import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RELEASE_ASSET_NAMES, REQUIRED_RUNTIME_CHECKS, hashReleaseAssets, createInstalledReleaseAcceptance, assertInstalledReleaseAcceptance, readInstalledReleaseAcceptance } from "../scripts/release-acceptance.mjs";
import { publishCheckedRelease, buildReleaseBody } from "../scripts/github-release.mjs";
import { assertLocalReleaseInput } from "../scripts/build-local-release.mjs";
import { assertPackagedRuntimeDependencies, stageRuntimeApplication } from "../scripts/runtime-dependencies.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wa-runtime-acceptance-"));
  const installer = Buffer.from("MZ-synthetic-never-executed"), sha512 = createHash("sha512").update(installer).digest("base64");
  writeFileSync(path.join(directory, RELEASE_ASSET_NAMES[0]), installer);
  writeFileSync(path.join(directory, RELEASE_ASSET_NAMES[1]), "synthetic-blockmap");
  writeFileSync(path.join(directory, RELEASE_ASSET_NAMES[2]), JSON.stringify({ version: "1.7.5", path: RELEASE_ASSET_NAMES[0], sha512,
    files: [{ url: RELEASE_ASSET_NAMES[0], sha512, size: installer.length }] }));
  const expected = { version: "1.7.5", sourceCommit: "synthetic-commit", assetHashes: hashReleaseAssets(directory) };
  const report = createInstalledReleaseAcceptance({ ...expected, baselineVersion: "1.7.4", baselineInstallerSha256: "b".repeat(64),
    checks: REQUIRED_RUNTIME_CHECKS.map((name) => ({ name, pass: true })) });
  writeFileSync(path.join(directory, "installed-release-test.json"), JSON.stringify(report));
  writeFileSync(path.join(directory, "release-check.json"), JSON.stringify({ status: "PASS", version: expected.version, sourceCommit: expected.sourceCommit,
    runtimeAcceptanceVerified: true, distributionReady: true, sha256: expected.assetHashes[RELEASE_ASSET_NAMES[0]], checks: [{ pass: true }] }));
  return { directory, expected, report };
}

test("runtime acceptance binds every final asset, source version and commit", () => {
  const { directory, expected, report } = fixture();
  assert.equal(assertInstalledReleaseAcceptance(report, expected), true);
  assert.equal(readInstalledReleaseAcceptance(directory, expected).status, "PASS");
  for (const change of [{ status: "FAIL" }, { version: "1.7.4" }, { sourceCommit: "different" }, { baselineVersion: "1.7.5" },
    { baselineVersion: "1.7.6" }, { baselineVersion: "1.7.4-rc.1" }, { baselineInstallerSha256: "" }, { completedAt: "bad" },
    { scope: "unpackaged-source" }, { nsisWizardExecuted: true }, { productionProfileAccessed: true }, { assetHashes: {} },
    { checks: [] }, { checks: report.checks.slice(0, -1) }, { checks: [...report.checks, report.checks[0]] },
    { checks: report.checks.map((c, i) => i ? c : { ...c, pass: false }) }]) {
    assert.throws(() => assertInstalledReleaseAcceptance({ ...report, ...change }, expected), /Publish blocked/);
  }
});

test("rebuilt installer, blockmap or manifest cannot reuse old runtime acceptance", () => {
  for (const name of RELEASE_ASSET_NAMES) {
    const { directory, expected } = fixture();
    writeFileSync(path.join(directory, name), Buffer.concat([readFileSync(path.join(directory, name)), Buffer.from("synthetic-change")]));
    assert.throws(() => readInstalledReleaseAcceptance(directory, { ...expected, assetHashes: hashReleaseAssets(directory) }), /Publish blocked/);
  }
});

test("missing and malformed runtime evidence is refused, not treated as a previous pass", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wa-empty-runtime-"));
  assert.throws(() => readInstalledReleaseAcceptance(directory, {}), /Publish blocked/);
  writeFileSync(path.join(directory, "installed-release-test.json"), "not json");
  assert.throws(() => readInstalledReleaseAcceptance(directory, {}), /Publish blocked/);
});

