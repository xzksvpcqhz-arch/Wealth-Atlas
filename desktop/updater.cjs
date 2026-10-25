const PUBLIC_FEED = Object.freeze({ provider: "github", owner: "xzksvpcqhz-arch", repo: "Wealth-Atlas", private: false });
const controllers = new WeakMap();
const RETRY_INTERVAL = 60 * 1000;
const CHECK_INTERVAL = 30 * 60 * 1000;

function setupAutoUpdates({ updater, isPackaged, isolated = false, platform = process.platform, log = () => {}, now = Date.now }) {
  const emit = (event, details = {}) => { try { log(event, details); } catch { /* Diagnostics cannot block startup. */ } };
  if (!isPackaged || isolated || platform !== "win32" || !updater) {
    emit("update-disabled", { reason: isolated ? "isolated-test" : !isPackaged ? "development" : platform !== "win32" ? "unsupported-platform" : "unavailable" });
    return { check: async () => ({ status: "disabled" }), getState: () => ({ status: "disabled" }) };
  }
  if (controllers.has(updater)) return controllers.get(updater);
  let state = { status: "idle" };
  let inFlight = null;
  let lastAttempt = null;
  const versionOf = (info) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(info?.version ?? "") ? info.version : "unknown";
  const fail = (error) => {
    // Never log upstream messages, URLs, headers, release notes, paths or tokens.
    const code = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ERR_UPDATER_INVALID_SIGNATURE", "ERR_UPDATER_INVALID_RELEASE_FEED", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "ERR_UPDATER_SHA512_CHECKSUM_MISMATCH"])
      .has(error?.code) ? error.code : "UPDATE_FAILED";
    if (state.status !== "error" || state.code !== code) emit("update-error", { code });
    state = { status: "error", code };
  };
  const controller = {
    getState: () => ({ ...state }),
    check: () => {
      if (inFlight) return inFlight;
      if (state.status === "downloaded") return Promise.resolve({ ...state });
      const interval = state.status === "error" ? RETRY_INTERVAL : CHECK_INTERVAL;
      if (lastAttempt !== null && now() - lastAttempt < interval) return Promise.resolve({ ...state });
      lastAttempt = now();
      state = { status: "checking" };
      emit("update-check-start");
      inFlight = Promise.resolve().then(async () => {
        const result = await updater.checkForUpdates();
        if (result?.downloadPromise) await result.downloadPromise;
        return { ...state };
      }).catch((error) => { fail(error); return { ...state }; }).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
  controllers.set(updater, controller);
  try {
    updater.logger = null;
    updater.requestHeaders = null;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.setFeedURL({ ...PUBLIC_FEED });
    updater.on("checking-for-update", () => emit("update-checking"));
    updater.on("update-available", (info) => {
      state = { status: "downloading", version: versionOf(info) };
      emit("update-available", { version: state.version });
    });
    updater.on("update-not-available", () => { state = { status: "up-to-date" }; emit("update-not-available"); });
    updater.on("update-downloaded", (info) => {
      state = { status: "downloaded", version: versionOf(info) };
      emit("update-downloaded", { version: state.version, install: "on-normal-quit" });
      // Do not close a financial form or interrupt an explicit Obsidian write.
      // electron-updater installs the verified pending update on a normal exit.
    });
    updater.on("error", fail);
    void controller.check();
  } catch (error) { fail(error); }
  return controller;
}

module.exports = { PUBLIC_FEED, setupAutoUpdates };
