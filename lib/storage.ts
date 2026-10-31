import Dexie, { type Table } from "dexie";
import { getDesktopBridge } from "./desktop";
import type { WealthData } from "./types";
import { acknowledgeRemovalJournals, CloudSyncSafetyError, emptyDeletionMetadata, fingerprintSnapshot, mergeDeletionMetadata, parseSyncBaseline, prepareRemovalJournals, snapshotsEqual, validateDeletionMetadata, type DeletionMetadata, type SyncBaseline } from "./cloud-merge";
import { emptySyncOutbox, failSyncOutbox, queueSavedSnapshot, resumeSyncOutbox, validateSyncOutbox, type SyncFailureCode, type SyncOutbox } from "./cloud-retry";
import { assertActiveDataProfile, createBlankWealthData, getDataProfile, getObjectProfile, profileMetadataKey, snapshotKey, tagProfileObject, type DataProfile } from "./data-profile";
import { validAuthReceipt, type VerifiedAuthReceipt } from "./auth-session";

export type StorageLifecycleEvent =
  | "open-start"
  | "open-success"
  | "blocked"
  | "versionchange"
  | "read-start"
  | "read-success"
  | "write-start"
  | "write-success";

export type StorageLifecycleReporter = (event: StorageLifecycleEvent) => void;

export class WealthStorageError extends Error {
  constructor(
    message: string,
    public readonly storageStage: "open" | "blocked" | "versionchange" | "read" | "write",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WealthStorageError";
  }
}

let lifecycleReporter: StorageLifecycleReporter | null = null;

function emitLifecycle(event: StorageLifecycleEvent) {
  try {
    lifecycleReporter?.(event);
  } catch {
    // A diagnostics callback must never break local storage.
  }
}

class WealthAtlasDatabase extends Dexie {
  snapshots!: Table<{ id: string; data: WealthData; updatedAt: string }, string>;
  obsidianHandles!: Table<{ id: string; handle: unknown; vaultName: string; updatedAt: string }, string>;
  blockedDuringOpen = false;
  versionChanged = false;

  constructor() {
    super("wealth-atlas");
    this.version(1).stores({ snapshots: "id, updatedAt" });
    this.version(2).stores({ snapshots: "id, updatedAt", obsidianHandles: "id, updatedAt" });
    this.on("blocked", () => {
      this.blockedDuringOpen = true;
      emitLifecycle("blocked");
    });
    this.on("versionchange", () => {
      this.versionChanged = true;
      emitLifecycle("versionchange");
      this.close({ disableAutoOpen: true });
    });
  }
}

export const db = typeof window !== "undefined" ? new WealthAtlasDatabase() : null;

function storageTestMode() {
  return getDesktopBridge()?.startupTestMode ?? "";
}

export async function initializeWealthStorage(reporter?: StorageLifecycleReporter) {
  if (!db) return;
  lifecycleReporter = reporter ?? lifecycleReporter;
  emitLifecycle("open-start");

  const testMode = storageTestMode();
  if (testMode === "indexeddb-open-failure") {
    throw new WealthStorageError("IndexedDB open diagnostic test", "open");
  }
  if (testMode === "indexeddb-blocked") {
    emitLifecycle("blocked");
    throw new WealthStorageError("IndexedDB is blocked by another application window.", "blocked");
  }
  if (testMode === "indexeddb-versionchange") {
    emitLifecycle("versionchange");
    throw new WealthStorageError("IndexedDB version changed during startup.", "versionchange");
  }

  try {
    db.blockedDuringOpen = false;
    db.versionChanged = false;
    if (!db.isOpen()) {
      const timeout = new Promise<never>((_, reject) => {
        window.setTimeout(() => {
          const stage = db.blockedDuringOpen ? "blocked" : "open";
          reject(new WealthStorageError(
            stage === "blocked"
              ? "IndexedDB is blocked by another application window."
              : "IndexedDB did not finish opening in time.",
            stage,
          ));
        }, 10000);
      });
      await Promise.race([db.open(), timeout]);
    }
    if (db.versionChanged) {
      throw new WealthStorageError("IndexedDB version changed during startup.", "versionchange");
    }
    emitLifecycle("open-success");
  } catch (error) {
    if (error instanceof WealthStorageError) throw error;
    throw new WealthStorageError("IndexedDB could not be opened. Existing data was not changed.", "open", { cause: error });
  }
}

