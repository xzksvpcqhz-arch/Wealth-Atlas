const fs = require("node:fs");
const path = require("node:path");

const PROBE_TEXT = "WEALTH_ATLAS_FIXED_VISIBILITY_PROBE_V1\n";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ioCodes = new Set(["EACCES", "EPERM", "ENOENT", "EBUSY", "ENOSPC", "EIO"]);
const normalize = value => typeof value === "string" && path.isAbsolute(value)
  ? (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)) : null;

/** Explicitly opted-in candidate builds only. No auth/database/renderer access.
 * One fixed-content file per build and profile; exclusive creation never reads
 * or overwrites a pre-existing file. No directory creation, cleanup or restore.
 * Readback/fsync here concern ONLY this marker, not session/financial durability. */
function createDiagnosticVisibilityProbe({ version, mode, probeId, expectedRoot, record, io = fs } = {}) {
  const expected = normalize(expectedRoot);
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)
    || !["manual-candidate", "isolated-qa"].includes(mode) || typeof probeId !== "string"
    || !uuid.test(probeId) || !expected || typeof record !== "function") return () => false;
  const directory = path.join(expectedRoot, "logs");
  const file = path.join(directory, `diagnostic-visibility-${probeId}.txt`);
  let attempted = false;
  const emit = code => { try { record(code); } catch { /* Observation never blocks startup. */ } };
  const classify = error => {
    let code;
    try { code = error?.code; } catch { /* No provider/error text is retained. */ }
    emit(ioCodes.has(code) ? `DIAGNOSTIC_IO_${code}` : "DIAGNOSTIC_IO_OTHER");
  };
  const ordinaryDirectory = target => {
    const stat = io.lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink() && normalize(io.realpathSync(target)) === normalize(target);
  };
  return actualRoot => {
    if (attempted) return false;
    attempted = true;
    emit("VISIBILITY_PROBE_STARTED");
    if (normalize(actualRoot) !== expected) { emit("VISIBILITY_PROBE_ROOT_MISMATCH"); return false; }
    let descriptor = null, phase = "target";
    try {
      if (!ordinaryDirectory(expectedRoot) || !ordinaryDirectory(directory)) {
        emit("VISIBILITY_PROBE_UNSAFE_TARGET"); return false;
      }
      phase = "create";
      descriptor = io.openSync(file, "wx+", 0o600);
      const created = io.fstatSync(descriptor, { bigint: true });
      if (!created.isFile() || created.nlink !== 1n || typeof created.dev !== "bigint" || created.dev < 0n
        || typeof created.ino !== "bigint" || created.ino <= 0n) { emit("VISIBILITY_PROBE_UNSAFE_TARGET"); return false; }
      phase = "write";
      io.writeFileSync(descriptor, PROBE_TEXT, "utf8");
      io.fsyncSync(descriptor);
      io.closeSync(descriptor); descriptor = null;
      emit("VISIBILITY_PROBE_WRITE_CONFIRMED");
      phase = "read";
      descriptor = io.openSync(file, "r");
      const reopened = io.fstatSync(descriptor, { bigint: true });
      // Check identity/size BEFORE reading: a replacement/link must never make
      // this diagnostic read another file, even a short one with private data.
      if (!reopened.isFile() || reopened.nlink !== 1n || reopened.dev !== created.dev
        || reopened.ino !== created.ino || reopened.size !== BigInt(Buffer.byteLength(PROBE_TEXT, "utf8"))) {
        emit("VISIBILITY_PROBE_UNSAFE_TARGET"); return false;
      }
      const matches = io.readFileSync(descriptor, "utf8") === PROBE_TEXT;
      io.closeSync(descriptor); descriptor = null;
      if (!matches) { emit("VISIBILITY_PROBE_FAILED"); return false; }
      emit("VISIBILITY_PROBE_READBACK_CONFIRMED"); return true;
    } catch (error) {
      let code;
      try { code = error?.code; } catch { /* Do not disclose error payloads. */ }
      if (phase === "create" && code === "EEXIST") { emit("VISIBILITY_PROBE_FILE_EXISTS"); return false; }
      emit(phase === "target" ? "VISIBILITY_PROBE_TARGET_UNAVAILABLE" : "VISIBILITY_PROBE_FAILED");
      classify(error); return false;
    } finally {
      if (descriptor !== null) { try { io.closeSync(descriptor); } catch { /* Preserve partial marker; never remove it. */ } }
    }
  };
}

module.exports = { createDiagnosticVisibilityProbe, PROBE_TEXT };
