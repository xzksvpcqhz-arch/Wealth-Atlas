"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { WealthData } from "@/lib/types";
import { isCloudConfigured } from "@/lib/supabase-client";
import { loadCloudBaseline, loadCloudDeletions, loadCloudOutbox, loadWealthData, recordCloudSyncFailure, resumeCloudSync, saveCloudBaseline, saveCloudDeletions } from "@/lib/storage";
import { createCloudRetryController, syncFailureMessage } from "@/lib/cloud-retry";
import { getAccountError, getAccountRevision, getAccountUser, initializeAccountBoundary, isAccountBusy, isAccountVerified, retryAccountVerification, resetAccountPassword, signInAccount, signOutAccount, signUpAccount, subscribeAccountBoundary } from "@/lib/account-boundary";
import { assertActiveDataProfile, getDataProfile, getObjectProfile, isActiveDataProfile, tagProfileObject, type DataProfile } from "@/lib/data-profile";
import { subscribePasswordRecovery } from "@/lib/password-recovery";
import {
  isRecoveryLink,
  getCloudTransport,
  resetPassword as cloudResetPassword,
  subscribeToRemote,
  type CloudUser,
} from "@/lib/cloud-sync";
import {
  CloudSyncSafetyError,
  createCloudSyncSession,
  snapshotsEqual,
} from "@/lib/cloud-merge";

export type SyncStatus = "unconfigured" | "signed-out" | "syncing" | "ready" | "error";

export interface CloudSyncController {
  user: CloudUser | null;
  status: SyncStatus;
  lastSyncedAt: string | null;
  error: string | null;
  recovering: boolean;
  signIn: (email: string, password: string, rememberEmail?: boolean) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  syncNow: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  completePasswordReset: (newPassword: string) => Promise<void>;
}

