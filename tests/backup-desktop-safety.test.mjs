import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createDesktopBackupStore } = require("../desktop/backup-safety.cjs");
const { createDataProfileRouter } = require("../desktop/data-profiles.cjs");
const { transpileModule, ModuleKind } = require("typescript");
const repo = fileURLToPath(new URL("../", import.meta.url));
const work = path.join(repo, "work");
await fs.mkdir(work, { recursive: true });
// Retain all synthetic artifacts. No cleanup, recursive deletes, Electron launch,
// real profiles, financial backups, secrets, database or network access.
const runRoot = await fs.mkdtemp(path.join(work, "desktop-backup-safety-"));
const fixedDate = "2026-11-20T01:02:03.004Z";
const snapshot = { schemaVersion: 10, accounts: [{ id: "synthetic-account", balance: 123 }], reportCurrency: "MYR" };
const payload = () => ({ snapshot: structuredClone(snapshot), schemaVersion: 10 });
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const fixtureRoot = () => fs.mkdtemp(path.join(runRoot, "case-"));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function guardedFs(overrides = {}, calls = []) {
  return new Proxy(fs, {
    get(target, method) {
      if (["rm", "rmdir", "unlink"].includes(method)) return () => { throw new Error("Test forbids deletion."); };
      if (typeof target[method] !== "function") return target[method];
      return (...args) => {
        const location = path.resolve(String(args[0]));
        const relative = path.relative(runRoot, location);
        assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "I/O must stay under synthetic work root");
        calls.push({ method, args });
        return (overrides[method] ?? target[method])(...args);
      };
    },
  });
}

function store(root, extras = {}) {
  return createDesktopBackupStore({ getProfileRoot: () => root, getAppVersion: () => "synthetic-1.7.9", now: () => new Date(fixedDate), fs: guardedFs(), ...extras });
}

async function fixture(root, kind, id, options = {}) {
  const folder = path.join(root, kind === "autosave" ? "autosaves" : "backups", id);
  await fs.mkdir(folder, { recursive: true });
  const buffer = options.buffer ?? encode(snapshot);
  const metadata = Object.hasOwn(options, "metadata") ? options.metadata : {
    backupVersion: kind === "autosave" ? 3 : 2, kind, createdAt: fixedDate,
    appVersion: "synthetic-1.7.9", schemaVersion: 10, snapshotSha256: digest(buffer),
    ...(kind === "backup" ? { manifest: "manifest.json" } : {}),
  };
  const manifest = Object.hasOwn(options, "manifest") ? options.manifest : (kind === "backup" ? {
    createdAt: fixedDate, appVersion: "synthetic-1.7.9", schemaVersion: 10,
    files: [{ name: "wealth-data.json", bytes: buffer.byteLength, sha256: digest(buffer) }],
  } : null);
  await fs.writeFile(path.join(folder, "wealth-data.json"), buffer);
  if (metadata !== null) await fs.writeFile(path.join(folder, "metadata.json"), typeof metadata === "string" ? metadata : encode(metadata));
  if (manifest !== null) await fs.writeFile(path.join(folder, "manifest.json"), typeof manifest === "string" ? manifest : encode(manifest));
  return folder;
}

async function inventory(folder) {
  const result = {};
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, "Inventory must not follow links");
    result[entry.name] = entry.isDirectory() ? await inventory(path.join(folder, entry.name)) : digest(await fs.readFile(path.join(folder, entry.name)));
  }
  return result;
}

