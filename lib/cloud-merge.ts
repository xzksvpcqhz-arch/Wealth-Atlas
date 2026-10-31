import type { WealthData } from "./types";

const ARRAY_FIELDS = [
  "accounts",
  "transactions",
  "transfers",
  "fxRates",
  "goals",
  "assets",
  "plannedPayments",
  "budgets",
  "categories",
  "annualPlans",
  "watchlists",
  "investments",
  "investmentTransactions",
  "liabilities",
  "netWorthHistory",
  "subscriptions",
  "reviews",
  "importReviews",
  "migrationHistory",
  "migrationBackups",
  "migrationNotices",
  "assetMigrationBackups",
  "syncLogs",
] as const;

/** Stable JSON equality ignores object-key ordering, but never merges financial fields. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    }
    return item;
  }) ?? "null";
}

export function snapshotsEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export class CloudSyncSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudSyncSafetyError";
  }
}

export class CloudEditConflictError extends CloudSyncSafetyError {
  readonly conflictCount: number;
  constructor(conflictCount: number) {
    super(`检测到 ${conflictCount} 项不同修改，已暂停同步并保留本机和云端资料。请先备份，处理冲突后再同步；不会自动选择某一版本覆盖。`);
    this.name = "CloudEditConflictError";
    this.conflictCount = conflictCount;
  }
}

export class CloudLocalSaveError extends CloudSyncSafetyError {
  constructor() { super("本地保存尚未确认，已暂停上传。原资料已保留，请检查本地保存提示并备份后重试。"); this.name = "CloudLocalSaveError"; }
}

/** Hash-only metadata: no record contents, balances, names, or credentials. */
type FieldFingerprint = { kind: "value"; hash: string } | { kind: "records"; records: Record<string, string> };
export type SyncBaseline = { version: 1; fields: Record<string, FieldFingerprint> };

// Only collections with an existing, confirmed permanent-delete path. Never
// infer deletion for reports, migration backups, or read-only calculated data.
const REMOVABLE_FIELDS = ["accounts", "transactions", "transfers", "fxRates", "goals", "assets", "plannedPayments", "budgets", "categories", "annualPlans", "watchlists"] as const;
export type RemovableField = typeof REMOVABLE_FIELDS[number];
export type DeletionMetadata = { version: 1; tombstones: Partial<Record<RemovableField, Record<string, string[]>>> };
const SYNC_PAYLOAD_KEY = "__wealthAtlasSync";
type RemovalIntent = { owner: string; field: RemovableField; record: unknown };
const removalIntents = new WeakMap<WealthData, RemovalIntent[]>();
let deletionOwner: { id: string } | null = null;

export function registerDeletionOwner(id: string): () => void {
  const lease = { id };
  deletionOwner = lease;
  return () => { if (deletionOwner === lease) deletionOwner = null; };
}

/** Called ONLY inside an existing confirmed-delete handler. No inference from empty data. */
export function removeConfirmedRecord(data: WealthData, field: RemovableField, id: string): WealthData {
  if (!(REMOVABLE_FIELDS as readonly string[]).includes(field)) throw new CloudSyncSafetyError("该模块没有永久删除规则，资料未改变。");
  const items = data[field] as Array<{ id: string }> | undefined;
  const record = items?.find((item) => item.id === id);
  if (!record) return data;
  const next = { ...data, [field]: items!.filter((item) => item.id !== id) };
  removalIntents.set(next, [...(removalIntents.get(data) ?? []), { owner: deletionOwner?.id ?? "unassigned", field, record }]);
  return next;
}

/** Carry non-serializable intents across batched local edits, not into financial JSON. */
export function inheritRemovalIntents(previous: WealthData, next: WealthData): WealthData {
  if (previous === next) return next;
  const intents = [...new Set([...(removalIntents.get(previous) ?? []), ...(removalIntents.get(next) ?? [])])];
  if (intents.length) removalIntents.set(next, intents);
  return next;
}

