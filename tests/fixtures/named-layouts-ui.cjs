/* Actual production TS/TSX, not the approved preview or a reimplemented model.
 * Only display modules are allowlisted. No app entry, SDK, financial store,
 * private files, .env, installed profile, server, or external URL is loaded.
 * Run through ../named-layouts-ui.test.mjs for an OS-only child environment.
 */
const path = require("node:path");
const GROUPS = {
  offscreen: [
    "honest empty library", "save complete three-device snapshot and sidebar",
    "copy and rename stable IDs without applying", "select and device previews never apply",
    "apply cancellation, backdrop, confirmation and focus", "applySnapshot storage failure is view-atomic",
    "dirty draft failed save-as retains draft", "dirty draft saved before separate apply confirmation",
    "active deletion protected and other deletion targets exact ID", "same-tick double submissions",
    "library quota, dropped write, retry and fresh mount", "queued mutation CAS preserves another window",
    "hook name, capacity and own-key validation", "local, guest, cloud ownership and fresh mounts",
    "offline error and retry through actual sync and transport", "remote library never applies saved or dirty preferences",
    "whole-library conflict requires confirmation and never applies", "A-B-A stale remote responses and dialog isolation",
    "A-B-A queued local operation and stale handlers are fenced", "changed dialog target is not deleted",
    "background poll cannot refresh an open conflict confirmation", "focus ticket is consumed after cancellation",
    ...[320, 390, 1280, 1440].map(width => `actual CSS responsive ${width}px`),
  ],
  native: ["native Enter saves once with input focus", "native Escape cancels and restores focus", "native Tab trap and focus indication"],
};
exports.GROUPS = GROUPS;