export async function retryWealthStorage(reporter?: StorageLifecycleReporter) {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Explicit reopen below remains the source of truth.
  }
  await initializeWealthStorage(reporter);
}

type DeletionJournalRow = { id: string; deletions: DeletionMetadata; updatedAt: string };
type OutboxRow = { id: string; outbox: SyncOutbox; updatedAt: string };
let snapshotWriteQueue: Promise<void> = Promise.resolve();
const deletionJournalId = (owner: string, scope: DataProfile) => scope.kind === "local"
  ? `cloud-deletions:v1:${owner}` : profileMetadataKey(scope, `deletions:${owner}`);

async function writeWealthData(data: WealthData, scope: DataProfile) {
  if (!db) return;
  await initializeWealthStorage();
  emitLifecycle("write-start");
  try {
    // No new store/version/migration: metadata uses separate, namespaced keys in
    // the existing store. Old clients still read only id=current.
    const journals = await prepareRemovalJournals(data);
    const journalTable = db.table<DeletionJournalRow, string>("snapshots");
    await db.transaction("rw", db.snapshots, async () => {
      const updatedAt = new Date().toISOString();
      for (const [owner, pending] of journals) {
        if (scope.kind === "cloud" && owner !== scope.ownerId) throw new CloudSyncSafetyError("删除标记不属于当前工作区，资料未改变。");
        const id = deletionJournalId(owner, scope);
        const existing = await journalTable.get(id);
        const deletions = mergeDeletionMetadata(existing ? validateDeletionMetadata(existing.deletions) : emptyDeletionMetadata(), pending);
        await journalTable.put({ id, deletions, updatedAt });
      }
      if (scope.kind === "cloud") {
        const outboxes = db!.table<OutboxRow, string>("snapshots");
        const id = profileMetadataKey(scope, "outbox");
        const row = await outboxes.get(id);
        const current = await db!.snapshots.get(snapshotKey(scope));
        let outbox = row ? validateSyncOutbox(row.outbox) : emptySyncOutbox();
        if (!row || !current || journals.size > 0 || !snapshotsEqual(current.data, data)) outbox = queueSavedSnapshot(outbox);
        // Snapshot + tombstones + pending revision commit atomically, or none do.
        await outboxes.put({ id, outbox, updatedAt });
      }
      await db!.snapshots.put({ id: snapshotKey(scope), data, updatedAt });
    });
    acknowledgeRemovalJournals(data);
    emitLifecycle("write-success");
  } catch (error) {
    throw new WealthStorageError("The local snapshot could not be saved. Existing data was not cleared.", "write", { cause: error });
  }
}

export function saveWealthData(data: WealthData, scope: DataProfile = getObjectProfile(data) ?? getDataProfile()): Promise<void> {
  try { assertActiveDataProfile(scope); }
  catch { return Promise.reject(new CloudSyncSafetyError("账号工作区已经切换或尚未就绪，未执行新的保存。")); }
  const owner = getObjectProfile(data);
  if (owner && owner !== scope) return Promise.reject(new CloudSyncSafetyError("资料不属于目标工作区，未执行保存。"));
  // Hash preparation must not reorder two rapid edits and save an older snapshot last.
  const pending = snapshotWriteQueue.then(() => writeWealthData(data, scope));
  snapshotWriteQueue = pending.catch(() => undefined);
  return pending;
}

export const flushWealthWrites = () => snapshotWriteQueue;