test("oldest of ten autosaves and every original backup survive fresh safety backups, even with a startup cache", async () => {
  const root = await fixtureRoot();
  for (let i = 0; i < 10; i++) await fixture(root, "autosave", `20000101-autosave-${String(i).padStart(2, "0")}`);
  const original = await fixture(root, "backup", "legacy-v1.7.9-schema-10");
  const beforeAutosaves = await inventory(path.join(root, "autosaves"));
  const beforeOriginal = await inventory(original);
  const backups = store(root);
  const first = await backups.createRestoreSafetyBackup(payload());
  const secondPayload = payload(); secondPayload.snapshot.accounts[0].balance = 456;
  const second = await backups.createRestoreSafetyBackup(secondPayload);
  assert.notEqual(first.id, second.id);
  for (const item of [first, second]) {
    assert.equal(item.kind, "backup"); assert.equal(item.reused, false);
    assert.equal(item.createdAt, fixedDate);
    assert.equal(path.dirname(item.path), path.join(root, "backups"));
    assert.equal(item.snapshotSha256, digest(await fs.readFile(path.join(item.path, "wealth-data.json"))));
    const metadata = JSON.parse(await fs.readFile(path.join(item.path, "metadata.json"), "utf8"));
    assert.equal(metadata.reason, "pre-restore"); assert.equal(metadata.backupVersion, 4);
    assert.equal(metadata.networkUpload, false);
  }
  assert.deepEqual(await backups.readBackup(first), snapshot);
  assert.deepEqual(await backups.readBackup(second), secondPayload.snapshot);
  assert.deepEqual(await backups.readBackup({ id: "20000101-autosave-00", kind: "autosave" }), snapshot);
  assert.deepEqual(await inventory(path.join(root, "autosaves")), beforeAutosaves);
  assert.deepEqual(await inventory(original), beforeOriginal);
  assert.equal((await fs.readdir(path.join(root, "backups"))).length, 3);
});

test("same-millisecond concurrent calls create unique verified copies without overwriting", async () => {
  const root = await fixtureRoot();
  const backups = store(root);
  const results = await Promise.all(Array.from({ length: 20 }, () => backups.createRestoreSafetyBackup(payload())));
  assert.equal(new Set(results.map((item) => item.id)).size, 20);
  for (const item of results) assert.deepEqual(await backups.readBackup(item), snapshot);
});

test("normalized asset optional undefined object props match original autosave JSON without corrupting arrays", async () => {
  const root = await fixtureRoot(); const backups = store(root);
  const input = payload();
  input.snapshot.assets = [
    { id: "synthetic-unsold-asset", name: "Synthetic asset", cost: 25, sellPrice: undefined, saleDate: undefined },
    { id: "synthetic-sold-asset", name: "Synthetic sold asset", cost: 30, sellPrice: 40, saleDate: "2026-11-19" },
  ];
  input.snapshot.optionalSetting = undefined;
  input.snapshot.syntheticArray = [null, { optional: undefined, retained: "yes" }, []];
  const expectedBytes = encode(input.snapshot);
  const result = await backups.createRestoreSafetyBackup(input);
  assert.deepEqual(await fs.readFile(path.join(result.path, "wealth-data.json")), expectedBytes);
  const restored = await backups.readBackup(result);
  assert.deepEqual(restored, JSON.parse(expectedBytes));
  assert.equal(Object.hasOwn(restored.assets[0], "sellPrice"), false);
  assert.equal(Object.hasOwn(restored.assets[0], "saleDate"), false);
  assert.equal(Object.hasOwn(input.snapshot.assets[0], "sellPrice"), true, "Input is untouched");
  for (const values of [[undefined], ["retained", undefined], Array(1)]) {
    await assert.rejects(backups.createRestoreSafetyBackup({ snapshot: { values }, schemaVersion: 10 }), /JSON values/);
  }
});

test("exclusive mkdir retries collisions and bounded exhaustion preserves existing bytes", async () => {
  const root = await fixtureRoot();
  const first = await store(root, { randomId: () => "collision" }).createRestoreSafetyBackup(payload());
  const original = await inventory(first.path);
  let attempts = 0;
  const next = await store(root, { randomId: () => ++attempts === 1 ? "collision" : "unique" }).createRestoreSafetyBackup(payload());
  assert.equal(attempts, 2); assert.notEqual(first.id, next.id);
  await assert.rejects(store(root, { randomId: () => "collision" }).createRestoreSafetyBackup(payload()), /unique/);
  assert.deepEqual(await inventory(first.path), original);
  assert.equal((await fs.readdir(path.join(root, "backups"))).length, 2);
});

