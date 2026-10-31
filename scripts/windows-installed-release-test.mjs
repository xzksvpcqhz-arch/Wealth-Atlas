import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import packageJson from "../package.json" with { type: "json" };
import { FRESH_INSTALL_PHASES, assertExactInstallerVersion, denyHttpProxyArgs, resolveInstallerTestConfig } from "./installer-test-config.mjs";
import { RELEASE_ASSET_NAMES, hashReleaseAssets, createInstalledReleaseAcceptance } from "./release-acceptance.mjs";

// Select and validate every source/output path before any runtime filesystem IO.
const {
  projectRoot, baselineVersion, releaseVersion, baselineInstaller, releaseInstaller, releasePath, releaseCheckPath, reportPath,
  testParent, testRoot, freshInstallPath, freshProfilePath, upgradeInstallPath, upgradedInstallPath, upgradeProfilePath, accountIsolationProfilePath,
  vaultPath, extractorPath, syntheticHomePath, roamingPath, localPath, tempPath,
} = resolveInstallerTestConfig({ projectRoot: process.cwd(), releaseVersion: packageJson.version, env: process.env, runId: randomUUID() });
if (process.platform !== "win32") throw new Error("Installer payload runtime tests require Windows.");

// Never forward credentials, real profile/vault overrides or Electron overrides.
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const powershellPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const childEnvironment = {
  SystemRoot: systemRoot, WINDIR: systemRoot,
  PATH: path.join(systemRoot, "System32"),
  PSModulePath: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  USERPROFILE: syntheticHomePath, HOME: syntheticHomePath,
  HOMEDRIVE: path.parse(syntheticHomePath).root.slice(0, 2), HOMEPATH: syntheticHomePath.slice(2),
  APPDATA: roamingPath, LOCALAPPDATA: localPath, TEMP: tempPath, TMP: tempPath,
};

function assertDirectoryChain(directory, allowMissing = false) {
  let current = path.parse(directory).root;
  for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (allowMissing && error.code === "ENOENT") return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Test paths must use ordinary directories, not links/junctions.");
  }
}

function assertOrdinaryFile(file) {
  assertDirectoryChain(path.dirname(file));
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0) {
    throw new Error("Test inputs must be nonempty ordinary files, not links.");
  }
}

