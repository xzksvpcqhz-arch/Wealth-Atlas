/* Diagnostic-only matrix against an unchanged candidate. Each child receives a
 * fresh QA UUID, synthetic Auth/finance replies and a process-only deny proxy.
 * Never opens, closes or inspects the user's manual/production profile. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(process.argv[2] ?? "");
const relative = path.relative(path.join(root, "desktop-dist", "candidates"), destination);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
const manifest = JSON.parse(await readFile(path.join(destination, "candidate-check.json"), "utf8"));
assert.match(manifest.version, /^1\.7\.5-rc\.(?:10|11)$/);
assert.equal(manifest.githubPublished, false);
const exeDirectory = path.join(destination, "windows", "win-unpacked");
const cases = [
  { id: "cdp-root", close: "cdp", cwd: "project" },
  { id: "native-root", close: "window", cwd: "project" },
  { id: "native-exe", close: "window", cwd: "executable" },
  { id: "rapid-native-exe", close: "window", cwd: "executable", rapid: true },
  { id: "forced-exit-exe", close: "terminate", cwd: "executable", rapid: true },
  { id: "forced-exit-settled", close: "terminate", cwd: "executable", rapid: true, settleMs: 8000 },
  { id: "natural-start-exe", close: "window", cwd: "executable", rapid: true, natural: true },
  { id: "native-ui-x", close: "external", cwd: "executable", rapid: true, natural: true, offlineBeforeClose: true },
  { id: "overlapping-profile", close: "window", cwd: "executable", overlap: true },
];
const reportName = "rc10-adversarial-case.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originalSource = await readFile(path.join(root, "scripts", "test-candidate-offline-cold.mjs"), "utf8");
const sourceHash = sha(originalSource);

function replaceOne(source, needle, replacement) {
  const first = source.indexOf(needle);
  assert.ok(first >= 0 && source.indexOf(needle, first + needle.length) < 0, "Test template changed; no unsafe fallback is allowed");
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

async function runCase(config, runToken) {
  const label = `adv-${config.id}-${runToken.slice(0, 8)}`;
  const outputPath = path.join(destination, `offline-cold-check-${label}.json`);
  let source = originalSource;
  source = replaceOne(source, 'import { spawn } from "node:child_process";', 'import { spawn, execFileSync } from "node:child_process";');
  source = replaceOne(source, 'const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");', `const root = ${JSON.stringify(root)};`);
  source = replaceOne(source, 'const destination = path.resolve(process.argv[2] ?? "");', `const destination = ${JSON.stringify(destination)};`);
  source = replaceOne(source, 'const runLabel = process.argv[3];', `const runLabel = ${JSON.stringify(label)};`);
  source = replaceOne(source, 'const checks = [];', `const checks = []; const adversarial = ${JSON.stringify(config)}; const observations = []; const closes = []; let peer = null; let views = 0; let externalCloseEligible = false; let externalCloseRequested = false;`);
  source = replaceOne(source, '{ cwd: root, env, windowsHide: true, stdio: "ignore" }', `{ cwd: ${JSON.stringify(config.cwd === "executable" ? exeDirectory : root)}, env, windowsHide: ${config.close !== "external"}, stdio: "ignore" }`);

  // Normal-login controls intentionally omit only the pre-existing injected
  // write-failure scenario. The original script and its assertions stay intact.
  const faultStart = source.indexOf('  await running.evaluate("window.__qaRejectAuthWrites = true");');
  const faultEnd = source.indexOf('  await running.evaluate("window.__qaRejectAuthWrites = false");', faultStart);
  const successSubmit = source.indexOf('  await running.evaluate(`document.querySelector(".cloud-form").requestSubmit()`);', faultEnd);
  assert.ok(faultStart > 0 && faultEnd > faultStart && successSubmit > faultEnd);
  source = source.slice(0, faultStart) + source.slice(successSubmit);
  const storageHook = /    const set = Storage\.prototype\.setItem;[\s\S]*?\n    };\n/;
  assert.equal((source.match(storageHook) ?? []).length > 0, true);
  source = source.replace(storageHook, "");
  if (config.close === "external") {
    // Visible native windows can paint before asynchronous startup navigation
    // settles. Poll navigation as well as the selector, without bypassing Auth.
    source = replaceOne(source,
      '  await until(() => running.evaluate(`Boolean(document.querySelector("input[type=email]"))`), "synthetic login form");',
      '  await until(async () => { await running.evaluate(settings); return await running.evaluate(`Boolean(document.querySelector("input[type=email]"))`); }, "synthetic login form");');
  }

  if (config.natural) {
    source = replaceOne(source, '"--candidate-qa-first-document",', '');
    source = replaceOne(source, 'item.type === "page" && item.url === "about:blank"', 'item.type === "page" && item.url === "wealth-atlas://app/"');
    source = replaceOne(source, '  await cdp.send("Page.navigate", { url: "wealth-atlas://app/" });', '  // No pause, navigation or reload: inspect the original production document.');
    source = replaceOne(source, 'window.__qaColdDocument === ${JSON.stringify(documentMarker)} && Boolean(document.querySelector(".app-shell"))', 'Boolean(document.querySelector(".app-shell"))');
  }

  const closeCommand = config.close === "external"
    ? `if (externalCloseEligible && !externalCloseRequested) {
        externalCloseRequested = true;
        const title = ${JSON.stringify("Wealth Atlas ISOLATED QA native-X " + label)};
        await evaluate("document.title = " + JSON.stringify(title));
        await writeFile(path.join(path.dirname(process.argv[1]), "native-close-ready.json"), JSON.stringify({ stage: "await-native-x", version: report.version, pid: child.pid, title }));
        while (child.exitCode === null) await delay(100);
      } else { void cdp.send("Browser.close").catch(() => {}); }`
    : config.close === "window"
    ? 'void cdp.send("Runtime.evaluate", { expression: "window.close()", userGesture: true }).catch(() => {});'
    : config.close === "terminate"
      ? 'if (child.exitCode === null && Number.isInteger(child.pid)) execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });'
      : 'void cdp.send("Browser.close").catch(() => {});';
  source = replaceOne(source, '    void cdp.send("Browser.close").catch(() => {});', `    ${closeCommand}`);
  source = replaceOne(source, '    cdp.socket.close(); if (child.exitCode === null) child.kill();', '    const fallbackKill = child.exitCode === null; cdp.socket.close(); if (fallbackKill) child.kill(); closes.push({ requested: adversarial.close, fallbackKill });');
  source = replaceOne(source, 'async function financialView() {', 'async function financialView() {\n  views++; if (adversarial.rapid && views === 1) return;');

  const checkpoint = `async function adversarialCheckpoint(stage) {
    const auth = await running.evaluate(
      "(() => { const names = Object.keys(localStorage).filter(k => /^sb-.*-auth-token$/.test(k)); return { cacheKeys: names.length, validSyntheticSession: names.some(k => { try { const s = JSON.parse(localStorage.getItem(k)); return s?.user?.id === '55555555-5555-4555-8555-555555555555' && typeof s.refresh_token === 'string'; } catch { return false; } }) }; })()");
    const rows = await running.evaluate(readQaRows);
    let startup = null; try { const s = JSON.parse(await readFile(path.join(profile, 'logs', 'startup.json'), 'utf8')); startup = { version: s.appVersion, startedAt: s.startedAt, status: s.status }; } catch {}
    observations.push({ stage, ...auth,
      ownedRows: rows.filter(r => r.id === 'profile:v1:cloud:' + user.id).length,
      receiptRows: rows.filter(r => r.id === 'auth-verified:v1:' + user.id).length,
      startup });
  }
`;
  source = replaceOne(source, 'let running;', 'let running;\n' + checkpoint);
  source = replaceOne(source, '  checks.push({ name: "online seed uses shipped SDK and real localStorage/IndexedDB", pass: true });', '  checks.push({ name: "online seed uses shipped SDK and real localStorage/IndexedDB", pass: true });\n  await adversarialCheckpoint("before-close");\n  if (adversarial.offlineBeforeClose) { online = false; await running.evaluate(`window.__qaNetworkOnline = false; window.dispatchEvent(new Event("offline"))`); }\n  externalCloseEligible = true;\n  if (adversarial.settleMs) await delay(adversarial.settleMs);');
  source = replaceOne(source, '  await delay(12000); await running.evaluate(settings);', '  await delay(12000); await running.evaluate(settings);\n  await adversarialCheckpoint("offline-reopen");');
  if (config.overlap) {
    source = replaceOne(source, '  await running.close(); running = null;\n  online = false;\n  running = await launch();', '  peer = running;\n  online = false;\n  running = await launch();');
  }

  // Each diagnostic case tests login -> this close/start path -> offline view
  // -> reconnect. The full expiry/race suite remains in the original runner.
  const extendedStart = source.indexOf("  // Close again, cross the token's expiry");
  const extendedEnd = source.indexOf('  assert.equal(unexpected, 0, "No unhandled synthetic HTTP endpoints");', extendedStart);
  assert.ok(extendedStart > 0 && extendedEnd > extendedStart);
  source = source.slice(0, extendedStart) + source.slice(extendedEnd);
  source = replaceOne(source, '{ status: "PASS", version: report.version, checks,', '{ status: "PASS", version: report.version, checks, adversarial, observations, closes,');
  source = replaceOne(source, '{ status: "FAIL", version: report.version, checks,', '{ status: "FAIL", version: report.version, checks, adversarial, observations, closes,');
  source = replaceOne(source, '} finally { if (running) await running.close(); await new Promise(resolve => denyProxy.close(resolve)); }', '} finally { if (running) await running.close(); if (peer) await peer.close(); await new Promise(resolve => denyProxy.close(resolve)); }');
  try { await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`); }
  catch { console.error("Adversarial runner failed outside its assertions; no private exception detail was printed."); process.exitCode = 1; }
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  if (config.close === "external") {
    let confirmed = false;
    try {
      const proof = JSON.parse(await readFile(path.join(path.dirname(process.argv[1]), "native-close-confirmation.json"), "utf8"));
      confirmed = proof.action === "native-x" && proof.runToken === runToken && proof.version === manifest.version;
    } catch { /* A missing external observation can never become a native-X PASS. */ }
    report.exerciseStatus = confirmed ? "NATIVE_X_OBSERVED" : "INCONCLUSIVE_NATIVE_CLOSE_UNCONFIRMED";
  }
  if (report.closes?.some(item => item.fallbackKill) && config.close !== "terminate") report.exerciseStatus = "INCONCLUSIVE_CLOSE_FALLBACK";
  await writeFile(path.join(path.dirname(process.argv[1]), reportName), JSON.stringify({ id: config.id, resultFile: outputPath, ...report }, null, 2));
  return report;
}

