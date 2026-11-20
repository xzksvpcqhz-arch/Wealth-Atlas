import { canonicalJson } from "./cloud-merge";
import { assertActiveDataProfile, getDataProfile, profileMetadataKey, snapshotKey, type DataProfile } from "./data-profile";
import type { WealthData } from "./types";
import { stableRestoreFingerprint } from "./backup-restore-preview";

/** Metadata only, in the existing snapshots store. Never a cloud rollback instruction. */
export type RestoreHold = Readonly<{
  version: 1;
  paused: boolean;
  generation: number;
  revision: number;
  restoredAt: string | null;
}>;
export const EMPTY_RESTORE_HOLD: RestoreHold = Object.freeze({ version: 1, paused: false, generation: 0, revision: 0, restoredAt: null });
export class RestoreIsolationError extends Error {
  constructor(message = "本机恢复保护尚未确认，已停止操作，原资料未被覆盖。") { super(message); this.name = "RestoreIsolationError"; }
}
export const restoreHoldKey = (scope: DataProfile) => profileMetadataKey(scope, "restore-isolation:v1");
export function parseRestoreHold(value: unknown): RestoreHold {
  if (!value || typeof value !== "object") throw new RestoreIsolationError();
  const hold = value as RestoreHold;
  if (hold.version !== 1 || typeof hold.paused !== "boolean" || !Number.isSafeInteger(hold.generation) || hold.generation < 0
    || !Number.isSafeInteger(hold.revision) || hold.revision < hold.generation
    || !(hold.restoredAt === null || typeof hold.restoredAt === "string" && Number.isFinite(Date.parse(hold.restoredAt)))
    || (hold.paused && (hold.generation === 0 || hold.restoredAt === null))) throw new RestoreIsolationError();
  return Object.freeze({ version: 1, paused: hold.paused, generation: hold.generation, revision: hold.revision, restoredAt: hold.restoredAt });
}

