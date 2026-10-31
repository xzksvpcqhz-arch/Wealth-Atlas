import { buildAssetMarkdown, buildDailyMarkdown, buildMonthlyMarkdown, buildYearlyMarkdown, getDefaultObsidianTemplates } from "./exporters";
import { getDesktopBridge } from "./desktop";
import type { WealthData } from "./types";
import { assertActiveDataProfile, getDataProfile, getObjectProfile, tagProfileObject } from "./data-profile";

export const OBSIDIAN_ROOT = "财富理财师";
export const OBSIDIAN_FOLDERS = [
  "00-总览",
  "01-每日",
  "02-每月",
  "03-每年",
  "04-储蓄目标",
  "05-资产负债",
  "06-物品资产",
  "07-订阅与年度支出",
  "08-复盘记录",
  "99-模板",
] as const;

export type VaultFileHandle = {
  getFile: () => Promise<{ text: () => Promise<string> }>;
  createWritable: () => Promise<{ write: (content: string) => Promise<void>; close: () => Promise<void> }>;
};

export type VaultDirectoryHandle = {
  name: string;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<VaultDirectoryHandle>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<VaultFileHandle>;
  queryPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<"granted" | "prompt" | "denied">;
  requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<"granted" | "prompt" | "denied">;
};

export type SyncFileKind = "daily" | "monthly" | "yearly" | "asset";
export type SyncFileStatus = "new" | "update" | "unchanged" | "conflict";

export type SyncFilePlan = {
  kind: SyncFileKind;
  path: string;
  label: string;
  status: SyncFileStatus;
  summary: string;
  content: string;
  existingContent?: string;
  assetId?: string;
};

export type SyncResult = {
  fileCount: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  errorReason?: string;
};

function joinVaultPath(base: string, name: string) {
  return [base, name].filter(Boolean).join("/");
}

function createDesktopDirectoryHandle(name: string, relativePath = ""): VaultDirectoryHandle {
  const scope = getDataProfile();
  const bridge = getDesktopBridge();
  if (!bridge) throw new Error("桌面文件夹桥接不可用，请改用 ZIP 下载。");
  return {
    name,
    async getDirectoryHandle(childName, options) {
      const childPath = joinVaultPath(relativePath, childName);
      await bridge.ensureDirectory(childPath, options?.create === true);
      assertActiveDataProfile(scope);
      return createDesktopDirectoryHandle(childName, childPath);
    },
    async getFileHandle(filename, options) {
      const filePath = joinVaultPath(relativePath, filename);
      await bridge.ensureFile(filePath, options?.create === true);
      return {
        getFile: async () => ({ text: () => bridge.readFile(filePath) }),
        createWritable: async () => {
          let pendingContent = "";
          return {
            write: async (content: string) => { pendingContent = content; },
            close: async () => { await bridge.writeFile(filePath, pendingContent); },
          };
        },
      };
    },
    queryPermission: async () => (await bridge.getVaultConnection()).connected ? "granted" : "denied",
    requestPermission: async () => (await bridge.getVaultConnection()).connected ? "granted" : "denied",
  };
}

export async function restoreVaultHandle(handle: unknown, vaultName: string) {
  const scope = getDataProfile();
  assertActiveDataProfile(scope);
  if (handle && typeof handle === "object" && getObjectProfile(handle) && getObjectProfile(handle) !== scope) throw new Error("Vault 连接不属于当前账号，请重新连接。");
  const bridge = getDesktopBridge();
  if (!bridge) return tagProfileObject(handle as VaultDirectoryHandle, scope);
  const connection = await bridge.getVaultConnection();
  assertActiveDataProfile(scope);
  if (!connection.connected) throw new Error("上次选择的 Vault 已断开，请重新选择本地 Vault。");
  return tagProfileObject(createDesktopDirectoryHandle(connection.name || vaultName), scope);
}

const templateFiles = {
  daily: "每日模板.md",
  monthly: "每月模板.md",
  yearly: "每年模板.md",
  goal: "储蓄目标模板.md",
  asset: "资产模板.md",
  review: "财务复盘模板.md",
} as const;

