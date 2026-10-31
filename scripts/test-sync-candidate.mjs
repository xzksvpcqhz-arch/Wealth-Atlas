import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, access, lstat, realpath, open } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCandidateServer } from "./candidate-web-server.mjs";
import { CANDIDATE_VERSION } from "./build-sync-candidate.mjs";
import { classifyCandidateQaPath, sameDirectoryIdentity } from "./candidate-qa-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(process.argv[2] ?? "");
const relative = path.relative(path.join(root, "desktop-dist", "candidates"), destination);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Only a generated candidate directory is accepted");
const reportPath = path.join(destination, "candidate-check.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(report.version, CANDIDATE_VERSION);
assert.equal(report.githubPublished, false);
assert.equal(report.candidatePurpose, "profile-log-visibility-diagnostics");
assert.match(report.visibilityProbeId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const runtimeReportPath = path.join(destination, "local-runtime-check.json");
await assert.rejects(access(runtimeReportPath), { code: "ENOENT" }, "Keep previous runtime evidence intact");
// The failure-injection wrapper changes only this test constant in memory.
const probeCheckMode = "normal";
const markerText = "WEALTH_ATLAS_FIXED_VISIBILITY_PROBE_V1\n";
const runStartedAt = Date.now();
const processCloses = [];
const markerFileViews = new Set();
for (const file of ["lib/password-recovery.ts", "lib/supabase-client.ts", "lib/cloud-sync.ts", "lib/auth-session.ts", "lib/auth-storage.ts", "lib/auth-diagnostics.ts", "lib/storage.ts", "lib/account-boundary.ts", "lib/login-history.ts", "lib/use-cloud-sync.ts", "components/CloudSyncPanel.tsx", "app/globals.css", "desktop/main.cjs", "desktop/preload.cjs", "desktop/auth-diagnostic-codes.json", "desktop/candidate-diagnostics.cjs", "desktop/startup-diagnostics.cjs", "desktop/auth-trace.cjs", "desktop/diagnostic-visibility.cjs"]) {
  assert.equal(createHash("sha256").update(await readFile(path.join(root, file))).digest("hex"), report.sourceFileHashes?.[file], "Candidate source changed since packaging; build a fresh candidate, without overwriting old files");
}
const qaSession = randomUUID();
const candidateProfile = path.join(process.env.APPDATA, "Wealth Atlas Sync Candidate", CANDIDATE_VERSION, "isolated-qa", qaSession);
const markerPath = path.join(candidateProfile, "logs", `diagnostic-visibility-${report.visibilityProbeId}.txt`);
let profileExists = false;
try { await access(candidateProfile); profileExists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
assert.equal(profileExists, false, "Candidate profile already exists. Refusing to inspect a possibly used account; no data was changed.");
const qa = path.join(root, "work", "sync-candidate-qa", randomUUID());
await mkdir(qa, { recursive: true });
// Process-only proxy: loopback assets/debugging remain available; no hosted
// Auth/finance request from this NEW blank QA profile can leave the machine.
const denyProxy = net.createServer(socket => socket.destroy());
await new Promise((resolve, reject) => { denyProxy.once("error", reject); denyProxy.listen(0, "127.0.0.1", resolve); });
const proxyPort = denyProxy.address().port;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let firstProbeBoot, secondProbeBoot, firstMarker;
async function captureProbeBoot() {
  const file = path.join(destination, "windows", "win-unpacked", "candidate-qa-startup-diagnostic.json");
  const stat = await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 65536);
  const value = JSON.parse(await readFile(file, "utf8"));
  assert.equal(value.appVersion, CANDIDATE_VERSION); assert.equal(value.mode, "isolated-qa");
  assert.match(value.bootId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.ok(Date.parse(value.startedAt) >= runStartedAt);
  assert.ok(Array.isArray(value.codes) && value.codes.length <= 256);
  return value;
}
async function inspectOwnMarker() {
  // This exact fresh QA root was absent before launch. Never inspect the manual
  // profile named in release metadata, or enumerate any profile directory.
  for (const directory of [candidateProfile, path.dirname(markerPath)]) {
    const stat = await lstat(directory, { bigint: true });
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    const resolved = await realpath(directory);
    const fileView = classifyCandidateQaPath({ expected: directory, resolved, qaRoot: candidateProfile,
      appData: process.env.APPDATA, userProfile: process.env.USERPROFILE, version: CANDIDATE_VERSION });
    assert.notEqual(fileView, "refused", "Unexpected native path: no marker contents may be read");
    // Only the exact recognized alias for this NEW QA UUID may be inspected.
    // Directory metadata must prove it is the same directory before any bytes.
    const resolvedStat = fileView === "canonical" ? stat : await lstat(resolved, { bigint: true });
    assert.ok(sameDirectoryIdentity(stat, resolvedStat), "Logical and native QA paths must identify the same ordinary directory");
    markerFileViews.add(fileView);
  }
  const before = await lstat(markerPath, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.ino > 0n);
  assert.equal(before.size, BigInt(Buffer.byteLength(markerText)));
  const handle = await open(markerPath, "r");
  try {
    const stat = await handle.stat({ bigint: true });
    assert.ok(stat.isFile() && stat.nlink === 1n && stat.ino === before.ino && stat.dev === before.dev);
    assert.equal(stat.size, BigInt(Buffer.byteLength(markerText)));
    const bytes = Buffer.alloc(Buffer.byteLength(markerText) + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    assert.equal(read.bytesRead, Buffer.byteLength(markerText));
    assert.equal(bytes.subarray(0, read.bytesRead).toString("utf8"), markerText);
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
  } finally { await handle.close(); }
}
function probeCodes(boot) { return boot.codes.filter(code => code.startsWith("VISIBILITY_PROBE_")); }
async function probeCheckpoint(reopen) {
  const boot = await captureProbeBoot();
  const expected = probeCheckMode === "blocked" ? ["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_UNSAFE_TARGET"]
    : reopen ? ["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_FILE_EXISTS"]
      : ["VISIBILITY_PROBE_STARTED", "VISIBILITY_PROBE_WRITE_CONFIRMED", "VISIBILITY_PROBE_READBACK_CONFIRMED"];
  assert.deepEqual(probeCodes(boot), expected);
  if (reopen) { secondProbeBoot = boot; assert.notEqual(boot.bootId, firstProbeBoot.bootId); }
  else firstProbeBoot = boot;
  if (probeCheckMode === "blocked") return; // Not even a marker-path read in this scenario.
  const marker = await inspectOwnMarker();
  if (reopen) assert.deepEqual(marker, firstMarker, "Restart must not replace or rewrite the same marker");
  else firstMarker = marker;
}
function visibilitySummary() {
  assert.ok(firstProbeBoot && secondProbeBoot);
  if (probeCheckMode === "normal") assert.equal(markerFileViews.size, 1);
  return { enabledInPackage: true, scenario: probeCheckMode, firstWriteAndReadbackVerified: probeCheckMode === "normal",
    independentMarkerReadVerified: probeCheckMode === "normal", restartPreservedMarker: probeCheckMode === "normal",
    unsafeLogTargetRefused: probeCheckMode === "blocked", inspectedQaFileView: probeCheckMode === "normal" ? [...markerFileViews][0] : "not-inspected",
    manualPhysicalProfileVerified: false, realRootCauseProven: false, realProfileAccessed: false };
}
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function connect(port, child) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child.exitCode !== null) throw new Error("Isolated candidate exited before its page became available");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const target = (await response.json()).find((item) => item.type === "page" && /^(wealth-atlas:\/\/app\/|http:\/\/127\.0\.0\.1:\d+\/)/.test(item.url));
      if (target?.webSocketDebuggerUrl) {
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
        let serial = 0;
        const pending = new Map();
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (pending.has(message.id)) { const { resolve, reject, timer } = pending.get(message.id); clearTimeout(timer); pending.delete(message.id);
            message.error ? reject(new Error("Candidate diagnostic command failed")) : resolve(message.result); }
        });
        return { socket, send(method, params = {}) { return new Promise((resolve, reject) => {
          const id = ++serial;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error("Candidate diagnostic command timed out")); }, 20000);
          pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
        }); } };
      }
    } catch { /* The local debugging socket is not ready yet. */ }
    await delay(250);
  }
  throw new Error("Candidate page startup timed out");
}

