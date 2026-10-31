import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertReleaseSource, assertCloudBuildConfigured, publishCheckedRelease, validateUpdateAssets, buildReleaseBody } from "../scripts/github-release.mjs";
import { probeAnonymousPrivileges, publicProbeConfig } from "../scripts/check-cloud-permissions.mjs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { createCandidateServer } from "../scripts/candidate-web-server.mjs";
import { assertCandidatePath, CANDIDATE_VERSION, CANDIDATE_PROFILE_VERSION } from "../scripts/build-sync-candidate.mjs";
import { classifyCandidateQaPath, sameDirectoryIdentity } from "../scripts/candidate-qa-paths.mjs";
import { hashReleaseAssets, createInstalledReleaseAcceptance } from "../scripts/release-acceptance.mjs";

test("QA native path aliases require an exact new UUID suffix and matching directory identity", () => {
  const userProfile = "C:\\Users\\Synthetic", appData = path.win32.join(userProfile, "AppData", "Roaming");
  const version = "1.7.5-rc.13", id = "11111111-1111-4111-8111-111111111111";
  const qaRoot = path.win32.join(appData, "Wealth Atlas Sync Candidate", version, "isolated-qa", id);
  const expected = path.win32.join(qaRoot, "logs");
  const resolved = path.win32.join(userProfile, "AppData", "Local", "Packages", "OpenAI.Codex_123456789abcd", "LocalCache", "Roaming", path.win32.relative(appData, expected));
  const check = overrides => classifyCandidateQaPath({ expected, resolved, qaRoot, appData, userProfile, version, ...overrides });
  assert.equal(check({ resolved: expected }), "canonical");
  assert.equal(check({}), "codex-package-view");
  for (const change of [{ resolved: resolved.replace(id, "22222222-2222-4222-8222-222222222222") },
    { resolved: resolved.replace("OpenAI.Codex_", "Other.App_") }, { resolved: resolved + "\\other" },
    { resolved: "D:\\other\\logs" }, { expected: qaRoot + "\\database", resolved: qaRoot + "\\database" },
    { qaRoot: path.win32.join(appData, "Wealth Atlas Sync Candidate", "1.7.5-rc.5") }, { version: "1.7.5" }]) assert.equal(check(change), "refused");
  const stat = { dev: 1n, ino: 2n, isDirectory: () => true, isSymbolicLink: () => false };
  assert.equal(sameDirectoryIdentity(stat, { ...stat }), true);
  for (const other of [{ ...stat, dev: 3n }, { ...stat, ino: 3n }, { ...stat, ino: 0n },
    { ...stat, isSymbolicLink: () => true }, { ...stat, isDirectory: () => false }]) assert.equal(sameDirectoryIdentity(stat, other), false);
  const zero = { ...stat, ino: 0n };
  assert.equal(sameDirectoryIdentity(zero, { ...zero }), false);
  const unsafeNumber = { ...stat, dev: 1, ino: Number.MAX_SAFE_INTEGER + 1 };
  assert.equal(sameDirectoryIdentity(unsafeNumber, { ...unsafeNumber }), false);
});

test("candidate bootstrap forces a separate profile even without its launcher", () => {
  const source = readFileSync(new URL("../scripts/candidate-bootstrap.cjs", import.meta.url), "utf8");
  const paths = {}, environment = { WEALTH_ATLAS_TEST_PROFILE: "synthetic-production-root" };
  let loaded = false;
  runInNewContext(source, { process: { env: environment, argv: [] }, require(name) {
    if (name === "node:path") return path;
    if (name === "electron") return { app: { getPath: () => path.resolve("synthetic-appdata"), setName() {}, setPath: (name, value) => { paths[name] = value; } } };
    if (name === "../package.json") return { version: CANDIDATE_VERSION, wealthAtlasCandidate: "cloud-sync-test" };
    if (name === "../desktop/candidate-diagnostics.cjs") return { enableCandidateDiagnostics() {} };
    if (name === "./main.cjs") { loaded = true; assert.equal(paths.userData, environment.WEALTH_ATLAS_TEST_PROFILE); return {}; }
    throw new Error("Unexpected candidate module");
  } });
  assert.equal(loaded, true);
  assert.equal(paths.userData, path.join(path.resolve("synthetic-appdata"), "Wealth Atlas Sync Candidate", CANDIDATE_VERSION));
  assert.equal(paths.sessionData, paths.userData);
});

test("candidate bootstrap refuses invalid metadata before opening a profile", () => {
  const source = readFileSync(new URL("../scripts/candidate-bootstrap.cjs", import.meta.url), "utf8");
  let pathsTouched = false;
  assert.throws(() => runInNewContext(source, { process: { env: {}, argv: [] }, require(name) {
    if (name === "node:path") return path;
    if (name === "../package.json") return { version: "1.7.4" };
    if (name === "electron") return { app: { getPath: () => { pathsTouched = true; }, setPath: () => { pathsTouched = true; } } };
    throw new Error("Unexpected module");
  } }), /Candidate metadata is missing/);
  assert.equal(pathsTouched, false);
});