export function emptyDeletionMetadata(): DeletionMetadata {
  return { version: 1, tombstones: {} };
}

export function validateDeletionMetadata(value: unknown): DeletionMetadata {
  const item = value as DeletionMetadata | null;
  const isHash = (entry: unknown) => typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry);
  if (!item || item.version !== 1 || !item.tombstones || typeof item.tombstones !== "object" || Array.isArray(item.tombstones)) {
    throw new CloudSyncSafetyError("删除同步标记无法读取，已暂停同步；不会重置或覆盖原资料。");
  }
  for (const [field, records] of Object.entries(item.tombstones)) {
    if (!(REMOVABLE_FIELDS as readonly string[]).includes(field) || !records || typeof records !== "object" || Array.isArray(records)
      || !Object.entries(records).every(([key, hashes]) => isHash(key) && Array.isArray(hashes) && hashes.length > 0 && hashes.every(isHash))) {
      throw new CloudSyncSafetyError("删除同步标记格式不正确，已暂停同步；不会重置或覆盖原资料。");
    }
  }
  return item;
}

export function mergeDeletionMetadata(...values: DeletionMetadata[]): DeletionMetadata {
  const result = emptyDeletionMetadata();
  for (const value of values) {
    for (const [field, records] of Object.entries(validateDeletionMetadata(value).tombstones)) {
      const target = result.tombstones[field as RemovableField] ??= {};
      for (const [key, hashes] of Object.entries(records)) target[key] = [...new Set([...(target[key] ?? []), ...hashes])].sort();
    }
  }
  return result;
}

/** The snapshot and these hash-only journals are saved in ONE IndexedDB transaction. */
export async function prepareRemovalJournals(data: WealthData): Promise<Map<string, DeletionMetadata>> {
  const journals = new Map<string, DeletionMetadata>();
  for (const intent of removalIntents.get(data) ?? []) {
    const current = data[intent.field] as Array<{ id: string }> | undefined;
    const record = intent.record as { id: string };
    if (!Array.isArray(current) || current.some((item) => item.id === record.id)) continue;
    const metadata = journals.get(intent.owner) ?? emptyDeletionMetadata();
    const records = metadata.tombstones[intent.field] ??= {};
    const key = await hash(keyOf(record));
    records[key] = [...new Set([...(records[key] ?? []), await hash(record)])].sort();
    journals.set(intent.owner, metadata);
  }
  return journals;
}

export function acknowledgeRemovalJournals(data: WealthData) {
  removalIntents.delete(data); // Metadata is now durable; do not retain removed record contents in memory.
}

export function decodeSyncPayload(payload: WealthData): { data: WealthData; deletions: DeletionMetadata } {
  assertSnapshot(payload);
  const raw = payload as unknown as Record<string, unknown>;
  if (!Object.hasOwn(raw, SYNC_PAYLOAD_KEY)) return { data: payload, deletions: emptyDeletionMetadata() };
  const { [SYNC_PAYLOAD_KEY]: metadata, ...data } = raw;
  return { data: data as WealthData, deletions: validateDeletionMetadata(metadata) };
}

export function encodeSyncPayload(data: WealthData, deletions: DeletionMetadata): WealthData {
  validateDeletionMetadata(deletions);
  return Object.values(deletions.tombstones).some((records) => Object.keys(records).length > 0)
    ? ({ ...data, [SYNC_PAYLOAD_KEY]: deletions } as WealthData) : data;
}

function assertSnapshot(value: unknown): asserts value is WealthData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudSyncSafetyError("同步资料格式不完整，已停止同步，原资料未被覆盖。");
  }
  for (const field of ARRAY_FIELDS) {
    const items = (value as Record<string, unknown>)[field];
    if (items !== undefined && !Array.isArray(items)) {
      throw new CloudSyncSafetyError("同步列表格式不正确，已停止同步，原资料未被覆盖。");
    }
    if (Array.isArray(items)) {
      const keys = items.map(keyOf);
      if (new Set(keys).size !== keys.length) {
        throw new CloudSyncSafetyError("同步资料有重复记录标识，已停止同步，原资料未被覆盖。");
      }
    }
  }
}

