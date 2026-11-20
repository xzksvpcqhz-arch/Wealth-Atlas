const defaultFs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const samePath = (a, b) => path.relative(a, b) === "";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** No Electron startup, retention, cache, deletion or network side effects. */
function createDesktopBackupStore({ getProfileRoot, getAppVersion, fs = defaultFs, now = () => new Date(), randomId = randomUUID }) {
  function validateAddress({ id, kind } = {}) {
    if (kind !== "autosave" && kind !== "backup") throw new Error("Backup kind is invalid.");
    // Dots inside versioned legacy names are valid; dot segments, trailing dots,
    // Windows aliases/ADS, separators and encoded traversal are not.
    if (typeof id !== "string" || id.length > 240 || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id)
      || id.includes("..") || id.endsWith(".") || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(id)) {
      throw new Error("Backup id is invalid.");
    }
    return { id, kind };
  }

  function assertContained(root, target) {
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Backup path escapes the profile.");
    }
  }

  async function context(profileRoot, kind) {
    const originalRoot = path.resolve(profileRoot);
    const root = await fs.realpath(originalRoot);
    const rootStat = await fs.lstat(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Backup profile is not a directory.");
    return pinnedContext(originalRoot, root, kind, [{ target: root, stat: rootStat }]);
  }

  function pinnedContext(originalRoot, root, kind, directories) {
    const files = [];
    const ctx = { root, directories, files };
    // Fork the identities already pinned by listing, not a new realpath/root
    // that could accept a replacement junction between enumeration and read.
    ctx.fork = () => pinnedContext(originalRoot, root, kind, [...directories]);
    ctx.check = async () => {
      if (!samePath(await fs.realpath(originalRoot), root)) throw new Error("Backup profile changed.");
      for (const { target, stat } of directories) {
        const current = await fs.lstat(target, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, stat)
          || !samePath(await fs.realpath(target), target)) throw new Error("Backup directory changed or is a link.");
      }
    };
    ctx.pin = async (target) => {
      await ctx.check();
      assertContained(root, target);
      const stat = await fs.lstat(target, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(target), target)) {
        throw new Error("Backup directory is not a contained directory (links are not allowed).");
      }
      directories.push({ target, stat });
      await ctx.check();
      return target;
    };
    ctx.directory = path.join(root, kind === "autosave" ? "autosaves" : "backups");
    return ctx;
  }

  async function readFile(ctx, name, optional = false) {
    await ctx.check();
    const target = path.join(ctx.folder, name);
    assertContained(ctx.root, target);
    let before;
    try { before = await fs.lstat(target, { bigint: true }); } catch (error) {
      if (!optional || error?.code !== "ENOENT") throw error;
      // Pin absence too: metadata/manifest appearing during the read invalidates it.
      ctx.files.push(async () => {
        try { await fs.lstat(target); } catch (missing) { if (missing?.code === "ENOENT") return; throw missing; }
        throw new Error("Backup file changed during read.");
      });
      return null;
    }
    if (!before.isFile() || before.isSymbolicLink() || !samePath(await fs.realpath(target), target)) {
      throw new Error("Backup file is not a contained regular file (links are not allowed).");
    }
    await ctx.check();
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let buffer;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(before, opened)) throw new Error("Backup file changed during read.");
      buffer = await handle.readFile();
      if (!sameFile(opened, await handle.stat({ bigint: true }))) throw new Error("Backup file changed during read.");
    } finally { await handle.close(); }
    const check = async () => {
      await ctx.check();
      const current = await fs.lstat(target, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || !sameFile(before, current)
        || !samePath(await fs.realpath(target), target)) throw new Error("Backup file changed during read.");
    };
    ctx.files.push(check);
    await check();
    return buffer;
  }

  function parseJson(buffer) {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
    catch { throw new Error("Backup contains invalid JSON or UTF-8."); }
  }

  function checkHash(value, actual) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value) || value.toLowerCase() !== actual) {
      throw new Error("Backup file integrity check failed.");
    }
  }

  async function loadBackup(profileRoot, address, listingContext = null) {
    const { id, kind } = validateAddress(address);
    const ctx = listingContext ? listingContext.fork() : await context(profileRoot, kind);
    if (!listingContext) await ctx.pin(ctx.directory);
    ctx.folder = await ctx.pin(path.join(ctx.directory, id));
    const buffer = await readFile(ctx, "wealth-data.json");
    const metadataBuffer = await readFile(ctx, "metadata.json", true);
    const manifestBuffer = await readFile(ctx, "manifest.json", true);
    const snapshot = parseJson(buffer);
    const metadata = metadataBuffer === null ? null : parseJson(metadataBuffer);
    const manifest = manifestBuffer === null ? null : parseJson(manifestBuffer);
    const actual = sha256(buffer);
    if (metadataBuffer !== null && !isObject(metadata)) throw new Error("Backup metadata is invalid.");
    // A partial new safety backup must never downgrade to a hashless legacy
    // folder just because its metadata write failed or the file disappeared.
    if ((/^\d{17}-restore-/.test(id) || metadata?.backupVersion === 4)
      && (!metadata || metadata.backupVersion !== 4 || metadata.kind !== "backup"
        || metadata.reason !== "pre-restore" || metadata.manifest !== "manifest.json")) {
      throw new Error("Restore safety backup metadata is missing or invalid.");
    }
    if (metadata !== null) {
      const version = metadata.backupVersion;
      if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > 4)) throw new Error("Backup format is unsupported.");
      if (Object.hasOwn(metadata, "kind") && metadata.kind !== kind) throw new Error("Backup kind contradicts metadata.");
      if (Object.hasOwn(metadata, "schemaVersion") && (!Number.isSafeInteger(metadata.schemaVersion) || metadata.schemaVersion < 1)) {
        throw new Error("Backup schema version is invalid.");
      }
      if (Object.hasOwn(metadata, "snapshotSha256")) checkHash(metadata.snapshotSha256, actual);
      else if (version >= 2) throw new Error("Backup checksum is missing.");
      if (Object.hasOwn(metadata, "manifest") && metadata.manifest !== "manifest.json") throw new Error("Backup manifest name is invalid.");
      if ((metadata.manifest === "manifest.json" || version === 2 || version === 4) && manifestBuffer === null) {
        throw new Error("Backup manifest is missing.");
      }
    }
    // Compatibility: snapshot-only legacy folders, or valid v1/unversioned
    // metadata without a checksum, remain readable as UNVERIFIED legacy data.
    // Only ENOENT means absent; bad JSON, I/O errors and supplied bad hashes
    // never fall back to legacy. Version 2+ always requires its checksum.
    if (manifestBuffer !== null) {
      if (!isObject(manifest) || !Array.isArray(manifest.files) || manifest.files.length !== 1) throw new Error("Backup manifest is invalid.");
      const file = manifest.files[0];
      if (!isObject(file) || file.name !== "wealth-data.json" || !Number.isSafeInteger(file.bytes) || file.bytes !== buffer.byteLength) {
        throw new Error("Backup manifest file or byte count is invalid.");
      }
      checkHash(file.sha256, actual);
      for (const key of ["schemaVersion", "createdAt", "appVersion"]) {
        if (metadata && Object.hasOwn(metadata, key) && Object.hasOwn(manifest, key) && manifest[key] !== metadata[key]) {
          throw new Error("Backup manifest contradicts metadata.");
        }
      }
    }
    const check = async () => {
      await ctx.check();
      for (const checkFile of ctx.files) await checkFile();
    };
    await check();
    const integrity = (metadata && Object.hasOwn(metadata, "snapshotSha256")) || manifestBuffer !== null ? "verified" : "legacy-unverified";
    return { snapshot, snapshotSha256: actual, metadata, manifest, integrity, path: ctx.folder, check };
  }

  async function listBackups() {
    const profileRoot = getProfileRoot();
    const candidates = [];
    for (const kind of ["autosave", "backup"]) {
      let ctx, entries;
      try {
        ctx = await context(profileRoot, kind);
        await ctx.pin(ctx.directory);
        await ctx.check();
        entries = await fs.readdir(ctx.directory, { withFileTypes: true });
        await ctx.check();
      } catch { continue; }
      for (const entry of entries.filter((item) => item.isDirectory() && !item.isSymbolicLink()).sort((a, b) => b.name.localeCompare(a.name))) {
        try {
          // Reuse the fully validated reader and immediately discard its body.
          // Listing retains only safe metadata and identity checks, never data.
          const backup = await loadBackup(profileRoot, { id: entry.name, kind }, ctx);
          const metadata = backup.metadata;
          // Preserve the UI's skip-missing/bad-metadata policy. Snapshot-only
          // legacy folders can still be read explicitly via readBackup.
          if (!metadata || (Object.hasOwn(metadata, "createdAt") && metadata.createdAt !== null && typeof metadata.createdAt !== "string")
            || (Object.hasOwn(metadata, "appVersion") && typeof metadata.appVersion !== "string")) continue;
          candidates.push({
            entry: {
              id: entry.name, kind, path: backup.path,
              createdAt: metadata.createdAt ?? null, appVersion: metadata.appVersion ?? "",
              // backupVersion is a file format, never a financial schema.
              schemaVersion: metadata.schemaVersion ?? null,
            },
            check: backup.check,
          });
        } catch {
          // Bad, incomplete, changed or escaping entries are not selectable;
          // listing never repairs, deletes or falls back to unsafe file reads.
        }
      }
    }
    const results = [];
    for (const candidate of candidates) {
      try { await candidate.check(); results.push(candidate.entry); } catch { /* changed during enumeration */ }
    }
    return results.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  }

  async function durableWrite(ctx, name, buffer) {
    await ctx.check();
    const handle = await fs.open(path.join(ctx.folder, name), "wx", 0o600);
    try { await handle.writeFile(buffer); await handle.sync(); }
    finally { await handle.close(); }
    await ctx.check();
  }

  async function syncDirectory(target) {
    // Node cannot open/fsync directory handles on Windows. FileHandle.sync()
    // above still flushes every file via FlushFileBuffers; do not suppress file
    // flush failures. POSIX also flushes directory entries before success.
    if (process.platform === "win32") return;
    const handle = await fs.open(target, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async function createRestoreSafetyBackup(payload) {
    // Capture the per-request root before any asynchronous boundary.
    const profileRoot = getProfileRoot();
    const schemaVersion = payload?.schemaVersion;
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("Backup schema version is invalid.");
    if (!isObject(payload?.snapshot)) throw new Error("Backup snapshot must be a JSON object.");
    const snapshotBuffer = Buffer.from(JSON.stringify(payload.snapshot, function (_key, value) {
      // Match autosave JSON semantics for optional object properties produced by
      // normalizers (e.g. asset.sellPrice/saleDate). Never turn array holes or
      // undefined array entries into null and silently change their meaning.
      if (value === undefined && !Array.isArray(this)) return undefined;
      if (["undefined", "function", "symbol", "bigint"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
        throw new Error("Backup snapshot must contain only JSON values.");
      }
      return value;
    }, 2) + "\n", "utf8");
    if (!isObject(parseJson(snapshotBuffer))) throw new Error("Backup snapshot must serialize to a JSON object.");
    const snapshotSha256 = sha256(snapshotBuffer);
    const createdAt = now().toISOString();
    await fs.mkdir(profileRoot, { recursive: true });
    const ctx = await context(profileRoot, "backup");
    await ctx.check();
    try { await fs.mkdir(ctx.directory, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    await ctx.pin(ctx.directory);
    let id;
    for (let attempt = 0; attempt < 8; attempt++) {
      const unique = randomId();
      if (typeof unique !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(unique)) throw new Error("Backup unique ID is invalid.");
      id = `${createdAt.replace(/[-:.TZ]/g, "")}-restore-${unique}`;
      validateAddress({ id, kind: "backup" });
      await ctx.check();
      const folder = path.join(ctx.directory, id);
      try { await fs.mkdir(folder, { mode: 0o700 }); }
      catch (error) { if (error?.code === "EEXIST") continue; throw error; }
      ctx.folder = await ctx.pin(folder);
      break;
    }
    if (!ctx.folder) throw new Error("Unable to allocate a unique restore safety backup.");
    const metadata = {
      backupVersion: 4, kind: "backup", createdAt, appVersion: getAppVersion(), schemaVersion,
      reason: "pre-restore", source: "wealth-atlas-desktop", networkUpload: false,
      snapshotSha256, manifest: "manifest.json",
    };
    const manifest = {
      createdAt, appVersion: metadata.appVersion, schemaVersion,
      files: [{ name: "wealth-data.json", bytes: snapshotBuffer.byteLength, sha256: snapshotSha256 }],
    };
    // No overwrites, reuse or cleanup: failed attempts remain inspectable and
    // cannot remove a selected autosave or any original backup. Metadata last.
    await durableWrite(ctx, "wealth-data.json", snapshotBuffer);
    await durableWrite(ctx, "manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
    await durableWrite(ctx, "metadata.json", Buffer.from(JSON.stringify(metadata, null, 2) + "\n"));
    for (const { target } of [...ctx.directories].reverse()) await syncDirectory(target);
    const verified = await loadBackup(profileRoot, { id, kind: "backup" });
    if (verified.snapshotSha256 !== snapshotSha256 || JSON.stringify(verified.metadata) !== JSON.stringify(metadata)
      || JSON.stringify(verified.manifest) !== JSON.stringify(manifest)) throw new Error("Restore safety backup verification failed.");
    await ctx.check();
    return { id, kind: "backup", path: ctx.folder, createdAt, snapshotSha256, reused: false };
  }

  async function readBackupWithIntegrity(payload) {
    validateAddress(payload);
    const verified = await loadBackup(getProfileRoot(), payload);
    return {
      snapshot: verified.snapshot, snapshotSha256: verified.snapshotSha256, integrity: verified.integrity,
      schemaVersion: verified.metadata?.schemaVersion ?? null,
      backupVersion: verified.metadata?.backupVersion ?? null,
    };
  }

  return { createRestoreSafetyBackup, readBackupWithIntegrity, listBackups,
    readBackup: async (payload) => (await readBackupWithIntegrity(payload)).snapshot,
  };
}

module.exports = { createDesktopBackupStore };
