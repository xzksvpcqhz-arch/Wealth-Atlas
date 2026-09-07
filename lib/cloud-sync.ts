import { getSupabaseClient } from "./supabase-client";
import type { WealthData } from "./types";

export type CloudUser = { id: string; email: string | undefined };

export type PullResult = { data: WealthData; updatedAt: string };

export { mergeSnapshots } from "./cloud-merge";

export async function signUp(email: string, password: string): Promise<CloudUser> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("尚未配置云端（缺少 Supabase 环境变量）。");
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  if (!data.user) throw new Error("注册未返回用户，请重试。");
  // 若项目开启了「邮箱确认」，注册后不会立即建立会话；提示用户去邮箱确认。
  if (!data.session) {
    throw new Error("注册成功！请到邮箱点开确认链接，再回来点「登录」。");
  }
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

/** 发送密码重置邮件。网页版会带回跳地址；桌面版（file://）交给 Supabase 默认流程。 */
export async function resetPassword(email: string): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("尚未配置云端（缺少 Supabase 环境变量）。");
  const redirectTo = typeof window !== "undefined" && window.location.protocol.startsWith("http")
    ? window.location.origin
    : undefined;
  const { error } = await sb.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : {});
  if (error) throw error;
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
  const handle = (payload: { new?: { data?: WealthData } | null }) => {
    const next = payload.new?.data;
    if (next) onData(next);
  };
  const channel = sb
    .channel("user_data_changes")
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "user_data" }, handle)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "user_data" }, handle)
    .subscribe();
  return () => {
    void sb.removeChannel(channel);
  };
}