function nowClock(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/**
 * All triggers share one guarded session. A conflict is shown in the existing
 * error panel; neither local data nor the remote conflicting version is replaced.
 */
export function useCloudSync(
  data: WealthData,
  setData: Dispatch<SetStateAction<WealthData>>,
  ready: boolean,
  profile: DataProfile = getDataProfile(),
): CloudSyncController {
  const configured = isCloudConfigured();
  const accountVerified = isAccountVerified();
  const [user, setUser] = useState<CloudUser | null>(null);
  const [status, setStatus] = useState<SyncStatus>(configured ? "signed-out" : "unconfigured");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recovering = useSyncExternalStore(subscribePasswordRecovery, isRecoveryLink, () => false);

  const dataRef = useRef(data);
  dataRef.current = data;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const sessionRef = useRef<ReturnType<typeof createCloudSyncSession> | null>(null);
  const retryRef = useRef<ReturnType<typeof createCloudRetryController> | null>(null);
  // A profile switch remounts this hook before the boundary publishes its final
  // error. React's external-store handshake cannot miss that intervening update.
  useSyncExternalStore(subscribeAccountBoundary, getAccountRevision, () => 0);
  const appliedDataRef = useRef<WealthData | null>(null);
  const pendingApplyRef = useRef<{ next: WealthData; resolve: (applied: boolean) => void } | null>(null);
  const [applyAttempt, setApplyAttempt] = useState(0);
  const pushTimerRef = useRef<number | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const stopSession = useCallback(() => {
    retryRef.current?.dispose();
    retryRef.current = null;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    pendingApplyRef.current?.resolve(false);
    pendingApplyRef.current = null;
    if (pushTimerRef.current !== null) window.clearTimeout(pushTimerRef.current);
    pushTimerRef.current = null;
    appliedDataRef.current = null;
  }, []);

  const syncNow = useCallback(async () => {
    if (!readyRef.current || !isActiveDataProfile(profile)) return;
    if (!isAccountVerified()) { await retryAccountVerification(); return; }
    await retryRef.current?.request("manual");
  }, [profile]);

  const startSession = useCallback(async (u: CloudUser, cancelled: () => boolean) => {
    stopSession();
    if (profile.kind !== "cloud" || profile.ownerId !== u.id || !isActiveDataProfile(profile)) return;
    const baseline = await loadCloudBaseline(profile);
    if (cancelled() || !isActiveDataProfile(profile)) return;
    sessionRef.current = createCloudSyncSession({
      transport: getCloudTransport(u.id),
      baseline,
      getLocal: () => {
        assertActiveDataProfile(profile);
        if (getObjectProfile(dataRef.current) !== profile) throw new CloudSyncSafetyError("资料与登录账号不一致，已停止同步。");
        return dataRef.current;
      },
      loadDeletions: () => loadCloudDeletions(u.id, profile),
      saveDeletions: (deletions) => saveCloudDeletions(u.id, deletions, profile),
      applyLocal: (expected, next) => {
        if (!isActiveDataProfile(profile)) return Promise.resolve(false);
        tagProfileObject(next, profile);
        if (snapshotsEqual(dataRef.current, next)) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          pendingApplyRef.current = { next, resolve };
          appliedDataRef.current = next;
          // Do not overwrite edits queued in React while the network was busy.
          setData((current) => isActiveDataProfile(profile) && getObjectProfile(current) === profile && snapshotsEqual(current, expected) ? next : current);
          setApplyAttempt((attempt) => attempt + 1);
        });
      },
      confirmLocalPersistence: async (expected) => {
        // Read only. The existing parent effect owns snapshot writes; do not race it.
        const activeSession = sessionRef.current;
        try {
          for (let attempt = 0; attempt < 10; attempt++) {
            if (sessionRef.current !== activeSession || !isActiveDataProfile(profile)) return false;
            if (snapshotsEqual(await loadWealthData(undefined, profile), expected)) return true;
            if (!snapshotsEqual(dataRef.current, expected)) return false;
            await new Promise((resolve) => window.setTimeout(resolve, 60));
          }
        } catch { /* Surface a local-save error without exposing IndexedDB contents. */ }
        return false;
      },
      saveBaseline: (next, deletions) => saveCloudBaseline(profile, next, deletions),
    });
    const session = sessionRef.current;
    const retry = createCloudRetryController({
      load: () => loadCloudOutbox(profile),
      fail: (code) => recordCloudSyncFailure(profile, code),
      resume: (transientOnly) => resumeCloudSync(profile, transientOnly),
      run: () => session.sync(),
      online: () => navigator.onLine !== false,
      active: () => !cancelled() && readyRef.current && isActiveDataProfile(profile) && sessionRef.current === session,
      setTimer: (callback, delay) => window.setTimeout(callback, delay),
      clearTimer: (id) => window.clearTimeout(id),
      onState: (next, reason, cause) => {
        setStatus(next);
        setError(reason ? cause instanceof CloudSyncSafetyError ? cause.message : syncFailureMessage(reason) : null);
        if (next === "ready") setLastSyncedAt(nowClock());
      },
    });
    retryRef.current = retry;
    setUser(u);
    setLastSyncedAt(null);
    const unsubscribe = subscribeToRemote(u.id, () => { void retry.request("remote"); });
    let wasOffline = navigator.onLine === false;
    const onOffline = () => { wasOffline = true; void retry.request("change"); };
    const onOnline = () => { const trigger = wasOffline ? "online" : "focus"; wasOffline = false; void retry.request(trigger); };
    const onFocus = () => { void retry.request("focus"); };
    const onVisibility = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    unsubscribeRef.current = () => {
      unsubscribe();
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    await retry.request("initial");
  }, [profile, setData, stopSession]);

  // Acknowledge only the state React actually committed, not an optimistic ref.
  useEffect(() => {
    const pending = pendingApplyRef.current;
    if (!pending) return;
    pendingApplyRef.current = null;
    pending.resolve(snapshotsEqual(data, pending.next));
  }, [data, applyAttempt]);

  const resetPassword = useCallback(async (email: string) => {
    setError(null);
    await cloudResetPassword(email);
  }, []);

  const completePasswordReset = useCallback(async (newPassword: string) => {
    await resetAccountPassword(newPassword);
  }, []);

  // The account boundary selects a workspace before financial startup is allowed.
  useEffect(() => {
    void initializeAccountBoundary();
    if (!configured || !ready || profile.kind !== "cloud" || recovering || !accountVerified) return;
    let cancelled = false;
    const u = getAccountUser();
    if (u?.id === profile.ownerId) void startSession(u, () => cancelled).catch(() => {
      if (!cancelled) { setStatus("error"); setError("无法打开当前账号的同步状态，原资料已保留。"); }
    });
    return () => {
      cancelled = true;
      stopSession();
    };
  }, [configured, ready, profile, recovering, accountVerified, startSession, stopSession]);

  // 本地数据变化 → 防抖自动上传（合并来自云端的改动不重复上传）
  useEffect(() => {
    if (!configured || !ready || !user) return;
    if (appliedDataRef.current && snapshotsEqual(appliedDataRef.current, data)) {
      appliedDataRef.current = null;
      return;
    }
    appliedDataRef.current = null;
    if (pushTimerRef.current !== null) window.clearTimeout(pushTimerRef.current);
    pushTimerRef.current = window.setTimeout(() => {
      pushTimerRef.current = null;
      void retryRef.current?.request("change");
    }, 1200);
    return () => {
      if (pushTimerRef.current !== null) {
        window.clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
      }
    };
  }, [data, configured, ready, user, syncNow]);

  // 卸载时退订
  useEffect(() => () => stopSession(), [stopSession]);

  const accountError = getAccountError();
  return { user: profile.kind === "cloud" ? getAccountUser() ?? user : null,
    status: isAccountBusy() ? "syncing" : accountError ? "error" : status,
    lastSyncedAt, error: accountError ?? error, recovering,
    signIn: signInAccount, signUp: signUpAccount, signOut: signOutAccount,
    syncNow, resetPassword, completePasswordReset };
}
