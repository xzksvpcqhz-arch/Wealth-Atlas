/* Run with the repository's Electron. Only synthetic UI preferences are used.
 * Production imports are allow-listed: no app entry, financial store, auth SDK,
 * environment files, real profiles, or backend connections are loaded.
 */
const path = require("node:path");

if (process.type === "browser") {
  const { app, BrowserWindow, protocol } = require("electron");
  const { mkdirSync } = require("node:fs");
  const { randomUUID } = require("node:crypto");
  const scheme = "wa-display-hook-test";
  protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true } }]);
  const profile = path.resolve(__dirname, "../../work/display-hook-tests", randomUUID());
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.setPath("logs", profile);
  app.setPath("crashDumps", profile);
  app.commandLine.appendSwitch("disk-cache-dir", path.join(profile, "cache"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("no-pings");
  const watchdog = setTimeout(() => {
    console.error("DISPLAY_PREFERENCES_HOOK_FAIL timeout");
    app.exit(1);
  }, 35_000);
  app.whenReady().then(async () => {
    let blockedRequests = 0;
    protocol.handle(scheme, () => new Response("<!doctype html><html><body><div id='root'></div></body></html>", {
      headers: { "Content-Type": "text/html", "Content-Security-Policy": "connect-src 'none'; img-src 'none';" },
    }));
    const win = new BrowserWindow({ show: false, webPreferences: {
      nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false,
    } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const allowed = details.url.startsWith(`${scheme}://app/`);
      if (!allowed) blockedRequests++;
      callback({ cancel: !allowed });
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    await win.loadURL(`${scheme}://app/`);
    const result = await win.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).runRendererTests()`);
    if (blockedRequests !== 0) throw new Error("Unexpected network attempt was blocked");
    console.log(`DISPLAY_PREFERENCES_HOOK_PASS ${JSON.stringify({ ...result, realBackendRequests: 0 })}`);
    clearTimeout(watchdog);
    win.destroy();
    app.exit(0);
  }).catch((error) => {
    clearTimeout(watchdog);
    console.error("DISPLAY_PREFERENCES_HOOK_FAIL", String(error.message).split("\n")[0].slice(0, 220));
    app.exit(1);
  });
} else if (process.type === "renderer") {
  exports.runRendererTests = async () => {
    const assert = require("node:assert/strict");
    const { readFileSync } = require("node:fs");
    const ts = require("typescript");
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const { act } = React;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let networkAttempts = 0;
    const denyNetwork = () => { networkAttempts++; throw new Error("Network disabled in display hook tests"); };
    window.fetch = denyNetwork;
    window.XMLHttpRequest = class { constructor() { denyNetwork(); } };
    window.WebSocket = class { constructor() { denyNetwork(); } };
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });

    const allowedSources = new Set([
      "lib/display-preferences.ts", "lib/display-preference-sync.ts",
      "lib/display-preference-transport.ts", "lib/use-display-preferences.ts",
    ]);
    function loadTs(file, replacements = {}) {
      assert.ok(allowedSources.has(file), "Only display implementation sources may be read");
      const source = readFileSync(path.resolve(__dirname, "../..", file), "utf8");
      const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      } }).outputText;
      const module = { exports: {} };
      new Function("require", "module", "exports", compiled)((name) => {
        if (Object.hasOwn(replacements, name)) return replacements[name];
        if (name === "react") return React;
        throw new Error(`Non-display dependency blocked: ${name}`);
      }, module, module.exports);
      return module.exports;
    }
    const pure = loadTs("lib/display-preferences.ts");
    const syncModule = loadTs("lib/display-preference-sync.ts", { "./display-preferences": pure });
    const transportModule = loadTs("lib/display-preference-transport.ts", {
      "./display-preferences": pure, "./display-preference-sync": syncModule,
    });
    const clone = (value) => structuredClone(value);
    const preference = (gap) => {
      const value = pure.createDisplayPreferences();
      value.devices.desktop.enabled = true;
      value.devices.desktop.gap = gap;
      assert.ok(pure.parseDisplayPreferences(value), "Fixture preferences pass the real strict schema");
      return value;
    };
    let epoch = 0, state, controller, root, renderKey = 0;
    const listeners = new Set();
    const markerKey = "synthetic-financial-store-marker";
    const marker = "synthetic-untouched-marker-only";
    const keyFor = (profile) => pure.displayStorageKey({ kind: profile.kind, ownerId: profile.ownerId });
    const makeProfile = (kind, ownerId = null) => Object.freeze({
      key: kind === "cloud" ? `cloud:${ownerId}` : kind, kind, ownerId,
      epoch: ++epoch, desktopToken: "synthetic-profile-token",
    });
    const local = () => makeProfile("local");
    const cloudA = () => makeProfile("cloud", "synthetic-display-A");
    const cloudB = () => makeProfile("cloud", "synthetic-display-B");
    const storage = {
      getItem(key) {
        state.accesses.push(["read", key]);
        assert.ok(key.startsWith("wealth-atlas.display-preferences.v1."), "Hook must not read financial storage");
        if (state.blockRead) throw new Error("Synthetic storage read blocked");
        return state.values.get(key) ?? null;
      },
      setItem(key, raw) {
        state.accesses.push(["write", key]);
        assert.ok(key.startsWith("wealth-atlas.display-preferences.v1."), "Hook must not write financial storage");
        if (state.writeMode === "throw") throw new Error("Synthetic storage write blocked");
        if (state.writeMode === "drop") return;
        state.writes.push(key);
        state.values.set(key, raw);
      },
    };
    Object.defineProperty(window, "localStorage", { configurable: true, get() {
      if (state.blockGetter) throw new Error("Synthetic storage access blocked");
      return storage;
    } });
    const profiles = { isActiveDataProfile: (expected) => state.active === expected && expected.kind !== "locked" };
    const boundary = {
      subscribeAccountBoundary: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      getAccountRevision: () => state.authRevision,
      getAccountUser: () => state.user,
      isAccountVerified: () => state.verified,
    };
    // The production transport gets this existing fake client, never an auth SDK.
    const client = new Proxy({ from(table) {
      assert.equal(table, "user_ui_preferences", "Transport may only access the display table");
      const query = { operation: "read", owner: null, revision: null, value: null, signal: null };
      const builder = {
        select(columns) { assert.equal(columns, "revision,preferences"); return builder; },
        eq(field, value) {
          assert.ok(field === "user_id" || field === "revision");
          if (field === "user_id") query.owner = value;
          else query.revision = value;
          return builder;
        },
        insert(value) { query.operation = "insert"; query.owner = value.user_id; query.value = value.preferences; return builder; },
        update(value) { query.operation = "update"; query.value = value.preferences; return builder; },
        abortSignal(signal) { query.signal = signal; return builder; },
        async maybeSingle() {
          assert.equal(state.active.kind, "cloud", "Only cloud profiles can use transport");
          assert.equal(query.owner, state.active.ownerId, "Transport owner must match the active profile");
          assert.equal(state.verified, true, "An already verified account is required");
          assert.equal(state.user?.id, query.owner, "Existing verified auth must match the owner");
          assert.equal(query.signal.aborted, false, "No request may begin after disposal");
          const current = clone(state.rows.get(query.owner) ?? null);
          state.requests.push({ ...query });
          if (query.operation === "read") {
            // Intentionally ignore abort after starting: stale completion must be
            // rejected by the actual hook/engine, not hidden by this fake.
            const gate = state.gates.get(query.owner);
            if (gate) await gate.promise;
            return { data: current, error: null };
          }
          if ((query.operation === "insert" && current !== null)
            || (query.operation === "update" && current?.revision !== query.revision)) return { data: null, error: null };
          assert.ok(pure.parseDisplayPreferences(query.value), "Transport writes strict display preferences only");
          const next = { revision: (current?.revision ?? 0) + 1, preferences: clone(query.value) };
          state.rows.set(query.owner, next);
          return { data: clone(next), error: null };
        },
      };
      return builder;
    } }, { get(target, name) {
      if (name === "from") return target.from;
      state.authAccesses++;
      throw new Error("Display hook must never initialize or call authentication");
    } });
    const { useDisplayPreferences } = loadTs("lib/use-display-preferences.ts", {
      "@/lib/data-profile": profiles,
      "@/lib/display-preferences": pure,
      "@/lib/account-boundary": boundary,
      "@/lib/supabase-client": { getSupabaseClient() {
        state.clientReads++;
        return state.clientAvailable ? client : null;
      } },
      "@/lib/display-preference-transport": { createDisplayPreferenceTransport(...args) {
        const transport = transportModule.createDisplayPreferenceTransport(...args);
        state.transports.push({ owner: args[1], active: args[2], signal: args[3] });
        return transport;
      } },
      "@/lib/display-preference-sync": { ...syncModule, createDisplayPreferenceSync(options) {
        const engine = syncModule.createDisplayPreferenceSync(options);
        state.sessions.push({ options, engine });
        return engine;
      } },
    });
    function Harness({ profile }) {
      state.renders++;
      controller = useDisplayPreferences(profile);
      React.useEffect(() => { state.mounts++; return () => { state.unmounts++; }; }, []);
      return null;
    }
    const tick = () => new Promise((resolve) => window.setTimeout(resolve, 0));
    async function flush() { await act(async () => { await tick(); await tick(); }); }
    async function until(predicate, message) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await flush();
      }
      assert.fail(message);
    }
    async function mount(profile) {
      state.active = profile;
      if (!root) root = createRoot(document.getElementById("root"));
      await act(async () => {
        root.render(React.createElement(React.StrictMode, null,
          React.createElement(Harness, { profile, key: ++renderKey })));
      });
      await flush();
      assert.equal(controller.ready, profile.kind !== "locked", "Only active, unlocked profiles become ready");
    }
    async function unmount() {
      if (root) await act(async () => { root.unmount(); root = null; });
      await flush();
    }
    async function auth(user, verified) {
      await act(async () => {
        state.user = user;
        state.verified = verified;
        state.authRevision++;
        for (const listener of listeners) listener();
      });
      await flush();
    }
    const verifiedFor = (profile) => { state.user = { id: profile.ownerId }; state.verified = true; };
    const seed = (profile, value) => state.values.set(keyFor(profile), JSON.stringify(value));
    const stored = (profile) => JSON.parse(state.values.get(keyFor(profile)));
    const gap = () => controller.draft.devices.desktop.gap;
    async function change(value) { await act(async () => controller.update((next) => { next.devices.desktop.gap = value; })); }
    async function save() { let result; await act(async () => { result = controller.save(); }); await flush(); return result; }
    function defer(owner) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      const gate = { promise, release: () => { state.gates.delete(owner); release(); } };
      state.gates.set(owner, gate);
      return gate;
    }
    const checks = [];
    let transportRequests = 0;
    async function check(name, run) {
      state = {
        active: null, values: new Map([[markerKey, marker]]), rows: new Map(), gates: new Map(),
        accesses: [], writes: [], requests: [], sessions: [], transports: [],
        user: null, verified: false, authRevision: 0, authAccesses: 0, clientReads: 0,
        clientAvailable: true, blockGetter: false, blockRead: false, writeMode: "normal", mounts: 0, unmounts: 0, renders: 0,
      };
      try {
        await run();
        assert.equal(state.values.get(markerKey), marker, "Synthetic financial marker stays byte-for-byte untouched");
        assert.equal(state.authAccesses, 0, "No auth methods or credentials are requested");
        assert.equal(networkAttempts, 0, "No real network APIs are called");
        checks.push(name);
      } catch (error) {
        throw new Error(`${name}: ${String(error.message).split("\n")[0].slice(0, 160)}`);
      } finally {
        for (const gate of [...state.gates.values()]) gate.release();
        await unmount();
        assert.equal(listeners.size, 0, "Account subscriptions clean up on unmount");
        assert.ok(state.transports.every((transport) => transport.signal.aborted), "Every cloud transport is aborted on unmount");
        transportRequests += state.requests.length;
      }
    }

    await check("local-guest-cloud-A-B-scope-projection-and-remount", async () => {
      const scopes = [local(), makeProfile("guest"), cloudA(), cloudB()];
      const expected = new Map();
      for (const [index, scope] of scopes.entries()) {
        assert.equal(pure.displayStorageKey(scope), null, "Actual strict module rejects DataProfile extra keys");
        const value = preference(14 + index * 4);
        seed(scope, value);
        expected.set(keyFor(scope), JSON.stringify(value));
        if (scope.kind === "cloud") state.rows.set(scope.ownerId, { revision: 1, preferences: clone(value) });
      }
      for (const [index, scope] of scopes.entries()) {
        if (scope.kind === "cloud") verifiedFor(scope);
        await mount(scope);
        assert.equal(controller.readable, true);
        assert.equal(gap(), 14 + index * 4, "Each profile loads its own persisted UI state");
        assert.equal(controller.dirty, false);
        await change(15 + index * 4);
        assert.equal(await save(), true, "Full DataProfile is projected before strict writes");
        expected.set(keyFor(scope), JSON.stringify(preference(15 + index * 4)));
        for (const other of scopes) assert.equal(state.values.get(keyFor(other)), expected.get(keyFor(other)), "Other profiles remain untouched");
        await unmount();
        await mount(scope);
        assert.equal(gap(), 15 + index * 4, "Same-profile remount restores its saved preferences");
        assert.equal(controller.canUndo, false);
        assert.equal(controller.dirty, false);
      }
      assert.equal(new Set(scopes.map(keyFor)).size, 4);
      assert.ok(state.requests.some((request) => request.operation === "update"), "Real sync engine pushes saved cloud display changes");
    });

    await check("StrictMode-undo-redo-cancel", async () => {
      const profile = local(); seed(profile, preference(18));
      await mount(profile);
      assert.equal(state.mounts, 2, "StrictMode replays mount effects");
      assert.equal(state.unmounts, 1);
      await change(20); await change(22);
      await act(async () => controller.undo()); assert.equal(gap(), 20, "Undo removes exactly one edit under StrictMode");
      await act(async () => controller.undo()); assert.equal(gap(), 18);
      assert.equal(controller.canUndo, false); assert.equal(controller.canRedo, true); assert.equal(controller.dirty, false);
      await act(async () => controller.redo()); assert.equal(gap(), 20);
      await act(async () => controller.redo()); assert.equal(gap(), 22); assert.equal(controller.canRedo, false);
      await act(async () => controller.undo()); await change(26);
      assert.equal(controller.canRedo, false, "A new edit discards redo history");
      assert.equal(stored(profile).devices.desktop.gap, 18, "Draft/history never auto-save");
      await act(async () => controller.cancel());
      assert.equal(gap(), 18); assert.equal(controller.canUndo, false); assert.equal(controller.canRedo, false);
      assert.equal(state.writes.length, 0); assert.equal(state.clientReads, 0);
    });

    for (const [label, raw] of [
      ["malformed", "{synthetic-invalid-json"],
      ["unknown-version", JSON.stringify({ ...pure.createDisplayPreferences(), version: 99 })],
      ["unknown-field", JSON.stringify({ ...pure.createDisplayPreferences(), extra: "synthetic" })],
    ]) await check(`invalid-storage-${label}-preserved`, async () => {
      const profile = cloudA(); verifiedFor(profile);
      state.values.set(keyFor(profile), raw);
      state.values.set(`${keyFor(profile)}.sync`, "synthetic-untouched-sync-marker");
      await mount(profile);
      assert.equal(controller.readable, false); assert.ok(controller.message);
      const draft = clone(controller.draft);
      await change(28); assert.deepEqual(controller.draft, draft, "Unreadable preferences cannot be edited");
      assert.equal(await save(), false);
      await act(async () => controller.reload());
      assert.equal(state.values.get(keyFor(profile)), raw, "Invalid raw storage is never replaced by defaults");
      assert.equal(state.values.get(`${keyFor(profile)}.sync`), "synthetic-untouched-sync-marker");
      assert.equal(state.writes.length, 0); assert.equal(state.requests.length, 0);
    });

    for (const fault of ["blockGetter", "blockRead"]) await check(`blocked-storage-${fault}-retry`, async () => {
      const profile = local(); seed(profile, preference(16));
      const before = state.values.get(keyFor(profile));
      state[fault] = true;
      await mount(profile);
      assert.equal(controller.readable, false); assert.ok(controller.message);
      await change(28); assert.equal(await save(), false);
      assert.equal(state.values.get(keyFor(profile)), before); assert.equal(state.writes.length, 0);
      state[fault] = false;
      await act(async () => controller.reload());
      assert.equal(controller.readable, true); assert.equal(gap(), 16);
      await change(28); assert.equal(await save(), true); assert.equal(stored(profile).devices.desktop.gap, 28);
    });

    for (const mode of ["throw", "drop"]) await check(`blocked-write-${mode}-preserves-draft`, async () => {
      const profile = local(); seed(profile, preference(16)); await mount(profile);
      const before = state.values.get(keyFor(profile));
      await change(28); state.writeMode = mode;
      assert.equal(await save(), false); assert.equal(controller.dirty, true); assert.equal(gap(), 28);
      assert.ok(controller.message); assert.equal(state.values.get(keyFor(profile)), before);
      state.writeMode = "normal";
      assert.equal(await save(), true); assert.equal(controller.dirty, false);
      assert.equal(stored(profile).devices.desktop.gap, 28);
    });

    await check("storage-event-draft-and-optimistic-conflict", async () => {
      const profile = local(); seed(profile, preference(16)); await mount(profile);
      await change(26);
      seed(profile, preference(20));
      await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: keyFor(profile) })));
      assert.equal(gap(), 26, "Cross-window storage events preserve an unsaved draft");
      assert.ok(controller.message); assert.equal(await save(), false);
      assert.equal(stored(profile).devices.desktop.gap, 20, "Compare-and-set failure never overwrites another window");
      await act(async () => controller.cancel()); assert.equal(gap(), 20); assert.equal(controller.dirty, false);
      seed(profile, preference(22));
      await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: keyFor(makeProfile("guest")) })));
      assert.equal(gap(), 20, "Unrelated profile storage events are ignored");
      await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: keyFor(profile) })));
      assert.equal(gap(), 22, "Clean drafts reload their own profile's storage events");
    });

    await check("late-old-account-callbacks-and-response-blocked", async () => {
      const a = cloudA(), b = cloudB();
      state.rows.set(a.ownerId, { revision: 1, preferences: preference(30) });
      state.rows.set(b.ownerId, { revision: 1, preferences: preference(20) });
      const gate = defer(a.ownerId); verifiedFor(a); await mount(a);
      await until(() => state.requests.some((request) => request.owner === a.ownerId), "Account A read starts before switching");
      const old = controller, oldSessions = [...state.sessions], oldTransports = [...state.transports];
      verifiedFor(b); await mount(b);
      await until(() => controller.syncStatus === "ready" && gap() === 20, "Account B loads its own cloud preferences");
      assert.ok(oldTransports.every((transport) => transport.signal.aborted));
      const before = new Map(state.values), requests = state.requests.length;
      await act(async () => {
        old.update((next) => { next.devices.desktop.gap = 32; });
        assert.equal(old.save(), false); old.reload(); old.cancel(); old.undo(); old.redo();
        await old.retrySync(); await old.resolveSync("remote");
        for (const { options } of oldSessions) {
          assert.equal(options.isActive(), false);
          assert.equal(options.applyRemote(preference(32)), false, "Stale hook remote callback is rejected directly");
          assert.equal(options.saveMeta({ version: 1, revision: 2, base: preference(32) }), false, "Stale metadata callback is rejected directly");
        }
        gate.release();
      });
      await flush();
      assert.equal(state.requests.length, requests, "Stale controller cannot send more requests");
      assert.deepEqual(state.values, before, "Late account A response and retained callbacks cannot touch either scope");
      assert.equal(gap(), 20); assert.equal(controller.syncStatus, "ready");
      assert.equal(state.values.has(keyFor(a)), false); assert.equal(state.values.has(`${keyFor(a)}.sync`), false);
      const nextA = cloudA(); verifiedFor(nextA); await mount(nextA);
      await until(() => gap() === 30 && controller.syncStatus === "ready", "A fresh account A epoch can load A again");
      assert.notEqual(nextA.epoch, a.epoch);
      assert.ok(oldSessions.every(({ options }) => !options.isActive()), "Same owner does not reactivate old epochs");
      for (const { options } of oldSessions) assert.equal(options.applyRemote(preference(32)), false);
      assert.equal(stored(nextA).devices.desktop.gap, 30);
    });

    await check("dirty-draft-pauses-pull-and-cancel-resumes", async () => {
      const profile = cloudA(), base = preference(16); verifiedFor(profile); seed(profile, base);
      state.values.set(`${keyFor(profile)}.sync`, JSON.stringify({ version: 1, revision: 1, base }));
      state.rows.set(profile.ownerId, { revision: 2, preferences: preference(22) });
      const before = new Map(state.values), gate = defer(profile.ownerId);
      await mount(profile); await change(28);
      await act(async () => gate.release());
      await until(() => controller.syncStatus === "waiting", "A pull completed during a draft waits");
      assert.equal(gap(), 28); assert.equal(controller.dirty, true);
      assert.deepEqual(state.values, before, "Dirty drafts prevent remote apply and sync-metadata acknowledgement");
      await act(async () => { await controller.retrySync(); });
      assert.equal(gap(), 28); assert.deepEqual(state.values, before);
      assert.equal(state.requests.filter((request) => request.operation !== "read").length, 0);
      await act(async () => controller.cancel());
      await until(() => gap() === 22 && controller.syncStatus === "ready", "Cancelling a draft resumes the pending remote pull");
      assert.equal(controller.dirty, false); assert.equal(stored(profile).devices.desktop.gap, 22);
      assert.equal(JSON.parse(state.values.get(`${keyFor(profile)}.sync`)).revision, 2);
    });

    await check("shared-storage-stale-session-undo-cannot-upload-old-snapshot", async () => {
      const profile = cloudA(), x = preference(16), y = preference(28);
      verifiedFor(profile); seed(profile, x);
      state.values.set(`${keyFor(profile)}.sync`, JSON.stringify({ version: 1, revision: 1, base: x }));
      state.rows.set(profile.ownerId, { revision: 1, preferences: clone(x) });
      await mount(profile);
      await until(() => controller.syncStatus === "ready", "Session B initially acknowledges X");
      await change(24);
      assert.equal(controller.dirty, true);

      // Equivalent to another window/session A saving and uploading Y for the
      // same account: preferences, shared ancestry, and remote revision advance
      // together, while B deliberately keeps its dirty draft and old snapshot X.
      seed(profile, y);
      const metaY = JSON.stringify({ version: 1, revision: 2, base: y });
      state.values.set(`${keyFor(profile)}.sync`, metaY);
      state.rows.set(profile.ownerId, { revision: 2, preferences: clone(y) });
      await act(async () => {
        window.dispatchEvent(new StorageEvent("storage", { key: keyFor(profile) }));
        window.dispatchEvent(new StorageEvent("storage", { key: `${keyFor(profile)}.sync` }));
      });
      assert.equal(gap(), 24, "B ignores A's saved Y while its own draft is dirty");
      assert.equal(controller.dirty, true); assert.ok(controller.message);
      const before = new Map(state.values), writes = state.writes.length, requests = state.requests.length;
      await act(async () => controller.undo());
      assert.equal(gap(), 16, "Undo returns B's draft to its old saved X, not shared Y");
      assert.equal(controller.dirty, false);
      await until(() => controller.syncStatus === "error", "Stale B must reject the shared-storage byte mismatch");
      await act(async () => { await controller.retrySync(); });
      assert.ok(state.requests.length > requests, "The real engine attempts a fresh read with shared Y ancestry");
      assert.equal(state.requests.slice(requests).filter((request) => request.operation !== "read").length, 0,
        "B must never upload X using A's newer shared Y revision");
      assert.throws(() => state.sessions.at(-1).options.local(), /snapshot changed in another window/,
        "Actual hook local getter checks persisted bytes against its saved snapshot");
      assert.equal(state.writes.length, writes, "Stale B cannot rewrite preferences or shared sync metadata");
      assert.deepEqual(state.values, before, "A's shared Y and metadata stay byte-for-byte intact");
      assert.deepEqual(state.rows.get(profile.ownerId), { revision: 2, preferences: y }, "Cloud Y is not rolled back to X");
    });

    await check("reload-synchronous-snapshot-conflicts-before-React-render", async () => {
      const profile = cloudA(), a = preference(16), b = preference(20), c = preference(28);
      verifiedFor(profile); seed(profile, a);
      const metaA = JSON.stringify({ version: 1, revision: 1, base: a });
      state.values.set(`${keyFor(profile)}.sync`, metaA);
      state.rows.set(profile.ownerId, { revision: 2, preferences: clone(c) });
      const gate = defer(profile.ownerId);
      await mount(profile);
      assert.ok(state.requests.some((request) => request.operation === "read"), "Remote C read is already pending");
      assert.equal(gap(), 16);
      const renders = state.renders, writes = state.writes.length;
      seed(profile, b); // Another local writer changes A to B without a storage event.
      const before = new Map(state.values);
      await act(async () => {
        const pending = controller.retrySync();
        controller.reload();
        assert.equal(state.renders, renders, "Reload is still batched; React has not rendered B");
        gate.release();
        await pending;
        assert.equal(state.renders, renders, "Pending C is classified before the reload render commits");
        const snapshot = state.sessions.at(-1).options.local();
        assert.deepEqual(snapshot.value, b, "Reload synchronously pairs B's saved value with B's raw CAS token");
        assert.equal(snapshot.stored, true); assert.equal(snapshot.dirty, false);
        assert.deepEqual(state.values, before, "Remote C cannot consume B's raw token while comparing against old A");
        assert.equal(state.writes.length, writes, "The pre-render response cannot apply C or acknowledge it");
      });
      await flush();
      assert.equal(gap(), 20); assert.equal(controller.dirty, false);
      assert.equal(controller.syncStatus, "conflict", "Local B and remote C both changed from base A");
      assert.deepEqual(state.values, before); assert.equal(state.values.get(`${keyFor(profile)}.sync`), metaA);
      assert.deepEqual(state.rows.get(profile.ownerId), { revision: 2, preferences: c });
      assert.equal(state.requests.filter((request) => request.operation !== "read").length, 0);
    });

    await check("corrupt-reload-synchronously-blocks-fallback-default-upload", async () => {
      const profile = cloudA(), valid = preference(16);
      verifiedFor(profile); seed(profile, valid);
      // Keep remote and ancestry identical: without the readable gate, reload's
      // fallback defaults look like a local-only edit eligible for upload.
      const meta = JSON.stringify({ version: 1, revision: 1, base: valid });
      state.values.set(`${keyFor(profile)}.sync`, meta);
      state.rows.set(profile.ownerId, { revision: 1, preferences: clone(valid) });
      const gate = defer(profile.ownerId);
      await mount(profile);
      assert.ok(state.requests.some((request) => request.operation === "read"), "Valid cloud read is pending before corruption");
      assert.equal(controller.readable, true); assert.equal(gap(), 16);
      const c = controller, session = state.sessions.at(-1), transport = state.transports.at(-1);
      const renders = state.renders, writes = state.writes.length, requests = state.requests.length;
      const corrupt = "{synthetic-corrupt-display-bytes";
      state.values.set(keyFor(profile), corrupt);
      const before = new Map(state.values);
      await act(async () => {
        const pending = c.retrySync();
        c.reload();
        assert.equal(state.renders, renders, "Corrupt reload is batched before React renders unreadable state");
        assert.equal(controller.readable, true, "Rendered controller still holds the previous readable state");
        assert.equal(transport.signal.aborted, false, "Effect cleanup has not yet invalidated the pending read");
        assert.equal(session.options.isActive(), false, "Readable ref immediately disables the actual sync session");
        assert.equal(transport.active(), false, "Production transport's active predicate sees unreadable storage synchronously");
        assert.throws(() => session.options.local(), /snapshot changed in another window/,
          "Local getter must reject unreadable fallback defaults even when raw corrupt bytes match storage");
        gate.release();
        await pending;
        assert.equal(state.renders, renders, "Valid remote read resolves before unreadable-state render commits");
        assert.equal(state.writes.length, writes, "Fallback defaults cannot be persisted or acknowledged before render");
        assert.deepEqual(state.values, before, "Corrupt bytes and valid ancestry survive the pre-render response unchanged");
        assert.deepEqual(state.rows.get(profile.ownerId), { revision: 1, preferences: valid }, "Fallback defaults never replace the valid remote row");
      });
      await flush();
      assert.equal(controller.readable, false); assert.ok(controller.message);
      assert.deepEqual(controller.draft, pure.createDisplayPreferences(), "Fallback defaults are display-only, not uploadable state");
      assert.equal(controller.syncStatus, "local"); assert.equal(transport.signal.aborted, true);
      assert.equal(await save(), false);
      await act(async () => { await controller.retrySync(); });
      assert.equal(state.requests.length, requests, "Unreadable reload stops repeat and retry requests");
      assert.equal(state.requests.filter((request) => request.operation !== "read").length, 0, "No fallback-default upload is attempted");
      assert.equal(state.writes.length, writes); assert.deepEqual(state.values, before);
      assert.equal(state.values.get(keyFor(profile)), corrupt); assert.equal(state.values.get(`${keyFor(profile)}.sync`), meta);
      assert.deepEqual(state.rows.get(profile.ownerId), { revision: 1, preferences: valid });
    });

    await check("update-synchronous-draft-blocks-pull-before-React-render", async () => {
      const profile = cloudA(), a = preference(16), c = preference(22);
      verifiedFor(profile); seed(profile, a);
      state.values.set(`${keyFor(profile)}.sync`, JSON.stringify({ version: 1, revision: 1, base: a }));
      state.rows.set(profile.ownerId, { revision: 2, preferences: clone(c) });
      const gate = defer(profile.ownerId);
      await mount(profile);
      assert.ok(state.requests.some((request) => request.operation === "read"), "Remote C read is already pending");
      const before = new Map(state.values), renders = state.renders, writes = state.writes.length;
      await act(async () => {
        const pending = controller.retrySync();
        controller.update((next) => { next.devices.desktop.gap = 28; });
        assert.equal(state.renders, renders, "Update dispatch is batched before the next React render");
        gate.release();
        await pending;
        assert.equal(state.renders, renders, "Pending remote C resolves before React renders the unsaved draft");
        const snapshot = state.sessions.at(-1).options.local();
        assert.equal(snapshot.dirty, true, "Hook exposes the draft synchronously to the real sync engine");
        assert.deepEqual(snapshot.value, a, "Saved snapshot remains A while its new draft is unsaved");
        assert.deepEqual(state.values, before, "A pre-render response neither replaces storage nor acknowledges C");
        assert.equal(state.writes.length, writes);
      });
      await flush();
      assert.equal(gap(), 28, "Unsaved draft survives a response between dispatch and render");
      assert.equal(controller.dirty, true); assert.equal(controller.canUndo, true);
      assert.equal(controller.syncStatus, "waiting");
      assert.deepEqual(state.values, before);
      assert.deepEqual(state.rows.get(profile.ownerId), { revision: 2, preferences: c });
      assert.equal(state.requests.filter((request) => request.operation !== "read").length, 0);
    });

    await check("existing-matching-verified-auth-only-and-cloud-only", async () => {
      for (const profile of [local(), makeProfile("guest"), makeProfile("locked")]) {
        await mount(profile); assert.equal(controller.syncStatus, "local");
      }
      assert.equal(state.clientReads, 0); assert.equal(state.sessions.length, 0);
      const profile = cloudA(); state.user = { id: profile.ownerId }; state.verified = false;
      state.rows.set(profile.ownerId, { revision: 1, preferences: preference(18) });
      await mount(profile); assert.equal(controller.syncStatus, "waiting"); assert.equal(state.requests.length, 0);
      await auth({ id: "synthetic-display-B" }, true);
      assert.equal(controller.syncStatus, "waiting"); assert.equal(state.requests.length, 0);
      await auth(null, true);
      assert.equal(state.requests.length, 0, "Verified flag without the correct existing user is insufficient");
      state.clientAvailable = false; await auth({ id: profile.ownerId }, true);
      assert.equal(controller.syncStatus, "waiting"); assert.equal(state.requests.length, 0);
      state.clientAvailable = true; await auth({ id: profile.ownerId }, true);
      await until(() => gap() === 18 && controller.syncStatus === "ready", "Existing verified matching auth enables cloud UI sync");
      await change(26); assert.equal(await save(), true);
      await until(() => state.rows.get(profile.ownerId).preferences.devices.desktop.gap === 26, "Saved UI change pushes through production transport");
      const session = state.sessions.at(-1), requestCount = state.requests.length;
      await auth({ id: profile.ownerId }, false);
      await act(async () => { await controller.retrySync(); });
      assert.equal(controller.syncStatus, "waiting"); assert.equal(state.requests.length, requestCount);
      assert.equal(session.options.applyRemote(preference(32)), false, "Revoked verification invalidates retained apply callbacks");
      assert.equal(session.options.saveMeta({ version: 1, revision: 99, base: preference(32) }), false);
      assert.equal(stored(profile).devices.desktop.gap, 26);
    });

    return { checks: checks.length, profile: "isolated", transportRequests, authCalls: 0 };
  };
} else {
  throw new Error("Run this fixture with Electron, or node --test tests/display-preferences-hook.test.mjs");
}