test("approved candidate updates reuse exactly the rc.5 directory without touching files", () => {
  const source = readFileSync(new URL("../scripts/candidate-bootstrap.cjs", import.meta.url), "utf8");
  const paths = {}, environment = { WEALTH_ATLAS_TEST_PROFILE: "synthetic-production-root" };
  runInNewContext(source, { process: { env: environment, argv: [] }, require(name) {
    if (name === "node:path") return path;
    if (name === "electron") return { app: { getPath: () => path.resolve("synthetic-appdata"), setName() {}, setPath: (name, value) => { paths[name] = value; } } };
    if (name === "../package.json") return { version: CANDIDATE_VERSION, wealthAtlasCandidate: "cloud-sync-test", wealthAtlasCandidateProfileVersion: CANDIDATE_PROFILE_VERSION };
    if (name === "../desktop/candidate-diagnostics.cjs") return { enableCandidateDiagnostics() {} };
    if (name === "./main.cjs") return {};
    throw new Error("Unexpected module: no file I/O is allowed in profile selection");
  } });
  assert.equal(CANDIDATE_PROFILE_VERSION, "1.7.5-rc.5");
  assert.equal(paths.userData, path.join(path.resolve("synthetic-appdata"), "Wealth Atlas Sync Candidate", "1.7.5-rc.5"));
  assert.equal(paths.sessionData, paths.userData);
  assert.equal(environment.WEALTH_ATLAS_TEST_PROFILE, paths.userData);
});

test("candidate profile metadata cannot select production, traversal, another release or a future candidate", () => {
  const source = readFileSync(new URL("../scripts/candidate-bootstrap.cjs", import.meta.url), "utf8");
  for (const profileVersion of ["../../Wealth Atlas", "C:\\production", "Wealth Atlas", "1.7.4", "1.8.0-rc.1", "1.7.5-rc.999999", null, {}, 5]) {
    // null/undefined mean omitted legacy metadata and keep the default version.
    if (profileVersion === null) continue;
    let touched = false;
    assert.throws(() => runInNewContext(source, { process: { env: {}, argv: [] }, require(name) {
      if (name === "node:path") return path;
      if (name === "../package.json") return { version: CANDIDATE_VERSION, wealthAtlasCandidate: "cloud-sync-test", wealthAtlasCandidateProfileVersion: profileVersion };
      if (name === "electron") return { app: { getPath() { touched = true; }, setPath() { touched = true; } } };
      throw new Error("Unexpected module");
    } }), /Invalid candidate profile metadata/);
    assert.equal(touched, false);
  }
});

test("candidate QA UUID can only select a child of its isolated candidate root", () => {
  const source = readFileSync(new URL("../scripts/candidate-bootstrap.cjs", import.meta.url), "utf8");
  const session = "12345678-1234-1234-1234-123456789abc";
  for (const value of [session, "../../production", "C:\\other-profile"]) {
    const paths = {};
    const evaluate = () => runInNewContext(source, { process: { env: {}, argv: [`--candidate-qa-session=${value}`] }, require(name) {
      if (name === "node:path") return path;
      if (name === "../package.json") return { version: CANDIDATE_VERSION, wealthAtlasCandidate: "cloud-sync-test", wealthAtlasCandidateProfileVersion: CANDIDATE_PROFILE_VERSION };
      if (name === "electron") return { app: { getPath: () => path.resolve("synthetic-appdata"), setName() {}, setPath: (name, value) => { paths[name] = value; } } };
      if (name === "../desktop/candidate-diagnostics.cjs") return { enableCandidateDiagnostics() {} };
      if (name === "./main.cjs") return {};
      throw new Error("Unexpected module");
    } });
    if (value === session) { evaluate(); assert.equal(paths.userData, path.join(path.resolve("synthetic-appdata"), "Wealth Atlas Sync Candidate", CANDIDATE_VERSION, "isolated-qa", session)); }
    else { assert.throws(evaluate, /Invalid candidate QA session/); assert.equal(Object.keys(paths).length, 0); }
  }
});

test("candidate first-document pause cannot be inherited by an ordinary profile", () => {
  const source = readFileSync(new URL("../scripts/candidate-bootstrap.cjs", import.meta.url), "utf8");
  const session = "12345678-1234-1234-1234-123456789abc";
  for (const qa of [false, true]) {
    const environment = { WEALTH_ATLAS_CANDIDATE_FIRST_DOCUMENT: "inherited-not-trusted" };
    const argv = ["--candidate-qa-first-document", ...(qa ? [`--candidate-qa-session=${session}`] : [])];
    runInNewContext(source, { process: { env: environment, argv }, require(name) {
      if (name === "node:path") return path;
      if (name === "electron") return { app: { getPath: () => path.resolve("synthetic-appdata"), setName() {}, setPath() {} } };
      if (name === "../package.json") return { version: CANDIDATE_VERSION, wealthAtlasCandidate: "cloud-sync-test" };
      if (name === "../desktop/candidate-diagnostics.cjs") return { enableCandidateDiagnostics() {} };
      if (name === "./main.cjs") return {};
      throw new Error("Unexpected candidate module");
    } });
    assert.equal(environment.WEALTH_ATLAS_CANDIDATE_FIRST_DOCUMENT, qa ? session : "");
  }
});

