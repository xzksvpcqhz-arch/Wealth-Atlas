import { getDesktopBridge } from "./desktop";
import { getWealthDataSchemaVersion } from "./migrations";
import { OBSIDIAN_ROOT, restoreVaultHandle } from "./obsidian";
import { loadObsidianHandle } from "./storage";
import type { WealthData } from "./types";

export const SNAPSHOT_FORMAT = "wealth-atlas-snapshot";
export const SNAPSHOT_VERSION = 1;
export const OBSIDIAN_SNAPSHOT_DIR = ".wealth-atlas";
export const OBSIDIAN_SNAPSHOT_FILENAME = "snapshot.json";

export type SnapshotEnvelope = {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  exportedAt: string;
  schemaVersion: number;
  data: WealthData;
};

export function buildSnapshotEnvelope(data: WealthData): SnapshotEnvelope {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    schemaVersion: getWealthDataSchemaVersion(data),
    data,
  };
}

export function serializeSnapshot(data: WealthData): string {
  return JSON.stringify(buildSnapshotEnvelope(data), null, 2);
}

/**
 * 解析快照内容。兼容两种形态：
 * 1. 带封装的快照 { format: "wealth-atlas-snapshot", data: WealthData }
 * 2. 直接的 WealthData 对象（含 accounts 数组与 reportCurrency）
 */
export function parseSnapshot(input: unknown): WealthData {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  let candidate: Record<string, unknown> | null = null;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.format === SNAPSHOT_FORMAT && obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
      candidate = obj.data as Record<string, unknown>;
    } else {
      candidate = obj;
    }
  }
  if (candidate && Array.isArray(candidate.accounts) && typeof candidate.reportCurrency === "string") {
    return candidate as unknown as WealthData;
  }
  throw new Error("不是有效的 Wealth Atlas 快照文件。");
}

/** 桌面端：把当前全量数据写入 %APPDATA%\Wealth Atlas\autosaves\（主进程负责滚动保留 10 份）。 */
export function autosaveLocalSnapshot(data: WealthData): Promise<unknown> {
  const bridge = getDesktopBridge();
  if (!bridge) return Promise.resolve(null);
  return bridge.writeAutosave({ snapshot: data, schemaVersion: getWealthDataSchemaVersion(data) });
}

/**
 * 把全量快照写入已连接的 Obsidian Vault（财富理财师/.wealth-atlas/snapshot.json）。
 * 尽力而为：vault 未连接或写入失败时静默跳过，绝不打断正常使用。
 */
export async function writeObsidianSnapshot(data: WealthData): Promise<void> {
  try {
    const stored = await loadObsidianHandle();
    if (!stored) return;
    const handle = await restoreVaultHandle(stored.handle, stored.vaultName);
    const root = await handle.getDirectoryHandle(OBSIDIAN_ROOT, { create: true });
    const directory = await root.getDirectoryHandle(OBSIDIAN_SNAPSHOT_DIR, { create: true });
    const file = await directory.getFileHandle(OBSIDIAN_SNAPSHOT_FILENAME, { create: true });
    const writable = await file.createWritable();
    await writable.write(serializeSnapshot(data));
    await writable.close();
  } catch {
    // Obsidian 快照是尽力而为的异地兜底，失败不影响本地数据。
  }
}
