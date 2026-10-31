/* Independent, bounded synthetic contract review. No SDK, app, profile, env,
 * financial data, network, disk trace, or browser storage is opened. The only
 * source reads are the three reviewed modules and their fixed enum registry.
 * TS is transpiled in memory; all diagnostic/storage I/O is injected memory.
 * Output is fixed case enums, counts and booleans, never assertion payloads. */
"use strict";
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "../..");
const DIRECTORY = path.join(ROOT, "SYNTHETIC_MEMORY_ONLY");
const VERSION = "0.0.0-rc.11";
const TIME = Date.UTC(2026, 0, 1);
const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const A = "AUTH_RUNTIME_STARTED", B = "AUTH_STORAGE_WRITE_CONFIRMED";
const ACTIVITIES = ["AUTH_STORAGE_FIRST_READ_EMPTY", "AUTH_STORAGE_FIRST_READ_PRESENT",
  "AUTH_STORAGE_WRITE_CONFIRMED", "AUTH_STORAGE_REMOVE_REQUESTED", "AUTH_STORAGE_REMOVE_CONFIRMED"];
const SESSION_KEY = "sb-synthetic-auth-token";
const VALUE = "SYNTHETIC_MEMORY_VALUE_ONLY";
const PRIVATE = "SYNTHETIC_PRIVATE_ERROR_ONLY";
const LIMIT = 64 * 1024;