test("candidate technical sidecar is boot-specific, bounded, enum-only and nonfatal on write failure", () => {
  const require = createRequire(import.meta.url);
  const { createCandidateDiagnostics } = require("../desktop/candidate-diagnostics.cjs");
  const codes = require("../desktop/auth-diagnostic-codes.json"), writes = [];
  const record = createCandidateDiagnostics(CANDIDATE_VERSION, "synthetic-program-folder", (...args) => writes.push(args));
  assert.equal(record("AUTH_RUNTIME_STARTED"), true);
  assert.equal(record("OFFLINE_CACHE_MISSING"), true); assert.equal(record("OFFLINE_CACHE_MISSING"), true);
  assert.equal(record("synthetic@example.invalid secret MYR 123"), false);
  assert.equal(record({ account: "SYNTHETIC_PRIVATE" }), false);
  for (const code of Object.keys(codes)) record(code);
  const report = JSON.parse(writes.at(-1)[1]);
  assert.deepEqual(Object.keys(report), ["appVersion", "bootId", "startedAt", "mode", "codes"]);
  assert.equal(report.mode, "manual-candidate");
  assert.equal(report.codes.length, Object.keys(codes).length);
  assert.equal(writes.every(([file, text]) => file === path.join("synthetic-program-folder", "candidate-startup-diagnostic.json")
    && !/synthetic@example|secret|MYR|SYNTHETIC_PRIVATE/.test(text)), true);
  let nextBoot;
  createCandidateDiagnostics(CANDIDATE_VERSION, "synthetic-program-folder", (_file, text) => { nextBoot = JSON.parse(text); })("AUTH_RUNTIME_STARTED");
  assert.notEqual(report.bootId, nextBoot.bootId);
  let qaFile;
  createCandidateDiagnostics(CANDIDATE_VERSION, "synthetic-program-folder", (file) => { qaFile = file; }, "isolated-qa")("AUTH_RUNTIME_STARTED");
  assert.notEqual(qaFile, writes[0][0], "Automated QA cannot replace manual startup evidence");
  assert.equal(createCandidateDiagnostics(CANDIDATE_VERSION, "synthetic-program-folder", () => { throw new Error("synthetic denied"); })("AUTH_RUNTIME_STARTED"), false);
  const explicitId = "77777777-7777-4777-8777-777777777777";
  let joinedBoot;
  createCandidateDiagnostics(CANDIDATE_VERSION, "synthetic-program-folder", (_file, text) => { joinedBoot = JSON.parse(text); }, "isolated-qa", explicitId)("AUTH_RUNTIME_STARTED");
  assert.equal(joinedBoot.bootId, explicitId);
  assert.equal(createCandidateDiagnostics(CANDIDATE_VERSION, "synthetic-program-folder", () => assert.fail("Invalid boot ID must not write"), "isolated-qa", "SYNTH_PRIVATE")("AUTH_RUNTIME_STARTED"), false);
});

test("desktop diagnostic IPC does not report success when the profile log write failed", async () => {
  const source = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const snippet = source.slice(source.indexOf("async function writeDiagnosticLog("), source.indexOf("function logsDirectory()"));
  const context = { rendererLogQueue: Promise.resolve(), rendererLogPath: () => "synthetic-log", path,
    startupDiagnostics: { recordIoFailure: () => undefined },
    fs: { async mkdir() { throw new Error("synthetic write denied"); } } };
  const log = runInNewContext(snippet + "\nwriteDiagnosticLog", context);
  assert.equal(await log("synthetic"), false);
  assert.match(source, /return await writeDiagnosticLog\("renderer-diagnostic", safePayload\)/);
});

test("candidate startup context and failed log writes report enums without changing storage", () => {
  const require = createRequire(import.meta.url);
  const result = require("./fixtures/startup-context-review.cjs").runReview();
  assert.equal(result.failed, 0);
  assert.ok(result.passed >= 10);
});

test("candidate visibility probe uses a single fixed-content exclusive marker and never reads existing files", () => {
  const require = createRequire(import.meta.url);
  const result = require("./fixtures/diagnostic-visibility-review.cjs").runReview();
  assert.equal(result.failed, 0);
  assert.ok(result.passed >= 15);
});

