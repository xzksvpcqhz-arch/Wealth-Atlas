const path = require("node:path");

const stages = Object.freeze({
  initialize: "LOG_INITIALIZATION_FAILED",
  main: "MAIN_LOG_WRITE_FAILED",
  startup: "STARTUP_STATUS_WRITE_FAILED",
  renderer: "RENDERER_LOG_WRITE_FAILED",
});
const ioCodes = Object.freeze(Object.fromEntries(
  ["EACCES", "EPERM", "ENOENT", "EBUSY", "ENOSPC", "EIO"].map(code => [code, `DIAGNOSTIC_IO_${code}`]),
));

/** Candidate/test diagnostics only. Compare paths in memory, emit fixed enums.
 * No filesystem access, path configuration, auth, payloads or recovery actions. */
function createStartupDiagnostics({ record, expectedRoot, getUserData, getSessionData, getStoragePath }) {
  const normalize = value => {
    if (typeof value !== "string" || !value) return null;
    const normalized = path.resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const expected = normalize(expectedRoot);
  function emit(code) {
    try { record(code); } catch { /* Diagnostics cannot change application behavior. */ }
  }
  return {
    checkContext(phase, storagePath) {
      if (!expected || !["before-ready", "ready"].includes(phase)) return false;
      emit(phase === "ready" ? "PROFILE_CHECK_READY" : "PROFILE_CHECK_BEFORE_READY");
      try {
        const userMatches = normalize(getUserData()) === expected;
        const sessionMatches = normalize(getSessionData()) === expected;
        emit(userMatches ? "PROFILE_USER_ROOT_MATCH" : "PROFILE_USER_ROOT_MISMATCH");
        emit(sessionMatches ? "PROFILE_SESSION_ROOT_MATCH" : "PROFILE_SESSION_ROOT_MISMATCH");
        if (phase !== "ready") return userMatches && sessionMatches;
        const storage = normalize(storagePath === undefined && getStoragePath ? getStoragePath() : storagePath);
        const storageMatches = storage === expected;
        emit(!storage ? "PROFILE_STORAGE_ROOT_UNAVAILABLE"
          : storageMatches ? "PROFILE_STORAGE_ROOT_MATCH" : "PROFILE_STORAGE_ROOT_MISMATCH");
        return userMatches && sessionMatches && storageMatches;
      } catch {
        emit("PROFILE_CONTEXT_CHECK_FAILED");
        return false;
      }
    },
    recordIoFailure(stage, error) {
      if (!expected || !Object.hasOwn(stages, stage)) return false;
      emit(stages[stage]);
      let code;
      try { code = typeof error?.code === "string" ? error.code : null; } catch { /* Untrusted exception getter. */ }
      emit(code && Object.hasOwn(ioCodes, code) ? ioCodes[code] : "DIAGNOSTIC_IO_OTHER");
      return true;
    },
  };
}

module.exports = { createStartupDiagnostics };