if (process.argv[3] === "--case") {
  const config = cases.find(c => c.id === process.argv[4]);
  assert.ok(config);
  const token = process.argv[5];
  assert.match(token ?? "", /^[0-9a-f-]{36}$/);
  // A parent-owned scratch result path, never a directory supplied by an app.
  const resultDirectory = path.resolve(process.argv[6] ?? "");
  const workRoot = path.join(root, "work", "adversarial-results");
  assert.ok(resultDirectory.startsWith(workRoot + path.sep));
  const argvScript = process.argv[1];
  try {
    // Keep runCase's small result beside this parent-created marker path.
    process.argv[1] = path.join(resultDirectory, "case-runner.mjs");
    await runCase(config, token);
  } finally { process.argv[1] = argvScript; }
} else {
  const token = randomUUID();
  const runRoot = path.join(root, "work", "adversarial-results", token);
  await mkdir(runRoot, { recursive: true });
  const selected = process.argv[3] ? cases.filter(c => c.id === process.argv[3]) : cases;
  assert.ok(selected.length);
  const results = [];
  async function execute(config) {
    const directory = path.join(runRoot, config.id); await mkdir(directory);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), destination, "--case", config.id, token, directory],
      { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // This PID is the exact child Node case created above. Its descendants
        // are only that case's fresh-UUID Electron processes, never the user app.
        if (child.exitCode === null) {
          try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch {}
        }
        resolve("CASE_TIMEOUT");
      }, config.close === "external" ? 600000 : 150000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", exitCode => { clearTimeout(timer); resolve(exitCode); });
    });
    let result;
    try { result = JSON.parse(await readFile(path.join(directory, reportName), "utf8")); }
    catch { result = { id: config.id, status: "INCONCLUSIVE", runnerExit: code }; }
    results.push(result);
    console.log(JSON.stringify({ id: config.id, status: result.status, exerciseStatus: result.exerciseStatus ?? "REQUESTED_PATH_EXERCISED", checks: result.checks?.length ?? 0, observations: result.observations ?? [], closes: result.closes ?? [] }));
  }
  // Two independent UUID profiles at a time; a deliberate overlap case is
  // confined to its own fresh UUID and never the manual rc.5 directory.
  for (let i = 0; i < selected.length; i += 2) await Promise.all(selected.slice(i, i + 2).map(execute));
  const summary = { version: manifest.version, unchangedCandidate: true, originalTestSourceHash: sourceHash,
    productionCodeChanged: false, realProfileAccessed: false, hostedRequestsSent: false,
    actualUserFailureStillUnresolved: true, cases: results };
  await writeFile(path.join(runRoot, "matrix.json"), JSON.stringify(summary, null, 2));
  console.log("Adversarial matrix saved: " + path.join(runRoot, "matrix.json"));
}
