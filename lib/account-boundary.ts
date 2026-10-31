import { getCurrentUser, getOfflineUser, isRetryableAuthError, isRecoveryLink, signIn, signUp, signOut, completePasswordReset, subscribeToAuth, type CloudUser, type OfflineCloudUser } from "./cloud-sync";
import { isCloudConfigured } from "./supabase-client";
import { getDataProfile, makeDataProfile, publishDataProfile, type DataProfile } from "./data-profile";
import { prepareAccountWorkspace, flushWealthWrites, hasVerifiedWorkspaceHistory, wasExplicitlySignedOut, saveExplicitSignOutState } from "./storage";
import { activateDesktopDataProfile } from "./desktop";
import { registerDeletionOwner } from "./cloud-merge";
import { rememberLoginEmail } from "./login-history";
import { reportAuthDiagnostic } from "./auth-diagnostics";
import { readAutoLoginPreference } from "./auto-login";
import { capturePasswordRecoveryIntent } from "./password-recovery";

let generation = 0;
let queue: Promise<void> = Promise.resolve();
let initialized: Promise<void> | null = null;
let authUnsubscribe: (() => void) | null = null;
let attachAuthSubscription: (() => void) | null = null;
// This launch gate is separate from SDK persistence. Turning the preference off
// never logs out the current session or deletes its stored workspace/cache.
let manualLoginRequired = false;
let releaseDeletionOwner: (() => void) | null = null;
let authOperationTicket: number | null = null;
let currentUser: CloudUser | null = null;
let authError: string | null = null;
let busy = false;
let passwordResetInFlight: Promise<void> | null = null;
let onlineVerified = false;
// In-memory continuity only, obtained from an exact receipt/cache/workspace proof
// before the SDK can refresh its cache. Never persists credentials or authorizes
// cloud writes; any privacy fence/sign-out/rejection discards this grant.
let offlineAccess: { ownerId: string; verifiedAt: number; validUntil: number } | null = null;
let needsVerification = false;
let verificationInFlight: Promise<void> | null = null;
let onlineListener: (() => void) | null = null;
let focusListener: (() => void) | null = null;
let visibilityListener: (() => void) | null = null;
let lastVerificationAttempt = 0;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryAttempts = 0;
const recoveryDelays = [2200, 5000, 10000, 20000, 30000];
const verificationFailureMessage = "无法确认账号工作区，请重新登录或重启后重试。原资料未被删除或替换。";
const listeners = new Set<() => void>();
let boundaryRevision = 0;
export const getAccountRevision = () => boundaryRevision;
export const getAccountUser = () => currentUser;
export const getAccountError = () => authError;
export const isAccountBusy = () => busy;
export const isAccountVerified = () => onlineVerified;
export function subscribeAccountBoundary(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function notify() { boundaryRevision++; listeners.forEach((listener) => listener()); }
function cancelRecoveryTimer() { if (recoveryTimer !== null) clearTimeout(recoveryTimer); recoveryTimer = null; }
function scheduleRecovery(ticket: number) {
  if (manualLoginRequired || ticket !== generation || !needsVerification || recoveryTimer !== null
    || typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (recoveryAttempts >= recoveryDelays.length) { reportAuthDiagnostic("AUTH_RECOVERY_EXHAUSTED"); return; }
  reportAuthDiagnostic("AUTH_RECOVERY_SCHEDULED");
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (ticket === generation && needsVerification) void retryAccountVerification(true);
  }, recoveryDelays[recoveryAttempts++]);
}

function lock() {
  cancelRecoveryTimer();
  offlineAccess = null;
  releaseDeletionOwner?.(); releaseDeletionOwner = null;
  currentUser = null;
  onlineVerified = false;
  busy = true;
  authError = null;
  publishDataProfile(makeDataProfile("locked"));
  notify();
}