const safeMessage = error => String(error?.message ?? error).split("\n")[0]
  .replace(/[A-Za-z]:[\\/][^\s'"<>]+/g, "[local path]").slice(0, 500);

if (process.type === "browser") {
  const { app, BrowserWindow, protocol, ipcMain, session } = require("electron");
  const { mkdirSync, writeFileSync } = require("node:fs");
  // Both windows are deliberately destroyed between the offscreen and native
  // groups; keep this synthetic runner alive until its explicit final exit.
  app.on("window-all-closed", () => {});
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
  const scheme = "wa-named-layouts-qa";
  const runId = process.argv.find(arg => /^--qa-run=[a-f0-9-]{36}$/.test(arg))?.slice(9);
  if (!runId) throw new Error("Use the node:test wrapper; a fresh synthetic run ID is required");
  const output = path.resolve(__dirname, "../../work/named-layouts-ui", runId);
  const profile = path.join(output, "synthetic-profile");
  mkdirSync(path.join(output, "captures"), { recursive: true });
  mkdirSync(profile, { recursive: true });
  for (const key of ["userData", "sessionData", "logs", "crashDumps"]) app.setPath(key, profile);
  app.commandLine.appendSwitch("disk-cache-dir", path.join(profile, "cache"));
  for (const key of ["disable-background-networking", "disable-component-update", "no-pings", "disable-domain-reliability"]) app.commandLine.appendSwitch(key);
  protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true } }]);
  const windows = new Map();
  const captures = [];
  let blockedRequests = 0;
  const watchdog = setTimeout(() => {
    console.error("NAMED_LAYOUTS_UI_FAIL isolated harness timed out");
    app.exit(1);
  }, 150_000);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fixtureUrl = value => {
    try { const url = new URL(value); return url.protocol === `${scheme}:` && url.hostname === "fixture" && ["", "/"].includes(url.pathname) && !url.search && !url.hash && !url.username && !url.password; }
    catch { return false; }
  };
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const allowed = fixtureUrl(details.url);
      if (!allowed) blockedRequests++;
      callback({ cancel: !allowed });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle(scheme, request => new Response(fixtureUrl(request.url)
      ? "<!doctype html><html lang='zh-CN'><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body><div id='root'></div></body></html>" : "blocked", {
      status: fixtureUrl(request.url) ? 200 : 403,
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'" },
    }));
    ipcMain.handle("named-layouts-qa-control", async (event, command) => {
      const win = windows.get(event.sender.id);
      if (!win || !fixtureUrl(event.sender.getURL())) throw new Error("Unknown synthetic sender");
      if (command.kind === "resize" && [320, 390, 1280, 1440].includes(command.width)) {
        win.setContentSize(command.width, 1000);
        await delay(70);
        return win.getContentSize();
      }
      if (command.kind === "capture" && /^[a-z0-9-]+$/.test(command.name)) {
        const capture = await win.webContents.capturePage();
        const relative = `captures/${command.name}.png`;
        writeFileSync(path.join(output, relative), capture.toPNG());
        const size = capture.getSize();
        captures.push({ file: relative, ...size });
        return size;
      }
      if (command.kind === "key" && win.isVisible() && ["Enter", "Escape", "Tab"].includes(command.key)) {
        win.focus(); win.webContents.focus();
        const modifiers = command.shift ? ["shift"] : [];
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: command.key, modifiers });
        // Enter must include Chromium's character event, not just keyDown/up.
        if (command.key === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: command.key, modifiers });
        await delay(60);
        return { visible: win.isVisible(), focused: win.isFocused() };
      }
      throw new Error("Unsupported synthetic-window operation");
    });
    async function run(mode) {
      const win = new BrowserWindow({ width: 1280, height: 1000, useContentSize: true,
        show: mode === "native", title: "Synthetic named-layouts keyboard QA", autoHideMenuBar: true,
        webPreferences: { offscreen: mode !== "native", nodeIntegration: true,
          contextIsolation: false, sandbox: false, backgroundThrottling: false },
      });
      windows.set(win.webContents.id, win);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", event => event.preventDefault());
      win.webContents.on("will-attach-webview", event => event.preventDefault());
      await win.loadURL(`${scheme}://fixture/`);
      if (mode === "native") { win.show(); win.focus(); win.webContents.focus(); await delay(80); }
      try {
        return await win.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).runRendererTests(${JSON.stringify(mode)})`);
      } finally {
        windows.delete(win.webContents.id);
        win.destroy(); // The offscreen window is never shown or hidden.
      }
    }
    const offscreen = await run("offscreen");
    const native = await run("native");
    const groups = [...offscreen.groups, ...native.groups];
    const report = { version: 1, ok: groups.every(group => group.ok) && blockedRequests === 0,
      groups, passed: groups.filter(group => group.ok).length, failed: groups.filter(group => !group.ok).length,
      assertions: offscreen.assertions + native.assertions, profile: "fresh synthetic work directory",
      productionDataAccessed: false, realBackendRequests: 0, blockedRequests,
      networkAttempts: offscreen.networkAttempts + native.networkAttempts,
      authCalls: offscreen.authCalls + native.authCalls,
      transportRequests: offscreen.transportRequests + native.transportRequests,
      sourceHashes: offscreen.sourceHashes, css: offscreen.css, captures,
      coverage: "actual React component/hooks; synthetic account boundary, storage and remote client; not installed or cross-device acceptance" };
    writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
    console.log(`${report.ok ? "NAMED_LAYOUTS_UI_PASS" : "NAMED_LAYOUTS_UI_FAIL"} ${JSON.stringify({ passed: report.passed, failed: report.failed, assertions: report.assertions })}`);
    clearTimeout(watchdog);
    app.exit(report.ok ? 0 : 1);
  }).catch(error => {
    clearTimeout(watchdog);
    writeFileSync(path.join(output, "failure.json"), JSON.stringify({ error: safeMessage(error) }));
    console.error("NAMED_LAYOUTS_UI_FAIL", safeMessage(error));
    app.exit(1);
  });
} else if (process.type === "renderer") {
  exports.runRendererTests = async mode => {
    const strict = require("node:assert/strict");
    const { readFileSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    const { ipcRenderer } = require("electron");
    const ts = require("typescript");
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const { act } = React;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let assertions = 0, networkAttempts = 0, state, display, named, root, epoch = 0;
    const assert = new Proxy(strict, { get(target, key) {
      const value = target[key];
      return typeof value === "function" ? (...args) => { assertions++; return value(...args); } : value;
    } });
    const clone = value => structuredClone(value);
    const encoded = value => JSON.stringify(value);
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    async function flush() { await act(async () => { await tick(); await tick(); await frame(); }); }
    async function until(predicate, message) {
      for (let n = 0; n < 70; n++) { if (predicate()) { assert.ok(true, message); return; } await flush(); }
      assert.fail(message);
    }
    function guard(condition, message) {
      if (!condition && state) state.violations.push(message);
      assert.ok(condition, message);
    }
    const denyNetwork = () => { networkAttempts++; throw new Error("External network disabled in synthetic UI QA"); };
    window.fetch = denyNetwork;
    for (const key of ["XMLHttpRequest", "WebSocket", "EventSource"]) window[key] = class { constructor() { denyNetwork(); } };
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: denyNetwork });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    const listeners = new Set(), profileListeners = new Set();
    const profiles = {
      isActiveDataProfile: expected => state.active === expected && expected.kind !== "locked",
      getDataProfile: () => state.active, getServerDataProfile: () => state.active,
      subscribeDataProfile: listener => { profileListeners.add(listener); return () => profileListeners.delete(listener); },
    };
    const boundary = {
      subscribeAccountBoundary: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      getAccountRevision: () => state.authRevision, getAccountUser: () => state.user,
      isAccountVerified: () => state.verified,
    };
    const markerEntries = [["synthetic.finance.snapshot", "FAKE_FINANCE_UNCHANGED"],
      ["synthetic.personal.Vault", "FAKE_VAULT_UNCHANGED"], ["unrelated.preference", "FAKE_OTHER_UNCHANGED"]];
    const storage = {
      getItem(key) { guard(state.allowed.has(key), "Storage reads must use an exact own display key"); state.accesses.push(["read", key]); return state.values.get(key) ?? null; },
      setItem(key, raw) {
        guard(state.allowed.has(key), "Storage writes must use an exact own display key"); state.accesses.push(["write", key]);
        const fault = state.faults.get(key);
        if (fault === "quota") throw new DOMException("Synthetic quota only", "QuotaExceededError");
        if (fault === "drop") return;
        state.values.set(key, raw); state.writes.push(key);
      },
    };
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => storage });
    const nativeLockRequest = navigator.locks.request.bind(navigator.locks);
    Object.defineProperty(navigator.locks, "request", { configurable: true, value(name, options, callback) {
      guard(state.allowed.has(name), "Web Lock must be scoped to an exact own display key");
      const captured = state, gate = state.lockGate;
      captured.lockPending++;
      return nativeLockRequest(name, options, async lock => {
        if (gate) { captured.lockWaits++; await gate.promise; }
        return callback(lock);
      }).finally(() => { captured.lockPending--; });
    } });
    const client = new Proxy({ from(table) {
      guard(["user_ui_preferences", "user_ui_layout_libraries"].includes(table), "Only the two display tables are accessible");
      const payload = table === "user_ui_preferences" ? "preferences" : "library";
      const query = { table, operation: "read", owner: null, revision: null, value: null, signal: null };
      const builder = {
        select(columns) { guard(columns === `revision,${payload}`, "Only display columns may be selected"); return builder; },
        eq(field, value) { guard(["user_id", "revision"].includes(field), "Only owner and revision filters allowed"); query[field === "user_id" ? "owner" : "revision"] = value; return builder; },
        insert(value) { guard(Object.keys(value).sort().join(",") === [payload, "user_id"].sort().join(","), "Insert has only display payload and owner"); query.operation = "insert"; query.owner = value.user_id; query.value = clone(value[payload]); return builder; },
        update(value) { guard(Object.keys(value).join(",") === payload, "Update has only display payload"); query.operation = "update"; query.value = clone(value[payload]); return builder; },
        abortSignal(signal) { query.signal = signal; return builder; },
        async maybeSingle() {
          const captured = state;
          guard(captured.active.kind === "cloud" && query.owner === captured.active.ownerId, "Remote request belongs to active cloud owner");
          guard(captured.verified && captured.user?.id === query.owner, "Remote request requires matching synthetic verified boundary");
          guard(query.signal && !query.signal.aborted, "Disposed transport must not begin requests");
          const rowKey = `${table}:${query.owner}`;
          const snapshot = clone(captured.rows.get(rowKey) ?? null);
          captured.requests.push({ ...query, signal: undefined });
          const gate = captured.remoteGates.get(`${table}:${query.operation}:${query.owner}`);
          // Ignore abort after a request starts: production, not the fake, must fence stale completions.
          if (gate) { gate.started++; await gate.promise; }
          if (captured.offline) return { data: null, error: { code: "SYNTHETIC_OFFLINE" } };
          if (query.operation === "read") return { data: snapshot, error: null };
          const current = captured.rows.get(rowKey) ?? null;
          if (query.operation === "insert" ? current !== null : current?.revision !== query.revision) return { data: null, error: null };
          guard(!!(payload === "preferences" ? pure.parseDisplayPreferences(query.value) : model.parseNamedLayoutLibrary(query.value)), "Remote payload passes actual strict parser");
          const next = { revision: (current?.revision ?? 0) + 1, [payload]: clone(query.value) };
          captured.rows.set(rowKey, next);
          return { data: clone(next), error: null };
        },
      };
      return builder;
    } }, { get(target, key) {
      if (key === "from") return target.from;
      state.authCalls++;
      guard(false, "No authentication, credentials or non-display client API may be accessed");
    } });
    const allowed = new Set(["lib/display-preferences.ts", "lib/display-preference-sync.ts", "lib/display-preference-transport.ts",
      "lib/use-display-preferences.ts", "lib/named-display-layouts.ts", "lib/named-layout-sync.ts",
      "lib/named-layout-transport.ts", "lib/use-named-display-layouts.ts", "components/NamedDisplayLayouts.tsx"]);
    const sourceHashes = {}, cache = new Map();
    const readSource = file => {
      guard(allowed.has(file) || ["app/globals.css", "components/NamedDisplayLayouts.module.css"].includes(file), "Only explicitly allowlisted display source files may be read");
      const source = readFileSync(path.resolve(__dirname, "../..", file), "utf8");
      sourceHashes[file] = createHash("sha256").update(source).digest("hex");
      return source;
    };
    const actualCss = readSource("components/NamedDisplayLayouts.module.css");
    const styles = Object.create(null);
    const mappedCss = actualCss.replace(/\.([A-Za-z_][\w-]*)/g, (_match, key) => {
      styles[key] = `qa_nl_${key}`; return `.${styles[key]}`;
    });
    // Keep actual global tokens and rules, but remove its build-only Tailwind
    // import and local font URLs; no fonts/assets are read or requested.
    const baselineCss = readSource("app/globals.css").replace(/@import\s+"tailwindcss"\s*;/g, "")
      .replace(/@font-face\s*\{[^}]*\}/g, "");
    assert.ok(!/url\s*\(|@import/i.test(baselineCss + mappedCss), "Injected actual CSS cannot request resources");
    const sheet = document.createElement("style");
    sheet.textContent = baselineCss + "\n" + mappedCss;
    document.head.append(sheet);
    document.getElementById("root").style.cssText = "width:100%;min-width:0;padding:16px;max-width:1440px;margin-inline:auto";
    function loadTs(file) {
      if (cache.has(file)) return cache.get(file);
      const source = readSource(file);
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: file }).outputText;
      const module = { exports: {} };
      const safeRequire = name => {
        if (name === "react" || name === "react/jsx-runtime") return require(name);
        if (["./data-profile", "@/lib/data-profile"].includes(name)) return profiles;
        if (["./account-boundary", "@/lib/account-boundary"].includes(name)) return boundary;
        if (["./supabase-client", "@/lib/supabase-client"].includes(name)) return { getSupabaseClient: () => state.clientAvailable ? client : null };
        if (file === "components/NamedDisplayLayouts.tsx" && name === "./NamedDisplayLayouts.module.css") return { __esModule: true, default: styles };
        const resolved = name.startsWith("@/lib/") ? `${name.slice(2)}.ts`
          : name.startsWith("./") ? path.posix.normalize(`${path.posix.dirname(file)}/${name}.ts`) : "";
        guard(allowed.has(resolved), `Non-display production import blocked: ${name}`);
        return loadTs(resolved);
      };
      new Function("require", "module", "exports", compiled)(safeRequire, module, module.exports);
      if (file === "lib/use-named-display-layouts.ts") {
        const actual = module.exports.useNamedDisplayLayouts;
        module.exports.useNamedDisplayLayouts = profile => { named = actual(profile); return named; };
      }
      cache.set(file, module.exports);
      return module.exports;
    }
    const pure = loadTs("lib/display-preferences.ts");
    const model = loadTs("lib/named-display-layouts.ts");
    const { useDisplayPreferences } = loadTs("lib/use-display-preferences.ts");
    const Component = loadTs("components/NamedDisplayLayouts.tsx").default;
    function Harness({ profile }) {
      display = useDisplayPreferences(profile);
      const observed = { ...display, applySnapshot(value) { state.uiApplyCalls++; return display.applySnapshot(value); } };
      return React.createElement(React.Fragment, null, React.createElement(Component, { display: observed }),
        React.createElement("output", { hidden: true, "data-current-display": true }, encoded(display.saved)));
    }
    const scope = profile => ({ kind: profile.kind, ownerId: profile.ownerId });
    const displayKey = profile => pure.displayStorageKey(scope(profile));
    const libraryKey = profile => model.namedLayoutStorageKey(scope(profile));
    function profile(kind = "local", ownerId = null) {
      const value = Object.freeze({ kind, ownerId, key: kind === "cloud" ? `cloud:${ownerId}` : kind,
        epoch: ++epoch, desktopToken: "SYNTHETIC_ONLY" });
      for (const key of [displayKey(value), libraryKey(value)]) if (key) { state.allowed.add(key); state.allowed.add(`${key}.sync`); }
      return value;
    }
    function preference(seed = 1) {
      const value = pure.createDisplayPreferences();
      value.sidebar.hidden = seed % 2 ? ["reports", "capture", "excel"] : ["budget", "transfer"];
      for (const [index, device] of ["desktop", "tablet", "mobile"].entries()) {
        const layout = value.devices[device];
        layout.enabled = index !== 1; layout.gap = 12 + (seed + index * 5) % 21; layout.groupMotion = index % 2 ? "none" : "stagger";
        layout.items = layout.items.slice(index + seed % 3).concat(layout.items.slice(0, index + seed % 3));
        for (const [n, item] of layout.items.entries()) Object.assign(item, { width: [4, 6, 8, 12][(n + index) % 4],
          height: 144 + (seed * 7 + n * 3) % 200, padding: 14 + (seed + n) % 19,
          title: 13 + (seed + n) % 16, amount: 20 + (seed + n) % 45, body: 13 + (seed + index) % 6,
          titleWeight: 400, amountWeight: 600, bodyWeight: 700, motion: ["fade", "spring", "zoom"][index],
          duration: 120 + (seed * 13 + n) % 481, visible: n % 3 !== 0, detailsExpanded: n % 2 === 0 });
      }
      assert.ok(pure.parseDisplayPreferences(value), "Synthetic full snapshot passes the real strict parser");
      return value;
    }
    const IDs = [1, 2, 3].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    function library(values = [preference(2), preference(9)]) {
      const value = { version: 1, schemes: values.map((preferences, index) => ({ id: IDs[index], name: `Synthetic ${index + 1}`, preferences: clone(preferences) })) };
      assert.ok(model.parseNamedLayoutLibrary(value), "Synthetic library passes the actual parser"); return value;
    }
    function seed(profile, value = preference(1), lib) {
      state.values.set(displayKey(profile), encoded(value));
      if (lib) state.values.set(libraryKey(profile), encoded({ version: 1, library: lib, base: null }));
      if (profile.kind === "cloud") state.rows.set(`user_ui_preferences:${profile.ownerId}`, { revision: 1, preferences: clone(value) });
      return value;
    }
    const storedLibrary = profile => JSON.parse(state.values.get(libraryKey(profile))).library;
    const currentView = () => document.querySelector("[data-current-display]").textContent;
    async function mount(next) {
      await act(async () => {
        state.active = next; state.user = next.kind === "cloud" ? { id: next.ownerId } : null;
        state.verified = next.kind === "cloud"; state.authRevision++;
        for (const listener of [...listeners, ...profileListeners]) listener();
        if (!root) root = createRoot(document.getElementById("root"));
        root.render(React.createElement(React.StrictMode, null, React.createElement(Harness, { profile: next, key: `${next.key}:${next.epoch}` })));
      });
      await until(() => display.ready && named.ready, "Real hooks become ready"); await flush();
    }
    async function unmount() { if (root) await act(async () => { root.unmount(); root = null; }); await flush(); }
    const dlg = () => document.querySelector("dialog[open]");
    function button(label, container = document) {
      const found = [...container.querySelectorAll("button")].filter(element => element.textContent.trim() === label || element.getAttribute("aria-label") === label);
      assert.equal(found.length, 1, `Exactly one actual button: ${label}`); return found[0];
    }
    function actionButton(id, action) {
      const element = document.querySelector(`button[data-layout-id='${id}'][data-layout-action='${action}']`);
      assert.ok(element, `Actual ${action} button exists for target ID`); return element;
    }
    async function click(target) {
      const element = typeof target === "string" ? button(target) : target;
      assert.ok(!element.disabled, "Actual button must be enabled");
      await act(async () => { element.focus(); element.click(); }); await flush();
    }
    async function typeName(value) {
      const element = dlg()?.querySelector("input[name=schemeName]"); assert.ok(element, "Actual controlled name input exists");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }); await flush();
      assert.equal(element.value, value, "Real controlled input accepted text");
    }
    async function confirm(twice = false) {
      const form = dlg()?.querySelector("form"); assert.ok(form, "Actual modal form exists");
      await act(async () => { form.requestSubmit(); if (twice) form.requestSubmit(); }); await flush();
      await until(() => !named.busy && (!form.isConnected || form.getAttribute("aria-busy") !== "true"), "Submitted operation settles before checking its result");
      await flush();
    }
    async function nameOperation(trigger, name, twice = false) { await click(trigger); await typeName(name); await confirm(twice); }
    async function edit(value) { await act(async () => display.update(next => Object.assign(next, clone(value)))); await flush(); }
    async function apply(value) { let ok; await act(async () => { ok = display.applySnapshot(value); }); await flush(); return ok; }
    async function mutate(run) { let ok; await act(async () => { ok = await run(); }); await flush(); return ok; }
    function gate() {
      let resolve;
      const value = { promise: new Promise(done => { resolve = done; }), started: 0, released: false,
        release() { if (!value.released) { value.released = true; resolve(); } } };
      state.gates.add(value); return value;
    }
    async function backdrop() {
      const element = dlg(); assert.ok(element, "Actual modal is open");
      await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 0, clientY: 0 })));
      await flush(); assert.equal(dlg(), null, "Backdrop cancels the modal");
    }
    async function storageEvent(key) { await act(async () => window.dispatchEvent(new StorageEvent("storage", { key }))); await flush(); }
    async function setup(values, lib, kind = "local", owner = null) { const p = profile(kind, owner); seed(p, values ?? preference(1), lib); await mount(p); return p; }
    const groups = [];
    let transportRequests = 0, authCalls = 0;
    async function check(name, run) {
      state = { active: null, values: new Map(markerEntries), rows: new Map(), allowed: new Set(),
        accesses: [], writes: [], requests: [], faults: new Map(), remoteGates: new Map(), gates: new Set(),
        violations: [], authCalls: 0, authRevision: 0, user: null, verified: false, clientAvailable: true,
        offline: false, lockGate: null, lockPending: 0, lockWaits: 0, uiApplyCalls: 0 };
      const start = assertions;
      let failure;
      try { await run(); } catch (error) { failure = safeMessage(error) + " | " + String(error?.stack ?? "").split("\n").slice(1, 5).map(line => line.replace(/[A-Za-z]:[\\/][^\s'"<>]+/g, "[test path]")).join(" | "); }
      try {
        await act(async () => { for (const value of state.gates) value.release(); });
        await unmount();
        await until(() => state.lockPending === 0, "Pending real Web Locks drain");
        assert.equal(listeners.size, 0, "Real account subscriptions dispose");
        assert.equal(profileListeners.size, 0, "Real profile subscriptions dispose");
        assert.deepEqual(state.violations, [], "Caught internal errors cannot hide a boundary violation");
        for (const [key, value] of markerEntries) assert.equal(state.values.get(key), value, "Synthetic finance, Vault and unrelated sentinels are byte-for-byte unchanged");
        assert.equal(state.authCalls, 0, "No auth SDK calls"); assert.equal(networkAttempts, 0, "No real network API calls");
      } catch (error) { failure = failure ?? safeMessage(error); }
      transportRequests += state.requests.length; authCalls += state.authCalls;
      groups.push({ name, ok: !failure, assertions: assertions - start, ...(failure ? { error: failure } : {}) });
    }

    const cases = {
      async "honest empty library"() {
        const p = profile(); await mount(p);
        assert.deepEqual(named.library.schemes, []); assert.match(document.body.textContent, /还没有保存的方案/);
        assert.equal(document.querySelectorAll("[data-layout-action=select]").length, 0);
        assert.equal(state.values.has(libraryKey(p)), false); assert.equal(state.uiApplyCalls, 0);
        assert.equal(display.dirty, false); assert.equal(named.syncStatus, "local");
      },
      async "save complete three-device snapshot and sidebar"() {
        const saved = preference(1), draft = preference(7), p = await setup(saved);
        await edit(draft); await nameOperation("另存为新方案", "  Ａlpha  ");
        assert.equal(dlg(), null); assert.equal(named.library.schemes.length, 1);
        const item = named.library.schemes[0]; assert.equal(item.name, "Alpha");
        assert.deepEqual(item.preferences, draft); assert.deepEqual(storedLibrary(p), named.library);
        assert.deepEqual(display.saved, saved); assert.deepEqual(display.draft, draft); assert.equal(display.dirty, true);
        assert.equal(state.uiApplyCalls, 0); assert.equal(state.values.get(displayKey(p)), encoded(saved));
      },
      async "copy and rename stable IDs without applying"() {
        const lib = library(), p = await setup(preference(1), lib), before = currentView();
        await nameOperation(actionButton(IDs[0], "copy"), "Copied");
        const copied = named.library.schemes.find(item => item.name === "Copied"); assert.ok(copied); assert.notEqual(copied.id, IDs[0]);
        assert.deepEqual(copied.preferences, lib.schemes[0].preferences);
        await nameOperation(actionButton(copied.id, "rename"), "Renamed");
        assert.equal(named.library.schemes.find(item => item.id === copied.id).name, "Renamed");
        assert.deepEqual(named.library.schemes[0], lib.schemes[0]); assert.equal(currentView(), before);
        assert.deepEqual(storedLibrary(p), named.library); assert.equal(state.uiApplyCalls, 0);
      },
      async "select and device previews never apply"() {
        const lib = library(); await setup(preference(1), lib); const before = currentView();
        await click(actionButton(IDs[1], "select"));
        for (const [device, label] of [["desktop", "桌面"], ["tablet", "平板"], ["mobile", "手机"]]) {
          await click(button(label, document.querySelector("[aria-label=预览设备]")));
          const preview = document.querySelector("[data-device]"); assert.equal(preview.dataset.device, device);
          assert.equal(preview.children.length, lib.schemes[1].preferences.devices[device].items.filter(item => item.visible).length);
          assert.equal(actionButton(IDs[1], "select").getAttribute("aria-pressed"), "true");
          assert.equal(currentView(), before); assert.equal(state.uiApplyCalls, 0);
        }
      },
      async "apply cancellation, backdrop, confirmation and focus"() {
        const lib = library(), saved = preference(1), p = await setup(saved, lib);
        await click(actionButton(IDs[1], "select")); const trigger = button("预览并应用这套方案");
        await click(trigger); assert.match(dlg().textContent, /应用这套完整显示方案/);
        assert.equal(document.activeElement, dlg().querySelector("h2"));
        await click(button("取消", dlg())); assert.equal(dlg(), null); assert.equal(document.activeElement, trigger);
        assert.deepEqual(display.saved, saved); await click(trigger); await backdrop(); assert.equal(state.uiApplyCalls, 0);
        await click(trigger); await confirm(); assert.equal(dlg(), null); assert.equal(state.uiApplyCalls, 1);
        assert.deepEqual(display.saved, lib.schemes[1].preferences); assert.deepEqual(display.draft, display.saved);
        assert.equal(display.dirty, false); assert.equal(state.values.get(displayKey(p)), encoded(display.saved));
        assert.deepEqual(named.library, lib);
      },
      async "applySnapshot storage failure is view-atomic"() {
        const saved = preference(1), next = preference(8), p = await setup(saved), before = currentView();
        for (const fault of ["quota", "drop"]) {
          state.faults.set(displayKey(p), fault); assert.equal(await apply(next), false);
          assert.equal(currentView(), before); assert.deepEqual(display.saved, saved); assert.deepEqual(display.draft, saved);
          assert.equal(state.values.get(displayKey(p)), encoded(saved)); assert.equal(display.canUndo, false);
        }
        state.faults.clear(); state.values.set(displayKey(p), encoded(preference(12)));
        assert.equal(await apply(next), false, "CAS rejects stale current-display writer"); assert.equal(currentView(), before);
        assert.equal(state.values.get(displayKey(p)), encoded(preference(12)));
        state.values.set(displayKey(p), encoded(saved));
        assert.equal(await apply({ ...next, finance: "SYNTHETIC_FORBIDDEN" }), false);
        await edit(preference(4)); const draft = clone(display.draft);
        assert.equal(await apply(next), false, "Dirty current display cannot be overwritten"); assert.deepEqual(display.draft, draft);
        await act(async () => display.cancel()); await flush(); assert.equal(await apply(next), true);
        assert.equal(currentView(), encoded(next)); assert.equal(display.canUndo, false);
      },
      async "dirty draft failed save-as retains draft"() {
        const lib = library(), saved = preference(1), p = await setup(saved, lib), draft = preference(6);
        await edit(draft); await click("预览并应用这套方案"); assert.match(dlg().textContent, /先保留未保存/);
        await confirm(); await typeName("Draft safe"); state.faults.set(libraryKey(p), "quota"); await confirm();
        assert.ok(dlg()); assert.match(dlg().querySelector("[role=alert]").textContent, /另存失败/);
        assert.deepEqual(display.draft, draft); assert.equal(display.dirty, true); assert.deepEqual(display.saved, saved);
        assert.deepEqual(named.library, lib); assert.deepEqual(storedLibrary(p), lib); assert.equal(state.uiApplyCalls, 0);
        await click(button("取消切换", dlg())); assert.deepEqual(display.draft, draft);
      },
      async "dirty draft saved before separate apply confirmation"() {
        const lib = library(), saved = preference(1), p = await setup(saved, lib), draft = preference(6);
        await edit(draft); await click("预览并应用这套方案"); await confirm();
        await typeName("Preserved draft"); await confirm();
        assert.ok(dlg()); assert.match(dlg().textContent, /应用这套完整显示方案/);
        assert.deepEqual(named.library.schemes.find(item => item.name === "Preserved draft").preferences, draft);
        assert.equal(state.uiApplyCalls, 0); assert.deepEqual(display.saved, saved); assert.deepEqual(display.draft, saved);
        assert.deepEqual(storedLibrary(p), named.library); await confirm();
        assert.equal(state.uiApplyCalls, 1); assert.deepEqual(display.saved, lib.schemes[0].preferences);
      },
      async "active deletion protected and other deletion targets exact ID"() {
        const lib = library(), p = await setup(lib.schemes[0].preferences, lib);
        assert.equal(document.querySelector(`[data-layout-id='${IDs[0]}'][data-layout-action=delete]`), null);
        assert.match(actionButton(IDs[0], "select").closest("article").textContent, /当前使用，请先切换再删除/);
        const before = currentView(), original = state.values.get(libraryKey(p));
        await click(actionButton(IDs[1], "delete")); assert.match(dlg().textContent, /Synthetic 2/);
        await click(button("取消", dlg())); assert.equal(state.values.get(libraryKey(p)), original);
        await click(actionButton(IDs[1], "delete")); await backdrop(); assert.equal(state.values.get(libraryKey(p)), original);
        await click(actionButton(IDs[1], "delete")); await confirm();
        assert.deepEqual(named.library.schemes.map(item => item.id), [IDs[0]]);
        assert.deepEqual(storedLibrary(p).schemes, [lib.schemes[0]]); assert.equal(currentView(), before);
        assert.ok(document.activeElement?.isConnected); assert.equal(document.activeElement.tagName, "BUTTON");
      },
      async "same-tick double submissions"() {
        const p = await setup(), before = currentView();
        await nameOperation("另存为新方案", "One", true); assert.equal(named.library.schemes.length, 1);
        const id = named.library.schemes[0].id;
        await nameOperation(actionButton(id, "copy"), "Two", true); assert.equal(named.library.schemes.length, 2);
        await nameOperation(actionButton(id, "rename"), "Renamed once", true); assert.equal(named.library.schemes[0].name, "Renamed once");
        assert.equal(currentView(), before);
        await act(async () => display.update(next => { next.devices.desktop.gap = 31; }));
        await act(async () => { assert.equal(display.save(), true); }); await flush();
        await click(actionButton(id, "select")); await click("预览并应用这套方案"); await confirm(true);
        assert.equal(state.uiApplyCalls, 1, "Same-tick duplicate confirmation applies only once");
        await click(actionButton(named.library.schemes[1].id, "rename")); await typeName("renamed ONCE"); await confirm(true);
        assert.ok(dlg()); assert.match(dlg().querySelector("[role=alert]").textContent, /同名/); await click(button("取消", dlg()));
        assert.deepEqual(storedLibrary(p), named.library);
      },
      async "library quota, dropped write, retry and fresh mount"() {
        const p = await setup(), before = currentView();
        for (const fault of ["quota", "drop"]) {
          state.faults.set(libraryKey(p), fault); await nameOperation("另存为新方案", "Retry me");
          assert.ok(dlg()); assert.equal(named.library.schemes.length, 0); assert.equal(state.values.has(libraryKey(p)), false);
          assert.equal(currentView(), before); await click(button("取消", dlg()));
        }
        state.faults.clear(); await nameOperation("另存为新方案", "Retry me");
        const saved = clone(named.library); await unmount(); await mount(p);
        assert.deepEqual(named.library, saved); assert.equal(currentView(), before); assert.equal(display.dirty, false);
      },
      async "queued mutation CAS preserves another window"() {
        const lib = library(), p = await setup(preference(1), lib), wait = gate(); state.lockGate = wait;
        let pending;
        await act(async () => { pending = named.rename(IDs[0], "Must not overwrite"); });
        await until(() => state.lockWaits > 0, "Actual hook write reached real Web Lock");
        const external = clone(lib); external.schemes[0].name = "Other window";
        const raw = encoded({ version: 1, library: external, base: null }); state.values.set(libraryKey(p), raw);
        state.lockGate = null; await act(async () => { wait.release(); assert.equal(await pending, false); }); await flush();
        assert.equal(state.values.get(libraryKey(p)), raw); assert.deepEqual(named.library, lib); assert.match(named.message, /其他窗口/);
        await storageEvent(libraryKey(p)); assert.deepEqual(named.library, external);
        assert.equal(await mutate(() => named.rename(IDs[0], "Retried safely")), true);
        assert.equal(storedLibrary(p).schemes[0].name, "Retried safely");
      },
      async "hook name, capacity and own-key validation"() {
        const p = await setup();
        assert.equal(await mutate(() => named.add("Alpha", preference(1))), true);
        for (const invalid of ["alpha", "Ａｌｐｈａ", "", " ", "x".repeat(31), "bad\u202ename", "bad\nname"]) {
          const raw = state.values.get(libraryKey(p)); assert.equal(await mutate(() => named.add(invalid, preference(2))), false);
          assert.equal(state.values.get(libraryKey(p)), raw);
        }
        let getterCalls = 0;
        const hostile = preference(3); Object.defineProperty(hostile, "secret", { enumerable: false, get() { getterCalls++; return "SYNTHETIC"; } });
        assert.equal(await mutate(() => named.add("Hostile", hostile)), false); assert.equal(getterCalls, 0);
        const inherited = Object.create(preference(3)); assert.equal(await mutate(() => named.add("Inherited", inherited)), false);
        for (let n = 2; n <= 10; n++) assert.equal(await mutate(() => named.add(`Layout ${n}`, preference(n))), true);
        const raw = state.values.get(libraryKey(p));
        assert.equal(await mutate(() => named.add("Eleven", preference(4))), false);
        assert.equal(await mutate(() => named.copy(named.library.schemes[0].id, "Copy eleven")), false);
        assert.equal(named.library.schemes.length, 10); assert.equal(state.values.get(libraryKey(p)), raw);
      },
      async "local, guest, cloud ownership and fresh mounts"() {
        const all = [profile(), profile("guest"), profile("cloud", "qa-owner-A"), profile("cloud", "qa-owner-B")];
        state.clientAvailable = false;
        for (const [index, p] of all.entries()) {
          const lib = library([preference(index + 2)]); lib.schemes[0].name = `Scope ${index}`;
          seed(p, preference(index + 8), lib);
        }
        const originals = new Map(state.values);
        for (const [index, p] of all.entries()) {
          await mount(p); assert.equal(named.library.schemes[0].name, `Scope ${index}`); assert.deepEqual(display.saved, preference(index + 8));
          await unmount(); await mount(p); assert.equal(named.library.schemes[0].name, `Scope ${index}`);
        }
        assert.equal(new Set(all.map(libraryKey)).size, 4); assert.deepEqual(state.values, originals); assert.equal(state.requests.length, 0);
      },
      async "offline error and retry through actual sync and transport"() {
        state.offline = true; const p = await setup(preference(1), undefined, "cloud", "qa-owner-A");
        await until(() => named.syncStatus === "error", "Real named sync reports offline failure");
        const before = currentView(); await nameOperation("另存为新方案", "Offline saved");
        assert.equal(named.library.schemes.length, 1); await until(() => named.syncStatus === "error", "Local save still reports remote failure");
        assert.deepEqual(storedLibrary(p), named.library); state.offline = false; await click("重试方案库同步");
        await until(() => named.syncStatus === "ready", "Real retry reaches ready");
        assert.deepEqual(state.rows.get(`user_ui_layout_libraries:${p.ownerId}`).library, named.library);
        assert.ok(state.requests.some(request => request.table === "user_ui_layout_libraries" && request.operation === "insert"));
        assert.equal(currentView(), before); assert.equal(state.uiApplyCalls, 0);
      },
      async "remote library never applies saved or dirty preferences"() {
        const p = profile("cloud", "qa-owner-A"), saved = seed(p), remote = library();
        state.rows.set(`user_ui_layout_libraries:${p.ownerId}`, { revision: 1, library: remote });
        await mount(p); await until(() => named.syncStatus === "ready", "Remote library imported");
        assert.deepEqual(named.library, remote); assert.deepEqual(display.saved, saved); const draft = preference(7); await edit(draft);
        const updated = clone(remote); updated.schemes[0].name = "Remote rename";
        state.rows.set(`user_ui_layout_libraries:${p.ownerId}`, { revision: 2, library: updated });
        await mutate(() => named.retrySync()); await until(() => named.library.schemes[0].name === "Remote rename", "Updated remote library imported");
        assert.deepEqual(display.saved, saved); assert.deepEqual(display.draft, draft); assert.equal(display.dirty, true);
        assert.equal(currentView(), encoded(saved)); assert.equal(state.uiApplyCalls, 0);
      },
      async "whole-library conflict requires confirmation and never applies"() {
        const local = library(), remote = library([preference(10)]); remote.schemes[0].name = "Cloud only";
        const p = profile("cloud", "qa-owner-A"), saved = seed(p, preference(1), local);
        state.rows.set(`user_ui_layout_libraries:${p.ownerId}`, { revision: 3, library: remote }); await mount(p);
        await until(() => named.syncStatus === "conflict", "Divergent whole libraries conflict");
        assert.deepEqual(named.library, local); assert.equal(button("另存为新方案").disabled, true);
        await click("采用云端整份方案库…"); assert.deepEqual(named.library, local);
        await click(button("取消", dlg())); assert.deepEqual(named.library, local);
        await click("采用云端整份方案库…"); await confirm(); await until(() => named.syncStatus === "ready", "Confirmed conflict resolves");
        assert.ok(!dlg(), "Successful explicit resolution closes the dialog, not an outdated render-status error"); assert.deepEqual(named.library, remote); assert.deepEqual(display.saved, saved);
        assert.equal(currentView(), encoded(saved)); assert.equal(state.uiApplyCalls, 0);
      },
      async "A-B-A stale remote responses and dialog isolation"() {
        for (const operation of ["read", "insert"]) {
          const a = profile("cloud", "qa-owner-A"), b = profile("cloud", "qa-owner-B"), lib = library([preference(5)]);
          seed(a, preference(1), operation === "insert" ? lib : undefined); seed(b, preference(4));
          const wait = gate(); state.remoteGates.set(`user_ui_layout_libraries:${operation}:${a.ownerId}`, wait);
          if (operation === "read") state.rows.set(`user_ui_layout_libraries:${a.ownerId}`, { revision: 1, library: lib });
          else state.rows.delete(`user_ui_layout_libraries:${a.ownerId}`);
          await mount(a); await until(() => wait.started > 0, "Old owner remote operation started");
          await click("另存为新方案"); await typeName("Must not leak");
          await mount(b); assert.equal(dlg(), null); assert.deepEqual(named.library.schemes, []); assert.deepEqual(display.saved, preference(4));
          const bRaw = state.values.get(libraryKey(b));
          state.remoteGates.clear(); const a2 = profile("cloud", a.ownerId); await mount(a2);
          await until(() => named.syncStatus === "ready", "Fresh A epoch independently completes");
          const before = clone(named.library), beforeSaved = clone(display.saved), raw = state.values.get(libraryKey(a2));
          await act(async () => wait.release()); await flush(); await flush();
          assert.deepEqual(named.library, before); assert.deepEqual(display.saved, beforeSaved);
          assert.equal(state.values.get(libraryKey(a2)), raw); assert.equal(state.values.get(libraryKey(b)), bRaw);
          assert.doesNotMatch(document.body.textContent, /Must not leak/); await unmount();
        }
      },
      async "A-B-A queued local operation and stale handlers are fenced"() {
        state.clientAvailable = false;
        const lib = library(), a = profile("cloud", "qa-owner-A"), b = profile("cloud", "qa-owner-B");
        seed(a, preference(1), lib); seed(b, preference(4)); await mount(a);
        const oldNamed = named, oldDisplay = display, raw = state.values.get(libraryKey(a)), wait = gate(); state.lockGate = wait;
        let pending; await act(async () => { pending = named.rename(IDs[0], "Stale rename"); });
        await until(() => state.lockWaits > 0, "Old local mutation waiting on actual lock");
        await mount(b); const bRaw = state.values.get(libraryKey(b));
        const a2 = profile("cloud", a.ownerId); await mount(a2); state.lockGate = null;
        await act(async () => { wait.release(); assert.equal(await pending, false); }); await flush();
        assert.equal(await mutate(() => oldNamed.add("Stale add", preference(8))), false);
        assert.equal(await mutate(() => oldDisplay.applySnapshot(preference(8))), false);
        assert.equal(state.values.get(libraryKey(a2)), raw); assert.equal(state.values.get(libraryKey(b)), bRaw);
        assert.deepEqual(named.library, lib); assert.deepEqual(display.saved, preference(1));
      },
      async "changed dialog target is not deleted"() {
        const lib = library(), p = await setup(preference(1), lib);
        await click(actionButton(IDs[1], "delete")); const external = clone(lib); external.schemes[1].name = "Externally renamed";
        const raw = encoded({ version: 1, library: external, base: null }); state.values.set(libraryKey(p), raw);
        await storageEvent(libraryKey(p)); await confirm();
        assert.ok(dlg()); assert.match(dlg().querySelector("[role=alert]").textContent, /更改或移除/);
        assert.equal(state.values.get(libraryKey(p)), raw); assert.deepEqual(named.library, external); assert.equal(state.uiApplyCalls, 0);
      },
      async "background poll cannot refresh an open conflict confirmation"() {
        const local = library(), remote = library([preference(10)]); remote.schemes[0].name = "Cloud first";
        const p = profile("cloud", "qa-owner-A"); seed(p, preference(1), local);
        state.rows.set(`user_ui_layout_libraries:${p.ownerId}`, { revision: 4, library: remote }); await mount(p);
        await until(() => named.syncStatus === "conflict", "Initial conflict is available");
        await click("以本机整份方案库更新云端…");
        const updated = clone(remote); updated.schemes[0].name = "Cloud newer";
        state.rows.set(`user_ui_layout_libraries:${p.ownerId}`, { revision: 5, library: updated });
        await mutate(() => named.retrySync()); await until(() => named.syncStatus === "conflict", "Background poll sees newer conflict");
        await confirm(); assert.ok(dlg(), "Stale confirmation remains open with explanation");
        assert.ok(dlg().querySelector("[role=alert]").textContent); assert.equal(state.rows.get(`user_ui_layout_libraries:${p.ownerId}`).revision, 5);
        assert.deepEqual(state.rows.get(`user_ui_layout_libraries:${p.ownerId}`).library, updated);
        assert.deepEqual(named.library, local); assert.equal(state.uiApplyCalls, 0);
        await click(button("取消", dlg())); await click("以本机整份方案库更新云端…"); await confirm();
        assert.ok(!dlg()); assert.deepEqual(state.rows.get(`user_ui_layout_libraries:${p.ownerId}`).library, local);
      },
      async "focus ticket is consumed after cancellation"() {
        const lib = library(); await setup(preference(1), lib);
        const rename = actionButton(IDs[0], "rename"); await click(rename); await click(button("取消", dlg()));
        assert.ok(document.activeElement === rename, "Cancel restores the original trigger");
        const second = actionButton(IDs[1], "select"); await click(second); await flush(); await flush();
        assert.ok(document.activeElement === second, "Selecting another scheme does not replay the old focus ticket");
        assert.equal(second.getAttribute("aria-pressed"), "true"); assert.equal(state.uiApplyCalls, 0);
      },
      async "native Enter saves once with input focus"() {
        const p = await setup(); await click("另存为新方案"); await typeName("Keyboard saved");
        assert.equal(document.activeElement, dlg().querySelector("input")); await nativeKey("Enter");
        await until(() => !dlg(), "Native Enter submits real form");
        assert.equal(named.library.schemes.length, 1); assert.equal(named.library.schemes[0].name, "Keyboard saved");
        assert.deepEqual(storedLibrary(p), named.library); assert.equal(state.uiApplyCalls, 0);
        assert.ok(document.activeElement === button("另存为新方案"), "Successful Enter returns focus to the save-as button");
      },
      async "native Escape cancels and restores focus"() {
        const lib = library(), p = await setup(preference(1), lib), before = new Map(state.values);
        for (const trigger of [button("另存为新方案"), actionButton(IDs[0], "copy"), actionButton(IDs[0], "rename"), actionButton(IDs[1], "delete"), button("预览并应用这套方案")]) {
          await click(trigger); assert.ok(dlg()); await nativeKey("Escape");
          await until(() => !dlg(), "Native Escape invokes actual dialog cancellation");
          assert.equal(document.activeElement, trigger); assert.deepEqual(state.values, before); assert.equal(state.uiApplyCalls, 0);
        }
        assert.deepEqual(storedLibrary(p), lib);
      },
      async "native Tab trap and focus indication"() {
        await setup(); await click("另存为新方案");
        const dialog = dlg(), input = dialog.querySelector("input"); assert.equal(document.activeElement, input);
        const controls = [...dialog.querySelectorAll("button,input")];
        const visited = new Set();
        for (let n = 0; n < controls.length * 2; n++) {
          await nativeKey("Tab"); assert.ok(dialog.contains(document.activeElement), "Native Tab cannot escape modal");
          visited.add(document.activeElement);
        }
        assert.ok(controls.every(control => visited.has(control)), "Native Tab reaches every dialog control");
        for (let n = 0; n < controls.length + 1; n++) { await nativeKey("Tab", true); assert.ok(dialog.contains(document.activeElement)); }
        const computed = getComputedStyle(document.activeElement); assert.notEqual(computed.outlineStyle, "none");
        assert.ok(parseFloat(computed.outlineWidth) >= 2, "Actual CSS draws keyboard focus");
        await nativeKey("Escape"); assert.equal(document.activeElement, button("另存为新方案"));
      },
    };
    async function nativeKey(key, shift = false) {
      let result; await act(async () => { result = await ipcRenderer.invoke("named-layouts-qa-control", { kind: "key", key, shift }); }); await flush();
      assert.equal(result.visible, true, "Native keys run only in the separate visible window"); assert.equal(result.focused, true);
    }
    for (const width of [320, 390, 1280, 1440]) cases[`actual CSS responsive ${width}px`] = async () => {
      await ipcRenderer.invoke("named-layouts-qa-control", { kind: "resize", width });
      const lib = library(); lib.schemes[1].name = "长名称排版验证".repeat(4).slice(0, 30);
      await setup(preference(1), lib); await click(actionButton(IDs[1], "select")); await flush();
      assert.equal(innerWidth, width, "Actual Chromium layout viewport matches requested width");
      assert.equal(getComputedStyle(document.querySelector(`.${styles.managerBody}`)).display, "grid");
      const regions = [...document.querySelector(`.${styles.managerBody}`).children].map(element => element.getBoundingClientRect());
      assert.ok(width <= 390 ? regions[1].top >= regions[0].bottom : regions[1].left > regions[0].left, "Actual CSS stacks mobile and splits desktop");
      function geometry(container) {
        assert.ok(document.documentElement.scrollWidth <= innerWidth + 1, "No document horizontal overflow");
        let controls = 0;
        for (const control of container.querySelectorAll("button,input")) {
          if (!control.getClientRects().length) continue;
          control.scrollIntoView({ block: "center", inline: "nearest" });
          const rect = control.getBoundingClientRect(); controls++;
          assert.ok(rect.width >= 43.9 && rect.height >= 43.9, `44px control: ${control.textContent.trim().slice(0, 20) || "name input"}`);
          assert.ok(rect.left >= -1 && rect.right <= innerWidth + 1, "Control is not horizontally clipped");
          assert.ok(rect.top >= -1 && rect.bottom <= innerHeight + 1, "Control can be scrolled completely into view");
          if (control.tagName === "BUTTON") {
            assert.ok(control.scrollWidth <= control.clientWidth + 1, "Button label does not overflow");
            assert.ok(control.scrollHeight <= control.clientHeight + 1, "Button label is not vertically clipped");
          }
          for (let parent = control.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
            const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
            if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) assert.ok(rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1, "Ancestor cannot clip control horizontally");
            if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) assert.ok(rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1, "Ancestor cannot clip control vertically");
          }
        }
        assert.ok(controls >= 3, "Geometry inspected multiple actual controls");
      }
      geometry(document.querySelector(`.${styles.manager}`)); window.scrollTo(0, 0); await flush();
      const capture = await ipcRenderer.invoke("named-layouts-qa-control", { kind: "capture", name: `actual-${width}` });
      assert.equal(capture.width, width); assert.ok(capture.height > 0);
      await click("另存为新方案"); await typeName(lib.schemes[1].name); geometry(dlg());
      const modalCapture = await ipcRenderer.invoke("named-layouts-qa-control", { kind: "capture", name: `dialog-${width}` });
      assert.equal(modalCapture.width, width); await click(button("取消", dlg()));
      assert.equal(state.uiApplyCalls, 0);
    };
    for (const name of GROUPS[mode]) {
      assert.equal(typeof cases[name], "function", "Every declared group must execute, never skip");
      await check(name, cases[name]);
    }
    return { groups, assertions, networkAttempts, transportRequests, authCalls, sourceHashes,
      css: { module: "actual file with deterministic class mapping", globals: "actual rules minus build-only import and resource-loading font faces" } };
  };
}
