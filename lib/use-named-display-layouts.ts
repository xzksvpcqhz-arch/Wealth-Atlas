"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isActiveDataProfile, type DataProfile } from "./data-profile";
import { getAccountRevision, getAccountUser, isAccountVerified, subscribeAccountBoundary } from "./account-boundary";
import { getSupabaseClient } from "./supabase-client";
import { parseDisplayPreferences, type DisplayPreferences } from "./display-preferences";
import { createNamedLayoutLibrary, layoutNameKey, namedLayoutStorageKey, normalizeLayoutName, readNamedLayouts, writeNamedLayouts, type NamedLayoutEnvelope, type NamedLayoutLibrary } from "./named-display-layouts";
import { createNamedLayoutSync, type NamedLayoutConflictToken } from "./named-layout-sync";
import { createNamedLayoutTransport } from "./named-layout-transport";
import type { DisplaySyncStatus } from "./display-preference-sync";

const empty = (): NamedLayoutEnvelope => ({ version: 1, library: createNamedLayoutLibrary(), base: null });

/** A separate display-only library. It never imports a financial store, never
 * binds unowned layouts to an account, and never applies incoming templates. */
export function useNamedDisplayLayouts(profile: DataProfile) {
  const [envelope, setEnvelope] = useState<NamedLayoutEnvelope>(empty);
  const state = useRef({ envelope, raw: null as string | null, readable: false });
  const [ready, setReady] = useState(false), [readable, setReadable] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(true), operating = useRef(false);
  const [syncStatus, setSyncStatus] = useState<DisplaySyncStatus>("local");
  const authRevision = useSyncExternalStore(subscribeAccountBoundary, getAccountRevision, () => 0);
  const sync = useRef<ReturnType<typeof createNamedLayoutSync> | null>(null);
  const active = useCallback(() => mounted.current && isActiveDataProfile(profile), [profile]);
  const scope = { kind: profile.kind, ownerId: profile.ownerId };
  const key = namedLayoutStorageKey(scope);

  const reload = useCallback(() => {
    if (!active()) return;
    const result = readNamedLayouts({ kind: profile.kind, ownerId: profile.ownerId });
    const ok = result.status === "default" || result.status === "stored";
    state.current = { envelope: result.envelope, raw: result.raw, readable: ok };
    setEnvelope(result.envelope); setReadable(ok); setReady(true);
    setMessage(result.status === "invalid" ? "方案库无法读取，原保存内容已保留，未自动覆盖。"
      : result.status === "unavailable" ? "本机方案库存储不可用；没有更改原方案，请稍后重新读取。" : "");
  }, [active, profile]);

  useEffect(() => {
    mounted.current = true; reload();
    const storage = (event: StorageEvent) => { if (event.key === key && active()) reload(); };
    window.addEventListener("storage", storage);
    return () => { mounted.current = false; window.removeEventListener("storage", storage); };
  }, [active, key, reload]);

  const commit = useCallback(async (value: NamedLayoutEnvelope, expected: string | null, fence: () => boolean = active) => {
    const allowed = () => active() && fence();
    if (!allowed() || !state.current.readable) return false;
    const result = await writeNamedLayouts({ kind: profile.kind, ownerId: profile.ownerId }, value, expected, allowed);
    if (!allowed()) return false;
    if (!result.ok) {
      setMessage(result.reason === "conflict" ? "其他窗口已更新方案库，未覆盖。请重新读取后重试。"
        : result.reason === "unsupported" ? "当前环境不支持安全的多窗口保存，请使用新版浏览器或桌面版；原方案已保留。"
        : "方案库保存失败，原内容已保留。请检查本机存储后重试。");
      return false;
    }
    state.current = { envelope: structuredClone(value), raw: result.raw, readable: true };
    setEnvelope(state.current.envelope); return true;
  }, [active, profile]);

  useEffect(() => {
    if (!ready || !readable || profile.kind !== "cloud") { setSyncStatus("local"); return; }
    const client = getSupabaseClient();
    if (!client || !profile.ownerId) { setSyncStatus("waiting"); return; }
    const owner = profile.ownerId, abort = new AbortController();
    const verified = () => active() && state.current.readable && !abort.signal.aborted && isAccountVerified() && getAccountUser()?.id === owner;
    const session = createNamedLayoutSync({
      active: verified,
      transport: createNamedLayoutTransport(client, owner, verified, abort.signal),
      local: () => {
        if (!key || window.localStorage.getItem(key) !== state.current.raw) throw new Error("Layout library changed in another window");
        return { envelope: structuredClone(state.current.envelope), raw: state.current.raw };
      },
      commit: async (value, expected) => verified() && commit(value, expected, verified),
      onStatus: value => { if (active()) setSyncStatus(value); },
    });
    sync.current = session;
    // Offline verified workspaces remain readable without a cloud response.
    if (verified()) void session.sync(); else setSyncStatus("waiting");
    const resume = () => { if (!document.hidden && verified()) void session.sync(); };
    const timer = window.setInterval(resume, 30_000);
    window.addEventListener("online", resume); window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    return () => { abort.abort(); session.dispose(); if (sync.current === session) sync.current = null; clearInterval(timer); window.removeEventListener("online", resume); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [profile, active, ready, readable, authRevision, commit, key]);

  const mutate = useCallback(async (change: (library: NamedLayoutLibrary) => void): Promise<boolean> => {
    if (!active() || !ready || !state.current.readable || operating.current) return false;
    operating.current = true; setBusy(true);
    try {
      const captured = state.current;
      const next = structuredClone(captured.envelope);
      change(next.library);
      if (!await commit(next, captured.raw)) return false;
      if (!active()) return false;
      setMessage("方案库已保存在当前工作区；只包含显示设置。");
      if (profile.kind === "cloud") { setSyncStatus("waiting"); void sync.current?.sync(); }
      return true;
    } catch {
      if (active()) setMessage("未保存：名称须为 1–30 字且不能重复，最多保存 10 套；请重新选择有效方案。原内容已保留。");
      return false;
    } finally { operating.current = false; if (active()) setBusy(false); }
  }, [active, ready, commit, profile.kind]);

  const checkedName = (library: NamedLayoutLibrary, input: string, except?: string) => {
    const name = normalizeLayoutName(input);
    if (!name || library.schemes.some(item => item.id !== except && layoutNameKey(item.name) === layoutNameKey(name))) throw new Error("Invalid layout name");
    return name;
  };
  const add = (name: string, input: DisplayPreferences) => {
    const preferences = parseDisplayPreferences(input);
    return mutate(library => {
      if (!preferences || library.schemes.length >= 10) throw new Error("Invalid layout snapshot");
      library.schemes.push({ id: crypto.randomUUID(), name: checkedName(library, name), preferences });
    });
  };
  const rename = (id: string, name: string) => mutate(library => {
    const item = library.schemes.find(item => item.id === id); if (!item) throw new Error("Layout missing");
    item.name = checkedName(library, name, id);
  });
  const copy = (id: string, name: string) => mutate(library => {
    const item = library.schemes.find(item => item.id === id); if (!item || library.schemes.length >= 10) throw new Error("Layout missing");
    library.schemes.push({ id: crypto.randomUUID(), name: checkedName(library, name), preferences: structuredClone(item.preferences) });
  });
  const remove = (id: string) => mutate(library => {
    if (!library.schemes.some(item => item.id === id)) throw new Error("Layout missing");
    library.schemes = library.schemes.filter(item => item.id !== id);
  });
  const syncMessage = ({ local: "方案库仅保存在当前本机工作区", waiting: "方案库等待账号验证或联网；本机方案已保留", syncing: "正在同步账号方案库…", ready: "账号方案库已是最新", conflict: "其他设备也修改了方案库，已暂停；请选择保留哪一整套方案库", error: "账号方案库同步失败，本机方案已保留，可以重试" } satisfies Record<DisplaySyncStatus, string>)[syncStatus];
  return { library: envelope.library, ready, readable, busy, message, syncStatus, syncMessage, add, rename, copy, remove, reload, retrySync: async () => { await sync.current?.sync(); }, getConflictToken: () => active() ? sync.current?.getConflictToken() ?? null : null, resolveSync: async (choice: "local" | "remote", confirmed: NamedLayoutConflictToken | null) => {
    const current = sync.current;
    if (!active() || !current) return false;
    const outcome = await current.resolve(choice, confirmed);
    return active() && sync.current === current && outcome === "ready";
  } };
}

export type NamedDisplayLayoutsController = ReturnType<typeof useNamedDisplayLayouts>;
