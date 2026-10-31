/* Pure diagnostic visibility contract review. The only real filesystem reads
 * are the helper source and diagnostic enum. All probe I/O stays in memory;
 * never start Electron, inspect a profile, or import auth/storage/network code. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PROBE_TEXT = "WEALTH_ATLAS_FIXED_VISIBILITY_PROBE_V1\n";
const PROBE_ID = "12345678-1234-4234-8234-123456789abc";
const PRIVATE = "SYNTHETIC_PRIVATE_BYTES_NEVER_A_DIAGNOSTIC";
const ROOT = path.resolve("SYNTHETIC_VISIBILITY_REVIEW", "approved-root");
const OTHER_ROOT = path.resolve("SYNTHETIC_VISIBILITY_REVIEW", "different-root");
const LOGS = path.join(ROOT, "logs");
const TARGET = path.join(LOGS, "diagnostic-visibility-" + PROBE_ID + ".txt");
const VISIBILITY_CODES = ["STARTED", "ROOT_MISMATCH", "TARGET_UNAVAILABLE", "UNSAFE_TARGET",
  "FILE_EXISTS", "WRITE_CONFIRMED", "READBACK_CONFIRMED", "FAILED"].map(code => "VISIBILITY_PROBE_" + code);
const IO_CODES = ["EACCES", "EPERM", "ENOENT", "EBUSY", "ENOSPC", "EIO"];
const ALLOWED_CODES = new Set([...VISIBILITY_CODES, ...IO_CODES.map(code => "DIAGNOSTIC_IO_" + code), "DIAGNOSTIC_IO_OTHER"]);
const SUCCESS_CODES = ["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_WRITE_CONFIRMED", "VISIBILITY_PROBE_READBACK_CONFIRMED"];
const canonical = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

function safeError(code, accesses = []) {
  return new Proxy(Object.create(null), { get(_target, key) {
    accesses.push(key);
    if (key === "code") return code;
    throw new Error(PRIVATE);
  } });
}

function makeMemoryFs(config = {}) {
  const calls = [], violations = [], descriptors = new Map(), occurrences = Object.create(null);
  let exists = Boolean(config.existing), bytes = Buffer.from(config.existing ? PRIVATE : ""), nextFd = 100;
  let writes = 0, reads = 0;
  const bad = () => { violations.push("SYNTH_UNEXPECTED_IO"); throw new Error("SYNTH_UNEXPECTED_IO"); };
  const isPath = (actual, expected) => typeof actual === "string" && canonical(actual) === canonical(expected);
  const directory = target => isPath(target, ROOT) ? "root" : isPath(target, LOGS) ? "logs" : bad();
  const handle = fd => descriptors.get(fd) || bad();
  function note(operation, args) {
    calls.push({ operation, args: [...args] });
    const nth = occurrences[operation] = (occurrences[operation] || 0) + 1;
    const failure = (config.failures || []).find(item => item.operation === operation && (item.nth || 1) === nth);
    if (failure) {
      if (operation === "writeFileSync" && config.partialWrite) { bytes = Buffer.from("WEALTH_"); writes++; }
      throw failure.error;
    }
  }
  const methods = {
    lstatSync(...args) {
      note("lstatSync", args);
      const part = directory(args[0]);
      if (config.missing === part) throw safeError("ENOENT");
      const kind = config[part + "Kind"] || "directory";
      return { isDirectory: () => kind === "directory", isSymbolicLink: () => kind === "symlink" };
    },
    realpathSync(...args) {
      note("realpathSync", args);
      const part = directory(args[0]);
      return config.redirect === part ? path.join(OTHER_ROOT, part) : path.resolve(args[0]);
    },
    openSync(...args) {
      note("openSync", args);
      if (!isPath(args[0], TARGET)) return bad();
      const flags = args[1];
      if (flags === "wx+") {
        if (args[2] !== 0o600 || args.length !== 3) return bad();
        if (exists) throw safeError("EEXIST");
        exists = true; bytes = Buffer.alloc(0);
      } else if (flags === "r") {
        if (args.length !== 2 || !exists) return bad();
      } else return bad();
      const fd = nextFd++;
      descriptors.set(fd, { kind: flags === "r" ? "reader" : "writer", fd });
      return fd;
    },
    fstatSync(...args) {
      if (args.length !== 2 || args[1] === null || typeof args[1] !== "object"
        || Reflect.ownKeys(args[1]).length !== 1 || !Object.hasOwn(args[1], "bigint") || args[1].bigint !== true) return bad();
      note("fstatSync", args);
      const descriptor = handle(args[0]);
      const changes = descriptor.kind === "reader" ? config.reopenedStat : config.createdStat;
      return { dev: 7n, ino: 23n, size: BigInt(bytes.length), nlink: 1n,
        isFile: () => true, isSymbolicLink: () => false, ...changes };
    },
    writeFileSync(...args) {
      note("writeFileSync", args);
      if (handle(args[0]).kind !== "writer" || args[1] !== PROBE_TEXT || args[2] !== "utf8" || args.length !== 3) return bad();
      writes++; bytes = Buffer.from(args[1], args[2]);
    },
    fsyncSync(...args) {
      note("fsyncSync", args);
      if (handle(args[0]).kind !== "writer" || args.length !== 1) return bad();
    },
    closeSync(...args) {
      note("closeSync", args);
      handle(args[0]);
      if (args.length !== 1) return bad();
      descriptors.delete(args[0]);
    },
    readFileSync(...args) {
      note("readFileSync", args);
      reads++;
      if (handle(args[0]).kind !== "reader" || args[1] !== "utf8" || args.length !== 2) return bad();
      return config.readback === undefined ? bytes.toString("utf8") : config.readback;
    },
  };
  const io = new Proxy(Object.freeze(methods), { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    return bad(); // Includes mkdir/unlink/rename/path reads and async I/O.
  } });
  return { io, calls, violations, descriptors, occurrences,
    get exists() { return exists; }, get bytes() { return bytes.toString("utf8"); },
    get writes() { return writes; }, get reads() { return reads; } };
}

function runReview() {
  let passed = 0, failed = 0, factory, codes, sandbox, deniedImports = 0;
  let defaultIoCalls = 0;
  const allCases = [];
  const test = (code, check) => {
    try { check(); passed++; }
    catch { failed++; console.error("DIAGNOSTIC_VISIBILITY_REVIEW_FAILURE " + code); }
  };
  test("SYNTH_MODULE_LOAD", () => {
    codes = JSON.parse(readFileSync(path.join(__dirname, "../../desktop/auth-diagnostic-codes.json"), "utf8"));
    const source = readFileSync(path.join(__dirname, "../../desktop/diagnostic-visibility.cjs"), "utf8");
    const inertFs = new Proxy(Object.create(null), { get() {
      return () => { defaultIoCalls++; throw new Error("SYNTH_DEFAULT_FS_DENIED"); };
    } });
    const purePath = Object.freeze({ resolve: path.resolve, join: path.join, isAbsolute: path.isAbsolute });
    sandbox = vm.createContext({ module: { exports: {} }, Buffer,
      process: Object.freeze({ platform: process.platform }), require(name) {
        if (name === "node:fs" || name === "fs") return inertFs;
        if (name === "node:path" || name === "path") return purePath;
        deniedImports++;
        throw new Error("SYNTH_CAPABILITY_DENIED");
      } }, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(source, { filename: "diagnostic-visibility.cjs" }).runInContext(sandbox, { timeout: 1000 });
    factory = sandbox.module.exports.createDiagnosticVisibilityProbe;
    assert.equal(typeof factory, "function");
    if (Object.hasOwn(sandbox.module.exports, "PROBE_TEXT")) assert.equal(sandbox.module.exports.PROBE_TEXT, PROBE_TEXT);
    for (const code of ALLOWED_CODES) assert.equal(Object.hasOwn(codes, code), true);
    assert.equal(defaultIoCalls, 0);
    assert.equal(deniedImports, 0);
  });
  if (failed) return { passed, failed, caseCount: passed + failed };

  function build(overrides = {}, config = {}, sharedFs) {
    const memory = sharedFs || makeMemoryFs(config), records = [];
    const options = { version: "1.2.3-rc.12", mode: "manual-candidate", probeId: PROBE_ID,
      expectedRoot: ROOT, io: memory.io, record(...args) {
        records.push(args);
        if (config.onRecord) config.onRecord(...args);
        if (config.recordThrows) throw new Error(PRIVATE);
      }, ...overrides };
    const probe = factory(options);
    assert.equal(typeof probe, "function");
    const result = { memory, records, probe,
      expectCodes(expected) { assert.deepEqual(records.map(args => args[0]), expected); },
      noIo() { assert.equal(memory.calls.length, 0); assert.equal(memory.violations.length, 0); },
      once() {
        const calls = memory.calls.length, events = records.length;
        assert.equal(probe(ROOT), false);
        assert.equal(memory.calls.length, calls);
        assert.equal(records.length, events);
      },
    };
    allCases.push(result);
    return result;
  }
  const operations = memory => memory.calls.map(call => call.operation);
  const failedCodes = (code, afterWrite = false) => ["VISIBILITY_PROBE_STARTED",
    ...(afterWrite ? ["VISIBILITY_PROBE_WRITE_CONFIRMED"] : []), "VISIBILITY_PROBE_FAILED", "DIAGNOSTIC_IO_" + code];

  test("SYNTH_SANDBOX_CAPABILITIES", () => {
    for (const name of ["node:fs/promises", "electron", "node:http", "node:https", "node:net", "node:child_process"])
      assert.throws(() => sandbox.require(name));
    assert.equal(deniedImports, 6);
    assert.deepEqual(Object.keys(sandbox.process), ["platform"]);
    assert.equal(vm.runInContext("[typeof fetch, typeof XMLHttpRequest, typeof setTimeout, typeof process.env, typeof process.getBuiltinModule].every(value => value === 'undefined')", sandbox), true);
  });
  for (const mode of ["manual-candidate", "isolated-qa"]) test("SYNTH_SUCCESS_" + mode.toUpperCase().replaceAll("-", "_"), () => {
    const w = build({ mode });
    assert.equal(w.probe(ROOT), true);
    w.expectCodes(SUCCESS_CODES);
    assert.deepEqual(operations(w.memory), ["lstatSync", "realpathSync", "lstatSync", "realpathSync",
      "openSync", "fstatSync", "writeFileSync", "fsyncSync", "closeSync", "openSync", "fstatSync", "readFileSync", "closeSync"]);
    const opens = w.memory.calls.filter(call => call.operation === "openSync");
    assert.deepEqual(opens.map(call => call.args.slice(1)), [["wx+", 0o600], ["r"]]);
    assert.equal(opens.every(call => canonical(call.args[0]) === canonical(TARGET)), true);
    const write = w.memory.calls.find(call => call.operation === "writeFileSync");
    assert.deepEqual(write.args, [100, PROBE_TEXT, "utf8"]);
    assert.equal(w.memory.bytes, PROBE_TEXT);
    assert.equal(w.memory.writes, 1);
    assert.equal(w.memory.reads, 1);
    assert.equal(w.memory.descriptors.size, 0);
    w.once();
  });
  const largeIdentity = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  for (const [name, identity] of [["ZERO_DEVICE", { dev: 0n }], ["LARGE_BIGINT", { dev: largeIdentity, ino: largeIdentity }]])
    test("SYNTH_VALID_IDENTITY_" + name, () => {
      const w = build({}, { createdStat: identity, reopenedStat: identity });
      assert.equal(w.probe(ROOT), true);
      w.expectCodes(SUCCESS_CODES);
      assert.equal(w.memory.writes, 1);
      assert.equal(w.memory.reads, 1);
      assert.equal(w.memory.descriptors.size, 0);
      w.once();
    });
  test("SYNTH_NORMALIZED_ROOT_MATCH", () => {
    const w = build({ expectedRoot: ROOT + path.sep + "unused" + path.sep + ".." });
    assert.equal(w.probe(ROOT + path.sep + "." + path.sep), true);
    w.expectCodes(SUCCESS_CODES);
    w.once();
  });
  if (process.platform === "win32") test("SYNTH_WINDOWS_CASE_NORMALIZATION", () => {
    const w = build();
    assert.equal(w.probe(ROOT.toUpperCase()), true);
    w.expectCodes(SUCCESS_CODES);
    w.once();
  });
  test("SYNTH_CALLBACK_THROWS_SAME_IO", () => {
    const reference = build(), w = build({}, { recordThrows: true });
    assert.equal(reference.probe(ROOT), true);
    assert.equal(w.probe(ROOT), true);
    assert.deepEqual(w.memory.calls, reference.memory.calls);
    w.expectCodes(SUCCESS_CODES);
    w.once();
  });
  test("SYNTH_REENTRANT_CALLBACK_ONCE_ONLY", () => {
    const nested = [];
    let w;
    w = build({}, { onRecord() { nested.push(w.probe(ROOT)); } });
    assert.equal(w.probe(ROOT), true);
    assert.deepEqual(nested, [false, false, false]);
    assert.equal(w.memory.writes, 1);
    w.once();
  });

  const invalidIds = [undefined, null, "", 123, {}, "not-a-uuid", "../" + PROBE_ID,
    PROBE_ID + ".txt", PROBE_ID.slice(1), PROBE_ID.replace("a", "g"), PROBE_ID + " ",
    PROBE_ID + "\n", PROBE_ID + "\r", PROBE_ID + "\r\n", PROBE_ID + "\u2028", PROBE_ID + "\u2029"];
  for (const [index, probeId] of invalidIds.entries()) test("SYNTH_UUID_GATE_" + index, () => {
    const w = build({ probeId });
    assert.equal(w.probe(ROOT), false);
    w.noIo(); w.expectCodes([]); w.once();
  });
  const invalidVersions = [undefined, null, "", 123, {}, "1.2.3", "1.2.3-beta.1", "1.2.3-rc",
    "1.2.3-rc.1-extra", "prefix1.2.3-rc.1", "1.2.3-rc.1\n", "1.2.3-rc.1\r\n"];
  for (const [index, version] of invalidVersions.entries()) test("SYNTH_VERSION_GATE_" + index, () => {
    const w = build({ version });
    assert.equal(w.probe(ROOT), false);
    w.noIo(); w.expectCodes([]); w.once();
  });
  for (const [index, mode] of [undefined, null, "", 123, {}, "production", "candidate", "manual-candidate\n", "isolated-qa\n"].entries())
    test("SYNTH_MODE_GATE_" + index, () => {
      const w = build({ mode });
      assert.equal(w.probe(ROOT), false);
      w.noIo(); w.expectCodes([]); w.once();
    });
  for (const [index, expectedRoot] of [undefined, null, "", 123, {}, ".", "relative-root", path.join("relative", "root")].entries())
    test("SYNTH_EXPECTED_ROOT_GATE_" + index, () => {
      const w = build({ expectedRoot });
      assert.equal(w.probe(ROOT), false);
      w.noIo(); w.expectCodes([]); w.once();
    });
  for (const [index, record] of [undefined, null, "not-a-function"].entries()) test("SYNTH_RECORD_GATE_" + index, () => {
    const w = build({ record });
    assert.equal(w.probe(ROOT), false);
    w.noIo(); w.expectCodes([]); w.once();
  });
  test("SYNTH_DEFAULT_DISABLED_NO_IO", () => {
    assert.equal(factory()(ROOT), false);
    assert.equal(factory({ version: "1.2.3", expectedRoot: ROOT, mode: "manual-candidate", probeId: PROBE_ID, record() {} })(ROOT), false);
    assert.equal(defaultIoCalls, 0);
  });
  for (const [index, actualRoot] of [undefined, null, "", 123, {}, "relative-root", OTHER_ROOT].entries())
    test("SYNTH_ACTUAL_ROOT_MISMATCH_" + index, () => {
      const w = build();
      assert.equal(w.probe(actualRoot), false);
      w.noIo(); w.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_ROOT_MISMATCH"]); w.once();
    });
  test("SYNTH_MISMATCH_CALLBACK_THROWS_NO_IO", () => {
    const w = build({}, { recordThrows: true });
    assert.equal(w.probe(OTHER_ROOT), false);
    w.noIo(); w.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_ROOT_MISMATCH"]); w.once();
  });

  for (const part of ["root", "logs"]) {
    test("SYNTH_MISSING_" + part.toUpperCase(), () => {
      const w = build({}, { missing: part });
      assert.equal(w.probe(ROOT), false);
      w.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_TARGET_UNAVAILABLE", "DIAGNOSTIC_IO_ENOENT"]);
      assert.equal(operations(w.memory).includes("openSync"), false);
      assert.equal(w.memory.exists, false);
      w.once();
    });
    for (const kind of ["symlink", "file"]) test("SYNTH_UNSAFE_" + part.toUpperCase() + "_" + kind.toUpperCase(), () => {
      const w = build({}, { [part + "Kind"]: kind });
      assert.equal(w.probe(ROOT), false);
      w.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_UNSAFE_TARGET"]);
      assert.equal(operations(w.memory).includes("openSync"), false);
      assert.equal(w.memory.exists, false);
      w.once();
    });
    test("SYNTH_REALPATH_REDIRECT_" + part.toUpperCase(), () => {
      const w = build({}, { redirect: part });
      assert.equal(w.probe(ROOT), false);
      w.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_UNSAFE_TARGET"]);
      assert.equal(operations(w.memory).includes("openSync"), false);
      assert.equal(w.memory.exists, false);
      w.once();
    });
  }
  test("SYNTH_EXISTING_MARKER_UNTOUCHED", () => {
    const w = build({}, { existing: true });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_FILE_EXISTS"]);
    assert.equal(w.memory.bytes, PRIVATE);
    assert.equal(w.memory.reads, 0);
    assert.equal(w.memory.writes, 0);
    assert.equal(w.memory.calls.filter(call => call.operation === "openSync").length, 1);
    assert.equal(operations(w.memory).includes("fstatSync"), false);
    assert.equal(w.memory.descriptors.size, 0);
    w.once();
  });
  test("SYNTH_SAME_BUILD_RESTART_EXCLUSIVE", () => {
    const first = build();
    assert.equal(first.probe(ROOT), true);
    const readCount = first.memory.reads, writeCount = first.memory.writes, callCount = first.memory.calls.length;
    const second = build({}, {}, first.memory);
    assert.equal(second.probe(ROOT), false);
    second.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_FILE_EXISTS"]);
    assert.equal(first.memory.bytes, PROBE_TEXT);
    assert.equal(first.memory.reads, readCount);
    assert.equal(first.memory.writes, writeCount);
    assert.equal(operations(first.memory).slice(callCount).includes("readFileSync"), false);
    second.once();
  });

  const failures = [
    ["LSTAT_ROOT", "lstatSync", 1, false, true], ["LSTAT_LOGS", "lstatSync", 2, false, true],
    ["REALPATH_ROOT", "realpathSync", 1, false, true], ["REALPATH_LOGS", "realpathSync", 2, false, true],
    ["CREATE", "openSync", 1, false, false], ["CREATED_FSTAT", "fstatSync", 1, false, false],
    ["WRITE", "writeFileSync", 1, false, false], ["FSYNC", "fsyncSync", 1, false, false],
    ["WRITE_CLOSE", "closeSync", 1, false, false], ["REOPEN", "openSync", 2, true, false],
    ["READ_FSTAT", "fstatSync", 2, true, false], ["READBACK", "readFileSync", 1, true, false],
    ["READ_CLOSE", "closeSync", 2, true, false],
  ];
  for (const [name, operation, nth, afterWrite, targetPhase] of failures) test("SYNTH_FAILURE_" + name, () => {
    const accesses = [], w = build({}, { failures: [{ operation, nth, error: safeError("EIO", accesses) }] });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(targetPhase ? ["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_TARGET_UNAVAILABLE", "DIAGNOSTIC_IO_EIO"] : failedCodes("EIO", afterWrite));
    assert.equal(accesses.length > 0 && accesses.length <= 2, true);
    assert.equal(accesses.every(key => key === "code"), true);
    assert.equal(w.memory.descriptors.size, 0);
    if (!afterWrite) assert.equal(w.memory.reads, 0);
    if (["CREATED_FSTAT", "WRITE", "FSYNC", "WRITE_CLOSE"].includes(name)) assert.equal(w.memory.exists, true);
    w.once();
  });
  test("SYNTH_PARTIAL_WRITE_RETAINED_NOT_RETRIED", () => {
    const w = build({}, { partialWrite: true, failures: [{ operation: "writeFileSync", error: safeError("ENOSPC") }] });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(failedCodes("ENOSPC"));
    assert.equal(w.memory.bytes, "WEALTH_");
    assert.equal(w.memory.reads, 0);
    assert.equal(w.memory.descriptors.size, 0);
    w.once();
    const restarted = build({}, {}, w.memory);
    assert.equal(restarted.probe(ROOT), false);
    restarted.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_FILE_EXISTS"]);
    assert.equal(w.memory.bytes, "WEALTH_");
    assert.equal(w.memory.reads, 0);
    assert.equal(w.memory.writes, 1);
  });
  test("SYNTH_CLEANUP_CLOSE_FAILURE_NONFATAL", () => {
    const w = build({}, { failures: [{ operation: "writeFileSync", error: safeError("EIO") },
      { operation: "closeSync", error: safeError("EBUSY") }] });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(failedCodes("EIO"));
    assert.equal(w.memory.calls.filter(call => call.operation === "closeSync").length, 1);
    assert.equal(w.memory.exists, true);
    assert.equal(w.memory.reads, 0);
    w.once();
  });
  for (const [name, createdStat] of [["NOT_FILE", { isFile: () => false }], ["MULTI_LINK", { nlink: 2n }], ["UNLINKED", { nlink: 0n }],
    ["MATCHING_ZERO_INODE", { ino: 0n }], ["MATCHING_NEGATIVE_DEVICE", { dev: -1n }], ["MATCHING_NEGATIVE_INODE", { ino: -1n }],
    ["MATCHING_NUMBER_DEVICE", { dev: 7 }], ["MATCHING_NUMBER_INODE", { ino: 23 }],
    ["MATCHING_UNSAFE_NUMBER_DEVICE", { dev: Number.MAX_SAFE_INTEGER + 1 }],
    ["MATCHING_UNSAFE_NUMBER_INODE", { ino: Number.MAX_SAFE_INTEGER + 1 }]])
    test("SYNTH_CREATED_UNSAFE_" + name, () => {
      // The reader would report the SAME invalid identifier. Refusal must be
      // caused by the creation guard, not a later identity/type mismatch.
      const w = build({}, { createdStat, reopenedStat: createdStat });
      assert.equal(w.probe(ROOT), false);
      w.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_UNSAFE_TARGET"]);
      assert.equal(w.memory.writes, 0);
      assert.equal(w.memory.reads, 0);
      assert.equal(w.memory.occurrences.openSync, 1);
      assert.equal(w.memory.occurrences.fstatSync, 1);
      assert.equal(w.memory.descriptors.size, 0);
      assert.equal(w.memory.exists, true);
      w.once();
    });
  const unsafeReadStats = [
    ["NOT_FILE", { isFile: () => false }], ["DEVICE", { dev: 8n }], ["INODE", { ino: 24n }],
    ["MULTI_LINK", { nlink: 2n }], ["UNLINKED", { nlink: 0n }],
    ["OVERSIZED", { size: BigInt(Buffer.byteLength(PROBE_TEXT, "utf8")) + 1n }],
    ["VERY_LARGE", { size: BigInt(Number.MAX_SAFE_INTEGER) }], ["UNDERSIZED", { size: 1n }],
    ["EMPTY", { size: 0n }], ["INVALID_SIZE", { size: NaN }],
    ["NUMBER_DEVICE", { dev: 7 }], ["NUMBER_INODE", { ino: 23 }], ["NUMBER_IDENTITY", { dev: 7, ino: 23 }],
    ["NUMBER_LINK_COUNT", { nlink: 1 }], ["NUMBER_SIZE", { size: Buffer.byteLength(PROBE_TEXT, "utf8") }],
  ];
  for (const [name, reopenedStat] of unsafeReadStats) test("SYNTH_READ_REFUSED_" + name, () => {
    const w = build({}, { reopenedStat, readback: PRIVATE });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_WRITE_CONFIRMED", "VISIBILITY_PROBE_UNSAFE_TARGET"]);
    assert.equal(w.memory.reads, 0); // Private replacement bytes MUST NOT be requested.
    assert.equal(operations(w.memory).includes("readFileSync"), false);
    assert.equal(w.memory.descriptors.size, 0);
    assert.equal(w.memory.bytes, PROBE_TEXT);
    w.once();
  });
  for (const field of ["dev", "ino"]) test("SYNTH_READ_REFUSED_LOSSLESS_" + field.toUpperCase(), () => {
    assert.equal(Number(largeIdentity), Number(largeIdentity + 1n));
    const w = build({}, { createdStat: { [field]: largeIdentity }, reopenedStat: { [field]: largeIdentity + 1n }, readback: PRIVATE });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_WRITE_CONFIRMED", "VISIBILITY_PROBE_UNSAFE_TARGET"]);
    assert.equal(w.memory.writes, 1);
    assert.equal(w.memory.reads, 0);
    assert.equal(operations(w.memory).includes("readFileSync"), false);
    assert.equal(w.memory.descriptors.size, 0);
    assert.equal(w.memory.bytes, PROBE_TEXT);
    w.once();
  });
  for (const [index, readback] of [PRIVATE, "", PROBE_TEXT.trimEnd(), PROBE_TEXT + "\n"].entries()) test("SYNTH_READBACK_CONTENT_MISMATCH_" + index, () => {
    const w = build({}, { readback });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_WRITE_CONFIRMED", "VISIBILITY_PROBE_FAILED"]);
    assert.equal(w.memory.reads, 1);
    assert.equal(w.memory.descriptors.size, 0);
    w.once();
  });

  for (const code of IO_CODES) test("SYNTH_IO_CLASSIFICATION_" + code, () => {
    const accesses = [], w = build({}, { failures: [{ operation: "openSync", error: safeError(code, accesses) }], recordThrows: true });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(failedCodes(code));
    assert.equal(accesses.length > 0 && accesses.length <= 2, true);
    assert.equal(accesses.every(key => key === "code"), true);
    assert.equal(w.memory.reads, 0);
    assert.equal(w.memory.writes, 0);
    w.once();
  });
  const unknownCodes = ["ETIMEDOUT", "__proto__", "constructor", PRIVATE, PRIVATE.repeat(2048), 123, undefined, null,
    { toString() { throw new Error(PRIVATE); } }];
  for (const [index, code] of unknownCodes.entries()) test("SYNTH_IO_OTHER_" + index, () => {
    const accesses = [], w = build({}, { failures: [{ operation: "openSync", error: safeError(code, accesses) }] });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(failedCodes("OTHER"));
    assert.equal(accesses.length > 0 && accesses.length <= 2, true);
    assert.equal(accesses.every(key => key === "code"), true);
    w.once();
  });
  test("SYNTH_ERROR_CODE_GETTER_THROWS", () => {
    let touches = 0;
    const error = Object.defineProperty({}, "code", { get() { touches++; throw new Error(PRIVATE); } });
    const w = build({}, { failures: [{ operation: "openSync", error }], recordThrows: true });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(failedCodes("OTHER"));
    assert.equal(touches > 0 && touches <= 2, true);
    w.once();
  });
  for (const [index, error] of [null, undefined, PRIVATE, 42].entries()) test("SYNTH_THROWN_NON_ERROR_" + index, () => {
    const w = build({}, { failures: [{ operation: "openSync", error }] });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(failedCodes("OTHER"));
    w.once();
  });
  test("SYNTH_EEXIST_ONLY_DURING_CREATE", () => {
    const w = build({}, { failures: [{ operation: "openSync", nth: 2, error: safeError("EEXIST") }] });
    assert.equal(w.probe(ROOT), false);
    w.expectCodes(failedCodes("OTHER", true));
    assert.equal(w.memory.reads, 0);
    w.once();
  });
  test("SYNTH_ENUM_ONLY_NO_PAYLOAD", () => {
    assert.equal(allCases.length > 100, true);
    for (const w of allCases) {
      for (const args of w.records) {
        assert.equal(args.length, 1);
        assert.equal(typeof args[0], "string");
        assert.equal(ALLOWED_CODES.has(args[0]), true);
        assert.equal(Object.hasOwn(codes, args[0]), true);
      }
      const serialized = JSON.stringify(w.records);
      for (const secret of [ROOT, OTHER_ROOT, PROBE_ID, PROBE_TEXT, PRIVATE]) assert.equal(serialized.includes(secret), false);
    }
    assert.equal(defaultIoCalls, 0);
    assert.equal(deniedImports, 6);
  });
  test("SYNTH_NO_UNEXPECTED_FS_CAPABILITIES", () => {
    for (const w of allCases) assert.deepEqual(w.memory.violations, []);
  });
  return { passed, failed, caseCount: passed + failed };
}

module.exports = { runReview };
if (require.main === module) {
  const result = runReview();
  console.log("DIAGNOSTIC_VISIBILITY_REVIEW_RESULT " + JSON.stringify(result));
  process.exitCode = result.failed ? 1 : 0;
}