async function activate(user: CloudUser | null, ticket: number, local = false, verified = true, explicitLogin = false) {
  if (verified || !user) offlineAccess = null;
  if (user && verified) {
    await saveExplicitSignOutState(false);
    if (ticket !== generation) return;
  }
  if (verified || local || !user) { cancelRecoveryTimer(); recoveryAttempts = 0; }
  const existing = getDataProfile();
  if (user && existing.kind === "cloud" && existing.ownerId === user.id) {
    if (explicitLogin && verified) manualLoginRequired = false;
    currentUser = user; busy = false; onlineVerified = verified; needsVerification = !verified;
    authError = verified ? null : "当前暂时无法在线验证；已打开本机原账号资料，上传暂停。联网后会重新验证，也可点击立即同步。";
    notify(); return; // Never remount/replace a local draft merely to revalidate.
  }
  const scope: DataProfile = makeDataProfile(local ? "local" : user ? "cloud" : "guest", user?.id ?? null);
  await flushWealthWrites();
  if (ticket !== generation) return;
  await prepareAccountWorkspace(scope, verified || local);
  if (ticket !== generation) return;
  scope.desktopToken = await activateDesktopDataProfile(scope);
  if (ticket !== generation) return;
  // Release only after storage/capability activation, but BEFORE publishing:
  // an external sign-out at that publication must still fence private UI.
  if (explicitLogin && user && verified) manualLoginRequired = false;
  currentUser = user;
  onlineVerified = Boolean(user && verified);
  needsVerification = Boolean(user && !verified);
  busy = false;
  authError = needsVerification ? "当前暂时无法在线验证；已打开本机原账号资料，上传暂停。联网后会重新验证，也可点击立即同步。" : null;
  if (user) releaseDeletionOwner = registerDeletionOwner(user.id);
  publishDataProfile(scope);
  notify();
}

async function activateOffline(user: OfflineCloudUser, ticket: number) {
  await activate(user, ticket, false, false);
  if (ticket !== generation) return;
  const proof = user.localVerification;
  if (proof && Number.isSafeInteger(proof.verifiedAt) && Number.isSafeInteger(proof.validUntil)
    && proof.validUntil - proof.verifiedAt === 86400000) {
    offlineAccess = { ownerId: user.id, ...proof };
  }
}

function retainedOfflineUser(expected?: CloudUser | null): CloudUser | null {
  const scope = getDataProfile(), now = Date.now();
  if (!offlineAccess || !currentUser || onlineVerified || scope.kind !== "cloud"
    || scope.ownerId !== currentUser.id || offlineAccess.ownerId !== currentUser.id
    || expected && expected.id !== currentUser.id || now < offlineAccess.verifiedAt || now >= offlineAccess.validUntil) return null;
  return currentUser;
}

async function runAuth(operation: () => Promise<CloudUser | null>, rememberEmail = false) {
  cancelRecoveryTimer(); recoveryAttempts = 0;
  manualLoginRequired = true;
  const ticket = ++generation;
  authOperationTicket = ticket;
  lock();
  const result = queue.then(async () => {
    if (ticket !== generation) return;
    try {
      attachAuthSubscription?.();
      let user = await operation();
      if (ticket !== generation) return;
      if (user) {
        const verified = await getCurrentUser();
        if (ticket !== generation) return;
        if (!verified || verified.id !== user.id) throw new Error("登录状态发生变化，请重新登录。");
        user = verified;
      }
      await activate(user, ticket, false, true, true);
      // An awaited auth operation can resolve after failure or become stale.
      // Only the verified, activated identity may opt in to email-only memory.
      if (rememberEmail && user && ticket === generation && onlineVerified
        && getDataProfile().kind === "cloud" && getDataProfile().ownerId === user.id) rememberLoginEmail(user.email);
    } catch (error) {
      if (ticket !== generation) return;
      await activate(null, ticket).catch(() => { busy = false; notify(); });
      authError = error instanceof Error && /邮箱|确认链接|未配置|登录状态发生变化/.test(error.message)
        ? error.message : "账号操作未完成，原工作区资料已保留，请检查登录信息和网络后重试。";
      notify();
    } finally { if (authOperationTicket === ticket) authOperationTicket = null; }
  });
  queue = result.catch(() => undefined);
  return result;
}

export const signInAccount = (email: string, password: string, rememberEmail = false) => runAuth(() => signIn(email, password), rememberEmail);
export const signUpAccount = (email: string, password: string) => runAuth(() => signUp(email, password));
export const signOutAccount = () => runAuth(async () => { await signOut(); await saveExplicitSignOutState(true); return null; });
export function resetAccountPassword(password: string): Promise<void> {
  if (passwordResetInFlight) return passwordResetInFlight;
  const ticket = generation;
  const operation = queue.then(async () => {
    if (ticket !== generation) throw new Error("登录状态已经变化，未提交新密码。");
    try {
      // Do not lock/unmount the workspace just to update its password. Otherwise
      // a failed request loses the form/error, and can falsely resemble success.
      await completePasswordReset(password);
      if (ticket === generation) { authError = null; notify(); }
    } catch (error) {
      if (ticket === generation && error instanceof Error && error.name === "PasswordSavedLocalConfirmationError") {
        authError = "新密码已保存，但本机完成状态未能确认。请重新登录；财务资料未被更改。"; notify();
      }
      throw error;
    }
  });
  const pending = operation.finally(() => { if (passwordResetInFlight === pending) passwordResetInFlight = null; });
  passwordResetInFlight = pending;
  queue = pending.catch(() => undefined);
  return pending;
}

