"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { WealthData } from "@/lib/types";
import { isCloudConfigured } from "@/lib/supabase-client";
import {
  getCurrentUser,
  pullSnapshot,
  pushSnapshot,
  resetPassword as cloudResetPassword,
  signIn as cloudSignIn,
  signOut as cloudSignOut,
  signUp as cloudSignUp,
  subscribeToRemote,
  mergeSnapshots,
  type CloudUser,
} from "@/lib/cloud-sync";

export type SyncStatus = "unconfigured" | "signed-out" | "syncing" | "ready" | "error";

export interface CloudSyncController {
  user: CloudUser | null;
  status: SyncStatus;
  lastSyncedAt: string | null;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  syncNow: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
}

function nowClock(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 云端同步控制器（纯逻辑，无界面）：
 * - 登录后：拉云端 → 与本地合并 → 回推合并结果（双方收敛）
 * - 本地每次改动：防抖 1.2s 自动上传
 * - 实时订阅：其他设备的改动自动合并回本地（回声/无变化则跳过，避免循环）
 * 由「设置 → 云端同步」卡片消费。
 */
export function useCloudSync(
  data: WealthData,
  setData: Dispatch<SetStateAction<WealthData>>,
  ready: boolean,
): CloudSyncController {
  const configured = isCloudConfigured();
  const [user, setUser] = useState<CloudUser | null>(null);
  const [status, setStatus] = useState<SyncStatus>(configured ? "signed-out" : "unconfigured");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dataRef = useRef(data);
  dataRef.current = data;
  const suppressPushRef = useRef(false);
  const pushTimerRef = useRef<number | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  /** 把云端快照合并进本地；内容没变化就跳过（避免回声触发无限循环）。 */
  const applyRemote = useCallback(
    (remote: WealthData) => {
      const current = dataRef.current;
      const merged = mergeSnapshots(current, remote);
      if (jsonEqual(merged, current)) return;
      suppressPushRef.current = true;
      setData(merged);
    },
    [setData],
  );

  const subscribe = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = subscribeToRemote((remote) => applyRemote(remote));
  }, [applyRemote]);

  const syncNow = useCallback(async () => {
    if (!configured) return;
    setError(null);
    setStatus("syncing");
    try {
      const pulled = await pullSnapshot();
      let merged = dataRef.current;
      if (pulled) {
        merged = mergeSnapshots(dataRef.current, pulled.data);
        if (!jsonEqual(merged, dataRef.current)) {
          suppressPushRef.current = true;
          setData(merged);
        }
      }
      await pushSnapshot(merged);
      setLastSyncedAt(nowClock());
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [configured, setData]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null);
      setStatus("syncing");
      try {
        const u = await cloudSignIn(email, password);
        setUser(u);
        subscribe();
        await syncNow();
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [subscribe, syncNow],
  );

  const signUp = useCallback(
    async (email: string, password: string) => {
      setError(null);
      setStatus("syncing");
      try {
        const u = await cloudSignUp(email, password);
        setUser(u);
        subscribe();
        await pushSnapshot(dataRef.current); // 首次注册：把本地数据上传到自己的云端空间
        setLastSyncedAt(nowClock());
        setStatus("ready");
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [subscribe],
  );

  const signOut = useCallback(async () => {
    await cloudSignOut();
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    setUser(null);
    setStatus("signed-out");
    setLastSyncedAt(null);
    setError(null);
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    setError(null);
    await cloudResetPassword(email);
  }, []);

  // 挂载时恢复已有登录会话（等本地数据 ready 后再同步，避免用种子数据覆盖真实数据）
  useEffect(() => {
    if (!configured || !ready) return;
    let cancelled = false;
    void (async () => {
      try {
        const u = await getCurrentUser();
        if (cancelled || !u) return;
        setUser(u);
        subscribe();
        await syncNow();
      } catch {
        /* 未登录或网络异常，保持未登录即可 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configured, ready, subscribe, syncNow]);

  // 本地数据变化 → 防抖自动上传（合并来自云端的改动不重复上传）
  useEffect(() => {
    if (!configured || !ready || !user) return;
    if (suppressPushRef.current) {
      suppressPushRef.current = false;
      return;
    }
    if (pushTimerRef.current !== null) window.clearTimeout(pushTimerRef.current);
    pushTimerRef.current = window.setTimeout(() => {
      pushTimerRef.current = null;
      void pushSnapshot(dataRef.current)
        .then(() => setLastSyncedAt(nowClock()))
        .catch(() => undefined);
    }, 1200);
    return () => {
      if (pushTimerRef.current !== null) {
        window.clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
      }
    };
  }, [data, configured, ready, user]);

  // 卸载时退订
  useEffect(() => () => unsubscribeRef.current?.(), []);

  return { user, status, lastSyncedAt, error, signIn, signUp, signOut, syncNow, resetPassword };
}