test("bad kinds, dot/traversal/Windows IDs fail before any filesystem I/O; dotted legacy versions work", async () => {
  const root = await fixtureRoot();
  const calls = [];
  const backups = store(root, { fs: guardedFs({}, calls) });
  for (const kind of [undefined, null, "", "BACKUP", "backup ", "other", {}, 0]) {
    await assert.rejects(backups.readBackup({ id: "valid", kind }), /kind/);
  }
  for (const id of [undefined, null, 1, {}, "", ".", "..", ".hidden", "a..b", "a.", "../outside", "..\\outside", "a/b", "a\\b", "C:outside", "a:stream", "%2e%2e", "a\0b", "CON", "NUL.json", "LPT1", "x".repeat(241)]) {
    await assert.rejects(backups.readBackup({ id, kind: "backup" }), /id/);
  }
  assert.equal(calls.length, 0);
  await fixture(root, "backup", "20261120-v1.7.9-schema-10");
  assert.deepEqual(await backups.readBackup({ id: "20261120-v1.7.9-schema-10", kind: "backup" }), snapshot);
});

test("legacy missing-checksum policy is explicit; modern or supplied bad checksums never fall back", async () => {
  const root = await fixtureRoot(); const backups = store(root);
  for (const [id, metadata] of [["snapshot-only", null], ["legacy-v1", { backupVersion: 1 }], ["legacy-unversioned", {}]]) {
    await fixture(root, "backup", id, { metadata, manifest: null });
    assert.deepEqual(await backups.readBackup({ id, kind: "backup" }), snapshot);
    const details = await backups.readBackupWithIntegrity({ id, kind: "backup" });
    assert.deepEqual(details.snapshot, snapshot);
    assert.equal(details.integrity, "legacy-unverified");
    assert.equal(details.snapshotSha256, digest(encode(snapshot)));
    assert.equal(details.schemaVersion, null);
  }
  const good = digest(encode(snapshot));
  const invalidMetadata = [
    "{bad-json", null, [], 7,
    { snapshotSha256: "" }, { snapshotSha256: null }, { snapshotSha256: 42 },
    { snapshotSha256: "0".repeat(64) }, { backupVersion: 2 }, { backupVersion: 3 },
    { backupVersion: 4 }, { backupVersion: 99, snapshotSha256: good },
    { kind: "autosave", snapshotSha256: good }, { schemaVersion: -1, snapshotSha256: good },
    { snapshotSha256: good, manifest: "../outside.json" },
  ];
  for (let index = 0; index < invalidMetadata.length; index++) {
    const id = `invalid-${index}`;
    // JSON null is malformed metadata, unlike a genuinely absent legacy file.
    const metadata = invalidMetadata[index] === null ? "null" : invalidMetadata[index];
    await fixture(root, "backup", id, { metadata, manifest: null });
    await assert.rejects(backups.readBackup({ id, kind: "backup" }), /backup/i);
  }
  await fixture(root, "autosave", "uppercase-hash", { metadata: { backupVersion: 3, snapshotSha256: good.toUpperCase() } });
  assert.deepEqual(await backups.readBackup({ id: "uppercase-hash", kind: "autosave" }), snapshot);
  const denied = store(root, { fs: guardedFs({ lstat: async (target, ...args) => {
    if (target.endsWith("metadata.json")) throw Object.assign(new Error("synthetic denied"), { code: "EACCES" });
    return fs.lstat(target, ...args);
  } }) });
  await assert.rejects(denied.readBackup({ id: "snapshot-only", kind: "backup" }), /denied/);
  const incomplete = "20261120010203004-restore-incomplete";
  await fixture(root, "backup", incomplete, { metadata: null, manifest: null });
  await assert.rejects(backups.readBackup({ id: incomplete, kind: "backup" }), /safety backup metadata/);
});

test("integrity details accompany the same pinned body and validate every supplied metadata/manifest hash and byte count", async () => {
  const root = await fixtureRoot(); const backups = store(root);
  const fresh = await backups.createRestoreSafetyBackup(payload());
  assert.deepEqual(await backups.readBackupWithIntegrity(fresh), {
    snapshot, snapshotSha256: fresh.snapshotSha256, integrity: "verified", schemaVersion: 10, backupVersion: 4,
  });
  await fixture(root, "backup", "legacy-manifest-only", { metadata: { backupVersion: 1 } });
  assert.equal((await backups.readBackupWithIntegrity({ id: "legacy-manifest-only", kind: "backup" })).integrity, "verified");
  await fixture(root, "backup", "bad-metadata-good-manifest", { metadata: { backupVersion: 1, snapshotSha256: "f".repeat(64) } });
  await assert.rejects(backups.readBackupWithIntegrity({ id: "bad-metadata-good-manifest", kind: "backup" }), /integrity/);
  await fixture(root, "backup", "bad-byte-count", { manifest: { files: [{ name: "wealth-data.json", bytes: 0, sha256: digest(encode(snapshot)) }] } });
  await assert.rejects(backups.readBackupWithIntegrity({ id: "bad-byte-count", kind: "backup" }), /byte count/);
});

