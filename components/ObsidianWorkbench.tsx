"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  BookOpenText,
  Check,
  CheckCircle,
  CloudArrowDown,
  FileText,
  FolderSimple,
  GearSix,
  LinkSimple,
  Prohibit,
  ShieldCheck,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { exportObsidianZip, downloadMarkdownFile, getDefaultObsidianTemplates } from "@/lib/exporters";
import {
  buildSyncPlan,
  ensureVaultFolders,
  getDirectoryPicker,
  OBSIDIAN_FOLDERS,
  requestVaultPermission,
  restoreVaultHandle,
  type SyncFilePlan,
  type VaultDirectoryHandle,
  writeSyncPlan,
} from "@/lib/obsidian";
import { clearObsidianHandle, loadObsidianHandle, saveObsidianHandle } from "@/lib/storage";
import type { ObsidianTemplateKey, SyncLog, WealthData } from "@/lib/types";

type WorkbenchMode = "sync" | "settings";

const templateLabels: Record<ObsidianTemplateKey, string> = {
  daily: "每日模板",
  monthly: "每月模板",
  yearly: "每年模板",
  goal: "储蓄目标模板",
  asset: "资产模板",
  review: "财务复盘模板",
};

function makeSyncId() {
  return `sync-${crypto.randomUUID()}`;
}

function statusLabel(status: SyncFilePlan["status"]) {
  return { new: "新增", update: "即将更新", unchanged: "无变化", conflict: "需确认" }[status];
}

function statusIcon(status: SyncFilePlan["status"]) {
  if (status === "conflict") return WarningCircle;
  if (status === "unchanged") return CheckCircle;
  return FileText;
}

