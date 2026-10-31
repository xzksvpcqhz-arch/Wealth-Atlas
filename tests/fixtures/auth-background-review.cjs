/* Installed SDK lifecycle, not a mock of its refresh implementation. Each case
 * gets a fresh VM, synthetic browser, virtual timers, memory adapter and HTTP.
 * No app/profile/DB/env access, native HTTP, private SDK method calls or writes. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const tslib = require("tslib");
const ROOT = path.resolve(__dirname, "../..");
const SDK_ENTRY = require.resolve("@supabase/auth-js");
const SDK_ROOT = path.dirname(SDK_ENTRY);
const BASE = "https://synthetic-background.invalid";
const KEY = "sb-synthetic-background-auth-token";
const BASE_TIME = Date.UTC(2026, 9, 30);
const USER = { id: "77777777-7777-4777-8777-777777777777", email: "synthetic-background@example.invalid",
  aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
function must(condition, code) {
  if (!condition) throw Object.assign(new Error("Synthetic assertion failed"), { reviewCode: code });
}
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }

function makeClock() {
  const timers = new Map(), pending = new Set(), errors = [];
  let now = BASE_TIME, serial = 0;
  const track = value => {
    if (!value || typeof value.then !== "function") return;
    const promise = Promise.resolve(value); pending.add(promise);
    promise.then(() => pending.delete(promise), error => { errors.push(error); pending.delete(promise); });
  };
  const schedule = (fn, delay, interval, args) => {
    const id = ++serial; timers.set(id, { fn, at: now + Math.max(0, Number(delay) || 0), interval, args }); return id;
  };
  return {
    get now() { return now; }, pending, errors,
    setTimeout: (fn, delay, ...args) => schedule(fn, delay, 0, args),
    setInterval: (fn, delay, ...args) => schedule(fn, delay, Math.max(1, Number(delay) || 1), args),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id), track,
    get intervalCount() { return [...timers.values()].filter(timer => timer.interval).length; },
    get timerCount() { return timers.size; },
    jump(target) { must(target >= now, "SYNTH_CLOCK_MONOTONIC"); now = target; },
    async until(predicate) {
      for (let i = 0; i < 20 && !predicate(); i++) await flush();
      must(predicate(), "SYNTH_MICROTASK_BOUND_REACHED");
    },
    async advance(duration) {
      const target = now + duration;
      await flush();
      for (let steps = 0; ; steps++) {
        must(steps < 200, "SYNTH_TIMER_BOUND_REACHED");
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next; now = Math.max(now, timer.at);
        if (timer.interval) timer.at = now + timer.interval; else timers.delete(id);
        try { track(timer.fn(...timer.args)); } catch (error) { errors.push(error); }
        await flush();
      }
      now = Math.max(now, target); await flush();
    },
  };
}

function makeWorld(adapterSource, codes, { expired = false, hidden = false } = {}) {
  const clock = makeClock(), listeners = new Map(), modules = new Map(), logs = [];
  const w = { clock, records: [], events: [], requests: 0, writes: 0, removes: 0, reads: 0,
    starts: 0, stops: 0, visibilityChanges: 0, networkChanges: 0, mode: "NETWORK",
    unmockedFetchAttempts: 0, forbiddenImports: 0, initDone: false, initError: false, rotated: null };
  let release;
  const responseGate = new Promise(resolve => { release = resolve; });
  w.release = release;
  const session = label => {
    const seconds = Math.floor(clock.now / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    return { access_token: encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ sub: USER.id, exp: seconds + 3600, iat: seconds }) + ".synthetic-signature",
      refresh_token: "synthetic-background-" + label, expires_at: seconds + 3600, expires_in: 3600, token_type: "bearer", user: USER };
  };
  w.original = session("original");
  if (expired) w.original.expires_at = Math.floor(clock.now / 1000) - 1;
  w.originalRaw = JSON.stringify(w.original);
  const values = new Map([[KEY, w.originalRaw]]);
  w.values = values;
  const raw = {
    getItem(key) { if (key === KEY) w.reads++; return values.get(key) ?? null; },
    setItem(key, value) { if (key === KEY) w.writes++; values.set(key, value); },
    removeItem(key) { if (key === KEY) w.removes++; values.delete(key); },
  };
  const emit = code => { must(Object.hasOwn(codes, code), "SYNTH_UNKNOWN_PRODUCT_ENUM"); w.records.push(code); };
  const document = { visibilityState: hidden ? "hidden" : "visible" };
  const navigator = { onLine: true, userAgent: "Synthetic background review" };
  const window = { localStorage: raw, location: { href: BASE + "/", hash: "", search: "" },
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  };
  const dispatch = name => { for (const fn of [...(listeners.get(name) ?? [])]) clock.track(fn({ type: name })); };
  w.visibility = async state => { document.visibilityState = state; w.visibilityChanges++; dispatch("visibilitychange"); await flush(); };
  w.online = async state => { navigator.onLine = state; w.networkChanges++; dispatch(state ? "online" : "offline"); await flush(); };
  w.listenerCount = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  class VirtualDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const silent = (...args) => logs.push(args);
  const sandbox = vm.createContext({ window, document, navigator, Date: VirtualDate, URL, URLSearchParams,
    TextEncoder, TextDecoder, atob, btoa, structuredClone,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    console: { log: silent, warn: silent, error: silent, debug: silent, info: silent },
    fetch() { w.unmockedFetchAttempts++; throw new Error("SYNTH_NATIVE_FETCH_FORBIDDEN"); },
  });
  function load(file) {
    must(file.startsWith(SDK_ROOT + path.sep) && file.endsWith(".js"), "SYNTH_SDK_SOURCE_BOUNDARY");
    if (modules.has(file)) return modules.get(file).exports;
    const mod = { exports: {} }; modules.set(file, mod);
    const source = readFileSync(file, "utf8");
    const wrapper = new vm.Script("(function(require,module,exports){\n" + source + "\n})", { filename: "synthetic-installed-sdk.cjs" }).runInContext(sandbox, { timeout: 1000 });
    wrapper(name => {
      if (name === "tslib") return tslib;
      if (!name.startsWith(".")) { w.forbiddenImports++; throw new Error("SYNTH_IMPORT_FORBIDDEN"); }
      return load(path.resolve(path.dirname(file), name + (name.endsWith(".js") ? "" : ".js")));
    }, mod, mod.exports);
    return mod.exports;
  }
  const adapterModule = { exports: {} };
  new vm.Script("(function(module,exports){\n" + adapterSource + "\n})", { filename: "synthetic-source-adapter.cjs" })
    .runInContext(sandbox, { timeout: 1000 })(adapterModule, adapterModule.exports);
  w.adapter = adapterModule.exports.createAuthStorage(raw, emit);
  w.preflight = () => adapterModule.exports.readStoredAuthSession(BASE, raw, reason => emit({
    "cache-missing": "OFFLINE_CACHE_MISSING", "cache-invalid": "OFFLINE_CACHE_INVALID",
    "storage-unavailable": "OFFLINE_STORAGE_UNAVAILABLE", "config-missing": "OFFLINE_CONFIG_MISSING",
  }[reason]));
  const { AuthClient } = load(SDK_ENTRY);
  const reply = (body, status) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "X-Supabase-Api-Version": "2024-01-01" },
  });
  const fakeFetch = async (input, init = {}) => {
    const address = new URL(typeof input === "string" ? input : input.url);
    must(address.origin === BASE && address.pathname === "/auth/v1/token"
      && address.searchParams.get("grant_type") === "refresh_token" && init.method === "POST", "SYNTH_UNEXPECTED_HTTP");
    w.requests++;
    await responseGate;
    if (w.mode === "NETWORK") throw new TypeError("SYNTH_NETWORK_UNAVAILABLE");
    if (w.mode === "503") return reply({ code: "unexpected_failure", msg: "SYNTH_INFRASTRUCTURE_FAILURE" }, 503);
    if (w.mode === "400" || w.mode === "401") return reply({ code: "refresh_token_not_found", msg: "SYNTH_REFRESH_REJECTED" }, Number(w.mode));
    must(w.mode === "SUCCESS", "SYNTH_UNKNOWN_RESPONSE_MODE");
    w.rotated = session("rotated"); return reply(w.rotated, 200);
  };
  w.construct = () => {
    must(!w.client, "SYNTH_ONE_CLIENT_PER_REALM");
    w.client = new AuthClient({ url: BASE + "/auth/v1", storageKey: KEY, storage: w.adapter,
      persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, fetch: fakeFetch, debug: false });
    w.subscription = w.client.onAuthStateChange(event => {
      must(["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "TOKEN_REFRESHED"].includes(event), "SYNTH_UNEXPECTED_AUTH_EVENT");
      w.events.push(event);
    }).data.subscription;
    clock.track(w.client.initialize().then(result => { w.initDone = true; w.initError = Boolean(result.error); }));
  };
  w.boot = async () => {
    w.construct(); await clock.until(() => w.initDone); must(!w.initError, "SYNTH_INIT_ERROR");
    await clock.advance(0); must(w.requests === 0, "SYNTH_NO_EARLY_REFRESH");
  };
  w.start = async () => { w.starts++; await w.client.startAutoRefresh(); await flush(); };
  w.stop = async () => { w.stops++; await w.client.stopAutoRefresh(); await flush(); };
  w.signedOut = () => w.events.filter(event => event === "SIGNED_OUT").length;
  w.refreshed = () => w.events.filter(event => event === "TOKEN_REFRESHED").length;
  w.unchanged = code => must(values.get(KEY) === w.originalRaw && w.removes === 0 && w.writes === 0 && w.signedOut() === 0, code);
  w.prepare = async lifecycle => {
    if (lifecycle === "MANUAL") await w.stop(); else await w.visibility("hidden");
    must(clock.timerCount === 0, "SYNTH_STOP_CLEARS_SCHEDULED_TICKS");
    clock.jump(w.original.expires_at * 1000 + 1);
    if (lifecycle === "MANUAL") await w.start(); else await w.visibility("visible");
    await clock.advance(0); await clock.until(() => w.requests === 1);
    w.unchanged("SYNTH_PENDING_REQUEST_NO_MUTATION");
  };
  w.complete = async () => { release(); await flush(); await clock.advance(30000); await clock.until(() => clock.pending.size === 0); };
  w.consoleSafe = () => {
    const forbidden = [KEY, USER.email, w.original.access_token, w.original.refresh_token,
      ...(w.rotated ? [w.rotated.access_token, w.rotated.refresh_token] : [])];
    const text = logs.map(args => args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg, Object.getOwnPropertyNames(arg ?? {}))).join(" ")).join("\n");
    return forbidden.every(value => !text.includes(value));
  };
  w.cleanup = async () => {
    if (w.client) await w.client.dispose();
    release(); await flush(); await clock.advance(30000);
    must(clock.pending.size === 0 && clock.errors.length === 0 && clock.timerCount === 0 && w.listenerCount() === 0, "SYNTH_CLEANUP_DRAINS_PENDING_WORK");
    must(w.unmockedFetchAttempts === 0 && w.forbiddenImports === 0 && w.consoleSafe(), "SYNTH_ISOLATION_OR_PRIVATE_OUTPUT");
  };
  return w;
}

async function runReview() {
  const cases = [];
  const codes = JSON.parse(readFileSync(path.join(ROOT, "desktop/auth-diagnostic-codes.json"), "utf8"));
  const installed = JSON.parse(readFileSync(path.join(ROOT, "node_modules/@supabase/auth-js/package.json"), "utf8"));
  must(installed.version === "2.114.0", "SYNTH_INSTALLED_VERSION_CHANGED");
  const adapterSource = ts.transpileModule(readFileSync(path.join(ROOT, "lib/auth-storage.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const add = async (scenario, check, options) => {
    let w, failureCode = null;
    try { w = makeWorld(adapterSource, codes, options); if (!options?.expired) await w.boot(); await check(w); }
    catch (error) { failureCode = /^SYNTH_[A-Z0-9_]+$/.test(error?.reviewCode ?? "") ? error.reviewCode : "SYNTH_ASSERTION_FAILED"; }
    finally {
      if (w) try { await w.cleanup(); } catch { failureCode ??= "SYNTH_CLEANUP_FAILED"; }
    }
    cases.push({ scenario, passed: failureCode === null, failureCode, refreshRequests: w?.requests ?? 0,
      cacheWrites: w?.writes ?? 0, cacheRemoves: w?.removes ?? 0, signedOutEvents: w?.signedOut() ?? 0,
      tokenRefreshedEvents: w?.refreshed() ?? 0, publicStarts: w?.starts ?? 0, publicStops: w?.stops ?? 0,
      visibilityChanges: w?.visibilityChanges ?? 0, networkChanges: w?.networkChanges ?? 0,
      unmockedFetchAttempts: w?.unmockedFetchAttempts ?? 0 });
  };

  await add("SYNTH_PUBLIC_START_STOP_RESTART", async w => {
    must(w.clock.intervalCount === 1 && w.listenerCount() === 1, "SYNTH_AUTOMATIC_BROWSER_LIFECYCLE_ATTACHED");
    await w.stop(); must(w.clock.timerCount === 0 && w.listenerCount() === 0, "SYNTH_PUBLIC_STOP_CANCELS_AND_DETACHES");
    await w.start(); await w.start(); must(w.clock.intervalCount === 1, "SYNTH_PUBLIC_START_DOES_NOT_DUPLICATE_INTERVALS");
    await w.stop(); await w.clock.advance(60000);
    must(w.requests === 0, "SYNTH_CANCELLED_TICKS_DO_NOT_REQUEST"); w.unchanged("SYNTH_STOP_IS_NOT_SIGN_OUT");
    await w.start(); await w.client.dispose(); await w.clock.advance(60000);
    must(w.requests === 0 && w.clock.timerCount === 0, "SYNTH_DISPOSE_CANCELS_PENDING_INITIAL_TICK");
    w.unchanged("SYNTH_DISPOSE_IS_NOT_SIGN_OUT");
  });
  for (const lifecycle of ["MANUAL", "VISIBILITY"]) for (const mode of ["NETWORK", "503", "400", "401"]) {
    await add("SYNTH_" + lifecycle + "_PENDING_" + mode, async w => {
      w.mode = mode; await w.prepare(lifecycle);
      await w.online(false);
      if (lifecycle === "MANUAL") await w.stop(); else await w.visibility("hidden");
      must(w.clock.timerCount === 0, "SYNTH_HIDE_STOP_CLEARS_TICKS_NOT_REQUEST");
      w.unchanged("SYNTH_HIDE_STOP_OFFLINE_NOT_SIGN_OUT");
      await w.complete();
      if (mode === "NETWORK" || mode === "503") {
        must(w.requests === 8, "SYNTH_SDK_RETRIES_CONTINUE_AFTER_HIDE_STOP");
        w.unchanged("SYNTH_TRANSIENT_BACKGROUND_FAILURE_PRESERVES_CACHE");
        await w.online(true); must(w.requests === 8, "SYNTH_ONLINE_EVENT_ALONE_NOT_SDK_REFRESH_TRIGGER");
        if (lifecycle === "VISIBILITY") {
          await w.clock.advance(61000); w.mode = "SUCCESS";
          await w.visibility("visible"); await w.clock.until(() => w.refreshed() === 1);
          await w.visibility("hidden");
          must(w.writes === 1 && w.removes === 0 && w.signedOut() === 0, "SYNTH_VISIBLE_RESUMES_AFTER_COOLDOWN");
        }
      } else {
        must(w.requests === 1 && w.removes === 1 && !w.values.has(KEY) && w.signedOut() === 1, "SYNTH_EXPIRED_SERVER_REJECTION_REMOVES_AFTER_RESPONSE");
        must(w.preflight() === null && w.records.includes("OFFLINE_CACHE_MISSING"), "SYNTH_REJECTION_THEN_OFFLINE_CACHE_MISSING");
      }
    });
  }
  for (const mode of ["NETWORK", "SUCCESS", "400"]) await add("SYNTH_DISPOSE_PENDING_" + mode, async w => {
    w.mode = mode; await w.prepare("MANUAL");
    await w.client.dispose(); must(w.clock.timerCount === 0 && w.listenerCount() === 0, "SYNTH_DISPOSE_DETACHES_LIFECYCLE");
    w.unchanged("SYNTH_DISPOSE_PENDING_NOT_PROACTIVE_DELETE");
    await w.complete();
    must(w.signedOut() === 0 && w.refreshed() === 0, "SYNTH_DISPOSE_CLEARS_EVENT_SUBSCRIBERS");
    if (mode === "NETWORK") w.unchanged("SYNTH_DISPOSE_NETWORK_PRESERVES_CACHE");
    if (mode === "SUCCESS") must(w.writes === 1 && w.removes === 0 && w.values.get(KEY) !== w.originalRaw, "SYNTH_DISPOSE_DOES_NOT_ABORT_REFRESH_COMMIT");
    if (mode === "400") must(w.removes === 1 && !w.values.has(KEY), "SYNTH_DISPOSE_DOES_NOT_ABORT_REJECTION_CLEANUP");
  });
  await add("SYNTH_MANUAL_LIFECYCLE_OWNS_VISIBILITY", async w => {
    await w.stop(); w.clock.jump(w.original.expires_at * 1000 + 1); await w.start();
    must(w.listenerCount() === 0, "SYNTH_MANUAL_START_REMOVES_VISIBILITY_CALLBACK");
    await w.visibility("hidden"); await w.online(false);
    must(w.clock.intervalCount === 1, "SYNTH_MANUAL_START_NOT_STOPPED_BY_VISIBILITY_EVENT");
    await w.clock.advance(0); must(w.requests === 1, "SYNTH_SDK_TICK_DOES_NOT_GATE_ON_NAVIGATOR_ONLINE");
    await w.stop(); w.unchanged("SYNTH_MANUAL_OFFLINE_STOP_PRESERVES_PENDING_CACHE");
    await w.complete(); w.unchanged("SYNTH_MANUAL_OFFLINE_NETWORK_FAILURE_PRESERVES_CACHE");
  });
  await add("SYNTH_CACHE_READ_BEFORE_AUTOMATIC_INITIALIZATION", async w => {
    w.mode = "400";
    const cached = w.preflight();
    must(cached?.user.id === USER.id && !w.client && w.requests === 0, "SYNTH_READ_ONLY_PREFLIGHT_PRECEDES_SDK");
    w.unchanged("SYNTH_PREFLIGHT_DOES_NOT_MUTATE_OR_START_REFRESH");
    w.construct(); await w.clock.until(() => w.requests === 1);
    w.unchanged("SYNTH_AUTOMATIC_INIT_PENDING_NO_REMOVE");
    await w.complete();
    must(w.initDone && w.removes === 1, "SYNTH_AUTO_INIT_REJECTION_MUTATES_CACHE");
    must(w.preflight() === null && w.records.includes("OFFLINE_CACHE_MISSING"), "SYNTH_POST_INIT_READ_DIFFERS_FROM_PREFLIGHT");
    must(cached?.user.id === USER.id && !w.values.has(KEY) && w.writes === 0, "SYNTH_PREFLIGHT_COPY_NOT_RESTORED_OR_AUTHORIZATION");
  }, { expired: true, hidden: true });

  const passed = cases.filter(item => item.passed).length;
  return { installedVersionExpected: true, passed, failed: cases.length - passed, caseCount: cases.length,
    controlledTimers: true, privateSdkMethodsCalled: false, productionProfileAccessed: false,
    realFinancialDataAccessed: false, realNetworkUsed: false, realRootCauseProven: false, cases };
}

module.exports = { runReview };
if (require.main === module) runReview().then(result => {
  console.log("AUTH_BACKGROUND_REVIEW_RESULT " + JSON.stringify(result)); process.exitCode = result.failed ? 1 : 0;
}, () => {
  console.log('AUTH_BACKGROUND_REVIEW_RESULT {"passed":0,"failed":1,"caseCount":1,"failureCode":"SYNTH_HARNESS_FAILED","realRootCauseProven":false}');
  process.exitCode = 1;
});