const authReceiptId = (ownerId: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) throw new Error("Invalid authentication metadata owner.");
  return `auth-verified:v1:${ownerId}`;
};
/** Separate metadata row in the existing store. No database/schema migration. */
export async function saveVerifiedAuthReceipt(receipt: VerifiedAuthReceipt) {
  if (!validAuthReceipt(receipt) || !db) throw new Error("Authentication metadata could not be saved.");
  await initializeWealthStorage();
  const table = db.table<{ id: string; receipt: VerifiedAuthReceipt }, string>("snapshots");
  await db.transaction("rw", db.snapshots, async () => {
    const id = authReceiptId(receipt.ownerId), old = await table.get(id);
    if (old && !validAuthReceipt(old.receipt)) throw new Error("Authentication metadata needs verification.");
    await table.put({ id, receipt: { ...receipt,
      ...(receipt.completedRecovery || old?.receipt.completedRecovery ? { completedRecovery: receipt.completedRecovery ?? old?.receipt.completedRecovery } : {}),
    } });
  });
}
export type AuthReceiptFailure = "db-unavailable" | "receipt-missing" | "receipt-invalid" | "workspace-missing" | "workspace-invalid";
export async function loadVerifiedAuthReceipt(ownerId: string, requireWorkspace = false,
  onFailure?: (reason: AuthReceiptFailure) => void): Promise<VerifiedAuthReceipt | null> {
  if (!db) { onFailure?.("db-unavailable"); return null; }
  await initializeWealthStorage();
  const row = await db.table<{ id: string; receipt: VerifiedAuthReceipt }, string>("snapshots").get(authReceiptId(ownerId));
  if (!row) { onFailure?.("receipt-missing"); return null; }
  if (!validAuthReceipt(row.receipt) || row.receipt.ownerId !== ownerId) { onFailure?.("receipt-invalid"); return null; }
  if (requireWorkspace) {
    // Read only: an offline session can never create/adopt a financial workspace.
    const saved = await db.snapshots.get(`profile:v1:cloud:${ownerId}`);
    if (!saved) { onFailure?.("workspace-missing"); return null; }
    if (!saved.data || !Array.isArray(saved.data.accounts) || !Array.isArray(saved.data.transactions)) { onFailure?.("workspace-invalid"); return null; }
  }
  return row.receipt;
}

/** Metadata-key count only. Missing credentials never select an old owner or
 * turn previously authenticated data into a newly-created empty guest profile. */
export async function hasVerifiedWorkspaceHistory(): Promise<boolean> {
  if (!db) throw new Error("Authentication metadata is unavailable.");
  await initializeWealthStorage();
  return (await db.snapshots.where("id").startsWith("auth-verified:v1:").count()) > 0;
}

/** Technical intent only, not an identity or permission grant. Preserve an
 * intentional sign-out across restart without deleting receipts/workspaces. */
export async function wasExplicitlySignedOut(): Promise<boolean> {
  if (!db) throw new Error("Authentication metadata is unavailable.");
  await initializeWealthStorage();
  const row = await db.table<{ id: string; version: number; signedOut: boolean }, string>("snapshots").get("auth-exit-intent:v1");
  return row?.version === 1 && row.signedOut === true;
}
export async function saveExplicitSignOutState(signedOut: boolean) {
  if (!db || typeof signedOut !== "boolean") throw new Error("Authentication intent could not be saved.");
  await initializeWealthStorage();
  await db.table<{ id: string; version: number; signedOut: boolean }, string>("snapshots").put({
    id: "auth-exit-intent:v1", version: 1, signedOut,
  });
}

/** Add-only workspace creation. Never adopts, replaces, or migrates legacy id=current. */
export async function prepareAccountWorkspace(scope: DataProfile, allowCreate = true) {
  if (scope.kind === "local") return;
  if (!db) throw new CloudSyncSafetyError("无法打开账号工作区，原资料未被覆盖。");
  await initializeWealthStorage();
  const data = createBlankWealthData();
  const baseline = await fingerprintSnapshot(data);
  const metadata = db.table<{ id: string; baseline: SyncBaseline }, string>("snapshots");
  await db.transaction("rw", db.snapshots, async () => {
    const existing = await db!.snapshots.get(snapshotKey(scope));
    if (existing) {
      if (!existing.data || !Array.isArray(existing.data.accounts) || !Array.isArray(existing.data.transactions)) {
        throw new CloudSyncSafetyError("账号工作区资料不完整，已停止载入，原资料未被覆盖。");
      }
      return;
    }
    if (!allowCreate) throw new CloudSyncSafetyError("离线工作区不存在，未建立空白替代资料。请联网后重新验证。");
    await db!.snapshots.add({ id: snapshotKey(scope), data, updatedAt: new Date().toISOString() });
    await metadata.add({ id: profileMetadataKey(scope, "baseline"), baseline });
    if (scope.kind === "cloud") await db!.table<OutboxRow, string>("snapshots").add({
      id: profileMetadataKey(scope, "outbox"), outbox: emptySyncOutbox(), updatedAt: new Date().toISOString(),
    });
  });
}

export async function loadCloudBaseline(scope: DataProfile): Promise<SyncBaseline | null> {
  await snapshotWriteQueue;
  if (!db) return null;
  const row = await db.table<{ id: string; baseline: SyncBaseline }, string>("snapshots").get(profileMetadataKey(scope, "baseline"));
  return row ? parseSyncBaseline(JSON.stringify(row.baseline)) : null;
}