async function resolveIdentity(ticket: number, expected?: CloudUser | null) {
  if (manualLoginRequired || ticket !== generation) return;
  const wasPendingVerification = needsVerification;
  try {
    const user = expected === null ? null : await getCurrentUser();
    if (ticket !== generation) return;
    if (expected && user && user.id !== expected.id) throw new Error("Identity changed");
    if (!user && expected !== null && !await wasExplicitlySignedOut()
      && (wasPendingVerification || await hasVerifiedWorkspaceHistory())) {
      if (ticket !== generation) return;
      needsVerification = wasPendingVerification;
      lock(); busy = false; authError = verificationFailureMessage;
      reportAuthDiagnostic("AUTH_HISTORY_WITHOUT_SESSION"); notify();
      if (needsVerification) scheduleRecovery(ticket);
      return;
    }
    if (ticket !== generation) return;
    await activate(user, ticket);
  } catch (error) {
    if (ticket !== generation) return;
    if (isRetryableAuthError(error)) {
      const offline = await getOfflineUser();
      if (ticket !== generation) return;
      needsVerification = true;
      if (offline && (!expected || expected.id === offline.id)) {
        try { await activateOffline(offline, ticket); scheduleRecovery(ticket); return; }
        catch { reportAuthDiagnostic("OFFLINE_WORKSPACE_OPEN_FAILED"); }
      }
      // A successful SDK token refresh may update its cache while getUser is
      // temporarily unavailable. Keep ONLY the already-open, same-generation,
      // unexpired local grant; never infer a new identity from an email/receipt.
      const retained = !offline ? retainedOfflineUser(expected) : null;
      if (retained) {
        await activate(retained, ticket, false, false);
        reportAuthDiagnostic("OFFLINE_CONTEXT_RETAINED"); scheduleRecovery(ticket); return;
      }
      if (getDataProfile().kind !== "locked") lock();
      busy = false; needsVerification = true;
      authError = "暂时无法验证登录，也没有匹配的已验证本机工作区。原资料未被覆盖；联网后将重试验证。"; notify();
      scheduleRecovery(ticket);
      return;
    }
    lock(); busy = false; needsVerification = false;
    authError = verificationFailureMessage; notify();
  }
}

/** Serialized independently of the sync queue; no cloud writes before success. */
export function retryAccountVerification(automatic = false): Promise<void> {
  if (manualLoginRequired) return Promise.resolve();
  if (verificationInFlight) return verificationInFlight;
  if (!needsVerification && onlineVerified) return Promise.resolve();
  if (automatic && Date.now() - lastVerificationAttempt < 2000) return Promise.resolve();
  cancelRecoveryTimer();
  const ticket = generation;
  lastVerificationAttempt = Date.now();
  const operation = queue.then(async () => {
    if (manualLoginRequired || ticket !== generation) return;
    await resolveIdentity(ticket);
  });
  const pending = operation.finally(() => { if (verificationInFlight === pending) verificationInFlight = null; });
  verificationInFlight = pending;
  queue = pending.catch(() => undefined);
  return pending;
}

