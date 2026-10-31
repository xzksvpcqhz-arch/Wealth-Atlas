/** Sync metadata only. Never contains financial records, credentials or provider messages. */
export type SyncFailureCode = "network" | "server" | "authentication" | "permission" | "conflict" | "storage" | "safety";
export type SyncOutbox = {
  version: 1;
  revision: number;
  acknowledgedRevision: number;
  attempts: number;
  nextAttemptAt: number | null;
  paused: SyncFailureCode | "retry-limit" | null;
  lastError: SyncFailureCode | null;
  updatedAt: string;
};
export const MAX_SYNC_RETRIES = 8;
const delays = [2000, 5000, 10000, 30000, 60000, 120000, 300000, 600000];
const codes: SyncFailureCode[] = ["network", "server", "authentication", "permission", "conflict", "storage", "safety"];
export const hasPendingSync = (state: SyncOutbox) => state.revision > state.acknowledgedRevision;

export class CloudTransportError extends Error {
  readonly retryCode: SyncFailureCode;
  constructor(code: SyncFailureCode) {
    super(syncFailureMessage(code));
    this.name = "CloudTransportError";
    this.retryCode = code;
  }
}

export function classifySyncFailure(error: unknown): SyncFailureCode {
  if (error instanceof CloudTransportError) return error.retryCode;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "CloudEditConflictError") return "conflict";
  if (name === "WealthStorageError" || name === "CloudLocalSaveError") return "storage";
  return "safety"; // Unknown errors are never interpreted as permission to retry a write.
}

export function syncFailureMessage(code: SyncFailureCode | "offline" | "retry-limit"): string {
  const messages = {
    offline: "当前离线；已成功保存在本机的改动会在联网后自动重试。",
    network: "网络连接中断，待同步资料保留在本机，将稍后自动重试。",
    server: "云端暂时无法处理请求，待同步资料已保留，将稍后自动重试。",
    authentication: "登录验证已失效，已暂停自动同步。请重新登录；本机资料未被删除。",
    permission: "云端拒绝访问，已暂停自动同步。请检查账号权限；本机资料未被删除。",
    conflict: "检测到资料冲突，已暂停自动重试。请先备份并核对两个版本，再手动同步。",
    storage: "本地保存尚未确认，已停止上传。原资料已保留，请检查本地保存提示后重试。",
    safety: "同步安全校验未通过，已暂停自动重试。请先备份并检查后手动同步。",
    "retry-limit": "自动重试已达本轮上限，待同步资料仍保留。请检查网络后手动同步。",
  };
  return messages[code];
}

export function emptySyncOutbox(now = Date.now()): SyncOutbox {
  return { version: 1, revision: 0, acknowledgedRevision: 0, attempts: 0, nextAttemptAt: null, paused: null, lastError: null, updatedAt: new Date(now).toISOString() };
}

export function validateSyncOutbox(value: unknown): SyncOutbox {
  const row = value as SyncOutbox | null;
  const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  const allowed = ["version", "revision", "acknowledgedRevision", "attempts", "nextAttemptAt", "paused", "lastError", "updatedAt"];
  if (!row || row.version !== 1 || !integer(row.revision) || !integer(row.acknowledgedRevision) || row.acknowledgedRevision > row.revision
    || !integer(row.attempts) || row.attempts > MAX_SYNC_RETRIES || !(row.nextAttemptAt === null || integer(row.nextAttemptAt))
    || !(row.paused === null || row.paused === "retry-limit" || codes.includes(row.paused))
    || !(row.lastError === null || codes.includes(row.lastError))
    || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))
    || Object.keys(row).some((key) => !allowed.includes(key))
    || row.paused !== null && row.nextAttemptAt !== null
    || row.paused === "retry-limit" && (row.attempts !== MAX_SYNC_RETRIES || !["network", "server"].includes(row.lastError ?? ""))
    || row.revision === row.acknowledgedRevision && (row.attempts !== 0 || row.paused !== null || row.lastError !== null || row.nextAttemptAt !== null)) {
    const error = new Error("离线同步状态无法读取，已停止同步；原资料和队列未被重置。");
    error.name = "CloudSyncSafetyError";
    throw error;
  }
  return row;
}

export function queueSavedSnapshot(state: SyncOutbox, now = Date.now()): SyncOutbox {
  validateSyncOutbox(state);
  if (state.revision === Number.MAX_SAFE_INTEGER) throw new Error("离线同步序号已达上限，未执行写入。");
  return { ...state, revision: state.revision + 1, updatedAt: new Date(now).toISOString() };
}