function runReview() {
  const results = [];
  let codes, createAuthTrace, storageModule;
  let mutedOutput = 0;
  const quietConsole = Object.freeze(Object.fromEntries(["log", "warn", "error", "info", "debug"]
    .map(name => [name, () => { mutedOutput++; }])));
  const check = (code, body) => {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/);
    try { body(); results.push({ check: code, passed: true }); }
    catch (error) {
      results.push({ check: code, passed: false,
        failure: error?.code === "ERR_ASSERTION" ? "ASSERTION_FAILED" : "EXECUTION_FAILED" });
    }
  };
  function transpile(file, window, imports = {}) {
    assert.ok(["lib/auth-storage.ts", "lib/auth-diagnostics.ts"].includes(file));
    const source = readFileSync(path.join(ROOT, file), "utf8");
    const output = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        esModuleInterop: true, resolveJsonModule: true } });
    assert.equal((output.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
    const sandbox = vm.createContext({ module: { exports: {} }, window, console: quietConsole,
      require(name) {
        if (Object.hasOwn(imports, name)) return imports[name];
        throw new Error("SYNTHETIC_IMPORT_DENIED");
      } }, { codeGeneration: { strings: false, wasm: false } });
    sandbox.exports = sandbox.module.exports;
    new vm.Script(output.outputText, { filename: file }).runInContext(sandbox, { timeout: 1000 });
    return sandbox.module.exports;
  }

  check("LOAD_ENUM_REGISTRY", () => {
    codes = JSON.parse(readFileSync(path.join(ROOT, "desktop/auth-diagnostic-codes.json"), "utf8"));
    for (const code of [A, B, ...ACTIVITIES, "AUTH_STORAGE_TRACE_LIMIT_REACHED"])
      assert.equal(Object.hasOwn(codes, code) && codes[code] === true, true);
  });
  check("LOAD_ACTUAL_TRACE", () => {
    ({ createAuthTrace } = require("../../desktop/auth-trace.cjs"));
    assert.equal(typeof createAuthTrace, "function");
  });
  check("LOAD_ACTUAL_STORAGE_IN_MEMORY", () => {
    storageModule = transpile("lib/auth-storage.ts", undefined);
    assert.equal(typeof storageModule.createAuthStorage, "function");
  });

  function traceWorld(initial) {
    const files = new Map(), calls = [];
    const manual = path.join(DIRECTORY, "candidate-auth-trace.json");
    const qa = path.join(DIRECTORY, "candidate-qa-auth-trace.json");
    if (arguments.length && initial !== null) files.set(manual, initial);
    const state = { time: TIME, readFault: false, writeFault: false, dropWrite: false,
      readbackFault: false, mismatch: false, lastWrite: false };
    function read(file) {
      calls.push({ op: "READ", file });
      assert.ok(file === manual || file === qa);
      if (state.readFault || (state.readbackFault && state.lastWrite)) throw new Error(PRIVATE);
      if (state.mismatch && state.lastWrite) return "SYNTHETIC_READBACK_MISMATCH";
      state.lastWrite = false;
      return files.has(file) ? files.get(file) : null;
    }
    function write(file, text, encoding) {
      calls.push({ op: "WRITE", file, text, encoding });
      assert.ok(file === manual || file === qa);
      assert.equal(encoding, "utf8");
      assert.equal(typeof text, "string");
      if (state.writeFault) throw new Error(PRIVATE);
      if (!state.dropWrite) files.set(file, text);
      state.lastWrite = true;
    }
    function create(overrides = {}) {
      const record = createAuthTrace({ version: VERSION, directory: DIRECTORY, bootId: IDS[0],
        now: () => state.time, read, write, ...overrides });
      assert.equal(typeof record, "function");
      return record;
    }
    return { files, calls, state, manual, qa, read, write, create,
      report(file = manual) { return JSON.parse(files.get(file)); },
      writes() { return calls.filter(call => call.op === "WRITE"); } };
  }
  function validateReport(report) {
    assert.deepEqual(Object.keys(report).sort(), ["boots", "format", "formatVersion"]);
    assert.equal(report.format, "wealth-atlas-auth-trace");
    assert.equal(report.formatVersion, 1);
    assert.ok(report.boots.length >= 1 && report.boots.length <= 2);
    assert.equal(new Set(report.boots.map(boot => boot.bootId)).size, report.boots.length);
    for (const boot of report.boots) {
      assert.deepEqual(Object.keys(boot).sort(), ["appVersion", "bootId", "events", "mode", "omitted", "startedAt"]);
      assert.match(boot.bootId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      assert.match(boot.appVersion, /^\d+\.\d+\.\d+-rc\.\d+$/);
      assert.ok(["manual-candidate", "isolated-qa"].includes(boot.mode));
      assert.equal(new Date(boot.startedAt).toISOString(), boot.startedAt);
      assert.ok(Number.isSafeInteger(boot.omitted) && boot.omitted >= 0);
      assert.ok(boot.events.length >= 1 && boot.events.length <= 64);
      let previousTime = 0;
      for (const [index, event] of boot.events.entries()) {
        assert.deepEqual(Object.keys(event).sort(), ["code", "elapsedMs", "seq"]);
        assert.equal(Object.hasOwn(codes, event.code), true);
        assert.ok(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= previousTime);
        assert.ok(Number.isSafeInteger(event.seq) && event.seq > 0);
        const expected = index < 8 ? index + 1 : index + 1 + boot.omitted;
        assert.equal(event.seq, expected);
        if (index && !(index === 8 && boot.omitted)) assert.notEqual(event.code, boot.events[index - 1].code);
        previousTime = event.elapsedMs;
      }
      if (boot.omitted) assert.equal(boot.events.length, 64);
    }
  }
  function history() {
    return { format: "wealth-atlas-auth-trace", formatVersion: 1, boots: [{ bootId: IDS[0],
      appVersion: VERSION, mode: "manual-candidate", startedAt: new Date(TIME).toISOString(),
      events: [{ seq: 1, code: A, elapsedMs: 0 }], omitted: 0 }] };
  }
  function refuse(raw) {
    const w = traceWorld(raw), record = w.create({ bootId: IDS[1] });
    assert.equal(record(A), false);
    assert.equal(record(B), false);
    assert.equal(w.writes().length, 0);
    assert.equal(w.files.get(w.manual), raw);
  }

  if (createAuthTrace && codes) {
    check("TRACE_FIXED_SCHEMA_ORDER_AND_READBACK", () => {
      const w = traceWorld(), record = w.create();
      assert.equal(w.calls.length, 0);
      assert.equal(record(A), true);
      const operations = w.calls.map(call => call.op);
      assert.deepEqual(operations.slice(-2), ["WRITE", "READ"]);
      assert.ok(operations.slice(0, -2).length >= 1 && operations.slice(0, -2).every(op => op === "READ"));
      assert.equal(w.calls.at(-2).file, w.calls.at(-1).file);
      const report = w.report(); validateReport(report);
      assert.equal(report.boots[0].bootId, IDS[0]);
      assert.equal(report.boots[0].appVersion, VERSION);
      assert.equal(report.boots[0].mode, "manual-candidate");
      assert.equal(report.boots[0].startedAt, new Date(TIME).toISOString());
      assert.deepEqual(report.boots[0].events, [{ seq: 1, code: A, elapsedMs: 0 }]);
    });
    for (const [index, version] of [undefined, null, 11, "", "0.0.0", "v0.0.0-rc.11", "0.0.0-beta.11",
      "0.0.0-rc.11+extra", "0.0.0-rc.11\n", {}, new String(VERSION)].entries()) {
      check("TRACE_NONCANDIDATE_NO_IO_" + index, () => {
        const w = traceWorld(), record = w.create({ version });
        assert.equal(record(A), false); assert.equal(record(B), false);
        assert.equal(w.calls.length, 0);
      });
    }
    for (const [index, mode] of [null, "", "production", "isolated-qa/../manual-candidate", {}].entries()) {
      check("TRACE_INVALID_MODE_NO_IO_" + index, () => {
        const w = traceWorld(); assert.equal(w.create({ mode })(A), false); assert.equal(w.calls.length, 0);
      });
    }
    check("TRACE_UNKNOWN_CODES_NO_COERCION_OR_IO", () => {
      let getters = 0;
      const hostile = Object.defineProperties({}, {
        toString: { get() { getters++; throw new Error(PRIVATE); } },
        code: { get() { getters++; throw new Error(PRIVATE); } },
      });
      const w = traceWorld(), record = w.create();
      for (const code of [undefined, null, false, 1, {}, [], hostile, "", "__proto__", "constructor", "toString",
        PRIVATE, "AUTH_RUNTIME_STARTED\n", new String(A)]) assert.equal(record(code), false);
      assert.equal(getters, 0); assert.equal(w.calls.length, 0);
      assert.equal(record(A), true);
      const count = w.calls.length;
      assert.equal(record(PRIVATE), false); assert.equal(w.calls.length, count);
    });
    check("TRACE_ADJACENT_ONLY_DEDUPLICATION", () => {
      const w = traceWorld(), record = w.create();
      assert.equal(record(A), true);
      assert.equal(typeof record(A), "boolean");
      assert.equal(w.writes().length, 1);
      assert.equal(record(B), true); assert.equal(record(A), true);
      assert.deepEqual(w.report().boots[0].events.map(event => event.code), [A, B, A]);
      validateReport(w.report());
    });
    check("TRACE_MONOTONIC_ELAPSED_WITH_CLOCK_ROLLBACK", () => {
      const w = traceWorld(), record = w.create(); record(A);
      w.state.time += 25; record(B);
      w.state.time -= 100; record(A);
      w.state.time = TIME + 1000; record(B);
      assert.deepEqual(w.report().boots[0].events.map(event => event.elapsedMs), [0, 25, 25, 1000]);
      validateReport(w.report());
    });
    check("TRACE_FIRST_EIGHT_LAST_FIFTY_SIX_BOUND", () => {
      const w = traceWorld(), record = w.create();
      for (let index = 0; index < 160; index++) {
        w.state.time = TIME + index;
        assert.equal(record(index % 2 ? B : A), true);
      }
      const report = w.report(), boot = report.boots[0]; validateReport(report);
      assert.equal(boot.events.length, 64); assert.equal(boot.omitted, 96);
      assert.deepEqual(boot.events.map(event => event.seq),
        [...Array.from({ length: 8 }, (_, index) => index + 1), ...Array.from({ length: 56 }, (_, index) => 105 + index)]);
      for (const call of w.writes()) assert.ok(Buffer.byteLength(call.text, "utf8") <= LIMIT);
      const text = w.files.get(w.manual), count = w.calls.length;
      assert.equal(typeof record(B), "boolean");
      assert.equal(w.files.get(w.manual), text); assert.equal(w.calls.length, count);
    });
    check("TRACE_CROSS_BOOT_RETENTION_AND_SEQUENCE_RESET", () => {
      const w = traceWorld(); let prior;
      for (let index = 0; index < 4; index++) {
        const record = w.create({ bootId: IDS[index] });
        assert.equal(record(A), true); assert.equal(record(B), true);
        const report = w.report(); validateReport(report);
        assert.deepEqual(report.boots.map(boot => boot.bootId), IDS.slice(Math.max(0, index - 1), index + 1));
        assert.deepEqual(report.boots.at(-1).events.map(event => event.seq), [1, 2]);
        if (prior) assert.deepEqual(report.boots[0], prior);
        prior = report.boots.at(-1);
        w.state.time += 1000;
      }
    });
    check("TRACE_BOUNDED_HISTORY_CAN_BE_REOPENED", () => {
      const w = traceWorld(), record = w.create();
      for (let index = 0; index < 80; index++) assert.equal(record(index % 2 ? B : A), true);
      const previous = w.report().boots[0];
      assert.equal(w.create({ bootId: IDS[1] })(A), true);
      assert.deepEqual(w.report().boots[0], previous); validateReport(w.report());
    });
    check("TRACE_QA_MANUAL_SEPARATION", () => {
      const w = traceWorld();
      assert.equal(w.create()(A), true);
      const original = w.files.get(w.manual);
      assert.equal(w.create({ mode: "isolated-qa", bootId: IDS[1] })(B), true);
      assert.equal(w.files.get(w.manual), original);
      assert.equal(w.report(w.qa).boots.length, 1);
      assert.equal(w.report(w.qa).boots[0].mode, "isolated-qa");
      validateReport(w.report(w.qa));
      assert.equal(w.create({ mode: "isolated-qa", bootId: IDS[2] })(A), true);
      assert.equal(w.report(w.qa).boots.length, 2); assert.equal(w.files.get(w.manual), original);
    });
    check("TRACE_OPTIONAL_BOOT_UUID", () => {
      const w = traceWorld(); assert.equal(w.create({ bootId: undefined })(A), true); validateReport(w.report());
    });
    // A repeated boot ID is tested separately; refuse() otherwise uses a fresh ID.
    check("TRACE_EXISTING_SAME_BOOT_ID_REFUSED", () => {
      const raw = JSON.stringify(history()), w = traceWorld(raw);
      assert.equal(w.create()(B), false); assert.equal(w.writes().length, 0); assert.equal(w.files.get(w.manual), raw);
    });
    const badRaw = ["", "{", "null", "[]", "{}", "false", "1", "\ufeff{}", undefined, false, {}, 42,
      " ".repeat(LIMIT + 1), "\u00e9".repeat(LIMIT / 2 + 1)];
    badRaw.forEach((raw, index) => check("TRACE_CORRUPT_RAW_REFUSED_" + index, () => refuse(raw)));
    const invalid = [];
    function corrupt(code, mutate) { const report = history(); mutate(report); invalid.push([code, JSON.stringify(report)]); }
    const boot = report => report.boots[0], event = report => boot(report).events[0];
    corrupt("UNKNOWN_FORMAT", r => { r.format = PRIVATE; });
    corrupt("FORMAT_VERSION_TYPE", r => { r.formatVersion = "1"; });
    corrupt("FORMAT_VERSION_UNKNOWN", r => { r.formatVersion = 2; });
    corrupt("TOP_EXTRA_SECRET", r => { r.secret = PRIVATE; });
    corrupt("TOP_MISSING_FIELD", r => { delete r.format; });
    corrupt("BOOTS_NULL", r => { r.boots = null; });
    corrupt("BOOTS_OBJECT", r => { r.boots = {}; });
    corrupt("BOOTS_TOO_MANY", r => { r.boots = [boot(r), { ...boot(r), bootId: IDS[2] }, { ...boot(r), bootId: IDS[3] }]; });
    corrupt("BOOTS_DUPLICATE_IDS", r => { r.boots.push({ ...boot(r) }); });
    corrupt("BOOT_NULL", r => { r.boots[0] = null; });
    corrupt("BOOT_EXTRA_SECRET", r => { boot(r).identity = PRIVATE; });
    corrupt("BOOT_MISSING_FIELD", r => { delete boot(r).omitted; });
    corrupt("BOOT_ID_TYPE", r => { boot(r).bootId = 1; });
    corrupt("BOOT_ID_INVALID", r => { boot(r).bootId = PRIVATE; });
    corrupt("VERSION_TYPE", r => { boot(r).appVersion = {}; });
    corrupt("VERSION_NONCANDIDATE", r => { boot(r).appVersion = "0.0.0"; });
    corrupt("MODE_CROSS_FILE", r => { boot(r).mode = "isolated-qa"; });
    corrupt("MODE_TYPE", r => { boot(r).mode = {}; });
    corrupt("STARTED_AT_TYPE", r => { boot(r).startedAt = TIME; });
    corrupt("STARTED_AT_INVALID", r => { boot(r).startedAt = PRIVATE; });
    corrupt("OMITTED_TYPE", r => { boot(r).omitted = "0"; });
    corrupt("OMITTED_NEGATIVE", r => { boot(r).omitted = -1; });
    corrupt("OMITTED_FRACTION", r => { boot(r).omitted = 0.5; });
    corrupt("OMITTED_UNSAFE", r => { boot(r).omitted = Number.MAX_SAFE_INTEGER + 1; });
    corrupt("EVENTS_NULL", r => { boot(r).events = null; });
    corrupt("EVENTS_EMPTY", r => { boot(r).events = []; });
    corrupt("EVENTS_OVERSIZE", r => { boot(r).events = Array.from({ length: 65 }, (_, i) => ({ seq: i + 1, code: i % 2 ? B : A, elapsedMs: i })); });
    corrupt("EVENT_NULL", r => { boot(r).events[0] = null; });
    corrupt("EVENT_EXTRA_SECRET", r => { event(r).payload = PRIVATE; });
    corrupt("EVENT_MISSING_FIELD", r => { delete event(r).elapsedMs; });
    corrupt("EVENT_CODE_UNKNOWN", r => { event(r).code = PRIVATE; });
    corrupt("EVENT_CODE_PROTOTYPE", r => { event(r).code = "constructor"; });
    corrupt("EVENT_CODE_TYPE", r => { event(r).code = {}; });
    corrupt("EVENT_SEQUENCE_ZERO", r => { event(r).seq = 0; });
    corrupt("EVENT_SEQUENCE_TYPE", r => { event(r).seq = "1"; });
    corrupt("EVENT_SEQUENCE_FRACTION", r => { event(r).seq = 1.5; });
    corrupt("EVENT_SEQUENCE_DUPLICATE", r => { boot(r).events.push({ seq: 1, code: B, elapsedMs: 1 }); });
    corrupt("EVENT_SEQUENCE_TOTAL_MISMATCH", r => { boot(r).omitted = 1; });
    corrupt("EVENT_ELAPSED_TYPE", r => { event(r).elapsedMs = "0"; });
    corrupt("EVENT_ELAPSED_NEGATIVE", r => { event(r).elapsedMs = -1; });
    corrupt("EVENT_ELAPSED_FRACTION", r => { event(r).elapsedMs = 0.5; });
    corrupt("EVENT_ELAPSED_UNSAFE", r => { event(r).elapsedMs = Number.MAX_SAFE_INTEGER + 1; });
    corrupt("EVENT_ELAPSED_DECREASE", r => { event(r).elapsedMs = 10; boot(r).events.push({ seq: 2, code: B, elapsedMs: 1 }); });
    corrupt("OMITTED_WITH_SHORT_EVENTS", r => { boot(r).events.push({ seq: 3, code: B, elapsedMs: 1 }); boot(r).omitted = 1; });
    corrupt("NONCANONICAL_RETENTION", r => {
      boot(r).events = Array.from({ length: 64 }, (_, i) => ({ seq: i + 1 + (i >= 7 ? 1 : 0), code: i % 2 ? B : A, elapsedMs: i }));
      boot(r).omitted = 1;
    });
    for (const [code, raw] of invalid) check("TRACE_HISTORY_REFUSED_" + code, () => refuse(raw));
    for (const fault of ["readFault", "writeFault", "dropWrite", "readbackFault", "mismatch"]) {
      check("TRACE_FAILURE_CONTAINED_" + fault.replace(/[A-Z]/g, letter => "_" + letter).toUpperCase(), () => {
        const w = traceWorld(); w.state[fault] = true;
        assert.equal(w.create()(A), false);
        if (fault === "readFault") assert.equal(w.writes().length, 0);
      });
      if (fault !== "readFault") check("TRACE_SAME_CODE_RETRY_AFTER_" + fault.replace(/[A-Z]/g, letter => "_" + letter).toUpperCase(), () => {
        const w = traceWorld(), record = w.create(); w.state[fault] = true;
        assert.equal(record(A), false);
        assert.equal(record(A), false);
        w.state[fault] = false; w.state.lastWrite = false;
        const before = w.calls.length;
        const recovered = record(A);
        assert.equal(typeof recovered, "boolean");
        // Fail-closed refusal is permitted; recovery is not promised. Success
        // is not permitted without an actual newly confirmed write/readback.
        if (recovered) {
          const operations = w.calls.slice(before).map(call => call.op);
          assert.deepEqual(operations.slice(-2), ["WRITE", "READ"]);
          assert.ok(operations.slice(0, -2).every(op => op === "READ"));
          validateReport(w.report()); assert.equal(w.report().boots[0].events.length, 1);
        }
      });
    }
    check("TRACE_REDACTION_NO_ARGUMENT_SERIALIZATION", () => {
      const w = traceWorld(), record = w.create(); let touches = 0;
      const hostile = { toJSON() { touches++; throw new Error(PRIVATE); }, toString() { touches++; throw new Error(PRIVATE); } };
      assert.equal(record(hostile), false); assert.equal(record(A), true);
      assert.equal(touches, 0);
      for (const call of w.writes()) for (const secret of [PRIVATE, SESSION_KEY, VALUE, DIRECTORY]) assert.equal(call.text.includes(secret), false);
      validateReport(w.report());
    });
  }

  function storageWorld(options = {}) {
    const values = new Map(options.present ? [[SESSION_KEY, VALUE]] : []);
    const calls = [], order = [], activities = [], failures = [];
    const state = { readFailure: false, writeFailure: false, removeFailure: false, dropWrite: false,
      dropRemove: false, readbackMismatch: false, providerFailure: false, methodFailure: null, ...options };
    const target = {
      getItem(key) {
        calls.push(["READ", key]); order.push("READ");
        if (state.readFailure) throw new Error(PRIVATE + key);
        if (state.readbackMismatch) return PRIVATE;
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        calls.push(["WRITE", key, value]); order.push("WRITE");
        if (state.writeFailure) throw new Error(PRIVATE + key + value);
        if (!state.dropWrite) values.set(key, value);
      },
      removeItem(key) {
        calls.push(["REMOVE", key]); order.push("REMOVE");
        if (state.removeFailure) throw new Error(PRIVATE + key);
        if (!state.dropRemove) values.delete(key);
      },
    };
    for (const name of ["getItem", "setItem", "removeItem"]) {
      const method = target[name];
      Object.defineProperty(target, name, { get() {
        if (state.methodFailure === name) { order.push("METHOD_GETTER_FAILED"); throw new Error(PRIVATE); }
        return method;
      } });
    }
    const window = Object.defineProperty({}, "localStorage", { get() {
      order.push("PROVIDER");
      if (state.providerFailure) throw new Error(PRIVATE);
      return target;
    } });
    const api = options.lazy ? transpile("lib/auth-storage.ts", window) : storageModule;
    const adapter = api.createAuthStorage(options.lazy ? undefined : target,
      (...args) => { failures.push(args); order.push(args[0]); if (options.failureThrows) throw new Error(PRIVATE); },
      options.noCallback ? undefined : (...args) => {
        activities.push(args); order.push(args[0]); if (options.callbackThrows) throw new Error(PRIVATE + SESSION_KEY + VALUE);
      });
    function expectActivity(expected) {
      assert.deepEqual(activities, expected.map(code => [code]));
      for (const args of activities) { assert.equal(args.length, 1); assert.ok(ACTIVITIES.includes(args[0])); assert.equal(codes[args[0]], true); }
    }
    function failure(action, code) {
      let caught;
      try { action(); } catch (error) { caught = error; }
      assert.ok(caught); assert.equal(caught.name, "AuthStorageError"); assert.equal(caught.code, code);
      assert.equal(Object.hasOwn(caught, "cause"), false);
      const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
      for (const secret of [PRIVATE, SESSION_KEY, VALUE]) assert.equal(serialized.includes(secret), false);
      assert.deepEqual(failures.at(-1), [code]);
      return caught;
    }
    return { adapter, target, values, calls, order, activities, failures, state, expectActivity, failure };
  }
  if (storageModule && codes) {
    for (const present of [false, true]) check("STORAGE_FIRST_READ_" + (present ? "PRESENT" : "EMPTY"), () => {
      const w = storageWorld({ present });
      assert.equal(w.adapter.getItem(SESSION_KEY), present ? VALUE : null);
      assert.equal(w.adapter.getItem(SESSION_KEY), present ? VALUE : null);
      w.expectActivity([present ? ACTIVITIES[1] : ACTIVITIES[0]]);
      assert.deepEqual(w.calls, [["READ", SESSION_KEY], ["READ", SESSION_KEY]]);
      assert.deepEqual(w.order, ["READ", present ? ACTIVITIES[1] : ACTIVITIES[0], "READ"]);
    });
    check("STORAGE_FAILED_READ_DOES_NOT_CONSUME_FIRST_READ", () => {
      const w = storageWorld({ readFailure: true });
      w.failure(() => w.adapter.getItem(SESSION_KEY), "AUTH_STORAGE_READ_FAILED"); w.expectActivity([]);
      w.state.readFailure = false; assert.equal(w.adapter.getItem(SESSION_KEY), null);
      w.expectActivity([ACTIVITIES[0]]);
      assert.deepEqual(w.calls, [["READ", SESSION_KEY], ["READ", SESSION_KEY]]);
    });
    check("STORAGE_EMPTY_STRING_IS_PRESENT_NOT_MISSING", () => {
      const w = storageWorld(); w.values.set(SESSION_KEY, "");
      assert.equal(w.adapter.getItem(SESSION_KEY), ""); w.expectActivity([ACTIVITIES[1]]);
    });
    check("STORAGE_WRITE_AFTER_EXISTING_READBACK_ONLY", () => {
      const w = storageWorld(); assert.equal(w.adapter.setItem(SESSION_KEY, VALUE), undefined);
      w.expectActivity([ACTIVITIES[2]]);
      assert.deepEqual(w.calls, [["WRITE", SESSION_KEY, VALUE], ["READ", SESSION_KEY]]);
      assert.deepEqual(w.order, ["WRITE", "READ", ACTIVITIES[2]]);
      assert.equal(w.adapter.getItem(SESSION_KEY), VALUE); w.expectActivity([ACTIVITIES[2], ACTIVITIES[1]]);
    });
    check("STORAGE_REMOVE_REQUEST_BEFORE_OPERATION_CONFIRMED_AFTER_READBACK", () => {
      const w = storageWorld({ present: true }); assert.equal(w.adapter.removeItem(SESSION_KEY), undefined);
      w.expectActivity([ACTIVITIES[3], ACTIVITIES[4]]);
      assert.deepEqual(w.calls, [["REMOVE", SESSION_KEY], ["READ", SESSION_KEY]]);
      assert.deepEqual(w.order, [ACTIVITIES[3], "REMOVE", "READ", ACTIVITIES[4]]);
      assert.equal(w.values.has(SESSION_KEY), false);
    });
    const unknownKeys = ["", "constructor", "__proto__", "synthetic-probe", "sb--auth-token", "sb-synthetic-auth-token-code-verifier",
      "sb-synthetic-auth-token-user", "xsb-synthetic-auth-token", "sb-synthetic-auth-token\n", "sb-synthetic.auth-token"];
    unknownKeys.forEach((key, index) => check("STORAGE_NONSESSION_KEY_UNOBSERVED_" + index, () => {
      const w = storageWorld();
      assert.equal(w.adapter.getItem(key), null); w.adapter.setItem(key, VALUE); w.adapter.removeItem(key);
      w.expectActivity([]);
      assert.deepEqual(w.calls, [["READ", key], ["WRITE", key, VALUE], ["READ", key], ["REMOVE", key], ["READ", key]]);
      assert.equal(w.adapter.getItem(SESSION_KEY), null); w.expectActivity([ACTIVITIES[0]]);
    }));
    for (const callbackThrows of [false, true]) check("STORAGE_CALLBACK_TRANSPARENT_" + Number(callbackThrows), () => {
      const w = storageWorld({ callbackThrows });
      assert.equal(w.adapter.getItem(SESSION_KEY), null);
      assert.equal(w.adapter.setItem(SESSION_KEY, VALUE), undefined);
      assert.equal(w.adapter.removeItem(SESSION_KEY), undefined);
      w.expectActivity([ACTIVITIES[0], ACTIVITIES[2], ACTIVITIES[3], ACTIVITIES[4]]);
      assert.deepEqual(w.calls, [["READ", SESSION_KEY], ["WRITE", SESSION_KEY, VALUE], ["READ", SESSION_KEY], ["REMOVE", SESSION_KEY], ["READ", SESSION_KEY]]);
      assert.equal(w.failures.length, 0); assert.equal(w.values.size, 0);
    });
    check("STORAGE_ABSENT_ACTIVITY_CALLBACK_COMPATIBILITY", () => {
      const w = storageWorld({ noCallback: true }); w.adapter.getItem(SESSION_KEY);
      w.adapter.setItem(SESSION_KEY, VALUE); w.adapter.removeItem(SESSION_KEY);
      w.expectActivity([]); assert.equal(w.calls.length, 5); assert.equal(w.failures.length, 0);
    });
    for (const [fault, expected, ops] of [
      ["writeFailure", "AUTH_STORAGE_WRITE_FAILED", ["WRITE"]],
      ["readFailure", "AUTH_STORAGE_WRITE_FAILED", ["WRITE", "READ"]],
      ["dropWrite", "AUTH_STORAGE_WRITE_UNCONFIRMED", ["WRITE", "READ"]],
      ["readbackMismatch", "AUTH_STORAGE_WRITE_UNCONFIRMED", ["WRITE", "READ"]],
    ]) check("STORAGE_WRITE_FAILURE_" + fault.replace(/[A-Z]/g, letter => "_" + letter).toUpperCase(), () => {
      const w = storageWorld({ [fault]: true, callbackThrows: true, failureThrows: true });
      w.failure(() => w.adapter.setItem(SESSION_KEY, VALUE), expected); w.expectActivity([]);
      assert.deepEqual(w.calls.map(call => call[0]), ops);
      assert.equal(w.calls.some(call => call[0] === "REMOVE"), false);
      if (fault === "readFailure" || fault === "readbackMismatch") assert.equal(w.values.get(SESSION_KEY), VALUE);
    });
    for (const [fault, ops] of [["removeFailure", ["REMOVE"]], ["readFailure", ["REMOVE", "READ"]],
      ["dropRemove", ["REMOVE", "READ"]], ["readbackMismatch", ["REMOVE", "READ"]]]) {
      check("STORAGE_REMOVE_FAILURE_" + fault.replace(/[A-Z]/g, letter => "_" + letter).toUpperCase(), () => {
        const w = storageWorld({ present: true, [fault]: true, callbackThrows: true, failureThrows: true });
        w.failure(() => w.adapter.removeItem(SESSION_KEY), "AUTH_STORAGE_REMOVE_FAILED");
        w.expectActivity([ACTIVITIES[3]]); assert.deepEqual(w.calls.map(call => call[0]), ops);
        assert.equal(w.order[0], ACTIVITIES[3]); assert.equal(w.calls.some(call => call[0] === "WRITE"), false);
      });
    }
    for (const [method, action, expected, activities] of [
      ["getItem", "READ", "AUTH_STORAGE_READ_FAILED", []],
      ["setItem", "WRITE", "AUTH_STORAGE_WRITE_FAILED", []],
      ["removeItem", "REMOVE", "AUTH_STORAGE_REMOVE_FAILED", [ACTIVITIES[3]]],
    ]) check("STORAGE_METHOD_GETTER_FAILURE_" + action, () => {
      const w = storageWorld({ methodFailure: method });
      w.failure(() => w.adapter[method](SESSION_KEY, VALUE), expected);
      w.expectActivity(activities); assert.equal(w.calls.length, 0);
    });
    check("STORAGE_LAZY_PROVIDER_RECOVERS_WITHOUT_PROBES", () => {
      const w = storageWorld({ lazy: true, providerFailure: true });
      assert.equal(w.order.length, 0);
      w.failure(() => w.adapter.getItem(SESSION_KEY), "AUTH_STORAGE_READ_FAILED");
      w.expectActivity([]); assert.equal(w.calls.length, 0);
      w.state.providerFailure = false;
      assert.equal(w.adapter.getItem(SESSION_KEY), null);
      w.adapter.setItem(SESSION_KEY, VALUE); w.adapter.removeItem(SESSION_KEY);
      w.expectActivity([ACTIVITIES[0], ACTIVITIES[2], ACTIVITIES[3], ACTIVITIES[4]]);
      assert.equal(w.calls.length, 5);
    });
    check("STORAGE_REMOVE_REQUEST_PRECEDES_PROVIDER_GETTER_FAILURE", () => {
      const w = storageWorld({ lazy: true, providerFailure: true });
      w.failure(() => w.adapter.removeItem(SESSION_KEY), "AUTH_STORAGE_REMOVE_FAILED");
      w.expectActivity([ACTIVITIES[3]]);
      assert.deepEqual(w.order, [ACTIVITIES[3], "PROVIDER", "AUTH_STORAGE_REMOVE_FAILED"]);
      assert.equal(w.calls.length, 0);
    });
    check("STORAGE_NO_ROLLBACK_OF_INTERVENING_SESSION", () => {
      const w = storageWorld();
      let removes = 0, reads = 0;
      const values = new Map();
      const target = { setItem(key) { values.set(key, PRIVATE); }, getItem(key) { reads++; return values.get(key) ?? null; }, removeItem() { removes++; } };
      const adapter = storageModule.createAuthStorage(target, undefined, (...args) => w.activities.push(args));
      let caught; try { adapter.setItem(SESSION_KEY, VALUE); } catch (error) { caught = error; }
      assert.equal(caught?.code, "AUTH_STORAGE_WRITE_UNCONFIRMED");
      assert.equal(values.get(SESSION_KEY), PRIVATE); assert.equal(reads, 1); assert.equal(removes, 0); w.expectActivity([]);
    });
  }

  function reporterWorld(options = {}) {
    const calls = [], state = { bridgeFailure: false, version: VERSION, desktop: true, ...options };
    let touched = 0;
    const bridge = Object.defineProperties({}, {
      isDesktop: { get() { touched++; if (state.bridgeFailure) throw new Error(PRIVATE); return state.desktop; } },
      appVersion: { get() { touched++; if (state.bridgeFailure) throw new Error(PRIVATE); return state.version; } },
    });
    const window = options.noWindow ? undefined : Object.defineProperty({}, "wealthAtlasDesktop", {
      get() { if (options.bridgeGetterFailure) throw new Error(PRIVATE); return options.noBridge ? undefined : bridge; },
    });
    const api = transpile("lib/auth-diagnostics.ts", window, {
      "../desktop/auth-diagnostic-codes.json": codes,
      "./diagnostics": { reportSafeDiagnostic(...args) {
        calls.push(args);
        if (options.reportThrows) throw new Error(PRIVATE);
        // A minimal caught rejection: no async work, timers, or unhandled rejection.
        return { catch(callback) { if (options.reportRejects) callback(new Error(PRIVATE)); return this; } };
      } },
    });
    assert.equal(typeof api.reportAuthStorageActivity, "function");
    return { api, calls, state, touches: () => touched };
  }
  if (codes) {
    check("REPORTER_CANDIDATE_BUDGET_SIXTY_FOUR_PLUS_LIMIT", () => {
      const w = reporterWorld();
      for (let index = 0; index < 200; index++) w.api.reportAuthStorageActivity(ACTIVITIES[index % ACTIVITIES.length]);
      assert.equal(w.calls.length, 65);
      for (let index = 0; index < 64; index++) assert.deepEqual(w.calls[index], ["auth-recovery", ACTIVITIES[index % ACTIVITIES.length], "info"]);
      assert.deepEqual(w.calls[64], ["auth-recovery", "AUTH_STORAGE_TRACE_LIMIT_REACHED", "info"]);
    });
    check("REPORTER_REPEATED_CYCLES_NOT_LIFETIME_DEDUPLICATED", () => {
      const w = reporterWorld();
      for (let index = 0; index < 3; index++) for (const code of [ACTIVITIES[2], ACTIVITIES[3], ACTIVITIES[4]]) w.api.reportAuthStorageActivity(code);
      assert.equal(w.calls.length, 9); assert.equal(w.calls.filter(args => args[1] === ACTIVITIES[3]).length, 3);
    });
    for (const [index, options] of [{ noWindow: true }, { noBridge: true }, { desktop: false }, { version: "0.0.0" },
      { version: "0.0.0-beta.11" }, { bridgeFailure: true }, { bridgeGetterFailure: true }].entries()) {
      check("REPORTER_DISABLED_OR_GETTER_FAILURE_" + index, () => {
        const w = reporterWorld(options); for (const code of ACTIVITIES) assert.equal(w.api.reportAuthStorageActivity(code), undefined);
        assert.equal(w.calls.length, 0);
      });
    }
    check("REPORTER_UNKNOWN_CODES_DO_NOT_TOUCH_BRIDGE_OR_BUDGET", () => {
      const w = reporterWorld(); let coercions = 0;
      const hostile = { toString() { coercions++; throw new Error(PRIVATE); } };
      for (let index = 0; index < 100; index++) for (const code of [undefined, null, {}, hostile, A, "constructor", PRIVATE]) w.api.reportAuthStorageActivity(code);
      assert.equal(w.calls.length, 0); assert.equal(w.touches(), 0); assert.equal(coercions, 0);
      w.api.reportAuthStorageActivity(ACTIVITIES[0]); assert.equal(w.calls.length, 1);
    });
    for (const fault of ["reportThrows", "reportRejects"]) check("REPORTER_DELIVERY_FAILURE_" + fault.replace(/[A-Z]/g, letter => "_" + letter).toUpperCase(), () => {
      const w = reporterWorld({ [fault]: true });
      for (const code of ACTIVITIES) assert.equal(w.api.reportAuthStorageActivity(code), undefined);
      assert.equal(w.calls.length, ACTIVITIES.length);
      for (const call of w.calls) { assert.equal(call.length, 3); assert.ok(ACTIVITIES.includes(call[1])); }
    });
  }
  check("REVIEWED_TYPESCRIPT_DID_NOT_LOG_PAYLOADS", () => { assert.equal(mutedOutput, 0); });
  return { results, passed: results.filter(item => item.passed).length,
    failed: results.filter(item => !item.passed).length, caseCount: results.length };
}

module.exports = { runReview };
if (require.main === module) {
  try {
    const review = runReview();
    for (const result of review.results) process.stdout.write(JSON.stringify(result) + "\n");
    process.stdout.write(JSON.stringify({ check: "AUTH_TRACE_REVIEW_SUMMARY", passed: review.passed,
      failed: review.failed, caseCount: review.caseCount }) + "\n");
    process.exitCode = review.failed ? 1 : 0;
  } catch {
    process.stdout.write('{"check":"AUTH_TRACE_REVIEW_FATAL","passed":false}\n');
    process.exitCode = 1;
  }
}
