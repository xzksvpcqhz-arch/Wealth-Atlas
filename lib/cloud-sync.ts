import { getSupabaseClient } from "./supabase-client";
import { createSnapshotTransport } from "./cloud-transport";
import { assertActiveDataProfile, getDataProfile } from "./data-profile";
import { clearPasswordRecovery, getPasswordRecoveryEpoch, getPasswordRecoveryOwner, isCurrentPasswordRecovery, isPasswordRecovery, resumeVerifiedPasswordRecovery } from "./password-recovery";
import { AuthVerificationError, authVerificationError, offlineSessionBinding, sessionBinding, verifiedRecoveryKey } from "./auth-session";
import { readStoredAuthSession } from "./auth-storage";
import { loadVerifiedAuthReceipt, saveVerifiedAuthReceipt } from "./storage";
import { reportAuthDiagnostic, type AuthDiagnosticCode } from "./auth-diagnostics";
export { isRetryableAuthError } from "./auth-session";

export type CloudUser = { id: string; email: string | undefined };
export type OfflineCloudUser = CloudUser & { localVerification: { verifiedAt: number; validUntil: number } };

async function authRead<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AuthVerificationError("transient")), 10000);
  })]); } finally { clearTimeout(timer!); }
}

async function verifiedSession() {
  const sb = getSupabaseClient();
  if (!sb) return null;
  const before = await authRead(sb.auth.getSession());
  if (before.error) throw authVerificationError(before.error);
  // getUser() with a missing session performs SDK cleanup/SIGNED_OUT. There is
  // no server identity to verify in this case; do not erase recovery context.
  if (!before.data.session) { reportAuthDiagnostic("ONLINE_SESSION_MISSING"); return null; }
  const verified = await authRead(sb.auth.getUser());
  if (verified.error) throw authVerificationError(verified.error);
  if (!verified.data.user) return null;
  const after = await authRead(sb.auth.getSession());
  const session = after.data.session;
  if (after.error || !session || !before.data.session || session.user.id !== verified.data.user.id
    || session.access_token !== before.data.session.access_token || session.refresh_token !== before.data.session.refresh_token) {
    throw new AuthVerificationError("changed");
  }
  return { user: { id: verified.data.user.id, email: verified.data.user.email }, session,
    binding: await sessionBinding(session), recoveryKey: await verifiedRecoveryKey(session) };
}

export function getCloudTransport(userId: string) {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("尚未配置云端（缺少 Supabase 环境变量）。");
  const scope = getDataProfile();
  if (scope.kind !== "cloud" || scope.ownerId !== userId) throw new Error("登录账号与本机工作区不一致，已停止同步。");
  const transport = createSnapshotTransport(sb, userId);
  return {
    pull() { assertActiveDataProfile(scope); return transport.pull(); },
    compareAndSet: (...args: Parameters<typeof transport.compareAndSet>) => { assertActiveDataProfile(scope); return transport.compareAndSet(...args); },
  };
}

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
  clearPasswordRecovery();
  return { id: data.user.id, email: data.user.email };
}

export async function signOut(): Promise<void> {
  const sb = getSupabaseClient();
  // This button signs out this session only. The SDK defaults to "global",
  // which would revoke the same user's other devices during an email-picker test.
  const result = await sb?.auth.signOut({ scope: "local" });
  if (result?.error) throw new Error("登出尚未确认，请检查网络后重试。");
}

/** 发送密码重置邮件。优先跳回当前网页地址；桌面版（file://）回退到 NEXT_PUBLIC_APP_URL。 */
export async function resetPassword(email: string): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("尚未配置云端（缺少 Supabase 环境变量）。");
  const redirectTo = typeof window !== "undefined" && window.location.protocol.startsWith("http")
    ? window.location.origin
    : process.env.NEXT_PUBLIC_APP_URL;
  const { error } = await sb.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : {});
  if (error) throw error;
}

/** Recovery survives SDK URL cleanup and account-workspace React remounts. */
export function isRecoveryLink(): boolean {
  return isPasswordRecovery();
}