/** Namespace IDs to avoid collisions with content-addressed, non-ID records. */
export function keyOf(item: unknown): string {
  if (item && typeof item === "object" && "id" in item && typeof (item as { id: unknown }).id === "string") {
    return `id:${(item as { id: string }).id}`;
  }
  return `value:${canonicalJson(item)}`;
}

async function hash(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new CloudSyncSafetyError("当前环境无法进行同步版本校验，已停止同步，财务资料仍保留在本机。");
  }
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintSnapshot(data: WealthData): Promise<SyncBaseline> {
  assertSnapshot(data);
  const fields: SyncBaseline["fields"] = Object.create(null);
  await Promise.all(Object.entries(data).map(async ([field, value]) => {
    if (value === undefined) return;
    if ((ARRAY_FIELDS as readonly string[]).includes(field)) {
      const records: Record<string, string> = Object.create(null);
      await Promise.all((value as unknown[]).map(async (item) => { records[await hash(keyOf(item))] = await hash(item); }));
      fields[field] = { kind: "records", records };
    } else {
      fields[field] = { kind: "value", hash: await hash(value) };
    }
  }));
  return { version: 1, fields };
}

export function parseSyncBaseline(serialized: string | null): SyncBaseline | null {
  try {
    const value = JSON.parse(serialized ?? "null");
    if (value?.version !== 1 || !value.fields || typeof value.fields !== "object" || Array.isArray(value.fields)) return null;
    const isHash = (item: unknown) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item);
    for (const entry of Object.values(value.fields) as FieldFingerprint[]) {
      if (!entry || typeof entry !== "object") return null;
      if (entry.kind === "value" && isHash(entry.hash)) continue;
      if (entry.kind === "records" && entry.records && typeof entry.records === "object" && !Array.isArray(entry.records)
        && Object.keys(entry.records).every(isHash) && Object.values(entry.records).every(isHash)) continue;
      return null;
    }
    return value as SyncBaseline;
  } catch {
    return null;
  }
}

/**
 * Three-way, record-atomic merge. Unknown ancestry + different values is a conflict.
 * Permanent removals require durable tombstones. Unknown missing records pause
 * instead of being resurrected or interpreted as permission to delete data.
 * No input is mutated; ANY conflict prevents the complete snapshot from being applied.
 */
