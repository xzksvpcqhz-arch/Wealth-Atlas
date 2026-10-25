import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertReleaseSource, assertCloudBuildConfigured, publishCheckedRelease, validateUpdateAssets } from "../scripts/github-release.mjs";

const source = { version: "1.7.4", committedVersion: "1.7.4", head: "candidate", tagCommit: "candidate", remoteCommit: "candidate", dirty: false, latestVersion: "1.7.3" };
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
  const report = { status: "PASS", release: "UNSIGNED", distributionReady: true, sourceCommit: "candidate", version: "1.7.4", sha256: createHash("sha256").update(installer).digest("hex"), checks: [{ pass: true }] };
  writeFileSync(path.join(folder, "release-check.json"), JSON.stringify(report));
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
