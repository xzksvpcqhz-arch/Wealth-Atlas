import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const RELEASE_ASSET_NAMES = Object.freeze([
  "Wealth-Atlas-Setup.exe", "Wealth-Atlas-Setup.exe.blockmap", "latest.yml",
]);
export const REQUIRED_RUNTIME_CHECKS = Object.freeze([
  "fresh-profile", "diagnostics", "account-isolation", "upgrade", "rollback",
]);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blocked = () => { throw new Error("Publish blocked: final installer runtime acceptance is missing, invalid or does not match the exact release assets."); };
const stable = (value) => typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  && value.split(".").every((part) => Number.isSafeInteger(Number(part)));

export function isOlderStableVersion(baseline, version) {
  if (!stable(baseline) || !stable(version)) return false;
  const a = baseline.split(".").map(Number), b = version.split(".").map(Number);
  const index = a.findIndex((part, i) => part !== b[i]);
  return index >= 0 && a[index] < b[index];
}

export function hashReleaseAssets(directory) {
  return Object.fromEntries(RELEASE_ASSET_NAMES.map((name) => {
    const file = path.join(directory, name), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0) blocked();
    return [name, sha256(readFileSync(file))];
  }));
}

export function assertInstalledReleaseAcceptance(report, { version, sourceCommit, assetHashes, localCandidate = false }) {
  if (!report || report.format !== "wealth-atlas-installed-release-acceptance" || report.formatVersion !== 1
    || report.status !== "PASS" || report.version !== version || !isOlderStableVersion(report.baselineVersion, version)
    || typeof sourceCommit !== "string" || !sourceCommit || report.sourceCommit !== sourceCommit
    || report.localCandidate !== localCandidate || report.scope !== "extracted-nsis-payload" || report.nsisWizardExecuted !== false || report.productionProfileAccessed !== false
    || !/^[a-f0-9]{64}$/.test(report.baselineInstallerSha256 ?? "")
    || !Number.isFinite(Date.parse(report.completedAt)) || !Array.isArray(report.checks) || !report.checks.length) blocked();
  if (!report.assetHashes || !assetHashes || Object.keys(report.assetHashes).length !== RELEASE_ASSET_NAMES.length
    || Object.keys(assetHashes).length !== RELEASE_ASSET_NAMES.length) blocked();
  for (const name of RELEASE_ASSET_NAMES) {
    if (!/^[a-f0-9]{64}$/.test(assetHashes[name] ?? "") || report.assetHashes[name] !== assetHashes[name]) blocked();
  }
  if (report.installerSha256 !== assetHashes[RELEASE_ASSET_NAMES[0]]) blocked();
  const names = new Set();
  for (const check of report.checks) {
    if (!check || typeof check.name !== "string" || !check.name || check.pass !== true || names.has(check.name)) blocked();
    names.add(check.name);
  }
  if (REQUIRED_RUNTIME_CHECKS.some((name) => !names.has(name))) blocked();
  return true;
}

export function createInstalledReleaseAcceptance({ version, baselineVersion, sourceCommit, assetHashes, baselineInstallerSha256, checks, localCandidate = false }) {
  const report = {
    format: "wealth-atlas-installed-release-acceptance", formatVersion: 1, status: "PASS",
    version, baselineVersion, sourceCommit, localCandidate, completedAt: new Date().toISOString(),
    scope: "extracted-nsis-payload", nsisWizardExecuted: false, productionProfileAccessed: false,
    installerSha256: assetHashes?.[RELEASE_ASSET_NAMES[0]], assetHashes: { ...assetHashes }, baselineInstallerSha256,
    checks: checks.map(({ name, pass }) => ({ name, pass })),
  };
  assertInstalledReleaseAcceptance(report, { version, sourceCommit, assetHashes, localCandidate });
  return report;
}

export function readInstalledReleaseAcceptance(directory, expected) {
  let report;
  try {
    const file = path.join(directory, "installed-release-test.json"), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) blocked();
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch { blocked(); }
  assertInstalledReleaseAcceptance(report, expected);
  return report;
}
