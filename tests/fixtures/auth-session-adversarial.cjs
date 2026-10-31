/* Mechanism identification only. Installed SDK + unchanged auth helpers; all
 * HTTP, sessions, receipts, clocks and storage are synthetic and in memory.
 * No app, profile, financial DB, real credential or external network is used. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createClient } = require("@supabase/supabase-js");
const codes = require("../../desktop/auth-diagnostic-codes.json");
const URL_BASE = "https://synthetic-adversarial.invalid";
const STORAGE_KEY = "sb-synthetic-adversarial-auth-token";
const USER_A = { id: "77777777-7777-4777-8777-777777777777", email: "synthetic-a@example.invalid", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const USER_B = { ...USER_A, id: "88888888-8888-4888-8888-888888888888", email: "synthetic-b@example.invalid" };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function createWorld(baseNow, privateValues) {
  const w = { now: baseNow, values: new Map(), receipts: new Map(), diagnostics: [], clients: [], gates: [], pending: [],
    refreshMode: "SUCCESS", userMode: "SUCCESS", readMode: "NORMAL", writeMode: "NORMAL", userGate: null, refreshGate: null,
    reads: 0, writes: 0, removes: 0, refreshRequests: 0, userRequests: 0, signInRequests: 0, signOutRequests: 0,
    signedOut: 0, refreshed: 0, receiptWrites: 0, lastMissing: false, lastOfflineAccepted: false, lastOutcome: null };
  Date.now = () => w.now;
  const emit = code => { assert.equal(Object.hasOwn(codes, code), true); w.diagnostics.push(code); };
  const sessionFor = (user, label) => {
    const seconds = Math.floor(w.now / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const value = { access_token: encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ sub: user.id, exp: seconds + 3600, iat: seconds }) + ".synthetic-signature",
      refresh_token: "synthetic-" + label, expires_at: seconds + 3600, expires_in: 3600, token_type: "bearer", user };
    privateValues.add(value.access_token); privateValues.add(value.refresh_token); return value;
  };
  w.original = sessionFor(USER_A, "original"); w.other = sessionFor(USER_B, "other");
  w.values.set(STORAGE_KEY, JSON.stringify(w.original));
  const raw = {
    getItem(key) {
      if (key === STORAGE_KEY) {
        w.reads++;
        if (w.readMode === "THROW") throw new Error("SYNTH_PRIVATE_VENDOR_DETAIL " + key);
        if (w.readMode === "NULL") return null;
      }
      return w.values.get(key) ?? null;
    },
    setItem(key, value) {
      if (key === STORAGE_KEY) {
        w.writes++;
        if (w.writeMode === "THROW") throw new Error("SYNTH_PRIVATE_VENDOR_DETAIL " + key + value);
      }
      w.values.set(key, value);
      if (key === STORAGE_KEY && w.writeMode === "CONCURRENT_REPLACE") w.values.set(key, JSON.stringify(w.other));
    },
    removeItem(key) { if (key === STORAGE_KEY) w.removes++; w.values.delete(key); },
  };
  const browser = { localStorage: raw, location: { hash: "", href: URL_BASE + "/" } };
  const cache = new Map();
  const answer = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "X-Supabase-Api-Version": "2024-01-01" } });
  const fakeFetch = async (input, init = {}) => {
    const address = new URL(typeof input === "string" ? input : input.url);
    assert.equal(address.origin, URL_BASE);
    if (address.pathname === "/auth/v1/token") {
      if (address.searchParams.get("grant_type") === "password") { w.signInRequests++; return answer(w.other); }
      assert.equal(address.searchParams.get("grant_type"), "refresh_token");
      w.refreshRequests++;
      if (w.refreshGate) await w.refreshGate.promise;
      if (w.refreshMode === "NETWORK") { w.now += 31000; throw new TypeError("Synthetic network unavailable"); }
      if (w.refreshMode === "503") { w.now += 31000; return answer({ code: "unexpected_failure", msg: "Synthetic infrastructure failure" }, 503); }
      if (["400", "401"].includes(w.refreshMode)) return answer({ code: "refresh_token_not_found", msg: "Synthetic refresh rejection" }, Number(w.refreshMode));
      w.rotated = sessionFor(USER_A, "rotated"); return answer(w.rotated);
    }
    if (address.pathname === "/auth/v1/user" && (init.method ?? "GET") === "GET") {
      w.userRequests++;
      if (w.userGate) await w.userGate.promise;
      if (w.userMode === "SESSION_NOT_FOUND") return answer({ code: "session_not_found", msg: "Synthetic revoked session" }, 403);
      if (w.userMode === "401") return answer({ code: "bad_jwt", msg: "Synthetic JWT rejection" }, 401);
      return answer(USER_A);
    }
    if (address.pathname === "/auth/v1/logout") { w.signOutRequests++; return answer(null, 204); }
    throw new Error("Unexpected synthetic endpoint");
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    assert.ok(["lib/auth-storage.ts", "lib/auth-session.ts", "lib/supabase-client.ts", "lib/cloud-sync.ts"].includes(file));
    const mod = { exports: {} }; cache.set(file, mod);
    const compiled = ts.transpileModule(readFileSync(path.resolve(__dirname, "../..", file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", "window", "navigator", "process", compiled)(name => {
      if (name === "@supabase/supabase-js") return { createClient(url, publicKey, options) {
        const client = createClient(url, publicKey, { ...options,
          auth: { ...options.auth, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fakeFetch } });
        w.clients.push(client); return client;
      } };
      if (["./auth-storage", "./auth-session", "./supabase-client"].includes(name)) return load("lib/" + name.slice(2) + ".ts");
      if (name === "./auth-diagnostics") return { reportAuthDiagnostic: emit };
      if (name === "./storage") return {
        loadVerifiedAuthReceipt: async (owner, _workspace, onFailure) => {
          const receipt = w.receipts.get(owner); if (!receipt) onFailure?.("receipt-missing"); return receipt ?? null;
        },
        saveVerifiedAuthReceipt: async receipt => { w.receiptWrites++; w.receipts.set(receipt.ownerId, receipt); },
      };
      if (name === "./password-recovery") return { capturePasswordRecoveryIntent() {}, observePasswordRecovery() {}, clearPasswordRecovery() {}, resumeVerifiedPasswordRecovery() {} };
      if (["./cloud-transport", "./data-profile"].includes(name)) return {};
      throw new Error("Unexpected synthetic auth import");
    }, mod, mod.exports, browser, { onLine: true }, { env: { NEXT_PUBLIC_SUPABASE_URL: URL_BASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-only" } });
    return mod.exports;
  }
  w.authStorage = load("lib/auth-storage.ts"); w.auth = load("lib/auth-session.ts"); w.cloud = load("lib/cloud-sync.ts");
  w.client = load("lib/supabase-client.ts").getSupabaseClient();
  const listen = client => client.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") { w.signedOut++; emit("AUTH_EVENT_SIGNED_OUT"); }
    if (event === "TOKEN_REFRESHED") w.refreshed++;
  });
  listen(w.client);
  await w.client.auth.initialize(); await tick();
  w.receipts.set(USER_A.id, { version: 1, ownerId: USER_A.id, verifiedAt: baseNow - 1000, binding: await w.auth.sessionBinding(w.original) });
  w.secondary = async () => {
    const client = createClient(URL_BASE, "synthetic-public-only", { auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
      storage: w.authStorage.createAuthStorage(raw, emit) }, global: { fetch: fakeFetch } });
    w.clients.push(client); listen(client); await client.auth.initialize(); await tick(); return client;
  };
  w.offline = async () => {
    const start = w.diagnostics.length, result = await w.cloud.getOfflineUser();
    w.lastMissing = w.diagnostics.slice(start).includes("OFFLINE_CACHE_MISSING"); w.lastOfflineAccepted = Boolean(result); return result;
  };
  w.step = async operation => {
    let value = null, error = null;
    try { value = await operation(); error = value?.error ?? null; } catch (failure) { error = failure; }
    w.lastOutcome = { success: !error, returnedUser: value?.id === USER_A.id, missingUser: value === null && !error,
      transient: Boolean(error && w.auth.isRetryableAuthError(error)), invalid: error?.kind === "invalid", changed: error?.kind === "changed",
      storageError: error?.name === "AuthStorageError", refreshDiscarded: error?.name === "AuthRefreshDiscardedError" };
    return w.lastOutcome;
  };
  w.waitFor = async condition => { for (let i = 0; i < 300 && !condition(); i++) await tick(); assert.ok(condition()); };
  w.gate = () => { const gate = deferred(); w.gates.push(gate); return gate; };
  w.track = promise => { w.pending.push(promise); return promise; };
  w.reads = w.writes = w.removes = w.signedOut = w.refreshed = 0; w.diagnostics.length = 0;
  w.observe = () => {
    let stored = null; try { stored = JSON.parse(w.values.get(STORAGE_KEY) ?? "null"); } catch {}
    return { rawCachePresent: Boolean(w.values.get(STORAGE_KEY)), cacheIsOriginal: stored?.refresh_token === w.original.refresh_token,
      cacheIsOtherOwner: stored?.user?.id === USER_B.id, cacheIsRotated: Boolean(w.rotated && stored?.refresh_token === w.rotated.refresh_token),
      offlineCacheMissing: w.lastMissing, offlineProofAccepted: w.lastOfflineAccepted, reads: w.reads, writes: w.writes, removes: w.removes,
      signedOut: w.signedOut, tokenRefreshed: w.refreshed, refreshRequests: w.refreshRequests, userRequests: w.userRequests,
      signInRequests: w.signInRequests, signOutRequests: w.signOutRequests, receiptWrites: w.receiptWrites,
      outcome: w.lastOutcome, diagnostics: [...new Set(w.diagnostics)] };
  };
  w.close = async () => { for (const gate of w.gates) gate.resolve(); await Promise.allSettled(w.pending); for (const client of w.clients) await client.auth.dispose(); };
  return w;
}

async function runReview() {
  const originalNow = Date.now, originalFetch = globalThis.fetch, savedError = console.error, savedWarn = console.warn;
  const sdkOutput = [], cases = [], privateValues = new Set([STORAGE_KEY, USER_A.email, USER_B.email, "SYNTH_PRIVATE_VENDOR_DETAIL"]);
  let unmockedFetchAttempts = 0;
  globalThis.fetch = async () => { unmockedFetchAttempts++; throw new Error("External network disabled"); };
  console.error = console.warn = (...values) => { sdkOutput.push(...values); };
  const run = async (scenario, action) => {
    let w, pass = false;
    try { w = await createWorld(originalNow(), privateValues); await action(w); pass = true; }
    catch { /* Preserve failed assertions; report only the fixed failure enum. */ }
    finally {
      if (w) { await w.close(); cases.push({ scenario, pass, ...w.observe(), assertions: pass ? ["SYNTH_ASSERTIONS_PASSED"] : ["SYNTH_ASSERTION_FAILED"] }); }
      else cases.push({ scenario, pass: false, assertions: ["SYNTH_HARNESS_FAILURE"] });
      Date.now = originalNow;
    }
  };
  try {
    await run("SYNTH_CONTROL_VERIFIED", async w => {
      assert.ok(await w.offline()); assert.equal((await w.step(() => w.cloud.getCurrentUser())).returnedUser, true);
      assert.equal(w.removes, 0); assert.equal(w.writes, 0); assert.equal(w.receiptWrites, 1);
    });
    for (const status of ["400", "401"]) await run("SYNTH_REFRESH_" + status + "_EXPIRED", async w => {
      w.now = w.original.expires_at * 1000 + 1000; w.refreshMode = status;
      assert.ok(await w.offline()); assert.equal((await w.step(() => w.cloud.getCurrentUser())).invalid, true);
      assert.equal(w.removes, 1); assert.equal(w.signedOut, 1); assert.equal(w.receiptWrites, 0);
      assert.equal(await w.offline(), null); assert.equal(w.lastMissing, true); assert.ok(w.diagnostics.includes("ONLINE_REJECTED"));
    });
    for (const mode of ["NETWORK", "503"]) await run("SYNTH_REFRESH_" + mode + "_EXPIRED", async w => {
      w.now = w.original.expires_at * 1000 + 1000; w.refreshMode = mode;
      assert.equal((await w.step(() => w.cloud.getCurrentUser())).transient, true);
      assert.equal(w.removes, 0); assert.equal(w.signedOut, 0); assert.equal(w.refreshRequests, 1);
      assert.ok(await w.offline()); assert.equal(w.lastMissing, false); assert.ok(w.diagnostics.includes("ONLINE_NETWORK_FAILURE"));
    });
    await run("SYNTH_REFRESH_PROACTIVE_REJECTION_COOLDOWN", async w => {
      w.now = w.original.expires_at * 1000 - 30000; w.refreshMode = "400";
      assert.equal((await w.step(() => w.cloud.getCurrentUser())).returnedUser, true);
      assert.equal(w.refreshRequests, 1); assert.equal(w.removes, 0);
      w.now = w.original.expires_at * 1000 + 1000;
      assert.equal((await w.step(() => w.cloud.getCurrentUser())).invalid, true);
      assert.equal(w.refreshRequests, 1); assert.equal(w.removes, 0);
      w.now += 61000;
      assert.equal((await w.step(() => w.cloud.getCurrentUser())).invalid, true);
      assert.equal(w.refreshRequests, 2); assert.equal(w.removes, 1); await w.offline(); assert.equal(w.lastMissing, true);
    });
    await run("SYNTH_USER_SESSION_NOT_FOUND", async w => {
      w.userMode = "SESSION_NOT_FOUND"; assert.equal((await w.step(() => w.cloud.getCurrentUser())).invalid, true);
      assert.equal(w.removes, 1); assert.equal(w.signedOut, 1); await w.offline(); assert.equal(w.lastMissing, true);
      assert.ok(w.diagnostics.includes("ONLINE_REJECTED"));
    });
    await run("SYNTH_USER_401_BAD_JWT", async w => {
      w.userMode = "401"; assert.equal((await w.step(() => w.cloud.getCurrentUser())).invalid, true);
      assert.equal(w.removes, 0); assert.equal(w.signedOut, 0); assert.ok(await w.offline()); assert.equal(w.lastMissing, false);
      assert.ok(w.diagnostics.includes("ONLINE_REJECTED"));
    });
    await run("SYNTH_CACHE_INVALID_JSON", async w => {
      w.values.set(STORAGE_KEY, "{synthetic-invalid"); assert.equal(await w.offline(), null);
      assert.ok(w.diagnostics.includes("OFFLINE_CACHE_INVALID"));
      assert.equal((await w.step(() => w.cloud.getCurrentUser())).missingUser, true);
      assert.equal(w.removes, 0); await w.offline(); assert.equal(w.lastMissing, false);
    });
    await run("SYNTH_CACHE_MISSING_EXPIRES_AT", async w => {
      const invalid = { ...w.original }; delete invalid.expires_at; w.values.set(STORAGE_KEY, JSON.stringify(invalid));
      assert.ok(await w.offline()); assert.equal((await w.step(() => w.cloud.getCurrentUser())).missingUser, true);
      assert.equal(w.removes, 1); assert.equal(w.signedOut, 1); await w.offline(); assert.equal(w.lastMissing, true);
    });
    await run("SYNTH_CACHE_EMPTY_PASSIVE_ADAPTER", async w => {
      w.values.delete(STORAGE_KEY); assert.equal(await w.offline(), null);
      assert.equal((await w.step(() => w.cloud.getCurrentUser())).missingUser, true);
      assert.equal(w.lastMissing, true); assert.equal(w.writes, 0); assert.equal(w.removes, 0); assert.equal(w.signedOut, 0);
    });
    await run("SYNTH_READ_NULL_WITH_VALUE_PRESENT", async w => {
      w.readMode = "NULL"; assert.equal(await w.offline(), null); assert.equal(w.lastMissing, true);
      assert.equal((await w.step(() => w.cloud.getCurrentUser())).missingUser, true);
      assert.equal(w.values.has(STORAGE_KEY), true); assert.equal(w.removes, 0); assert.equal(w.writes, 0);
      w.readMode = "NORMAL"; assert.ok(await w.offline());
    });
    await run("SYNTH_ADAPTER_READ_EXCEPTION", async w => {
      w.readMode = "THROW"; assert.equal(await w.offline(), null);
      assert.equal((await w.step(() => w.cloud.getCurrentUser())).storageError, true);
      assert.ok(w.diagnostics.includes("AUTH_STORAGE_READ_FAILED")); assert.ok(w.diagnostics.includes("OFFLINE_STORAGE_UNAVAILABLE"));
      assert.equal(w.removes, 0); assert.equal(w.values.has(STORAGE_KEY), true);
      w.readMode = "NORMAL"; assert.ok(await w.offline()); assert.equal(w.lastMissing, false);
    });
    await run("SYNTH_ROTATION_DURING_GET_USER", async w => {
      w.userGate = w.gate(); const pending = w.track(w.step(() => w.cloud.getCurrentUser())); await w.waitFor(() => w.userRequests === 1);
      assert.equal((await w.client.auth.refreshSession()).error, null); w.userGate.resolve();
      assert.equal((await pending).changed, true); assert.equal(w.removes, 0); assert.equal(w.refreshed, 1);
      assert.equal(await w.offline(), null); assert.equal(w.lastMissing, false); assert.ok(w.diagnostics.includes("ONLINE_SESSION_CHANGED"));
      assert.ok(w.diagnostics.includes("OFFLINE_BINDING_MISMATCH"));
    });
    await run("SYNTH_ROTATION_WRITE_EXCEPTION", async w => {
      w.now = w.original.expires_at * 1000 + 1000; w.writeMode = "THROW";
      assert.equal((await w.step(() => w.cloud.getCurrentUser())).storageError, true);
      assert.equal(w.removes, 0); assert.equal(w.refreshed, 0); assert.equal(w.observe().cacheIsOriginal, true);
      assert.ok(w.diagnostics.includes("AUTH_STORAGE_WRITE_FAILED")); assert.ok(await w.offline()); assert.equal(w.lastMissing, false);
    });
    await run("SYNTH_ROTATION_READBACK_REPLACED", async w => {
      w.writeMode = "CONCURRENT_REPLACE";
      assert.equal((await w.step(() => w.client.auth.refreshSession())).storageError, true);
      assert.equal(w.observe().cacheIsOtherOwner, true); assert.equal(w.removes, 0); assert.equal(w.refreshed, 0);
      assert.ok(w.diagnostics.includes("AUTH_STORAGE_WRITE_UNCONFIRMED")); await w.offline(); assert.equal(w.lastMissing, false);
    });
    await run("SYNTH_REFRESH_VS_EXPLICIT_SIGN_OUT", async w => {
      const otherClient = await w.secondary(); w.refreshGate = w.gate();
      const pending = w.track(w.step(() => w.client.auth.refreshSession())); await w.waitFor(() => w.refreshRequests === 1);
      assert.equal((await otherClient.auth.signOut({ scope: "local" })).error, null);
      w.refreshGate.resolve(); assert.equal((await pending).refreshDiscarded, true);
      assert.equal(w.removes, 1); assert.equal(w.writes, 0); assert.equal(w.refreshed, 0); await w.offline(); assert.equal(w.lastMissing, true);
    });
    await run("SYNTH_REFRESH_VS_OTHER_SIGN_IN", async w => {
      const otherClient = await w.secondary(); w.refreshGate = w.gate();
      const pending = w.track(w.step(() => w.client.auth.refreshSession())); await w.waitFor(() => w.refreshRequests === 1);
      assert.equal((await otherClient.auth.signInWithPassword({ email: USER_B.email, password: "synthetic-password" })).error, null);
      w.refreshGate.resolve(); assert.equal((await pending).refreshDiscarded, true);
      assert.equal(w.observe().cacheIsOtherOwner, true); assert.equal(w.removes, 0); assert.equal(w.refreshed, 0);
      await w.offline(); assert.equal(w.lastMissing, false);
    });
    let outputSafe = true;
    for (const value of sdkOutput) {
      const text = value instanceof Error ? JSON.stringify(value, Object.getOwnPropertyNames(value)) : JSON.stringify(value) ?? "";
      if ([...privateValues].some(privateValue => text.includes(privateValue))) outputSafe = false;
    }
    return { installedSdkVersionExpected: require("@supabase/auth-js/package.json").version === "2.114.0",
      cases, caseCount: cases.length, passed: cases.filter(item => item.pass).length, failed: cases.filter(item => !item.pass).length,
      sdkOutputSafe: outputSafe, unmockedFetchAttempts, realFinancialDataAccessed: false, productionProfileAccessed: false, realRootCauseProven: false };
  } finally { Date.now = originalNow; globalThis.fetch = originalFetch; console.error = savedError; console.warn = savedWarn; }
}
module.exports = { runReview };
if (require.main === module) runReview().then(result => {
  console.log("AUTH_SESSION_ADVERSARIAL_RESULT " + JSON.stringify(result));
  if (result.failed || !result.sdkOutputSafe || result.unmockedFetchAttempts) process.exitCode = 1;
}).catch(() => { console.error("AUTH_SESSION_ADVERSARIAL_RESULT " + JSON.stringify({ failed: 1, diagnostics: ["SYNTH_HARNESS_FAILURE"], realRootCauseProven: false })); process.exitCode = 1; });