test("JSON, UTF-8, manifest hashes/bytes/names/contradictions and missing required manifest are rejected", async () => {
  const root = await fixtureRoot(); const backups = store(root);
  const buffer = encode(snapshot);
  const file = { name: "wealth-data.json", bytes: buffer.byteLength, sha256: digest(buffer) };
  const bad = [null, "broken", [], { files: [] }, { files: [file, file] },
    { files: [{ ...file, sha256: "a".repeat(64) }] }, { files: [{ ...file, sha256: null }] },
    { files: [{ ...file, bytes: file.bytes + 1 }] }, { files: [{ ...file, name: "../wealth-data.json" }] },
    { schemaVersion: 9, files: [file] }, { createdAt: "contradictory", files: [file] }];
  for (let i = 0; i < bad.length; i++) {
    await fixture(root, "backup", `manifest-${i}`, { manifest: bad[i] });
    await assert.rejects(backups.readBackup({ id: `manifest-${i}`, kind: "backup" }), /Backup/);
  }
  for (const [id, corrupt] of [["bad-json", Buffer.from("{broken")], ["bad-utf8", Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]]) {
    await fixture(root, "backup", id, { buffer: corrupt });
    await assert.rejects(backups.readBackup({ id, kind: "backup" }), /JSON or UTF-8/);
  }
});

test("safe list keeps legitimate legacy entries with schema null and metadata-only dates/version, skipping invalid entries", async () => {
  const root = await fixtureRoot(); const backups = store(root);
  const body = encode({ ...snapshot, createdAt: "2099-01-01T00:00:00Z", appVersion: "body-not-metadata" });
  const legacy = await fixture(root, "backup", "legacy-v1.7.9", { buffer: body, metadata: { backupVersion: 1, appVersion: "legacy-app" }, manifest: null });
  const datedLegacy = await fixture(root, "backup", "legacy-dated", { metadata: { backupVersion: 1, createdAt: "2020-01-01T00:00:00Z" }, manifest: null });
  const modern = await fixture(root, "autosave", "modern");
  await fixture(root, "backup", "missing-metadata", { metadata: null, manifest: null });
  await fixture(root, "backup", "bad-metadata", { metadata: "{broken", manifest: null });
  await fixture(root, "backup", "bad-metadata-hash", { metadata: { backupVersion: 1, snapshotSha256: "f".repeat(64) } });
  await fixture(root, "backup", "bad-byte-count", { manifest: { files: [{ name: "wealth-data.json", bytes: 0, sha256: digest(encode(snapshot)) }] } });
  await fixture(root, "backup", "bad-schema", { metadata: { backupVersion: 1, schemaVersion: "10" }, manifest: null });
  await fixture(root, "backup", "bad-date-type", { metadata: { backupVersion: 1, createdAt: {} }, manifest: null });
  await fixture(root, "backup", "bad-app-type", { metadata: { backupVersion: 1, appVersion: 7 }, manifest: null });
  const missingBody = await fixture(root, "backup", "missing-body");
  await fs.rename(path.join(missingBody, "wealth-data.json"), path.join(missingBody, "retained-synthetic-body.json"));
  const listed = await backups.listBackups();
  assert.deepEqual(listed, [
    { id: "modern", kind: "autosave", path: modern, createdAt: fixedDate, appVersion: "synthetic-1.7.9", schemaVersion: 10 },
    { id: "legacy-dated", kind: "backup", path: datedLegacy, createdAt: "2020-01-01T00:00:00Z", appVersion: "", schemaVersion: null },
    { id: "legacy-v1.7.9", kind: "backup", path: legacy, createdAt: null, appVersion: "legacy-app", schemaVersion: null },
  ]);
});

