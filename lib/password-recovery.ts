// Recovery intent is UI state, not authorization. Only a trusted SDK recovery
// event binds an owner. No password, URL token or financial data is retained.
let pending = false;
let owner: string | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
const intentKey = "wealth-atlas.password-recovery-intent.v1";
function persistIntent(pending: boolean) {
  try {
    if (pending) window.sessionStorage.setItem(intentKey, JSON.stringify({ version: 1, expiresAt: Date.now() + 3600000 }));
    else window.sessionStorage.removeItem(intentKey);
  } catch { /* The verified server session remains the authority, not storage. */ }
}
function hasStoredIntent() {
  try { const marker = JSON.parse(window.sessionStorage.getItem(intentKey) ?? "null"); return marker?.version === 1 && marker.expiresAt > Date.now() && marker.expiresAt <= Date.now() + 3600000; }
  catch { return false; }
}

function notify() { listeners.forEach((listener) => listener()); }
function isRecoveryUrl() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("type") === "recovery" && Boolean(params.get("access_token")) && Boolean(params.get("refresh_token"));
}

/** Called before createClient: the SDK is allowed to consume/clear the URL. */
export function capturePasswordRecoveryIntent() {
  if (!isRecoveryUrl() && !hasStoredIntent()) return;
  pending = true; owner = null; epoch++; persistIntent(true); notify();
}

export function isPasswordRecovery() { return pending || isRecoveryUrl(); }
export const getPasswordRecoveryEpoch = () => epoch;
export const getPasswordRecoveryOwner = () => owner;
export function subscribePasswordRecovery(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Synchronous notification only. Never call back into the SDK in its callback. */
export function observePasswordRecovery(event: string, userId: string | null) {
  if (event === "PASSWORD_RECOVERY" && userId) {
    pending = true; owner = userId; epoch++; persistIntent(true); notify();
  } else if (event === "SIGNED_OUT" || owner && userId !== owner) {
    clearPasswordRecovery();
  }
  // SIGNED_IN may also mean refocus/reconfirmation of the same session, not a
  // new credential login. Only the explicit successful signIn action ends it.
}

/** Authorization comes from a server-verified recovery AMR, never the UI marker. */
export function resumeVerifiedPasswordRecovery(userId: string) {
  if (pending && owner === userId) return;
  pending = true; owner = userId; epoch++; persistIntent(true); notify();
}

export function isCurrentPasswordRecovery(expectedOwner: string, expectedEpoch: number) {
  return pending && owner === expectedOwner && epoch === expectedEpoch;
}

export function clearPasswordRecovery() {
  persistIntent(false);
  if (!pending && !owner) return;
  pending = false; owner = null; epoch++; notify();
}
