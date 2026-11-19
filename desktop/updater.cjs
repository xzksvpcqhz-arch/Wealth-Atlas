const PUBLIC_FEED = Object.freeze({ provider: "github", owner: "xzksvpcqhz-arch", repo: "Wealth-Atlas", private: false });
const controllers = new WeakMap();
const RETRY_INTERVAL = 60 * 1000;
const CHECK_INTERVAL = 30 * 60 * 1000;
const NETWORK_FAILURES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]);
const INTEGRITY_FAILURES = new Set(["ERR_UPDATER_INVALID_SIGNATURE", "ERR_UPDATER_SHA512_CHECKSUM_MISMATCH", "ERR_CHECKSUM_MISMATCH"]);
const SAFE_ERROR_CODES = new Set([...NETWORK_FAILURES, ...INTEGRITY_FAILURES, "ERR_UPDATER_INVALID_RELEASE_FEED", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "UPDATE_RESULT_UNAVAILABLE"]);

function setupAutoUpdates({ updater, isPackaged, isolated = false, platform = process.platform, log = () => {}, now = Date.now }) {
  const emit = (event, details = {}) => { try { log(event, details); } catch { /* Diagnostics cannot block startup. */ } };
  if (!isPackaged || isolated || platform !== "win32" || !updater) {
    const reason = isolated ? "isolated-test" : !isPackaged ? "development" : platform !== "win32" ? "unsupported-platform" : "unavailable";
    emit("update-disabled", { reason });
    return { check: async () => ({ status: "disabled", reason }), getState: () => ({ status: "disabled", reason }) };
  }
  if (controllers.has(updater)) return controllers.get(updater);
  let state = { status: "idle" };
  let inFlight = null;
  let lastAttempt = null;
  let configured = false;
  let configurationFailed = false;
  let attemptFailed = false;
  let latestVersion = null;
  let checkedAt = null;
  let progressPercent = null;
  const remainingCooldown = () => {
    if (lastAttempt === null || state.status === "downloaded") return 0;
    const interval = state.status === "error" ? RETRY_INTERVAL : CHECK_INTERVAL;
    let remaining;
    try { remaining = interval - (now() - lastAttempt); } catch { return interval; }
    // Keep the existing throttle, but let a future UI explain why a retry waits.
    // Invalid/backward clocks must not expose NaN or bypass request limits.
    return Number.isFinite(remaining) ? Math.max(0, Math.min(interval, remaining)) : interval;
  };
  const snapshot = () => ({ ...state, retryAfterMs: remainingCooldown(), latestVersion, checkedAt, progressPercent: state.status === "downloading" ? progressPercent : null });
  const versionOf = (info) => {
    try { return typeof info?.version === "string" && info.version.length <= 64 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(info.version) ? info.version : "unknown"; }
    catch { return "unknown"; }
  };
  const fail = (error) => {
    // Never log upstream messages, URLs, headers, release notes, paths or tokens.
    const code = !configured ? "UPDATE_CONFIGURATION_FAILED" : SAFE_ERROR_CODES.has(error?.code) ? error.code : "UPDATE_FAILED";
    if (!configured) configurationFailed = true;
    if (state.status === "downloaded" && NETWORK_FAILURES.has(code)) {
      if (state.warningCode !== code) emit("update-warning", { code });
      state = { ...state, warningCode: code };
      return;
    }
    attemptFailed = true;
    if (state.status === "downloaded" || INTEGRITY_FAILURES.has(code) || code === "UPDATE_RESULT_UNAVAILABLE") {
      // A rejected or uncertain pending installer must not run on normal quit.
      updater.autoInstallOnAppQuit = false;
    }
    if (state.status !== "error" || state.code !== code) emit("update-error", { code });
    state = { status: "error", code };
  };
  const controller = {
    getState: snapshot,
    check: () => {
      if (!configured) return Promise.resolve(snapshot());
      if (inFlight) return inFlight;
      if (state.status === "downloaded" || remainingCooldown() > 0) return Promise.resolve(snapshot());
      lastAttempt = now();
      checkedAt = Number.isFinite(lastAttempt) && lastAttempt >= 0 && lastAttempt <= 8640000000000000 ? lastAttempt : null;
      progressPercent = null;
      attemptFailed = false;
      state = { status: "checking" };
      emit("update-check-start");
      inFlight = Promise.resolve().then(async () => {
        const result = await updater.checkForUpdates();
        if (result?.downloadPromise) await result.downloadPromise;
        // A settled request without a terminal SDK event is not a successful check.
        if (state.status === "checking" || state.status === "downloading") fail({ code: "UPDATE_RESULT_UNAVAILABLE" });
        return snapshot();
      }).catch((error) => { fail(error); return snapshot(); }).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
  controllers.set(updater, controller);
  try {
    // Catch SDK setup errors before configuring the provider or other listeners.
    updater.on("error", fail);
    updater.logger = null;
    updater.requestHeaders = null;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.setFeedURL({ ...PUBLIC_FEED });
    updater.on("checking-for-update", () => { if (configured && !attemptFailed) emit("update-checking"); });
    updater.on("update-available", (info) => {
      if (!configured || attemptFailed) return;
      state = { status: "downloading", version: versionOf(info) };
      latestVersion = state.version === "unknown" ? null : state.version;
      progressPercent = null;
      emit("update-available", { version: state.version });
    });
    updater.on("download-progress", (info) => {
      if (!configured || attemptFailed || state.status !== "downloading") return;
      try {
        if (typeof info?.percent !== "number" || !Number.isFinite(info.percent)) return;
        const percent = Math.floor(Math.max(0, Math.min(100, info.percent)) * 10) / 10;
        progressPercent = Math.max(progressPercent ?? 0, percent);
      } catch { /* Unusable progress must not break startup or expose provider data. */ }
    });
    updater.on("update-not-available", (info) => {
      if (!configured || attemptFailed) return;
      // A delayed check result must not erase active download or install readiness.
      if (state.status === "downloading" || state.status === "downloaded") return;
      const version = versionOf(info);
      if (version !== "unknown") latestVersion = version;
      state = { status: "up-to-date" };
      emit("update-not-available");
    });
    updater.on("update-downloaded", (info) => {
      if (!configured || attemptFailed) return;
      updater.autoInstallOnAppQuit = true;
      state = { status: "downloaded", version: versionOf(info) };
      latestVersion = state.version === "unknown" ? null : state.version;
      emit("update-downloaded", { version: state.version, install: "on-normal-quit" });
      // Do not close a financial form or interrupt an explicit Obsidian write.
      // electron-updater installs the verified pending update on a normal exit.
    });
    if (!configurationFailed) {
      configured = true;
      void controller.check();
    }
  } catch (error) { fail(error); }
  if (!configured) {
    // Failed initialization cannot use a fallback feed or arm normal-exit install.
    try { updater.autoInstallOnAppQuit = false; } catch { /* No checks are allowed. */ }
  }
  return controller;
}

module.exports = { PUBLIC_FEED, setupAutoUpdates };