/** Lives outside page components: switching profiles unmounts every old private draft. */
export function initializeAccountBoundary(): Promise<void> {
  if (initialized) return needsVerification ? retryAccountVerification(true) : initialized;
  const ticket = ++generation;
  const local = !isCloudConfigured() || Boolean(typeof window !== "undefined" && window.wealthAtlasDesktop?.startupTestMode);
  manualLoginRequired = !local && !readAutoLoginPreference().enabled;
  const attachAuth = () => {
    if (authUnsubscribe) return;
    authUnsubscribe = subscribeToAuth((user, event) => {
    // INITIAL_SESSION reports the SDK's initial storage read, not a sign-out.
    // It can contain null when a startup read/refresh fails temporarily. Let
    // resolveIdentity own initial verification and its guarded offline fallback;
    // otherwise this notification cancels it and opens an empty guest workspace.
    // Explicit intents own the privacy lock while queued AND running. Older
    // operations cannot clear a newer intent; background work owns no such lock.
    if (manualLoginRequired || event === "INITIAL_SESSION"
      || authOperationTicket === generation && getDataProfile().kind === "locked") return;
    if (user?.id === currentUser?.id && getDataProfile().kind !== "locked") {
      if (user && (!onlineVerified || event === "TOKEN_REFRESHED" || event === "PASSWORD_RECOVERY")) {
        // Do not invoke the SDK while holding its auth-notification lock.
        const observedGeneration = generation;
        setTimeout(() => { if (observedGeneration !== generation) return; needsVerification = true; void retryAccountVerification(); }, 0);
      }
      return;
    }
    const eventTicket = ++generation;
    needsVerification = false; recoveryAttempts = 0;
    lock(); // Synchronous privacy fence; never await Supabase calls inside its callback.
    // Leave the SDK notification/lock entirely, not just its current microtask.
    const outsideNotification = new Promise<void>((resolve) => setTimeout(resolve, 0));
    queue = queue.then(() => outsideNotification).then(async () => {
      if (manualLoginRequired || eventTicket !== generation) return;
      if (!user && event === "SIGNED_OUT") {
        busy = false; authError = verificationFailureMessage;
        reportAuthDiagnostic("AUTH_EXTERNAL_SIGN_OUT_LOCKED"); notify(); return;
      }
      await resolveIdentity(eventTicket, user);
    }).catch(() => { busy = false; notify(); });
  }); };
  attachAuthSubscription = local ? null : attachAuth;
  const restoreRecoveryOnly = async () => {
    if (ticket !== generation) return;
    // A consumed-link reload has only the existing sessionStorage UI marker.
    // Capture it before SDK startup, then bind the owner through the existing
    // server-verified recovery AMR path, never through an email or marker alone.
    capturePasswordRecoveryIntent();
    if (!isRecoveryLink()) return;
    attachAuth();
    try { await getCurrentUser(); }
    catch { /* The recovery form must reverify before any password write. */ }
  };
  if (!local && typeof window !== "undefined" && window.addEventListener) {
    onlineListener = () => {
      if (manualLoginRequired) return;
      if (needsVerification || !onlineVerified && getDataProfile().kind === "locked") void retryAccountVerification();
    };
    window.addEventListener("online", onlineListener);
    focusListener = () => { if (!manualLoginRequired && needsVerification && !busy) void retryAccountVerification(true); };
    window.addEventListener("focus", focusListener);
    if (typeof document !== "undefined") {
      visibilityListener = () => { if (document.visibilityState === "visible") focusListener?.(); };
      document.addEventListener("visibilitychange", visibilityListener);
    }
  }
  initialized = (async () => {
    try {
      if (local) await activate(null, ticket, true);
      else if (manualLoginRequired) {
        // Do not even construct the SDK for an ordinary manual-login startup.
        // A deliberately opened recovery link may initialize its existing
        // recovery form, but cannot open an account workspace through events.
        await activate(null, ticket);
        await restoreRecoveryOnly();
      }
      else {
        let explicitlySignedOut: boolean;
        try { explicitlySignedOut = await wasExplicitlySignedOut(); }
        catch {
          if (ticket !== generation) return;
          manualLoginRequired = true;
          await activate(null, ticket);
          if (ticket !== generation) return;
          authError = "无法确认本机退出状态，已暂停自动登录。请手动登录；原账号资料已保留。"; notify();
          await restoreRecoveryOnly();
          return;
        }
        if (ticket !== generation) return;
        if (explicitlySignedOut) {
          manualLoginRequired = true;
          await activate(null, ticket);
          await restoreRecoveryOnly();
          return;
        }
        let offline: OfflineCloudUser | null = null;
        try {
          offline = await getOfflineUser();
          if (ticket !== generation) return;
          if (offline) await activateOffline(offline, ticket);
        } catch { reportAuthDiagnostic("OFFLINE_WORKSPACE_OPEN_FAILED"); offline = null; }
        if (ticket !== generation) return;
        // No SDK constructor/subscription before the read-only local preflight,
        // including when Windows reports LAN connectivity without Internet.
        attachAuth();
        await resolveIdentity(ticket, offline ?? undefined);
      }
    }
    catch {
      if (ticket !== generation) return;
      busy = false;
      authError = "无法打开账号工作区，原资料已保留。请重新启动后重试。"; notify();
    }
  })();
  queue = initialized.catch(() => undefined);
  return initialized;
}

/** Test/HMR cleanup: never removes stored workspaces or authentication tokens. */
export function disposeAccountBoundary() {
  cancelRecoveryTimer(); recoveryAttempts = 0;
  releaseDeletionOwner?.(); releaseDeletionOwner = null;
  generation++; authUnsubscribe?.(); authUnsubscribe = null; initialized = null;
  attachAuthSubscription = null; manualLoginRequired = false;
  if (onlineListener && typeof window !== "undefined") window.removeEventListener?.("online", onlineListener);
  if (focusListener && typeof window !== "undefined") window.removeEventListener?.("focus", focusListener);
  if (visibilityListener && typeof document !== "undefined") document.removeEventListener("visibilitychange", visibilityListener);
  focusListener = null; visibilityListener = null;
  onlineListener = null; onlineVerified = false; needsVerification = false; verificationInFlight = null; lastVerificationAttempt = 0;
  currentUser = null; busy = false; authError = null;
  offlineAccess = null;
}