export async function mergeSnapshots(local: WealthData, remote: WealthData, baseline: SyncBaseline | null = null, deletions: DeletionMetadata = emptyDeletionMetadata()): Promise<WealthData> {
  assertSnapshot(local);
  assertSnapshot(remote);
  validateDeletionMetadata(deletions);
  if (local.schemaVersion !== undefined && remote.schemaVersion !== undefined && local.schemaVersion !== remote.schemaVersion) {
    throw new CloudSyncSafetyError("两台设备的资料版本不同，已暂停同步。请先更新应用并备份，不会自动迁移或降级资料。");
  }
  const [localPrint, remotePrint] = await Promise.all([fingerprintSnapshot(local), fingerprintSnapshot(remote)]);
  const merged: Record<string, unknown> = { ...local };
  let conflicts = 0;
  for (const field of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const remoteValue = (remote as unknown as Record<string, unknown>)[field];
    const localValue = (local as unknown as Record<string, unknown>)[field];
    const ancestor = baseline?.fields[field];
    if ((ARRAY_FIELDS as readonly string[]).includes(field)) {
      const localItems = new Map(((localValue as unknown[] | undefined) ?? []).map((item) => [keyOf(item), item]));
      const remoteItems = new Map(((remoteValue as unknown[] | undefined) ?? []).map((item) => [keyOf(item), item]));
      const items = new Map<string, unknown>();
      const l = localPrint.fields[field];
      const r = remotePrint.fields[field];
      for (const key of new Set([...localItems.keys(), ...remoteItems.keys()])) {
        const fingerprintKey = await hash(key);
        const lh = l?.kind === "records" ? l.records[fingerprintKey] : undefined;
        const rh = r?.kind === "records" ? r.records[fingerprintKey] : undefined;
        const bh = ancestor?.kind === "records" ? ancestor.records[fingerprintKey] : undefined;
        const deletedHashes = deletions.tombstones[field as RemovableField]?.[fingerprintKey];
        if (deletedHashes) {
          // Unchanged stale replicas may be removed; edits/restores competing
          // with a permanent deletion must be reviewed, never silently lost.
          if ((lh && !deletedHashes.includes(lh) && lh !== bh) || (rh && !deletedHashes.includes(rh) && rh !== bh)) conflicts++;
          continue;
        }
        if ((REMOVABLE_FIELDS as readonly string[]).includes(field) && bh !== undefined
          && ((!localItems.has(key) && Array.isArray(localValue)) || (!remoteItems.has(key) && Array.isArray(remoteValue)))) {
          conflicts++;
          continue;
        }
        if (!localItems.has(key)) items.set(key, remoteItems.get(key));
        else if (!remoteItems.has(key) || lh === rh || (bh !== undefined && rh === bh)) items.set(key, localItems.get(key));
        else if (bh !== undefined && lh === bh) items.set(key, remoteItems.get(key));
        else conflicts++;
      }
      merged[field] = Array.from(items.values());
    } else {
      if (remoteValue === undefined) continue;
      const l = localPrint.fields[field];
      const r = remotePrint.fields[field];
      const lh = l?.kind === "value" ? l.hash : undefined;
      const rh = r?.kind === "value" ? r.hash : undefined;
      const bh = ancestor?.kind === "value" ? ancestor.hash : undefined;
      if (localValue === undefined || lh === rh || (bh !== undefined && lh === bh)) merged[field] = remoteValue;
      else if (bh === undefined || rh !== bh) conflicts++;
    }
  }
  // Never cascade an account/category/rate removal into another record's history.
  const checkReference = async (field: RemovableField, id: unknown) => {
    if (typeof id === "string" && deletions.tombstones[field]?.[await hash(`id:${id}`)]) conflicts++;
  };
  for (const account of (merged.accounts ?? []) as WealthData["accounts"]) await checkReference("accounts", account.parentAccountId);
  for (const transaction of (merged.transactions ?? []) as WealthData["transactions"]) {
    await checkReference("accounts", transaction.accountId);
    await checkReference("categories", transaction.categoryId);
    await checkReference("fxRates", transaction.fxSnapshot?.rateId);
  }
  for (const transfer of (merged.transfers ?? []) as WealthData["transfers"]) {
    await checkReference("accounts", transfer.fromAccountId);
    await checkReference("accounts", transfer.toAccountId);
    await checkReference("fxRates", transfer.fxSnapshot?.rateId);
  }
  if (conflicts) throw new CloudEditConflictError(conflicts);
  return merged as WealthData;
}

export type CloudSnapshot = { data: WealthData; updatedAt: string };
export type CloudSyncTransport = {
  pull: () => Promise<CloudSnapshot | null>;
  compareAndSet: (data: WealthData, expected: CloudSnapshot | null) => Promise<CloudSnapshot | null>;
};

