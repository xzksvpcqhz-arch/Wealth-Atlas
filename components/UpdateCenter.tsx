"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { getDesktopBridge } from "@/lib/desktop";
import { awaitUpdateRequest, browserUpdateState, readUpdateReply, UPDATE_RELEASES_URL, updateView, type UpdateState } from "@/lib/update-center";
import styles from "./UpdateCenter.module.css";

const WEB_VERSION = process.env.NEXT_PUBLIC_WEALTH_ATLAS_VERSION ?? "";
const waitLabel = (milliseconds: number) => {
  const seconds = Math.ceil(milliseconds / 1000);
  return seconds >= 60 ? Math.floor(seconds / 60) + "分" + seconds % 60 + "秒" : seconds + "秒";
};

export default function UpdateCenter() {
  const id = useId();
  const [snapshot, setSnapshot] = useState<UpdateState | null>(null);
  const [problem, setProblem] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [openingNotes, setOpeningNotes] = useState(false);
  const [notesProblem, setNotesProblem] = useState(false);
  const [reload, setReload] = useState(0);
  const bridge = useRef<ReturnType<typeof getDesktopBridge>>(null);
  const lifetime = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const checkBusy = useRef(false);
  const notesBusy = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    try {
      bridge.current = getDesktopBridge();
      if (!bridge.current) { setSnapshot(browserUpdateState(WEB_VERSION)); setProblem(false); return () => abort.abort(); }
      if (!bridge.current.getUpdateState || !bridge.current.checkForUpdates) {
        setSnapshot({ ...browserUpdateState(bridge.current.appVersion), platform: bridge.current.platform, disabledReason: "unavailable" });
        setProblem(false); return () => abort.abort();
      }
    } catch {
      setProblem(true);
      return () => abort.abort();
    }
    const read = async () => {
      const generation = epoch.current;
      let state: UpdateState | null = null;
      try {
        const response = await awaitUpdateRequest(() => bridge.current!.getUpdateState!(), abort.signal);
        if (closed) return;
        state = readUpdateReply(response);
        if (!state) throw new Error("UPDATE_STATE_UNAVAILABLE");
        if (generation === epoch.current) { setSnapshot(state); setProblem(false); }
      } catch {
        if (closed) return;
        if (generation === epoch.current) { setProblem(true); return; }
      }
      if (!closed && state?.status !== "disabled" && state?.code !== "UPDATE_CONFIGURATION_FAILED") {
        timer = setTimeout(() => void read(), state?.status === "checking" || state?.status === "downloading" ? 1000 : 2000);
      }
    };
    void read();
    return () => { closed = true; abort.abort(); clearTimeout(timer); };
  }, [reload]);

  const view = problem
    ? { badge: "状态暂不可用", title: "暂时无法读取更新状态", detail: "本机资料和已下载文件不会因读取失败而清除。可以重新读取状态；不要因此卸载或清空资料。", tone: "attention", label: "重新读取状态", locked: false }
    : snapshot ? updateView(snapshot)
    : { badge: "正在读取", title: "正在读取更新状态", detail: "正在读取此设备的程序版本和更新器状态。", tone: "neutral", label: "正在读取…", locked: true };
  const waiting = !problem && Boolean(snapshot && snapshot.retryAfterMs > 0 && !view.locked);
  const locked = view.locked || requesting || waiting;
  const currentVersion = snapshot?.currentVersion ?? WEB_VERSION;
  const versionLabel = currentVersion && currentVersion !== "unknown" ? "v" + currentVersion : "未能读取";
  const platformLabel = snapshot?.platform === "win32" ? "Windows 桌面版" : snapshot?.platform === "browser" ? "网页版" : snapshot ? "桌面版" : "正在读取运行环境";
  const actionLabel = requesting ? "正在请求…" : view.label;

  const check = async () => {
    if (checkBusy.current || locked) return;
    if (problem) { epoch.current++; setReload((value) => value + 1); return; }
    const active = lifetime.current;
    if (!active || active.signal.aborted || !bridge.current?.checkForUpdates) return;
    checkBusy.current = true; setRequesting(true);
    const generation = ++epoch.current;
    try {
      const response = await awaitUpdateRequest(() => bridge.current!.checkForUpdates!(), active.signal);
      if (active.signal.aborted || generation !== epoch.current) return;
      const next = readUpdateReply(response);
      if (!next) throw new Error("UPDATE_STATE_UNAVAILABLE");
      setSnapshot(next); setProblem(false);
    } catch { if (!active.signal.aborted && generation === epoch.current) setProblem(true); }
    finally { checkBusy.current = false; if (!active.signal.aborted) setRequesting(false); }
  };
  const openNotes = async () => {
    const active = lifetime.current;
    if (notesBusy.current || !active || active.signal.aborted) return;
    notesBusy.current = true; setOpeningNotes(true); setNotesProblem(false);
    try {
      if (!bridge.current?.openUpdateReleaseNotes) throw new Error("UPDATE_NOTES_UNAVAILABLE");
      const result = await awaitUpdateRequest(() => bridge.current!.openUpdateReleaseNotes!(), active.signal);
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw new Error("UPDATE_NOTES_UNAVAILABLE");
    } catch { if (!active.signal.aborted) setNotesProblem(true); }
    finally { notesBusy.current = false; if (!active.signal.aborted) setOpeningNotes(false); }
  };

  return <section className={"panel " + styles.panel} aria-labelledby={id + "-title"} data-testid="update-center">
    <header className={styles.heading}>
      <div><h2 id={id + "-title"}>更新中心</h2><p>查看程序版本和更新进度，不影响账号资料同步。</p></div>
      <span className={styles.badge} data-tone={view.tone}>{view.badge}</span>
    </header>
    <dl className={styles.versions}>
      <div><dt>当前版本</dt><dd>{versionLabel}</dd><small>{platformLabel}</small></div>
      <div><dt>最新正式版</dt><dd>{snapshot?.latestVersion ? "v" + snapshot.latestVersion : "尚未取得"}</dd><small>{snapshot?.latestVersion ? "最近一次检查取得的正式版本" : "检查后显示 GitHub 正式版本"}</small></div>
    </dl>
    <div className={styles.feedback} data-tone={view.tone} role="status" aria-live="polite" aria-atomic="true" aria-busy={!problem && snapshot?.status === "checking"}>
      <strong>{view.title}</strong><p id={id + "-status"}>{view.detail}</p>
    </div>
    {!problem && snapshot?.status === "downloading" && <div className={styles.download}>
      <div className={styles.progressLabel}><label htmlFor={id + "-progress"}>安装包下载进度</label><strong>{snapshot.progressPercent === null ? "正在获取进度" : snapshot.progressPercent + "%"}</strong></div>
      <progress id={id + "-progress"} max={100} value={snapshot.progressPercent ?? undefined} aria-label="安装包下载进度" />
      <p>下载完成并通过校验后，才会显示等待退出安装。</p>
    </div>}
    <div className={styles.actions}>
      <button type="button" className="primary-button" disabled={locked} onClick={() => void check()} aria-label={actionLabel} aria-describedby={id + "-status" + (waiting ? " " + id + "-retry" : "")} title={waiting ? waitLabel(snapshot!.retryAfterMs) + "后可再次检查" : view.label}>
        <ArrowClockwise size={18} aria-hidden="true" /><span>{actionLabel}</span>
      </button>
      {snapshot?.platform === "browser"
        ? <a className="secondary-button" href={UPDATE_RELEASES_URL} target="_blank" rel="noopener noreferrer" title="在 GitHub 查看正式发布记录">查看发布说明</a>
        : <button type="button" className="secondary-button" disabled={openingNotes || !snapshot} onClick={() => void openNotes()} title="在 GitHub 查看正式发布记录">{openingNotes ? "正在打开…" : "查看发布说明"}</button>}
      <span className={styles.lastCheck}>{snapshot?.checkedAt !== null && snapshot?.checkedAt !== undefined ? <time dateTime={new Date(snapshot.checkedAt).toISOString()}>最近检查：{new Date(snapshot.checkedAt).toLocaleString("zh-CN", { hour12: false })}</time> : "尚未检查"}</span>
    </div>
    {waiting && <p className={styles.retry} id={id + "-retry"}>为避免重复请求，{waitLabel(snapshot!.retryAfterMs)}后可再次检查。</p>}
    {notesProblem && <p className={styles.retry} role="status">暂时无法打开发布说明，请稍后重试。不会影响更新下载或本机资料。</p>}
    <p className={styles.explanation}>下载完成后，请先保存当前操作，再正常关闭应用进行安装。重新打开后才会显示新版本，不会强制中断操作。</p>
    <p className={styles.backup}>更新不需要卸载或清空资料；建议提前备份重要资料。</p>
  </section>;
}
