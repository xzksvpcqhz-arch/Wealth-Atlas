/* Windows-only synthetic log-path obstruction. Do not run concurrently with
 * another packaged candidate runner: the candidate's QA sidecar is shared.
 * The original runner is transformed in memory, never edited or copied. */
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANDIDATE_VERSION } from "./build-sync-candidate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = CANDIDATE_VERSION;
let failureStage = "SYNTH_LOG_FAILURE_VALIDATION";

async function run() {
  assert.equal(process.platform, "win32");
  assert.equal(process.argv.length, 3, "Supply exactly one generated current candidate directory");
  assert.ok(process.argv[2]);
  const destination = path.resolve(process.argv[2]);
  const relative = path.relative(path.join(root, "desktop-dist", "candidates"), destination);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  const report = JSON.parse(await readFile(path.join(destination, "candidate-check.json"), "utf8"));
  assert.equal(report.version, expectedVersion);
  assert.equal(report.githubPublished, false);
  await assert.rejects(access(path.join(destination, "startup-log-failure-check.json")), { code: "ENOENT" },
    "Keep existing diagnostic reports; choose a new candidate directory rather than overwriting evidence");

  let source = (await readFile(path.join(root, "scripts", "test-sync-candidate.mjs"), "utf8")).replaceAll("\r\n", "\n");
  function unique(needle, label) {
    const first = source.indexOf(needle);
    if (!needle || first < 0 || source.indexOf(needle, first + 1) >= 0) {
      failureStage = "SYNTH_LOG_FAILURE_TRANSFORM_" + label;
      throw new Error("SYNTH_LOG_FAILURE_TRANSFORM_" + label);
    }
    return first;
  }
  function replace(needle, replacement, label) {
    const first = unique(needle, label);
    source = source.slice(0, first) + replacement + source.slice(first + needle.length);
  }
  const lines = (...items) => items.join("\n");

  // Fail closed if the original safety envelope changes. All remain intact in
  // the imported source, including refusal before any access to a used profile.
  const preserved = [
    'assert.equal(report.version, CANDIDATE_VERSION);',
    'assert.equal(report.githubPublished, false);',
    'const qaSession = randomUUID();',
    'const candidateProfile = path.join(process.env.APPDATA, "Wealth Atlas Sync Candidate", CANDIDATE_VERSION, "isolated-qa", qaSession);',
    lines('let profileExists = false;',
      'try { await access(candidateProfile); profileExists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }',
      'assert.equal(profileExists, false, "Candidate profile already exists. Refusing to inspect a possibly used account; no data was changed.");'),
    lines('const denyProxy = net.createServer(socket => socket.destroy());',
      'await new Promise((resolve, reject) => { denyProxy.once("error", reject); denyProxy.listen(0, "127.0.0.1", resolve); });'),
    '    `--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=127.0.0.1;localhost;[::1]"], { cwd: root, env, windowsHide: true, stdio: "ignore" });',
    '  const args = [`--candidate-qa-session=${qaSession}`];',
    '  checks.push(await checkRun({ exe, args, desktop: true, screenshots: true, label: "windows" }));',
    '  checks.push(await checkRun({ exe, args, desktop: true, screenshots: false, label: "windows-reopen" }));',
    '    for (const [width, height] of screenshots ? [[1440, 900], [1280, 800], [1024, 768], [390, 844], [320, 720]] : [[1440, 900]]) {',
    '    assert.equal(state.guest, true, `${label}: guest workspace`); assert.equal(state.legacy, false, `${label}: no production/owned snapshot`);',
    '  assert.equal(technical.appVersion, CANDIDATE_VERSION);',
    '  assert.equal(technical.mode, "isolated-qa");',
    '  assert.ok(technical.codes.every(code => Object.hasOwn(enumCodes, code)), "Diagnostics contain fixed enums only");',
    lines('  for (const code of ["PROFILE_USER_ROOT_MATCH", "PROFILE_SESSION_ROOT_MATCH", "PROFILE_STORAGE_ROOT_MATCH"])',
      '    assert.ok(technical.codes.includes(code), "Packaged startup confirms " + code);'),
  ];
  preserved.forEach((needle, index) => unique(needle, "SAFETY_" + index));

  replace('const probeCheckMode = "normal";', 'const probeCheckMode = "blocked";', "VISIBILITY_BLOCKER_MODE");
  replace('import { classifyCandidateQaPath, sameDirectoryIdentity } from "./candidate-qa-paths.mjs";',
    'import { classifyCandidateQaPath, sameDirectoryIdentity } from ' + JSON.stringify(pathToFileURL(path.join(root, "scripts", "candidate-qa-paths.mjs")).href) + ';', "QA_PATH_IMPORT");

  replace('import { createCandidateServer } from "./candidate-web-server.mjs";',
    'import { createCandidateServer } from ' + JSON.stringify(pathToFileURL(path.join(root, "scripts", "candidate-web-server.mjs")).href) + ';', "SERVER_IMPORT");
  replace('import { CANDIDATE_VERSION } from "./build-sync-candidate.mjs";',
    'import { CANDIDATE_VERSION } from ' + JSON.stringify(pathToFileURL(path.join(root, "scripts", "build-sync-candidate.mjs")).href) + ';', "VERSION_IMPORT");
  replace('const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
    'const root = ' + JSON.stringify(root) + ';', "ROOT");
  replace('const destination = path.resolve(process.argv[2] ?? "");',
    'const destination = ' + JSON.stringify(destination) + ';', "DESTINATION");
  replace('await mkdir(qa, { recursive: true });', lines(
    'await mkdir(qa, { recursive: true });',
    '// Exclusive mkdir also rejects a profile that appeared after the refusal check.',
    '// Missing QA parent directories fail closed; never create/adopt an old root.',
    'await mkdir(candidateProfile, { recursive: false });',
    'await writeFile(path.join(candidateProfile, "logs"), "SYNTHETIC_LOG_DIRECTORY_BLOCKER\\n", { encoding: "utf8", flag: "wx" });'), "FRESH_LOG_BLOCKER");
  replace('const checks = [];', lines('const checks = [];', 'const logFailureRunStartedAt = Date.now();'), "SIDECAR_FRESHNESS");

  replace(lines(
    '  const mainLog = await readFile(path.join(candidateProfile, "logs", "main.log"), "utf8");',
    '  assert.ok(mainLog.includes(\'"event":"update-disabled"\') && mainLog.includes(\'"reason":"isolated-test"\'));',
    '  assert.ok(!mainLog.includes(\'"event":"update-check-start"\'));',
    '  const technical = JSON.parse(await readFile(path.join(destination, "windows", "win-unpacked", "candidate-qa-startup-diagnostic.json"), "utf8"));'), lines(
    '  step = "startup-log-failure-diagnostics";',
    '  const requiredLogFailureCodes = ["LOG_INITIALIZATION_FAILED", "MAIN_LOG_WRITE_FAILED", "RENDERER_LOG_WRITE_FAILED"];',
    '  const relevantIoCodes = ["DIAGNOSTIC_IO_OTHER", "DIAGNOSTIC_IO_ENOENT"];',
    '  const sidecarPath = path.join(destination, "windows", "win-unpacked", "candidate-qa-startup-diagnostic.json");',
    '  let technical;',
    '  for (let attempt = 0; attempt < 40; attempt++) {',
    '    try {',
    '      const value = JSON.parse(await readFile(sidecarPath, "utf8"));',
    '      if (value.appVersion === CANDIDATE_VERSION && value.mode === "isolated-qa"',
    '        && Date.parse(value.startedAt) >= logFailureRunStartedAt && Array.isArray(value.codes)',
    '        && requiredLogFailureCodes.every(code => value.codes.includes(code))',
    '        && relevantIoCodes.some(code => value.codes.includes(code))) { technical = value; break; }',
    '    } catch { /* Only the generated QA sidecar may still be pending. */ }',
    '    await delay(125);',
    '  }',
    '  assert.ok(technical, "Fresh isolated sidecar must confirm the injected startup log failure");',
    '  for (const code of requiredLogFailureCodes) assert.ok(technical.codes.includes(code));',
    '  assert.ok(relevantIoCodes.some(code => technical.codes.includes(code)));'), "SIDECAR_LOG_FAILURE_ASSERTIONS");

  replace(lines(
    '  step = "mac-web-on-windows";',
    '  server = await createCandidateServer({ siteRoot: path.join(destination, "mac-web", "site"), port: 0 });',
    '  checks.push(await checkRun({ exe: path.join(root, "node_modules", "electron", "dist", "electron.exe"),',
    '    args: [path.join(root, "tests", "fixtures", "candidate-browser.cjs"), path.join(qa, "web-profile"), `http://127.0.0.1:${server.address().port}/`],',
    '    desktop: false, screenshots: true, label: "mac-web-on-windows" }));'), '', "WINDOWS_ONLY");
  replace('"local-runtime-check.json"', '"startup-log-failure-check.json"', "REPORT_NAME");
  replace('    autoUpdaterDisabled: true, archiveChecksumsVerified: true, checks, screenshots: qa,',
    '    scenario: "synthetic-startup-log-failure", logDirectoryBlocked: true, startupLogFailureDiagnosticsVerified: true,\n    realRootCauseProven: false, archiveChecksumsVerified: true, checks, screenshots: qa,', "REPORT_SCOPE");
  replace('    return { label, pass: true, normalStartup: true, blankGuest: true, secureContext: true, resourcesOk: true, viewports };',
    '    return { label, pass: true, injectedLogFailureStartup: true, blankGuest: true, secureContext: true, resourcesOk: true, viewports };', "RUN_SCOPE");
  replace(lines(
    '  console.log("Candidate local runtime QA PASS: startup/reopen, isolated blank guest, updater off, CSS/JS, five widths, archive checksums.");',
    '  console.log("Real account login, hosted two-device sync, and actual macOS remain NOT VERIFIED.");',
    '  console.log("Synthetic/blank QA screenshots: " + qa);'), lines(
    '  console.log("Injected startup log-failure QA PASS: isolated Windows startup/reopen, blank guest, CSS/JS, five widths, fixed failure diagnostics, archive checksums.");',
    '  console.log("Synthetic logs-path obstruction only; real-user root cause, account/offline recovery, hosted sync, and macOS remain NOT VERIFIED.");',
    '  console.log("Fresh synthetic QA artifacts retained; no existing profile was cleared.");'), "SUCCESS_MESSAGES");
  replace(lines(
    '  console.error("Candidate runtime QA FAILED at " + step + "; no release was published and no existing profile was cleared.");',
    '  if (error?.code === "ERR_ASSERTION") console.error(error.message);',
    '  else console.error(error?.name === "Error" ? error.message : "Local diagnostic operation failed");'),
    '  console.error("Injected startup log-failure QA FAILED at " + step + "; no release was published and no existing profile was cleared.");', "SAFE_FAILURE_MESSAGE");
  preserved.forEach((needle, index) => unique(needle, "PRESERVED_" + index));

  failureStage = "SYNTH_LOG_FAILURE_RUN";
  await import("data:text/javascript;base64," + Buffer.from(source, "utf8").toString("base64"));
}

try { await run(); }
catch {
  // Do not print raw exceptions (including dataURL stacks), paths or payloads.
  console.error("Injected startup log-failure QA FAILED: " + failureStage + "; no publication or existing-profile cleanup was requested.");
  process.exitCode = 1;
}