test("candidate visibility opt-in is metadata-only and pins the selected candidate root", () => {
  const source = readFileSync(new URL("../scripts/candidate-bootstrap.cjs", import.meta.url), "utf8");
  const id = "99999999-9999-4999-8999-999999999999";
  let options;
  runInNewContext(source, { process: { env: {}, argv: [] }, require(name) {
    if (name === "node:path") return path;
    if (name === "electron") return { app: { getPath: () => path.resolve("synthetic-appdata"), setName() {}, setPath() {} } };
    if (name === "../package.json") return { version: CANDIDATE_VERSION, wealthAtlasCandidate: "cloud-sync-test",
      wealthAtlasCandidateProfileVersion: CANDIDATE_PROFILE_VERSION, wealthAtlasCandidateVisibilityProbeId: id };
    if (name === "../desktop/candidate-diagnostics.cjs") return { enableCandidateDiagnostics(_version, _exe, _mode, value) { options = value; } };
    if (name === "./main.cjs") return {};
    throw new Error("Unexpected visibility integration module");
  } });
  assert.equal(options.probeId, id);
  assert.equal(options.expectedRoot, path.join(path.resolve("synthetic-appdata"), "Wealth Atlas Sync Candidate", CANDIDATE_PROFILE_VERSION));
  const main = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  assert.match(main, /initializeDiagnosticsSync\(\);\s*runCandidateVisibilityProbe\(app\.getPath\("userData"\)\);/);
  const { runCandidateVisibilityProbe } = createRequire(import.meta.url)("../desktop/candidate-diagnostics.cjs");
  assert.equal(runCandidateVisibilityProbe(path.resolve("synthetic-production-root")), false, "Formal startup has not enabled any probe");
});

test("native candidate visibility probe writes fixed text without DevTools and preserves it on another startup", { timeout: 60000,
  skip: process.platform !== "win32" ? "Windows Electron integration test" : false }, async () => {
  const { execFile } = await import("node:child_process");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const profile = mkdtempSync(path.join(os.tmpdir(), "wealth-atlas-visibility-qa-"));
  writeFileSync(path.join(profile, "synthetic-qa-only.txt"), "WEALTH_ATLAS_SYNTHETIC_VISIBILITY_ONLY", { flag: "wx" });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  for (const mode of ["seed", "repeat"]) {
    const output = await new Promise((resolve, reject) => execFile(path.join(root, "node_modules/electron/dist/electron.exe"), [
      path.join(root, "tests/fixtures/diagnostic-visibility-electron.cjs"), `--visibility-qa-root=${profile}`,
      ...(mode === "repeat" ? ["--repeat"] : []),
    ], { cwd: root, env, windowsHide: true, timeout: 25000, maxBuffer: 64000 }, (error, stdout) => {
      if (error) reject(new Error("Isolated visibility startup failed; no private log read.")); else resolve(stdout);
    }));
    const line = output.match(/VISIBILITY_NATIVE_RESULT (\{[^\n]+\})/); assert.ok(line);
    const result = JSON.parse(line[1]); assert.equal(result.pass, true); assert.equal(result.mode, mode);
    assert.equal(result.realProfileAccessed, false); assert.equal(result.financialDatabaseOpened, false);
    assert.equal(result.networkUsed, false); assert.equal(result.devtoolsUsed, false);
    const { PROBE_TEXT } = createRequire(import.meta.url)("../desktop/diagnostic-visibility.cjs");
    assert.equal(readFileSync(path.join(profile, "logs", "diagnostic-visibility-88888888-8888-4888-8888-888888888888.txt"), "utf8"), PROBE_TEXT,
      "Parent can independently read only its exact synthetic marker");
  }
});

test("candidate auth trace preserves bounded safe cross-boot evidence without changing auth operations", () => {
  const require = createRequire(import.meta.url);
  const result = require("./fixtures/auth-trace-review.cjs").runReview();
  assert.equal(result.failed, 0);
  assert.ok(result.passed >= 10);
});

test("native candidate auth trace crosses isolated normal close and cold reopen through the sandboxed bridge", { timeout: 60000, skip: process.platform !== "win32" ? "Windows Electron integration test" : false }, async () => {
  const { execFile } = await import("node:child_process");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const profile = mkdtempSync(path.join(os.tmpdir(), "wealth-atlas-auth-trace-qa-"));
  writeFileSync(path.join(profile, "synthetic-qa-only.txt"), "WEALTH_ATLAS_SYNTHETIC_AUTH_TRACE_ONLY", { flag: "wx" });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [];
  for (const mode of ["seed", "reopen"]) {
    const output = await new Promise((resolve, reject) => execFile(path.join(root, "node_modules/electron/dist/electron.exe"), [
      "--disable-gpu", path.join(root, "tests/fixtures/auth-trace-electron.cjs"), `--auth-trace-qa-root=${profile}`,
      ...(mode === "reopen" ? ["--reopen"] : []),
    ], { cwd: root, env, windowsHide: true, timeout: 25000, maxBuffer: 64000 }, (error, stdout) => {
      if (error) reject(new Error("Isolated native auth trace failed; no private log collected.")); else resolve(stdout);
    }));
    const line = output.match(/AUTH_TRACE_NATIVE_RESULT (\{[^\n]+\})/);
    assert.ok(line);
    const result = JSON.parse(line[1]);
    assert.equal(result.pass, true); assert.equal(result.realNetworkUsed, false); assert.equal(result.realProfileAccessed, false);
    assert.equal(result.financialDatabaseOpened, false); assert.equal(result.mode, mode);
    checks.push(result);
  }
  assert.equal(checks.length, 2);
});