// A synchronous, lossless stable fingerprint allows the CAS comparison INSIDE
// IndexedDB's transaction, without a WebCrypto await auto-closing that transaction.
// The string is only held in memory; it is never persisted or broadcast.
export const restoreFingerprint = (data: WealthData): string => stableRestoreFingerprint(data);
type View = { loaded: boolean; hold: RestoreHold | null; preparing: boolean; error: string | null };
const views = new Map<string, View>();
const listeners = new Set<() => void>();
let revision = 0;
let channel: BroadcastChannel | null = null;
const leases = new WeakMap<DataProfile, { epoch: number; key: string; ownerId: string | null; kind: DataProfile["kind"] }>();
const saveGenerations = new WeakMap<DataProfile, number>();
const objectGenerations = new WeakMap<object, number>();
const preparing = new Set<string>();
const UNKNOWN: View = Object.freeze({ loaded: false, hold: null, preparing: false, error: null });
function notify() { revision++; listeners.forEach((listener) => { try { listener(); } catch { /* Observers cannot undo durability. */ } }); }
function connectChannel() {
  if (channel || typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
  try {
    channel = new BroadcastChannel("wealth-atlas-restore-isolation-v1");
    channel.onmessage = (event: MessageEvent) => {
      const key = event.data?.key;
      if (typeof key !== "string" || !views.has(key)) return;
      const old = views.get(key)!;
      views.set(key, { ...old, loaded: false });
      notify();
      const scope = getDataProfile();
      if (scope.kind !== "locked" && snapshotKey(scope) === key) void loadRestoreHold(scope).catch(() => undefined);
    };
  } catch { /* Durable checks remain authoritative if notifications are unavailable. */ }
}
export function subscribeRestoreIsolation(listener: () => void) { connectChannel(); listeners.add(listener); return () => { listeners.delete(listener); }; }
export const getRestoreIsolationRevision = () => revision;
export const getServerRestoreIsolationRevision = () => 0;
export function getRestoreIsolationState(scope: DataProfile): View {
  if (scope.kind === "locked") return UNKNOWN;
  return views.get(snapshotKey(scope)) ?? UNKNOWN;
}
export function isRestorePreparing(scope: DataProfile) { return scope.kind !== "locked" && preparing.has(snapshotKey(scope)); }
export function areRestoreSideEffectsBlocked(scope: DataProfile) {
  const view = getRestoreIsolationState(scope);
  return !view.loaded || !!view.error || view.preparing || view.hold?.paused !== false;
}
export function publishRestoreHold(scope: DataProfile, hold: RestoreHold, broadcast = false) {
  const key = snapshotKey(scope), old = views.get(key);
  if (old?.hold && old.hold.revision > hold.revision) return;
  const next = { loaded: true, hold, preparing: preparing.has(key), error: null };
  views.set(key, next);
  if (!old || !old.loaded || old.error || old.preparing !== next.preparing || canonicalJson(old.hold) !== canonicalJson(hold)) notify();
  if (broadcast) { connectChannel(); try { channel?.postMessage({ key }); } catch { /* Metadata will be rechecked at the boundary. */ } }
}
export function noteRestoreGeneration(scope: DataProfile, data: WealthData, generation: number) {
  // Reading the hold alone must NOT upgrade another window's stale financial view.
  saveGenerations.set(scope, generation);
  objectGenerations.set(data, generation);
}
export function getRestoreSaveGeneration(scope: DataProfile, data: WealthData) {
  return objectGenerations.get(data) ?? saveGenerations.get(scope) ?? 0;
}
export function assertRestoreGeneration(scope: DataProfile, generation: number, hold: RestoreHold, acceptedQueuedSave = false) {
  // Account-boundary deliberately locks private UI BEFORE draining already
  // accepted saves, then flushes that queue BEFORE activating another account.
  // Such an admitted save may finish in its original namespace while locked;
  // it still cannot cross a restore generation or an activated new account.
  if (!acceptedQueuedSave || getDataProfile().kind !== "locked") assertActiveDataProfile(scope);
  if (hold.generation !== generation) throw new RestoreIsolationError("资料已在其他窗口恢复，旧保存已取消。请重新载入当前工作区后再编辑。");
}
export function assertRestoreLease(scope: DataProfile) {
  assertActiveDataProfile(scope);
  const lease = leases.get(scope);
  if (!lease || lease.epoch !== scope.epoch || lease.key !== scope.key || lease.ownerId !== scope.ownerId || lease.kind !== scope.kind) {
    throw new RestoreIsolationError("恢复屏障已失效或工作区已切换，原资料未被覆盖。");
  }
}

export async function loadRestoreHold(scope: DataProfile): Promise<RestoreHold> {
  try {
    const storage = await import("./storage");
    const hold = await storage.loadRestoreHoldStorage(scope);
    publishRestoreHold(scope, hold);
    return hold;
  } catch (error) {
    if (scope.kind !== "locked") { views.set(snapshotKey(scope), { loaded: false, hold: null, preparing: isRestorePreparing(scope), error: "恢复保护状态无法读取，云同步与 Vault 自动快照已暂停。" }); notify(); }
    throw error;
  }
}
export async function assertRestoreSideEffectsAllowed(scope: DataProfile) {
  assertActiveDataProfile(scope);
  if (isRestorePreparing(scope)) throw new RestoreIsolationError("正在准备本机恢复，云同步与 Vault 自动快照已暂停。");
  const hold = await loadRestoreHold(scope);
  assertActiveDataProfile(scope);
  if (hold.paused || isRestorePreparing(scope)) throw new RestoreIsolationError("本机恢复后已暂停云同步与 Vault 自动快照。请核对资料后明确恢复；恢复同步可能产生合并或冲突。");
  return hold;
}
function lockManager() { return typeof navigator !== "undefined" ? navigator.locks : undefined; }
function lockName(scope: DataProfile) { return `wealth-atlas:restore-effects:${snapshotKey(scope)}`; }

/** The callback must cover the ENTIRE cloud session or automatic Vault write.
 * Never acquire this lock recursively; ordinary IndexedDB saves do not acquire it. */
export async function withRestoreSideEffects<T>(scope: DataProfile, work: () => Promise<T>): Promise<T> {
  const run = async () => { await assertRestoreSideEffectsAllowed(scope); return work(); };
  const locks = lockManager();
  // Legacy platforms may continue normal operation, but cannot perform a restore.
  return locks ? locks.request(lockName(scope), { mode: "exclusive" }, run) : run();
}

/** No safety backup or commit may run until old cloud/Vault work has settled.
 * The caller must recheck its live dataRef, identity and preview inside work,
 * then create/verify the safety backup, commit, and install the committed object. */
export async function withLocalRestore<T>(scope: DataProfile, work: () => Promise<T>): Promise<T> {
  assertActiveDataProfile(scope);
  const locks = lockManager(), key = snapshotKey(scope);
  const identity = { epoch: scope.epoch, key: scope.key, ownerId: scope.ownerId, kind: scope.kind };
  if (!locks) throw new RestoreIsolationError("此环境无法隔离其他窗口的同步操作，已取消恢复。请使用支持 Web Locks 的浏览器或桌面版。");
  if (preparing.has(key)) throw new RestoreIsolationError("此工作区已有恢复操作，请等待完成。");
  preparing.add(key);
  views.set(key, { ...getRestoreIsolationState(scope), preparing: true }); notify();
  try {
    return await locks.request(lockName(scope), { mode: "exclusive" }, async () => {
      assertActiveDataProfile(scope);
      leases.set(scope, identity);
      assertRestoreLease(scope);
      const storage = await import("./storage");
      await storage.flushWealthWrites();
      assertRestoreLease(scope);
      return await work();
    });
  } finally {
    leases.delete(scope); preparing.delete(key);
    views.set(key, { ...(views.get(key) ?? UNKNOWN), preparing: false }); notify();
  }
}
export async function commitRestoredSnapshot(scope: DataProfile, expectedFingerprint: string, candidate: WealthData): Promise<RestoreHold> {
  assertRestoreLease(scope);
  // Pin before the import await as callers may otherwise mutate a candidate
  // while the module/storage initialization is pending.
  const fingerprint = restoreFingerprint(candidate);
  const storage = await import("./storage");
  if (restoreFingerprint(candidate) !== fingerprint) throw new RestoreIsolationError("恢复候选已变化，请重新预览。");
  return storage.commitRestoredSnapshotStorage(scope, expectedFingerprint, candidate);
}
/** Explicit user action only. This does not discard tombstones/outbox/baseline,
 * and it does not promise that a restored snapshot will win a cloud merge. */
export async function resumeRestoreSideEffects(scope: DataProfile): Promise<RestoreHold> {
  assertActiveDataProfile(scope);
  if (isRestorePreparing(scope)) throw new RestoreIsolationError("恢复尚未结束，未解除保护。");
  const locks = lockManager();
  if (!locks) throw new RestoreIsolationError("此环境无法安全解除恢复保护。");
  return locks.request(lockName(scope), { mode: "exclusive" }, async () => {
    assertActiveDataProfile(scope);
    const storage = await import("./storage");
    return storage.resumeRestoreSideEffectsStorage(scope);
  });
}