export function getDirectoryPicker() {
  if (typeof window === "undefined") return null;
  const bridge = getDesktopBridge();
  const scope = getDataProfile();
  if (bridge) {
    return async () => {
      const selected = await bridge.selectVault();
      assertActiveDataProfile(scope);
      if (!selected?.connected) throw new Error("已取消选择 Vault，未读取或写入任何文件。");
      return tagProfileObject(createDesktopDirectoryHandle(selected.name), scope);
    };
  }
  const picker = (window as Window & { showDirectoryPicker?: () => Promise<VaultDirectoryHandle> }).showDirectoryPicker;
  return picker ? async () => {
    const handle = await picker.call(window);
    assertActiveDataProfile(scope);
    return tagProfileObject(handle, scope);
  } : null;
}

export async function requestVaultPermission(handle: VaultDirectoryHandle) {
  const query = await handle.queryPermission?.({ mode: "readwrite" });
  if (query === "granted") return true;
  const requested = await handle.requestPermission?.({ mode: "readwrite" });
  if (requested !== "granted") throw new Error("Vault 文件夹写入权限未获授权，请重新连接或改用 ZIP 下载。");
  return true;
}

async function getNestedDirectory(root: VaultDirectoryHandle, segments: string[], create = false) {
  let current = root;
  for (const segment of segments.filter(Boolean)) current = await current.getDirectoryHandle(segment, { create });
  return current;
}