test("list rejects native root and entry junctions before enumeration/content opens, without outside reads", async () => {
  for (const kind of ["autosave", "backup"]) {
    for (const level of ["root", "entry"]) {
      const root = await fixtureRoot();
      const outside = path.join(root, "outside-profile");
      const externalFolder = await fixture(outside, kind, "escape");
      const profile = path.join(root, "profile"); await fs.mkdir(profile);
      const parent = path.join(profile, kind === "autosave" ? "autosaves" : "backups");
      if (level === "entry") await fs.mkdir(parent);
      const link = level === "root" ? parent : path.join(parent, "escape");
      await fs.symlink(level === "root" ? path.dirname(externalFolder) : externalFolder, link, process.platform === "win32" ? "junction" : "dir");
      const before = await inventory(outside); const calls = [];
      assert.deepEqual(await store(profile, { fs: guardedFs({}, calls) }).listBackups(), []);
      assert.equal(calls.some((call) => ["open", "readFile"].includes(call.method)), false);
      assert.equal(calls.some((call) => call.method === "readdir" && call.args[0] === link), false);
      assert.deepEqual(await inventory(outside), before);
    }
  }
});

test("list does not open metadata/snapshot/manifest file links (mocked file symlinks), preserving valid neighbors", async () => {
  for (const name of ["metadata.json", "wealth-data.json", "manifest.json"]) {
    const root = await fixtureRoot();
    await fixture(root, "backup", "linked"); await fixture(root, "backup", "valid");
    const calls = [];
    const backups = store(root, { fs: guardedFs({ lstat: async (target, ...args) => {
      const stat = await fs.lstat(target, ...args);
      if (path.basename(path.dirname(target)) === "linked" && path.basename(target) === name) stat.isSymbolicLink = () => true;
      return stat;
    } }, calls) });
    assert.deepEqual((await backups.listBackups()).map((entry) => entry.id), ["valid"]);
    assert.equal(calls.some((call) => call.method === "open" && path.basename(path.dirname(call.args[0])) === "linked" && path.basename(call.args[0]) === name), false);
  }
});

test("list rejects a root replaced by a junction after readdir, before reading any outside metadata/body", async () => {
  const root = await fixtureRoot();
  const profile = path.join(root, "profile"); await fixture(profile, "backup", "selected");
  const outside = path.join(root, "outside-profile"); await fixture(outside, "backup", "selected");
  const directory = path.join(profile, "backups"); const calls = []; let changed = false;
  const backups = store(profile, { fs: guardedFs({ readdir: async (target, ...args) => {
    const entries = await fs.readdir(target, ...args);
    if (target === directory && !changed) {
      changed = true;
      await fs.rename(directory, `${directory}-retained`);
      await fs.symlink(path.join(outside, "backups"), directory, process.platform === "win32" ? "junction" : "dir");
    }
    return entries;
  } }, calls) });
  assert.deepEqual(await backups.listBackups(), []);
  assert.equal(changed, true);
  assert.equal(calls.some((call) => ["open", "readFile"].includes(call.method)), false);
});

test("list rechecks previously validated entries and skips metadata replaced later in the same enumeration", async () => {
  const root = await fixtureRoot();
  const first = await fixture(root, "backup", "z-first");
  await fixture(root, "backup", "a-next"); let changed = false;
  const backups = store(root, { fs: guardedFs({ open: async (target, ...args) => {
    if (!changed && path.basename(path.dirname(target)) === "a-next" && path.basename(target) === "metadata.json") {
      changed = true;
      const metadata = JSON.parse(await fs.readFile(path.join(first, "metadata.json"), "utf8"));
      await fs.writeFile(path.join(first, "metadata.json"), encode({ ...metadata, appVersion: "changed-after-validation" }));
    }
    return fs.open(target, ...args);
  } }) });
  assert.deepEqual((await backups.listBackups()).map((entry) => entry.id), ["a-next"]);
  assert.equal(changed, true);
});

test("list captures its request profile root once across asynchronous profile changes", async () => {
  const rootA = await fixtureRoot(); const rootB = await fixtureRoot();
  for (const root of [rootA, rootB]) {
    await fixture(root, "autosave", "autosave"); await fixture(root, "backup", "backup");
  }
  let activeRoot = rootA; let captures = 0;
  const reached = deferred(); const release = deferred();
  const backups = store(rootA, { getProfileRoot: () => { captures++; return activeRoot; }, fs: guardedFs({ readdir: async (target, ...args) => {
    if (target === path.join(rootA, "autosaves")) { reached.resolve(); await release.promise; }
    return fs.readdir(target, ...args);
  } }) });
  const pending = backups.listBackups(); await reached.promise;
  activeRoot = rootB; release.resolve();
  const entries = await pending;
  assert.equal(captures, 1); assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => path.dirname(path.dirname(entry.path)) === rootA));
});

