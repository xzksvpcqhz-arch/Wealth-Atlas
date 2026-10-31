// Actual SDK + React + IndexedDB, but only synthetic in-memory auth responses.
// This test harness is not included in either candidate or production packages.
const path = require("node:path");

if (process.type === "browser") {
  const { app, BrowserWindow, protocol } = require("electron");
  const { mkdirSync } = require("node:fs");
  const { randomUUID } = require("node:crypto");
  const root = path.resolve(__dirname, "../..");
  const profile = path.join(root, "work", "password-recovery-tests", randomUUID());
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile); app.setPath("sessionData", profile);
  protocol.registerSchemesAsPrivileged([{ scheme: "wa-recovery-test", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  app.whenReady().then(async () => {
    let externalRequests = 0;
    protocol.handle("wa-recovery-test", () => new Response("<html><body><div id='root'></div></body></html>", { headers: { "Content-Type": "text/html" } }));
    const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
    window.webContents.on("console-message", (details) => {
      if (details.message.startsWith("RECOVERY_QA ")) console.log(details.message);
    });
    window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => {
      externalRequests++; callback({ cancel: true });
    });
    await window.loadURL("wa-recovery-test://app/");
    const manualRecovery = process.argv.includes("--manual-recovery");
    let report = await window.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).run(${manualRecovery}, false)`);
    if (manualRecovery) {
      const loaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
      window.webContents.reload(); await loaded;
      report = await window.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).run(true, true)`);
    }
    if (externalRequests) throw new Error("Unexpected external request in isolated recovery test");
    console.log((manualRecovery ? "MANUAL_RECOVERY_PASS " : "PASSWORD_RECOVERY_PASS ") + JSON.stringify({ ...report, realNetworkRequests: externalRequests }));
    window.destroy(); app.exit(0);
  }).catch((error) => { console.error("PASSWORD_RECOVERY_FAIL " + error.message); app.exit(1); });
} else {
  exports.run = async (manualRecovery = false, reloaded = false) => {
    const assert = require("node:assert/strict");
    const { readFileSync } = require("node:fs");
    const ts = require("typescript");
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const { createClient } = require("@supabase/supabase-js");
    const { act, useEffect, useState, useSyncExternalStore } = React;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // This fixture fulfills Auth locally. Its online state must not inherit the
    // operator's physical offline acceptance test on the Windows host.
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
    Object.defineProperty(globalThis, "crypto", { value: require("node:crypto").webcrypto });
    const rootPath = path.resolve(__dirname, "../..");
    const cache = new Map();
    const replacements = {};
    // Only the existing form's behavior is under test; do not load the icon
    // package's bundler-only entry through Electron's CommonJS test loader.
    replacements["@phosphor-icons/react"] = new Proxy({}, { get: () => () => React.createElement("svg", { "aria-hidden": true }) });
    function load(file) {
      if (cache.has(file)) return cache.get(file).exports;
      const mod = { exports: {} }; cache.set(file, mod);
      const source = readFileSync(path.join(rootPath, file), "utf8");
      const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
      } }).outputText;
      new Function("require", "module", "exports", "process", compiled)((name) => {
        if (Object.hasOwn(replacements, name)) return replacements[name];
        if (name === "../desktop/auth-diagnostic-codes.json") return require("../../desktop/auth-diagnostic-codes.json");
        if (name.startsWith("@/")) return load(name.slice(2) + (name.includes("components/") ? ".tsx" : ".ts"));
        if (name.startsWith(".")) return load(path.posix.normalize(path.posix.join(path.posix.dirname(file), name)) + ".ts");
        return require(name);
      }, mod, mod.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-auth.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key" } });
      return mod.exports;
    }
    const user = { id: "00000000-0000-4000-8000-000000000001", email: "synthetic@example.invalid",
      aud: "authenticated", role: "authenticated", created_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {} };
    const now = Math.floor(Date.now() / 1000), encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const accessToken = encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ sub: user.id, aud: "authenticated", exp: now + 3600, iat: now, role: "authenticated",
      ...(manualRecovery ? { session_id: "00000000-0000-4000-8000-000000000002", amr: [{ method: "recovery", timestamp: now - 1 }] } : {}) }) + ".synthetic-signature";
    const session = { access_token: accessToken, refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "bearer", user };
    const state = { password: "synthetic-old-password", puts: 0, failNext: true, putGate: null, financialRequests: 0 };
    const answer = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    let actualClient;
    replacements["@supabase/supabase-js"] = { createClient(url, key, options) {
      actualClient = createClient(url, key, { ...options,
        // Real persistent storage in this new isolated profile: offline proof
        // must read the same SDK cache, never an in-memory stand-in session.
        auth: { ...options.auth, persistSession: true, autoRefreshToken: false },
        global: { fetch: async (input, init = {}) => {
          const address = new URL(typeof input === "string" ? input : input.url), method = init.method ?? "GET";
          assert.equal(address.origin, "https://synthetic-auth.invalid");
          if (address.pathname === "/auth/v1/user" && method === "GET") return answer(user);
          if (address.pathname === "/auth/v1/user" && method === "PUT") {
            state.puts++;
            const body = JSON.parse(init.body);
            // The installed SDK appends null PKCE fields even in implicit flow.
            assert.deepEqual(Object.keys(body).sort(), ["code_challenge", "code_challenge_method", "password"]);
            assert.equal(body.code_challenge, null); assert.equal(body.code_challenge_method, null);
            if (state.putGate) await state.putGate;
            if (state.failNext) { state.failNext = false; return answer({ code: "unexpected_failure", msg: "Synthetic private detail" }, 500); }
            state.password = body.password; return answer(user);
          }
          if (address.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
          if (address.pathname === "/auth/v1/token" && method === "POST") {
            const body = JSON.parse(init.body);
            return body.password === state.password ? answer(session) : answer({ code: "invalid_credentials", msg: "Synthetic rejected" }, 400);
          }
          throw new Error("Unexpected synthetic auth endpoint");
        } },
      });
      return actualClient;
    } };
    replacements["./desktop"] = { getDesktopBridge: () => null, activateDesktopDataProfile: async () => undefined };
    const cloud = load("lib/cloud-sync.ts");
    const recovery = load("lib/password-recovery.ts");
    const profiles = load("lib/data-profile.ts");
    const storage = load("lib/storage.ts");
    const merge = load("lib/cloud-merge.ts");
    const boundary = load("lib/account-boundary.ts");
    let remote = null;
    const cloudForHook = { ...cloud, subscribeToRemote: () => () => {}, getCloudTransport: () => ({
      pull: async () => { state.financialRequests++; return remote; },
      compareAndSet: async (data) => { state.financialRequests++; return (remote = { data: structuredClone(data), updatedAt: "synthetic-revision" }); },
    }) };
    replacements["@/lib/cloud-sync"] = cloudForHook;
    const { useCloudSync } = load("lib/use-cloud-sync.ts");
    const CloudSyncPanel = load("components/CloudSyncPanel.tsx").default;

    // Preserve a pre-existing unassigned snapshot exactly. It must never become
    // the authenticated account's recovery session or financial cloud payload.
    const localScope = profiles.makeDataProfile("local"); profiles.publishDataProfile(localScope);
    const original = reloaded ? await storage.loadWealthData(undefined, localScope)
      : { ...profiles.createBlankWealthData(), transactions: [{ id: "synthetic-unassigned", amount: 17 }] };
    if (!reloaded) await storage.saveWealthData(original, localScope);
    assert.equal(original.transactions[0].id, "synthetic-unassigned");
    if (manualRecovery) load("lib/auto-login.ts").saveAutoLoginPreference(false);
    profiles.publishDataProfile(profiles.makeDataProfile("locked"));
    if (!reloaded) {
      window.history.replaceState(null, "", "/#access_token=" + accessToken + "&refresh_token=synthetic-refresh&expires_in=3600&token_type=bearer&type=recovery");
      assert.equal(cloud.isRecoveryLink(), true);
    } else assert.equal(window.location.hash, "", "Consumed recovery URL must not be replayed");
    let controller, activeScope, mounts = 0;
    function Harness() {
      const profile = useSyncExternalStore(profiles.subscribeDataProfile, profiles.getDataProfile);
      useEffect(() => { void boundary.initializeAccountBoundary(); }, []);
      return React.createElement(Workspace, { key: profile.epoch, profile });
    }
    function Workspace({ profile }) {
      const [data, setData] = useState(() => profiles.tagProfileObject(profiles.createBlankWealthData(), profile));
      const [ready, setReady] = useState(false);
      activeScope = profile; controller = useCloudSync(data, setData, ready, profile);
      useEffect(() => { mounts++; }, []);
      useEffect(() => { let cancelled = false;
        if (profile.kind !== "locked") void storage.loadWealthData(undefined, profile).then((saved) => {
          if (!cancelled && profiles.isActiveDataProfile(profile)) { if (saved) setData(saved); setReady(true); }
        }); return () => { cancelled = true; };
      }, [profile]);
      return React.createElement(CloudSyncPanel, { cloud: controller });
    }
    const root = createRoot(document.getElementById("root"));
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function until(check) {
      for (let attempt = 0; attempt < 200; attempt++) { await act(async () => { await delay(15); }); if (check()) return; }
      throw new Error("Synthetic recovery state did not settle");
    }
    await act(async () => { root.render(React.createElement(Harness)); });
    await until(() => activeScope.kind === (manualRecovery ? "guest" : "cloud") && controller.recovering && recovery.getPasswordRecoveryOwner() === user.id);
    assert.equal(window.location.hash, ""); assert.ok(mounts > 1); assert.equal(cloud.isRecoveryLink(), true);
    assert.equal(document.querySelectorAll('input[type="password"]').length, 2);
    if (manualRecovery) {
      assert.equal(boundary.isAccountVerified(), false); assert.equal(boundary.getAccountUser(), null);
      assert.equal(state.financialRequests, 0);
      assert.equal(merge.canonicalJson(await storage.loadWealthData(undefined, localScope)), merge.canonicalJson(original));
      if (reloaded) {
        state.failNext = false;
        await act(async () => { await boundary.resetAccountPassword("synthetic-new-password"); });
        await until(() => !controller.recovering);
        assert.equal(state.puts, 1); assert.equal(activeScope.kind, "guest"); assert.equal(state.financialRequests, 0);
        assert.equal(merge.canonicalJson(await storage.loadWealthData(undefined, localScope)), merge.canonicalJson(original));
      }
      await act(async () => { await root.unmount(); });
      boundary.disposeAccountBoundary(); await actualClient.auth.stopAutoRefresh(); await storage.flushWealthWrites(); storage.db.close();
      return { manualRecoveryReloadVerified: reloaded, originalFinancialDataUnchanged: true,
        noAccountWorkspaceOpened: true, noFinancialRequests: true, passwordUpdatedOnlyAfterConfirmation: reloaded };
    }
    const financialSnapshot = merge.canonicalJson(await storage.loadWealthData(undefined, activeScope));
    const receipt = await storage.loadVerifiedAuthReceipt(user.id, true);
    assert.ok(receipt && /^[a-f0-9]{64}$/.test(receipt.binding));
    assert.equal(JSON.stringify(receipt).includes(accessToken), false);
    assert.equal(JSON.stringify(receipt).includes("synthetic-refresh"), false);
    assert.equal((await cloud.getOfflineUser())?.id, user.id);
    const authTable = storage.db.table("snapshots"), authId = "auth-verified:v1:" + user.id;
    const authRow = structuredClone(await authTable.get(authId));
    await authTable.put({ ...authRow, receipt: { ...authRow.receipt, binding: "a".repeat(64) } });
    assert.equal(await cloud.getOfflineUser(), null);
    await authTable.put(authRow);
    await storage.saveVerifiedAuthReceipt({ ...receipt, ownerId: "synthetic-no-workspace" });
    assert.equal(await storage.loadVerifiedAuthReceipt("synthetic-no-workspace", true), null);
    assert.equal(await authTable.get("profile:v1:cloud:synthetic-no-workspace"), undefined);
    assert.equal(merge.canonicalJson(await storage.loadWealthData(undefined, activeScope)), financialSnapshot);
    assert.equal(state.financialRequests, 0);
    console.log("RECOVERY_QA recovery-form-ready");

    function input(element, value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await act(async () => { for (const element of document.querySelectorAll('input[type="password"]')) input(element, "synthetic-new-password"); });
    const beforeFailureMounts = mounts;
    await act(async () => { document.querySelector("form.cloud-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await delay(20); });
    await until(() => Boolean(document.querySelector('[role="alert"]')));
    assert.equal(controller.recovering, true); assert.equal(mounts, beforeFailureMounts);
    assert.equal(document.querySelectorAll('input[type="password"]').length, 2);
    assert.doesNotMatch(document.querySelector('[role="alert"]').textContent, /private detail/);
    assert.equal(state.financialRequests, 0);
    assert.equal(merge.canonicalJson(await storage.loadWealthData(undefined, activeScope)), financialSnapshot);
    console.log("RECOVERY_QA failed-save-retained-form puts=" + state.puts);

    let release;
    state.putGate = new Promise((resolve) => { release = resolve; });
    const beforePuts = state.puts;
    let a, b;
    await act(async () => { a = boundary.resetAccountPassword("synthetic-new-password"); b = boundary.resetAccountPassword("synthetic-other-password"); await delay(10); });
    assert.equal(a, b); assert.equal(state.puts, beforePuts + 1); assert.equal(state.financialRequests, 0);
    await act(async () => { release(); await a; });
    console.log("RECOVERY_QA retry-confirmed puts=" + state.puts);
    await until(() => !controller.recovering);
    assert.equal(state.password, "synthetic-new-password");
    assert.equal(merge.canonicalJson(await storage.loadWealthData(undefined, localScope)), merge.canonicalJson(original));
    assert.equal(merge.canonicalJson(await storage.loadWealthData(undefined, activeScope)), financialSnapshot);

    await act(async () => { await controller.signOut(); });
    await until(() => activeScope.kind === "guest");
    await act(async () => { await controller.signIn("synthetic@example.invalid", "synthetic-new-password"); });
    await until(() => activeScope.kind === "cloud" && controller.user?.id === user.id);
    assert.equal(merge.canonicalJson(await storage.loadWealthData(undefined, localScope)), merge.canonicalJson(original));
    await act(async () => { await root.unmount(); });
    boundary.disposeAccountBoundary(); await actualClient.auth.stopAutoRefresh(); storage.db.close();
    return { recoveryRemountVerified: true, failedSaveRetainsForm: true, duplicateClicksCoalesced: true,
      financialDataUnchanged: true, newPasswordLoginVerified: true, hostedAuthVerified: false };
  };
}
