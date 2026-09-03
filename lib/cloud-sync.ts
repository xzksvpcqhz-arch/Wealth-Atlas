import { getSupabaseClient } from "./supabase-client";
import type { WealthData } from "./types";

export type CloudUser = { id: string; email: string | undefined };

export type PullResult = { data: WealthData; updatedAt: string };

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

function keyOf(item: unknown): string {
  if (item && typeof item === "object" && "id" in item && typeof (item as { id: unknown }).id === "string") {
    return (item as { id: string }).id;
  }
  return JSON.stringify(item);
}

function mergeById<T>(local: T[], remote: T[]): T[] {
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
    const localArr = (local as unknown as Record<string, { id: string }[] | undefined>)[field] ?? [];
    const remoteArr = (remote as unknown as Record<string, { id: string }[] | undefined>)[field] ?? [];
    (merged as unknown as Record<string, unknown>)[field] = mergeById(localArr, remoteArr);
  }
  return merged;
}

export async function signUp(email: string, password: string): Promise<CloudUser> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("尚未配置云端（缺少 Supabase 环境变量）。");
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  if (!data.user) throw new Error("注册未返回用户，请重试。");
  return { id: data.user.id, email: data.user.email };
}

export async function signIn(email: string, password: string): Promise<CloudUser> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("尚未配置云端（缺少 Supabase 环境变量）。");
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.user) throw new Error("登录未返回用户，请重试。");
  return { id: data.user.id, email: data.user.email };
}

export async function signOut(): Promise<void> {
  const sb = getSupabaseClient();
  await sb?.auth.signOut();
}

export async function getCurrentUser(): Promise<CloudUser | null> {
  const sb = getSupabaseClient();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data.user ? { id: data.user.id, email: data.user.email } : null;
}

/** 拉取当前登录用户的云端快照；没有则返回 null。 */
export async function pullSnapshot(): Promise<PullResult | null> {
  const sb = getSupabaseClient();
  if (!sb) return null;
  const { data, error } = await sb.from("user_data").select("data, updated_at").maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { data: data.data as WealthData, updatedAt: data.updated_at as string };
}

/** 把本地完整快照推送到云端（upsert 当前用户那一行）。 */
export async function pushSnapshot(data: WealthData): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) return;
  const { error } = await sb.from("user_data").upsert({ data }, { onConflict: "user_id" });
  if (error) throw error;
}

/**
 * 订阅云端当前用户数据的实时变化。
 * 返回一个取消订阅的函数。变化时把最新的快照回传给 onData。
 */
export function subscribeToRemote(onData: (data: WealthData) => void): () => void {
  const sb = getSupabaseClient();
  if (!sb) return () => undefined;
  const channel = sb
    .channel("user_data_changes")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "user_data" },
      (payload) => {
        const next = (payload.new as { data?: WealthData } | undefined)?.data;
        if (next) onData(next);
      },
    )
    .subscribe();
  return () => {
    void sb.removeChannel(channel);
  };
}
