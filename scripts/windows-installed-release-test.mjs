import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import packageJson from "../package.json" with { type: "json" };

const projectRoot = process.cwd();
const baselineVersion = "1.7.3";
const releaseVersion = packageJson.version;
const baselineInstaller = process.env.WEALTH_ATLAS_BASELINE_INSTALLER || path.join(projectRoot, "desktop-dist", `v${baselineVersion}`, "Wealth-Atlas-Setup.exe");
const releaseInstaller = path.join(projectRoot, "desktop-dist", `v${releaseVersion}`, "Wealth-Atlas-Setup.exe");
const testRoot = path.join(projectRoot, "work", "installed-release-tests", randomUUID());
const freshInstallPath = path.join(testRoot, "fresh-app");
const freshProfilePath = path.join(testRoot, "fresh-profile");
const upgradeInstallPath = path.join(testRoot, "upgrade-app");
const upgradeProfilePath = path.join(testRoot, "upgrade-profile");
const vaultPath = path.join(testRoot, "vault");
const extractorPath = process.env.WEALTH_ATLAS_TEST_EXTRACTOR || path.join(projectRoot, "node_modules", "electron-winstaller", "vendor", "7z-x64.exe");

function run(file, args, env = {}, requireSmokeOutput = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 || (requireSmokeOutput && !output.includes("WEALTH_ATLAS_SMOKE"))) {
        reject(new Error(`${path.basename(file)} failed with exit code ${code}.\n${output}`));
        return;
      }
      resolve(output);
    });
  });
}

function executableVersion(filePath) {
  const command = "(Get-Item -LiteralPath $env:WA_EXE).VersionInfo.ProductVersion";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    env: { ...process.env, WA_EXE: filePath },
  }).trim();
}

async function install(installerPath, installPath, expectedVersion) {
  // Test the real payload without executing NSIS, changing registry/shortcuts,
  // replacing the user's installed app, or using a real financial profile.
  const payloadRoot = path.join(installPath, expectedVersion);
  const stagingRoot = path.join(payloadRoot, "installer-payload");
  const applicationRoot = path.join(payloadRoot, "application");
  mkdirSync(stagingRoot, { recursive: true });
  mkdirSync(applicationRoot, { recursive: true });
  await run(extractorPath, ["x", installerPath, "$PLUGINSDIR/app-64.7z", `-o${stagingRoot}`, "-y"]);
  await run(extractorPath, ["x", path.join(stagingRoot, "$PLUGINSDIR", "app-64.7z"), `-o${applicationRoot}`, "-y"]);
  const applicationPath = path.join(applicationRoot, "Wealth Atlas.exe");
  if (!existsSync(applicationPath)) throw new Error("Installed Wealth Atlas executable was not found.");
  const actualVersion = executableVersion(applicationPath);
  if (!(actualVersion === expectedVersion || actualVersion.startsWith(`${expectedVersion}.`))) {
    throw new Error(`Installed version mismatch: ${actualVersion} / expected ${expectedVersion}.`);
  }
  return applicationPath;
}

async function smoke(applicationPath, profilePath, phase) {
  const args = [`--desktop-smoke=${phase}`];
  if (phase === "localstorage-unavailable") args.unshift("--disable-local-storage");
  const vaultEnv = ["vault-bridge", "obsidian-disconnect-failure", "obsidian-disconnect-success"].includes(phase)
    ? { WEALTH_ATLAS_TEST_VAULT: vaultPath }
    : {};
  const output = await run(applicationPath, args, {
    WEALTH_ATLAS_TEST_PROFILE: profilePath,
    ...vaultEnv,
    WEALTH_ATLAS_DESKTOP_SMOKE: phase,
  }, true);
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

for (const requiredInstaller of [baselineInstaller, releaseInstaller]) {
  if (!existsSync(requiredInstaller)) throw new Error(`Required installer does not exist: ${path.relative(projectRoot, requiredInstaller)}`);
}

const freshApp = await install(releaseInstaller, freshInstallPath, releaseVersion);
const freshPhases = [
  "main-startup-failure", "empty", "startup-diagnostics", "main-error-hooks", "localstorage-unavailable", "obsidian-disconnected",
  "seed-empty-object", "verify-startup-empty-object", "seed-partial-snapshot",
  "verify-startup-partial-snapshot", "seed-legacy-snapshot", "migration-failure", "verify-legacy-migration", "asset-audit", "diagnostics", "diagnostic-browser-clipboard", "diagnostic-ipc-clipboard", "diagnostic-ipc-failure", "diagnostic-save-failure",
  "error-boundary", "renderer-process-crash", "layout", "vault-bridge", "seed", "indexeddb-open-failure", "indexeddb-blocked", "indexeddb-versionchange", "indexeddb-read-failure", "verify", "edit", "verify-edit",
  "soft-delete", "verify-soft-delete", "restore", "verify-restore", "permanent-delete", "verify-permanent-delete",
];
for (const phase of freshPhases) await smoke(freshApp, freshProfilePath, phase);
await smoke(freshApp, freshProfilePath, "verify-permanent-delete");
verifyDiagnostics(freshProfilePath);

let upgradeApp = await install(baselineInstaller, upgradeInstallPath, baselineVersion);
await smoke(upgradeApp, upgradeProfilePath, "empty");
await smoke(upgradeApp, upgradeProfilePath, "seed");
await smoke(upgradeApp, upgradeProfilePath, "verify");

upgradeApp = await install(releaseInstaller, upgradeInstallPath, releaseVersion);
await smoke(upgradeApp, upgradeProfilePath, "verify");
await smoke(upgradeApp, upgradeProfilePath, "startup-diagnostics");
await smoke(upgradeApp, upgradeProfilePath, "verify");
verifyUpgradeBackup(upgradeProfilePath);

const rollbackApp = await install(baselineInstaller, upgradeInstallPath, baselineVersion);
await smoke(rollbackApp, upgradeProfilePath, "verify");

upgradeApp = await install(releaseInstaller, upgradeInstallPath, releaseVersion);
await smoke(upgradeApp, upgradeProfilePath, "verify");
verifyDiagnostics(upgradeProfilePath, false);

console.log("Installer payload runtime test: PASS (NSIS wizard and registry not exercised)");
console.log(`Fresh isolated profile: v${releaseVersion} PASS`);
console.log(`Upgrade: v${baselineVersion} -> v${releaseVersion} PASS`);
console.log(`Rollback data compatibility: v${releaseVersion} -> v${baselineVersion} PASS`);
console.log(`Isolated test root: ${testRoot}`);
