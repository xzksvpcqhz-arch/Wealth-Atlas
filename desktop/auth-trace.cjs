const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const codes = require("./auth-diagnostic-codes.json");

const FORMAT = "wealth-atlas-auth-trace";
const MAX_BYTES = 64 * 1024;
const MAX_EVENTS = 64;
const KEEP_FIRST = 8;
const candidateVersion = /^\d+\.\d+\.\d+-rc\.\d+$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const modes = new Set(["manual-candidate", "isolated-qa"]);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === "string" && value.length === 24
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function readBounded(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || stat.nlink !== 1) {
    throw new Error("Technical trace is not a bounded ordinary file.");
  }
  return fs.readFileSync(file, "utf8");
}

function parseHistory(raw, mode) {
  if (raw === null) return [];
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_BYTES) return null;
  const report = JSON.parse(raw);
  if (!exactKeys(report, ["format", "formatVersion", "boots"]) || report.format !== FORMAT
    || report.formatVersion !== 1 || !Array.isArray(report.boots) || report.boots.length > 2) return null;
  const ids = new Set();
  for (const boot of report.boots) {
    if (!exactKeys(boot, ["bootId", "appVersion", "mode", "startedAt", "events", "omitted"])
      || typeof boot.bootId !== "string" || !uuid.test(boot.bootId) || ids.has(boot.bootId)
      || typeof boot.appVersion !== "string" || boot.appVersion.length > 48 || !candidateVersion.test(boot.appVersion)
      || boot.mode !== mode || !iso(boot.startedAt) || !integer(boot.omitted)
      || !Array.isArray(boot.events) || boot.events.length === 0 || boot.events.length > MAX_EVENTS
      || (boot.omitted > 0 && boot.events.length !== MAX_EVENTS)) return null;
    ids.add(boot.bootId);
    let lastSeq = 0, lastElapsed = 0;
    for (const [index, event] of boot.events.entries()) {
      const expectedSeq = index < KEEP_FIRST ? index + 1 : index + 1 + boot.omitted;
      if (!exactKeys(event, ["seq", "code", "elapsedMs"]) || !integer(event.seq) || event.seq <= lastSeq
        || event.seq !== expectedSeq
        || typeof event.code !== "string" || !Object.hasOwn(codes, event.code)
        || !integer(event.elapsedMs) || event.elapsedMs < lastElapsed) return null;
      if (index > 0 && !(index === KEEP_FIRST && boot.omitted > 0)
        && event.code === boot.events[index - 1].code) return null;
      lastSeq = event.seq; lastElapsed = event.elapsedMs;
    }
    if (boot.events[0].seq !== 1 || lastSeq !== boot.events.length + boot.omitted) return null;
  }
  return report.boots;
}

/** A bounded candidate-only event timeline, never a token/financial store.
 * Only fixed enum codes enter this API. Reads are limited to this same technical
 * file; malformed/unknown files are preserved, not replaced. Readback proves
 * same-process visibility only, NOT physical-disk durability or close success. */
function createAuthTrace({ version, directory, mode = "manual-candidate", write = fs.writeFileSync,
  read = readBounded, now = Date.now, bootId = randomUUID() }) {
  if (typeof version !== "string" || version.length > 48 || !candidateVersion.test(version)
    || typeof directory !== "string" || !directory || !modes.has(mode)
    || typeof bootId !== "string" || !uuid.test(bootId)) return () => false;
  const file = path.join(directory, mode === "isolated-qa" ? "candidate-qa-auth-trace.json" : "candidate-auth-trace.json");
  let initialized = false, unavailable = false, started, current, boots, serial = 0;
  let expectedFile = null, confirmed = false;
  return code => {
    if (typeof code !== "string" || !Object.hasOwn(codes, code) || unavailable) return false;
    try {
      if (!initialized) {
        expectedFile = read(file);
        const previous = parseHistory(expectedFile, mode);
        if (!previous || previous.some(boot => boot.bootId === bootId)) { unavailable = true; return false; }
        started = now();
        if (!integer(started)) { unavailable = true; return false; }
        current = { bootId, appVersion: version, mode, startedAt: new Date(started).toISOString(), events: [], omitted: 0 };
        boots = [...previous.slice(-1), current];
        initialized = true;
      }
      if (current.events.at(-1)?.code === code && confirmed) return true;
      if (current.events.at(-1)?.code !== code) {
        const elapsed = now() - started;
        const elapsedMs = Math.max(current.events.at(-1)?.elapsedMs ?? 0, Number.isSafeInteger(elapsed) ? elapsed : 0);
        current.events.push({ seq: ++serial, code, elapsedMs });
        if (current.events.length > MAX_EVENTS) { current.events.splice(KEEP_FIRST, 1); current.omitted++; }
      }
      const text = JSON.stringify({ format: FORMAT, formatVersion: 1, boots }, null, 2) + "\n";
      if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return false;
      // Do not replace another observed writer's trace. This comparison is not
      // a filesystem lock and cannot prove that concurrent processes are absent.
      if (read(file) !== expectedFile) { unavailable = true; return false; }
      confirmed = false;
      write(file, text, "utf8");
      expectedFile = text;
      confirmed = read(file) === text;
      return confirmed;
    } catch {
      // Never expose an exception/path or mutate auth state to repair diagnostics.
      confirmed = false;
      return false;
    }
  };
}

module.exports = { createAuthTrace };
