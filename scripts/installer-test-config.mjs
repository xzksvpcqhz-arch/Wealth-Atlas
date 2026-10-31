import path from "node:path";

export const FRESH_INSTALL_PHASES = Object.freeze([
  "main-startup-failure", "empty", "startup-diagnostics", "main-error-hooks", "localstorage-unavailable", "obsidian-disconnected",
  "obsidian-disconnect-failure", "obsidian-disconnect-success",
  "seed-empty-object", "verify-startup-empty-object", "seed-partial-snapshot",
  "verify-startup-partial-snapshot", "seed-legacy-snapshot", "migration-failure", "verify-legacy-migration", "asset-audit", "diagnostics", "diagnostic-browser-clipboard", "diagnostic-ipc-clipboard", "diagnostic-ipc-failure", "diagnostic-save-failure",
  "error-boundary", "renderer-process-crash", "layout", "vault-bridge", "seed", "indexeddb-open-failure", "indexeddb-blocked", "indexeddb-versionchange", "indexeddb-read-failure", "verify", "edit", "verify-edit",
  "soft-delete", "verify-soft-delete", "restore", "verify-restore", "permanent-delete", "verify-permanent-delete", "account-isolation",
]);

function stableVersion(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

export function validateInstallerVersions(baselineVersion, releaseVersion) {
  if (!stableVersion(baselineVersion) || !stableVersion(releaseVersion)) {
    throw new Error("Installer versions must be stable numeric major.minor.patch versions.");
  }
  const baseline = baselineVersion.split(".").map(Number);
  const release = releaseVersion.split(".").map(Number);
  const difference = baseline.findIndex((part, index) => part !== release[index]);
  if (difference < 0 || baseline[difference] >= release[difference]) {
    throw new Error("The baseline version must be strictly older than the release version.");
  }
}

export function assertExactInstallerVersion(actualVersion, expectedVersion) {
  if (!stableVersion(expectedVersion) || (actualVersion !== expectedVersion && actualVersion !== `${expectedVersion}.0`)) {
    throw new Error("Installer/application version must equal the expected stable version or its exact .0 PE form.");
  }
}

export function denyHttpProxyArgs(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("A bound loopback proxy port is required.");
  return Object.freeze([
    `--proxy-server=http://127.0.0.1:${port}`, "--proxy-bypass-list=<-loopback>", "--disable-quic",
  ]);
}

const forbiddenPart = /^(?:data|exports|private-vault|backups|outputs|review|appdata|vault|\.git|\.aws|\.ssh|\.codex|\.agents)$/i;

function checkedPath(value, projectRoot, paths, label) {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\x00-\x1f\x7f<>"|?*]/.test(value)
    || /^[/\\]{2}/.test(value) || /^[a-z]:[^/\\]/i.test(value)
    || value.replace(/^[a-z]:[/\\]/i, "").includes(":")) {
    throw new Error(`${label} must be a nonempty local filesystem path.`);
  }
  // Validate BEFORE normalization too: traversal must not conceal a private path.
  for (const part of value.split(/[/\\]/)) {
    if (forbiddenPart.test(part) || /^\.env/i.test(part)
      || (part !== "." && part !== ".." && /[. ]$/.test(part))
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(`${label} must not address private, reserved or ambiguous paths.`);
    }
  }
  const resolved = paths.resolve(projectRoot, value);
  if (resolved === paths.parse(resolved).root) throw new Error(`${label} must not be a filesystem root.`);
  return resolved;
}

function within(parent, child, paths) {
  const relative = paths.relative(parent.toLowerCase(), child.toLowerCase());
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

/** Pure selection/validation only: no filesystem, processes, environment reads or
 * implicit defaults to the caller's real profile. The runner supplies a new UUID
 * and checks ordinary files/directories and absence before performing any work. */
export function resolveInstallerTestConfig({ projectRoot, releaseVersion, env = {}, runId, paths = path }) {
  const baselineVersion = env.WEALTH_ATLAS_BASELINE_VERSION ?? "1.7.4";
  validateInstallerVersions(baselineVersion, releaseVersion);
  if (typeof runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)) {
    throw new Error("Installer tests require a new v4 UUID test root.");
  }
  if (typeof projectRoot !== "string" || !paths.isAbsolute(projectRoot)) throw new Error("An absolute project root is required.");
  const root = checkedPath(projectRoot, projectRoot, paths, "Project root");
  const select = (value, label) => checkedPath(value, root, paths, label);
  const releasePath = select(env.WEALTH_ATLAS_RELEASE_DIR ?? paths.join("desktop-dist", `v${releaseVersion}`), "Release directory");
  const baselineInstaller = select(env.WEALTH_ATLAS_BASELINE_INSTALLER ?? paths.join("desktop-dist", `v${baselineVersion}`, "Wealth-Atlas-Setup.exe"), "Baseline installer");
  const extractorPath = select(env.WEALTH_ATLAS_TEST_EXTRACTOR ?? paths.join("node_modules", "electron-winstaller", "vendor", "7z-x64.exe"), "Extractor");
  const releaseInstaller = paths.join(releasePath, "Wealth-Atlas-Setup.exe");
  const testParent = paths.join(root, "work", "installed-release-tests");
  const testRoot = paths.join(testParent, runId);
  if (within(releasePath, testParent, paths) || within(testParent, releasePath, paths)
    || [baselineInstaller, extractorPath].some((file) => within(testParent, file, paths))
    || baselineInstaller.toLowerCase() === releaseInstaller.toLowerCase()
    || extractorPath.toLowerCase() === releaseInstaller.toLowerCase()
    || extractorPath.toLowerCase() === baselineInstaller.toLowerCase()) {
    throw new Error("Installer test sources and synthetic output paths must not overlap.");
  }
  if (![baselineInstaller, extractorPath].every((file) => paths.extname(file).toLowerCase() === ".exe")) {
    throw new Error("Baseline installer and extractor must be executable file paths.");
  }
  const syntheticHomePath = paths.join(testRoot, "synthetic-home");
  return Object.freeze({
    projectRoot: root, releaseVersion, baselineVersion, releasePath, releaseInstaller, baselineInstaller, extractorPath,
    releaseCheckPath: paths.join(releasePath, "release-check.json"),
    reportPath: paths.join(releasePath, "installed-release-test.json"), testParent, testRoot,
    freshInstallPath: paths.join(testRoot, "fresh-app"), freshProfilePath: paths.join(testRoot, "fresh-profile"),
    upgradeInstallPath: paths.join(testRoot, "upgrade-app"), upgradeProfilePath: paths.join(testRoot, "upgrade-profile"),
    upgradedInstallPath: paths.join(testRoot, "upgraded-app"),
    accountIsolationProfilePath: paths.join(testRoot, "account-isolation-profile"),
    vaultPath: paths.join(testRoot, "synthetic-obsidian-vault"), syntheticHomePath,
    roamingPath: paths.join(syntheticHomePath, "synthetic-roaming"), localPath: paths.join(syntheticHomePath, "synthetic-local"),
    tempPath: paths.join(testRoot, "temp"),
  });
}
