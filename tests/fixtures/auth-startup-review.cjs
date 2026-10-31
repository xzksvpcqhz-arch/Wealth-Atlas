/* Auth boundary regression, not a hosted release acceptance test. Uses the actual SDK and
 * app auth/boundary modules; auth persistence and workspace I/O are in-memory
 * synthetic doubles. No browser, Electron profile, real key or backend is used. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createClient } = require("@supabase/supabase-js");

function createWorld(authStorage, workspaces, boundaryClock) {
  const cache = new Map();
  const state = { online: true, navigatorOnline: undefined, authReads: 0, passwordWrites: 0, unexpectedEndpoints: 0, authStatus: 200, authGate: null, diagnostics: [],
    sdkSessionMissing: false, sdkSessionValue: undefined, serverUser: null, sdkWrites: 0, preparedScopes: [],
    signInUser: null, signInCalls: [], signInGate: null, signOutCalls: 0, signOutGate: null };
  const user = { id: "33333333-3333-4333-8333-333333333333", email: "synthetic@example.invalid",
    aud: "authenticated", role: "authenticated", created_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {} };
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const tokenFor = (method, ownerId = user.id) => encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ sub: ownerId, aud: "authenticated", exp: now + 3600, iat: now,
    session_id: "44444444-4444-4444-8444-444444444444", amr: [{ method, timestamp: now - 1 }] }) + ".synthetic-signature";
  const token = tokenFor("password");
  const session = { access_token: token, refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "bearer", user };
  const window = new EventTarget(); window.location = { hash: "", protocol: "https:", origin: "https://synthetic-review.invalid" };
  window.sessionStorage = { getItem: (name) => authStorage.get(name) ?? null,
    setItem: (name, value) => authStorage.set(name, value), removeItem: (name) => authStorage.delete(name) };
  window.localStorage = window.sessionStorage;
  let actualClient;
  const replacements = {
    "./auth-diagnostics": { reportAuthDiagnostic: (code) => { state.diagnostics.push(code); } },
    "./auth-storage": { createAuthStorage: (...args) => load("lib/auth-storage.ts").createAuthStorage(...args), readStoredAuthSession: () => {
      const raw = authStorage.get("synthetic-review-session");
      return raw ? JSON.parse(raw) : null;
    } },
    "@supabase/supabase-js": { createClient(url, key, options) {
      actualClient = createClient(url, key, { ...options,
        auth: { ...options.auth, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "synthetic-review-session",
          storage: load("lib/auth-storage.ts").createAuthStorage({ getItem: (name) => name === "synthetic-review-session"
            ? state.sdkSessionMissing ? null : state.sdkSessionValue ?? authStorage.get(name) ?? null : authStorage.get(name) ?? null,
            setItem: (name, value) => { state.sdkWrites++; authStorage.set(name, value); },
            removeItem: (name) => { state.sdkWrites++; authStorage.delete(name); } }, replacements["./auth-diagnostics"].reportAuthDiagnostic) },
        global: { fetch: async (input, init = {}) => {
          const address = new URL(typeof input === "string" ? input : input.url), method = init.method ?? "GET";
          assert.equal(address.origin, "https://synthetic-review.invalid");
          if (address.pathname === "/auth/v1/user" && method === "GET") {
            state.authReads++;
            if (!state.online) throw new TypeError("Synthetic offline request");
            if (state.authGate) await state.authGate;
            if (state.authStatus !== 200) return new Response(JSON.stringify({ code: "bad_jwt", msg: "Synthetic rejected session" }), { status: state.authStatus, headers: { "Content-Type": "application/json" } });
            return answer(state.serverUser ?? user);
          }
          if (address.pathname === "/auth/v1/verify" && method === "POST") {
            assert.equal(JSON.parse(init.body).type, "recovery");
            return answer({ ...session, access_token: tokenFor("recovery") });
          }
          if (address.pathname === "/auth/v1/user" && method === "PUT") { state.passwordWrites++; return answer(user); }
          if (address.pathname === "/auth/v1/token" && method === "POST" && address.searchParams.get("grant_type") === "password") {
            if (state.signInUser) {
              const requested = state.signInUser;
              assert.deepEqual(JSON.parse(init.body), { email: requested.email, password: "synthetic-sign-in-password", gotrue_meta_security: {} });
              state.signInCalls.push(requested.id);
              if (state.signInGate) await state.signInGate;
              state.serverUser = requested;
              return answer({ ...session, user: requested, access_token: tokenFor("password", requested.id) });
            }
            assert.deepEqual(JSON.parse(init.body), { email: user.email, password: "synthetic-sign-in-password", gotrue_meta_security: {} });
            state.signInCalls.push(user.id);
            return answer(session);
          }
          if (address.pathname === "/auth/v1/logout") {
            state.signOutCalls++;
            if (state.signOutGate) await state.signOutGate;
            return new Response(null, { status: 204 });
          }
          state.unexpectedEndpoints++; throw new Error("Unexpected synthetic endpoint");
        } },
      });
      return actualClient;
    } },
    "./desktop": { getDesktopBridge: () => null, activateDesktopDataProfile: async () => undefined },
    "./storage": { flushWealthWrites: async () => {},
      hasVerifiedWorkspaceHistory: async () => [...workspaces.keys()].some(key => key.startsWith("receipt:")),
      wasExplicitlySignedOut: async () => workspaces.get("explicit-signout") === true,
      saveExplicitSignOutState: async (signedOut) => { workspaces.set("explicit-signout", signedOut); },
      prepareAccountWorkspace: async (scope, allowCreate = true) => {
        state.preparedScopes.push({ key: scope.key, allowCreate });
        if (!workspaces.has(scope.key)) { if (!allowCreate) throw new Error("Synthetic missing offline workspace"); workspaces.set(scope.key, { synthetic: true }); }
      },
      loadVerifiedAuthReceipt: async (ownerId, requireWorkspace = false) => {
        const receipt = workspaces.get("receipt:" + ownerId);
        if (requireWorkspace && !workspaces.has("cloud:" + ownerId)) return null;
        return load("lib/auth-session.ts").validAuthReceipt(receipt) && receipt.ownerId === ownerId ? receipt : null;
      },
      saveVerifiedAuthReceipt: async (receipt) => {
        assert.equal(load("lib/auth-session.ts").validAuthReceipt(receipt), true);
        const old = workspaces.get("receipt:" + receipt.ownerId);
        workspaces.set("receipt:" + receipt.ownerId, { ...old, ...receipt });
      } },
  };
  function answer(body) { return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }); }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    assert.ok(file.startsWith("lib/") && file.endsWith(".ts") && !file.includes(".."));
    const mod = { exports: {} }; cache.set(file, mod);
    const source = readFileSync(path.resolve(__dirname, "../..", file), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const clock = file === "lib/account-boundary.ts" ? boundaryClock : null;
    new Function("require", "module", "exports", "process", "window", "navigator", "setTimeout", "clearTimeout", "Date", compiled)((name) => {
      if (Object.hasOwn(replacements, name)) return replacements[name];
      if (name === "../desktop/auth-diagnostic-codes.json") return require("../../desktop/auth-diagnostic-codes.json");
      if (name.startsWith(".")) return load(path.posix.normalize(path.posix.join(path.posix.dirname(file), name)) + ".ts");
      return require(name);
    }, mod, mod.exports, { env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-review.invalid",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-only" } }, window, { get onLine() { return state.navigatorOnline; } },
      clock?.setTimeout ?? setTimeout, clock?.clearTimeout ?? clearTimeout, clock?.Date ?? Date);
    return mod.exports;
  }
  const clientModule = load("lib/supabase-client.ts"), cloud = load("lib/cloud-sync.ts");
  const recovery = load("lib/password-recovery.ts"), profiles = load("lib/data-profile.ts"), boundary = load("lib/account-boundary.ts");
  return { state, user, token, session, window, clientModule, cloud, recovery, profiles, boundary,
    storage: replacements["./storage"],
    client: () => actualClient, async close() { boundary.disposeAccountBoundary(); await actualClient?.auth.stopAutoRefresh(); } };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Only the boundary's clock is virtual: SDK auth, storage reads and request
// handling remain real. Advancing time must not invoke a manual verification.
function createBoundaryClock() {
  let now = Date.now(), nextId = 0;
  const pending = new Map(), firedDelays = [];
  return { pending, firedDelays, Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, ms = 0) => { const id = ++nextId; pending.set(id, { callback, ms, due: now + ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    async next(settled) {
      assert.equal(pending.size, 1, "Exactly one automatic recovery timer must be pending");
      const [id, timer] = pending.entries().next().value;
      pending.delete(id); now = timer.due; firedDelays.push(timer.ms); timer.callback();
      for (let attempt = 0; attempt < 200 && !settled(); attempt++) await delay(1);
      assert.ok(settled(), "Automatic SDK verification must settle after the timer fires");
    } };
}
async function initialize(world) {
  await world.boundary.initializeAccountBoundary();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!world.boundary.isAccountBusy() && (world.profiles.getDataProfile().kind !== "locked" || world.boundary.getAccountError())) return;
    await delay(10);
  }
  throw new Error("Synthetic boundary did not settle");
}

async function runReview() {
  const savedFetch = globalThis.fetch;
  let unmockedFetchAttempts = 0;
  globalThis.fetch = async () => { unmockedFetchAttempts++; throw new Error("Unmocked network is disabled in diagnostic review"); };
  try {
  // A last confirmed synthetic account workspace, not a real financial snapshot.
  const authStorage = new Map(), workspaces = new Map();
  const original = { synthetic: true, transactions: [{ id: "synthetic-pending-record" }] };
  const seed = createWorld(authStorage, workspaces);
  const ownerKey = "cloud:" + seed.user.id; workspaces.set(ownerKey, structuredClone(original));
  const seeded = await seed.clientModule.getSupabaseClient().auth.setSession({ access_token: seed.token, refresh_token: "synthetic-refresh" });
  assert.equal(seeded.error, null);
  await initialize(seed);
  assert.equal(seed.profiles.getDataProfile().kind, "cloud");
  await seed.close();

  const copyWorkspaces = () => new Map([...workspaces].map(([key, value]) => [key, structuredClone(value)]));
  const startupNullSession = [];
  for (const scenario of ["recovers-correct-user", "bounded-persistent-null", "different-account", "server-rejected", "explicit-sign-out"]) {
    const auth = new Map(authStorage), local = copyWorkspaces(), clock = createBoundaryClock();
    const world = createWorld(auth, local, clock), receiptKey = "receipt:" + world.user.id;
    const receiptBefore = structuredClone(local.get(receiptKey)), authBefore = new Map(auth);
    world.state.sdkSessionMissing = scenario !== "different-account";
    if (scenario === "different-account") {
      const other = { ...world.user, id: "55555555-5555-4555-8555-555555555555" };
      const otherSession = JSON.parse(auth.get("synthetic-review-session"));
      const parts = otherSession.access_token.split("."), claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      parts[1] = Buffer.from(JSON.stringify({ ...claims, sub: other.id })).toString("base64url");
      world.state.sdkSessionValue = JSON.stringify({ ...otherSession, user: other, access_token: parts.join(".") });
      world.state.serverUser = other; // Same email deliberately cannot override the owner-ID fence.
      // Settle the SDK's own initialization notification before subscribing;
      // this case isolates resolveIdentity's expected-owner comparison.
      await world.clientModule.getSupabaseClient().auth.initialize();
    }
    const assertLocked = () => {
      assert.equal(world.profiles.getDataProfile().kind, "locked", scenario);
      assert.equal(world.boundary.getAccountUser(), null, scenario);
      assert.equal(world.boundary.isAccountVerified(), false, scenario);
      assert.ok(world.boundary.getAccountError(), scenario);
      assert.equal(local.has("guest"), false, "Missing/rejected identity must never create a blank guest");
      assert.deepEqual(local.get(ownerKey), original, "The original synthetic workspace must not change");
    };
    try {
      await initialize(world);
      assert.ok(world.state.diagnostics.includes("OFFLINE_PROOF_ACCEPTED"), "Exact local proof must precede the SDK check");
      assert.deepEqual(world.state.preparedScopes, [{ key: ownerKey, allowCreate: false }]);
      assertLocked();
      if (scenario === "different-account") {
        assert.equal(world.state.diagnostics.includes("ONLINE_VERIFIED"), true, "A real SDK result for another account must still be rejected");
        assert.equal(local.has("cloud:" + world.state.serverUser.id), false);
        assert.equal(clock.pending.size, 0, "An owner mismatch must not enter transient recovery");
      } else {
        assert.equal(world.state.authReads, 0, "A missing SDK session must not make a server request");
        assert.ok(world.state.diagnostics.includes("ONLINE_SESSION_MISSING"));
        assert.ok(world.state.diagnostics.includes("AUTH_HISTORY_WITHOUT_SESSION"), "Accepted offline proof plus null SDK session must reach the missing-session branch");
        assert.equal(clock.pending.size, 1, "A null startup session must retain bounded automatic verification");
        assert.deepEqual(local.get(receiptKey), receiptBefore, "Null cannot extend the 24-hour proof");
        assert.deepEqual(auth, authBefore, "Null cannot restore or rewrite SDK tokens");
        assert.equal(world.state.sdkWrites, 0);
        if (scenario === "recovers-correct-user") {
          // The adapter can read its already-existing synthetic value again;
          // neither app nor fixture calls setSession/restores any token.
          world.state.sdkSessionMissing = false;
          await clock.next(() => world.boundary.isAccountVerified());
          assert.equal(world.boundary.getAccountUser()?.id, world.user.id);
          assert.equal(world.profiles.getDataProfile().ownerId, world.user.id);
          assert.equal(world.boundary.getAccountError(), null);
          assert.equal(world.state.authReads, 1, "Recovery must verify the correct user via the real SDK");
          assert.deepEqual(clock.firedDelays, [2200]);
          assert.equal(clock.pending.size, 0);
          assert.deepEqual(local.get(ownerKey), original);
          assert.equal(local.has("guest"), false);
        } else if (scenario === "bounded-persistent-null") {
          for (let attempt = 0; attempt < 5; attempt++) {
            const checks = world.state.diagnostics.filter(code => code === "AUTH_HISTORY_WITHOUT_SESSION").length;
            await clock.next(() => world.state.diagnostics.filter(code => code === "AUTH_HISTORY_WITHOUT_SESSION").length > checks
              && (clock.pending.size === 1 || world.state.diagnostics.includes("AUTH_RECOVERY_EXHAUSTED")));
            assertLocked();
            assert.deepEqual(local.get(receiptKey), receiptBefore);
          }
          assert.deepEqual(clock.firedDelays, [2200, 5000, 10000, 20000, 30000]);
          assert.equal(clock.pending.size, 0, "Persistent null must stop after exactly five automatic attempts");
          assert.equal(world.state.diagnostics.filter(code => code === "ONLINE_SESSION_MISSING").length, 6);
          assert.equal(world.state.authReads, 0);
          assert.deepEqual(auth, authBefore);
          assert.equal(world.state.sdkWrites, 0);
        } else if (scenario === "server-rejected") {
          world.state.sdkSessionMissing = false; world.state.authStatus = 401;
          await clock.next(() => world.state.diagnostics.includes("ONLINE_REJECTED") && clock.pending.size === 0);
          assertLocked();
          assert.equal(world.state.authReads, 1);
          assert.deepEqual(local.get(receiptKey), receiptBefore);
          assert.equal(world.state.diagnostics.includes("AUTH_RECOVERY_EXHAUSTED"), false);
        } else {
          const signOut = world.boundary.signOutAccount();
          assert.equal(world.profiles.getDataProfile().kind, "locked", "Explicit sign-out fences synchronously");
          assert.equal(world.boundary.getAccountUser(), null);
          assert.equal(world.boundary.isAccountVerified(), false);
          assert.equal(clock.pending.size, 0);
          await signOut;
          assert.equal(world.boundary.getAccountUser(), null);
          assert.equal(world.profiles.getDataProfile().kind, "guest");
          assert.equal(local.get("explicit-signout"), true);
          assert.equal(clock.pending.size, 0);
          assert.deepEqual(local.get(ownerKey), original);
        }
      }
      assert.equal(world.state.unexpectedEndpoints, 0, "No upload, refresh, or other unexpected endpoint is allowed");
      assert.equal(world.state.passwordWrites, 0);
      startupNullSession.push({ name: scenario, pass: true, automaticDelays: [...clock.firedDelays] });
    } catch (error) {
      console.error("AUTH_STARTUP_NULL_SESSION_FAILURE " + JSON.stringify({ scenario, profile: world.profiles.getDataProfile().kind,
        busy: world.boundary.isAccountBusy(), errorShown: Boolean(world.boundary.getAccountError()),
        pendingDelays: [...clock.pending.values()].map(timer => timer.ms), diagnostics: world.state.diagnostics }));
      throw error;
    } finally { await world.close(); }
    assert.equal(clock.pending.size, 0);
  }
  const backgroundPrivacyFences = [];
  for (const event of ["SIGNED_OUT", "different-owner"]) {
    const auth = new Map(authStorage), local = copyWorkspaces(), clock = createBoundaryClock();
    const world = createWorld(auth, local, clock);
    let release;
    try {
      await world.clientModule.getSupabaseClient().auth.initialize();
      await initialize(world);
      assert.equal(world.boundary.isAccountVerified(), true);
      const readsBefore = world.state.authReads;
      world.state.authGate = new Promise(resolve => { release = resolve; });
      const sdkSession = (await world.client().auth.getSession()).data.session;
      await world.client().auth._notifyAllSubscribers("TOKEN_REFRESHED", sdkSession);
      await clock.next(() => world.state.authReads > readsBefore);
      const staleVerification = world.boundary.retryAccountVerification(); // Coalesces with the gated background check.
      const other = { ...world.user, id: "55555555-5555-4555-8555-555555555555" };
      const notification = world.client().auth._notifyAllSubscribers(event === "SIGNED_OUT" ? event : "SIGNED_IN",
        event === "SIGNED_OUT" ? null : { ...sdkSession, user: other });
      const immediateFence = world.profiles.getDataProfile().kind === "locked"
        && world.boundary.getAccountUser() === null && !world.boundary.isAccountVerified();
      await notification;
      if (!immediateFence) console.error("AUTH_BACKGROUND_PRIVACY_FENCE_FAILURE " + JSON.stringify({ event, immediateFence }));
      assert.equal(immediateFence, true, "External sign-out/owner change must fence during a pending background SDK check");
      release(); await staleVerification; // A stale successful response must not reopen the old owner.
      assert.equal(world.profiles.getDataProfile().kind, "locked");
      await clock.next(() => !world.boundary.isAccountBusy() && Boolean(world.boundary.getAccountError()));
      assert.equal(world.profiles.getDataProfile().kind, "locked");
      assert.equal(world.boundary.getAccountUser(), null);
      assert.equal(world.boundary.isAccountVerified(), false);
      assert.equal(clock.pending.size, 0, "The old generation cannot schedule recovery or reopen offline access");
      assert.equal(local.has("guest"), false);
      assert.equal(local.has("cloud:" + other.id), false);
      assert.deepEqual(local.get(ownerKey), original);

      const signIn = world.boundary.signInAccount(world.user.email, "synthetic-sign-in-password");
      assert.equal(world.profiles.getDataProfile().kind, "locked");
      await signIn;
      assert.equal(world.boundary.isAccountVerified(), true, "An explicit sign-in must not cancel itself on its own SDK event");
      assert.equal(world.boundary.getAccountUser()?.id, world.user.id);
      assert.equal(world.boundary.getAccountError(), null);
      assert.equal(clock.pending.size, 0);
      const signOut = world.boundary.signOutAccount();
      assert.equal(world.profiles.getDataProfile().kind, "locked");
      await signOut;
      assert.equal(world.profiles.getDataProfile().kind, "guest", "An explicit sign-out must complete despite its own SDK event");
      assert.equal(world.boundary.getAccountUser(), null);
      assert.equal(local.get("explicit-signout"), true);
      assert.deepEqual(local.get(ownerKey), original);
      assert.equal(clock.pending.size, 0);
      assert.equal(world.state.unexpectedEndpoints, 0);
      assert.equal(world.state.passwordWrites, 0);
      backgroundPrivacyFences.push({ event, immediateFence, staleSuccessDiscarded: true, explicitAuthNotCancelled: true });
    } catch (error) {
      console.error("AUTH_BACKGROUND_PRIVACY_FENCE_STATE " + JSON.stringify({ event, profile: world.profiles.getDataProfile().kind,
        pendingDelays: [...clock.pending.values()].map(timer => timer.ms), diagnostics: world.state.diagnostics }));
      throw error;
    } finally { release?.(); await world.close(); }
  }
  const queuedAuthIntents = [];
  const intentCases = [
    { name: "queued-sign-in-refresh", event: "TOKEN_REFRESHED" },
    { name: "queued-sign-in-signed-in", event: "SIGNED_IN" },
    { name: "queued-sign-out-refresh", event: "TOKEN_REFRESHED", signOut: true },
    { name: "queued-sign-out-signed-in", event: "SIGNED_IN", signOut: true },
    { name: "newest-queued-sign-in", event: "TOKEN_REFRESHED", supersede: true },
    { name: "newest-queued-sign-out", event: "SIGNED_IN", supersede: true, signOut: true },
    { name: "running-sign-in-then-sign-in", event: "TOKEN_REFRESHED", running: true },
    { name: "running-sign-in-then-sign-out", event: "SIGNED_IN", running: true, signOut: true },
  ];
  for (const scenario of intentCases) {
    const local = copyWorkspaces(), clock = createBoundaryClock(), world = createWorld(new Map(authStorage), local, clock);
    const second = { ...world.user, id: "55555555-5555-4555-8555-555555555555", email: "synthetic-second@example.invalid" };
    const third = { ...world.user, id: "66666666-6666-4666-8666-666666666666", email: "synthetic-third@example.invalid" };
    const target = scenario.running || scenario.supersede ? third : second;
    const privateDraft = { synthetic: true, transactions: [{ id: "synthetic-other-owner-draft" }] };
    for (const owner of [second, third]) local.set("cloud:" + owner.id, structuredClone(privateDraft));
    let releaseFirst, releaseLatest, unsubscribe;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const latestGate = new Promise(resolve => { releaseLatest = resolve; });
    const observedOwners = [], operations = [];
    const waitFor = async (condition) => {
      for (let attempt = 0; attempt < 200 && !condition(); attempt++) await delay(1);
      assert.ok(condition(), "Synthetic queued auth request must reach its gate");
    };
    try {
      await world.clientModule.getSupabaseClient().auth.initialize();
      await initialize(world);
      assert.equal(world.boundary.getAccountUser()?.id, world.user.id);
      assert.equal(world.boundary.isAccountVerified(), true);
      const oldSession = (await world.client().auth.getSession()).data.session;
      const preparedBefore = world.state.preparedScopes.length;
      unsubscribe = world.boundary.subscribeAccountBoundary(() => {
        if (world.profiles.getDataProfile().kind === "cloud") observedOwners.push(world.profiles.getDataProfile().ownerId);
      });
      if (scenario.running) {
        world.state.signInUser = second; world.state.signInGate = firstGate;
        operations.push(world.boundary.signInAccount(second.email, "synthetic-sign-in-password"));
        await waitFor(() => world.state.signInCalls.length === 1);
        if (scenario.signOut) world.state.signOutGate = latestGate;
        else world.state.signInGate = latestGate;
      } else {
        const readsBefore = world.state.authReads;
        world.state.authGate = firstGate;
        await world.client().auth._notifyAllSubscribers("TOKEN_REFRESHED", oldSession);
        await clock.next(() => world.state.authReads > readsBefore);
        operations.push(world.boundary.retryAccountVerification()); // Existing gated background check, not a new retry.
        if (scenario.supersede) operations.push(world.boundary.signInAccount(second.email, "synthetic-sign-in-password"));
      }
      world.state.signInUser = target;
      const latest = scenario.signOut ? world.boundary.signOutAccount()
        : world.boundary.signInAccount(target.email, "synthetic-sign-in-password");
      operations.push(latest);
      const lockedBeforeLateEvent = world.profiles.getDataProfile().kind === "locked"
        && world.boundary.getAccountUser() === null && !world.boundary.isAccountVerified();
      assert.equal(lockedBeforeLateEvent, true);
      await world.client().auth._notifyAllSubscribers(scenario.event, oldSession);
      releaseFirst();
      await Promise.all(operations.slice(0, -1));
      if (scenario.running) {
        await waitFor(() => scenario.signOut ? world.state.signOutCalls === 1 : world.state.signInCalls.length === 2);
        assert.equal(world.profiles.getDataProfile().kind, "locked", "The newest intent still holds the privacy lock after the old finally");
        // The older operation has finished, but its finally must not clear the
        // newer intent while that intent's real SDK request is still pending.
        await world.client().auth._notifyAllSubscribers(scenario.event, oldSession);
        releaseLatest();
      }
      await latest;
      // Drain a stolen-generation callback on the broken implementation so the
      // failure records the reopened old owner, not merely a pending callback.
      if (clock.pending.size) await clock.next(() => !world.boundary.isAccountBusy());
      const requestedOwnerActive = scenario.signOut
        ? world.profiles.getDataProfile().kind === "guest" && world.boundary.getAccountUser() === null && local.get("explicit-signout") === true
        : world.boundary.getAccountUser()?.id === target.id && world.profiles.getDataProfile().ownerId === target.id && world.boundary.isAccountVerified();
      const result = { name: scenario.name, lockedBeforeLateEvent,
        signInExecuted: world.state.signInCalls.includes(target.id), signOutExecuted: world.state.signOutCalls > 0,
        requestedOwnerActive, oldOwnerReopened: observedOwners.includes(world.user.id) };
      if (!requestedOwnerActive || result.oldOwnerReopened) console.error("AUTH_QUEUED_INTENT_FAILURE " + JSON.stringify(result));
      assert.equal(requestedOwnerActive, true, "Queued explicit intent must survive late events from the old SDK session");
      assert.equal(result.oldOwnerReopened, false, "Old owner A must never reopen after requesting a different owner/sign-out");
      assert.deepEqual(world.state.signInCalls, [...(scenario.running ? [second.id] : []), ...(scenario.signOut ? [] : [target.id])]);
      assert.equal(world.state.signOutCalls, scenario.signOut ? 1 : 0);
      assert.deepEqual(world.state.preparedScopes.slice(preparedBefore).map(scope => scope.key), [scenario.signOut ? "guest" : "cloud:" + target.id]);
      assert.equal(world.boundary.getAccountError(), null);
      assert.deepEqual(local.get(ownerKey), original);
      for (const owner of [second, third]) assert.deepEqual(local.get("cloud:" + owner.id), privateDraft);
      assert.equal(clock.pending.size, 0);
      if (!scenario.signOut) {
        const notification = world.client().auth._notifyAllSubscribers("SIGNED_OUT", null);
        assert.equal(world.profiles.getDataProfile().kind, "locked", "Completed explicit intent must not shield later external sign-out");
        await notification;
        await clock.next(() => !world.boundary.isAccountBusy() && Boolean(world.boundary.getAccountError()));
        assert.equal(world.profiles.getDataProfile().kind, "locked");
        assert.equal(world.boundary.getAccountUser(), null);
      }
      assert.equal(world.state.unexpectedEndpoints, 0);
      assert.equal(world.state.passwordWrites, 0);
      queuedAuthIntents.push(result);
    } finally {
      releaseFirst(); releaseLatest();
      await Promise.allSettled(operations);
      unsubscribe?.(); await world.close();
    }
  }
  const postActivationOwnerChange = { injectedDuringActivation: false, ownerChangeFencedAfterActivation: false, rejectedIdentityStayedLocked: false };
  {
    const local = copyWorkspaces(), clock = createBoundaryClock(), world = createWorld(new Map(authStorage), local, clock);
    const second = { ...world.user, id: "55555555-5555-4555-8555-555555555555", email: "synthetic-second@example.invalid" };
    const third = { ...world.user, id: "66666666-6666-4666-8666-666666666666", email: "synthetic-third@example.invalid" };
    const secondDraft = { synthetic: true, transactions: [{ id: "synthetic-post-activation-draft" }] };
    local.set("cloud:" + second.id, structuredClone(secondDraft));
    let notification, unsubscribe, signInSettled = false;
    try {
      await world.clientModule.getSupabaseClient().auth.initialize();
      await initialize(world);
      world.state.signInUser = second;
      unsubscribe = world.boundary.subscribeAccountBoundary(() => {
        if (postActivationOwnerChange.injectedDuringActivation || world.profiles.getDataProfile().ownerId !== second.id) return;
        // activate() calls notify synchronously just after publishDataProfile(B),
        // before its promise resolves back to runAuth and its finally can run.
        postActivationOwnerChange.injectedDuringActivation = !signInSettled;
        world.state.authStatus = 401;
        notification = world.client().auth._notifyAllSubscribers("SIGNED_IN", { ...world.session, user: third });
        postActivationOwnerChange.ownerChangeFencedAfterActivation = world.profiles.getDataProfile().kind === "locked"
          && world.boundary.getAccountUser() === null && !world.boundary.isAccountVerified();
      });
      await world.boundary.signInAccount(second.email, "synthetic-sign-in-password").finally(() => { signInSettled = true; });
      await notification;
      assert.equal(postActivationOwnerChange.injectedDuringActivation, true);
      assert.equal(postActivationOwnerChange.ownerChangeFencedAfterActivation, true, "Publishing/unlocking B must end explicit-operation event shielding before finally");
      assert.equal(world.profiles.getDataProfile().kind, "locked");
      await clock.next(() => !world.boundary.isAccountBusy() && Boolean(world.boundary.getAccountError()));
      assert.equal(world.state.diagnostics.includes("ONLINE_REJECTED"), true);
      assert.equal(world.profiles.getDataProfile().kind, "locked", "Rejected C must never fall back to offline owner B");
      assert.equal(world.boundary.getAccountUser(), null);
      assert.equal(world.boundary.isAccountVerified(), false);
      assert.equal(clock.pending.size, 0);
      assert.equal(local.has("guest"), false);
      assert.equal(local.has("cloud:" + third.id), false);
      assert.deepEqual(local.get(ownerKey), original);
      assert.deepEqual(local.get("cloud:" + second.id), secondDraft);
      assert.equal(world.state.unexpectedEndpoints, 0);
      assert.equal(world.state.passwordWrites, 0);
      postActivationOwnerChange.rejectedIdentityStayedLocked = true;
    } finally { unsubscribe?.(); await world.close(); }
  }
  const physical = createWorld(new Map(authStorage), copyWorkspaces());
  physical.state.online = false; physical.state.navigatorOnline = false;
  await initialize(physical);
  assert.equal(physical.client(), undefined, "Physical-offline startup must not construct an eager Auth SDK");
  assert.equal(physical.profiles.getDataProfile().kind, "cloud");
  assert.equal(physical.boundary.isAccountVerified(), false);
  assert.ok(physical.state.diagnostics.includes("AUTH_SDK_DEFERRED_OFFLINE"));
  const physicalScope = physical.profiles.getDataProfile();
  physical.state.online = true; physical.state.navigatorOnline = true;
  physical.window.dispatchEvent(new Event("online"));
  for (let attempt = 0; attempt < 200 && !physical.boundary.isAccountVerified(); attempt++) await delay(10);
  assert.equal(physical.boundary.isAccountVerified(), true);
  assert.equal(physical.profiles.getDataProfile(), physicalScope);
  await physical.client().auth._notifyAllSubscribers("SIGNED_OUT", null);
  await delay(50);
  assert.equal(physical.profiles.getDataProfile().kind, "locked", "External SDK sign-out is an explicit privacy/error fence, not empty guest success");
  assert.ok(physical.boundary.getAccountError());
  await physical.close();

  const noSessionWorkspaces = copyWorkspaces(), guestBeforeMissing = noSessionWorkspaces.has("guest");
  const missingSession = createWorld(new Map(), noSessionWorkspaces); await initialize(missingSession);
  assert.equal(missingSession.state.authReads, 0, "getUser must not run SDK session cleanup for a missing session");
  assert.equal(missingSession.profiles.getDataProfile().kind, "locked");
  assert.ok(missingSession.boundary.getAccountError());
  assert.equal(noSessionWorkspaces.has("guest"), guestBeforeMissing);
  assert.deepEqual(noSessionWorkspaces.get(ownerKey), original);
  await missingSession.close();

  const missedEventLocal = copyWorkspaces();
  missedEventLocal.get("receipt:" + seed.user.id).binding = "a".repeat(64);
  const missedEvent = createWorld(new Map(authStorage), missedEventLocal); missedEvent.state.online = false;
  const beforeMissedConsole = console.error; console.error = () => {};
  try { await initialize(missedEvent); } finally { console.error = beforeMissedConsole; }
  assert.equal(missedEvent.profiles.getDataProfile().kind, "locked");
  missedEvent.state.online = true; // Deliberately do NOT emit online or focus.
  for (let attempt = 0; attempt < 500 && !missedEvent.boundary.isAccountVerified(); attempt++) await delay(10);
  assert.equal(missedEvent.boundary.isAccountVerified(), true, "Bounded timer recovers a missed online event");
  assert.deepEqual(missedEventLocal.get(ownerKey), original); await missedEvent.close();

  // The real SDK can emit INITIAL_SESSION(null) on a failed initial read or
  // refresh. This is not SIGNED_OUT and must not cancel our own startup check.
  const coldAuth = new Map(authStorage);
  const coldWorkspaces = new Map([...workspaces].map(([key, value]) => [key, structuredClone(value)]));
  const initialNull = createWorld(coldAuth, coldWorkspaces);
  initialNull.state.online = false;
  const guestExisted = coldWorkspaces.has("guest");
  const previousError = console.error, previousWarn = console.warn;
  console.error = console.warn = () => {};
  let initialNullScope;
  try {
    const startup = initialNull.boundary.initializeAccountBoundary();
    // Local proof now intentionally completes before constructing the SDK.
    for (let attempt = 0; !initialNull.client() && attempt < 100; attempt++) await delay(5);
    assert.ok(initialNull.client(), "SDK attaches only after local preflight");
    await initialNull.client().auth._notifyAllSubscribers("INITIAL_SESSION", null);
    await startup;
    await delay(80);
    assert.equal(initialNull.profiles.getDataProfile().kind, "cloud");
    assert.equal(initialNull.boundary.isAccountVerified(), false);
    initialNullScope = initialNull.profiles.getDataProfile();
    await initialNull.client().auth._notifyAllSubscribers("INITIAL_SESSION", null);
    await delay(20);
    assert.equal(initialNull.profiles.getDataProfile(), initialNullScope, "An initial notification cannot remount a private draft");
  } finally { console.error = previousError; console.warn = previousWarn; }
  assert.equal((await initialNull.client().auth.getSession()).data.session?.user.id, initialNull.user.id);
  assert.equal(coldWorkspaces.has("guest"), guestExisted, "A transient initial notification must not create an empty guest workspace");
  const readsBeforeReconnect = initialNull.state.authReads;
  initialNull.state.online = true;
  initialNull.window.dispatchEvent(new Event("online"));
  for (let attempt = 0; attempt < 100 && !initialNull.boundary.isAccountVerified(); attempt++) await delay(10);
  assert.equal(initialNull.boundary.isAccountVerified(), true);
  assert.equal(initialNull.state.authReads > readsBeforeReconnect, true, "Reconnect must verify against the server without a manual sync");
  assert.equal(initialNull.profiles.getDataProfile(), initialNullScope);
  assert.equal(initialNull.boundary.getAccountError(), null);
  assert.deepEqual(coldWorkspaces.get(ownerKey), original);
  await initialNull.boundary.signOutAccount();
  assert.equal(initialNull.profiles.getDataProfile().kind, "guest", "Explicit sign-out must still fence private data");
  assert.equal(initialNull.boundary.getAccountUser(), null);
  assert.deepEqual(coldWorkspaces.get(ownerKey), original);
  await initialNull.close();
  const afterIntentionalSignOut = createWorld(coldAuth, coldWorkspaces); await initialize(afterIntentionalSignOut);
  assert.equal(afterIntentionalSignOut.profiles.getDataProfile().kind, "guest", "Intentional sign-out still reopens the normal signed-out view");
  assert.equal(afterIntentionalSignOut.boundary.getAccountError(), null);
  assert.deepEqual(coldWorkspaces.get(ownerKey), original); await afterIntentionalSignOut.close();

  const offline = createWorld(authStorage, workspaces); offline.state.online = false;
  // The SDK prints the deliberately thrown synthetic network error. Suppress
  // provider output; only the structured booleans below leave this diagnostic.
  const savedConsoleError = console.error; console.error = () => {};
  try { await initialize(offline); } finally { console.error = savedConsoleError; }
  const cached = await offline.client().auth.getSession();
  const offlineResult = { cachedSessionRetained: cached.data.session?.user.id === offline.user.id,
    activeProfile: offline.profiles.getDataProfile().kind, authErrorShown: Boolean(offline.boundary.getAccountError()),
    authNetworkAttempted: offline.state.authReads > 0, originalWorkspaceUnchanged: JSON.stringify(workspaces.get(ownerKey)) === JSON.stringify(original) };
  assert.equal(offlineResult.cachedSessionRetained, true);
  assert.equal(offlineResult.originalWorkspaceUnchanged, true);
  assert.equal(offlineResult.activeProfile, "cloud");
  assert.equal(offline.boundary.isAccountVerified(), false);
  const offlineScope = offline.profiles.getDataProfile();
  offline.state.online = true; offline.window.dispatchEvent(new Event("online")); await delay(100);
  const verified = await offline.cloud.getCurrentUser();
  await initialize(offline); // The existing initialization promise is already cached.
  const resumed = { serverIdentityAvailable: verified?.id === offline.user.id,
    activeProfile: offline.profiles.getDataProfile().kind, authErrorStillShown: Boolean(offline.boundary.getAccountError()),
    originalWorkspaceUnchanged: JSON.stringify(workspaces.get(ownerKey)) === JSON.stringify(original) };
  assert.equal(resumed.activeProfile, "cloud"); assert.equal(resumed.authErrorStillShown, false);
  assert.equal(offline.boundary.isAccountVerified(), true);
  assert.equal(offline.profiles.getDataProfile(), offlineScope, "Revalidation must not remount a draft");
  await offline.close();
  const restarted = createWorld(authStorage, workspaces); await initialize(restarted);
  const onlineRestartWorks = restarted.profiles.getDataProfile().kind === "cloud";
  await restarted.close();
  assert.equal(onlineRestartWorks, true); assert.equal(resumed.serverIdentityAvailable, true);

  const negativeChecks = [];
  for (const kind of ["missing-receipt", "wrong-binding", "wrong-owner", "expired-receipt", "missing-workspace", "forged-cached-user", "server-invalid-session"]) {
    const auth = new Map(authStorage), local = new Map([...workspaces].map(([key, value]) => [key, structuredClone(value)]));
    const receiptKey = "receipt:" + seed.user.id;
    if (kind === "missing-receipt") local.delete(receiptKey);
    if (kind === "wrong-binding") local.get(receiptKey).binding = "a".repeat(64);
    if (kind === "wrong-owner") local.get(receiptKey).ownerId = "synthetic-other-owner";
    if (kind === "expired-receipt") local.get(receiptKey).verifiedAt = Date.now() - 86400001;
    if (kind === "missing-workspace") local.delete(ownerKey);
    if (kind === "forged-cached-user") {
      const value = JSON.parse(auth.get("synthetic-review-session")); value.user.id = "synthetic-other-owner";
      auth.set("synthetic-review-session", JSON.stringify(value));
    }
    const world = createWorld(auth, local); world.state.online = kind === "server-invalid-session";
    if (world.state.online) world.state.authStatus = 401;
    const previousError = console.error; console.error = () => {};
    try { await initialize(world); } finally { console.error = previousError; }
    assert.notEqual(world.profiles.getDataProfile().kind, "cloud", kind + " must not open private workspace");
    assert.equal(world.boundary.isAccountVerified(), false);
    if (kind === "missing-workspace") assert.equal(local.has(ownerKey), false);
    else assert.deepEqual(local.get(ownerKey), original);
    negativeChecks.push({ name: kind, pass: true }); await world.close();
  }
  const raced = createWorld(new Map(authStorage), new Map([...workspaces].map(([key, value]) => [key, structuredClone(value)])));
  raced.state.online = false;
  const raceConsoleError = console.error; console.error = () => {};
  try { await initialize(raced); } finally { console.error = raceConsoleError; }
  raced.state.online = true;
  let release; raced.state.authGate = new Promise((resolve) => { release = resolve; });
  const a = raced.boundary.retryAccountVerification(), b = raced.boundary.retryAccountVerification();
  assert.equal(a, b, "Repeated verification must coalesce");
  await delay(20);
  const logout = raced.boundary.signOutAccount();
  release(); await a; await logout;
  assert.equal(raced.profiles.getDataProfile().kind, "guest");
  assert.equal(raced.boundary.getAccountUser(), null);
  await raced.close();

  const recoveryStorage = new Map(), recoveryWorkspaces = new Map();
  const first = createWorld(recoveryStorage, recoveryWorkspaces);
  const verifyResult = await first.clientModule.getSupabaseClient().auth.verifyOtp({ token_hash: "synthetic-token-hash", type: "recovery" });
  assert.equal(verifyResult.error, null);
  await initialize(first);
  const before = { recoveryActive: first.cloud.isRecoveryLink(), recoveryOwnerBound: first.recovery.getPasswordRecoveryOwner() === first.user.id,
    passwordUpdates: first.state.passwordWrites };
  assert.equal(before.recoveryActive, true); assert.equal(before.recoveryOwnerBound, true);
  await first.close();
  const fresh = createWorld(recoveryStorage, recoveryWorkspaces); await initialize(fresh);
  const after = { recoveryActive: fresh.cloud.isRecoveryLink(), authenticated: fresh.boundary.getAccountUser()?.id === fresh.user.id,
    cachedSessionRetained: (await fresh.client().auth.getSession()).data.session?.user.id === fresh.user.id,
    passwordUpdates: fresh.state.passwordWrites };
  await fresh.close();
  assert.equal(after.cachedSessionRetained, true); assert.equal(after.authenticated, true); assert.equal(after.passwordUpdates, 0);
  assert.equal(after.recoveryActive, true);
  // A successful save must not make the same recovery session reappear later.
  const completed = createWorld(recoveryStorage, recoveryWorkspaces); await initialize(completed);
  await completed.cloud.completePasswordReset("synthetic-new-password");
  assert.equal(completed.cloud.isRecoveryLink(), false); await completed.close();
  const afterComplete = createWorld(recoveryStorage, recoveryWorkspaces); await initialize(afterComplete);
  assert.equal(afterComplete.cloud.isRecoveryLink(), false); await afterComplete.close();
  const worlds = [seed, initialNull, offline, restarted, first, fresh, completed, afterComplete];
  assert.equal(worlds.reduce((sum, world) => sum + world.state.unexpectedEndpoints, 0), 0);
  assert.equal(worlds.reduce((sum, world) => sum + world.state.passwordWrites, 0), 1);
  assert.equal(unmockedFetchAttempts, 0);
  return { purpose: "isolated-regression-not-hosted-release-acceptance",
    method: "actual-SDK-and-auth-boundary-with-in-memory-auth-and-workspace-doubles",
    startupNullSession,
    backgroundPrivacyFences,
    queuedAuthIntents,
    postActivationOwnerChange,
    initialNullNotification: { freshOfflineProfile: "cloud", lateNotificationKeptWorkspace: true,
      originalWorkspaceUnchanged: true, noEmptyGuestCreated: true, automaticReconnectVerified: true,
      explicitSignOutStillIsolates: true },
    offlineRestart: { offline: offlineResult, afterNetworkEventAndRepeatedInitialization: resumed, onlineRestartWorks },
    recoveryBeforeFreshRuntime: before, recoveryAfterFreshRuntime: after,
    completedRecoveryDoesNotReopen: true,
    concurrentRetryCoalesced: true, signOutCancelsLateVerification: true,
    physicalOfflineSdkDeferred: true, missingSessionDidNotCreateGuest: true, missedOnlineEventRecovered: true, externalSignOutStaysLocked: true,
    negativeChecks,
    findings: [
      { id: "WA-AUTH-001", severity: "P1", reproduced: offlineResult.activeProfile === "guest" && resumed.activeProfile === "guest" && resumed.serverIdentityAvailable },
      { id: "WA-AUTH-002", severity: "P1", reproduced: before.recoveryActive && !after.recoveryActive && after.authenticated && after.passwordUpdates === 0 },
    ],
    unmockedFetchAttempts, realNetworkRequests: 0, realFinancialDataAccessed: false, productionProfileAccessed: false };
  } finally { globalThis.fetch = savedFetch; }
}

module.exports = { runReview, createWorld, initialize };
if (require.main === module) runReview().then((result) => console.log("AUTH_STARTUP_REVIEW_RESULT " + JSON.stringify(result)))
  .catch((error) => { console.error("AUTH_STARTUP_REVIEW_INCONCLUSIVE " + JSON.stringify({ errorName: error?.name ?? "Error",
    code: error?.code ?? null, fixtureLine: error?.stack?.split("\n").find((line) => line.includes(__filename + ":"))?.match(/:(\d+):\d+/)?.[1] ?? null })); process.exitCode = 1; });