test("junction escapes at the backup root or selected folder are blocked for reads and safety writes", async () => {
  for (const level of ["root", "folder"]) {
    const root = await fixtureRoot();
    const outside = path.join(root, "outside-profile");
    const externalFolder = await fixture(outside, "backup", "target");
    const profile = path.join(root, "profile");
    await fs.mkdir(profile);
    const parent = path.join(profile, "backups");
    if (level === "folder") await fs.mkdir(parent);
    await fs.symlink(level === "root" ? path.dirname(externalFolder) : externalFolder,
      level === "root" ? parent : path.join(parent, "target"), process.platform === "win32" ? "junction" : "dir");
    const before = await inventory(outside);
    const calls = [];
    const backups = store(profile, { fs: guardedFs({}, calls) });
    await assert.rejects(backups.readBackup({ id: "target", kind: "backup" }), /directory|link/i);
    if (level === "root") await assert.rejects(backups.createRestoreSafetyBackup(payload()), /directory|link/i);
    assert.deepEqual(await inventory(outside), before);
    assert.equal(calls.filter((call) => call.method === "open").length, 0);
  }
});

test("snapshot and optional checksum files cannot be symlinks", async (t) => {
  for (const name of ["wealth-data.json", "metadata.json", "manifest.json"]) {
    await t.test(name, async (subtest) => {
      const root = await fixtureRoot();
      const folder = await fixture(root, "backup", "linked");
      const target = path.join(folder, name);
      const moved = path.join(root, `synthetic-original-${name}`);
      await fs.rename(target, moved);
      try { await fs.symlink(moved, target, "file"); } catch (error) {
        if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
          subtest.skip("Windows file-symlink privilege unavailable; directory junctions tested separately"); return;
        }
        throw error;
      }
      await assert.rejects(store(root).readBackup({ id: "linked", kind: "backup" }), /link/);
    });
  }
});

test("file-link rejection branches are exercised without requiring Windows symlink privileges (mock lstat)", async () => {
  for (const name of ["wealth-data.json", "metadata.json", "manifest.json"]) {
    const root = await fixtureRoot();
    await fixture(root, "backup", "mock-linked");
    const calls = [];
    const backups = store(root, { fs: guardedFs({ lstat: async (target, ...args) => {
      const stat = await fs.lstat(target, ...args);
      if (path.basename(target) === name) stat.isSymbolicLink = () => true;
      return stat;
    } }, calls) });
    await assert.rejects(backups.readBackup({ id: "mock-linked", kind: "backup" }), /link/);
    assert.equal(calls.some((call) => call.method === "open" && path.basename(call.args[0]) === name), false);
  }
});

test("directory replacement and in-place snapshot changes during read invalidate the pinned target", async () => {
  for (const mode of ["replace-directory", "edit-snapshot"]) {
    const root = await fixtureRoot(); const folder = await fixture(root, "backup", "selected");
    let changed = false;
    const backupFs = guardedFs({ open: async (target, ...args) => {
      if (!changed && target.endsWith("metadata.json")) {
        changed = true;
        if (mode === "replace-directory") {
          await fs.rename(folder, `${folder}-retained`);
          await fixture(root, "backup", "selected");
        } else {
          await fs.writeFile(path.join(folder, "wealth-data.json"), encode({ ...snapshot, changed: true }));
        }
      }
      return fs.open(target, ...args);
    } });
    await assert.rejects(store(root, { fs: backupFs }).readBackup({ id: "selected", kind: "backup" }), /changed/);
    assert.equal(changed, true);
  }
});

