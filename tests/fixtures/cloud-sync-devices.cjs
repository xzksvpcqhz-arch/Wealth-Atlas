/* Synthetic two-device acceptance. Never opens the application profile or hosted
 * Supabase. Test-only Node integration is not used by the production app. */
const path = require("node:path");
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

if (process.type === "browser") {
  const { app, BrowserWindow, protocol, ipcMain } = require("electron");
  const assert = require("node:assert/strict");
  const { mkdirSync } = require("node:fs");
  const { randomUUID } = require("node:crypto");
  const root = path.resolve(__dirname, "../..");
  const profile = path.join(root, "work", "cloud-sync-device-tests", randomUUID());
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile); app.setPath("sessionData", profile);
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  protocol.registerSchemesAsPrivileged([{ scheme: "wa-devices-test", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const devices = new Map(), cloud = new Map(), checks = [];
  const counters = { reads: 0, inserts: 0, updates: 0, casMisses: 0, blockedExternalRequests: 0 };
  let sequence = 0, pullBarrier = null, historicalSnapshot = null;
  const revision = () => new Date(Date.UTC(2026, 0, 1) + ++sequence).toISOString();
  const copy = (value) => structuredClone(value);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function notify(owner) {
    for (const device of devices.values()) if (device.owner === owner && !device.hintsPaused && !device.win.isDestroyed()) {
      device.win.webContents.send("wa-devices:hint", owner);
    }
  }
  ipcMain.handle("wa-devices:identity", (event, owner) => {
    const device = devices.get(event.sender.id);
    assert.ok(device); assert.ok(owner === null || [OWNER_A, OWNER_B].includes(owner));
    device.owner = owner;
  });
  ipcMain.handle("wa-devices:request", async (event, request) => {
    const device = devices.get(event.sender.id);
    assert.ok(device && device.owner === request.owner);
    device.requests++;
    const url = new URL(request.url);
    assert.equal(url.origin, "https://synthetic-sync.invalid");
    assert.equal(url.pathname, "/rest/v1/user_data");
    assert.equal(url.searchParams.has("on_conflict"), false);
    assert.doesNotMatch(request.headers.prefer ?? "", /resolution=merge-duplicates/);
    const reply = (body, status = 200) => ({ body, status });
    if (device.failure) return reply({ code: "SYNTHETIC", message: "Synthetic provider detail must not reach the UI" }, device.failure);
    if (request.method === "GET") {
      assert.equal(url.searchParams.get("user_id"), `eq.${device.owner}`);
      counters.reads++;
      const result = cloud.has(device.owner) ? [copy(cloud.get(device.owner))] : [];
      if (pullBarrier && device.owner === OWNER_A) {
        const barrier = pullBarrier;
        await new Promise((resolve) => {
          barrier.waiters.push(resolve);
          if (barrier.waiters.length === 2) { pullBarrier = null; barrier.waiters.forEach((release) => release()); }
        });
      }
      return reply(result);
    }
    assert.ok(["POST", "PATCH"].includes(request.method));
    const existing = cloud.get(device.owner);
    if (request.method === "POST") {
      assert.equal(request.body.user_id, device.owner);
      if (existing) return reply({ code: "23505", message: "Synthetic duplicate owner" }, 409);
      counters.inserts++;
    } else {
      assert.equal(url.searchParams.get("user_id"), `eq.${device.owner}`);
      assert.ok(url.searchParams.get("updated_at")?.startsWith("eq."));
      if (!existing || url.searchParams.get("updated_at") !== `eq.${existing.updated_at}`) {
        counters.casMisses++; return reply([]);
      }
      counters.updates++;
    }
    const saved = { data: copy(request.body.data), updated_at: revision() };
    cloud.set(device.owner, saved); notify(device.owner);
    if (device.dropNextWriteAck) { device.dropNextWriteAck = false; return { drop: true }; }
    return reply([copy(saved)], request.method === "POST" ? 201 : 200);
  });
  async function createDevice(name) {
    const win = new BrowserWindow({ show: false, webPreferences: {
      partition: `persist:synthetic-device-${name}`, backgroundThrottling: false,
      nodeIntegration: true, contextIsolation: false, sandbox: false,
    } });
    const device = { name, win, owner: null, requests: 0, failure: null, hintsPaused: false, dropNextWriteAck: false };
    devices.set(win.webContents.id, device);
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_request, callback) => {
      counters.blockedExternalRequests++; callback({ cancel: true });
    });
    win.webContents.session.protocol.handle("wa-devices-test", () => new Response("<html><body><div id='root'></div></body></html>", { headers: { "Content-Type": "text/html" } }));
    await win.loadURL("wa-devices-test://app/");
    await mount(device);
    return device;
  }
  const run = (device, command, args = {}) => device.win.webContents.executeJavaScript(`window.syntheticDevice.run(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
  const mount = (device) => device.win.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).mountDevice(${JSON.stringify(device.name)})`);
  async function reopen(device) {
    const loaded = new Promise((resolve) => device.win.webContents.once("did-finish-load", resolve));
    device.win.webContents.reload(); await loaded; await mount(device);
  }
  async function waitFor(predicate) {
    for (let attempt = 0; attempt < 250; attempt++) { if (await predicate()) return; await delay(15); }
    throw new Error("Synthetic two-device wait exceeded limit");
  }
  async function check(name, action) {
    try { await action(); checks.push({ name, pass: true }); }
    catch (error) {
      const frame = error.stack?.split("\n").find((line) => line.includes(__filename + ":"));
      const line = frame?.match(/:(\d+):\d+\)?$/)?.[1] ?? "unknown";
      throw new Error(`Two-device acceptance failed: ${name}; ${error.name} at fixture line ${line}; record contents suppressed.`);
    }
  }
  app.whenReady().then(async () => {
    const a = await createDevice("A"), b = await createDevice("B");
    const state = (device) => run(device, "state");
    // A previously-ready label can remain visible during the local edit debounce.
    // Require its actual durable revision to be acknowledged before proceeding.
    const ready = async (device) => { const current = await state(device); return current.status === "ready" && !current.pending && current.persistedMatchesView; };
    await check("two independent persistent sessions authenticate the same synthetic owner", async () => {
      assert.notEqual(a.win.webContents.session.storagePath, b.win.webContents.session.storagePath);
      await run(a, "login", { owner: OWNER_A }); await run(b, "login", { owner: OWNER_A });
      assert.equal((await state(a)).owner, OWNER_A); assert.equal((await state(b)).owner, OWNER_A);
    });
    await check("SDK insert/update and hints propagate a multi-currency snapshot to the second device", async () => {
      await run(a, "seed");
      await waitFor(async () => ready(a).then(async (ok) => ok && (await state(b)).data.accounts.length === 3 && await ready(b)));
      assert.deepEqual((await state(a)).data, (await state(b)).data);
      assert.ok(counters.inserts >= 1); assert.ok(counters.updates >= 1);
    });
    await check("transfers never become income/expense and historical FX remains unchanged", async () => {
      for (const device of [a, b]) {
        const info = await state(device);
        const { usdReport, ...nativeMetrics } = info.metrics;
        assert.deepEqual(nativeMetrics, { sgd: 2799, myr: 781, usd: 500, income: 2000, expense: 15, budget: 85 });
        // The existing calculation multiplies the chained rate first. Compare
        // its unrounded floating-point result without changing app calculations.
        assert.ok(Number.isFinite(usdReport) && Math.abs(usdReport - 2331.6) < 1e-8);
        assert.equal(info.data.transfers[0].fxSnapshot.rate, 3.48);
        historicalSnapshot = copy(info.data.transfers[0].fxSnapshot);
      }
    });
    await check("independent offline edits merge through an actual SDK CAS race", async () => {
      await run(a, "network", { online: false }); await run(b, "network", { online: false });
      await run(a, "edit", { field: "transactions", id: "income-sgd", values: { amount: 2100 } });
      await run(b, "edit", { field: "transactions", id: "expense-myr", values: { amount: 20 } });
      const misses = counters.casMisses; pullBarrier = { waiters: [] };
      await Promise.all([run(a, "network", { online: true }), run(b, "network", { online: true })]);
      await waitFor(async () => {
        const [x, y] = await Promise.all([state(a), state(b)]);
        return x.status === "ready" && y.status === "ready" && x.data.transactions[0].amount === 2100 && y.data.transactions[0].amount === 2100
          && x.data.transactions[1].amount === 20 && y.data.transactions[1].amount === 20;
      });
      assert.ok(counters.casMisses > misses);
      assert.deepEqual((await state(a)).data, (await state(b)).data);
    });
    await check("offline pending work survives device reopen without duplicate transaction IDs", async () => {
      await run(b, "network", { online: false });
      const reads = counters.reads;
      await run(b, "add", { record: { id: "offline-myr", type: "expense", accountId: "myr", currency: "MYR", amount: 7, category: "Synthetic", date: "2026-10-02" } });
      assert.equal(counters.reads, reads); assert.equal((await state(b)).pending, true);
      await reopen(b);
      await waitFor(async () => await ready(a) && await ready(b) && (await state(a)).data.transactions.some((t) => t.id === "offline-myr"));
      const x = await state(b);
      assert.equal(x.pending, false); assert.equal(x.data.transactions.filter((t) => t.id === "offline-myr").length, 1);
    });
    await check("soft delete and restore reach both devices using the original record ID", async () => {
      await run(a, "edit", { field: "transactions", id: "offline-myr", values: { deleted: true, deletedAt: "2026-10-03T00:00:00.000Z" } });
      await waitFor(async () => (await state(b)).data.transactions.find((t) => t.id === "offline-myr")?.deleted === true && await ready(b));
      await run(b, "edit", { field: "transactions", id: "offline-myr", values: { deleted: false }, unset: ["deletedAt"] });
      await waitFor(async () => (await state(a)).data.transactions.find((t) => t.id === "offline-myr")?.deleted === false && await ready(a));
      assert.deepEqual((await state(a)).metrics, (await state(b)).metrics);
    });
    await check("transfer delete/restore updates both balances without changing income or expense", async () => {
      const original = (await state(a)).metrics;
      await run(a, "edit", { field: "transfers", id: "transfer-sgd-myr", values: { deleted: true, deletedAt: "2026-10-03T00:00:00.000Z" } });
      await waitFor(async () => (await state(b)).data.transfers[0].deleted === true && await ready(a) && await ready(b));
      for (const device of [a, b]) {
        const metrics = (await state(device)).metrics;
        assert.equal(metrics.sgd, original.sgd + 201); assert.equal(metrics.myr, original.myr - 696);
        assert.equal(metrics.usd, original.usd); assert.equal(metrics.income, original.income); assert.equal(metrics.expense, original.expense);
      }
      await run(b, "edit", { field: "transfers", id: "transfer-sgd-myr", values: { deleted: false }, unset: ["deletedAt"] });
      await waitFor(async () => (await state(a)).data.transfers[0].deleted === false && await ready(a) && await ready(b));
      assert.deepEqual((await state(a)).metrics, original); assert.deepEqual((await state(b)).metrics, original);
    });
    await check("confirmed permanent deletion cannot be resurrected by a stale reopened device", async () => {
      await run(b, "edit", { field: "transactions", id: "offline-myr", values: { deleted: true } });
      await waitFor(async () => (await state(a)).data.transactions.find((t) => t.id === "offline-myr")?.deleted === true && await ready(a));
      await run(a, "network", { online: false });
      await run(b, "remove", { field: "transactions", id: "offline-myr" });
      await waitFor(async () => await ready(b) && !cloud.get(OWNER_A).data.transactions.some((t) => t.id === "offline-myr"));
      assert.ok((await state(a)).data.transactions.some((t) => t.id === "offline-myr"));
      await reopen(a);
      await waitFor(async () => await ready(a) && !(await state(a)).data.transactions.some((t) => t.id === "offline-myr"));
      assert.equal(cloud.get(OWNER_A).data.transactions.some((t) => t.id === "offline-myr"), false);
    });
    await check("conflicting edits preserve the losing device's draft and winning cloud record", async () => {
      await run(a, "network", { online: false }); await run(b, "network", { online: false });
      await run(a, "edit", { field: "transactions", id: "expense-myr", values: { amount: 21 } });
      await run(b, "edit", { field: "transactions", id: "expense-myr", values: { amount: 22 } });
      await run(a, "network", { online: true }); await waitFor(() => ready(a));
      await run(b, "network", { online: true });
      await waitFor(async () => (await state(b)).pause === "conflict");
      assert.equal((await state(b)).data.transactions.find((t) => t.id === "expense-myr").amount, 22);
      assert.equal(cloud.get(OWNER_A).data.transactions.find((t) => t.id === "expense-myr").amount, 21);
      await run(b, "edit", { field: "transactions", id: "expense-myr", values: { amount: 21 } });
      await run(b, "sync"); await waitFor(() => ready(b));
    });
    await check("permission failures persistently pause instead of retrying on hints/focus", async () => {
      a.failure = 403;
      await run(a, "edit", { field: "transactions", id: "income-sgd", values: { note: "synthetic paused draft" } });
      await waitFor(async () => (await state(a)).pause === "permission");
      const updates = counters.updates, requests = a.requests;
      await run(a, "focus"); notify(OWNER_A); await delay(75);
      assert.equal(counters.updates, updates); assert.equal((await state(a)).pause, "permission");
      assert.equal(a.requests, requests); assert.doesNotMatch((await state(a)).error, /Synthetic provider detail/);
      a.failure = null; await run(a, "sync");
      await waitFor(async () => await ready(a) && await ready(b));
    });
    await check("accepted upload with a lost ACK replays without a second cloud write", async () => {
      const updates = counters.updates; a.dropNextWriteAck = true;
      await run(a, "edit", { field: "transactions", id: "income-sgd", values: { note: "synthetic ack lost" } });
      await waitFor(async () => (await state(a)).lastError === "network" && cloud.get(OWNER_A).data.transactions[0].note === "synthetic ack lost");
      await run(a, "network", { online: false }); await run(a, "network", { online: true });
      await waitFor(async () => await ready(a) && await ready(b));
      assert.equal(counters.updates, updates + 1);
      assert.equal((await state(a)).pending, false);
    });
    await check("sign-out removes private view and a second owner cannot drain the first owner's queue", async () => {
      await run(b, "network", { online: false });
      await run(b, "edit", { field: "transactions", id: "income-sgd", values: { note: "synthetic owner-A pending" } });
      assert.equal((await state(b)).pending, true);
      await run(b, "logout");
      assert.equal((await state(b)).data.transactions.length, 0);
      await run(b, "network", { online: true }); await run(b, "login", { owner: OWNER_B });
      assert.equal((await state(b)).data.transactions.length, 0);
      await run(b, "add", { record: { id: "income-sgd", type: "income", accountId: "other-synthetic", currency: "SGD", amount: 900, category: "Synthetic", date: "2026-10-01" } });
      await waitFor(() => ready(b));
      assert.notEqual(cloud.get(OWNER_A).data.transactions[0].note, "synthetic owner-A pending");
      assert.equal((await state(a)).data.transactions[0].amount, 2100);
      await run(b, "login", { owner: OWNER_A });
      await waitFor(async () => await ready(a) && cloud.get(OWNER_A).data.transactions[0].note === "synthetic owner-A pending");
      assert.equal(cloud.get(OWNER_B).data.transactions[0].amount, 900);
    });
    await check("new manual FX history syncs without rewriting a historical transfer snapshot", async () => {
      await run(a, "add", { field: "fxRates", record: { id: "sgd-myr-new", baseCurrency: "SGD", quoteCurrency: "MYR",
        rate: 3.55, effectiveDate: "2026-10-05", source: "手动输入" } });
      await waitFor(async () => (await state(b)).data.fxRates.some((rate) => rate.id === "sgd-myr-new") && await ready(a) && await ready(b));
      for (const device of [a, b]) {
        const current = await state(device);
        assert.equal(current.data.fxRates.find((rate) => rate.id === "sgd-myr").rate, 3.48);
        assert.deepEqual(current.data.transfers[0].fxSnapshot, historicalSnapshot);
      }
    });
    await check("unassigned local data stays local and final snapshots/FX converge after reopening", async () => {
      await reopen(a); await reopen(b);
      await waitFor(async () => await ready(a) && await ready(b));
      const x = await state(a), y = await state(b);
      assert.deepEqual(x.data, y.data); assert.deepEqual(x.metrics, y.metrics);
      assert.equal(x.persistedMatchesView, true); assert.equal(y.persistedMatchesView, true);
      assert.equal(x.legacyPreserved, true); assert.equal(y.legacyPreserved, true);
      assert.equal(x.data.transactions.some((t) => t.id.startsWith("unassigned-")), false);
      assert.deepEqual(x.data.transfers[0].fxSnapshot, historicalSnapshot);
      assert.equal(counters.blockedExternalRequests, 0);
    });
    for (const device of devices.values()) device.win.destroy();
    console.log(`CLOUD_SYNC_DEVICES_PASS ${JSON.stringify({ checks, realBackendRequests: 0, hostedAuthVerified: false,
      hostedRealtimeVerified: false, independentPersistentSessions: true, counters })}`);
    app.exit(0);
  }).catch((error) => { console.error(error.message?.startsWith("Two-device acceptance failed:") ? error.message : "Two-device harness failed; no private data printed."); app.exit(1); });
} else {
  exports.mountDevice = async (deviceName) => {
    const assert = require("node:assert/strict");
    const { readFileSync } = require("node:fs");
    const { ipcRenderer } = require("electron");
    const ts = require("typescript"), React = require("react");
    const { createRoot } = require("react-dom/client");
    const { createClient } = require("@supabase/supabase-js");
    const { act, useEffect, useState, useSyncExternalStore } = React;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "crypto", { value: require("node:crypto").webcrypto });
    function loadTs(file, replacements = {}) {
      const source = readFileSync(path.resolve(__dirname, "../..", file), "utf8");
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const mod = { exports: {} };
      new Function("require", "module", "exports", compiled)((name) => replacements[name]
        ?? (name === "./auto-login" ? loadTs("lib/auto-login.ts") : undefined)
        ?? (name === "./password-recovery" ? loadTs("lib/password-recovery.ts") : undefined)
        ?? (name === "./auth-diagnostics" ? { reportAuthDiagnostic() {} } : require(name)), mod, mod.exports);
      return mod.exports;
    }
    const merge = loadTs("lib/cloud-merge.ts"), retry = loadTs("lib/cloud-retry.ts");
    const recovery = loadTs("lib/password-recovery.ts");
    const finance = loadTs("lib/finance.ts");
    const profiles = loadTs("lib/data-profile.ts", { "./migrations": loadTs("lib/migrations.ts") });
    const desktopStub = { getDesktopBridge: () => null, activateDesktopDataProfile: async () => undefined };
    const storage = loadTs("lib/storage.ts", { "./cloud-merge": merge, "./cloud-retry": retry, "./desktop": desktopStub, "./data-profile": profiles, "./auth-session": loadTs("lib/auth-session.ts") });
    const { createSnapshotTransport } = loadTs("lib/cloud-transport.ts", { "./cloud-retry": retry });
    const nativeTimeout = window.setTimeout.bind(window);
    const delay = (ms) => new Promise((resolve) => nativeTimeout(resolve, ms));
    window.setTimeout = (callback, ms, ...args) => nativeTimeout(callback, ms === 1200 ? 15 : ms, ...args);
    const state = { online: true, user: localStorage.getItem("synthetic-test-owner"), authListener: null };
    Object.defineProperty(navigator, "onLine", { get: () => state.online, configurable: true });
    await ipcRenderer.invoke("wa-devices:identity", state.user);
    const listeners = new Map();
    ipcRenderer.on("wa-devices:hint", (_event, owner) => listeners.get(owner)?.forEach((listener) => listener()));
    const cloudFunctions = {
      isRetryableAuthError: () => false,
      getOfflineUser: async () => null,
      isRecoveryLink: () => false,
      getCurrentUser: async () => state.user ? { id: state.user, email: "synthetic@example.invalid" } : null,
      signIn: async (owner) => {
        assert.ok([OWNER_A, OWNER_B].includes(owner));
        state.user = owner; localStorage.setItem("synthetic-test-owner", owner);
        await ipcRenderer.invoke("wa-devices:identity", owner);
        const user = { id: owner, email: "synthetic@example.invalid" }; state.authListener?.(user); return user;
      },
      signOut: async () => { state.user = null; localStorage.removeItem("synthetic-test-owner"); await ipcRenderer.invoke("wa-devices:identity", null); state.authListener?.(null); },
      subscribeToAuth: (listener) => { state.authListener = listener; return () => { state.authListener = null; }; },
      subscribeToRemote: (owner, listener) => { const set = listeners.get(owner) ?? new Set(); listeners.set(owner, set); set.add(listener); return () => set.delete(listener); },
      getCloudTransport: (owner) => {
        const scope = profiles.getDataProfile(); assert.equal(scope.ownerId, owner);
        const sb = createClient("https://synthetic-sync.invalid", "sb_publishable_synthetic_only", {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { fetch: async (input, options = {}) => {
            profiles.assertActiveDataProfile(scope);
            if (!state.online) throw new Error("Synthetic offline");
            const url = typeof input === "string" ? input : input.url;
            const headers = Object.fromEntries(new Headers(options.headers).entries());
            const response = await ipcRenderer.invoke("wa-devices:request", { owner, url, method: options.method ?? "GET", headers,
              body: options.body ? JSON.parse(options.body) : null });
            if (response.drop) throw new Error("Synthetic response lost");
            return new Response(JSON.stringify(response.body), { status: response.status, headers: { "Content-Type": "application/json" } });
          } },
        });
        return createSnapshotTransport(sb, owner, 5000);
      },
    };
    const boundary = loadTs("lib/account-boundary.ts", { "./cloud-sync": cloudFunctions,
      "./login-history": loadTs("lib/login-history.ts"),
      "./supabase-client": { isCloudConfigured: () => true }, "./data-profile": profiles,
      "./storage": storage, "./desktop": desktopStub, "./cloud-merge": merge });
    const { useCloudSync } = loadTs("lib/use-cloud-sync.ts", {
      "@/lib/cloud-merge": merge, "@/lib/cloud-retry": retry, "@/lib/cloud-sync": cloudFunctions,
      "@/lib/password-recovery": recovery,
      "@/lib/account-boundary": boundary, "@/lib/data-profile": profiles,
      "@/lib/supabase-client": { isCloudConfigured: () => true }, "@/lib/storage": storage,
    });
    await storage.initializeWealthStorage();
    const legacyId = `unassigned-${deviceName}`;
    if (!await storage.db.snapshots.get("current")) await storage.db.snapshots.add({ id: "current", data: {
      ...profiles.createBlankWealthData(), transactions: [{ id: legacyId, amount: 777 }],
    }, updatedAt: "synthetic" });
    let controller, local, scope, change;
    function Harness() {
      const active = useSyncExternalStore(profiles.subscribeDataProfile, profiles.getDataProfile);
      useEffect(() => { void boundary.initializeAccountBoundary(); }, []);
      return React.createElement(Workspace, { key: active.epoch, active });
    }
    function Workspace({ active }) {
      const [data, setData] = useState(() => profiles.tagProfileObject(profiles.createBlankWealthData(), active));
      const [loaded, setLoaded] = useState(false);
      scope = active; local = data;
      controller = useCloudSync(data, setData, loaded, active);
      change = (update) => setData((current) => profiles.inheritProfileOwnership(current,
        merge.inheritRemovalIntents(current, update(current)), active));
      useEffect(() => {
        let cancelled = false;
        if (active.kind !== "locked") void storage.loadWealthData(undefined, active).then((saved) => {
          if (cancelled || !profiles.isActiveDataProfile(active)) return;
          if (saved) setData(saved); setLoaded(true);
        });
        return () => { cancelled = true; };
      }, [active]);
      useEffect(() => { if (loaded && profiles.isActiveDataProfile(active)) void storage.saveWealthData(data, active).catch(() => undefined); }, [data, loaded, active]);
      return React.createElement("div", null, controller.status);
    }
    const root = createRoot(document.getElementById("root"));
    await act(async () => { root.render(React.createElement(Harness)); });
    async function until(predicate) {
      for (let i = 0; i < 250; i++) { await act(async () => { await delay(15); }); if (await predicate()) return; }
      throw new Error("Synthetic renderer condition timed out");
    }
    async function action(fn) { let pending; await act(async () => { pending = fn(); await delay(1); }); return { pending }; }
    const fx = { originalAmount: 200, originalCurrency: "SGD", convertedAmount: 696, convertedCurrency: "MYR",
      rateDirection: "SGD/MYR", rate: 3.48, rateDate: "2026-10-01", rateSource: "手动输入", fee: 1, feeCurrency: "SGD", effectiveRate: 696 / 201 };
    function seed() { return { ...profiles.createBlankWealthData(),
      accounts: [
        { id: "sgd", name: "Synthetic SGD", currency: "SGD", type: "bank", balance: 1000 },
        { id: "myr", name: "Synthetic MYR", currency: "MYR", type: "bank", balance: 100 },
        { id: "usd", name: "Synthetic USD", currency: "USD", type: "investment", balance: 500 },
      ],
      transactions: [
        { id: "income-sgd", type: "income", accountId: "sgd", currency: "SGD", amount: 2000, category: "Synthetic", date: "2026-10-01" },
        { id: "expense-myr", type: "expense", accountId: "myr", currency: "MYR", amount: 15, category: "Synthetic", date: "2026-10-01" },
      ],
      transfers: [{ id: "transfer-sgd-myr", fromAccountId: "sgd", toAccountId: "myr", fromAmount: 200, toAmount: 696,
        fromCurrency: "SGD", toCurrency: "MYR", fee: 1, feeCurrency: "SGD", rate: 3.48, date: "2026-10-01", fxSnapshot: fx }],
      fxRates: [{ id: "sgd-myr", baseCurrency: "SGD", quoteCurrency: "MYR", rate: 3.48, effectiveDate: "2026-10-01" },
        { id: "usd-sgd", baseCurrency: "USD", quoteCurrency: "SGD", rate: 1.34, effectiveDate: "2026-10-01" }],
      budgets: [{ id: "budget-myr", month: "2026-10", category: "Synthetic", limit: 100, currency: "MYR" }],
    }; }
    window.syntheticDevice = { async run(command, args) {
      if (command === "login") { const work = await action(() => controller.signIn(args.owner, "synthetic-only")); await work.pending; await until(() => controller.status === "ready" && scope.ownerId === args.owner); }
      else if (command === "logout") { const work = await action(() => controller.signOut()); await work.pending; await until(() => scope.kind === "guest"); }
      else if (command === "network") await act(async () => { state.online = args.online; window.dispatchEvent(new Event(args.online ? "online" : "offline")); });
      else if (command === "focus") window.dispatchEvent(new Event("focus"));
      else if (command === "sync") { const work = await action(() => controller.syncNow()); await work.pending; }
      else if (["seed", "add", "edit", "remove"].includes(command)) {
        await act(async () => { change((current) => {
          if (command === "seed") return seed();
          if (command === "add") { const field = args.field ?? "transactions"; return { ...current, [field]: [...current[field], args.record] }; }
          if (command === "remove") return merge.removeConfirmedRecord(current, args.field, args.id);
          return { ...current, [args.field]: current[args.field].map((item) => {
            if (item.id !== args.id) return item;
            const next = { ...item, ...args.values }; for (const key of args.unset ?? []) delete next[key]; return next;
          }) };
        }); });
        await storage.flushWealthWrites();
      }
      await act(async () => { await delay(5); });
      if (command === "state") {
        const outbox = scope.kind === "cloud" ? await storage.loadCloudOutbox(scope) : null;
        const legacy = await storage.db.snapshots.get("current");
        const saved = scope.kind !== "locked" ? await storage.loadWealthData(undefined, scope) : null;
        return { status: controller.status, error: controller.error, owner: scope.ownerId, data: structuredClone(local),
          persistedMatchesView: saved ? merge.snapshotsEqual(saved, local) : false,
          pending: outbox ? retry.hasPendingSync(outbox) : false, pause: outbox?.paused, lastError: outbox?.lastError,
          legacyPreserved: legacy.data.transactions[0].id === legacyId && legacy.data.transactions[0].amount === 777,
          metrics: { sgd: finance.getAccountBalance(local, "sgd"), myr: finance.getAccountBalance(local, "myr"), usd: finance.getAccountBalance(local, "usd"),
            income: finance.totalIncomeInCurrency(local, "SGD"), expense: finance.totalExpensesInCurrency(local, "MYR"),
            budget: local.budgets.length ? finance.getBudgetRemaining(local, local.budgets[0]) : null,
            usdReport: finance.convert(500, "USD", "MYR", local.fxRates) } };
      }
      return true;
    } };
    await until(() => state.user ? controller.status === "ready" : scope.kind === "guest");
    return true;
  };
}
