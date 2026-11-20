"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowClockwise, Database, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { getDesktopBridge, type BackupEntry } from "@/lib/desktop";
import { getDataProfile, isActiveDataProfile } from "@/lib/data-profile";
import { prepareRestorePreview, stableRestoreFingerprint } from "@/lib/backup-restore-preview";
import type { WealthData } from "@/lib/types";
import styles from "./BackupRestorePanel.module.css";

type Preview = ReturnType<typeof prepareRestorePreview>;
export type RestoreRequest = { expected: WealthData; candidate: WealthData; verify: () => Promise<void> };
type Props = { data: WealthData; onRestore: (request: RestoreRequest) => Promise<void>; onToast: (message: string) => void; paused: boolean | null; onResume: () => Promise<void> };
const kinds = { added: "新增", changed: "改变", currentOnly: "当前独有", same: "相同" };
type Filter = "changes" | keyof typeof kinds;
const formatTime = (value: string | null) => !value || !Number.isFinite(Date.parse(value)) ? "未知时间" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
const showValue = (value: unknown) => value === undefined ? "未设置" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

function RestoreDialog({ title, description, final, busy, onClose, footer, children, returnFocus }: { title: string; description: string; final?: boolean; busy: boolean; onClose: () => void; footer: ReactNode; children: ReactNode; returnFocus: HTMLElement | null }) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = dialog.current!, origin = returnFocus ?? document.activeElement as HTMLElement | null;
    node.showModal(); heading.current?.focus({ preventScroll: true });
    return () => { node.close(); window.requestAnimationFrame(() => { if (origin?.isConnected) origin.focus({ preventScroll: true }); }); };
  }, []);
  useEffect(() => { content.current?.scrollTo(0, 0); heading.current?.focus({ preventScroll: true }); }, [title]);
  return <dialog ref={dialog} className={styles.dialog + (final ? " " + styles.final : "")} aria-labelledby={id + "-title"} aria-describedby={id + "-description"} aria-busy={busy}
    onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}
    onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); if (!busy && e.target === e.currentTarget && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) onClose(); }}>
    <div className={styles.frame}><header className={styles.heading}><div><h2 ref={heading} id={id + "-title"} tabIndex={-1}>{title}</h2><p id={id + "-description"}>{description}</p></div><button type="button" className="secondary-button compact" disabled={busy} onClick={onClose} aria-label="关闭恢复弹窗" title="关闭">关闭</button></header>
      <div ref={content} className={styles.content}>{children}</div><footer className={styles.footer}>{footer}</footer></div>
  </dialog>;
}