export function failSyncOutbox(state: SyncOutbox, code: SyncFailureCode, now = Date.now(), random = Math.random()): SyncOutbox {
  validateSyncOutbox(state);
  const pending = hasPendingSync(state) ? state : queueSavedSnapshot(state, now);
  const transient = code === "network" || code === "server";
  const attempts = transient ? Math.min(MAX_SYNC_RETRIES, pending.attempts + 1) : pending.attempts;
  const paused = transient ? attempts >= MAX_SYNC_RETRIES ? "retry-limit" : null : code;
  const delay = delays[Math.min(attempts - 1, delays.length - 1)] ?? delays[0];
  return { ...pending, attempts, paused, lastError: code,
    nextAttemptAt: paused ? null : now + Math.round(delay * (1 + Math.max(0, Math.min(1, random)) * 0.2)), updatedAt: new Date(now).toISOString() };
}

export function resumeSyncOutbox(state: SyncOutbox, transientOnly = false, now = Date.now()): SyncOutbox {
  validateSyncOutbox(state);
  if (transientOnly && (state.lastError !== "network" || state.paused && state.paused !== "retry-limit")) return state;
  return { ...state, attempts: 0, paused: null, nextAttemptAt: null, lastError: null, updatedAt: new Date(now).toISOString() };
}

type Trigger = "initial" | "change" | "remote" | "manual" | "online" | "focus" | "timer";
export function createCloudRetryController(options: {
  load: () => Promise<SyncOutbox>;
  fail: (code: SyncFailureCode) => Promise<SyncOutbox>;
  resume: (transientOnly: boolean) => Promise<SyncOutbox>;
  run: () => Promise<boolean>;
  online: () => boolean;
  active: () => boolean;
  onState: (status: "syncing" | "ready" | "error", reason?: SyncFailureCode | "offline" | "retry-limit", error?: unknown) => void;
  now?: () => number;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (id: number) => void;
}) {
  const now = options.now ?? Date.now;
  let disposed = false;
  let timer: number | null = null;
  let running: Promise<void> | null = null;
  let again: Trigger | null = null;
  let pendingAfterRun: number | null = null;
  const active = () => !disposed && options.active();
  function cancelTimer() { if (timer !== null) options.clearTimer(timer); timer = null; }
  function report(status: "syncing" | "ready" | "error", reason?: SyncFailureCode | "offline" | "retry-limit", error?: unknown) {
    if (active()) options.onState(status, reason, error);
  }
  function schedule(at: number) {
    cancelTimer();
    if (!active() || !options.online()) return;
    timer = options.setTimer(() => { timer = null; void request("timer"); }, Math.max(1, at - now()));
  }
  async function attempt(trigger: Trigger) {
    let state = await options.load();
    if (!active()) return;
    if (trigger === "manual" || trigger === "online") state = await options.resume(trigger === "online");
    if (!active()) return;
    if (state.paused) { report("error", state.paused); return; }
    if (!options.online()) { cancelTimer(); report("error", "offline"); return; }
    if (state.nextAttemptAt !== null && state.nextAttemptAt > now()) {
      schedule(state.nextAttemptAt); report("error", state.lastError ?? "network"); return;
    }
    report("syncing");
    try {
      const completed = await options.run();
      if (!completed || !active()) return;
      state = await options.load();
      if (!active()) return;
      if (hasPendingSync(state)) {
        if (pendingAfterRun === state.revision) {
          await options.fail("storage"); report("error", "storage"); return;
        }
        pendingAfterRun = state.revision;
        schedule(now() + 1200); report("error", "storage");
      } else { pendingAfterRun = null; cancelTimer(); report("ready"); }
    } catch (error) {
      if (!active()) return;
      const code = classifySyncFailure(error);
      state = await options.fail(code);
      if (!active()) return;
      report("error", state.paused === "retry-limit" ? "retry-limit" : code, error);
      if (!state.paused && state.nextAttemptAt !== null) schedule(state.nextAttemptAt);
    }
  }
  function request(trigger: Trigger = "change"): Promise<void> {
    if (!active()) return Promise.resolve();
    if (running) { if (again !== "manual") again = trigger; return running; }
    cancelTimer();
    running = attempt(trigger).catch(() => { report("error", "storage"); }).finally(() => {
      running = null;
      const pending = again; again = null;
      if (pending && active()) void request(pending);
    });
    return running;
  }
  return { request, dispose() { disposed = true; cancelTimer(); again = null; } };
}
