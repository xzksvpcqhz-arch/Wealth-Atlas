/** Email-only UI preferences. Never an authentication or workspace identity source. */
export const LOGIN_HISTORY_KEY = "wealth-atlas.login-history.v1";
export const MAX_LOGIN_HISTORY = 8;
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
export type LoginHistory = { emails: string[]; error: string | null };
const listeners = new Set<() => void>();
let notice: string | null = null;

export function normalizeLoginEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

export function parseLoginHistory(raw: string | null): string[] | null {
  if (raw === null) return [];
  if (raw.length > 4096) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || Object.keys(value).some((key) => !["version", "emails"].includes(key))
      || !Array.isArray(value.emails) || value.emails.length > MAX_LOGIN_HISTORY) return null;
    const emails = value.emails.map(normalizeLoginEmail);
    if (emails.some((email: string | null) => email === null)) return null;
    return [...new Set<string>(emails)];
  } catch { return null; }
}

function browserStorage(): PreferenceStorage {
  return window.localStorage; // Access itself may throw; every caller catches it.
}
export function readLoginHistory(storage?: PreferenceStorage): LoginHistory {
  try {
    const emails = parseLoginHistory((storage ?? browserStorage()).getItem(LOGIN_HISTORY_KEY));
    return emails === null
      ? { emails: [], error: "本机账号记忆格式无法读取，未覆盖原记录。请手动输入邮箱登录。" }
      : { emails, error: null };
  } catch {
    return { emails: [], error: "本机账号记忆暂不可用，请手动输入邮箱登录。财务资料不受影响。" };
  }
}
export const getLoginHistoryNotice = () => notice;
export function subscribeLoginHistory(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function announce(message: string) {
  notice = message;
  listeners.forEach((listener) => { try { listener(); } catch { /* Preferences must not fail authentication. */ } });
}
function writeHistory(emails: string[], storage: PreferenceStorage) {
  storage.setItem(LOGIN_HISTORY_KEY, JSON.stringify({ version: 1, emails }));
}

/** Called ONLY after server-verified sign-in and successful workspace activation. */
export function rememberLoginEmail(email: unknown, storage?: PreferenceStorage): boolean {
  const normalized = normalizeLoginEmail(email);
  if (!normalized) return false;
  try {
    const target = storage ?? browserStorage(), current = readLoginHistory(target);
    if (current.error) throw new Error("Unreadable preference");
    writeHistory([normalized, ...current.emails.filter((item) => item !== normalized)].slice(0, MAX_LOGIN_HISTORY), target);
    announce("已记住本机账号（仅邮箱）");
    return true;
  } catch {
    announce("登录已成功，但本机邮箱记忆未能保存。下次请手动输入邮箱；财务资料不受影响。");
    return false;
  }
}

export function forgetLoginEmail(email: string, storage?: PreferenceStorage): boolean {
  const normalized = normalizeLoginEmail(email);
  if (!normalized) return false;
  try {
    const target = storage ?? browserStorage(), current = readLoginHistory(target);
    if (current.error) throw new Error("Unreadable preference");
    writeHistory(current.emails.filter((item) => item !== normalized), target);
    announce("已移除此邮箱记忆；账号与财务资料未更改。");
    return true;
  } catch {
    announce("无法移除此邮箱记忆，原记录已保留。请稍后重试。");
    return false;
  }
}
