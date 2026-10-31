import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { FRESH_INSTALL_PHASES, assertExactInstallerVersion, denyHttpProxyArgs, resolveInstallerTestConfig, validateInstallerVersions } from "../scripts/installer-test-config.mjs";

// Pure fixtures only: no fs, child processes, sockets, installers or real paths.
const projectRoot = "C:\\synthetic\\release-source";
const runId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const p = path.win32;
const select = (env = {}, overrides = {}) => resolveInstallerTestConfig({ projectRoot, releaseVersion: "1.7.5", env, runId, paths: p, ...overrides });

test("default baseline 1.7.4 and target 1.7.5 select version-matched sources", () => {
  const config = select();
  assert.equal(config.baselineVersion, "1.7.4");
  assert.equal(config.baselineInstaller, p.join(projectRoot, "desktop-dist", "v1.7.4", "Wealth-Atlas-Setup.exe"));
  assert.equal(config.releasePath, p.join(projectRoot, "desktop-dist", "v1.7.5"));
  assert.equal(config.releaseInstaller, p.join(config.releasePath, "Wealth-Atlas-Setup.exe"));
  assert.equal(config.reportPath, p.join(config.releasePath, "installed-release-test.json"));
  assert.equal(config.releaseCheckPath, p.join(config.releasePath, "release-check.json"));
  assert.equal(config.extractorPath, p.join(projectRoot, "node_modules", "electron-winstaller", "vendor", "7z-x64.exe"));
});

test("a baseline override also changes its default installer path", () => {
  const config = select({ WEALTH_ATLAS_BASELINE_VERSION: "1.6.19" });
  assert.equal(config.baselineVersion, "1.6.19");
  assert.equal(config.baselineInstaller, p.join(projectRoot, "desktop-dist", "v1.6.19", "Wealth-Atlas-Setup.exe"));
});

test("absolute baseline and real extractor overrides are independent of release directory", () => {
  const baseline = "D:\\synthetic-releases\\v1.7.4\\Wealth-Atlas-Setup.exe";
  const extractor = "C:\\synthetic\\real-repo\\node_modules\\electron-winstaller\\vendor\\7z-x64.exe";
  const release = "D:\\synthetic-releases\\release-candidates\\unique";
  const config = select({ WEALTH_ATLAS_BASELINE_INSTALLER: baseline, WEALTH_ATLAS_RELEASE_DIR: release, WEALTH_ATLAS_TEST_EXTRACTOR: extractor });
  assert.equal(config.baselineInstaller, baseline);
  assert.equal(config.extractorPath, extractor);
  assert.equal(config.releasePath, release);
  assert.equal(config.reportPath, p.join(release, "installed-release-test.json"));
});

test("relative overrides resolve against the supplied source root, not ambient cwd", () => {
  const config = select({ WEALTH_ATLAS_RELEASE_DIR: "desktop-dist/release-candidates/unique", WEALTH_ATLAS_BASELINE_INSTALLER: "desktop-dist/v1.7.4/fixture.exe" });
  assert.equal(config.releasePath, p.join(projectRoot, "desktop-dist", "release-candidates", "unique"));
  assert.equal(config.baselineInstaller, p.join(projectRoot, "desktop-dist", "v1.7.4", "fixture.exe"));
});

test("stable versions compare numerically at every component", () => {
  for (const [baseline, release] of [["1.7.4", "1.7.5"], ["1.9.99", "1.10.0"], ["1.99.99", "2.0.0"], ["0.0.0", "0.0.1"], ["1.7.9", "1.7.10"]]) {
    assert.doesNotThrow(() => validateInstallerVersions(baseline, release));
  }
  for (const [baseline, release] of [["1.7.5", "1.7.5"], ["1.7.6", "1.7.5"], ["1.10.0", "1.9.99"], ["2.0.0", "1.99.99"]]) {
    assert.throws(() => validateInstallerVersions(baseline, release), /strictly older/);
  }
  assert.throws(() => select({}, { releaseVersion: "1.7.4" }), /strictly older/);
});

test("version inputs reject prerelease, metadata, prefix tricks and command/path injection", () => {
  const invalid = [undefined, null, 174, "", " ", " 1.7.4", "1.7.4 ", "01.7.4", "1.07.4", "1.7.04", "1.7", "v1.7.4", "1.7.4.0", "1.7.4-rc.1", "1.7.4+build", "1.7.4\n", "1.7.4;whoami", "1.7.4 && whoami", "$(whoami)", "../1.7.4", "1/7/4", "9007199254740992.0.0"];
  for (const value of invalid) {
    assert.throws(() => validateInstallerVersions(value, "2.0.0"), /stable numeric/);
    assert.throws(() => validateInstallerVersions("0.0.0", value), /stable numeric/);
  }
});

