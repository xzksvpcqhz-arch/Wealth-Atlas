/* Isolated React/Electron harness. No real backend, credentials, profile, or UI changes. */
const path = require("node:path");

if (process.type === "browser") {
  const { app, BrowserWindow, protocol } = require("electron");
  protocol.registerSchemesAsPrivileged([{ scheme: "wa-sync-test", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const { mkdirSync } = require("node:fs");
  const { randomUUID } = require("node:crypto");
  const root = path.resolve(__dirname, "../..");
  const profile = path.join(root, "work", "cloud-sync-hook-tests", randomUUID());
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.whenReady().then(async () => {
    protocol.handle("wa-sync-test", () => new Response("<html><body><div id='root'></div></body></html>", { headers: { "Content-Type": "text/html" } }));
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
    await win.loadURL("wa-sync-test://app/");
    const result = await win.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).runRendererTests()`);
    console.log(`CLOUD_SYNC_HOOK_PASS ${JSON.stringify(result)}`);
    win.destroy();
    app.exit(0);
  }).catch((error) => { console.error("CLOUD_SYNC_HOOK_FAIL", error.message); app.exit(1); });
} else {
  exports.runRendererTests = async () => {
    const assert = require("node:assert/strict");
    const { readFileSync } = require("node:fs");
    const ts = require("typescript");
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const { act, useEffect, useState, useSyncExternalStore } = React;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "crypto", { value: require("node:crypto").webcrypto });
    function loadTs(file, replacements = {}) {
      const source = readFileSync(path.resolve(__dirname, "../..", file), "utf8");
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const module = { exports: {} };
      new Function("require", "module", "exports", compiled)((name) => replacements[name]
        ?? (name === "./auto-login" ? loadTs("lib/auto-login.ts") : undefined)
        ?? (name === "./password-recovery" ? loadTs("lib/password-recovery.ts") : undefined)
        ?? (name === "./auth-diagnostics" ? { reportAuthDiagnostic() {} } : require(name)), module, module.exports);
      return module.exports;
    }
    const merge = loadTs("lib/cloud-merge.ts");
    const retryModule = loadTs("lib/cloud-retry.ts");
    const recovery = loadTs("lib/password-recovery.ts");
    const profiles = loadTs("lib/data-profile.ts", { "./migrations": loadTs("lib/migrations.ts") });
    const desktopStub = { getDesktopBridge: () => null, activateDesktopDataProfile: async () => undefined };
    const storage = loadTs("lib/storage.ts", { "./cloud-merge": merge, "./cloud-retry": retryModule, "./desktop": desktopStub, "./data-profile": profiles, "./auth-session": loadTs("lib/auth-session.ts") });
    const initial = { ...profiles.createBlankWealthData(), transactions: [{ id: "synthetic-only", amount: 10 }] };
    const state = {
      remote: structuredClone(initial), persisted: structuredClone(initial), revision: 0,
      user: null, listener: null, writes: 0, storageBlocked: false, localSaveFailed: false, localReadFailed: false,
      pullGate: null, configured: true, metadata: new Map(), authListener: null, loginGate: null, authFailure: false, authLocked: false,
      online: true, networkFailure: false, dropAcknowledgement: false, pulls: 0,
    };
    Object.defineProperty(window, "localStorage", { value: {
      getItem(key) { if (state.storageBlocked) throw new Error("Synthetic storage blocked"); return state.metadata.get(key) ?? null; },
      setItem(key, value) { if (state.storageBlocked) throw new Error("Synthetic storage blocked"); state.metadata.set(key, value); },
      removeItem(key) { state.metadata.delete(key); },
    } });
    Object.defineProperty(navigator, "onLine", { get: () => state.online, configurable: true });
    const nativeTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, delay === 1200 ? 15 : delay, ...args);
    const other = { remote: { ...profiles.createBlankWealthData(), transactions: [{ id: "synthetic-only", amount: 900 }] }, revision: 0, writes: 0, listener: null };
    function transportFor(row) { return {
      async pull() {
        state.pulls++;
        if (state.networkFailure) throw new retryModule.CloudTransportError("network");
        const result = { data: structuredClone(row.remote), updatedAt: String(row.revision) };
        if (state.pullGate) await state.pullGate;
        return result;
      },
      async compareAndSet(data, expected) {
        if (String(row.revision) !== expected.updatedAt) return null;
        row.remote = structuredClone(data); row.revision++; row.writes++;
        if (state.dropAcknowledgement) { state.dropAcknowledgement = false; throw new retryModule.CloudTransportError("network"); }
        return { data: structuredClone(data), updatedAt: String(row.revision) };
      },
    }; }
    const rowFor = (id) => id === "other-user" ? other : state;
    const cloudFunctions = {
      isRetryableAuthError: () => false,
      getOfflineUser: async () => null,
      isRecoveryLink: () => false,
      getCloudTransport: (id) => {
        const scope = profiles.getDataProfile();
        assert.equal(scope.ownerId, id);
        const transport = transportFor(rowFor(id));
        return { pull() { profiles.assertActiveDataProfile(scope); return transport.pull(); }, compareAndSet(...args) { profiles.assertActiveDataProfile(scope); return transport.compareAndSet(...args); } };
      },
      getCurrentUser: async () => {
        assert.equal(state.authLocked, false, "Never call back into auth during its notification lock");
        return state.user;
      },
      signIn: async (email) => {
        if (state.loginGate) await state.loginGate;
        if (state.authFailure) throw new Error("Synthetic private auth failure");
        state.user = { id: email === "other" ? "other-user" : "synthetic-user", email: "test@example.invalid" };
        state.authListener?.(state.user);
        return state.user;
      },
      signUp: async () => (state.user = { id: "synthetic-user", email: "test@example.invalid" }),
      signOut: async () => { state.user = null; state.authListener?.(null); },
      completePasswordReset: async () => { if (state.authFailure) throw new Error("Synthetic password failure"); },
      subscribeToAuth: (listener) => { state.authListener = listener; return () => { state.authListener = null; }; },
      subscribeToRemote: (id, listener) => { const row = rowFor(id); row.listener = listener; return () => { if (row.listener === listener) row.listener = null; }; },
    };
    const boundary = loadTs("lib/account-boundary.ts", {
      "./login-history": loadTs("lib/login-history.ts"),
      "./cloud-sync": cloudFunctions, "./supabase-client": { isCloudConfigured: () => state.configured },
      "./data-profile": profiles, "./storage": storage, "./desktop": desktopStub, "./cloud-merge": merge,
    });
    const { useCloudSync } = loadTs("lib/use-cloud-sync.ts", {
      "@/lib/cloud-merge": merge,
      "@/lib/cloud-retry": retryModule,
      "@/lib/cloud-sync": cloudFunctions,
      "@/lib/password-recovery": recovery,
      "@/lib/account-boundary": boundary,
      "@/lib/data-profile": profiles,
      "@/lib/supabase-client": { isCloudConfigured: () => state.configured },
      "@/lib/storage": { ...storage, loadWealthData: async (...args) => {
        if (state.localReadFailed) throw new Error("Synthetic IndexedDB read failure");
        return storage.loadWealthData(...args);
      } },
    });
    let controller, setLocal, local, activeScope, setDraft, draft, mounts = 0;
    function Harness() {
      const scope = useSyncExternalStore(profiles.subscribeDataProfile, profiles.getDataProfile);
      useEffect(() => { void boundary.initializeAccountBoundary(); }, []);
      return React.createElement(Workspace, { key: scope.epoch, scope });
    }
    function Workspace({ scope }) {
      const [data, setRawData] = useState(() => profiles.tagProfileObject(profiles.createBlankWealthData(), scope));
      const [loaded, setLoaded] = useState(false);
      const [privateDraft, setPrivateDraft] = useState("");
      useEffect(() => { mounts++; }, []);
      draft = privateDraft; setDraft = setPrivateDraft; activeScope = scope;
      controller = useCloudSync(data, setRawData, loaded, scope);
      local = data;
      setLocal = (action) => {
        if (!profiles.isActiveDataProfile(scope)) return;
        setRawData((current) => profiles.inheritProfileOwnership(current, merge.inheritRemovalIntents(current, typeof action === "function" ? action(current) : action), scope));
      };
      useEffect(() => {
        let cancelled = false;
        if (scope.kind !== "locked") void storage.loadWealthData(undefined, scope).then((saved) => {
          if (cancelled || !profiles.isActiveDataProfile(scope)) return;
          if (saved) setRawData(saved);
          setLoaded(true);
        });
        return () => { cancelled = true; };
      }, [scope]);
      useEffect(() => { if (loaded && profiles.isActiveDataProfile(scope) && !state.localSaveFailed) {
        state.persisted = structuredClone(data);
        void storage.saveWealthData(data, scope).catch((error) => { state.localWriteError = error.cause?.message ?? error.message; });
      } }, [data, loaded, scope]);
      return React.createElement("div", null, controller.status);
    }
    const root = createRoot(document.getElementById("root"));
    const delay = (ms) => new Promise((resolve) => nativeTimeout(resolve, ms));
    async function tick() { await act(async () => { await delay(20); }); }
    async function until(check) {
      for (let i = 0; i < 150; i++) { await tick(); if (await check()) return; }
      assert.fail(`Synthetic controller timed out after check ${checks}; status=${controller?.status}; profile=${activeScope?.kind}; write=${state.localWriteError ?? "none"}`);
    }
    async function begin(action) {
      let pending;
      await act(async () => { pending = action(); await delay(1); });
      return { pending };
    }
    let checks = 0;
    // Preserve unassigned pre-upgrade data verbatim; never seed a signed-in account from it.
    const legacyScope = profiles.makeDataProfile("local"); profiles.publishDataProfile(legacyScope);
    const legacy = { ...profiles.createBlankWealthData(), transactions: [{ id: "unassigned-test", amount: 777 }] };
    await storage.saveWealthData(legacy, legacyScope);
    profiles.publishDataProfile(profiles.makeDataProfile("locked"));
    await act(async () => { root.render(React.createElement(Harness)); });
    await until(() => activeScope.kind === "guest" && controller.status === "signed-out");
    assert.equal(controller.status, "signed-out"); checks++;
    const login = await begin(() => controller.signIn("synthetic", "synthetic"));
    await until(() => controller.status === "ready"); await login.pending;
    assert.ok(await storage.loadCloudBaseline(activeScope));
    assert.equal(local.transactions[0].id, "synthetic-only");
    assert.equal(merge.canonicalJson(await storage.loadWealthData(undefined, legacyScope)), merge.canonicalJson(legacy)); checks++;

    await act(async () => { setLocal((current) => ({ ...current, transactions: [{ ...current.transactions[0], amount: 11 }] })); });
    await until(() => state.remote.transactions[0].amount === 11 && controller.status === "ready");
    assert.equal(local.transactions[0].amount, 11); checks++;

    // Local edit and another device's different edit: no silent winner.
    await act(async () => {
      setLocal((current) => ({ ...current, transactions: [{ ...current.transactions[0], amount: 12 }] }));
      state.remote.transactions[0].amount = 13; state.revision++;
    });
    const conflicting = await begin(() => controller.syncNow());
    await until(() => controller.status === "error"); await conflicting.pending;
    assert.equal(local.transactions[0].amount, 12);
    assert.equal(state.remote.transactions[0].amount, 13);
    assert.match(controller.error, /不同修改|资料冲突/); checks++;

    // Same-value convergence can resume; no new conflict-resolution UI is invented.
    await act(async () => { setLocal((current) => ({ ...current, transactions: [{ ...current.transactions[0], amount: 13 }] })); });
    const matching = await begin(() => controller.syncNow());
    await until(() => controller.status === "ready"); await matching.pending; checks++;

    // A stale realtime payload is ignored; actual current cloud contents are pulled.
    await act(async () => {
      state.remote.transactions[0].amount = 14; state.revision++;
      state.listener({ transactions: [{ id: "synthetic-only", amount: 1 }] });
    });
    await until(() => controller.status === "ready" && local.transactions[0].amount === 14);
    assert.equal(state.persisted.transactions[0].amount, 14); checks++;

    // No baseline may advance ahead of a failed local persistence operation.
    const savedMetadata = merge.canonicalJson(await storage.loadCloudBaseline(activeScope));
    state.localSaveFailed = true;
    await act(async () => { state.remote.transactions[0].amount = 15; state.revision++; state.listener(); });
    await until(() => controller.status === "error");
    assert.match(controller.error, /本地保存尚未确认/);
    assert.equal(merge.canonicalJson(await storage.loadCloudBaseline(activeScope)), savedMetadata);
    state.localSaveFailed = false;
    state.persisted = structuredClone(local);
    await storage.saveWealthData(local);
    const retry = await begin(() => controller.syncNow());
    await until(() => controller.status === "ready"); await retry.pending; checks++;

    state.localReadFailed = true;
    const readFailure = await begin(() => controller.syncNow());
    await until(() => controller.status === "error"); await readFailure.pending;
    assert.match(controller.error, /本地保存尚未确认/);
    assert.doesNotMatch(controller.error, /Synthetic/);
    state.localReadFailed = false; checks++;

    // Pending requests from a signed-out session cannot apply stale data.
    let releasePull;
    state.pullGate = new Promise((resolve) => { releasePull = resolve; });
    const pendingSync = await begin(() => controller.syncNow());
    const beforeSignOut = structuredClone(local), writesBeforeSignOut = state.writes, previousScope = activeScope;
    await act(async () => { await controller.signOut(); });
    await until(() => activeScope.kind === "guest");
    state.pullGate = null;
    await act(async () => { releasePull(); await pendingSync.pending; });
    assert.equal(controller.user, null);
    assert.equal(controller.status, "signed-out");
    assert.equal(local.transactions.length, 0);
    assert.deepEqual(await storage.loadWealthData(undefined, previousScope), beforeSignOut);
    assert.equal(state.writes, writesBeforeSignOut); checks++;

    // localStorage unavailable still permits in-memory conflict protection.
    state.storageBlocked = true;
    const blockedLogin = await begin(() => controller.signIn("synthetic", "synthetic"));
    await until(() => activeScope.kind === "cloud" && ["ready", "error"].includes(controller.status));
    // A previously failed local read remains paused across login, unless explicitly retried.
    if (controller.status === "error") await act(async () => { await controller.syncNow(); });
    await until(() => controller.status === "ready"); await blockedLogin.pending;
    await act(async () => { setLocal((current) => ({ ...current, transactions: [{ ...current.transactions[0], amount: 16 }] })); });
    await until(() => controller.status === "ready" && state.remote.transactions[0].amount === 16);
    assert.equal(local.transactions[0].amount, 16); checks++;

    state.storageBlocked = false;
    // Soft delete / restore use the existing fields and remain ordinary sync edits.
    await act(async () => { setLocal((current) => ({ ...current, transactions: [{ ...current.transactions[0], deleted: true, deletedAt: "2026-10-25T00:00:00Z" }] })); });
    await until(() => controller.status === "ready" && state.remote.transactions[0].deleted === true);
    await act(async () => { setLocal((current) => ({ ...current, transactions: [{ ...current.transactions[0], deleted: false, deletedAt: undefined }] })); });
    await until(() => controller.status === "ready" && state.remote.transactions[0].deleted === false); checks++;

    // Confirmed permanent deletion persists a separate journal atomically with current.
    await act(async () => { setLocal((current) => merge.removeConfirmedRecord(current, "transactions", "synthetic-only")); });
    await until(() => controller.status === "ready" && state.remote.transactions.length === 0);
    const permanent = await storage.loadCloudDeletions("synthetic-user");
    assert.equal(Object.keys(permanent.tombstones.transactions).length, 1);
    assert.equal((await storage.loadWealthData()).transactions.length, 0);
    assert.equal(Object.hasOwn(await storage.loadWealthData(), "__wealthAtlasSync"), false); checks++;

    // A stale, old-style writer cannot erase the local journal or resurrect this record.
    state.remote = structuredClone(initial); state.remote.transactions[0].amount = 16;
    state.remote.transactions[0].deleted = false; state.revision++;
    await act(async () => { state.listener(); });
    await until(() => controller.status === "ready" && state.remote.transactions.length === 0);
    assert.equal(local.transactions.length, 0); checks++;

    // Sign-out/sign-in reloads the journal from real IndexedDB, not hook memory.
    await act(async () => { await controller.signOut(); });
    storage.db.close();
    await storage.initializeWealthStorage();
    assert.equal(Object.keys((await storage.loadCloudDeletions("synthetic-user", previousScope)).tombstones.transactions).length, 1);
    const afterReload = await begin(() => controller.signIn("synthetic", "synthetic"));
    await until(() => controller.status === "ready"); await afterReload.pending;
    assert.equal(local.transactions.length, 0); checks++;

    // A failed transaction must preserve both the snapshot and the existing journal.
    const beforeRollback = await storage.loadWealthData();
    const priorJournal = await storage.loadCloudDeletions("synthetic-user");
    await Promise.all([
      storage.saveWealthData({ ...beforeRollback, reportCurrency: "SGD" }),
      storage.saveWealthData({ ...beforeRollback, reportCurrency: "USD" }),
    ]);
    assert.equal((await storage.loadWealthData()).reportCurrency, "USD");
    await storage.saveWealthData(beforeRollback); checks++;
    const damagedKey = profiles.profileMetadataKey(activeScope, "deletions:synthetic-user");
    const table = storage.db.table("snapshots");
    const priorRow = await table.get(damagedKey);
    await table.put({ ...priorRow, deletions: { version: 99 } });
    await assert.rejects(storage.loadCloudDeletions("synthetic-user"), /删除同步标记/);
    const testBudget = { ...beforeRollback, budgets: [{ id: "synthetic-budget", limit: 10 }] };
    await storage.saveWealthData(testBudget);
    await assert.rejects(storage.saveWealthData(merge.removeConfirmedRecord(testBudget, "budgets", "synthetic-budget")));
    assert.equal((await storage.loadWealthData()).budgets.length, 1);
    await table.put(priorRow);
    await storage.resumeCloudSync(activeScope); // Explicit test repair, not automatic conflict resolution.
    assert.equal(merge.canonicalJson(await storage.loadCloudDeletions("synthetic-user")), merge.canonicalJson(priorJournal)); checks++;

    // Metadata rows are account-scoped; unassigned deletes never join a new account silently.
    await assert.rejects(storage.loadCloudDeletions("different-synthetic-user"), /其他账号/);
    const releaseUnassigned = merge.registerDeletionOwner("temporary-owner"); releaseUnassigned();
    const savedScopeA = activeScope, savedDataA = await storage.loadWealthData();
    const unownedRemoval = merge.removeConfirmedRecord(testBudget, "budgets", "synthetic-budget");
    await assert.rejects(storage.saveWealthData(unownedRemoval)); checks++;

    // Every private draft, closure, baseline and same-ID record belongs to one workspace.
    await act(async () => { setDraft("private-test-draft"); });
    const staleSetter = setLocal, countBeforeSwitch = mounts;
    const queuedSnapshotA = profiles.tagProfileObject({ ...savedDataA, reportCurrency: "SGD" }, activeScope);
    const queuedWriteA = storage.saveWealthData(queuedSnapshotA);
    const bLogin = await begin(() => controller.signIn("other", "synthetic"));
    await until(() => controller.status === "ready" && activeScope.ownerId === "other-user"); await bLogin.pending;
    await queuedWriteA;
    assert.equal(local.transactions[0].amount, 900);
    assert.equal(draft, ""); assert.ok(mounts > countBeforeSwitch);
    assert.equal(other.writes, 0); // A's records were never uploaded to B.
    await act(async () => { staleSetter({ ...savedDataA, reportCurrency: "USD" }); });
    assert.equal(local.reportCurrency, "MYR");
    await assert.rejects(storage.saveWealthData(savedDataA, activeScope), /不属于/);
    assert.deepEqual(await storage.loadCloudDeletions("other-user"), merge.emptyDeletionMetadata()); checks++;

    // Vault handles are namespaced without reading any actual filesystem folder.
    const scopeB = activeScope;
    await storage.saveObsidianHandle({ syntheticHandle: "B" }, "synthetic-B");
    const aLogin = await begin(() => controller.signIn("synthetic", "synthetic"));
    await until(() => controller.status === "ready" && activeScope.ownerId === "synthetic-user"); await aLogin.pending;
    assert.equal(local.transactions.length, 0);
    assert.equal(await storage.loadObsidianHandle(), null);
    await storage.saveObsidianHandle({ syntheticHandle: "A" }, "synthetic-A");
    const taggedHandleA = (await storage.loadObsidianHandle()).handle;
    const aScope = activeScope;
    const bAgain = await begin(() => controller.signIn("other", "synthetic"));
    await until(() => controller.status === "ready" && activeScope.ownerId === "other-user"); await bAgain.pending;
    assert.equal((await storage.loadObsidianHandle()).vaultName, "synthetic-B");
    await assert.rejects(storage.saveObsidianHandle(taggedHandleA, "synthetic-A"), /旧账号/);
    await storage.clearObsidianHandle();
    assert.equal(await storage.loadObsidianHandle(), null);
    assert.equal((await storage.db.obsidianHandles.get(profiles.snapshotKey(aScope))).vaultName, "synthetic-A"); checks++;

    // Async writes already queued for A may finish only in A's immutable namespace.
    await assert.rejects(storage.saveWealthData(savedDataA, savedScopeA), /工作区已经切换/);
    assert.equal((await storage.loadWealthData(undefined, savedScopeA)).reportCurrency, "SGD");
    assert.equal((await storage.loadWealthData(undefined, scopeB)).reportCurrency, "MYR");
    assert.deepEqual(await storage.loadWealthData(undefined, legacyScope), legacy); checks++;

    // Refresh events for the same user must not throw away an unsaved draft.
    await act(async () => { setDraft("still-editing"); state.authListener(state.user); });
    assert.equal(draft, "still-editing"); checks++;

    // Sign-out callback from another auth surface fences private state immediately.
    await act(async () => { state.user = null; state.authListener(null); });
    await until(() => activeScope.kind === "guest" && controller.status === "signed-out");
    assert.equal(local.transactions.length, 0); assert.equal(draft, ""); checks++;

    // External sign-in verifies only after the SDK callback's lock is released.
    await act(async () => {
      state.user = { id: "other-user", email: "test@example.invalid" };
      state.authLocked = true; state.authListener(state.user);
      queueMicrotask(() => { state.authLocked = false; });
    });
    await until(() => controller.status === "ready" && activeScope.ownerId === "other-user");
    assert.equal(local.transactions[0].amount, 900); checks++;

    // A failed login never re-exposes the last successful user's records or provider messages.
    state.authFailure = true;
    const failed = await begin(() => controller.signIn("synthetic", "wrong")); await failed.pending;
    await until(() => controller.status === "error");
    assert.equal(local.transactions.length, 0);
    assert.doesNotMatch(controller.error, /Synthetic/);
    await assert.rejects(controller.completePasswordReset("synthetic"));
    state.authFailure = false; checks++;

    // A pull that returns only after switching to B cannot replace B's view/cache.
    const loginBeforeRace = await begin(() => controller.signIn("synthetic", "synthetic"));
    await until(() => activeScope.ownerId === "synthetic-user"); await loginBeforeRace.pending;
    let releaseOldPull;
    state.pullGate = new Promise((resolve) => { releaseOldPull = resolve; });
    const oldPull = await begin(() => controller.syncNow());
    const lateB = await begin(() => controller.signIn("other", "synthetic"));
    await until(() => activeScope.ownerId === "other-user");
    state.pullGate = null;
    await act(async () => { releaseOldPull(); await oldPull.pending; await lateB.pending; });
    await until(() => controller.status === "ready");
    assert.equal(local.transactions[0].amount, 900);
    assert.equal((await storage.loadWealthData()).transactions[0].amount, 900); checks++;

    // Rapid A -> B login attempts are serialized; the latest requested identity wins.
    let releaseLogin;
    state.loginGate = new Promise((resolve) => { releaseLogin = resolve; });
    const firstLogin = await begin(() => controller.signIn("synthetic", "synthetic"));
    const finalLogin = await begin(() => controller.signIn("other", "synthetic"));
    state.loginGate = null;
    await act(async () => { releaseLogin(); await firstLogin.pending; await finalLogin.pending; });
    await until(() => controller.status === "ready" && activeScope.ownerId === "other-user");
    assert.equal(local.transactions[0].amount, 900); checks++;

    // Profile data, journals and unassigned legacy rows survive DB close/reopen.
    storage.db.close(); await storage.initializeWealthStorage();
    assert.equal((await storage.loadWealthData(undefined, scopeB)).transactions[0].amount, 900);
    assert.equal((await storage.loadWealthData(undefined, savedScopeA)).reportCurrency, "SGD");
    assert.deepEqual(await storage.loadWealthData(undefined, legacyScope), legacy); checks++;

    // Custom media can contain private pictures, so it follows the same boundary.
    const backgrounds = loadTs("lib/backgrounds.ts", { "./data-profile": profiles });
    const items = await backgrounds.addBackground("synthetic-B-image", "data:image/png;base64,c3ludGhldGlj");
    backgrounds.setActiveId(items[0].id);
    assert.ok(await backgrounds.getActiveBackgroundData());
    await act(async () => { await controller.signOut(); });
    await until(() => activeScope.kind === "guest");
    assert.equal(await backgrounds.getActiveBackgroundData(), null);
    assert.equal((await backgrounds.loadBackgrounds()).length, 0);
    const mediaLogin = await begin(() => controller.signIn("other", "synthetic"));
    await until(() => controller.status === "ready" && activeScope.ownerId === "other-user"); await mediaLogin.pending;
    assert.equal((await backgrounds.loadBackgrounds()).length, 1); checks++;

    // Real IndexedDB: offline writes and their coalesced pending revision are one commit.
    const offlineScopeB = activeScope, remoteBeforeOffline = structuredClone(other.remote);
    const pullsBeforeOffline = state.pulls;
    await act(async () => {
      state.online = false; window.dispatchEvent(new Event("offline"));
      setLocal((current) => ({ ...current, transactions: [...current.transactions, { id: "offline-only-B", amount: 1 }] }));
      setLocal((current) => ({ ...current, transactions: current.transactions.map((item) => item.id === "offline-only-B" ? { ...item, amount: 2 } : item) }));
    });
    await until(async () => (await storage.loadWealthData()).transactions.some((item) => item.id === "offline-only-B" && item.amount === 2));
    await act(async () => { await controller.syncNow(); });
    assert.equal(state.pulls, pullsBeforeOffline);
    assert.deepEqual(other.remote, remoteBeforeOffline);
    const offlineJob = await storage.loadCloudOutbox(activeScope);
    assert.equal(retryModule.hasPendingSync(offlineJob), true);
    assert.doesNotMatch(JSON.stringify(offlineJob), /offline-only-B|amount|transactions|accounts|snapshot/); checks++;

    // Close/reopen the database and authenticate again: the durable job, not hook memory, resumes.
    await act(async () => { await controller.signOut(); });
    storage.db.close(); await storage.initializeWealthStorage();
    const queueKeyB = profiles.profileMetadataKey(offlineScopeB, "outbox");
    assert.equal(retryModule.hasPendingSync((await table.get(queueKeyB)).outbox), true);
    state.online = true;
    const offlineReload = await begin(() => controller.signIn("other", "synthetic"));
    await until(() => controller.status === "ready" && activeScope.ownerId === "other-user"); await offlineReload.pending;
    assert.equal(other.remote.transactions.filter((item) => item.id === "offline-only-B").length, 1);
    assert.equal(other.remote.transactions.find((item) => item.id === "offline-only-B").amount, 2);
    assert.equal(retryModule.hasPendingSync(await storage.loadCloudOutbox(activeScope)), false); checks++;

    // Network failure while navigator reports online persists its deadline and attempt count.
    state.networkFailure = true;
    await act(async () => { setLocal((current) => ({ ...current, transactions: current.transactions.map((item) => item.id === "offline-only-B" ? { ...item, amount: 3 } : item) })); });
    await until(async () => controller.status === "error" && (await storage.loadCloudOutbox(activeScope)).attempts > 0);
    const failedNetworkJob = await storage.loadCloudOutbox(activeScope);
    assert.equal(failedNetworkJob.lastError, "network"); assert.ok(failedNetworkJob.nextAttemptAt > Date.now());
    assert.equal((await storage.loadWealthData()).transactions.find((item) => item.id === "offline-only-B").amount, 3);
    await act(async () => { state.online = false; window.dispatchEvent(new Event("offline")); });
    await tick(); state.networkFailure = false;
    await act(async () => { state.online = true; window.dispatchEvent(new Event("online")); });
    await until(() => controller.status === "ready" && other.remote.transactions.find((item) => item.id === "offline-only-B").amount === 3);
    assert.equal((await storage.loadCloudOutbox(activeScope)).attempts, 0); checks++;

    // Upload accepted / ACK lost: re-pull recognizes it; no duplicate transaction or second write.
    const writesBeforeLostAck = other.writes;
    state.dropAcknowledgement = true;
    await act(async () => { setLocal((current) => ({ ...current, transactions: current.transactions.map((item) => item.id === "offline-only-B" ? { ...item, amount: 4 } : item) })); });
    await until(() => controller.status === "error" && other.remote.transactions.find((item) => item.id === "offline-only-B").amount === 4);
    assert.equal(retryModule.hasPendingSync(await storage.loadCloudOutbox(activeScope)), true);
    await act(async () => { state.online = false; window.dispatchEvent(new Event("offline")); }); await tick();
    await act(async () => { state.online = true; window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); other.listener(); });
    await until(() => controller.status === "ready");
    assert.equal(other.writes, writesBeforeLostAck + 1);
    assert.equal(other.remote.transactions.filter((item) => item.id === "offline-only-B").length, 1); checks++;

    // An old common-ancestor ACK cannot clear a newer local pending revision.
    const oldAcknowledged = await merge.fingerprintSnapshot(local);
    await act(async () => {
      state.online = false; window.dispatchEvent(new Event("offline"));
      setLocal((current) => ({ ...current, transactions: current.transactions.map((item) => item.id === "offline-only-B" ? { ...item, amount: 5 } : item) }));
    });
    await until(async () => (await storage.loadWealthData()).transactions.find((item) => item.id === "offline-only-B").amount === 5);
    const beforeOldAck = await storage.loadCloudOutbox(activeScope);
    await storage.saveCloudBaseline(activeScope, oldAcknowledged);
    const afterOldAck = await storage.loadCloudOutbox(activeScope);
    assert.equal(afterOldAck.revision, beforeOldAck.revision);
    assert.equal(retryModule.hasPendingSync(afterOldAck), true); checks++;

    // Pending B work stays in B while a different verified account is active.
    await act(async () => { await controller.signOut(); });
    state.online = true;
    const otherAccount = await begin(() => controller.signIn("synthetic", "synthetic"));
    await until(() => controller.status === "ready" && activeScope.ownerId === "synthetic-user"); await otherAccount.pending;
    assert.equal(local.transactions.some((item) => item.id === "offline-only-B"), false);
    assert.equal(retryModule.hasPendingSync((await table.get(queueKeyB)).outbox), true);
    const backToB = await begin(() => controller.signIn("other", "synthetic"));
    await until(() => controller.status === "ready" && activeScope.ownerId === "other-user"); await backToB.pending;
    assert.equal(other.remote.transactions.find((item) => item.id === "offline-only-B").amount, 5);
    assert.equal(retryModule.hasPendingSync(await storage.loadCloudOutbox(activeScope)), false); checks++;

    // Invalid queue metadata rolls back the entire next write; it is not reset to empty.
    await act(async () => { state.online = false; window.dispatchEvent(new Event("offline")); }); await tick();
    const goodQueue = await table.get(queueKeyB), beforeCorruptQueue = await storage.loadWealthData();
    await table.put({ ...goodQueue, outbox: { version: 99 } });
    await assert.rejects(storage.saveWealthData({ ...beforeCorruptQueue, reportCurrency: "USD" }));
    assert.deepEqual(await storage.loadWealthData(), beforeCorruptQueue);
    assert.equal((await table.get(queueKeyB)).outbox.version, 99);
    await table.put(goodQueue); // Repair only the deliberately damaged test metadata.
    state.online = true;
    await act(async () => { await controller.syncNow(); });
    await until(() => controller.status === "ready"); checks++;

    // A new permanent-delete intent still needs an ACK if a later local edit
    // restores the identical financial JSON (e.g. an explicitly restored backup).
    const beforeJournalOnly = await storage.loadWealthData();
    assert.ok(beforeJournalOnly.transactions.some((item) => item.id === "offline-only-B"), "Synthetic journal-only test record must exist");
    const beforeJournalOnlyBase = await merge.fingerprintSnapshot(beforeJournalOnly);
    const journalOnlyRevision = (await storage.loadCloudOutbox(activeScope)).revision;
    await act(async () => {
      state.online = false; window.dispatchEvent(new Event("offline"));
      setLocal((current) => merge.removeConfirmedRecord(current, "transactions", "offline-only-B"));
    });
    await storage.flushWealthWrites();
    // A cancelled same-render delete intentionally has no marker; this case is
    // a committed delete followed by a separate, explicit backup restoration.
    await act(async () => { setLocal((current) => ({ ...current, transactions: beforeJournalOnly.transactions })); });
    await storage.flushWealthWrites();
    const journalOnlyJob = await storage.loadCloudOutbox(activeScope);
    assert.ok(journalOnlyJob.revision > journalOnlyRevision, JSON.stringify({ beforeRevision: journalOnlyRevision, afterRevision: journalOnlyJob.revision, acknowledged: journalOnlyJob.acknowledgedRevision, journalFields: Object.keys((await storage.loadCloudDeletions("other-user")).tombstones), remainingIntents: (await merge.prepareRemovalJournals(local)).size }));
    assert.deepEqual(await storage.loadWealthData(), beforeJournalOnly);
    await storage.saveCloudBaseline(activeScope, beforeJournalOnlyBase, merge.emptyDeletionMetadata());
    assert.equal(retryModule.hasPendingSync(await storage.loadCloudOutbox(activeScope)), true);
    assert.ok(Object.keys((await storage.loadCloudDeletions("other-user")).tombstones.transactions).length); checks++;

    // An incomplete owned workspace is not replaced with an empty snapshot.
    const brokenScope = profiles.makeDataProfile("cloud", "broken-test-user");
    const brokenRow = { id: profiles.snapshotKey(brokenScope), data: {}, updatedAt: "synthetic" };
    await table.put(brokenRow);
    await assert.rejects(storage.prepareAccountWorkspace(brokenScope), /不完整/);
    assert.deepEqual(await table.get(brokenRow.id), brokenRow); checks++;

    // Electron's contextBridge freezes exposed properties: never proxy the frozen target.
    const desktopRuntime = loadTs("lib/desktop.ts", { "./data-profile": profiles });
    window.wealthAtlasDesktop = Object.freeze({
      isDesktop: true, startupTestMode: "", activateDataProfile: async () => "synthetic-token",
      getDataLocation: async (scope) => { assert.equal(scope.key, activeScope.key); return "synthetic-location"; },
    });
    activeScope.desktopToken = await desktopRuntime.activateDesktopDataProfile(activeScope);
    const oldBridge = desktopRuntime.getDesktopBridge();
    assert.equal(await oldBridge.getDataLocation(), "synthetic-location");
    delete window.wealthAtlasDesktop;
    await act(async () => { await controller.signOut(); });
    await until(() => activeScope.kind === "guest");
    assert.throws(() => oldBridge.getDataLocation(), /已经切换/); checks++;

    await act(async () => { root.unmount(); });
    boundary.disposeAccountBoundary();
    storage.db.close();
    return { checks, profile: "isolated", realBackendRequests: 0 };
  };
}
