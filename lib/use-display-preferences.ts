"use client";

import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { isActiveDataProfile, type DataProfile } from "@/lib/data-profile";
import { createDisplayPreferences, displayStorageKey, readDisplayPreferences, writeDisplayPreferences, type DisplayPreferences } from "@/lib/display-preferences";
import { getAccountRevision, getAccountUser, isAccountVerified, subscribeAccountBoundary } from "@/lib/account-boundary";
import { getSupabaseClient } from "@/lib/supabase-client";
import { createDisplayPreferenceSync, type DisplaySyncStatus } from "@/lib/display-preference-sync";
import { createDisplayPreferenceTransport } from "@/lib/display-preference-transport";

type EditState = { draft: DisplayPreferences; saved: DisplayPreferences; history: DisplayPreferences[]; future: DisplayPreferences[] };
type EditAction = { type: "load" | "saved"; value: DisplayPreferences } | { type: "change"; change: (value: DisplayPreferences) => void } | { type: "undo" | "redo" };
function editReducer(state: EditState, action: EditAction): EditState {
  if (action.type === "load") return { draft: structuredClone(action.value), saved: structuredClone(action.value), history: [], future: [] };
  if (action.type === "saved") return { ...state, saved: structuredClone(action.value) };
  if (action.type === "change") {
    const next = structuredClone(state.draft); action.change(next);
    return JSON.stringify(next) === JSON.stringify(state.draft) ? state : { ...state, draft: next, history: [...state.history.slice(-59), state.draft], future: [] };
  }
  if (action.type === "undo" && state.history.length) return { ...state, draft: state.history.at(-1)!, history: state.history.slice(0, -1), future: [...state.future, state.draft] };
  if (action.type === "redo" && state.future.length) return { ...state, draft: state.future.at(-1)!, future: state.future.slice(0, -1), history: [...state.history, state.draft] };
  return state;
}

/** Display-only state, scoped by the existing verified account boundary.
 * Never reads or writes financial snapshots or the financial sync table. */