export async function saveCloudBaseline(scope: DataProfile, baseline: SyncBaseline, acknowledgedDeletions: DeletionMetadata = emptyDeletionMetadata()) {
  assertActiveDataProfile(scope);
  validateDeletionMetadata(acknowledgedDeletions);
  if (!db) throw new CloudSyncSafetyError("同步基准无法保存，原资料已保留。");
  await snapshotWriteQueue;
  const saved = await db.snapshots.get(snapshotKey(scope));
  if (!saved?.data) throw new CloudSyncSafetyError("本地快照尚未确认，未清除待同步队列。");
  const savedFingerprint = await fingerprintSnapshot(saved.data);
  assertActiveDataProfile(scope);
  await db.transaction("rw", db.snapshots, async () => {
    const current = await db!.snapshots.get(snapshotKey(scope));
    await db!.table<{ id: string; baseline: SyncBaseline }, string>("snapshots").put({ id: profileMetadataKey(scope, "baseline"), baseline });
    const outboxes = db!.table<OutboxRow, string>("snapshots");
    const id = profileMetadataKey(scope, "outbox"), row = await outboxes.get(id);
    const journal = scope.ownerId ? await db!.table<DeletionJournalRow, string>("snapshots").get(deletionJournalId(scope.ownerId, scope)) : null;
    const deletionsAcknowledged = snapshotsEqual(journal ? validateDeletionMetadata(journal.deletions) : emptyDeletionMetadata(), acknowledgedDeletions);
    // An old ACK cannot clear an edit committed while hashing / uploading.
    if (row && deletionsAcknowledged && snapshotsEqual(current?.data, saved.data) && snapshotsEqual(savedFingerprint, baseline)) {
      const state = validateSyncOutbox(row.outbox);
      await outboxes.put({ id, updatedAt: new Date().toISOString(), outbox: {
        ...emptySyncOutbox(), revision: state.revision, acknowledgedRevision: state.revision,
      } });
    }
  });
}

/** One coalesced job per account. Financial payload stays only in its existing snapshot. */
export async function loadCloudOutbox(scope: DataProfile): Promise<SyncOutbox> {
  assertActiveDataProfile(scope);
  if (!db || scope.kind !== "cloud") throw new CloudSyncSafetyError("离线同步工作区不可用，原资料未改变。");
  await snapshotWriteQueue;
  await initializeWealthStorage();
  assertActiveDataProfile(scope);
  const table = db.table<OutboxRow, string>("snapshots"), id = profileMetadataKey(scope, "outbox");
  return db.transaction("rw", db.snapshots, async () => {
    const row = await table.get(id);
    if (row) return validateSyncOutbox(row.outbox);
    if (!(await db!.snapshots.get(snapshotKey(scope)))?.data) throw new CloudSyncSafetyError("本地快照不存在，未建立替代资料。");
    const outbox = queueSavedSnapshot(emptySyncOutbox()); // Add-only compatibility with an earlier account workspace.
    await table.add({ id, outbox, updatedAt: new Date().toISOString() });
    return outbox;
  });
}

async function updateCloudOutbox(scope: DataProfile, update: (state: SyncOutbox) => SyncOutbox) {
  await loadCloudOutbox(scope);
  assertActiveDataProfile(scope);
  const table = db!.table<OutboxRow, string>("snapshots"), id = profileMetadataKey(scope, "outbox");
  return db!.transaction("rw", db!.snapshots, async () => {
    const row = await table.get(id);
    if (!row) throw new CloudSyncSafetyError("待同步状态不存在，原资料未改变。");
    const outbox = validateSyncOutbox(update(validateSyncOutbox(row.outbox)));
    await table.put({ id, outbox, updatedAt: new Date().toISOString() });
    return outbox;
  });
}

export const recordCloudSyncFailure = (scope: DataProfile, code: SyncFailureCode) => updateCloudOutbox(scope, (state) => failSyncOutbox(state, code));
export const resumeCloudSync = (scope: DataProfile, transientOnly = false) => updateCloudOutbox(scope, (state) => resumeSyncOutbox(state, transientOnly));