/** One serialized path for login, manual sync, local changes, and realtime hints. */
export function createCloudSyncSession(options: {
  transport: CloudSyncTransport;
  baseline: SyncBaseline | null;
  getLocal: () => WealthData;
  applyLocal: (expected: WealthData, next: WealthData) => Promise<boolean>;
  confirmLocalPersistence?: (expected: WealthData) => Promise<boolean>;
  loadDeletions?: () => Promise<DeletionMetadata>;
  saveDeletions?: (deletions: DeletionMetadata) => Promise<void>;
  saveBaseline: (baseline: SyncBaseline, acknowledgedDeletions: DeletionMetadata) => void | Promise<void>;
}) {
  let baseline = options.baseline;
  let disposed = false;
  let running: Promise<boolean> | null = null;
  let requested = false;
  let deletions = emptyDeletionMetadata();

  async function pass(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      // Offline queue is local-first: never upload a React-only, unsaved edit.
      if (options.confirmLocalPersistence && !await options.confirmLocalPersistence(options.getLocal())) throw new CloudLocalSaveError();
      if (disposed) return;
      const journal = await options.loadDeletions?.() ?? emptyDeletionMetadata();
      if (disposed) return;
      const pulled = await options.transport.pull();
      if (disposed) return;
      const inputPayload = decodeSyncPayload(options.getLocal());
      const remotePayload = pulled ? decodeSyncPayload(pulled.data) : null;
      deletions = mergeDeletionMetadata(deletions, journal, inputPayload.deletions, remotePayload?.deletions ?? emptyDeletionMetadata());
      const input = inputPayload.data;
      const inputBase = await fingerprintSnapshot(input);
      const candidate = await mergeSnapshots(input, remotePayload?.data ?? input, baseline, deletions);
      const payload = encodeSyncPayload(candidate, deletions);
      const acknowledgedBase = await fingerprintSnapshot(candidate);
      if (disposed) return;
      // The pull/hash may have taken seconds. Recheck the actual input being
      // uploaded, not merely the state that was durable when this pass started.
      if (options.confirmLocalPersistence && !await options.confirmLocalPersistence(input)) throw new CloudLocalSaveError();
      if (disposed) return;
      if (!snapshotsEqual(input, decodeSyncPayload(options.getLocal()).data)) continue;
      const acknowledged = pulled && snapshotsEqual(payload, pulled.data)
        ? pulled
        : await options.transport.compareAndSet(payload, pulled);
      if (disposed) return;
      if (!acknowledged) continue; // Lost CAS race: re-pull, never blind upsert.
      if (!snapshotsEqual(acknowledged.data, payload)) {
        throw new CloudSyncSafetyError("云端返回的资料与本次提交不同，已停止同步，本机资料未被覆盖。");
      }
      // Keep remote tombstones durable even if the app closes before React applies.
      await options.saveDeletions?.(deletions);
      if (disposed) return;
      // Edits made while awaiting the network must not be replaced by an old ACK.
      let applied = false;
      for (let rebase = 0; rebase < 3; rebase++) {
        // A confirmed deletion may have happened while the upload was pending.
        deletions = mergeDeletionMetadata(deletions, await options.loadDeletions?.() ?? emptyDeletionMetadata());
        if (disposed) return;
        const latest = options.getLocal();
        const next = await mergeSnapshots(decodeSyncPayload(latest).data, candidate, inputBase, deletions);
        if (disposed) return;
        if (!snapshotsEqual(latest, options.getLocal())) continue;
        applied = await options.applyLocal(latest, next);
        if (disposed) return;
        if (applied) break;
      }
      if (!applied) throw new CloudSyncSafetyError("本机仍在编辑，已保留最新修改，请稍后重新同步。");
      if (options.confirmLocalPersistence && !await options.confirmLocalPersistence(options.getLocal())) {
        throw new CloudLocalSaveError();
      }
      if (disposed) return;
      await options.saveBaseline(acknowledgedBase, decodeSyncPayload(acknowledged.data).deletions);
      if (disposed) return;
      baseline = acknowledgedBase;
      if (!snapshotsEqual(options.getLocal(), candidate)) requested = true;
      return;
    }
    throw new CloudSyncSafetyError("其他设备正在连续修改，已暂停本次上传，请稍后重新同步。本机资料未被覆盖。");
  }

  return {
    sync(): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      if (running) { requested = true; return running; }
      running = (async () => {
        let passes = 0;
        do {
          requested = false;
          await pass();
          if (++passes >= 8 && requested) throw new CloudSyncSafetyError("资料仍在持续更新，已保留本机修改，请稍后重新同步。");
        } while (requested && !disposed);
        return !disposed;
      })().finally(() => { running = null; });
      return running;
    },
    dispose() { disposed = true; },
  };
}
