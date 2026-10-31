/* Pure startup diagnostics contract tests. Read only the helper source and its
 * enum JSON; never start Electron or open any app/profile/data/network path.
 * The helper runs in a VM with only path.resolve and a platform-only process. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const syntheticRoot = path.resolve("SYNTHETIC_STARTUP_CONTEXT", "approved-root");
const otherRoot = path.resolve("SYNTHETIC_STARTUP_CONTEXT", "different-root");
const privateMarker = "SYNTHETIC_PRIVATE_DETAIL_NOT_A_DIAGNOSTIC";
const stageCodes = Object.freeze({ initialize: "LOG_INITIALIZATION_FAILED", main: "MAIN_LOG_WRITE_FAILED",
  startup: "STARTUP_STATUS_WRITE_FAILED", renderer: "RENDERER_LOG_WRITE_FAILED" });
const ioCodes = ["EACCES", "EPERM", "ENOENT", "EBUSY", "ENOSPC", "EIO"];
const contextCodes = ["PROFILE_CHECK_BEFORE_READY", "PROFILE_CHECK_READY", "PROFILE_USER_ROOT_MATCH",
  "PROFILE_USER_ROOT_MISMATCH", "PROFILE_SESSION_ROOT_MATCH", "PROFILE_SESSION_ROOT_MISMATCH",
  "PROFILE_STORAGE_ROOT_MATCH", "PROFILE_STORAGE_ROOT_MISMATCH", "PROFILE_STORAGE_ROOT_UNAVAILABLE",
  "PROFILE_CONTEXT_CHECK_FAILED"];

function runReview() {
  let passed = 0, failed = 0;
  const test = (code, check) => {
    try { check(); passed++; }
    catch { failed++; console.error("STARTUP_CONTEXT_REVIEW_FAILURE " + code); }
  };
  let factory, codes, sandbox, deniedImports = 0;
  const recordsForAllCases = [];
  test("SYNTH_MODULE_LOAD", () => {
    codes = JSON.parse(readFileSync(path.join(__dirname, "../../desktop/auth-diagnostic-codes.json"), "utf8"));
    const source = readFileSync(path.join(__dirname, "../../desktop/startup-diagnostics.cjs"), "utf8");
    const purePath = Object.freeze({ resolve: path.resolve });
    sandbox = vm.createContext({ module: { exports: {} }, process: Object.freeze({ platform: process.platform }),
      require(name) {
        if (name === "node:path" || name === "path") return purePath;
        deniedImports++;
        throw new Error("SYNTH_CAPABILITY_DENIED");
      },
    }, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(source, { filename: "startup-diagnostics.cjs" }).runInContext(sandbox, { timeout: 1000 });
    factory = sandbox.module.exports.createStartupDiagnostics;
    assert.equal(typeof factory, "function");
    assert.equal(deniedImports, 0);
    for (const code of [...contextCodes, ...Object.values(stageCodes), ...ioCodes.map(code => "DIAGNOSTIC_IO_" + code), "DIAGNOSTIC_IO_OTHER"])
      assert.equal(Object.hasOwn(codes, code), true);
  });
  if (failed) return { passed, failed, caseCount: passed + failed };

  test("SYNTH_NO_IO_CAPABILITIES", () => {
    for (const name of ["fs", "node:fs", "node:fs/promises", "electron", "node:http", "node:net", "node:child_process"])
      assert.throws(() => sandbox.require(name));
    assert.equal(deniedImports, 7);
    assert.deepEqual(Object.keys(sandbox.process), ["platform"]);
    assert.equal(vm.runInContext("[typeof fetch, typeof XMLHttpRequest, typeof Buffer, typeof setTimeout, typeof process.env, typeof process.getBuiltinModule].every(value => value === 'undefined')", sandbox), true);
  });

  function build(overrides = {}, recordThrows = false) {
    const records = [], calls = { user: 0, session: 0 };
    const state = { user: syntheticRoot, session: syntheticRoot };
    const options = Object.freeze({ expectedRoot: syntheticRoot,
      getUserData(...args) { assert.equal(args.length, 0); calls.user++; return state.user; },
      getSessionData(...args) { assert.equal(args.length, 0); calls.session++; return state.session; },
      ...overrides,
      record(...args) { records.push(args); if (recordThrows) throw new Error(privateMarker); },
    });
    recordsForAllCases.push(records);
    const helper = factory(options);
    assert.equal(typeof helper.checkContext, "function");
    assert.equal(typeof helper.recordIoFailure, "function");
    return { helper, records, calls, state, options,
      expectCodes(expected) { assert.deepEqual(records.map(args => args[0]).sort(), [...expected].sort()); },
    };
  }
  const matching = phase => [phase === "ready" ? "PROFILE_CHECK_READY" : "PROFILE_CHECK_BEFORE_READY",
    "PROFILE_USER_ROOT_MATCH", "PROFILE_SESSION_ROOT_MATCH"];
  const sensitiveError = code => Object.defineProperties({}, {
    code: { get: () => code },
    message: { get() { throw new Error(privateMarker); } },
    stack: { get() { throw new Error(privateMarker); } },
    path: { get() { throw new Error(privateMarker); } },
    toString: { value() { throw new Error(privateMarker); } },
  });

  for (const [index, expectedRoot] of [undefined, null, ""].entries()) test("SYNTH_DISABLED_" + index, () => {
    let touches = 0;
    const stop = () => { touches++; throw new Error(privateMarker); };
    const error = Object.defineProperty({}, "code", { get: stop });
    const w = build({ expectedRoot, getUserData: stop, getSessionData: stop, getStoragePath: stop });
    assert.equal(w.helper.checkContext("before-ready"), false);
    assert.equal(w.helper.checkContext("ready"), false);
    assert.equal(w.helper.recordIoFailure("main", error), false);
    assert.equal(touches, 0);
    w.expectCodes([]);
  });
  for (const [index, phase] of ["invalid-phase", undefined, null].entries()) test("SYNTH_INVALID_PHASE_" + index, () => {
    const w = build({ getStoragePath() { throw new Error(privateMarker); } });
    assert.equal(w.helper.checkContext(phase), false);
    assert.deepEqual(w.calls, { user: 0, session: 0 });
    w.expectCodes([]);
  });
  test("SYNTH_BEFORE_READY_ONLY_ROOTS", () => {
    const w = build({ getStoragePath() { throw new Error(privateMarker); } });
    const ignored = { toString() { throw new Error(privateMarker); } };
    assert.equal(w.helper.checkContext("before-ready", ignored), true);
    assert.deepEqual(w.calls, { user: 1, session: 1 });
    w.expectCodes(matching("before-ready"));
  });
  for (const phase of ["before-ready", "ready"]) test("SYNTH_RESOLVED_MATCH_" + phase.toUpperCase().replace("-", "_"), () => {
    const w = build({ expectedRoot: path.join("SYNTHETIC_STARTUP_CONTEXT", "approved-root") });
    w.state.user = syntheticRoot + path.sep + "unused" + path.sep + "..";
    w.state.session = syntheticRoot + path.sep + "." + path.sep;
    assert.equal(w.helper.checkContext(phase, syntheticRoot + path.sep + "unused" + path.sep + ".."), true);
    w.expectCodes([...matching(phase), ...(phase === "ready" ? ["PROFILE_STORAGE_ROOT_MATCH"] : [])]);
  });
  for (const phase of ["before-ready", "ready"]) for (const field of ["user", "session"]) test("SYNTH_ROOT_MISMATCH_" + phase.toUpperCase().replace("-", "_") + "_" + field.toUpperCase(), () => {
    const w = build();
    w.state[field] = otherRoot;
    const original = { ...w.state };
    assert.equal(w.helper.checkContext(phase, syntheticRoot), false);
    w.expectCodes([phase === "ready" ? "PROFILE_CHECK_READY" : "PROFILE_CHECK_BEFORE_READY",
      field === "user" ? "PROFILE_USER_ROOT_MISMATCH" : "PROFILE_USER_ROOT_MATCH",
      field === "session" ? "PROFILE_SESSION_ROOT_MISMATCH" : "PROFILE_SESSION_ROOT_MATCH",
      ...(phase === "ready" ? ["PROFILE_STORAGE_ROOT_MATCH"] : [])]);
    assert.deepEqual(w.state, original); // A mismatch must never reconfigure a root.
    assert.equal(w.options.expectedRoot, syntheticRoot);
    assert.equal(Object.isFrozen(w.options), true);
  });
  test("SYNTH_BOTH_ROOTS_MISMATCH", () => {
    const w = build(); w.state.user = otherRoot; w.state.session = otherRoot;
    assert.equal(w.helper.checkContext("before-ready"), false);
    w.expectCodes(["PROFILE_CHECK_BEFORE_READY", "PROFILE_USER_ROOT_MISMATCH", "PROFILE_SESSION_ROOT_MISMATCH"]);
  });
  test("SYNTH_STORAGE_MISMATCH", () => {
    const w = build();
    assert.equal(w.helper.checkContext("ready", otherRoot), false);
    w.expectCodes([...matching("ready"), "PROFILE_STORAGE_ROOT_MISMATCH"]);
    assert.deepEqual(w.state, { user: syntheticRoot, session: syntheticRoot });
  });
  test("SYNTH_EXPLICIT_STORAGE_STRING_PRIORITY", () => {
    const w = build({ getStoragePath() { throw new Error(privateMarker); } });
    assert.equal(w.helper.checkContext("ready", syntheticRoot), true);
    w.expectCodes([...matching("ready"), "PROFILE_STORAGE_ROOT_MATCH"]);
  });
  test("SYNTH_EXPLICIT_STORAGE_NULL_PRIORITY", () => {
    let calls = 0;
    const w = build({ getStoragePath() { calls++; return syntheticRoot; } });
    assert.equal(w.helper.checkContext("ready", null), false);
    assert.equal(calls, 0);
    w.expectCodes([...matching("ready"), "PROFILE_STORAGE_ROOT_UNAVAILABLE"]);
  });
  test("SYNTH_STORAGE_UNDEFINED_WITHOUT_GETTER", () => {
    const w = build();
    assert.equal(w.helper.checkContext("ready"), false);
    w.expectCodes([...matching("ready"), "PROFILE_STORAGE_ROOT_UNAVAILABLE"]);
  });
  test("SYNTH_STORAGE_OPTIONAL_GETTER", () => {
    let calls = 0;
    const w = build({ getStoragePath(...args) { assert.equal(args.length, 0); calls++; return syntheticRoot; } });
    assert.equal(w.helper.checkContext("ready"), true);
    assert.equal(calls, 1);
    w.expectCodes([...matching("ready"), "PROFILE_STORAGE_ROOT_MATCH"]);
  });
  test("SYNTH_STORAGE_GETTER_NULL", () => {
    const w = build({ getStoragePath() { return null; } });
    assert.equal(w.helper.checkContext("ready", undefined), false);
    w.expectCodes([...matching("ready"), "PROFILE_STORAGE_ROOT_UNAVAILABLE"]);
  });
  test("SYNTH_STORAGE_GETTER_THROWS", () => {
    let calls = 0;
    const w = build({ getStoragePath() { calls++; throw new Error(privateMarker); } });
    assert.equal(w.helper.checkContext("ready"), false);
    assert.equal(calls, 1);
    assert.equal(w.records.some(args => args[0] === "PROFILE_CONTEXT_CHECK_FAILED"), true);
  });
  for (const phase of ["before-ready", "ready"]) for (const getter of ["getUserData", "getSessionData"]) test("SYNTH_GETTER_THROWS_" + phase.toUpperCase().replace("-", "_") + "_" + getter.toUpperCase(), () => {
    const w = build({ [getter]() { throw new Error(privateMarker); } });
    assert.equal(w.helper.checkContext(phase, syntheticRoot), false);
    assert.equal(w.records.some(args => args[0] === "PROFILE_CONTEXT_CHECK_FAILED"), true);
  });
  test("SYNTH_RECORD_THROWS_MATCH", () => {
    const w = build({}, true);
    assert.equal(w.helper.checkContext("ready", syntheticRoot), true);
    w.expectCodes([...matching("ready"), "PROFILE_STORAGE_ROOT_MATCH"]);
  });
  test("SYNTH_RECORD_THROWS_MISMATCH", () => {
    const w = build({}, true);
    assert.equal(w.helper.checkContext("ready", otherRoot), false);
    w.expectCodes([...matching("ready"), "PROFILE_STORAGE_ROOT_MISMATCH"]);
  });
  test("SYNTH_RECORD_AND_GETTER_THROW", () => {
    const w = build({ getUserData() { throw new Error(privateMarker); } }, true);
    assert.equal(w.helper.checkContext("before-ready"), false);
    assert.equal(w.records.some(args => args[0] === "PROFILE_CONTEXT_CHECK_FAILED"), true);
  });

  for (const [stage, stageCode] of Object.entries(stageCodes)) for (const code of ioCodes) test("SYNTH_IO_" + stage.toUpperCase() + "_" + code, () => {
    const w = build();
    assert.equal(w.helper.recordIoFailure(stage, sensitiveError(code)), true);
    w.expectCodes([stageCode, "DIAGNOSTIC_IO_" + code]);
    assert.deepEqual(w.calls, { user: 0, session: 0 });
  });
  for (const [index, code] of ["ETIMEDOUT", "__proto__", "constructor", privateMarker, 123, undefined].entries()) test("SYNTH_OTHER_IO_" + index, () => {
    const w = build();
    assert.equal(w.helper.recordIoFailure("main", sensitiveError(code)), true);
    w.expectCodes([stageCodes.main, "DIAGNOSTIC_IO_OTHER"]);
  });
  test("SYNTH_THROWING_ERROR_CODE_GETTER", () => {
    const error = Object.defineProperty({}, "code", { get() { throw new Error(privateMarker); } });
    const w = build();
    assert.equal(w.helper.recordIoFailure("renderer", error), true);
    w.expectCodes([stageCodes.renderer, "DIAGNOSTIC_IO_OTHER"]);
  });
  test("SYNTH_ONLY_ERROR_CODE_READ", () => {
    const reads = [];
    const error = new Proxy({}, { get(_target, key) {
      reads.push(key); if (key === "code") return "EACCES"; throw new Error(privateMarker);
    } });
    const w = build();
    assert.equal(w.helper.recordIoFailure("startup", error), true);
    assert.equal(reads.length > 0, true);
    assert.equal(reads.every(key => key === "code"), true);
    w.expectCodes([stageCodes.startup, "DIAGNOSTIC_IO_EACCES"]);
  });
  for (const [index, error] of [null, undefined].entries()) test("SYNTH_MISSING_ERROR_" + index, () => {
    const w = build();
    assert.equal(w.helper.recordIoFailure("initialize", error), true);
    w.expectCodes([stageCodes.initialize, "DIAGNOSTIC_IO_OTHER"]);
  });
  test("SYNTH_IO_RECORD_THROWS", () => {
    const w = build({}, true);
    assert.equal(w.helper.recordIoFailure("main", sensitiveError("EIO")), true);
    w.expectCodes([stageCodes.main, "DIAGNOSTIC_IO_EIO"]);
  });
  for (const [index, stage] of ["unknown", "__proto__", "constructor", undefined, null].entries()) test("SYNTH_UNKNOWN_STAGE_" + index, () => {
    let reads = 0;
    const error = Object.defineProperty({}, "code", { get() { reads++; throw new Error(privateMarker); } });
    const w = build();
    assert.equal(w.helper.recordIoFailure(stage, error), false);
    assert.equal(reads, 0);
    w.expectCodes([]);
  });
  test("SYNTH_ENUM_ONLY_NO_PAYLOAD_OR_IO", () => {
    assert.equal(deniedImports, 7); // No helper import, at load or on any branch, attempted I/O.
    assert.equal(recordsForAllCases.length > 10, true);
    for (const records of recordsForAllCases) {
      for (const args of records) {
        assert.equal(args.length, 1);
        assert.equal(typeof args[0], "string");
        assert.equal(Object.hasOwn(codes, args[0]), true);
      }
      const serialized = JSON.stringify(records);
      for (const value of [syntheticRoot, otherRoot, privateMarker]) assert.equal(serialized.includes(value), false);
    }
  });
  return { passed, failed, caseCount: passed + failed };
}

module.exports = { runReview };
if (require.main === module) {
  const result = runReview();
  console.log("STARTUP_CONTEXT_REVIEW_RESULT " + JSON.stringify(result));
  process.exitCode = result.failed ? 1 : 0;
}