test("write/flush failures at every file, mkdir denial and read-back corruption never report success or prune originals", async () => {
  for (const mode of ["mkdir", "write-wealth-data.json", "write-manifest.json", "write-metadata.json", "sync-wealth-data.json", "sync-manifest.json", "sync-metadata.json", "verify"]) {
    const root = await fixtureRoot();
    const original = await fixture(root, "backup", "original");
    await fixture(root, "autosave", "oldest");
    const originals = await inventory(original);
    const autosaves = await inventory(path.join(root, "autosaves"));
    let triggered = false;
    const backupFs = guardedFs({
      mkdir: async (target, ...args) => {
        if (mode === "mkdir" && path.basename(target).includes("-restore-")) { triggered = true; throw new Error("synthetic mkdir denied"); }
        return fs.mkdir(target, ...args);
      },
      open: async (target, flags, ...args) => {
        const handle = await fs.open(target, flags, ...args);
        const name = path.basename(target);
        return new Proxy(handle, { get(object, key) {
          if (key === "writeFile" && mode === `write-${name}`) return async (buffer) => {
            triggered = true; await object.writeFile(buffer.subarray(0, 5)); throw new Error("synthetic disk full");
          };
          if (key === "sync" && mode === `sync-${name}`) return async () => { triggered = true; throw new Error("synthetic flush failure"); };
          if (key === "readFile" && mode === "verify" && name === "wealth-data.json") return async () => {
            triggered = true; await object.readFile(); return encode({ syntheticCorruption: true });
          };
          const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
        } });
      },
    });
    await assert.rejects(store(root, { fs: backupFs }).createRestoreSafetyBackup(payload()), /synthetic|integrity/);
    assert.equal(triggered, true, mode);
    assert.deepEqual(await inventory(original), originals);
    assert.deepEqual(await inventory(path.join(root, "autosaves")), autosaves);
  }
});

test("successful backups flush all files before read-back; invalid input cannot create directories", async () => {
  const root = await fixtureRoot(); const events = [];
  const backupFs = guardedFs({ open: async (target, flags, ...args) => {
    const handle = await fs.open(target, flags, ...args);
    if (flags !== "wx") events.push("read");
    return new Proxy(handle, { get(object, key) {
      if (key === "sync") return async () => { events.push(`sync-${path.basename(target)}`); return object.sync(); };
      const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
    } });
  } });
  await store(root, { fs: backupFs }).createRestoreSafetyBackup(payload());
  for (const name of ["wealth-data.json", "manifest.json", "metadata.json"]) assert.ok(events.indexOf(`sync-${name}`) < events.indexOf("read"));
  const calls = [];
  const invalidStore = store(root, { fs: guardedFs({}, calls) });
  const circular = {}; circular.self = circular;
  for (const input of [null, {}, { ...payload(), schemaVersion: "10" }, { ...payload(), schemaVersion: 0 }, { ...payload(), schemaVersion: 1.5 },
    { snapshot: null, schemaVersion: 10 }, { snapshot: [], schemaVersion: 10 }, { snapshot: circular, schemaVersion: 10 },
    { snapshot: new Date(fixedDate), schemaVersion: 10 }, { snapshot: { toJSON: () => null }, schemaVersion: 10 },
    ...[NaN, Infinity, 1n, () => {}].map((value) => ({ snapshot: { invalid: value }, schemaVersion: 10 }))]) {
    await assert.rejects(invalidStore.createRestoreSafetyBackup(input));
  }
  assert.equal(calls.length, 0);
});

