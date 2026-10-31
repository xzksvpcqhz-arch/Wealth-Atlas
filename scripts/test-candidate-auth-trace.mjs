/* rc.12 DIAGNOSTIC ONLY. Run sequentially AFTER packaging: QA sidecars are
 * shared beside the EXE. The complete offline-cold harness is imported through
 * unique in-memory transforms, never edited, copied to disk, or shortened. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = "1.7.5-rc.12";
const sourceFiles = [
  "lib/password-recovery.ts", "lib/supabase-client.ts", "lib/cloud-sync.ts", "lib/auth-session.ts",
  "lib/auth-storage.ts", "lib/auth-diagnostics.ts", "lib/storage.ts", "lib/account-boundary.ts",
  "lib/login-history.ts", "lib/use-cloud-sync.ts", "components/CloudSyncPanel.tsx", "app/globals.css",
  "desktop/main.cjs", "desktop/preload.cjs", "desktop/auth-diagnostic-codes.json",
  "desktop/candidate-diagnostics.cjs", "desktop/startup-diagnostics.cjs", "desktop/auth-trace.cjs",
];
const extraSourceFiles = ["scripts/test-candidate-offline-cold.mjs", "scripts/candidate-bootstrap.cjs",
  "desktop/updater.cjs", "desktop/data-profiles.cjs", "scripts/test-candidate-auth-trace.mjs"];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
let stage = "RC12_VALIDATE", resultPath, resultWritten = false;
let harnessChecks = 0, harnessCompleted = false, launches = 0, closes = 0, forcedCloses = 0;
let uncleanExits = 0;
let checkpoints = 0, transforms = 0, sourceUnchanged = false, removeExercised = false;
let seedBoot, seedClosedBoot, offlineBootId;
let seedWrites = 0, seedRemoves = 0, reconnectReads = 0;

function exact(value, keys) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function integer(value) { assert.ok(Number.isSafeInteger(value) && value >= 0); }
function iso(value) {
  assert.equal(typeof value, "string"); assert.equal(value.length, 24);
  assert.ok(Number.isFinite(Date.parse(value))); assert.equal(new Date(value).toISOString(), value);
}
async function ordinary(file, maxBytes = 1024 * 1024) {
  const stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maxBytes);
  // Reject redirected ancestors too. Never follow a candidate/source link into
  // a profile, credentials, excluded tree, or another artifact.
  assert.ok(samePath(await realpath(file), file));
  const bytes = await readFile(file);
  assert.ok(bytes.length <= maxBytes);
  return bytes;
}
function fixedSummary(pass) {
  return { code: pass ? "RC12_AUTH_TRACE_PASS" : "RC12_AUTH_TRACE_FAIL", stage,
    originalChecks: harnessChecks, launches, closes, forcedCloses, uncleanExits, checkpoints, transforms,
    sourceHashesUnchanged: sourceUnchanged, sharedBootIdVerified: checkpoints >= 1,
    previousCloseJoined: checkpoints >= 3, firstReadEmptyVerified: Boolean(seedBoot),
    firstReadPresentVerified: reconnectReads > 0, seedWriteConfirmations: seedWrites,
    seedRemoveConfirmations: seedRemoves, removeExercised,
    isolatedProfileOnly: true, simulatedSdkHttp: true, denyProxy: true,
    hostedRequestsSent: false, realProfileAccessed: false, pageReloads: 0,
    nativeXVerified: false, physicalOfflineVerified: false, diskDurabilityProven: false,
    realRootCauseProven: false };
}
async function emitResult(pass) {
  const value = fixedSummary(pass);
  if (resultPath && !resultWritten) {
    await writeFile(resultPath, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    resultWritten = true;
  }
  (pass ? console.log : console.error)(JSON.stringify(value));
}

async function run() {
  assert.equal(process.platform, "win32");
  assert.equal(process.argv.length, 3); assert.ok(process.argv[2]);
  const destination = path.resolve(process.argv[2]);
  const candidates = path.join(root, "desktop-dist", "candidates");
  assert.ok(samePath(path.dirname(destination), candidates));
  assert.match(path.basename(destination), /^v1\.7\.5-rc\.12-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  for (const directory of [candidates, destination, path.join(destination, "windows"),
    path.join(destination, "windows", "win-unpacked")]) {
    const stat = await lstat(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.ok(samePath(await realpath(directory), directory));
  }
  const manifestPath = path.join(destination, "candidate-check.json");
  const manifestBytes = await ordinary(manifestPath, 64 * 1024);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.version, version); assert.equal(manifest.githubPublished, false);
  assert.equal(manifest.status, "BUILT_FOR_MANUAL_TEST");
  assert.equal(manifest.candidatePurpose, "auth-persistence-timeline-diagnostics");
  assert.equal(manifest.autoUpdatesEnabled, false); assert.equal(manifest.financialDataIncluded, false);
  exact(manifest.sourceFileHashes, sourceFiles);
  const originals = new Map();
  for (const file of [...sourceFiles, ...extraSourceFiles]) {
    const bytes = await ordinary(path.join(root, file));
    originals.set(file, bytes);
    if (sourceFiles.includes(file)) {
      assert.match(manifest.sourceFileHashes[file], /^[a-f0-9]{64}$/);
      assert.equal(sha(bytes), manifest.sourceFileHashes[file]);
    }
  }
  const exeDirectory = path.join(destination, "windows", "win-unpacked");
  const asar = path.join(exeDirectory, "resources", "app.asar");
  const asarStat = await lstat(asar);
  assert.ok(asarStat.isFile() && !asarStat.isSymbolicLink() && asarStat.nlink === 1);
  assert.ok(samePath(await realpath(asar), asar));
  const { extractFile } = createRequire(import.meta.url)("@electron/asar");
  const embedded = JSON.parse(extractFile(asar, "package.json").toString("utf8"));
  assert.equal(embedded.version, version); assert.equal(embedded.main, "desktop/candidate-bootstrap.cjs");
  assert.equal(embedded.wealthAtlasCandidate, "cloud-sync-test");
  assert.equal(embedded.wealthAtlasCandidateProfileVersion, manifest.profileVersion);
  for (const file of [...sourceFiles.filter(file => file.startsWith("desktop/")),
    "desktop/updater.cjs", "desktop/data-profiles.cjs"]) {
    assert.ok(extractFile(asar, path.normalize(file)).equals(originals.get(file)));
  }
  assert.ok(extractFile(asar, path.normalize("desktop/candidate-bootstrap.cjs"))
    .equals(originals.get("scripts/candidate-bootstrap.cjs")));
  const codes = JSON.parse(originals.get("desktop/auth-diagnostic-codes.json").toString("utf8"));
  assert.ok(Object.keys(codes).length > 0 && Object.keys(codes).length <= 256);
  assert.ok(Object.entries(codes).every(([code, enabled]) => /^[A-Z][A-Z0-9_]{0,79}$/.test(code) && enabled === true));
  const allowedCode = code => typeof code === "string" && Object.hasOwn(codes, code);
  const runLabel = "rc12-trace-" + randomUUID();
  assert.match(runLabel, /^[a-z0-9-]{1,48}$/);
  const newResultPath = path.join(destination, `offline-cold-check-${runLabel}.json`);
  await assert.rejects(lstat(newResultPath), { code: "ENOENT" });
  resultPath = newResultPath;
  const startedAt = Date.now();

  function validateTrace(value) {
    exact(value, ["format", "formatVersion", "boots"]);
    assert.equal(value.format, "wealth-atlas-auth-trace"); assert.equal(value.formatVersion, 1);
    assert.ok(Array.isArray(value.boots) && value.boots.length >= 1 && value.boots.length <= 2);
    const ids = new Set();
    for (const boot of value.boots) {
      exact(boot, ["bootId", "appVersion", "mode", "startedAt", "events", "omitted"]);
      assert.equal(typeof boot.bootId, "string"); assert.match(boot.bootId, uuid);
      assert.ok(!ids.has(boot.bootId)); ids.add(boot.bootId);
      assert.equal(boot.appVersion, version); assert.equal(boot.mode, "isolated-qa"); iso(boot.startedAt);
      integer(boot.omitted);
      assert.ok(Array.isArray(boot.events) && boot.events.length > 0 && boot.events.length <= 64);
      if (boot.omitted > 0) assert.equal(boot.events.length, 64);
      let elapsed = 0;
      for (const [index, event] of boot.events.entries()) {
        exact(event, ["seq", "code", "elapsedMs"]);
        integer(event.seq); integer(event.elapsedMs); assert.ok(allowedCode(event.code));
        assert.equal(event.seq, index + 1 + (index < 8 ? 0 : boot.omitted));
        assert.ok(event.elapsedMs >= elapsed); elapsed = event.elapsedMs;
        if (index > 0 && !(index === 8 && boot.omitted > 0))
          assert.notEqual(event.code, boot.events[index - 1].code);
      }
      assert.equal(boot.events[0].code, "AUTH_RUNTIME_STARTED");
      assert.equal(boot.events.at(-1).seq, boot.events.length + boot.omitted);
    }
  }
  function has(boot, code) { return boot.events.some(event => event.code === code); }
  function lifecycle(boot) {
    for (const code of ["CANDIDATE_WINDOW_CLOSE_REQUESTED", "CANDIDATE_WINDOW_CLOSED",
      "CANDIDATE_APP_BEFORE_QUIT", "CANDIDATE_APP_WILL_QUIT"]) assert.ok(has(boot, code));
    const index = code => boot.events.findIndex(event => event.code === code);
    assert.ok(index("CANDIDATE_WINDOW_CLOSE_REQUESTED") < index("CANDIDATE_WINDOW_CLOSED"));
    assert.ok(index("CANDIDATE_APP_BEFORE_QUIT") < index("CANDIDATE_APP_WILL_QUIT"));
  }
  function storage(boot) {
    // For checkpoint conclusions require a complete, untruncated window. No
    // inference about missing remove/read activity from a retained tail alone.
    assert.equal(boot.omitted, 0);
    let pending = 0, removes = 0, writes = 0;
    for (const event of boot.events) {
      if (event.code === "AUTH_STORAGE_REMOVE_REQUESTED") { assert.equal(pending, 0); pending++; }
      if (event.code === "AUTH_STORAGE_REMOVE_CONFIRMED") { assert.equal(pending, 1); pending--; removes++; }
      if (event.code === "AUTH_STORAGE_WRITE_CONFIRMED") writes++;
      assert.notEqual(event.code, "AUTH_STORAGE_REMOVE_FAILED");
      assert.notEqual(event.code, "AUTH_STORAGE_TRACE_LIMIT_REACHED");
    }
    assert.equal(pending, 0);
    return { removes, writes };
  }
  async function snapshot() {
    const trace = JSON.parse((await ordinary(path.join(exeDirectory, "candidate-qa-auth-trace.json"), 64 * 1024)).toString("utf8"));
    const startup = JSON.parse((await ordinary(path.join(exeDirectory, "candidate-qa-startup-diagnostic.json"), 64 * 1024)).toString("utf8"));
    validateTrace(trace);
    exact(startup, ["appVersion", "bootId", "startedAt", "mode", "codes"]);
    assert.equal(startup.appVersion, version); assert.equal(startup.mode, "isolated-qa");
    assert.equal(typeof startup.bootId, "string"); assert.match(startup.bootId, uuid); iso(startup.startedAt);
    assert.ok(Date.parse(startup.startedAt) >= startedAt);
    assert.ok(Array.isArray(startup.codes) && startup.codes.length <= Object.keys(codes).length);
    assert.ok(startup.codes.every(allowedCode)); assert.equal(new Set(startup.codes).size, startup.codes.length);
    const current = trace.boots.at(-1);
    assert.equal(current.bootId, startup.bootId); // EXACT shared random ID, not merely two valid UUIDs.
    assert.ok(Date.parse(current.startedAt) >= startedAt);
    for (const code of ["AUTH_TRACE_WRITE_FAILED", "PROFILE_CONTEXT_CHECK_FAILED", "PROFILE_USER_ROOT_MISMATCH",
      "PROFILE_SESSION_ROOT_MISMATCH", "PROFILE_STORAGE_ROOT_MISMATCH", "PROFILE_STORAGE_ROOT_UNAVAILABLE"]) {
      assert.ok(!startup.codes.includes(code)); assert.ok(!has(current, code));
    }
    for (const code of ["AUTH_RUNTIME_STARTED", "PROFILE_CHECK_BEFORE_READY", "PROFILE_CHECK_READY",
      "PROFILE_USER_ROOT_MATCH", "PROFILE_SESSION_ROOT_MATCH", "PROFILE_STORAGE_ROOT_MATCH"]) {
      assert.ok(startup.codes.includes(code)); assert.ok(has(current, code));
    }
    return { trace, current };
  }
  async function checkpoint(code, check) {
    stage = code;
    // Async IPC and non-atomic technical JSON writes may still be settling.
    // Each checkpoint gets at most 40 reads, <=64 KiB/file, and 5 s of delays.
    for (let attempt = 0; attempt < 40; attempt++) {
      try { const value = await snapshot(); const result = check(value); checkpoints++; return result; }
      catch { /* Deliberately discard raw assertions, technical contents, paths and stacks. */ }
      if (attempt < 39) await delay(125);
    }
    throw new Error(code);
  }
  const hooks = {
    async refuseResult(actual) {
      assert.equal(actual, resultPath); await assert.rejects(access(actual), { code: "ENOENT" });
    },
    launched(child) { launches++; child.once("error", () => { stage = "RC12_SPAWN_FAILED"; }); },
    closed(exited, exitCode) {
      closes++; if (!exited) forcedCloses++;
      if (!exited || exitCode !== 0) { uncleanExits++; stage = "RC12_CLOSE_NOT_CLEAN"; }
    },
    async seed() {
      await checkpoint("RC12_SEED_TRACE", ({ current }) => {
        assert.ok(has(current, "AUTH_STORAGE_FIRST_READ_EMPTY"));
        assert.ok(!has(current, "AUTH_STORAGE_FIRST_READ_PRESENT"));
        assert.ok(has(current, "AUTH_STORAGE_WRITE_FAILED"));
        const counts = storage(current); assert.ok(counts.writes > 0);
        seedBoot = current; seedWrites = counts.writes; seedRemoves = counts.removes;
        removeExercised = counts.removes > 0;
      });
    },
    async seedClosed() {
      await checkpoint("RC12_SEED_CLOSED_TRACE", ({ current }) => {
        assert.equal(closes, 1); assert.equal(forcedCloses, 0); assert.equal(uncleanExits, 0);
        assert.equal(current.bootId, seedBoot.bootId); lifecycle(current); storage(current);
        assert.deepEqual(current.events.slice(0, seedBoot.events.length), seedBoot.events);
        seedClosedBoot = current;
      });
    },
    async offlineReopen() {
      await checkpoint("RC12_OFFLINE_REOPEN_TRACE", ({ trace, current }) => {
        assert.equal(trace.boots.length, 2); assert.notEqual(current.bootId, seedClosedBoot.bootId);
        assert.deepEqual(trace.boots[0], seedClosedBoot); lifecycle(trace.boots[0]);
        assert.ok(has(current, "AUTH_SDK_DEFERRED_OFFLINE")); assert.ok(has(current, "OFFLINE_PROOF_ACCEPTED"));
        // Offline proof intentionally precedes SDK construction. An adapter read
        // is asserted after the ORIGINAL reconnect, not manufactured offline.
        assert.ok(!has(current, "AUTH_STORAGE_FIRST_READ_EMPTY"));
        assert.ok(!has(current, "AUTH_STORAGE_FIRST_READ_PRESENT")); storage(current);
        offlineBootId = current.bootId;
      });
    },
    async reconnected() {
      await checkpoint("RC12_RECONNECT_FIRST_READ", ({ current }) => {
        assert.equal(current.bootId, offlineBootId);
        assert.ok(has(current, "AUTH_STORAGE_FIRST_READ_PRESENT"));
        assert.ok(!has(current, "AUTH_STORAGE_FIRST_READ_EMPTY")); storage(current);
        reconnectReads = current.events.filter(event => event.code === "AUTH_STORAGE_FIRST_READ_PRESENT").length;
      });
    },
    completed(checks) { harnessChecks = checks.length; harnessCompleted = true; },
    failed(checks) { harnessChecks = checks.length; stage = stage.startsWith("RC12_") ? stage : "RC12_HARNESS"; },
  };
  const bridgeKey = "__rc12AuthTrace_" + randomUUID();
  let source = originals.get("scripts/test-candidate-offline-cold.mjs").toString("utf8").replaceAll("\r\n", "\n");
  function unique(needle) {
    const first = source.indexOf(needle);
    assert.ok(needle && first >= 0 && source.indexOf(needle, first + 1) < 0);
    return first;
  }
  function replace(needle, replacement) {
    stage = "RC12_TRANSFORM";
    const first = unique(needle);
    source = source.slice(0, first) + replacement + source.slice(first + needle.length); transforms++;
  }
  const preserved = [
    'assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));',
    'assert.equal(report.githubPublished, false);', 'const qaSession = randomUUID();',
    'const profile = path.join(process.env.APPDATA, "Wealth Atlas Sync Candidate", report.version, "isolated-qa", qaSession);',
    'await assert.rejects(access(profile), { code: "ENOENT" });',
    'const denyProxy = net.createServer((socket) => socket.destroy());',
    '    `--candidate-qa-session=${qaSession}`, "--candidate-qa-first-document", `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`,',
    '    `--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=<-loopback>",',
    '  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] });',
    '      if (!online) return void await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "InternetDisconnected" });',
    '      if (url.pathname === "/auth/v1/token") return void await reply(session());',
    '    void cdp.send("Browser.close").catch(() => {});',
    '    cdp.socket.close(); if (child.exitCode === null) child.kill();',
    '  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [320, 720]]) {',
    '  assert.equal(unexpected, 0, "No unhandled synthetic HTTP endpoints");',
  ];
  preserved.forEach(unique);
  // Preserve every original assertion-bearing line, including duplicates, and
  // every check. Only path binding, report plumbing and observation hooks change.
  const assertionLines = source.split("\n").filter(line => /\bassert\./.test(line));
  const checkLines = source.split("\n").filter(line => line.includes("checks.push("));
  replace('const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
    'const root = ' + JSON.stringify(root) + ';\nconst authTraceHooks = globalThis[' + JSON.stringify(bridgeKey) + '];');
  replace('const destination = path.resolve(process.argv[2] ?? "");', 'const destination = ' + JSON.stringify(destination) + ';');
  replace('const runLabel = process.argv[3];', 'const runLabel = ' + JSON.stringify(runLabel) + ';');
  const resultLine = 'const resultPath = path.join(destination, runLabel ? `offline-cold-check-${runLabel}.json` : "offline-cold-check.json");';
  replace(resultLine, resultLine + '\nawait authTraceHooks.refuseResult(resultPath);');
  const reportLine = 'assert.equal(report.githubPublished, false);';
  replace(reportLine, reportLine + '\nassert.equal(report.version, "1.7.5-rc.12");');
  const spawnEnd = '  ], { cwd: root, env, windowsHide: true, stdio: "ignore" });';
  replace(spawnEnd, spawnEnd + '\n  authTraceHooks.launched(child);');
  const closeLine = '    cdp.socket.close(); if (child.exitCode === null) child.kill();';
  replace(closeLine, '    authTraceHooks.closed(child.exitCode !== null, child.exitCode);\n' + closeLine);
  const seedLine = '  checks.push({ name: "online seed uses shipped SDK and real localStorage/IndexedDB", pass: true });';
  replace(seedLine, seedLine + '\n  await authTraceHooks.seed();');
  const firstClose = '  await running.close(); running = null;\n  online = false;\n  running = await launch();';
  replace(firstClose, '  await running.close(); running = null;\n  await authTraceHooks.seedClosed();\n  online = false;\n  running = await launch();');
  const offlineLine = '  checks.push({ name: "separate-process offline cold start retains exact workspace", pass: true });';
  replace(offlineLine, offlineLine + '\n  await authTraceHooks.offlineReopen();');
  const reconnectLine = '  checks.push({ name: "reconnect verifies and retains exact snapshot without duplication", pass: true });';
  replace(reconnectLine, reconnectLine + '\n  await authTraceHooks.reconnected();');
  const originalEnding = `  await writeFile(resultPath, JSON.stringify({ status: "PASS", version: report.version, checks,
    isolatedProfile: true, defaultSdkStorage: true, denyProxy: true, firstApplicationDocument: true, pageReloads: 0,
    hostedRequestsSent: false, realProfileAccessed: false }, null, 2) + "\\n");
  console.log("Packaged synthetic offline cold-start PASS: " + JSON.stringify(checks));
} catch (error) {
  console.error("Packaged synthetic offline cold-start FAIL: " + error.message);
  console.error("Completed synthetic checks: " + JSON.stringify(checks));
  await writeFile(resultPath, JSON.stringify({ status: "FAIL", version: report.version, checks,
    failure: error.message, hostedRequestsSent: false, realProfileAccessed: false }, null, 2) + "\\n");
  process.exitCode = 1;
} finally { if (running) await running.close(); await new Promise(resolve => denyProxy.close(resolve)); }`;
  replace(originalEnding, `  authTraceHooks.completed(checks);
} catch {
  authTraceHooks.failed(checks);
  process.exitCode = 1;
} finally { if (running) await running.close(); await new Promise(resolve => denyProxy.close(resolve)); }`);
  preserved.forEach(unique);
  const occurrences = (text, line) => text.split(line).length - 1;
  const baseline = originals.get("scripts/test-candidate-offline-cold.mjs").toString("utf8").replaceAll("\r\n", "\n");
  for (const line of [...assertionLines, ...checkLines])
    assert.equal(occurrences(source, line), occurrences(baseline, line));

  globalThis[bridgeKey] = hooks;
  stage = "RC12_HARNESS";
  try {
    await import("data:text/javascript;base64," + Buffer.from(source, "utf8").toString("base64"));
  } finally {
    delete globalThis[bridgeKey];
    // Check raw bytes (not newline-normalized input) on success AND failure.
    for (const [file, bytes] of originals)
      assert.equal(sha(await ordinary(path.join(root, file))), sha(bytes));
    assert.ok((await ordinary(manifestPath, 64 * 1024)).equals(manifestBytes));
    sourceUnchanged = true;
  }
  assert.ok(harnessCompleted); assert.equal(harnessChecks, 9);
  assert.equal(launches, 5); assert.equal(closes, 5); assert.equal(forcedCloses, 0);
  assert.equal(uncleanExits, 0);
  await checkpoint("RC12_FINAL_TRACE", ({ trace }) => {
    assert.equal(trace.boots.length, 2);
    for (const boot of trace.boots) lifecycle(boot);
  });
  stage = "RC12_COMPLETE";
  await emitResult(true);
}

try { await run(); }
catch {
  // Never echo an assertion, SDK/provider error, path, file contents or data-URL
  // module stack. Exclusive write failure must not replace earlier evidence.
  process.exitCode = 1;
  try { await emitResult(false); }
  catch { console.error(JSON.stringify({ code: "RC12_AUTH_TRACE_FAIL", stage: "RC12_RESULT_WRITE_REFUSED" })); }
}
