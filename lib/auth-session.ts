/** Technical authentication metadata only; never persist a password or token. */
export type AuthSession = {
  access_token: string; refresh_token: string; expires_at?: number;
  user: { id: string; email?: string };
};
export type VerifiedAuthReceipt = {
  version: 1; ownerId: string; binding: string; verifiedAt: number;
  completedRecovery?: string;
};
export class AuthVerificationError extends Error {
  constructor(public readonly kind: "transient" | "invalid" | "changed") {
    super(kind === "transient" ? "暂时无法在线验证登录状态，原资料已保留。" : "登录状态需要重新验证，原资料已保留。");
    this.name = "AuthVerificationError";
  }
}
export function authVerificationError(error: unknown) {
  const item = error as { name?: string; status?: number } | null;
  return new AuthVerificationError(item?.name === "AuthRetryableFetchError" || item?.name === "TypeError"
    || item?.status === 0 || item?.status === 408 || item?.status === 429 || Number(item?.status) >= 500 ? "transient" : "invalid");
}
export function isRetryableAuthError(error: unknown) {
  return error instanceof AuthVerificationError && error.kind === "transient";
}
function claims(session: AuthSession, allowExpired = false) {
  try {
    const encoded = session.access_token.split(".")[1];
    const decoded = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))) as {
      sub?: string; exp?: number; session_id?: string; amr?: { method?: string; timestamp?: number }[];
    };
    if (decoded.sub !== session.user.id || !Number.isFinite(decoded.exp)
      || !allowExpired && Number(decoded.exp) * 1000 <= Date.now()) return null;
    return decoded;
  } catch { return null; }
}
async function digest(value: unknown) {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function sessionBinding(session: AuthSession | null) {
  if (!session?.user?.id || !session.access_token || !session.refresh_token || !claims(session)) return null;
  return digest([session.user.id, session.access_token, session.refresh_token]);
}
/** Expiry stops server authorization, not access to the exact previously verified
 * local workspace. This proof is bounded by the existing 24-hour receipt and is
 * NEVER used for uploads, password changes, a new workspace, or a missing token. */
export type OfflineProofFailure = "receipt-invalid" | "owner-mismatch" | "cache-invalid" | "clock-future" | "receipt-expired"
  | "claims-invalid" | "verification-after-expiry" | "digest-unavailable" | "binding-mismatch";
export async function offlineSessionBinding(session: AuthSession, receipt: VerifiedAuthReceipt, onFailure?: (reason: OfflineProofFailure) => void) {
  const fail = (reason: OfflineProofFailure) => { onFailure?.(reason); return null; };
  if (!validAuthReceipt(receipt)) return fail("receipt-invalid");
  if (receipt.ownerId !== session.user?.id) return fail("owner-mismatch");
  if (!session.access_token || !session.refresh_token) return fail("cache-invalid");
  if (receipt.verifiedAt > Date.now()) return fail("clock-future");
  if (Date.now() - receipt.verifiedAt > 86400000) return fail("receipt-expired");
  const token = claims(session, true);
  if (!token) return fail("claims-invalid");
  if (Number(token.exp) * 1000 <= receipt.verifiedAt) return fail("verification-after-expiry");
  const binding = await digest([session.user.id, session.access_token, session.refresh_token]);
  if (!binding) return fail("digest-unavailable");
  return binding === receipt.binding ? binding : fail("binding-mismatch");
}
/** Call only for the exact session just verified by the Auth server. */
export async function verifiedRecoveryKey(session: AuthSession) {
  const token = claims(session);
  if (!token?.session_id || !Array.isArray(token.amr)) return null;
  const recovery = Math.max(0, ...token.amr.filter((method) => method && method.method === "recovery" && Number.isFinite(method.timestamp)).map((method) => Number(method.timestamp)));
  const password = Math.max(0, ...token.amr.filter((method) => method && method.method === "password" && Number.isFinite(method.timestamp)).map((method) => Number(method.timestamp)));
  if (!recovery || password >= recovery || recovery * 1000 > Date.now() + 300000 || Date.now() - recovery * 1000 > 3600000) return null;
  return digest([session.user.id, token.session_id, recovery]);
}
export function validAuthReceipt(value: unknown): value is VerifiedAuthReceipt {
  const row = value as VerifiedAuthReceipt | null;
  return Boolean(row && row.version === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(row.ownerId)
    && /^[a-f0-9]{64}$/.test(row.binding) && Number.isSafeInteger(row.verifiedAt) && row.verifiedAt > 0
    && (row.completedRecovery === undefined || /^[a-f0-9]{64}$/.test(row.completedRecovery)));
}