test("actual main log catch paths distinguish log access from stale startup status", () => {
  const require = createRequire(import.meta.url);
  const { createStartupDiagnostics } = require("../desktop/startup-diagnostics.cjs");
  const source = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const snippet = source.slice(source.indexOf("function initializeDiagnosticsSync()"), source.indexOf("const STARTUP_STAGE_NAMES"));
  for (const point of ["initialize", "main", "startup"]) {
    const emitted = [], writes = [];
    const failure = Object.assign(new Error("SYNTHETIC_PRIVATE_DO_NOT_LOG"), { code: "EBUSY" });
    const startupDiagnostics = createStartupDiagnostics({ record: code => emitted.push(code), expectedRoot: "synthetic-root" });
    const context = { startupDiagnostics,
      logsDirectory: () => "synthetic-root/logs", mainLogPath: () => "synthetic-main",
      rendererLogPath: () => "synthetic-renderer", startupPath: () => "synthetic-startup",
      rotateLogSync() {}, startupSnapshot: () => ({ status: "synthetic" }),
      updateStartupStatus() {}, buildMainEntry: () => ({ event: "synthetic" }),
      fsSync: { mkdirSync() { if (point === "initialize") throw failure; },
        openSync() { return 1; }, closeSync() {},
        appendFileSync() { writes.push("append"); if (point === "main") throw failure; },
        writeFileSync() { writes.push("startup"); throw failure; } },
    };
    const api = runInNewContext(snippet + "\n({initializeDiagnosticsSync, writeMainLog})", context);
    assert.doesNotThrow(() => point === "initialize" ? api.initializeDiagnosticsSync() : api.writeMainLog("synthetic"));
    assert.deepEqual(emitted, [point === "initialize" ? "LOG_INITIALIZATION_FAILED"
      : point === "main" ? "MAIN_LOG_WRITE_FAILED" : "STARTUP_STATUS_WRITE_FAILED", "DIAGNOSTIC_IO_EBUSY"]);
    assert.equal(JSON.stringify(emitted).includes("SYNTHETIC_PRIVATE"), false);
    if (point === "startup") assert.deepEqual(writes, ["append", "startup"]);
  }
  assert.match(source, /startupDiagnostics\.checkContext\("before-ready"\)/);
  assert.match(source, /startupDiagnostics\.checkContext\("ready"\)/);
  assert.match(source, /getStoragePath: \(\) => session\.defaultSession\.storagePath/);
});

test("candidate archive allowlist rejects private paths, keys and traversal", () => {
  for (const file of [".env.local", "public/data/real.json", "exports/file.xlsx", "private-vault/note.md", "backups/file.json",
    "outputs/file.json", "review/request.json", "certificates/sign.pfx", "desktop/update-token.json", "../private.txt", "app/token.key"]) {
    assert.throws(() => assertCandidatePath(file));
  }
  for (const file of ["out/index.html", "site/_next/static/page.js", "desktop/main.cjs", "site/icon.svg"]) assert.doesNotThrow(() => assertCandidatePath(file));
});