export default function ObsidianWorkbench({ mode, data, setData, onToast, onNavigate }: { mode: WorkbenchMode; data: WealthData; setData: Dispatch<SetStateAction<WealthData>>; onToast: (message: string) => void; onNavigate: (page: "obsidian" | "settings" | "home") => void }) {
  const [vaultHandle, setVaultHandle] = useState<VaultDirectoryHandle | null>(null);
  const [vaultName, setVaultName] = useState(data.obsidian?.vaultName ?? "");
  const [busy, setBusy] = useState<"connect" | "disconnect" | "scan" | "sync" | "download" | null>(null);
  const [error, setError] = useState("");
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState("");
  const [plans, setPlans] = useState<SyncFilePlan[] | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<ObsidianTemplateKey>("daily");
  const [templateDraft, setTemplateDraft] = useState("");
  const disconnectButtonRef = useRef<HTMLButtonElement>(null);
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const disconnectCancelRef = useRef<HTMLButtonElement>(null);
  const disconnectDialogRef = useRef<HTMLDivElement>(null);
  const disconnectInFlightRef = useRef(false);

  const defaults = useMemo(() => getDefaultObsidianTemplates(), []);
  const logs = data.syncLogs ?? [];
  const latestLog = logs[0];
  const connected = data.obsidian?.status === "connected" && Boolean(vaultName);
  const visibleVaultName = connected ? vaultName : "";

  useEffect(() => {
    let cancelled = false;
    loadObsidianHandle().then((stored) => {
      if (cancelled || !stored) return;
      return restoreVaultHandle(stored.handle, stored.vaultName).then((handle) => {
        if (cancelled) return;
        setVaultHandle(handle);
        setVaultName(stored.vaultName);
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const closeDisconnectDialog = () => {
    if (disconnectInFlightRef.current) return;
    setDisconnectDialogOpen(false);
    setDisconnectError("");
    window.requestAnimationFrame(() => disconnectButtonRef.current?.focus());
  };

  useEffect(() => {
    if (!disconnectDialogOpen) return;
    const frame = window.requestAnimationFrame(() => disconnectCancelRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disconnectInFlightRef.current) {
        event.preventDefault();
        closeDisconnectDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(disconnectDialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [disconnectDialogOpen]);

  useEffect(() => {
    setTemplateDraft(data.obsidianTemplates?.[selectedTemplate] ?? defaults[selectedTemplate]);
  }, [data.obsidianTemplates, defaults, selectedTemplate]);

  const persistSettings = (next: WealthData["obsidian"]) => setData((current) => ({ ...current, obsidian: next }));

  const connectVault = async () => {
    const picker = getDirectoryPicker();
    if (!picker) {
      const message = "当前浏览器不支持本地文件夹写入，请改用 ZIP 下载。";
      setError(message);
      persistSettings({ vaultName: "", status: "permission-error", lastError: message });
      return;
    }
    setBusy("connect");
    setError("");
    try {
      const handle = await picker();
      await requestVaultPermission(handle);
      await ensureVaultFolders(handle, data.obsidianTemplates);
      await saveObsidianHandle(handle, handle.name);
      setVaultHandle(handle);
      setVaultName(handle.name);
      persistSettings({ vaultName: handle.name, status: "connected", connectedAt: new Date().toISOString() });
      onToast("Vault 已连接，标准 Folder 与模板已准备好");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Vault 连接失败，请检查文件夹权限。";
      setError(message);
      persistSettings({ vaultName: vaultName || "", status: "permission-error", lastError: message });
    } finally {
      setBusy(null);
    }
  };

  const reconnectVault = async () => {
    setBusy("connect");
    setError("");
    try {
      const stored = vaultHandle ? { handle: vaultHandle, vaultName } : await loadObsidianHandle();
      if (!stored) throw new Error("没有可重新连接的 Vault，请先选择本地 Vault。");
      const handle = vaultHandle ?? await restoreVaultHandle(stored.handle, stored.vaultName);
      await requestVaultPermission(handle);
      await ensureVaultFolders(handle, data.obsidianTemplates);
      setVaultHandle(handle);
      setVaultName(stored.vaultName);
      persistSettings({ ...data.obsidian, vaultName: stored.vaultName, status: "connected", lastError: undefined });
      onToast("Vault 已重新连接");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Vault 重新连接失败，请改用 ZIP 下载。";
      setError(message);
      persistSettings({ ...data.obsidian, vaultName, status: "permission-error", lastError: message });
    } finally {
      setBusy(null);
    }
  };

  const requestDisconnectVault = () => {
    if (!connected || busy === "disconnect") return;
    setDisconnectError("");
    setDisconnectDialogOpen(true);
  };

  const confirmDisconnectVault = async () => {
    if (!connected || disconnectInFlightRef.current) return;
    disconnectInFlightRef.current = true;
    setBusy("disconnect");
    setDisconnectError("");
    try {
      await clearObsidianHandle();
      setVaultHandle(null);
      setVaultName("");
      setPlans(null);
      setError("");
      persistSettings({ vaultName: "", status: "disconnected" });
      setDisconnectDialogOpen(false);
      onToast("已断开 Obsidian Vault 连接");
      window.requestAnimationFrame(() => connectButtonRef.current?.focus());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "断开连接失败，请稍后重试。";
      setDisconnectError(`断开连接失败：${message}`);
    } finally {
      disconnectInFlightRef.current = false;
      setBusy(null);
    }
  };

  const scanVault = async () => {
    if (!vaultHandle) {
      setError("请先连接 Vault。若浏览器无法写入，可直接下载 ZIP。");
      return;
    }
    setBusy("scan");
    setError("");
    try {
      await requestVaultPermission(vaultHandle);
      const nextPlans = await buildSyncPlan(vaultHandle, data);
      setPlans(nextPlans);
      persistSettings({ ...data.obsidian, vaultName, status: "connected", lastScanAt: new Date().toISOString(), lastError: undefined });
      onNavigate("obsidian");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "扫描 Vault 失败，请重新连接或下载 ZIP。";
      setError(message);
      persistSettings({ ...data.obsidian, vaultName, status: "permission-error", lastError: message });
    } finally {
      setBusy(null);
    }
  };

  const confirmSync = async () => {
    if (!vaultHandle || !plans) return;
    setBusy("sync");
    setError("");
    try {
      const result = await writeSyncPlan(vaultHandle, plans, "1.0.0");
      const log: SyncLog = { id: makeSyncId(), syncedAt: new Date().toISOString(), vaultName, ...result };
      setData((current) => ({ ...current, syncLogs: [log, ...(current.syncLogs ?? [])].slice(0, 30), obsidian: { ...current.obsidian, vaultName, status: result.failed ? "permission-error" : "connected", lastSyncAt: log.syncedAt, lastError: result.errorReason } }));
      if (result.failed) {
        setError(result.errorReason ?? "部分文件同步失败，可重新扫描后重试。");
        onToast("同步未完全成功，请查看失败原因");
      } else {
        setPlans(null);
        onToast(`同步完成：新增 ${result.added}，更新 ${result.updated}，跳过 ${result.skipped}`);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "同步失败，请重新扫描后重试。";
      setError(message);
      const log: SyncLog = { id: makeSyncId(), syncedAt: new Date().toISOString(), vaultName, fileCount: plans.length, added: 0, updated: 0, unchanged: 0, skipped: plans.filter((plan) => plan.status === "conflict").length, failed: plans.length, errorReason: message };
      setData((current) => ({ ...current, syncLogs: [log, ...(current.syncLogs ?? [])].slice(0, 30) }));
    } finally {
      setBusy(null);
    }
  };

  const saveTemplate = () => {
    setData((current) => ({ ...current, obsidianTemplates: { ...(current.obsidianTemplates ?? {}), [selectedTemplate]: templateDraft } }));
    onToast(`${templateLabels[selectedTemplate]} 已保存到本地 IndexedDB`);
  };

  const downloadScope = async (scope: "daily" | "monthly" | "yearly" | "full") => {
    setBusy("download");
    try {
      await exportObsidianZip(data, scope);
      onToast(`${scope === "full" ? "完整 Obsidian 文件夹" : scope === "daily" ? "每日" : scope === "monthly" ? "每月" : "每年"} ZIP 已下载`);
    } catch {
      onToast("ZIP 下载失败，请重试");
    } finally {
      setBusy(null);
    }
  };

  const renderConnection = () => <section className="panel obsidian-connection-panel"><div className="panel-title-row"><div><div className="panel-kicker">VAULT CONNECTION</div><h2>Obsidian Vault 连接</h2></div><div className={`vault-status ${connected ? "connected" : data.obsidian?.status === "permission-error" ? "error" : "disconnected"}`}><span />{connected ? "已连接" : data.obsidian?.status === "permission-error" ? "权限异常" : "未连接"}</div></div><div className="vault-connection-body"><div className="vault-identity"><div className="vault-icon"><BookOpenText size={22} /></div><div><strong>{visibleVaultName || "还没有选择本地 Vault"}</strong><span>{connected ? "仅在你明确扫描或同步时读取文件" : "选择后会创建财富理财师目录，不会删除已有文件"}</span></div></div><div className="vault-actions"><button ref={connectButtonRef} type="button" className="primary-button compact" onClick={connectVault} disabled={busy === "connect" || busy === "disconnect"} aria-label={vaultName ? "选择其他 Obsidian Vault" : "选择本地 Obsidian Vault"} title={vaultName ? "选择其他 Vault" : "选择本地 Vault"}>{busy === "connect" ? "连接中…" : vaultName ? "选择其他 Vault" : "选择本地 Vault"}</button>{vaultName && <button type="button" className="secondary-button compact" onClick={reconnectVault} disabled={busy === "connect" || busy === "disconnect"} aria-label="重新连接 Obsidian Vault" title="重新连接"><ArrowClockwise size={16} /> 重新连接</button>}{connected && <button ref={disconnectButtonRef} type="button" className="secondary-button compact vault-disconnect-button" onClick={requestDisconnectVault} disabled={busy === "disconnect"} aria-label="断开 Obsidian Vault 连接" title="断开连接"><Prohibit size={16} /> 断开连接</button>}</div></div>{error && <div className="sync-error" role="alert"><WarningCircle size={18} /><div><strong>需要处理</strong><span>{error}</span></div><button type="button" className="icon-button" onClick={() => setError("")} aria-label="关闭错误" title="关闭错误"><X size={16} /></button></div>}</section>;

  const renderDisconnectDialog = () => disconnectDialogOpen ? <div className="modal-backdrop obsidian-disconnect-backdrop" role="presentation" onPointerDown={(event) => { if (event.currentTarget === event.target) closeDisconnectDialog(); }}><div ref={disconnectDialogRef} className="modal confirm-modal obsidian-disconnect-modal" role="dialog" aria-modal="true" aria-labelledby="obsidian-disconnect-title" aria-describedby="obsidian-disconnect-description" aria-busy={busy === "disconnect"}><div className="modal-header"><div><div className="panel-kicker">VAULT CONNECTION</div><h2 id="obsidian-disconnect-title">确认断开 Obsidian Vault 连接吗？</h2></div><button type="button" className="icon-button" onClick={closeDisconnectDialog} disabled={busy === "disconnect"} aria-label="关闭断开连接确认弹窗" title="关闭"><X size={19} /></button></div><p id="obsidian-disconnect-description" className="confirm-lead">断开后，Wealth Atlas 将不再连接当前 Vault。不会删除 Vault 内的文件、笔记或文件夹，也不会删除 Wealth Atlas 的财务资料。</p><div className="confirm-record-summary obsidian-disconnect-summary"><div><span>当前 Vault</span><strong>{vaultName}</strong></div><div><span>连接状态</span><strong>已连接</strong></div></div><div className="confirm-warning"><ShieldCheck size={18} /><span>只会移除 Wealth Atlas 保存的连接授权与当前连接状态；同步日志、财务资料和 Vault 内容都会保留。</span></div>{disconnectError && <div className="sync-error obsidian-disconnect-error" role="alert"><WarningCircle size={18} /><div><strong>无法断开连接</strong><span>{disconnectError}</span></div></div>}<div className="confirm-actions"><button ref={disconnectCancelRef} type="button" className="secondary-button" onClick={closeDisconnectDialog} disabled={busy === "disconnect"}>取消</button><button type="button" className="danger-button obsidian-disconnect-confirm" onClick={confirmDisconnectVault} disabled={busy === "disconnect"} aria-label="确认断开 Obsidian Vault 连接" title="确认断开连接">{busy === "disconnect" ? "正在断开…" : <><Prohibit size={17} />确认断开连接</>}</button></div></div></div> : null;

  const renderFallbackDownloads = () => <section className="panel fallback-panel"><div className="panel-title-row"><div><div className="panel-kicker">ZIP FALLBACK</div><h2>无法写入时，仍然可以带走数据</h2></div><CloudArrowDown size={20} /></div><p>浏览器没有文件夹权限时，下载的 ZIP 不会写入 Vault，也不会改变原有文件。</p><div className="download-grid"><button onClick={() => downloadScope("daily")} disabled={busy === "download"}><FileText size={18} /><span>每日 ZIP</span><small>当天 Markdown</small></button><button onClick={() => downloadScope("monthly")} disabled={busy === "download"}><FileText size={18} /><span>每月 ZIP</span><small>月度复盘 Markdown</small></button><button onClick={() => downloadScope("yearly")} disabled={busy === "download"}><FileText size={18} /><span>每年 ZIP</span><small>年度复盘 Markdown</small></button><button onClick={() => downloadScope("full")} disabled={busy === "download"}><FolderSimple size={18} /><span>完整文件夹 ZIP</span><small>Folder、模板与三类笔记</small></button></div></section>;

  const renderLogs = () => <section className="panel sync-log-panel"><div className="panel-title-row"><div><div className="panel-kicker">LOCAL SYNC LOG</div><h2>同步日志</h2></div><ShieldCheck size={20} /></div>{logs.length ? <div className="sync-log-list">{logs.slice(0, 5).map((log) => <div className="sync-log-row" key={log.id}><div className="log-time"><strong>{new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(log.syncedAt))}</strong><span>{log.vaultName || "未连接 Vault"}</span></div><div className="log-counts"><span>{log.fileCount} 文件</span><span className="positive">+{log.added} 新增</span><span>{log.updated} 更新</span><span>{log.skipped} 跳过</span><span className={log.failed ? "negative" : "positive"}>{log.failed ? `${log.failed} 失败` : "成功"}</span></div>{log.errorReason && <small className="log-error">{log.errorReason}</small>}</div>)}</div> : <div className="empty-state compact-empty"><ShieldCheck size={28} /><strong>还没有同步记录</strong><span>确认一次同步后，日志会保存在本地 IndexedDB，不保存私人文件内容。</span></div>}{latestLog?.failed ? <button className="secondary-button compact retry-button" onClick={scanVault}><ArrowClockwise size={16} /> 重试上次同步</button> : null}</section>;

  const renderPreview = () => plans ? <section className="panel sync-preview-panel"><div className="panel-title-row"><div><div className="panel-kicker">SYNC PREVIEW</div><h2>同步前变更预览</h2></div><button className="secondary-button compact" onClick={scanVault} disabled={busy === "scan"}><ArrowClockwise size={16} /> {busy === "scan" ? "扫描中…" : "重新扫描"}</button></div><div className="sync-preview-intro"><span>确认后只会写入新增文件或自动区域，现有手写内容和冲突文件都会被保护。</span><b>{plans.length} 个目标文件</b></div><div className="sync-summary"><div><strong>{plans.filter((plan) => plan.status === "new").length}</strong><span>新增文件</span></div><div><strong>{plans.filter((plan) => plan.status === "update").length}</strong><span>即将更新</span></div><div><strong>{plans.filter((plan) => plan.status === "unchanged").length}</strong><span>没有变化</span></div><div><strong>{plans.filter((plan) => plan.status === "conflict").length}</strong><span>可能冲突</span></div></div><div className="sync-file-list">{plans.map((plan) => { const Icon = statusIcon(plan.status); return <div className={`sync-file-row ${plan.status}`} key={plan.path}><div className="sync-file-icon"><Icon size={18} /></div><div className="sync-file-main"><strong>{plan.label}</strong><code>{OBSIDIAN_FOLDERS.find((folder) => plan.path.startsWith(folder)) ? `财富理财师/${plan.path}` : plan.path}</code><span>{plan.summary}</span></div><div className={`sync-file-status ${plan.status}`}>{statusLabel(plan.status)}</div><button className="text-button" onClick={() => downloadMarkdownFile(plan.content, plan.path.split("/").at(-1) ?? "wealth-atlas.md")}><CloudArrowDown size={16} /> 下载</button></div>; })}</div>{plans.some((plan) => plan.status === "conflict") && <div className="sync-warning"><WarningCircle size={18} /><span>发现没有自动区域的文件。它们不会被直接覆盖，请在 Obsidian 中手动加入标记后重新扫描。</span></div>}<div className="sync-preview-actions"><button className="secondary-button" onClick={() => setPlans(null)}><X size={17} /> 取消</button><button className="primary-button" onClick={confirmSync} disabled={busy === "sync" || plans.every((plan) => plan.status === "unchanged" || plan.status === "conflict")}>{busy === "sync" ? "同步中…" : "确认同步"}</button></div></section> : <section className="panel sync-empty-panel"><div className="empty-orbit"><LinkSimple size={26} /></div><h2>先扫描，再决定写入什么</h2><p>扫描只会在你明确点击后读取三张目标 Markdown，并生成可审阅的变更预览。没有确认，不会写入任何文件。</p><button className="primary-button" onClick={scanVault} disabled={busy === "scan"}>{busy === "scan" ? "扫描中…" : "开始扫描并生成预览"}</button><span className="sync-note"><ShieldCheck size={15} /> 不会把私人文件内容保存到 IndexedDB 或 Git</span></section>;

  const renderTemplates = () => <section className="panel template-panel"><div className="panel-title-row"><div><div className="panel-kicker">TEMPLATE STUDIO</div><h2>模板管理</h2></div><GearSix size={20} /></div><p>模板只用于生成新文件；已经存在并含有用户内容的模板不会被自动覆盖。</p><div className="template-tabs">{(Object.keys(templateLabels) as ObsidianTemplateKey[]).map((key) => <button key={key} className={selectedTemplate === key ? "active" : ""} onClick={() => setSelectedTemplate(key)}>{templateLabels[key]}</button>)}</div><textarea className="template-editor" value={templateDraft} onChange={(event) => setTemplateDraft(event.target.value)} spellCheck={false} aria-label={`${templateLabels[selectedTemplate]}内容`} /><div className="template-editor-foot"><span>支持 `{'{{date}}'}`、`{'{{month}}'}`、`{'{{year}}'}` 和自动区域标记</span><button className="primary-button compact" onClick={saveTemplate}><Check size={16} /> 保存模板</button></div></section>;

  if (mode === "settings") return <><main className="main-content module-page obsidian-page"><header className="page-header module-header"><div><div className="breadcrumb">WEALTH ATLAS / SETTINGS</div><h1>设置与模板</h1></div><div className="header-actions"><button className="secondary-button compact" onClick={() => onNavigate("home")}><ArrowLeft size={16} /> 返回首页</button></div></header>{renderConnection()}<div className="obsidian-settings-grid"><div><section className="panel folder-panel"><div className="panel-title-row"><div><div className="panel-kicker">FOLDER MAP</div><h2>连接后自动准备的 Folder</h2></div><FolderSimple size={20} /></div><div className="folder-tree"><strong>财富理财师/</strong>{OBSIDIAN_FOLDERS.map((folder) => <span key={folder}>└─ {folder}/</span>)}</div></section>{renderLogs()}</div>{renderTemplates()}</div></main>{renderDisconnectDialog()}</>;

  return <><main className="main-content module-page obsidian-page"><header className="page-header module-header"><div><div className="breadcrumb">WEALTH ATLAS / OBSIDIAN</div><h1>Obsidian 同步工作台</h1></div><div className="header-actions"><button className="secondary-button compact" onClick={() => onNavigate("settings")}><GearSix size={16} /> 设置与模板</button></div></header>{renderConnection()}<div className="obsidian-workspace"><div>{renderPreview()}{renderFallbackDownloads()}</div>{renderLogs()}</div></main>{renderDisconnectDialog()}</>;
}