async function writeTextFile(directory: VaultDirectoryHandle, filename: string, content: string) {
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function ensureVaultFolders(vault: VaultDirectoryHandle, templates?: WealthData["obsidianTemplates"]) {
  const root = await vault.getDirectoryHandle(OBSIDIAN_ROOT, { create: true });
  for (const folder of OBSIDIAN_FOLDERS) await root.getDirectoryHandle(folder, { create: true });
  const defaults = getDefaultObsidianTemplates();
  const selectedTemplates = { ...defaults, ...templates };
  const templateDirectory = await root.getDirectoryHandle("99-模板", { create: true });
  for (const [key, filename] of Object.entries(templateFiles)) {
    try {
      await templateDirectory.getFileHandle(filename);
    } catch {
      await writeTextFile(templateDirectory, filename, selectedTemplates[key as keyof typeof templateFiles]);
    }
  }
  return root;
}

async function readTextFile(vault: VaultDirectoryHandle, relativePath: string) {
  const segments = relativePath.split("/");
  const filename = segments.pop();
  if (!filename) return null;
  try {
    const root = await vault.getDirectoryHandle(OBSIDIAN_ROOT);
    const directory = await getNestedDirectory(root, segments);
    const file = await directory.getFileHandle(filename);
    return await (await file.getFile()).text();
  } catch (error) {
    const code = error instanceof DOMException ? error.name : "";
    if (code === "NotFoundError" || error instanceof Error && /not found|不存在/i.test(error.message)) return null;
    throw error;
  }
}

export const AUTO_START = "<!-- WEALTH_ATLAS_AUTO_START -->";
export const AUTO_END = "<!-- WEALTH_ATLAS_AUTO_END -->";

export function hasAutoRegion(content: string) {
  return content.includes(AUTO_START) && content.includes(AUTO_END) && content.indexOf(AUTO_START) < content.indexOf(AUTO_END);
}

function autoRegion(content: string) {
  const start = content.indexOf(AUTO_START);
  const end = content.indexOf(AUTO_END);
  return start >= 0 && end > start ? content.slice(start, end + AUTO_END.length) : "";
}

export function mergeAutoRegion(existing: string, generated: string) {
  if (!hasAutoRegion(existing)) return null;
  const generatedRegion = autoRegion(generated);
  return existing.slice(0, existing.indexOf(AUTO_START)) + generatedRegion + existing.slice(existing.indexOf(AUTO_END) + AUTO_END.length);
}

function generatedFile(kind: SyncFileKind, data: WealthData, date: string, assetId?: string) {
  const month = date.slice(0, 7);
  const year = Number(date.slice(0, 4));
  if (kind === "daily") return buildDailyMarkdown(data, date);
  if (kind === "monthly") return buildMonthlyMarkdown(data, month);
  if (kind === "asset") return assetId ? buildAssetMarkdown(data, assetId) : "";
  return buildYearlyMarkdown(data, year);
}

function planPath(kind: SyncFileKind, date: string, assetId?: string) {
  const year = date.slice(0, 4);
  if (kind === "daily") return `01-每日/${year}/${date}.md`;
  if (kind === "monthly") return `02-每月/${year}/${date.slice(0, 7)}.md`;
  if (kind === "asset") return `06-物品资产/${assetId ?? "asset"}.md`;
  return `03-每年/${year}.md`;
}

export async function buildSyncPlan(vault: VaultDirectoryHandle, data: WealthData, date = new Date().toISOString().slice(0, 10)): Promise<SyncFilePlan[]> {
  const files: Array<{ kind: SyncFileKind; label: string; assetId?: string }> = [
    { kind: "daily", label: "每日笔记" },
    { kind: "monthly", label: "每月笔记" },
    { kind: "yearly", label: "每年笔记" },
  ];
  data.assets.forEach((asset) => files.push({ kind: "asset", label: `物品资产：${asset.name}`, assetId: asset.id }));
  const plans: SyncFilePlan[] = [];
  for (const file of files) {
    const assetId = file.assetId;
    const path = planPath(file.kind, date, assetId);
    const content = generatedFile(file.kind, data, date, assetId);
    const existingContent = await readTextFile(vault, path);
    if (existingContent === null) {
      plans.push({ kind: file.kind, path, label: file.label, assetId, status: "new", summary: "将创建新的 Markdown 文件", content });
      continue;
    }
    if (!hasAutoRegion(existingContent)) {
      plans.push({ kind: file.kind, path, label: file.label, assetId, status: "conflict", summary: "文件没有自动区域，已保护并跳过写入", content, existingContent });
      continue;
    }
    const merged = mergeAutoRegion(existingContent, content) ?? existingContent;
    plans.push({ kind: file.kind, path, label: file.label, assetId, status: merged === existingContent ? "unchanged" : "update", summary: merged === existingContent ? "自动内容没有变化" : "只更新自动区域，保留手写内容", content: merged, existingContent });
  }
  return plans;
}

function timestampForPath(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export async function writeSyncPlan(vault: VaultDirectoryHandle, plans: SyncFilePlan[], systemVersion: string): Promise<SyncResult> {
  const result: SyncResult = { fileCount: plans.length, added: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  try {
    const root = await vault.getDirectoryHandle(OBSIDIAN_ROOT, { create: true });
    const backupRoot = await getNestedDirectory(root, ["backups", "obsidian", timestampForPath()], true);
    const changed = plans.filter((plan) => plan.status === "update" && plan.existingContent !== undefined);
    for (const plan of changed) {
      const backupDirectory = await getNestedDirectory(backupRoot, plan.path.split("/").slice(0, -1), true);
      await writeTextFile(backupDirectory, plan.path.split("/").at(-1) ?? "backup.md", plan.existingContent ?? "");
    }
    await writeTextFile(backupRoot, "sync-manifest.json", JSON.stringify({ syncedAt: new Date().toISOString(), systemVersion, files: plans.map(({ path, status, summary }) => ({ path, status, summary })) }, null, 2));
    await writeTextFile(backupRoot, "sync-time.txt", new Date().toISOString());
    await writeTextFile(backupRoot, "system-version.txt", systemVersion);
  } catch (error) {
    result.errorReason = error instanceof Error ? error.message : "备份文件夹创建失败";
    result.failed = plans.filter((plan) => plan.status === "update").length;
    return result;
  }

  for (const plan of plans) {
    if (plan.status === "unchanged") { result.unchanged += 1; continue; }
    if (plan.status === "conflict") { result.skipped += 1; continue; }
    try {
      const segments = plan.path.split("/");
      const filename = segments.pop() ?? "note.md";
      const root = await vault.getDirectoryHandle(OBSIDIAN_ROOT, { create: true });
      const directory = await getNestedDirectory(root, segments, true);
      await writeTextFile(directory, filename, plan.content);
      if (plan.status === "new") result.added += 1;
      if (plan.status === "update") result.updated += 1;
    } catch (error) {
      result.failed += 1;
      result.errorReason = error instanceof Error ? error.message : "Markdown 写入失败";
    }
  }
  return result;
}