test("publish refuses stale acceptance and local candidates before any network request", async () => {
  const { directory, expected } = fixture(), original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Synthetic network must not be called"); };
  try {
    const checkPath = path.join(directory, "release-check.json"), check = JSON.parse(readFileSync(checkPath, "utf8"));
    writeFileSync(checkPath, JSON.stringify({ ...check, localCandidate: true }));
    await assert.rejects(publishCheckedRelease({ head: expected.sourceCommit }, directory, "1.7.5"), /Publish blocked/);
    writeFileSync(checkPath, JSON.stringify(check));
    const reportPath = path.join(directory, "installed-release-test.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    writeFileSync(reportPath, JSON.stringify({ ...report, installerSha256: "0".repeat(64) }));
    await assert.rejects(publishCheckedRelease({ head: expected.sourceCommit }, directory, "1.7.5"), /Publish blocked/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test("release copy describes current sync scope and never promises a universal offline fix", () => {
  const body = buildReleaseBody("1.7.5", "synthetic-commit", "UNSIGNED");
  assert.match(body, /account-isolated/i); assert.match(body, /password-recovery/i);
  assert.match(body, /verification lifetime/i); assert.match(body, /UNSIGNED/);
  assert.doesNotMatch(body, /No UI redesign or financial calculation\/cloud-sync changes/);
});

test("local release staging refuses private inputs before any file read", () => {
  for (const name of [".env.local", "public/data/private.json", "backups/a.json", "exports/a.csv", "outputs/a.txt", "review/result.json",
    "private-vault/note.md", "public/Vaults/note.md", "public/userprofiles/private.json", "public/realfinance/statement.json",
    "desktop/update-token.json", "desktop/cert.pfx", "../outside", "C:\\private.txt"]) assert.throws(() => assertLocalReleaseInput(name));
  for (const name of ["app/page.tsx", "desktop/main.cjs", "lib/finance.ts", "scripts/windows-release.mjs"]) assert.doesNotThrow(() => assertLocalReleaseInput(name));
});

test("candidate provenance cannot be erased by omitting the candidate environment flag", async () => {
  const { directory, expected, report } = fixture();
  assert.throws(() => assertInstalledReleaseAcceptance({ ...report, localCandidate: true }, expected), /Publish blocked/);
  assert.equal(assertInstalledReleaseAcceptance({ ...report, localCandidate: true }, { ...expected, localCandidate: true }), true);
  writeFileSync(path.join(directory, "local-candidate-provenance.json"), JSON.stringify({ localCandidate: true }));
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("No network expected"); };
  try { await assert.rejects(publishCheckedRelease({ head: expected.sourceCommit }, directory, "1.7.5"), /Publish blocked/); assert.equal(calls, 0); }
  finally { globalThis.fetch = original; }
});

test("packaged updater and all required nested runtime modules must have executable entry files", () => {
  const packages = { "package.json": { dependencies: { updater: "1" } }, "node_modules/updater/package.json": { main: "out/main.js", dependencies: { nested: "1" } },
    "node_modules/updater/node_modules/nested/package.json": { main: "index.js" } };
  const files = [...Object.keys(packages), "node_modules/updater/out/main.js", "node_modules/updater/node_modules/nested/index.js"];
  const read = (file) => packages[file];
  assert.equal(assertPackagedRuntimeDependencies(files, read), 2);
  assert.throws(() => assertPackagedRuntimeDependencies(files.filter((f) => !f.includes("nested")), read), /dependency is missing/);
  assert.throws(() => assertPackagedRuntimeDependencies(files.filter((f) => !f.endsWith("out/main.js")), read), /entry is missing/);
});

test("fresh formal runtime builds remain distinct from local candidates and cannot promote candidate source", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wa-runtime-staging-"));
  const source = path.join(root, "source");
  for (const directory of ["out", "desktop", "build", "node_modules"]) mkdirSync(path.join(source, directory), { recursive: true });
  writeFileSync(path.join(source, "out/index.html"), "synthetic static output");
  const pkg = { name: "synthetic-runtime", version: "1.7.6", main: "desktop/main.cjs", dependencies: {}, devDependencies: { synthetic: "1" }, scripts: { synthetic: "not-run" } };
  writeFileSync(path.join(source, "package.json"), JSON.stringify(pkg));
  await stageRuntimeApplication(source, source, path.join(root, "candidate"));
  assert.equal(JSON.parse(readFileSync(path.join(root, "candidate/package.json"))).wealthAtlasLocalReleaseCandidate, true);
  await stageRuntimeApplication(source, source, path.join(root, "formal"), { localCandidate: false });
  const formal = JSON.parse(readFileSync(path.join(root, "formal/package.json")));
  assert.equal(Object.hasOwn(formal, "wealthAtlasLocalReleaseCandidate"), false);
  assert.equal(Object.hasOwn(formal, "devDependencies"), false); assert.equal(Object.hasOwn(formal, "scripts"), false);
  writeFileSync(path.join(source, "package.json"), JSON.stringify({ ...pkg, wealthAtlasLocalReleaseCandidate: true }));
  await assert.rejects(stageRuntimeApplication(source, source, path.join(root, "refused"), { localCandidate: false }), /cannot be promoted/);
  assert.equal(existsSync(path.join(root, "refused/package.json")), false);
});

test("public staging uses committed, unchanged assets rather than untracked/ignored files", () => {
  const source = readFileSync(new URL("../scripts/build-local-release.mjs", import.meta.url), "utf8");
  assert.match(source, /\["ls-files", "-z", "--", "public"\]/);
  assert.match(source, /Public assets changed since the approved source/);
  assert.match(source, /!publicFiles\.has\(relative\)/);
  assert.ok(source.indexOf('relative.startsWith("public/")') < source.indexOf("await lstat(from)"));
});

test("packaging runs exact-payload acceptance before final validation and publication", () => {
  const source = readFileSync(new URL("../scripts/windows-release.mjs", import.meta.url), "utf8");
  const built = source.indexOf("await build({");
  const firstCheck = source.indexOf('["scripts/windows-release-check.mjs"]', built);
  const runtime = source.indexOf('["scripts/windows-installed-release-test.mjs"]', firstCheck);
  const finalCheck = source.indexOf('["scripts/windows-release-check.mjs"]', runtime);
  const publish = source.indexOf("await publishCheckedRelease", finalCheck);
  assert.ok(built > 0 && firstCheck > built && runtime > firstCheck && finalCheck > runtime && publish > finalCheck);
  assert.match(source, /localCandidate && process\.env\.WEALTH_ATLAS_PUBLISH === "1"/);
  assert.match(source, /Release output already exists/);
  assert.match(source, /from: path\.join\(runtimeApp, "node_modules"\), to: "node_modules"/);
});