// This runs ONLY after refusing a pre-existing candidate profile. It returns
// booleans/counts, never financial contents, identities, storage values or keys.
const inspect = `(${async function () {
  if (!document.body) return { ready: false };
  const text = document.body.innerText;
  const style = getComputedStyle(document.body);
  const resources = [...document.querySelectorAll("link[rel=stylesheet],script[src]")].map((node) => node.href || node.src);
  const responses = await Promise.all(resources.map(async (url) => {
    try { const response = await fetch(url); return response.status === 200 && (!url.includes(".css") || /text\/css/.test(response.headers.get("content-type") ?? "")); }
    catch { return false; }
  }));
  const databases = await indexedDB.databases();
  let blank = false, guest = false, legacy = false;
  if (databases.some((item) => item.name === "wealth-atlas")) {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open("wealth-atlas"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("QA read failed")); });
    try {
      if (!database.objectStoreNames.contains("snapshots")) return { ready: false };
      const rows = await new Promise((resolve, reject) => { const transaction = database.transaction("snapshots", "readonly"); const request = transaction.objectStore("snapshots").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("QA read failed")); });
      const snapshots = rows.filter((row) => row.data);
      guest = snapshots.some((row) => row.id === "profile:v1:guest");
      legacy = rows.some((row) => row.id === "current" || row.id.startsWith("profile:v1:cloud:"));
      blank = snapshots.every((row) => ["accounts", "transactions", "transfers", "budgets", "goals", "assets", "fxRates", "investments", "liabilities", "plannedPayments", "syncLogs"].every((key) => (row.data[key] ?? []).length === 0));
    } finally { database.close(); }
  }
  return { ready: Boolean(document.querySelector(".app-shell")), navigation: Boolean(document.querySelector(".sidebar,.mobile-nav")),
    hasPanel: Boolean(document.querySelector(".panel")), dark: !["rgb(255, 255, 255)", "rgba(0, 0, 0, 0)"].includes(style.backgroundColor),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    resourceCount: resources.length, resourcesOk: resources.length > 0 && responses.every(Boolean),
    errorPage: /Application error:|无法启动 Wealth Atlas/.test(text), secureContext: isSecureContext,
    version: window.wealthAtlasDesktop?.appVersion ?? null, smokeMode: window.wealthAtlasDesktop?.startupTestMode ?? null,
    blank, guest, legacy, desktop: Boolean(window.wealthAtlasDesktop),
    originOk: location.origin === "wealth-atlas://app" || /^http:\/\/127\.0\.0\.1:\d+$/.test(location.origin) };
}})()`;