test("PE metadata accepts only the expected version or its exact numeric .0 form", () => {
  assert.doesNotThrow(() => assertExactInstallerVersion("1.7.5", "1.7.5"));
  assert.doesNotThrow(() => assertExactInstallerVersion("1.7.5.0", "1.7.5"));
  for (const actual of ["1.7.4", "1.7.50", "1.7.5.1", "1.7.5.00", "1.7.5.0.0", "1.7.5.0-prefix", "1.7.5-rc.1", "1.7.5+build", "1.7.5\n", undefined]) {
    assert.throws(() => assertExactInstallerVersion(actual, "1.7.5"), /must equal/);
  }
  assert.throws(() => assertExactInstallerVersion("1.7.5-rc.1", "1.7.5-rc.1"));
});

test("path overrides reject blank, control, remote, device and ambiguous Windows paths", () => {
  const invalid = ["", " ", " relative.exe", "relative.exe ", "fixture\u0000.exe", "fixture\n.exe", "\\\\server\\share\\fixture.exe", "//server/share/fixture.exe", "\\\\?\\C:\\fixture.exe", "C:fixture.exe", "C:\\fixture.exe:stream", "C:\\bad*\\fixture.exe", "C:\\bad?\\fixture.exe", "C:\\bad.\\fixture.exe", "C:\\bad \\fixture.exe", "C:\\NUL.exe", "C:\\COM1\\fixture.exe", "C:\\"];
  for (const key of ["WEALTH_ATLAS_RELEASE_DIR", "WEALTH_ATLAS_BASELINE_INSTALLER", "WEALTH_ATLAS_TEST_EXTRACTOR"]) {
    for (const value of invalid) assert.throws(() => select({ [key]: value }), /path|root/i);
  }
});

test("private directories and .env names are refused before traversal normalization", () => {
  for (const part of ["data", "exports", "private-vault", "backups", "outputs", "review", "AppData", "Vault", ".env", ".env.local", ".ssh", ".git"]) {
    for (const key of ["WEALTH_ATLAS_RELEASE_DIR", "WEALTH_ATLAS_BASELINE_INSTALLER", "WEALTH_ATLAS_TEST_EXTRACTOR"]) {
      assert.throws(() => select({ [key]: `C:\\synthetic\\${part}\\fixture.exe` }), /private/);
      assert.throws(() => select({ [key]: `C:\\synthetic\\${part.toUpperCase()}\\..\\fixture.exe` }), /private/);
    }
  }
});

test("project root must be absolute, ordinary in syntax and outside private paths", () => {
  for (const root of ["relative", "C:\\", "C:\\synthetic\\AppData\\repo", "\\\\host\\share\\repo"]) {
    assert.throws(() => select({}, { projectRoot: root }));
  }
});

test("UUID output suffix must be a single canonical v4 UUID", () => {
  for (const value of [undefined, "", "manual-profile", "../escape", `${runId}\\child`, "11111111-1111-1111-8111-111111111111", "11111111-1111-4111-1111-111111111111"]) {
    assert.throws(() => select({}, { runId: value }), /v4 UUID/);
  }
});

test("synthetic output roots never overlap any release, baseline or extractor input", () => {
  const config = select();
  for (const release of [projectRoot, p.join(projectRoot, "work"), config.testParent, config.testRoot, p.join(config.testRoot, "release")]) {
    assert.throws(() => select({ WEALTH_ATLAS_RELEASE_DIR: release }), /overlap/);
  }
  for (const key of ["WEALTH_ATLAS_BASELINE_INSTALLER", "WEALTH_ATLAS_TEST_EXTRACTOR"]) {
    assert.throws(() => select({ [key]: p.join(config.testRoot, "fixture.exe") }), /overlap/);
  }
});

test("input aliases cannot make baseline, release and extractor the same file path", () => {
  const config = select();
  assert.throws(() => select({ WEALTH_ATLAS_BASELINE_INSTALLER: config.releaseInstaller.toUpperCase() }), /overlap/);
  assert.throws(() => select({ WEALTH_ATLAS_TEST_EXTRACTOR: config.releaseInstaller.replaceAll("\\", "/") }), /overlap/);
  assert.throws(() => select({ WEALTH_ATLAS_TEST_EXTRACTOR: config.baselineInstaller.toUpperCase() }), /overlap/);
});

test("baseline and extractor file selections must be .exe paths", () => {
  for (const key of ["WEALTH_ATLAS_BASELINE_INSTALLER", "WEALTH_ATLAS_TEST_EXTRACTOR"]) {
    for (const suffix of ["", ".zip", ".mjs"]) assert.throws(() => select({ [key]: `C:\\synthetic\\fixture${suffix}` }), /executable file paths/);
  }
});