export function useDisplayPreferences(profile: DataProfile) {
  const [state, commitState] = useReducer((_previous: EditState, next: EditState) => next, undefined, () => ({ draft: createDisplayPreferences(), saved: createDisplayPreferences(), history: [], future: [] }));
  const { draft, saved, history, future } = state;
  // Async responses and UI events share one coherent snapshot, including during
  // a batched React render. No raw CAS token can point at an older saved value.
  const stateRef = useRef<EditState>(state);
  const dispatch = useCallback((action: EditAction) => {
    const next = editReducer(stateRef.current, action);
    stateRef.current = next;
    commitState(next);
  }, []);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const [readable, setReadable] = useState(true);
  const readableRef = useRef(false);
  const raw = useRef<string | null>(null);
  const authRevision = useSyncExternalStore(subscribeAccountBoundary, getAccountRevision, () => 0);
  const [syncStatus, setSyncStatus] = useState<DisplaySyncStatus>("local");
  const sync = useRef<ReturnType<typeof createDisplayPreferenceSync> | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const hasDraft = useCallback(() => JSON.stringify(stateRef.current.draft) !== JSON.stringify(stateRef.current.saved), []);

  const reload = useCallback(() => {
    if (!isActiveDataProfile(profile)) return;
    const result = readDisplayPreferences({ kind: profile.kind, ownerId: profile.ownerId });
    readableRef.current = result.status === "default" || result.status === "stored";
    raw.current = result.raw;
    dispatch({ type: "load", value: result.value });
    setReadable(readableRef.current);
    setMessage(result.status === "invalid" ? "显示设置无法读取，原保存内容已保留，未自动覆盖。"
      : result.status === "unavailable" ? "本机显示设置存储暂不可用；原资料未改变，可以重试读取。" : "");
    setReady(true);
  }, [profile, dispatch]);

  useEffect(() => {
    reload();
    const listener = (event: StorageEvent) => {
      if (event.key !== displayStorageKey({ kind: profile.kind, ownerId: profile.ownerId }) || !isActiveDataProfile(profile)) return;
      if (hasDraft()) setMessage("其他窗口更新了显示设置，当前草稿已保留。请取消草稿并重新读取后再修改。");
      else reload();
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, [profile, reload, hasDraft]);

  useEffect(() => {
    if (!ready || !readable || profile.kind !== "cloud") { setSyncStatus("local"); return; }
    const client = getSupabaseClient();
    if (!client || !profile.ownerId) { setSyncStatus("waiting"); return; }
    const owner = profile.ownerId, scope = { kind: profile.kind, ownerId: owner };
    const key = displayStorageKey(scope)!;
    const abort = new AbortController();
    const active = () => readableRef.current && isActiveDataProfile(profile) && isAccountVerified() && getAccountUser()?.id === owner && !abort.signal.aborted;
    const session = createDisplayPreferenceSync({
      transport: createDisplayPreferenceTransport(client, owner, active, abort.signal),
      isActive: active,
      local: () => {
        // .sync metadata is shared by tabs. Never pair another tab's newer
        // ancestry with this tab's stale saved configuration.
        if (!readableRef.current || window.localStorage.getItem(key) !== raw.current) throw new Error("Display snapshot changed in another window");
        return { value: stateRef.current.saved, stored: raw.current !== null, dirty: hasDraft() };
      },
      readMeta: () => window.localStorage.getItem(`${key}.sync`),
      saveMeta: meta => {
        if (!active()) return false;
        try { const encoded = JSON.stringify(meta); window.localStorage.setItem(`${key}.sync`, encoded); return window.localStorage.getItem(`${key}.sync`) === encoded; } catch { return false; }
      },
      applyRemote: value => {
        if (!active() || hasDraft()) return false;
        const result = writeDisplayPreferences(scope, value, raw.current);
        if (!result.ok) return false;
        raw.current = result.raw;
        dispatch({ type: "load", value }); return true;
      },
      onStatus: setSyncStatus,
    });
    sync.current = session;
    void session.sync();
    const resume = () => { if (!document.hidden) void session.sync(); };
    const timer = window.setInterval(resume, 30_000);
    window.addEventListener("online", resume); window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    return () => { abort.abort(); session.dispose(); if (sync.current === session) sync.current = null; clearInterval(timer); window.removeEventListener("online", resume); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [profile, ready, readable, authRevision, dispatch, hasDraft]);

  useEffect(() => { if (ready && readable && !dirty) void sync.current?.sync(); }, [saved, ready, readable, dirty]);

  const update = useCallback((change: (next: DisplayPreferences) => void) => {
    if (!isActiveDataProfile(profile) || !ready || !readable) return;
    dispatch({ type: "change", change });
  }, [profile, ready, readable, dispatch]);

  const save = useCallback(() => {
    if (!isActiveDataProfile(profile) || !ready || !readable) return false;
    const value = stateRef.current.draft;
    const result = writeDisplayPreferences({ kind: profile.kind, ownerId: profile.ownerId }, value, raw.current);
    if (!result.ok) {
      setMessage(result.reason === "conflict" ? "其他窗口已保存新方案，未覆盖。当前草稿仍在，请取消并读取已保存方案后重试。"
        : "显示设置保存失败；当前草稿及原有财务资料已保留，可稍后重试。");
      return false;
    }
    raw.current = result.raw; dispatch({ type: "saved", value });
    setMessage("显示设置已保存在本机当前工作区。没有修改财务资料。");
    return true;
  }, [profile, ready, readable, dispatch]);

  const undo = () => {
    if (!isActiveDataProfile(profile) || !history.length) return;
    dispatch({ type: "undo" });
  };
  const redo = () => {
    if (!isActiveDataProfile(profile) || !future.length) return;
    dispatch({ type: "redo" });
  };

  const syncMessage = ({ local: "仅本机工作区保存", waiting: "显示方案同步等待账号验证、联网或草稿处理；本机设置已保留", syncing: "正在同步账号显示方案…", ready: "账号显示方案已是最新", conflict: "其他设备也修改了显示方案，已暂停同步；没有覆盖任何方案", error: "账号显示方案暂时同步失败，本机设置已保留，可重试" } satisfies Record<DisplaySyncStatus, string>)[syncStatus];
  return { draft, ready, readable, dirty, message, syncStatus, syncMessage, retrySync: () => sync.current?.sync(), resolveSync: (choice: "local" | "remote") => sync.current?.resolve(choice), update, save, cancel: reload, reload, undo, redo, canUndo: !!history.length, canRedo: !!future.length };
}

export type DisplayPreferenceController = ReturnType<typeof useDisplayPreferences>;
