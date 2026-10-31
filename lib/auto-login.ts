/** Local UI preference only. Never stores an identity, password or session token. */
export const AUTO_LOGIN_KEY = "wealth-atlas.auto-login.v1";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
export type AutoLoginPreference = { enabled: boolean; error: string | null };
const listeners = new Set<() => void>();
const readFailure = "无法读取本机自动登录设置，已暂停自动登录。请手动登录；财务资料不受影响。";

export function readAutoLoginPreference(storage?: PreferenceStorage): AutoLoginPreference {
  try {
    const raw = (storage ?? window.localStorage).getItem(AUTO_LOGIN_KEY);
    // Preserve the incumbent session-restoration behavior for existing installs.
    if (raw === null) return { enabled: true, error: null };
    if (raw.length > 128) return { enabled: false, error: readFailure };
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
      || typeof value.enabled !== "boolean" || Object.keys(value).length !== 2) {
      return { enabled: false, error: readFailure };
    }
    return { enabled: value.enabled, error: null };
  } catch { return { enabled: false, error: readFailure }; }
}

export function subscribeAutoLoginPreference(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Only an explicit switch action writes this one non-sensitive key. */
export function saveAutoLoginPreference(enabled: boolean, storage?: PreferenceStorage): AutoLoginPreference {
  let target: PreferenceStorage | undefined;
  try {
    target = storage ?? window.localStorage;
    if (typeof enabled !== "boolean") throw new Error("Invalid preference");
    const serialized = JSON.stringify({ version: 1, enabled });
    target.setItem(AUTO_LOGIN_KEY, serialized);
    if (target.getItem(AUTO_LOGIN_KEY) !== serialized) throw new Error("Preference not confirmed");
    for (const listener of listeners) { try { listener(); } catch { /* A view must not fail a confirmed preference write. */ } }
    return { enabled, error: null };
  } catch {
    // A partial write/readback failure is not a successful toggle. Never roll
    // back storage or touch the SDK's independent session key.
    return { ...readAutoLoginPreference(target), error: "自动登录设置未能确认保存，请重试。当前登录和财务资料未被更改。" };
  }
}