test("profiles, home, vault and extraction roots stay under the selected new UUID", () => {
  const config = select();
  assert.equal(config.testRoot, p.join(projectRoot, "work", "installed-release-tests", runId));
  const keys = ["freshInstallPath", "freshProfilePath", "upgradeInstallPath", "upgradedInstallPath", "upgradeProfilePath", "accountIsolationProfilePath", "vaultPath", "syntheticHomePath", "roamingPath", "localPath", "tempPath"];
  assert.equal(new Set(keys.map((key) => config[key])).size, keys.length);
  for (const key of keys) {
    const relative = p.relative(config.testRoot, config[key]);
    assert.ok(relative && !relative.startsWith("..") && !p.isAbsolute(relative));
  }
  assert.equal(Object.isFrozen(config), true);
  assert.throws(() => { config.testRoot = projectRoot; }, TypeError);
});

test("config reads only its four explicit environment inputs, not credentials or profile/history", () => {
  const keys = new Set(["WEALTH_ATLAS_BASELINE_VERSION", "WEALTH_ATLAS_BASELINE_INSTALLER", "WEALTH_ATLAS_RELEASE_DIR", "WEALTH_ATLAS_TEST_EXTRACTOR"]);
  const seen = [];
  const env = new Proxy({}, { get(_object, key) {
    assert.ok(keys.has(key), "Unexpected environment access");
    seen.push(key);
    return undefined;
  }, ownKeys() { throw new Error("Environment must not be enumerated or copied"); } });
  assert.deepEqual(select(env), select());
  assert.deepEqual(new Set(seen), keys);
});

test("version validation precedes even reading path overrides", () => {
  const env = { WEALTH_ATLAS_BASELINE_VERSION: "1.7.5" };
  for (const key of ["WEALTH_ATLAS_BASELINE_INSTALLER", "WEALTH_ATLAS_RELEASE_DIR", "WEALTH_ATLAS_TEST_EXTRACTOR"]) {
    Object.defineProperty(env, key, { get() { throw new Error("Path selection was attempted"); } });
  }
  assert.throws(() => select(env), /strictly older/);
});

test("selection is deterministic without probing even deliberately nonexistent synthetic sources", () => {
  assert.deepEqual(select(), select());
  const first = select(), second = select({}, { runId: secondId });
  for (const key of ["releaseInstaller", "baselineInstaller", "extractorPath", "reportPath"]) assert.equal(first[key], second[key]);
  assert.notEqual(first.testRoot, second.testRoot);
  assert.doesNotThrow(() => resolveInstallerTestConfig({ projectRoot: path.resolve("nonexistent-synthetic-source"), releaseVersion: "1.7.5", runId }));
});

test("fresh phases retain all original coverage and include isolation and both disconnect outcomes once", () => {
  const original = [
    "main-startup-failure", "empty", "startup-diagnostics", "main-error-hooks", "localstorage-unavailable", "obsidian-disconnected",
    "seed-empty-object", "verify-startup-empty-object", "seed-partial-snapshot", "verify-startup-partial-snapshot", "seed-legacy-snapshot", "migration-failure", "verify-legacy-migration", "asset-audit", "diagnostics", "diagnostic-browser-clipboard", "diagnostic-ipc-clipboard", "diagnostic-ipc-failure", "diagnostic-save-failure",
    "error-boundary", "renderer-process-crash", "layout", "vault-bridge", "seed", "indexeddb-open-failure", "indexeddb-blocked", "indexeddb-versionchange", "indexeddb-read-failure", "verify", "edit", "verify-edit",
    "soft-delete", "verify-soft-delete", "restore", "verify-restore", "permanent-delete", "verify-permanent-delete",
  ];
  const added = ["account-isolation", "obsidian-disconnect-failure", "obsidian-disconnect-success"];
  assert.equal(FRESH_INSTALL_PHASES.length, original.length + added.length);
  assert.equal(new Set(FRESH_INSTALL_PHASES).size, FRESH_INSTALL_PHASES.length);
  assert.deepEqual(FRESH_INSTALL_PHASES.filter((phase) => !added.includes(phase)), original);
  for (const phase of added) assert.equal(FRESH_INSTALL_PHASES.filter((item) => item === phase).length, 1);
  assert.ok(FRESH_INSTALL_PHASES.indexOf("obsidian-disconnect-failure") < FRESH_INSTALL_PHASES.indexOf("obsidian-disconnect-success"));
  assert.equal(Object.isFrozen(FRESH_INSTALL_PHASES), true);
});

test("deny proxy args target only the bound loopback port with no bypass or QUIC", () => {
  assert.deepEqual(denyHttpProxyArgs(54321), ["--proxy-server=http://127.0.0.1:54321", "--proxy-bypass-list=<-loopback>", "--disable-quic"]);
  assert.equal(Object.isFrozen(denyHttpProxyArgs(54321)), true);
  for (const value of [0, -1, 65536, NaN, 1.5, "54321", "54321;whoami", undefined]) assert.throws(() => denyHttpProxyArgs(value), /bound loopback/);
});
