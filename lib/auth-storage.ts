import type { AuthSession } from "./auth-session";

export type AuthStorageFailure = "AUTH_STORAGE_READ_FAILED" | "AUTH_STORAGE_WRITE_FAILED"
  | "AUTH_STORAGE_WRITE_UNCONFIRMED" | "AUTH_STORAGE_REMOVE_FAILED";
type AuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type AuthStorageActivity = "AUTH_STORAGE_FIRST_READ_EMPTY" | "AUTH_STORAGE_FIRST_READ_PRESENT"
  | "AUTH_STORAGE_WRITE_CONFIRMED" | "AUTH_STORAGE_REMOVE_REQUESTED" | "AUTH_STORAGE_REMOVE_CONFIRMED";

export class AuthStorageError extends Error {
  constructor(public readonly code: AuthStorageFailure) {
    super("无法确认本机登录状态存储，请稍后重试。");
    this.name = "AuthStorageError";
  }
}

/** Use the SDK's existing key and browser store, never its silent memory fallback.
 * Resolve lazily so a temporary storage failure can recover on an explicit retry.
 * A failed confirmation NEVER rolls back: another session may now own the key. */
export function createAuthStorage(storage?: AuthStorage, onFailure?: (code: AuthStorageFailure) => void,
  onActivity?: (code: AuthStorageActivity) => void): AuthStorage {
  let firstSessionRead = false;
  const sessionKey = (key: string) => typeof key === "string" && /^sb-[A-Za-z0-9_-]+-auth-token$/.test(key);
  const activity = (key: string, code: AuthStorageActivity) => {
    if (!sessionKey(key)) return;
    try { onActivity?.(code); } catch { /* Observation can never change SDK storage behavior. */ }
  };
  const fail = (code: AuthStorageFailure): never => {
    try { onFailure?.(code); } catch { /* Diagnostics cannot expose provider errors. */ }
    throw new AuthStorageError(code);
  };
  return {
    getItem(key) {
      try {
        const value = (storage ?? window.localStorage).getItem(key);
        if (!firstSessionRead && sessionKey(key)) {
          firstSessionRead = true;
          activity(key, value === null ? "AUTH_STORAGE_FIRST_READ_EMPTY" : "AUTH_STORAGE_FIRST_READ_PRESENT");
        }
        return value;
      }
      catch { return fail("AUTH_STORAGE_READ_FAILED"); }
    },
    setItem(key, value) {
      try {
        const target = storage ?? window.localStorage;
        target.setItem(key, value);
        if (target.getItem(key) === value) { activity(key, "AUTH_STORAGE_WRITE_CONFIRMED"); return; }
      } catch { return fail("AUTH_STORAGE_WRITE_FAILED"); }
      fail("AUTH_STORAGE_WRITE_UNCONFIRMED");
    },
    removeItem(key) {
      try {
        activity(key, "AUTH_STORAGE_REMOVE_REQUESTED");
        const target = storage ?? window.localStorage;
        target.removeItem(key);
        if (target.getItem(key) === null) { activity(key, "AUTH_STORAGE_REMOVE_CONFIRMED"); return; }
      } catch { return fail("AUTH_STORAGE_REMOVE_FAILED"); }
      fail("AUTH_STORAGE_REMOVE_FAILED");
    },
  };
}

/** Same key as supabase-js's default. This is a read-only view of its existing
 * browser storage, not a second token store or a financial-data migration. */
export type AuthCacheFailure = "config-missing" | "cache-missing" | "cache-invalid" | "storage-unavailable";
export function readStoredAuthSession(url: string | undefined, storage?: Pick<Storage, "getItem">,
  onFailure?: (reason: AuthCacheFailure) => void): AuthSession | null {
  if (!url) { onFailure?.("config-missing"); return null; }
  try {
    const key = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
    const raw = (storage ?? window.localStorage).getItem(key);
    if (!raw) { onFailure?.("cache-missing"); return null; }
    let session: AuthSession;
    try { session = JSON.parse(raw) as AuthSession; }
    catch { onFailure?.("cache-invalid"); return null; }
    if (!session || typeof session !== "object" || Array.isArray(session)
      || !session.user || !/^[A-Za-z0-9_-]{1,128}$/.test(session.user.id)
      || typeof session.access_token !== "string" || !session.access_token
      || typeof session.refresh_token !== "string" || !session.refresh_token) { onFailure?.("cache-invalid"); return null; }
    return session;
  } catch { onFailure?.("storage-unavailable"); return null; }
}
