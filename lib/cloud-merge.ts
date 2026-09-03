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

/** 记录的唯一键：有字符串 id 用 id；否则用整条内容的 JSON（保证去重不崩）。 */
export function keyOf(item: unknown): string {
  if (item && typeof item === "object" && "id" in item && typeof (item as { id: unknown }).id === "string") {
    return (item as { id: string }).id;
  }
  return JSON.stringify(item);
}

export function mergeById<T>(local: T[], remote: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of local) map.set(keyOf(item), item);
  for (const item of remote) map.set(keyOf(item), item); // 冲突以云端为准
  return Array.from(map.values());
}

/**
 * 合并本地快照与云端快照：
 * - 数组字段按 id 去重合并（同 id 冲突以云端为准，不丢本地独有记录）
 * - 标量字段（reportCurrency / schemaVersion / 各设置）以云端为准
 * 说明：这是"以云端为准、按 id 合并不丢记录"的简单策略，适合个人多设备同步。
 */
export function mergeSnapshots(local: WealthData, remote: WealthData): WealthData {
  const merged: WealthData = { ...local, ...remote };
  for (const field of ARRAY_FIELDS) {
    const localArr = (local as unknown as Record<string, unknown[] | undefined>)[field] ?? [];
    const remoteArr = (remote as unknown as Record<string, unknown[] | undefined>)[field] ?? [];
    (merged as unknown as Record<string, unknown>)[field] = mergeById(localArr, remoteArr);
  }
  return merged;
}
