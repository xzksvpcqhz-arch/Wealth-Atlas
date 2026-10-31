/* Real installed SDK, synthetic HTTP replies and browser storage only. Never
 * opens an app, profile or financial database; no credentials leave memory. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createClient } = require("@supabase/supabase-js");
const codes = require("../../desktop/auth-diagnostic-codes.json");
const url = "https://synthetic-storage.invalid", key = "sb-synthetic-storage-auth-token";
const privateMarker = "SYNTHETIC_VENDOR_PRIVATE_DETAIL";

async function runReview() {
  const names = ["window", "document", "localStorage", "BroadcastChannel", "fetch"];
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const savedError = console.error, savedWarn = console.warn, sdkOutput = [], clients = [];
  let unmockedFetchAttempts = 0;
  const user = { id: "77777777-7777-4777-8777-777777777777", email: "synthetic-storage@example.invalid",
    aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const session = { access_token: encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ sub: user.id, exp: now + 3600, iat: now }) + ".synthetic-signature",
    refresh_token: "synthetic-refresh-for-storage", token_type: "bearer", expires_in: 3600, user };
  const serialize = value => value instanceof Error ? JSON.stringify(value, Object.getOwnPropertyNames(value)) : JSON.stringify(value);
  const assertSafe = error => {
    assert.equal(error.name, "AuthStorageError");
    assert.equal(Object.hasOwn(codes, error.code), true);
    const text = serialize(error);
    for (const forbidden of [privateMarker, key, user.email, session.access_token, session.refresh_token]) assert.equal(text.includes(forbidden), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
  };
  function load(file, window, diagnostics, captured) {
    const mod = { exports: {} };
    const source = readFileSync(path.resolve(__dirname, "../..", file), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", "window", "process", compiled)(name => {
      if (name === "./auth-storage") return load("lib/auth-storage.ts", window, diagnostics, captured);
      if (name === "./auth-diagnostics") return { reportAuthDiagnostic: code => { assert.equal(Object.hasOwn(codes, code), true); diagnostics.push(code); } };
      if (name === "./password-recovery") return { capturePasswordRecoveryIntent() {}, observePasswordRecovery() {} };
      if (name === "@supabase/supabase-js") return { createClient(address, publicKey, options) {
        captured.storage = options.auth.storage;
        assert.ok(captured.storage, "Production client must supply explicit storage, not SDK memory fallback");
        const client = createClient(address, publicKey, { ...options,
          auth: { ...options.auth, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fakeFetch } });
        clients.push(client); return client;
      } };
      throw new Error("Unexpected synthetic module");
    }, mod, mod.exports, window, { env: { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-only" } });
    return mod.exports;
  }
  async function fakeFetch(input) {
    const address = new URL(typeof input === "string" ? input : input.url);
    assert.equal(address.origin, url);
    const body = address.pathname === "/auth/v1/token" ? session : address.pathname === "/auth/v1/user" ? user : null;
    assert.ok(body, "Only synthetic auth endpoints are permitted");
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  function world(mode = "ok") {
    const values = new Map(), diagnostics = [], captured = {}, events = [];
    const state = { mode, afterWrite: false, probes: 0, removals: 0 };
    const storage = {
      getItem(name) { if (state.mode === "throw-readback" && state.afterWrite) throw new Error(privateMarker + name); return values.get(name) ?? null; },
      setItem(name, value) {
        if (name.startsWith("lswt-")) { state.probes++; throw new Error(privateMarker + name); }
        if (state.mode === "throw-write") throw new Error(privateMarker + name + value);
        if (state.mode !== "drop-write") values.set(name, value);
        state.afterWrite = true;
      },
      removeItem(name) { state.removals++; values.delete(name); },
    };
    const window = new EventTarget(); window.location = { href: url + "/", hash: "", search: "" }; window.localStorage = storage;
    const document = new EventTarget(); document.visibilityState = "hidden";
    Object.assign(globalThis, { window, document, localStorage: storage });
    const app = () => {
      const client = load("lib/supabase-client.ts", window, diagnostics, captured).getSupabaseClient();
      client.auth.onAuthStateChange(event => { events.push(event); });
      return client;
    };
    return { values, diagnostics, captured, events, state, storage, window, app };
  }
  const login = client => client.auth.signInWithPassword({ email: user.email, password: "synthetic-password" });
  try {
    console.error = (...args) => { sdkOutput.push(...args); };
    console.warn = (...args) => {
      // Sequential synthetic "restarts" share one module's instance counter.
      // A real fresh process would not emit this unrelated duplicate warning.
      if (args.length === 1 && typeof args[0] === "string" && args[0].includes("Multiple GoTrueClient instances detected")) return;
      sdkOutput.push(...args);
    };
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, writable: true, value: undefined });
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async () => { unmockedFetchAttempts++; throw new Error("Real network disabled"); } });

    const old = world();
    const oldClient = createClient(url, "synthetic-public-only", { auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fakeFetch } });
    clients.push(oldClient);
    await oldClient.auth.initialize();
    assert.equal((await login(oldClient)).error, null);
    assert.equal((await oldClient.auth.getUser()).data.user?.id, user.id);
    assert.equal((await oldClient.auth.getSession()).data.session?.user.id, user.id);
    assert.equal(old.values.has(key), false, "Old SDK default can succeed in memory after a failed write probe");
    assert.equal(old.state.probes, 1); assert.equal(old.state.removals, 0);
    await oldClient.auth.dispose();

    const checks = [];
    for (const fault of ["ok", "throw-write", "drop-write", "throw-readback"]) {
      const fresh = world(fault), client = fresh.app();
      await client.auth.initialize();
      assert.equal(client.auth.storage, fresh.captured.storage);
      assert.equal(fresh.state.probes, 0, "Explicit storage bypasses the cached failed SDK probe");
      if (fault !== "ok") {
        let failure;
        try { await login(client); } catch (error) { failure = error; }
        assert.ok(failure, "Unconfirmed SDK persistence must never report successful login");
        assertSafe(failure);
        assert.equal(fresh.events.includes("SIGNED_IN"), false);
        assert.equal(fresh.diagnostics.includes(fault === "drop-write" ? "AUTH_STORAGE_WRITE_UNCONFIRMED" : "AUTH_STORAGE_WRITE_FAILED"), true);
        assert.equal(fresh.state.removals, 0, "Failure cannot roll back or remove a possibly concurrent session");
        fresh.state.mode = "ok"; fresh.state.afterWrite = false;
      }
      assert.equal((await login(client)).error, null, "Explicit retry after recovery persists normally");
      assert.equal((await client.auth.getUser()).data.user?.id, user.id);
      assert.deepEqual([...fresh.values.keys()], [key], "Only the unchanged SDK key is used; no second token store");
      assert.equal(fresh.events.includes("SIGNED_IN"), true);
      await client.auth.dispose();
      const restarted = fresh.app();
      assert.equal((await restarted.auth.getSession()).data.session?.user.id, user.id, "New SDK instance reads the same confirmed browser value");
      assert.equal((await restarted.auth.getUser()).data.user?.id, user.id);
      await restarted.auth.dispose();
      checks.push({ fault, pass: true, retryPersisted: true, freshInstanceReadSucceeded: true });
    }
    for (const value of sdkOutput) {
      const text = serialize(value) ?? "";
      for (const forbidden of [privateMarker, key, user.email, session.access_token, session.refresh_token]) assert.equal(text.includes(forbidden), false);
    }
    assert.equal(unmockedFetchAttempts, 0);
    return { method: "actual-installed-SDK-and-production-client-with-synthetic-storage-and-HTTP",
      oldDefaultProbeFailureReproduced: true, oldOnlineSuccessWasNotPersistent: true, explicitStorageNeverFellBack: true,
      checks, errorsAndDiagnosticsSafe: true, originalSdkKeyOnly: true, unmockedFetchAttempts, realFinancialDataAccessed: false, productionProfileAccessed: false };
  } finally {
    for (const client of clients) await client.auth.dispose();
    console.error = savedError; console.warn = savedWarn;
    for (const [name, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
}
module.exports = { runReview };
if (require.main === module) runReview().then(result => console.log("AUTH_STORAGE_SDK_RESULT " + JSON.stringify(result)))
  .catch(error => { console.error("AUTH_STORAGE_SDK_INCONCLUSIVE " + JSON.stringify({ name: error?.name ?? "Error", code: error?.code ?? null,
    fixtureLine: error?.stack?.split("\n").find(line => line.includes(__filename + ":"))?.match(/:(\d+):\d+/)?.[1] ?? null })); process.exitCode = 1; });