async function checkRun({ exe, args = [], desktop, screenshots, label }) {
  const port = await freePort();
  const env = { ...process.env };
  for (const key of ["WEALTH_ATLAS_DESKTOP_SMOKE", "WEALTH_ATLAS_TEST_PROFILE", "WEALTH_ATLAS_TEST_VAULT", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  const child = spawn(exe, [...args, `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`,
    `--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=127.0.0.1;localhost;[::1]"], { cwd: root, env, windowsHide: true, stdio: "ignore" });
  let cdp;
  try {
    cdp = await connect(port, child);
    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error("Candidate read-only page inspection failed (" + (result.exceptionDetails.exception?.className ?? "unknown") + ")");
      return result.result.value;
    };
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { state = await evaluate(inspect); }
      catch (error) { if (attempt === 99) throw error; await delay(250); continue; }
      if (state.ready && state.guest && !state.errorPage) break;
      await delay(250);
    }
    assert.equal(state.ready, true, `${label}: ready`); assert.equal(state.blank, true, `${label}: blank`);
    assert.equal(state.guest, true, `${label}: guest workspace`); assert.equal(state.legacy, false, `${label}: no production/owned snapshot`);
    assert.equal(state.desktop, desktop, `${label}: mode`); assert.equal(state.errorPage, false, `${label}: no startup error`);
    assert.equal(state.originOk, true); assert.equal(state.secureContext, true);
    if (desktop) { assert.equal(state.version, CANDIDATE_VERSION); assert.equal(state.smokeMode, ""); }
    const viewports = [];
    for (const [width, height] of screenshots ? [[1440, 900], [1280, 800], [1024, 768], [390, 844], [320, 720]] : [[1440, 900]]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await delay(250); state = await evaluate(inspect);
      assert.equal(state.overflow, false, `${label}: overflow at ${width}`); assert.equal(state.dark, true, `${label}: dark theme`);
      assert.equal(state.navigation, true); assert.equal(state.hasPanel, true); assert.equal(state.resourcesOk, true, `${label}: resources`);
      if (screenshots) { const shot = await cdp.send("Page.captureScreenshot", { format: "png" }); await writeFile(path.join(qa, `${label}-${width}.png`), Buffer.from(shot.data, "base64")); }
      viewports.push({ width, height, pass: true });
    }
    return { label, pass: true, normalStartup: true, blankGuest: true, secureContext: true, resourcesOk: true, viewports };
  } finally {
    if (cdp) { try { await cdp.send("Browser.close"); } catch {} cdp.socket.close(); }
    if (child.exitCode === null) { await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5000)]); }
    const cleanExit = child.exitCode === 0;
    const forcedClose = child.exitCode === null;
    if (child.exitCode === null) child.kill(); // Only the exact test process spawned above.
    processCloses.push({ cleanExit, forcedClose });
  }
}

const checks = [];
let step = "windows-startup";
let server;
try {
  const exe = path.join(destination, "windows", "win-unpacked", "Wealth Atlas Sync Candidate.exe");
  const args = [`--candidate-qa-session=${qaSession}`];
  checks.push(await checkRun({ exe, args, desktop: true, screenshots: true, label: "windows" }));
  await probeCheckpoint(false);
  step = "windows-reopen";
  checks.push(await checkRun({ exe, args, desktop: true, screenshots: false, label: "windows-reopen" }));
  await probeCheckpoint(true);
  const mainLog = await readFile(path.join(candidateProfile, "logs", "main.log"), "utf8");
  assert.ok(mainLog.includes('"event":"update-disabled"') && mainLog.includes('"reason":"isolated-test"'));
  assert.ok(!mainLog.includes('"event":"update-check-start"'));
  const technical = JSON.parse(await readFile(path.join(destination, "windows", "win-unpacked", "candidate-qa-startup-diagnostic.json"), "utf8"));
  const enumCodes = JSON.parse(await readFile(path.join(root, "desktop", "auth-diagnostic-codes.json"), "utf8"));
  assert.equal(technical.appVersion, CANDIDATE_VERSION);
  assert.equal(technical.mode, "isolated-qa");
  assert.ok(technical.codes.every(code => Object.hasOwn(enumCodes, code)), "Diagnostics contain fixed enums only");
  for (const code of ["PROFILE_USER_ROOT_MATCH", "PROFILE_SESSION_ROOT_MATCH", "PROFILE_STORAGE_ROOT_MATCH"])
    assert.ok(technical.codes.includes(code), "Packaged startup confirms " + code);
  const trace = JSON.parse(await readFile(path.join(destination, "windows", "win-unpacked", "candidate-qa-auth-trace.json"), "utf8"));
  assert.deepEqual(Object.keys(trace).sort(), ["boots", "format", "formatVersion"]);
  assert.equal(trace.format, "wealth-atlas-auth-trace"); assert.equal(trace.formatVersion, 1);
  assert.equal(trace.boots.length, 2);
  for (const boot of trace.boots) {
    assert.deepEqual(Object.keys(boot).sort(), ["appVersion", "bootId", "events", "mode", "omitted", "startedAt"]);
    assert.equal(boot.appVersion, CANDIDATE_VERSION); assert.equal(boot.mode, "isolated-qa");
    assert.ok(boot.events.length > 0 && boot.events.length <= 64);
    assert.ok(boot.events.every(event => Object.keys(event).sort().join() === "code,elapsedMs,seq" && Object.hasOwn(enumCodes, event.code)));
    assert.ok(boot.events.some(event => event.code === "CANDIDATE_APP_WILL_QUIT"));
  }
  assert.equal(trace.boots.at(-1).bootId, technical.bootId, "Current trace and startup sidecar identify the SAME boot");
  assert.notEqual(trace.boots[0].bootId, trace.boots[1].bootId);
  assert.equal(trace.boots[0].bootId, firstProbeBoot.bootId);
  assert.equal(trace.boots[1].bootId, secondProbeBoot.bootId);
  for (const [index, boot] of trace.boots.entries()) {
    assert.equal(boot.omitted, 0);
    assert.deepEqual(boot.events.filter(event => event.code.startsWith("VISIBILITY_PROBE_")).map(event => event.code),
      probeCodes(index === 0 ? firstProbeBoot : secondProbeBoot));
  }
  step = "mac-web-on-windows";
  server = await createCandidateServer({ siteRoot: path.join(destination, "mac-web", "site"), port: 0 });
  checks.push(await checkRun({ exe: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [path.join(root, "tests", "fixtures", "candidate-browser.cjs"), path.join(qa, "web-profile"), `http://127.0.0.1:${server.address().port}/`],
    desktop: false, screenshots: true, label: "mac-web-on-windows" }));
  step = "archive-checksums";
  for (const [file, hash] of Object.entries(report.hashes)) {
    assert.equal(path.basename(file), file);
    assert.equal(createHash("sha256").update(await readFile(path.join(destination, file))).digest("hex"), hash);
  }
  assert.equal(processCloses.length, checks.length);
  assert.ok(processCloses.every(item => item.cleanExit && !item.forcedClose), "All isolated candidate processes must close cleanly");
  await writeFile(runtimeReportPath, JSON.stringify({ status: "PASS", version: CANDIDATE_VERSION,
    autoUpdaterDisabled: true, archiveChecksumsVerified: true, checks, screenshots: qa,
    authTraceCrossBootVerified: true, authTraceBootIdsJoined: true,
    visibilityProbe: visibilitySummary(), cleanProcessExits: processCloses.length, forcedCloses: 0,
    realAccountLoginTested: false, hostedTwoDeviceVerified: false, macOSRuntimeVerified: false,
    productionProfileAccessed: false, externalNetworkBlocked: true, githubPublished: false }, null, 2) + "\n", { flag: "wx" });
  console.log("Candidate local runtime QA PASS: startup/reopen, isolated blank guest, updater off, CSS/JS, five widths, archive checksums.");
  console.log("Real account login, hosted two-device sync, and actual macOS remain NOT VERIFIED.");
  console.log("Synthetic/blank QA screenshots: " + qa);
} catch (error) {
  console.error("Candidate runtime QA FAILED at " + step + "; no release was published and no existing profile was cleared.");
  if (error?.code === "ERR_ASSERTION") console.error(error.message);
  else console.error(error?.name === "Error" ? error.message : "Local diagnostic operation failed");
  process.exitCode = 1;
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise(resolve => denyProxy.close(resolve));
}
