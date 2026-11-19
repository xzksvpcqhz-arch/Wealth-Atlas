const RELEASES_URL = "https://github.com/xzksvpcqhz-arch/Wealth-Atlas/releases";
const CHANNELS = Object.freeze({ state: "updates:get-state", check: "updates:check", notes: "updates:open-release-notes" });
const STATUSES = new Set(["idle", "checking", "downloading", "downloaded", "up-to-date", "error", "disabled"]);
const REASONS = new Set(["development", "isolated-test", "unsupported-platform", "unavailable"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]);
const ERROR_CODES = new Set([...NETWORK_CODES, "ERR_UPDATER_INVALID_SIGNATURE", "ERR_UPDATER_SHA512_CHECKSUM_MISMATCH", "ERR_CHECKSUM_MISMATCH", "ERR_UPDATER_INVALID_RELEASE_FEED", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "UPDATE_RESULT_UNAVAILABLE", "UPDATE_CONFIGURATION_FAILED", "UPDATE_FAILED"]);
const version = (value) => typeof value === "string" && value.length <= 64 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : null;

function serializeUpdateState(state, appVersion, platform) {
  // Reconstruct an explicit primitive-only object. Never spread SDK metadata.
  const status = STATUSES.has(state?.status) ? state.status : "error";
  const progress = state?.progressPercent;
  const retry = state?.retryAfterMs;
  const checked = state?.checkedAt;
  return {
    status,
    currentVersion: version(appVersion) ?? "unknown",
    latestVersion: version(state?.latestVersion) ?? version(state?.version),
    platform: ["win32", "darwin", "linux"].includes(platform) ? platform : "unknown",
    disabledReason: status === "disabled" ? REASONS.has(state?.reason) ? state.reason : "unavailable" : null,
    checkedAt: typeof checked === "number" && Number.isFinite(checked) && checked >= 0 && checked <= 8640000000000000 ? checked : null,
    progressPercent: status === "downloading" && typeof progress === "number" && Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null,
    retryAfterMs: typeof retry === "number" && Number.isFinite(retry) ? Math.max(0, Math.min(30 * 60 * 1000, retry)) : 0,
    code: status === "error" ? ERROR_CODES.has(state?.code) ? state.code : "UPDATE_FAILED" : null,
    warningCode: status === "downloaded" && NETWORK_CODES.has(state?.warningCode) ? state.warningCode : null,
  };
}

function trustedUpdateSender(event, contents, devUrl = null) {
  try {
    if (!contents || contents.isDestroyed() || event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return false;
    const url = new URL(event.senderFrame.url);
    if (url.username || url.password) return false;
    if (url.protocol === "wealth-atlas:" && url.hostname === "app" && !url.port && ["/", "/index.html"].includes(url.pathname)) return true;
    if (!devUrl) return false;
    const dev = new URL(devUrl);
    return ["http:", "https:"].includes(dev.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(dev.hostname)
      && url.origin === dev.origin && url.pathname === dev.pathname && !dev.username && !dev.password;
  } catch { return false; }
}

function registerUpdateIpc({ ipcMain, getController, getContents, getAppVersion, platform = process.platform, devUrl = null, openReleaseNotes, now = Date.now }) {
  let lastNotesOpen = null;
  const failure = (code) => ({ ok: false, code });
  for (const [action, channel] of Object.entries(CHANNELS)) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (!trustedUpdateSender(event, getContents(), devUrl)) return failure("UPDATE_ACCESS_DENIED");
        if (args.length) return failure("UPDATE_INVALID_REQUEST");
        if (action === "notes") {
          const time = now();
          if (!Number.isFinite(time)) return failure("UPDATE_BRIDGE_UNAVAILABLE");
          if (lastNotesOpen !== null && time - lastNotesOpen < 5000) return failure("UPDATE_NOTES_BUSY");
          lastNotesOpen = time;
          await openReleaseNotes(RELEASES_URL);
          return { ok: true };
        }
        const controller = getController();
        if (!controller) return failure("UPDATE_BRIDGE_UNAVAILABLE");
        // Acknowledge immediately; the panel polls the bounded state separately.
        // No renderer URL, path, token or installer command is accepted.
        if (action === "check") void Promise.resolve(controller.check()).catch(() => {});
        return { ok: true, state: serializeUpdateState(controller.getState(), getAppVersion(), platform) };
      } catch { return failure("UPDATE_BRIDGE_UNAVAILABLE"); }
    });
  }
}

module.exports = { CHANNELS, RELEASES_URL, serializeUpdateState, trustedUpdateSender, registerUpdateIpc };