test("candidate local server serves CSS correctly and rejects writes, rebinding and path escape", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "wa-candidate-http-"));
  const site = path.join(folder, "site");
  const { mkdirSync } = await import("node:fs"); mkdirSync(site);
  writeFileSync(path.join(site, "index.html"), "<html>synthetic</html>");
  writeFileSync(path.join(site, "style.css"), "body{background:#08111a}");
  writeFileSync(path.join(folder, "outside.txt"), "synthetic outside sentinel");
  const server = await createCandidateServer({ siteRoot: site, port: 0 });
  const port = server.address().port;
  const call = (url, headers = {}, method = "GET") => new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: url, method, headers }, (response) => {
      let body = ""; response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }); request.on("error", reject); request.end();
  });
  try {
    const home = await call("/"); assert.equal(home.status, 200); assert.match(home.body, /synthetic/);
    const css = await call("/style.css"); assert.equal(css.status, 200); assert.match(css.headers["content-type"], /^text\/css/);
    assert.equal(css.headers["cache-control"], "no-store");
    assert.equal((await call("/", { Host: "attacker.invalid" })).status, 403);
    assert.equal((await call("/", { Origin: "https://attacker.invalid" })).status, 403);
    assert.equal((await call("/", {}, "POST")).status, 405);
    const escaped = await call("/%2e%2e%2foutside.txt"); assert.equal(escaped.status, 403); assert.doesNotMatch(escaped.body, /sentinel/);
    assert.equal((await call("/missing.css")).status, 404);
    assert.equal((await call("/style.css", {}, "HEAD")).body, "");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

const probeConfig = { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_synthetic-test-only" };
test("permission probe permits only public configuration and never sends a server key", async () => {
  const legacyAnon = "header." + Buffer.from('{"role":"anon"}').toString("base64url") + ".signature";
  assert.doesNotThrow(() => publicProbeConfig({ ...probeConfig, NEXT_PUBLIC_SUPABASE_ANON_KEY: legacyAnon }));
  let requests = 0;
  for (const change of [{ NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_synthetic" },
    { NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_synthetic." + Buffer.from('{"role":"anon"}').toString("base64url") + ".signature" },
    { NEXT_PUBLIC_SUPABASE_ANON_KEY: "header." + Buffer.from('{"role":"service_role"}').toString("base64url") + ".signature" },
    { NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test\nheader" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-fixture.supabase.co/private" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-fixture.supabase.co?secret=fixture" },
    { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:3000" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://username:password@synthetic-fixture.supabase.co" }]) {
    await assert.rejects(() => probeAnonymousPrivileges({ ...probeConfig, ...change }, async () => { requests++; }),
      (error) => !/sb_secret|service_role|username|password|fixture/.test(error.message));
  }
  assert.equal(requests, 0);
});

test("live permission probe is HEAD limit=0 only and never reads any response body", async () => {
  for (const status of [200, 401, 403, 404, 500]) {
    const result = await probeAnonymousPrivileges(probeConfig, async (url, options) => {
      assert.equal(url.pathname, "/rest/v1/user_data");
      assert.equal(url.searchParams.get("select"), "id");
      assert.equal(url.searchParams.get("limit"), "0");
      assert.equal(options.method, "HEAD"); assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(Object.keys(options.headers).sort(), ["Accept", "apikey"]);
      return { status, get body() { throw new Error("Body must never be accessed"); },
        json() { throw new Error("Body must never be accessed"); }, text() { throw new Error("Body must never be accessed"); } };
    });
    assert.equal(result.liveIsolationVerified, false);
    assert.equal(result.financialRowsRequested, 0);
    assert.equal(result.status, [401, 403].includes(status) ? "ANONYMOUS_REQUEST_DENIED" : "NEEDS_METADATA_REVIEW");
    assert.notEqual(result.status, "PASS");
  }
});

test("permission probe failures suppress provider details and remain unverified", async () => {
  const result = await probeAnonymousPrivileges(probeConfig, async () => { throw new Error("synthetic private provider content"); });
  assert.equal(result.status, "UNREACHABLE"); assert.equal(result.liveIsolationVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /private provider content|synthetic-fixture|sb_publishable/);
});

test("catalog audit references metadata only and rolls back its read-only transaction", () => {
  const audit = readFileSync(new URL("../supabase/audit-user-data.sql", import.meta.url), "utf8");
  const statements = audit.replace(/--[^\n]*/g, "");
  assert.match(statements, /begin read only;/i); assert.match(statements, /rollback;/i);
  assert.doesNotMatch(statements, /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke)\b\s+(?:into\s+|table\s+)?public\.user_data/i);
  assert.doesNotMatch(statements, /\b(?:from|join)\s+(?:public\.)?user_data\b/i);
  assert.doesNotMatch(statements, /\b(?:from|join)\s+auth\.users\b/i);
});

test("candidate explicitly limits API grants without financial table mutations", () => {
  const sql = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8").replace(/--[^\n]*/g, "");
  assert.match(sql, /grant select on table public\.user_data to authenticated/i);
  assert.match(sql, /grant update \(data, updated_at\)/i);
  assert.match(sql, /as restrictive for all to public/i);
  assert.match(sql, /as restrictive for delete to public using \(false\)/i);
  assert.doesNotMatch(sql, /grant\s+(?:all|delete|truncate)\b/i);
  assert.doesNotMatch(sql, /security definer/i);
  assert.doesNotMatch(sql, /\b(?:update|delete from|insert into|truncate)\s+public\.user_data/i);
  assert.match(sql, /old\.updated_at \+ interval '1 microsecond'/i);
});

test("narrow trigger candidate preserves legacy API table grants and does no financial DML", () => {
  const sql = readFileSync(new URL("../supabase/harden-user-data-triggers.sql", import.meta.url), "utf8").replace(/--[^\n]*/g, "");
  assert.match(sql, /begin;/i); assert.match(sql, /commit;\s*$/i);
  assert.match(sql, /set local lock_timeout = '3s'/i);
  assert.match(sql, /pg_catalog\.clock_timestamp\(\)/i);
  assert.match(sql, /old\.updated_at \+ interval '1 microsecond'/i);
  assert.match(sql, /pg_catalog\.isfinite\(old\.updated_at\)/i);
  assert.match(sql, /security invoker set search_path = ''/i);
  assert.match(sql, /before_state is distinct from after_state/i);
  assert.doesNotMatch(sql, /\b(?:from|join)\s+(?:public\.)?user_data\b/i);
  assert.doesNotMatch(sql, /\b(?:update|delete from|insert into|truncate)\s+public\.user_data/i);
  assert.doesNotMatch(sql, /^\s*(?:grant|revoke)\s+(?!execute\b)/im);
  assert.doesNotMatch(sql, /\b(?:create|alter|drop)\s+policy\b/i);
  assert.doesNotMatch(sql, /\b(?:create or replace|alter|drop)\s+function public\.(?:set_user_id|touch_updated_at|rls_auto_enable)/i);
  assert.doesNotMatch(sql, /\b(?:alter|drop)\s+event trigger\b/i);
});

test("catalog audit distinguishes trigger functions from ordinary RPC review targets", () => {
  const sql = readFileSync(new URL("../supabase/audit-user-data.sql", import.meta.url), "utf8");
  assert.match(sql, /p\.prorettype = 'trigger'::regtype then 'row_trigger'/);
  assert.match(sql, /p\.prorettype = 'event_trigger'::regtype then 'event_trigger'/);
  assert.match(sql, /else 'ordinary_function_requires_rpc_review'/);
});

test("legacy search path fix cannot rewrite a function body, grant privileges or mutate financial rows", () => {
  const sql = readFileSync(new URL("../supabase/pin-legacy-timestamp-search-path.sql", import.meta.url), "utf8").replace(/--[^\n]*/g, "");
  assert.match(sql, /alter function public\.touch_updated_at\(\) set search_path = pg_catalog;/i);
  assert.match(sql, /before_function is distinct from/i);
  assert.match(sql, /before_layout is distinct from after_layout/i);
  assert.match(sql, /set local lock_timeout = '3s'/i);
  assert.doesNotMatch(sql, /\b(?:from|join)\s+(?:public\.)?user_data\b/i);
  assert.doesNotMatch(sql, /\b(?:insert into|update|delete from|truncate)\s+public\.user_data/i);
  assert.doesNotMatch(sql, /^\s*(?:grant|revoke|create|drop)\s/im);
  assert.doesNotMatch(sql, /alter\s+(?:table|policy|trigger|event trigger|role)\b/i);
});

const source = { version: "1.7.4", committedVersion: "1.7.4", head: "candidate", tagCommit: "candidate", remoteCommit: "candidate", dirty: false, latestVersion: "1.7.3" };
test("v1.7.7 release notes describe display-only sync and preserve verification limits", () => {
  const body = buildReleaseBody("1.7.7", "synthetic-reviewed-commit", "UNSIGNED");
  assert.match(body, /Wealth Atlas v1\.7\.7/);
  assert.match(body, /separate account-owned configuration table, not the financial snapshot/);
  assert.match(body, /Windows-to-Mac and Mac-to-Windows/);
  assert.match(body, /not proof of every NSIS wizard/);
  assert.match(body, /UNSIGNED/);
  assert.match(body, /synthetic-reviewed-commit/);
});
test("only a newer reviewed commit matching the local and remote release tags can publish", () => {
  assert.doesNotThrow(() => assertReleaseSource(source));
  for (const change of [{ dirty: true }, { committedVersion: "1.6.19" }, { tagCommit: "stale" }, { remoteCommit: "stale" }, { latestVersion: "1.7.4" }, { latestVersion: "1.8.0" }, { version: "invalid" }]) {
    assert.throws(() => assertReleaseSource({ ...source, ...change }));
  }
});
test("a public release cannot silently disable the existing cloud-login feature", () => {
  assert.throws(() => assertCloudBuildConfigured({}));
  assert.throws(() => assertCloudBuildConfigured({ NEXT_PUBLIC_SUPABASE_URL: "synthetic" }));
  const publicConfig = { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic-fixture.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_synthetic-test-only" };
  assert.doesNotThrow(() => assertCloudBuildConfigured(publicConfig));
  for (const unsafe of ["sb_secret_synthetic", Buffer.from("{}").toString("base64url") + "." + Buffer.from('{"role":"service_role"}').toString("base64url") + ".test"]) {
    assert.throws(() => assertCloudBuildConfigured({ ...publicConfig, NEXT_PUBLIC_SUPABASE_ANON_KEY: unsafe }));
  }
  assert.throws(() => assertCloudBuildConfigured({ ...publicConfig, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:3000" }));
});

function releaseFixture() {
  const folder = mkdtempSync(path.join(os.tmpdir(), "wealth-atlas-release-test-"));
  const installer = Buffer.from("MZ-synthetic-test-artifact");
  writeFileSync(path.join(folder, "Wealth-Atlas-Setup.exe"), installer);
  writeFileSync(path.join(folder, "Wealth-Atlas-Setup.exe.blockmap"), "synthetic-blockmap");
  const sha512 = createHash("sha512").update(installer).digest("base64");
  writeFileSync(path.join(folder, "latest.yml"), `version: 1.7.4\npath: Wealth-Atlas-Setup.exe\nsha512: ${sha512}\nfiles:\n  - url: Wealth-Atlas-Setup.exe\n    sha512: ${sha512}\n    size: ${installer.length}\n`);
  const report = { status: "PASS", release: "UNSIGNED", distributionReady: true, runtimeAcceptanceVerified: true, sourceCommit: "candidate", version: "1.7.4", sha256: createHash("sha256").update(installer).digest("hex"), checks: [{ pass: true }] };
  writeFileSync(path.join(folder, "release-check.json"), JSON.stringify(report));
  writeFileSync(path.join(folder, "installed-release-test.json"), JSON.stringify(createInstalledReleaseAcceptance({
    version: "1.7.4", baselineVersion: "1.7.3", sourceCommit: "candidate", assetHashes: hashReleaseAssets(folder),
    baselineInstallerSha256: "a".repeat(64), checks: ["fresh-profile", "diagnostics", "account-isolation", "upgrade", "rollback"].map((name) => ({ name, pass: true })),
  })));
  return { folder, report };
}

const context = { api: "https://api.github.com/repos/synthetic/fixture", headers: {}, head: "candidate", tag: "v1.7.4" };
async function mockUpload(failBlockmap, existing = false) {
  const { folder } = releaseFixture();
  const calls = [];
  const uploaded = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  console.log = (...args) => originalLog("[mock GitHub only]", ...args);
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ method, url });
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/releases/tags/v1.7.4")) return reply({}, existing ? 200 : 404);
    if (method === "POST" && url.endsWith("/releases")) {
      const request = JSON.parse(options.body);
      assert.equal(request.draft, true);
      assert.equal(request.target_commitish, "candidate");
      return reply({ id: 1, upload_url: "https://uploads.github.com/repos/synthetic/fixture/releases/1/assets{?name,label}" });
    }
    if (method === "POST" && url.includes("/assets?")) {
      const name = new URL(url).searchParams.get("name");
      if (failBlockmap && name.endsWith("blockmap")) return reply({}, 500);
      const asset = { name, state: "uploaded", size: options.body.length, digest: `sha256:${createHash("sha256").update(options.body).digest("hex")}` };
      uploaded.push(asset); return reply(asset);
    }
    if (method === "GET") return reply({ assets: uploaded });
    if (method === "PATCH") { assert.equal(uploaded.length, 3); return reply({}); }
    throw new Error("Unexpected synthetic request");
  };
  try {
    if (failBlockmap || existing) await assert.rejects(publishCheckedRelease(context, folder, "1.7.4"));
    else await publishCheckedRelease(context, folder, "1.7.4");
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  assert.equal(calls.some(({ method }) => method === "DELETE"), false);
  assert.equal(calls.some(({ method }) => method === "PATCH"), !failBlockmap && !existing);
}

test("release stays a draft until all three update assets are verified (mock network only)", () => mockUpload(false));
test("failed asset upload leaves the draft unpublished (mock network only)", () => mockUpload(true));
test("existing release is never overwritten or deleted (mock network only)", () => mockUpload(false, true));
test("unreviewed or corrupt artifacts cannot initiate a network write", async () => {
  const { folder, report } = releaseFixture();
  for (const invalid of [{ distributionReady: false }, { sourceCommit: "stale" }, { sha256: "wrong" }, { status: "FAIL" }, { checks: [] }]) {
    writeFileSync(path.join(folder, "release-check.json"), JSON.stringify({ ...report, ...invalid }));
    await assert.rejects(publishCheckedRelease(context, folder, "1.7.4"), /Publish blocked/);
  }
});

test("both manifest entries must match installer URL, version, size and checksum", () => {
  const bytes = Buffer.from("MZ-fixture");
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const make = (changes = {}) => {
    const manifest = { version: "1.7.4", path: "Wealth-Atlas-Setup.exe", sha512, files: [{ url: "Wealth-Atlas-Setup.exe", sha512, size: bytes.length }], ...changes };
    return [{ name: "Wealth-Atlas-Setup.exe", bytes }, { name: "Wealth-Atlas-Setup.exe.blockmap", bytes: Buffer.from("fixture") }, { name: "latest.yml", bytes: Buffer.from(JSON.stringify(manifest)) }];
  };
  assert.doesNotThrow(() => validateUpdateAssets(make(), "1.7.4"));
  for (const change of [{ version: "1.7.3" }, { path: "../../untrusted.exe" }, { sha512: "invalid" }, { files: [] }, { files: [{ url: "Wealth-Atlas-Setup.exe", sha512, size: 0 }] }]) {
    assert.throws(() => validateUpdateAssets(make(change), "1.7.4"));
  }
  assert.throws(() => validateUpdateAssets(make().slice(0, 2), "1.7.4"));
});