function assertAbsent(file) {
  try { lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Installer tests refuse to reuse or overwrite an existing output.");
}

function hashBaselineInstaller() {
  assertOrdinaryFile(baselineInstaller);
  return createHash("sha256").update(readFileSync(baselineInstaller)).digest("hex");
}

function run(file, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: projectRoot,
      env: { ...childEnvironment, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${path.basename(file)} failed with exit code ${code}.\n${output}`));
        return;
      }
      resolve(output);
    });
  });
}

function executableVersion(filePath) {
  const command = "(Get-Item -LiteralPath $env:WA_EXE).VersionInfo.ProductVersion";
  return execFileSync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...childEnvironment, WA_EXE: filePath },
  }).trim();
}

async function extractPayload(installerPath, installPath, expectedVersion) {
  // Test the real payload without executing NSIS, changing registry/shortcuts,
  // replacing the user's installed app, or using a real financial profile.
  const payloadRoot = path.join(installPath, expectedVersion);
  const stagingRoot = path.join(payloadRoot, "installer-payload");
  const applicationRoot = path.join(payloadRoot, "application");
  assertAbsent(installPath);
  mkdirSync(installPath);
  mkdirSync(payloadRoot);
  mkdirSync(stagingRoot);
  mkdirSync(applicationRoot);
  await run(extractorPath, ["x", installerPath, "$PLUGINSDIR/app-64.7z", `-o${stagingRoot}`, "-aos"]);
  const archivePath = path.join(stagingRoot, "$PLUGINSDIR", "app-64.7z");
  assertOrdinaryFile(archivePath);
  await run(extractorPath, ["x", archivePath, `-o${applicationRoot}`, "-aos"]);
  const applicationPath = path.join(applicationRoot, "Wealth Atlas.exe");
  assertOrdinaryFile(applicationPath);
  assertExactInstallerVersion(executableVersion(applicationPath), expectedVersion);
  return applicationPath;
}

let proxyArgs;
async function smoke(applicationPath, profilePath, phase) {
  const args = [...proxyArgs, `--desktop-smoke=${phase}`];
  if (phase === "localstorage-unavailable") args.unshift("--disable-local-storage");
  const vaultEnv = ["vault-bridge", "obsidian-disconnect-failure", "obsidian-disconnect-success"].includes(phase)
    ? { WEALTH_ATLAS_TEST_VAULT: vaultPath }
    : {};
  const output = await run(applicationPath, args, {
    WEALTH_ATLAS_TEST_PROFILE: profilePath,
    ...vaultEnv,
    WEALTH_ATLAS_DESKTOP_SMOKE: phase,
  });
  const results = [...output.matchAll(/^WEALTH_ATLAS_SMOKE (.+)\r?$/gm)];
  if (results.length !== 1) throw new Error(`Missing or ambiguous payload smoke result: ${phase}.`);
  const result = JSON.parse(results[0][1]);
  if (result.pass !== true || result.mode !== phase) throw new Error(`Payload smoke result did not pass the requested phase: ${phase}.`);
  process.stdout.write(output);
}

function verifyDiagnostics(profilePath, requireInjectedFailures = true) {
  const diagnosticsDirectory = path.join(profilePath, "logs");
  const diagnosticPaths = ["main.log", "renderer.log", "startup.json"].map((fileName) => path.join(diagnosticsDirectory, fileName));
  if (!diagnosticPaths.every(existsSync)) throw new Error("Installed application did not create all startup diagnostic files.");
  if (statSync(path.join(diagnosticsDirectory, "main.log")).size > 512 * 1024 || statSync(path.join(diagnosticsDirectory, "renderer.log")).size > 512 * 1024) throw new Error("Installed diagnostic log exceeded its size limit.");
  const diagnosticText = diagnosticPaths.map((filePath) => readFileSync(filePath, "utf8")).join("\n");
  for (const privateTestValue of ["desktop-test-account", "desktop-test-transaction", "desktop-test-budget", "desktop-test-goal"]) {
    if (diagnosticText.includes(privateTestValue)) throw new Error("Installed diagnostic logs contain seeded finance data.");
  }
  const expectedEvents = ["process-start", "static-protocol-registered", "load-url-start", "load-url-finished", "startup-stage", ...(requireInjectedFailures ? ["startup-failed", "uncaught-exception", "unhandled-rejection", "render-process-gone", "renderer-diagnostic"] : [])];
  for (const expectedEvent of expectedEvents) {
    if (!diagnosticText.includes(`"event":"${expectedEvent}"`)) throw new Error(`Installed diagnostic event is missing: ${expectedEvent}.`);
  }
}

function verifyUpgradeBackup(profilePath) {
  const backupRoot = path.join(profilePath, "backups");
  if (!existsSync(backupRoot)) throw new Error("Upgrade backup directory was not created.");
  const candidates = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes(`v${releaseVersion}-schema-10`))
    .map((entry) => path.join(backupRoot, entry.name));
  if (!candidates.length) throw new Error("No v" + releaseVersion + " schema-10 update backup was found.");
  const valid = candidates.some((directory) => {
    const metadataPath = path.join(directory, "metadata.json");
    const snapshotPath = path.join(directory, "wealth-data.json");
    if (!existsSync(metadataPath) || !existsSync(snapshotPath)) return false;
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    return metadata.appVersion === releaseVersion && metadata.schemaVersion === 10 && snapshot?.accounts?.some((item) => item.id === "desktop-test-account") && snapshot?.transactions?.some((item) => item.id === "desktop-test-transaction");
  });
  if (!valid) throw new Error("Update backup metadata or synthetic snapshot content is incomplete.");
}

assertDirectoryChain(releasePath);
assertAbsent(reportPath); // Fail before tests, including for a dangling symlink.
for (const file of [...RELEASE_ASSET_NAMES.map((name) => path.join(releasePath, name)), baselineInstaller, extractorPath, releaseCheckPath]) {
  assertOrdinaryFile(file);
}
assertDirectoryChain(testParent, true);
assertAbsent(testRoot);
const assetHashes = Object.freeze({ ...hashReleaseAssets(releasePath) });
const baselineInstallerSha256 = hashBaselineInstaller();
const releaseCheck = JSON.parse(readFileSync(releaseCheckPath, "utf8"));
if (releaseCheck.version !== releaseVersion || typeof releaseCheck.sha256 !== "string"
  || !/^[a-f0-9]{64}$/i.test(releaseCheck.sha256) || releaseCheck.sha256.toLowerCase() !== assetHashes["Wealth-Atlas-Setup.exe"]) {
  throw new Error("release-check.json does not match the selected release version and installer digest.");
}
const sourceCommit = releaseCheck.sourceCommit;
if (typeof sourceCommit !== "string" || !sourceCommit.trim()) throw new Error("release-check.json has no source commit.");

mkdirSync(testParent, { recursive: true });
mkdirSync(testRoot); // Exclusive UUID reservation: never reuse even an empty root.
for (const directory of [freshProfilePath, upgradeProfilePath, accountIsolationProfilePath, vaultPath, syntheticHomePath, roamingPath, localPath, tempPath]) mkdirSync(directory);
assertExactInstallerVersion(executableVersion(baselineInstaller), baselineVersion);
assertExactInstallerVersion(executableVersion(releaseInstaller), releaseVersion);

// Chromium HTTP(S)/WebSocket traffic is denied by a process-only loopback proxy.
// It closes every connection without parsing, logging or forwarding any request.
// This is not an OS firewall or a claim about arbitrary Node/native sockets.
const denyProxy = createServer((socket) => { socket.destroy(); });
await new Promise((resolve, reject) => {
  denyProxy.once("error", reject);
  denyProxy.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
    denyProxy.removeListener("error", reject);
    resolve();
  });
});
try {
  const address = denyProxy.address();
  if (!address || address.address !== "127.0.0.1") throw new Error("Deny proxy did not bind exclusively to loopback.");
  // Kept in outer scope so every smoke launch, including rollback, uses it.
  proxyArgs = denyHttpProxyArgs(address.port);
  const checks = [{ name: "chromium-deny-only-loopback-proxy", pass: true }];
  const freshApp = await extractPayload(releaseInstaller, freshInstallPath, releaseVersion);
  const freshPhases = FRESH_INSTALL_PHASES;
  for (const phase of freshPhases) {
    // This check needs an empty guest profile, not the earlier migration fixtures.
    await smoke(freshApp, phase === "account-isolation" ? accountIsolationProfilePath : freshProfilePath, phase);
    if (["account-isolation", "obsidian-disconnect-failure", "obsidian-disconnect-success"].includes(phase)) checks.push({ name: phase, pass: true });
  }
  await smoke(freshApp, freshProfilePath, "verify-permanent-delete");
  verifyDiagnostics(freshProfilePath);
  checks.push({ name: "fresh-profile", pass: true }, { name: "diagnostics", pass: true });

  const baselineApp = await extractPayload(baselineInstaller, upgradeInstallPath, baselineVersion);
  await smoke(baselineApp, upgradeProfilePath, "empty");
  await smoke(baselineApp, upgradeProfilePath, "seed");
  await smoke(baselineApp, upgradeProfilePath, "verify");

  // Separate immutable extraction roots; rollback/resume reuse payloads, not files.
  const upgradeApp = await extractPayload(releaseInstaller, upgradedInstallPath, releaseVersion);
  await smoke(upgradeApp, upgradeProfilePath, "verify");
  await smoke(upgradeApp, upgradeProfilePath, "startup-diagnostics");
  await smoke(upgradeApp, upgradeProfilePath, "verify");
  verifyUpgradeBackup(upgradeProfilePath);
  checks.push({ name: "upgrade", pass: true });

  await smoke(baselineApp, upgradeProfilePath, "verify");
  await smoke(upgradeApp, upgradeProfilePath, "verify");
  verifyDiagnostics(upgradeProfilePath, false);
  checks.push({ name: "rollback", pass: true });

  assertDirectoryChain(releasePath);
  const finalAssetHashes = hashReleaseAssets(releasePath);
  const finalBaselineInstallerSha256 = hashBaselineInstaller();
  if (Object.keys(finalAssetHashes).length !== Object.keys(assetHashes).length
    || RELEASE_ASSET_NAMES.some((name) => finalAssetHashes[name] !== assetHashes[name])
    || finalBaselineInstallerSha256 !== baselineInstallerSha256) {
    throw new Error("Release assets or baseline installer changed during payload runtime tests; acceptance not written.");
  }
  const report = createInstalledReleaseAcceptance({ version: releaseVersion, baselineVersion, sourceCommit, assetHashes, baselineInstallerSha256, checks,
    localCandidate: releaseCheck.localCandidate === true });
  report.networkScope = "chromium-deny-only-loopback-http-proxy";
  report.proxyForwardingEnabled = false;
  report.systemNetworkSettingsChanged = false;
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  console.log("Installer payload runtime test: PASS (NSIS wizard and registry not exercised)");
  console.log("Network scope: Chromium deny-only loopback HTTP proxy; no forwarding or system proxy changes");
  console.log(`Fresh isolated profile: v${releaseVersion} PASS`);
  console.log(`Upgrade: v${baselineVersion} -> v${releaseVersion} PASS`);
  console.log(`Rollback data compatibility: v${releaseVersion} -> v${baselineVersion} PASS`);
  console.log(`Isolated test root: ${testRoot}`);
} finally {
  await new Promise((resolve, reject) => denyProxy.close((error) => error ? reject(error) : resolve()));
}
