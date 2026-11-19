export type UpdateStatus = "idle" | "checking" | "downloading" | "downloaded" | "up-to-date" | "error" | "disabled";
export type UpdateState = {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  platform: string;
  disabledReason: string | null;
  checkedAt: number | null;
  progressPercent: number | null;
  retryAfterMs: number;
  code: string | null;
  warningCode: string | null;
};
export type UpdateReply = { ok: true; state: UpdateState } | { ok: false; code: string };
export const UPDATE_RELEASES_URL = "https://github.com/xzksvpcqhz-arch/Wealth-Atlas/releases";
const statuses = new Set(["idle", "checking", "downloading", "downloaded", "up-to-date", "error", "disabled"]);
const reasons = new Set(["browser", "development", "isolated-test", "unsupported-platform", "unavailable"]);
const network = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]);
const integrity = new Set(["ERR_UPDATER_INVALID_SIGNATURE", "ERR_UPDATER_SHA512_CHECKSUM_MISMATCH", "ERR_CHECKSUM_MISMATCH"]);
const errors = new Set([...network, ...integrity, "ERR_UPDATER_INVALID_RELEASE_FEED", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "UPDATE_RESULT_UNAVAILABLE", "UPDATE_CONFIGURATION_FAILED", "UPDATE_FAILED"]);
const keys = ["status", "currentVersion", "latestVersion", "platform", "disabledReason", "checkedAt", "progressPercent", "retryAfterMs", "code", "warningCode"];
const version = (value: unknown) => typeof value === "string" && value.length <= 64 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);

export function readUpdateReply(value: unknown): UpdateState | null {
  try {
    if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("state" in value)) return null;
    const data = value.state;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const fields = Object.keys(data);
    if (fields.length !== keys.length || fields.some((key) => !keys.includes(key))) return null;
    const state = data as UpdateState;
    if (!statuses.has(state.status) || !(version(state.currentVersion) || state.currentVersion === "unknown")) return null;
    if (state.latestVersion !== null && !version(state.latestVersion)) return null;
    if (!["win32", "darwin", "linux", "unknown"].includes(state.platform)) return null;
    if (state.disabledReason !== null && !reasons.has(state.disabledReason)) return null;
    if (state.checkedAt !== null && (typeof state.checkedAt !== "number" || !Number.isFinite(state.checkedAt) || state.checkedAt < 0 || state.checkedAt > 8640000000000000)) return null;
    if (typeof state.retryAfterMs !== "number" || !Number.isFinite(state.retryAfterMs) || state.retryAfterMs < 0 || state.retryAfterMs > 1800000) return null;
    if (state.progressPercent !== null && (typeof state.progressPercent !== "number" || !Number.isFinite(state.progressPercent) || state.progressPercent < 0 || state.progressPercent > 100 || state.status !== "downloading")) return null;
    if (state.code !== null && !errors.has(state.code)) return null;
    if (state.warningCode !== null && !(state.status === "downloaded" && network.has(state.warningCode))) return null;
    return Object.fromEntries(keys.map((key) => [key, (state as unknown as Record<string, unknown>)[key]])) as UpdateState;
  } catch { return null; }
}

export function browserUpdateState(appVersion: string): UpdateState {
  return { status: "disabled", currentVersion: version(appVersion) ? appVersion : "unknown", latestVersion: null, platform: "browser", disabledReason: "browser", checkedAt: null, progressPercent: null, retryAfterMs: 0, code: null, warningCode: null };
}

export function updateView(state: UpdateState) {
  const disabled = (detail: string) => ({ badge: "暂不可用", title: "此环境不执行程序更新", detail, tone: "neutral", label: "桌面版可用", locked: true });
  if (state.status === "disabled") {
    if (state.disabledReason === "browser") return { ...disabled("网页版不能下载或安装 Windows 程序；可以查看 GitHub 发布说明。"), badge: "网页版", title: "请在 Windows 桌面版检查更新" };
    if (state.disabledReason === "isolated-test") return { ...disabled("隔离测试模式已关闭线上更新，不会下载或安装正式程序。"), label: "测试模式已关闭更新" };
    if (state.disabledReason === "development") return { ...disabled("开发模式已关闭程序更新；请使用正式 Windows 桌面版检查。"), label: "开发模式已关闭更新" };
    return disabled("当前环境的更新器不可用。现有功能与本机资料不会因此改变。");
  }
  if (state.status === "checking") return { badge: "正在检查", title: "正在检查可用更新", detail: "正在检查 GitHub 正式版本，请稍候。", tone: "active", label: "正在检查…", locked: true };
  if (state.status === "downloading") return { badge: "正在下载", title: "发现新版本，正在后台下载", detail: state.progressPercent === 100 ? "下载字节已完成，正在等待校验。只有安装包确认就绪后，才会显示等待退出安装。" : "你可以继续使用应用。下载完成后不会强制关闭窗口。", tone: "active", label: "正在下载…", locked: true };
  if (state.status === "downloaded") return { badge: "等待退出安装", title: "更新已下载完成", detail: state.warningCode ? "安装包已就绪，后续网络检查暂时失败。待安装版本已保留；请先保存当前操作，再正常关闭应用。" : "请先保存当前操作，再正常关闭应用。安装完成后重新打开，才会显示新版本。", tone: "success", label: "安装包已就绪", locked: true };
  if (state.status === "error") {
    if (state.code === "UPDATE_CONFIGURATION_FAILED") return { badge: "需要处理", title: "更新器初始化失败", detail: "已停止更新检查和自动安装。请保存当前操作，重新启动应用后再检查；本机资料不会被清空。", tone: "attention", label: "请重新启动后检查", locked: true };
    if (state.code && integrity.has(state.code)) return { badge: "校验失败", title: "安装包校验未通过，已暂停安装", detail: "不会安装此文件。请稍后重新检查，现有版本和本机资料保持不变。", tone: "attention", label: "重新检查", locked: false };
    if (state.code === "UPDATE_RESULT_UNAVAILABLE") return { badge: "检查未完成", title: "暂时未取得有效更新结果", detail: "没有确认新的安装包，自动安装已暂停。请等待下方重试间隔结束后重新检查。", tone: "attention", label: "重新检查", locked: false };
    return { badge: "检查失败", title: "暂时无法完成更新检查", detail: "请检查网络并在重试间隔结束后重新检查。失败不会影响本机资料或现有功能。", tone: "attention", label: "重新检查", locked: false };
  }
  if (state.status === "up-to-date") return { badge: "已是最新", title: "当前没有更高的可用正式版本", detail: "本次检查没有可安装的新版本，你可以继续使用应用。", tone: "success", label: "检查更新", locked: false };
  return { badge: "尚未检查", title: "随时查看更新状态", detail: "点击“检查更新”，查看是否有可用的新版本。", tone: "neutral", label: "检查更新", locked: false };
}

export function awaitUpdateRequest(request: () => Promise<unknown>, signal: AbortSignal, timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (success: boolean, value?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (success) resolve(value); else reject(new Error("UPDATE_REQUEST_UNAVAILABLE"));
    };
    const abort = () => finish(false);
    if (signal.aborted) { finish(false); return; }
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(false), timeoutMs);
    Promise.resolve().then(() => { if (signal.aborted || done) return; return request(); }).then((value) => finish(true, value), () => finish(false));
  });
}