test("real private IPC registration and frozen preload/type wrapper enforce capabilities and pin in-flight profile roots", async () => {
  const root = await fixtureRoot();
  const router = createDataProfileRouter(() => root);
  const handles = new Map(); const calls = [];
  const reached = deferred(); const release = deferred(); let paused = false;
  const backups = createDesktopBackupStore({
    getProfileRoot: () => router.root(), getAppVersion: () => "synthetic-1.7.9", now: () => new Date(fixedDate),
    fs: guardedFs({ open: async (target, flags, ...args) => {
      if (!paused && flags === "wx") { paused = true; reached.resolve(); await release.promise; }
      return fs.open(target, flags, ...args);
    } }),
  });
  const main = await fs.readFile(path.join(repo, "desktop/main.cjs"), "utf8");
  const cache = new Map([[root, { path: "synthetic-cached-startup-backup" }]]);
  const registration = main.slice(main.indexOf("function registerDesktopIpc()"), main.indexOf("function resolveAppAsset("));
  const trust = main.slice(main.indexOf("function isTrustedSender("), main.indexOf("function vaultConfigPath("));
  const read = main.slice(main.indexOf("async function readBackup("), main.indexOf("async function writeSmokeLog("));
  const list = main.slice(main.indexOf("async function listBackups("), main.indexOf("async function readBackup("));
  runInNewContext(`${trust}\n${list}\n${read}\n${registration}\nregisterDesktopIpc();`, {
    APP_ORIGIN: "wealth-atlas://app", devUrl: null, dataProfiles: router, desktopBackups: backups,
    ipcMain: { on: () => {}, handle: (name, handler) => handles.set(name, handler) },
    sessionBackups: cache,
    createDataBackup: () => { throw new Error("Must not use startup backup cache"); },
    writeAutosave: () => { throw new Error("Must not write/prune rolling autosaves"); },
  });
  const event = { sender: { id: 1 }, senderFrame: { url: "wealth-atlas://app/" } };
  let raw;
  runInNewContext(await fs.readFile(path.join(repo, "desktop/preload.cjs"), "utf8"), {
    process: { env: {}, versions: { electron: "synthetic" }, platform: "win32" },
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { raw = Object.freeze(value); } }, ipcRenderer: {
      sendSync: () => "synthetic-1.7.9",
      invoke: (channel, envelope) => { calls.push({ channel, envelope }); return handles.get(channel)(event, envelope); },
    } }),
  });
  let current = { key: "cloud:synthetic-A" };
  current.desktopToken = await raw.activateDataProfile(current.key);
  const scopeA = current;
  const exports = {};
  const compiled = transpileModule(await fs.readFile(path.join(repo, "lib/desktop.ts"), "utf8"), { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, { exports, window: { wealthAtlasDesktop: raw }, require: () => ({
    getDataProfile: () => current,
    assertActiveDataProfile: (scope) => { if (current !== scope) throw new Error("synthetic profile changed"); },
  }) });
  const bridge = exports.getDesktopBridge();
  const pending = bridge.createRestoreSafetyBackup(payload());
  await reached.promise;
  const request = calls.at(-1);
  assert.equal(request.channel, "desktop:create-restore-safety-backup");
  assert.equal(request.envelope.__profile.key, scopeA.key); assert.equal(request.envelope.__profile.token, scopeA.desktopToken);
  current = { key: "guest", desktopToken: await raw.activateDataProfile("guest") };
  release.resolve();
  const first = await pending;
  const rootA = path.dirname(path.dirname(first.path));
  assert.notEqual(rootA, root);
  assert.equal(await fs.stat(first.path).then((stat) => stat.isDirectory()), true);
  assert.throws(() => bridge.createRestoreSafetyBackup(payload()), /changed/);
  assert.throws(() => raw.createRestoreSafetyBackup(payload(), { key: scopeA.key, token: scopeA.desktopToken }), /changed/);
  const second = await exports.getDesktopBridge().createRestoreSafetyBackup(payload());
  assert.notEqual(path.dirname(path.dirname(second.path)), rootA);
  assert.deepEqual(await exports.getDesktopBridge().readBackup(second.id, "backup"), snapshot);
  current = { key: scopeA.key, desktopToken: await raw.activateDataProfile(scopeA.key) };
  assert.notEqual(current.desktopToken, scopeA.desktopToken);
  assert.throws(() => bridge.createRestoreSafetyBackup(payload()), /changed/);
  assert.throws(() => raw.createRestoreSafetyBackup(payload(), { key: scopeA.key, token: scopeA.desktopToken }), /changed/);
  assert.deepEqual(await exports.getDesktopBridge().readBackup(first.id, "backup"), snapshot);
  const details = await exports.getDesktopBridge().readBackupWithIntegrity(first.id, "backup");
  assert.deepEqual(details.snapshot, snapshot); assert.equal(details.integrity, "verified");
  assert.equal(details.snapshotSha256, first.snapshotSha256);
  assert.equal(calls.at(-1).channel, "desktop:read-backup-with-integrity");
  assert.equal(calls.at(-1).envelope.__profile.token, current.desktopToken);
  const entries = await exports.getDesktopBridge().listBackups();
  assert.deepEqual(entries.map((entry) => entry.id), [first.id]);
  assert.equal(entries[0].schemaVersion, 10);
  const untrusted = { sender: { id: 1 }, senderFrame: { url: "https://untrusted.invalid/" } };
  assert.throws(() => handles.get("desktop:create-restore-safety-backup")(untrusted, { payload: payload(), __profile: current }), /Wealth Atlas/);
  assert.equal(cache.size, 1); assert.equal(cache.get(root).path, "synthetic-cached-startup-backup");
});
