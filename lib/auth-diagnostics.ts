import { reportSafeDiagnostic } from "./diagnostics";
import codes from "../desktop/auth-diagnostic-codes.json";
import type { AuthStorageActivity } from "./auth-storage";

export type AuthDiagnosticCode = keyof typeof codes;
const allowed = new Set<string>(Object.keys(codes));
const reported = new Set<string>();

/** Fixed enum only: never an SDK error, identity, token, URL or data payload.
 * At most one entry per code per renderer lifetime; existing logs are capped. */
export function reportAuthDiagnostic(code: AuthDiagnosticCode) {
  if (!allowed.has(code) || reported.has(code)) return;
  reported.add(code);
  void reportSafeDiagnostic("auth-recovery", code, "info").catch(() => undefined);
}

const storageActivities = new Set<AuthStorageActivity>(["AUTH_STORAGE_FIRST_READ_EMPTY", "AUTH_STORAGE_FIRST_READ_PRESENT",
  "AUTH_STORAGE_WRITE_CONFIRMED", "AUTH_STORAGE_REMOVE_REQUESTED", "AUTH_STORAGE_REMOVE_CONFIRMED"]);
let activityCount = 0;
/** Candidate-only sequence, without deduplicating distinct remove/write cycles.
 * No storage read, key, value or error payload; never enables financial access. */
export function reportAuthStorageActivity(code: AuthStorageActivity) {
  try {
    if (!storageActivities.has(code) || typeof window === "undefined" || !window.wealthAtlasDesktop?.isDesktop
      || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(window.wealthAtlasDesktop.appVersion) || activityCount > 64) return;
    const event = activityCount++ === 64 ? "AUTH_STORAGE_TRACE_LIMIT_REACHED" : code;
    void reportSafeDiagnostic("auth-recovery", event, "info").catch(() => undefined);
  } catch { /* Missing bridge/diagnostics cannot interfere with login or SDK persistence. */ }
}
