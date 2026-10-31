// Isolated real SDK + production boundary. Only synthetic memory and mocked HTTP.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createWorld, initialize } = require("./auth-startup-review.cjs");

function preferences(storage) {
  const mod = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(path.resolve(__dirname, "../../lib/auto-login.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("module", "exports", "window", compiled)(mod, mod.exports, { localStorage: storage });
  return mod.exports;
}
const delay = () => new Promise(resolve => setTimeout(resolve, 20));

async function runAutoLoginReview() {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Native network forbidden in auto-login review"); };
  let checks = 0;
  try {
    const values = new Map([["unrelated", "preserved"]]);
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const pref = preferences(storage), key = pref.AUTO_LOGIN_KEY;
    assert.deepEqual(pref.readAutoLoginPreference(), { enabled: true, error: null }); checks++;
    let notifications = 0;
    const unsubscribe = pref.subscribeAutoLoginPreference(() => notifications++);
    for (const enabled of [false, true]) {
      assert.deepEqual(pref.saveAutoLoginPreference(enabled), { enabled, error: null });
      assert.deepEqual(JSON.parse(values.get(key)), { version: 1, enabled });
      assert.equal(values.size, 2); assert.equal(values.get("unrelated"), "preserved");
    }
    assert.equal(notifications, 2); unsubscribe(); checks++;
    for (const raw of ["{broken", "null", "[]", '{"version":2,"enabled":true}', '{"version":1,"enabled":"true"}',
      '{"version":1,"enabled":true,"password":"synthetic"}', "x".repeat(129)]) {
      values.set(key, raw);
      assert.equal(pref.readAutoLoginPreference().enabled, false); assert.ok(pref.readAutoLoginPreference().error);
      assert.equal(values.get(key), raw);
    }
    checks++;
    for (const mode of ["read", "write", "readback", "drop"]) {
      values.set(key, JSON.stringify({ version: 1, enabled: true })); let wrote = false;
      const failed = { getItem(name) { if (mode === "read" || mode === "readback" && wrote) throw new Error("SYNTHETIC_PRIVATE_DETAIL"); return storage.getItem(name); },
        setItem(name, value) { if (mode === "write") throw new Error("SYNTHETIC_PRIVATE_DETAIL"); wrote = true; if (mode !== "drop") storage.setItem(name, value); } };
      const result = pref.saveAutoLoginPreference(false, failed);
      assert.ok(result.error); assert.equal(JSON.stringify(result).includes("SYNTHETIC_PRIVATE_DETAIL"), false);
      if (mode === "write" || mode === "drop") assert.equal(result.enabled, true);
    }
    checks++;

    // Establish the exact session/receipt/workspace via the actual installed SDK.
    const auth = new Map(), workspaces = new Map();
    const original = { synthetic: "unchanged", records: ["synthetic-only"] };
    const seed = createWorld(auth, workspaces);
    const ownerKey = "cloud:" + seed.user.id;
    workspaces.set(ownerKey, structuredClone(original));
    assert.equal((await seed.clientModule.getSupabaseClient().auth.setSession({ access_token: seed.token, refresh_token: "synthetic-refresh" })).error, null);
    await initialize(seed); assert.equal(seed.boundary.isAccountVerified(), true); await seed.close();
    const cloneWorkspaces = () => new Map([...workspaces].map(([name, value]) => [name, structuredClone(value)]));

    for (const online of [true, false]) for (const expired of [true, false]) {
      const cache = new Map(auth), privateData = cloneWorkspaces();
      if (expired) {
        const stored = JSON.parse(cache.get("synthetic-review-session"));
        const parts = stored.access_token.split(".");
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        parts[1] = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 })).toString("base64url");
        stored.access_token = parts.join("."); stored.expires_at = Math.floor(Date.now() / 1000) - 60;
        cache.set("synthetic-review-session", JSON.stringify(stored));
      }
      cache.set(key, JSON.stringify({ version: 1, enabled: false }));
      const before = JSON.stringify([...cache]);
      const w = createWorld(cache, privateData); w.state.navigatorOnline = online; w.state.online = online;
      try {
        await initialize(w);
        assert.equal(w.profiles.getDataProfile().kind, "guest"); assert.equal(w.boundary.getAccountUser(), null);
        assert.equal(w.client(), undefined); assert.equal(w.state.authReads, 0);
        w.window.dispatchEvent(new Event("online")); w.window.dispatchEvent(new Event("focus"));
        await w.boundary.retryAccountVerification(); await delay();
        assert.equal(w.client(), undefined); assert.equal(w.profiles.getDataProfile().kind, "guest");
        // Turning the preference back on is not an explicit login in this launch.
        cache.set(key, JSON.stringify({ version: 1, enabled: true }));
        await w.boundary.retryAccountVerification(); await w.boundary.initializeAccountBoundary();
        assert.equal(w.client(), undefined); assert.equal(w.boundary.getAccountUser(), null);
        cache.set(key, JSON.stringify({ version: 1, enabled: false }));
        assert.equal(JSON.stringify([...cache]), before); assert.deepEqual(privateData.get(ownerKey), original);
      } finally { await w.close(); }
      checks++;
    }
    for (const raw of ["{broken", '{"version":1,"enabled":"true"}']) {
      const cache = new Map(auth); cache.set(key, raw);
      const w = createWorld(cache, cloneWorkspaces());
      try { await initialize(w); assert.equal(w.client(), undefined); assert.equal(w.profiles.getDataProfile().kind, "guest"); assert.equal(cache.get(key), raw); }
      finally { await w.close(); }
      checks++;
    }
    {
      const retained = new Map(auth), signedOutData = cloneWorkspaces(); signedOutData.set("explicit-signout", true);
      const signedOut = createWorld(retained, signedOutData);
      try {
        await initialize(signedOut); await signedOut.boundary.retryAccountVerification();
        assert.equal(signedOut.client(), undefined, "An explicit sign-out marker forbids automatic SDK restore even with retained cache");
        assert.equal(signedOut.profiles.getDataProfile().kind, "guest"); assert.deepEqual(signedOutData.get(ownerKey), original); checks++;
      } finally { await signedOut.close(); }
    }
    {
      const retained = new Map(auth), pendingMarker = cloneWorkspaces();
      let release;
      pendingMarker.set("explicit-signout", true);
      const deferred = new Promise(resolve => { release = resolve; }); let awaiting = false;
      const queued = createWorld(retained, pendingMarker);
      // Defer the production storage export in the same isolated module graph.
      const originalReader = queued.storage.wasExplicitlySignedOut;
      queued.storage.wasExplicitlySignedOut = async () => { awaiting = true; return await deferred; };
      try {
        const startup = queued.boundary.initializeAccountBoundary();
        while (!awaiting) await delay();
        queued.window.dispatchEvent(new Event("online"));
        release(true); await startup; await delay();
        assert.equal(queued.client(), undefined); assert.equal(queued.profiles.getDataProfile().kind, "guest");
        assert.equal(pendingMarker.get("explicit-signout"), true); assert.deepEqual(pendingMarker.get(ownerKey), original); checks++;
      } finally { queued.storage.wasExplicitlySignedOut = originalReader; await queued.close(); }
    }
    {
      const retained = new Map(auth), signedOutData = cloneWorkspaces(); signedOutData.set("explicit-signout", true);
      const unavailable = createWorld(retained, signedOutData); let markerReads = 0;
      unavailable.storage.wasExplicitlySignedOut = async () => {
        if (++markerReads === 1) throw new Error("SYNTHETIC_PRIVATE_DETAIL");
        return true;
      };
      try {
        await initialize(unavailable);
        unavailable.window.dispatchEvent(new Event("online")); await unavailable.boundary.retryAccountVerification();
        assert.equal(unavailable.client(), undefined); assert.equal(unavailable.profiles.getDataProfile().kind, "guest");
        assert.ok(unavailable.boundary.getAccountError()); assert.equal(unavailable.boundary.getAccountError().includes("SYNTHETIC_PRIVATE_DETAIL"), false);
        assert.equal(signedOutData.get("explicit-signout"), true); assert.deepEqual(signedOutData.get(ownerKey), original); checks++;
      } finally { await unavailable.close(); }
    }

    const cache = new Map(auth), privateData = cloneWorkspaces(); cache.set(key, JSON.stringify({ version: 1, enabled: false }));
    const w = createWorld(cache, privateData);
    try {
      await initialize(w);
      w.state.authStatus = 401;
      await w.boundary.signInAccount(w.user.email, "synthetic-sign-in-password");
      assert.equal(w.profiles.getDataProfile().kind, "guest"); assert.equal(w.boundary.isAccountVerified(), false);
      w.state.authStatus = 200;
      await w.client().auth.setSession({ access_token: w.token, refresh_token: "synthetic-refresh" });
      await delay(); await w.boundary.retryAccountVerification();
      assert.equal(w.profiles.getDataProfile().kind, "guest", "Background events after failed login cannot release the gate"); checks++;
      const other = { ...w.user, id: "55555555-5555-4555-8555-555555555555", email: "other@example.invalid" };
      w.state.signInUser = other;
      await w.boundary.signInAccount(other.email, "synthetic-sign-in-password");
      assert.equal(w.profiles.getDataProfile().ownerId, other.id); assert.equal(w.boundary.isAccountVerified(), true);
      assert.deepEqual(privateData.get(ownerKey), original); checks++;
      // Off affects the next startup, not this authenticated workspace.
      cache.set(key, JSON.stringify({ version: 1, enabled: false }));
      w.window.dispatchEvent(new Event("focus")); await w.boundary.initializeAccountBoundary();
      assert.equal(w.profiles.getDataProfile().ownerId, other.id); checks++;
      await w.boundary.signOutAccount();
      await w.client().auth.setSession({ access_token: w.token, refresh_token: "synthetic-refresh" });
      await delay(); await w.boundary.retryAccountVerification();
      assert.equal(w.profiles.getDataProfile().kind, "guest", "Explicit logout never silently restores a retained/background session"); checks++;
    } finally { await w.close(); }

    // A deliberate recovery link can bind its owner, never open financial data.
    const recoveryCache = new Map(auth); recoveryCache.set(key, JSON.stringify({ version: 1, enabled: false }));
    const recoveryData = cloneWorkspaces(), recoveryWorld = createWorld(recoveryCache, recoveryData);
    try {
      recoveryWorld.window.location.hash = "#type=recovery&access_token=synthetic-access&refresh_token=synthetic-refresh";
      await initialize(recoveryWorld);
      assert.ok(recoveryWorld.client()); assert.equal(recoveryWorld.profiles.getDataProfile().kind, "guest");
      recoveryWorld.recovery.observePasswordRecovery("PASSWORD_RECOVERY", recoveryWorld.user.id);
      assert.equal(recoveryWorld.recovery.isPasswordRecovery(), true);
      await recoveryWorld.boundary.resetAccountPassword("synthetic-new-password");
      assert.equal(recoveryWorld.state.passwordWrites, 1); assert.equal(recoveryWorld.profiles.getDataProfile().kind, "guest");
      assert.deepEqual(recoveryData.get(ownerKey), original); checks++;
    } finally { await recoveryWorld.close(); }
    return { checks, realNetworkRequests: 0, financialDataAccessed: false };
  } finally { globalThis.fetch = savedFetch; }
}
module.exports = { runAutoLoginReview };
if (require.main === module) runAutoLoginReview().then(result => console.log("AUTO_LOGIN_PASS " + JSON.stringify(result)))
  .catch(error => { console.error("AUTO_LOGIN_FAIL " + error.stack); process.exitCode = 1; });