export async function loadCloudDeletions(owner: string, scope: DataProfile = getDataProfile()): Promise<DeletionMetadata> {
  try {
    if (scope.kind === "cloud" && owner !== scope.ownerId) throw new CloudSyncSafetyError("拒绝读取其他账号的删除标记。");
    await snapshotWriteQueue;
    if (!db) return emptyDeletionMetadata();
    await initializeWealthStorage();
    const table = db.table<DeletionJournalRow, string>("snapshots");
    const unassigned = await table.get(deletionJournalId("unassigned", scope));
    if (unassigned && Object.values(validateDeletionMetadata(unassigned.deletions).tombstones).some((records) => Object.keys(records).length)) {
      throw new CloudSyncSafetyError("本机有尚未归属当前账号的删除操作，已暂停同步。请先备份并核对账号，不会自动合并或恢复资料。");
    }
    const row = await table.get(deletionJournalId(owner, scope));
    return row ? validateDeletionMetadata(row.deletions) : emptyDeletionMetadata();
  } catch (error) {
    if (error instanceof CloudSyncSafetyError) throw error;
    throw new CloudSyncSafetyError("无法读取本地删除同步标记，已暂停同步。请检查本地保存状态并备份后重试。");
  }
}

export async function saveCloudDeletions(owner: string, incoming: DeletionMetadata, scope: DataProfile = getDataProfile()) {
  try {
    assertActiveDataProfile(scope);
    if (scope.kind === "cloud" && owner !== scope.ownerId) throw new CloudSyncSafetyError("拒绝保存其他账号的删除标记。");
    validateDeletionMetadata(incoming);
    if (!Object.values(incoming.tombstones).some((records) => Object.keys(records).length)) return;
    await snapshotWriteQueue;
    if (!db) throw new CloudSyncSafetyError("无法保存删除同步标记，已暂停同步，原资料未被覆盖。");
    await initializeWealthStorage();
    const table = db.table<DeletionJournalRow, string>("snapshots");
    await db.transaction("rw", db.snapshots, async () => {
      const id = deletionJournalId(owner, scope);
      const existing = await table.get(id);
      const deletions = mergeDeletionMetadata(existing ? validateDeletionMetadata(existing.deletions) : emptyDeletionMetadata(), incoming);
      await table.put({ id, deletions, updatedAt: new Date().toISOString() });
    });
  } catch (error) {
    if (error instanceof CloudSyncSafetyError) throw error;
    throw new CloudSyncSafetyError("无法保存本地删除同步标记，已暂停同步。原始资料未被覆盖，请检查本地保存状态。");
  }
}

export async function loadWealthData(reporter?: StorageLifecycleReporter, scope: DataProfile = getDataProfile()) {
  if (scope.kind === "locked") return null;
  if (!db) return null;
  await initializeWealthStorage(reporter);
  emitLifecycle("read-start");
  try {
    if (getDesktopBridge()?.isStorageReadFailureTest) {
      throw new Error("IndexedDB startup diagnostic test");
    }
    const snapshot = await db.snapshots.get(snapshotKey(scope));
    emitLifecycle("read-success");
    return snapshot?.data ? tagProfileObject(snapshot.data, scope) : null;
  } catch (error) {
    throw new WealthStorageError("The current local snapshot could not be read. Existing data was not changed.", "read", { cause: error });
  }
}

export async function saveObsidianHandle(handle: unknown, vaultName: string, scope: DataProfile = getDataProfile()) {
  assertActiveDataProfile(scope);
  if (handle && typeof handle === "object" && getObjectProfile(handle) && getObjectProfile(handle) !== scope) throw new Error("Vault 连接属于旧账号，未执行保存。");
  if (!db) return;
  await initializeWealthStorage();
  const storedHandle = getDesktopBridge() ? { kind: "desktop-vault" } : handle;
  assertActiveDataProfile(scope);
  await db.obsidianHandles.put({ id: snapshotKey(scope), handle: storedHandle, vaultName, updatedAt: new Date().toISOString() });
}

export async function loadObsidianHandle(scope: DataProfile = getDataProfile()) {
  if (scope.kind === "locked") return null;
  if (!db) return null;
  await initializeWealthStorage();
  const stored = await db.obsidianHandles.get(snapshotKey(scope));
  assertActiveDataProfile(scope);
  if (stored?.handle && typeof stored.handle === "object") tagProfileObject(stored.handle, scope);
  return stored ? { handle: stored.handle, vaultName: stored.vaultName } : null;
}

export async function clearObsidianHandle(scope: DataProfile = getDataProfile()) {
  assertActiveDataProfile(scope);
  const bridge = getDesktopBridge();
  if (!db) return;
  await initializeWealthStorage();
  await bridge?.disconnectVault();
  assertActiveDataProfile(scope);
  await db.obsidianHandles.delete(snapshotKey(scope));
}