export default function BackupRestorePanel({ data, onRestore, onToast, paused, onResume }: Props) {
  const [entries, setEntries] = useState<BackupEntry[] | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [target, setTarget] = useState<BackupEntry | null>(null), [preview, setPreview] = useState<Preview | null>(null);
  const [reading, setReading] = useState(false), [restoring, setRestoring] = useState(false), [final, setFinal] = useState(false), [ack, setAck] = useState(false);
  const [filter, setFilter] = useState<Filter>("changes"), [limit, setLimit] = useState(40), [resumeOpen, setResumeOpen] = useState(false);
  const busy = useRef(false), generation = useRef(0), current = useRef(data), scope = useRef(getDataProfile()).current;
  const expected = useRef<WealthData | null>(null), lifetime = useRef(true);
  const sourcePacket = useRef("");
  const returnFocus = useRef<HTMLElement | null>(null);
  const [legacyUnverified, setLegacyUnverified] = useState(false);
  current.current = data;
  useEffect(() => { lifetime.current = true; return () => { lifetime.current = false; generation.current++; }; }, []);
  const refresh = useCallback(async () => {
    const ticket = ++generation.current; setLoading(true); setError("");
    try { const list = await getDesktopBridge()?.listBackups(); if (lifetime.current && ticket === generation.current) setEntries(list ?? []); }
    catch { if (lifetime.current && ticket === generation.current) setError("无法读取备份列表，请刷新后重试。原资料未改变。"); }
    finally { if (lifetime.current && ticket === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const close = () => { if (busy.current) return; generation.current++; setTarget(null); setPreview(null); setFinal(false); setAck(false); setReading(false); setError(""); };
  const open = async (entry: BackupEntry, trigger: HTMLButtonElement) => {
    if (busy.current || reading || paused === null) return;
    returnFocus.current = trigger;
    const ticket = ++generation.current; expected.current = current.current;
    setTarget(entry); setPreview(null); setReading(true); setError(""); setFinal(false); setAck(false); setFilter("changes"); setLimit(40);
    try {
      const packet = await getDesktopBridge()?.readBackupWithIntegrity(entry.id, entry.kind);
      if (!lifetime.current || ticket !== generation.current || !isActiveDataProfile(scope)) return;
      if (!packet || entry.schemaVersion !== null && packet.schemaVersion !== entry.schemaVersion) throw new Error("RESTORE_METADATA_CHANGED");
      sourcePacket.current = stableRestoreFingerprint(packet);
      setLegacyUnverified(packet.integrity === "legacy-unverified");
      setPreview(prepareRestorePreview(expected.current!, packet.snapshot, { schemaVersion: packet.schemaVersion }));
    } catch { if (lifetime.current && ticket === generation.current) setError("无法验证这份备份，已停止恢复。请选择其他备份；原资料和备份均未改变。"); }
    finally { if (lifetime.current && ticket === generation.current) setReading(false); }
  };
  const stale = Boolean(preview && (!isActiveDataProfile(scope) || stableRestoreFingerprint(data) !== preview.currentFingerprint));
  const unchanged = Boolean(preview && preview.totals.added + preview.totals.changed + preview.totals.currentOnly === 0);
  const restore = async () => {
    if (busy.current || !target || !preview || !ack || stale || unchanged) return;
    busy.current = true; setRestoring(true); setError("");
    const ticket = generation.current, selected = target, prepared = preview, before = expected.current!;
    const verify = async () => {
      if (!lifetime.current || generation.current !== ticket || !isActiveDataProfile(scope) || stableRestoreFingerprint(current.current) !== prepared.currentFingerprint) throw new Error("RESTORE_STALE");
      const packet = await getDesktopBridge()?.readBackupWithIntegrity(selected.id, selected.kind);
      if (!packet || stableRestoreFingerprint(packet) !== sourcePacket.current || stableRestoreFingerprint(packet.snapshot) !== prepared.sourceFingerprint || !lifetime.current || generation.current !== ticket || !isActiveDataProfile(scope) || stableRestoreFingerprint(current.current) !== prepared.currentFingerprint) throw new Error("RESTORE_STALE");
    };
    try {
      await onRestore({ expected: before, candidate: prepared.candidate, verify });
      if (!lifetime.current) return;
      setTarget(null); setPreview(null); setFinal(false); setAck(false);
      onToast("已恢复本机资料；云端同步与 Vault 自动写入已暂停"); void refresh();
    } catch { if (lifetime.current) setError("恢复未完成：资料、账号或备份可能已变化，或安全备份／本地保存失败。请取消后重新预览；不会用空白资料覆盖。"); }
    finally { busy.current = false; if (lifetime.current) setRestoring(false); }
  };
  const resume = async () => {
    if (busy.current || !ack) return;
    busy.current = true; setRestoring(true); setError("");
    try { await onResume(); if (lifetime.current) { setResumeOpen(false); setAck(false); onToast("已允许恢复云端同步和 Vault 自动写入；同步冲突仍会停止处理"); } }
    catch { if (lifetime.current) setError("无法恢复自动写入，暂停保护仍然保留。请重新打开页面后重试。"); }
    finally { busy.current = false; if (lifetime.current) setRestoring(false); }
  };
  const records = preview?.details.filter((row) => filter === "changes" ? row.kind !== "same" : row.kind === filter) ?? [];
  const errorBlock = error && <div className="sync-error" role="alert"><WarningCircle size={18} /><div><strong>需要处理</strong><span>{error}</span></div></div>;
  return <main className={"main-content module-page backup-restore-page " + styles.panel} data-testid="backup-restore">
    <header className="page-header module-header"><div><div className="breadcrumb">WEALTH ATLAS / SETTINGS</div><h1>备份与恢复</h1></div><button type="button" className="secondary-button compact" onClick={() => void refresh()} disabled={loading || reading || restoring || Boolean(target)} aria-label="刷新备份列表" title="刷新备份列表"><ArrowClockwise size={16} />{loading ? "读取中…" : "刷新"}</button></header>
    <section className="panel"><div className="panel-title-row"><div><div className="panel-kicker">LOCAL RECOVERY</div><h2>本地快照与更新备份</h2></div><ShieldCheck size={20} /></div>
      <p className={styles.intro}>每次修改会自动在本机留存快照，更新／迁移前也会备份。选择一份先比较差异，确认前不会恢复或覆盖资料。早期备份可能没有校验码；请只选择你信任的本机备份，字段验证不能证明来源真实性。</p>
      {paused !== false && <div className={styles.hold} role="status"><strong>{paused === null ? "正在核对恢复保护状态" : "当前为本机恢复保护模式"}</strong><p>{paused === null ? "确认状态前，不能执行新的恢复或恢复自动写入。" : "云端上传、接收及 Vault 自动快照写入已暂停，重开应用后仍保持暂停。仅影响当前工作区；账号排版同步不受影响。"}</p>{paused && <button type="button" className="secondary-button" onClick={(event) => { returnFocus.current = event.currentTarget; setResumeOpen(true); setAck(false); setError(""); }} aria-label="检查并恢复自动写入" title="检查并恢复自动写入">检查并恢复自动写入</button>}</div>}
      {!target && !resumeOpen && errorBlock}
      {entries === null ? <div className="empty-state compact-empty"><Database size={28} /><strong>正在读取备份…</strong></div> : entries.length === 0 ? <div className="empty-state compact-empty"><Database size={28} /><strong>还没有本地备份</strong><span>桌面版改动过资料后，快照会出现在这里。</span></div> : <div className="backup-list">{entries.map((entry) => <div className="backup-row" key={entry.kind + "-" + entry.id}><div className="backup-row-main"><strong>{formatTime(entry.createdAt)}</strong><span>{entry.kind === "autosave" ? "自动快照" : "安全／更新备份"} · v{entry.appVersion || "未知"} · schema {entry.schemaVersion ?? "—"}</span></div><button type="button" className="secondary-button compact" onClick={(event) => void open(entry, event.currentTarget)} disabled={reading || restoring || paused === null} aria-label={"预览 " + formatTime(entry.createdAt) + " 的备份"} title="只读比较这份备份">预览恢复</button></div>)}</div>}
    </section>
    {target && <RestoreDialog returnFocus={returnFocus.current} title={final ? "最后确认恢复这份备份？" : "恢复前，先看看会改变什么"} description={final ? "仅恢复当前本机工作区，不是合并，也不是云端回退。" : "这一步只比较资料。确认前，不会恢复或覆盖任何内容。"} final={final} busy={restoring} onClose={close} footer={<><p>{final ? "安全备份与本地保存成功后才会显示恢复成功。" : "接下来还有一次确认。恢复前必须成功保存当前资料的安全备份。"}</p><div className={styles.actions}><button type="button" className="secondary-button" disabled={restoring} onClick={() => final ? (setFinal(false), setAck(false)) : close()}>{final ? "返回差异预览" : "取消，不恢复"}</button><button type="button" className="primary-button" disabled={restoring || reading || !preview || stale || unchanged || Boolean(error) || (final && !ack)} onClick={() => final ? void restore() : (setFinal(true), setAck(false))}>{restoring ? "正在保护并恢复…" : final ? "创建安全备份并恢复" : "继续，确认恢复"}</button></div></>}>
      {errorBlock}
      {reading ? <p role="status" className={styles.muted}>正在读取并验证备份…</p> : <>
        <div className={styles.sources}><div><span>当前资料</span><strong>本机当前工作区</strong><small>以打开预览时的资料比较</small></div><div><span>选中的备份</span><strong>{formatTime(target.createdAt)}</strong><small>v{target.appVersion || "未知"} · schema {target.schemaVersion ?? "—"}</small></div></div>
        {stale ? <div className={styles.notice} role="alert"><strong>当前资料已变化，请重新比较</strong><p>不能按旧差异继续恢复。请取消并重新打开预览。</p></div> : unchanged ? <div className={styles.notice}><strong>这份备份与当前资料相同</strong><p>没有需要恢复的变化，不会重新写入资料。</p></div> : preview && <div className={styles.notice}><strong>恢复是整份替换，不是自动合并</strong><p>当前独有的 {preview.totals.currentOnly} 项不会出现在恢复后的工作区。原备份不删除，恢复前会另外保存当前资料。</p></div>}
        <div className={styles.notice}><strong>恢复后暂停自动写入</strong><p>云端同步和 Vault 自动快照写入会暂停，直到你另行确认恢复。Obsidian 连接与现有同步日志保留；不会改写 Vault 文件。</p></div>
        {preview && legacyUnverified && <div className={styles.notice}><strong>早期备份：没有原始校验码</strong><p>字段验证已通过，但不能校验备份原始完整性。只有确认来源可信时才继续；不会自动修补或删除原备份。</p></div>}
        {final ? <label className={styles.ack}><input type="checkbox" checked={ack} disabled={restoring} onChange={(e) => setAck(e.target.checked)} /><span>我已查看差异，了解会替换本机资料，并暂停云端同步与 Vault 自动写入。</span></label> : preview && <>
          <div className={styles.filters} role="group" aria-label="筛选差异">{(["changes", "added", "changed", "currentOnly", "same"] as Filter[]).map((kind) => <button key={kind} type="button" className="secondary-button" aria-pressed={kind === filter} onClick={() => { setFilter(kind); setLimit(40); }}>{kind === "changes" ? "所有变化" : kinds[kind]} <b>{kind === "changes" ? preview.totals.added + preview.totals.changed + preview.totals.currentOnly : preview.totals[kind]}</b></button>)}</div>
          <h3>按资料类型比较</h3><table className={styles.table}><caption>包括停用及回收站资料；按资料类型与真实 ID 比较。无 ID 的设置与历史按完整内容比较。</caption><thead><tr>{["资料类型", "当前", "恢复后", "新增", "改变", "相同", "不再保留"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{preview.modules.map((row) => <tr key={row.key}><th scope="row">{row.label}</th>{(["current", "backup", "added", "changed", "same", "currentOnly"] as const).map((key, index) => <td key={key} data-label={["当前", "恢复后", "新增", "改变", "相同", "不再保留"][index]}>{row[key]}</td>)}</tr>)}</tbody></table>
          <div className={styles.detailsHeader}><h3>逐条查看变化</h3><span>只在本机显示，不写入诊断日志</span></div>
          {!records.length && <p className={styles.muted}>此筛选下没有记录。</p>}
          {records.slice(0, limit).map((row) => <details className={styles.record} key={row.module + "-" + row.id}><summary><strong>{preview.modules.find((module) => module.key === row.module)?.label} · {row.label === "$" ? "设置" : row.label}</strong><span>{kinds[row.kind]}</span></summary>{row.fields.map((field) => <div className={styles.fields} key={field.key}><div><span>当前 · {field.key}</span><pre>{showValue(field.before)}</pre></div><div><span>恢复后 · {field.key}</span><pre>{showValue(field.after)}</pre></div></div>)}</details>)}
          {records.length > limit && <button type="button" className="secondary-button" onClick={() => setLimit((value) => value + 40)}>再显示 40 项（剩余 {records.length - limit}）</button>}
        </>}
      </>}
    </RestoreDialog>}
    {resumeOpen && <RestoreDialog returnFocus={returnFocus.current} title="确认恢复自动写入？" description="这不是把云端回退到本机备份。" final busy={restoring} onClose={() => { if (!busy.current) { setResumeOpen(false); setError(""); setAck(false); } }} footer={<div className={styles.actions}><button type="button" className="secondary-button" disabled={restoring} onClick={() => setResumeOpen(false)}>继续保持暂停</button><button type="button" className="primary-button" disabled={!ack || restoring} onClick={() => void resume()}>{restoring ? "正在确认…" : "确认恢复自动写入"}</button></div>}>
      <div className={styles.notice}><strong>重新启用后可能合并云端资料并更新 Vault 快照</strong><p>云端其他设备的资料可能重新出现，本机改动可能上传。删除标记和原同步基准仍然保留；发生冲突时会停止，不会强制覆盖。请先核对当前资料和安全备份。</p></div>{errorBlock}<label className={styles.ack}><input type="checkbox" checked={ack} disabled={restoring} onChange={(e) => setAck(e.target.checked)} /><span>我已核对，允许当前工作区恢复云端同步与 Vault 自动写入。</span></label>
    </RestoreDialog>}
  </main>;
}