/** Use the SDK-verified recovery session, never re-read/replay consumed tokens. */
export async function completePasswordReset(newPassword: string): Promise<void> {
  const sb = getSupabaseClient();
  if (!sb) throw new Error("尚未配置云端（缺少 Supabase 环境变量）。");
  const owner = getPasswordRecoveryOwner(), epoch = getPasswordRecoveryEpoch();
  if (!owner || !isCurrentPasswordRecovery(owner, epoch)) {
    throw new Error("恢复会话尚未就绪或已失效，请从最新的重置邮件链接重新进入。");
  }
  let verified: Awaited<ReturnType<typeof verifiedSession>>;
  try { verified = await verifiedSession(); } catch { verified = null; }
  if (verified?.user.id !== owner || !isCurrentPasswordRecovery(owner, epoch)) {
    throw new Error("恢复会话已变化或失效，未提交新密码，请使用最新的重置邮件链接。");
  }
  const { data, error } = await sb.auth.updateUser({ password: newPassword });
  if (error) {
    if (error.code === "same_password") throw new Error("新密码不能与旧密码相同，请设置不同的密码。");
    if (error.code === "weak_password") throw new Error("新密码未满足安全要求，请使用更长且包含字母、数字和符号的密码。");
    throw new Error("新密码保存尚未确认，请检查网络或重新打开最新的恢复链接后重试。财务资料未被更改。");
  }
  if (data.user?.id !== owner || !isCurrentPasswordRecovery(owner, epoch)) {
    throw new Error("恢复账号发生变化，无法确认本次操作，请重新验证登录状态。");
  }
  if (verified.binding && verified.recoveryKey) {
    try {
      await saveVerifiedAuthReceipt({ version: 1, ownerId: owner, binding: verified.binding,
        verifiedAt: Date.now(), completedRecovery: verified.recoveryKey });
    } catch {
      clearPasswordRecovery();
      const failure = new Error("新密码已保存，但本机完成状态未能确认。请重新登录；财务资料未被更改。");
      failure.name = "PasswordSavedLocalConfirmationError";
      throw failure;
    }
  }
  // Only a confirmed update ends recovery. Failures keep the existing form open.
  clearPasswordRecovery();
}

export async function getCurrentUser(): Promise<CloudUser | null> {
  reportAuthDiagnostic("ONLINE_CHECK_START");
  // Do not ask getUser() to refresh an expired session while physically offline.
  // An SDK "missing session" cleanup can otherwise emit SIGNED_OUT before our
  // boundary gets a chance to open the already-verified local workspace.
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new AuthVerificationError("transient");
  let result: Awaited<ReturnType<typeof verifiedSession>>;
  try { result = await verifiedSession(); }
  catch (error) {
    reportAuthDiagnostic(error instanceof AuthVerificationError && error.kind === "transient" ? "ONLINE_NETWORK_FAILURE"
      : error instanceof AuthVerificationError && error.kind === "changed" ? "ONLINE_SESSION_CHANGED" : "ONLINE_REJECTED");
    throw error;
  }
  if (!result) return null;
  reportAuthDiagnostic("ONLINE_VERIFIED");
  const previous = await loadVerifiedAuthReceipt(result.user.id).catch(() => { reportAuthDiagnostic("AUTH_RECEIPT_READ_FAILED"); return null; });
  if (result.binding) {
    // This receipt is not online authorization. It can only reopen the matching,
    // already-existing local workspace while server verification is unavailable.
    await saveVerifiedAuthReceipt({ version: 1, ownerId: result.user.id, binding: result.binding,
      verifiedAt: Date.now() }).then(() => reportAuthDiagnostic("AUTH_RECEIPT_SAVED"), () => reportAuthDiagnostic("AUTH_RECEIPT_SAVE_FAILED"));
  } else reportAuthDiagnostic("AUTH_BINDING_UNAVAILABLE");
  if (result.recoveryKey) {
    if (previous?.completedRecovery === result.recoveryKey) clearPasswordRecovery();
    else resumeVerifiedPasswordRecovery(result.user.id);
  }
  return result.user;
}

export async function getOfflineUser(): Promise<OfflineCloudUser | null> {
  try {
    // getSession() is NOT a read-only cache getter: it may refresh over the
    // network. Read the SDK's existing storage directly without changing it.
    const session = readStoredAuthSession(process.env.NEXT_PUBLIC_SUPABASE_URL, undefined, (reason) => reportAuthDiagnostic({
      "config-missing": "OFFLINE_CONFIG_MISSING", "cache-missing": "OFFLINE_CACHE_MISSING",
      "cache-invalid": "OFFLINE_CACHE_INVALID", "storage-unavailable": "OFFLINE_STORAGE_UNAVAILABLE",
    }[reason] as AuthDiagnosticCode));
    if (!session) return null;
    const receipt = await loadVerifiedAuthReceipt(session.user.id, true, (reason) => reportAuthDiagnostic({
      "db-unavailable": "OFFLINE_DB_UNAVAILABLE", "receipt-missing": "OFFLINE_RECEIPT_MISSING", "receipt-invalid": "OFFLINE_RECEIPT_INVALID",
      "workspace-missing": "OFFLINE_WORKSPACE_MISSING", "workspace-invalid": "OFFLINE_WORKSPACE_INVALID",
    }[reason] as AuthDiagnosticCode));
    if (!receipt || !await offlineSessionBinding(session, receipt, (reason) => reportAuthDiagnostic({
      "receipt-invalid": "OFFLINE_RECEIPT_INVALID", "owner-mismatch": "OFFLINE_OWNER_MISMATCH", "cache-invalid": "OFFLINE_CACHE_INVALID",
      "clock-future": "OFFLINE_CLOCK_FUTURE", "receipt-expired": "OFFLINE_RECEIPT_EXPIRED", "claims-invalid": "OFFLINE_CLAIMS_INVALID",
      "verification-after-expiry": "OFFLINE_VERIFICATION_AFTER_EXPIRY", "digest-unavailable": "OFFLINE_DIGEST_UNAVAILABLE", "binding-mismatch": "OFFLINE_BINDING_MISMATCH",
    }[reason] as AuthDiagnosticCode))) return null;
    reportAuthDiagnostic("OFFLINE_PROOF_ACCEPTED");
    return { id: session.user.id, email: session.user.email,
      localVerification: { verifiedAt: receipt.verifiedAt, validUntil: receipt.verifiedAt + 86400000 } };
  } catch { reportAuthDiagnostic("OFFLINE_READ_FAILED"); return null; }
}

export function subscribeToAuth(onChange: (user: CloudUser | null, event?: string) => void): () => void {
  let stopped = false, unsubscribe: (() => void) | null = null;
  const attach = () => {
    if (stopped || unsubscribe) return;
    // Offline cache verification must happen BEFORE constructing the SDK, whose
    // constructor otherwise eagerly refreshes/mutates the persisted session.
    if (typeof navigator !== "undefined" && navigator.onLine === false) { reportAuthDiagnostic("AUTH_SDK_DEFERRED_OFFLINE"); return; }
    const sb = getSupabaseClient();
    if (!sb) return;
    const { data } = sb.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") reportAuthDiagnostic("AUTH_EVENT_SIGNED_OUT");
      onChange(session?.user ? { id: session.user.id, email: session.user.email } : null, event);
    });
    unsubscribe = () => data.subscription.unsubscribe();
    reportAuthDiagnostic("AUTH_SDK_ATTACHED");
  };
  attach();
  if (typeof window !== "undefined") window.addEventListener?.("online", attach);
  return () => { stopped = true; unsubscribe?.(); if (typeof window !== "undefined") window.removeEventListener?.("online", attach); };
}

/**
 * Realtime is a hint only: always re-pull through the guarded sync path.
 * Never apply an out-of-order event payload as the latest snapshot.
 */
export function subscribeToRemote(userId: string, onChange: () => void): () => void {
  const sb = getSupabaseClient();
  if (!sb) return () => undefined;
  const channel = sb
    .channel(`user_data_changes:${userId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "user_data", filter: `user_id=eq.${userId}` }, onChange)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "user_data", filter: `user_id=eq.${userId}` }, onChange)
    .subscribe();
  return () => {
    void sb.removeChannel(channel);
  };
}
