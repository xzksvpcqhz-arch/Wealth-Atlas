"use client";

import { Component, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { ArrowClockwise, ClipboardText, FloppyDisk, FolderOpen, ShieldWarning } from "@phosphor-icons/react";
import { createSafeDiagnostic, formatDiagnostic, reportSafeDiagnostic, reportStartupStage, type SafeDiagnostic } from "@/lib/diagnostics";
import { getDesktopBridge } from "@/lib/desktop";

type Props = { children: ReactNode };
type State = { diagnostic: SafeDiagnostic | null };

type DiagnosticFailurePanelProps = {
  diagnostic: SafeDiagnostic;
  onRetry?: () => void | Promise<void>;
};

export function DiagnosticFailurePanel({ diagnostic, onRetry }: DiagnosticFailurePanelProps) {
  const diagnosticText = useMemo(() => formatDiagnostic(diagnostic), [diagnostic]);
  const manualCopyRef = useRef<HTMLTextAreaElement>(null);
  const restartRequestedRef = useRef(false);
  const actionRequestedRef = useRef<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manualCopyVisible, setManualCopyVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [openingLogs, setOpeningLogs] = useState(false);
  const [openingBackups, setOpeningBackups] = useState(false);
  const [savedFileName, setSavedFileName] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const revealManualCopy = (message: string) => {
    setManualCopyVisible(true);
    setActionMessage(null);
    setActionError(message);
    window.setTimeout(() => {
      manualCopyRef.current?.focus();
      manualCopyRef.current?.select();
    }, 0);
  };

  const copyDiagnostic = async () => {
    if (copying) return;
    setCopying(true);
    setCopied(false);
    setActionError(null);
    setActionMessage(null);

    try {
      if (!navigator.clipboard?.writeText) throw new Error("Browser clipboard API is unavailable.");
      await navigator.clipboard.writeText(diagnosticText);
      setCopied(true);
      setActionMessage("诊断信息已复制");
      return;
    } catch {
      try {
        const bridge = getDesktopBridge();
        if (!bridge) throw new Error("Desktop clipboard bridge is unavailable.");
        await bridge.copyDiagnostic(diagnostic);
        setCopied(true);
        setActionMessage("诊断信息已复制");
        return;
      } catch {
        revealManualCopy("自动复制不可用。诊断文字已显示，请在文字框内按 Ctrl + A，再按 Ctrl + C。");
      }
    } finally {
      setCopying(false);
    }
  };

  const saveDiagnostic = async () => {
    if (saving) return;
    setSaving(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const bridge = getDesktopBridge();
      if (!bridge) throw new Error("Diagnostic file saving is available in the desktop app.");
      const result = await bridge.saveDiagnostic(diagnostic);
      setSavedFileName(result.fileName);
      setActionMessage("诊断文件已保存到 Wealth Atlas 日志文件夹");
    } catch {
      revealManualCopy("无法保存诊断文件。请使用下方手动复制区域，或稍后打开日志位置查看现有日志。");
    } finally {
      setSaving(false);
    }
  };

  const openLocation = async (kind: "logs" | "backups") => {
    if (actionRequestedRef.current) return;
    actionRequestedRef.current = kind;
    if (kind === "logs") setOpeningLogs(true);
    else setOpeningBackups(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const bridge = getDesktopBridge();
      if (!bridge) throw new Error("Desktop location is unavailable.");
      if (kind === "logs") await bridge.openLogsLocation();
      else await bridge.openBackupsLocation();
    } catch {
      setActionError(kind === "logs"
        ? "无法打开日志位置。日志位于 %APPDATA%\\Wealth Atlas\\logs。"
        : "无法打开备份位置。备份位于 %APPDATA%\\Wealth Atlas\\backups。");
    } finally {
      actionRequestedRef.current = null;
      if (kind === "logs") setOpeningLogs(false);
      else setOpeningBackups(false);
    }
  };

  const restartApp = async () => {
    if (restartRequestedRef.current) return;
    restartRequestedRef.current = true;
    setRestarting(true);
    setActionError(null);
    try {
      const bridge = getDesktopBridge();
      if (bridge) await bridge.restartApp();
      else window.location.reload();
    } catch (error) {
      await reportSafeDiagnostic("restart-app", error);
      restartRequestedRef.current = false;
      setRestarting(false);
      setActionError("无法自动重新启动，请关闭 Wealth Atlas 后再打开。");
    }
  };

  const retryStartup = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    setActionError(null);
    setActionMessage(null);
    try {
      await onRetry();
    } catch {
      setActionError("重新尝试仍未成功。原有资料没有被清除，请保留诊断信息和备份。");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <main className="app-failure-shell" role="alert">
      <div className="starfield" />
      <section className="panel app-failure-panel" aria-labelledby="app-failure-title">
        <div className="app-failure-icon"><ShieldWarning size={28} weight="fill" /></div>
        <div className="app-failure-copy">
          <span>Wealth Atlas {diagnostic.appVersion}</span>
          <h1 id="app-failure-title">Wealth Atlas 暂时无法完成启动</h1>
          <p>你的本地财务资料没有被自动删除。可以先重新尝试或重新启动；诊断工具只包含技术错误信息，不包含账户、余额或交易内容。</p>
        </div>

        <dl className="app-failure-details">
          <div><dt>错误 ID</dt><dd>{diagnostic.id}</dd></div>
          <div><dt>错误名称</dt><dd>{diagnostic.name}</dd></div>
          <div><dt>启动阶段</dt><dd>{diagnostic.stage}</dd></div>
          <div><dt>Schema</dt><dd>{diagnostic.schemaVersion}</dd></div>
          <div><dt>启动模式</dt><dd>{diagnostic.mode}</dd></div>
          <div><dt>资料备份</dt><dd>%APPDATA%\Wealth Atlas\backups</dd></div>
        </dl>

        <p className="app-failure-guidance">请不要删除 <code>%APPDATA%\Wealth Atlas</code>，也不要清空 IndexedDB。恢复资料前必须先验证备份，并由你明确确认。</p>

        {actionMessage ? <p className="app-failure-action-success" role="status">{actionMessage}{savedFileName ? "：" + savedFileName : ""}</p> : null}
        {actionError ? <p className="app-failure-action-error" role="status">{actionError}</p> : null}

        <div className="app-failure-actions">
          {onRetry ? (
            <button type="button" className="primary-button" onClick={retryStartup} disabled={retrying} aria-label="重新尝试读取本地资料">
              <ArrowClockwise size={17} />{retrying ? "正在重新尝试…" : "重新尝试"}
            </button>
          ) : null}
          <button type="button" className={onRetry ? "secondary-button" : "primary-button"} onClick={restartApp} disabled={restarting} aria-label="重新启动 Wealth Atlas">
            <ArrowClockwise size={17} />{restarting ? "正在重新启动…" : "重新启动"}
          </button>
          <button type="button" className="secondary-button" onClick={copyDiagnostic} disabled={copying} aria-label="复制安全诊断信息">
            <ClipboardText size={17} />{copying ? "正在复制…" : copied ? "诊断信息已复制" : "复制诊断信息"}
          </button>
          <button type="button" className="secondary-button" onClick={() => setManualCopyVisible((visible) => !visible)} aria-expanded={manualCopyVisible} aria-controls="manual-diagnostic-copy">
            <ClipboardText size={17} />手动复制
          </button>
          <button type="button" className="secondary-button" onClick={saveDiagnostic} disabled={saving} aria-label="保存安全诊断文件">
            <FloppyDisk size={17} />{saving ? "正在保存…" : "保存诊断文件"}
          </button>
          <button type="button" className="secondary-button" onClick={() => void openLocation("logs")} disabled={openingLogs} aria-label="打开诊断文件位置">
            <FolderOpen size={17} />{openingLogs ? "正在打开…" : "打开日志位置"}
          </button>
          <button type="button" className="secondary-button" onClick={() => void openLocation("backups")} disabled={openingBackups} aria-label="打开资料备份位置">
            <FolderOpen size={17} />{openingBackups ? "正在打开…" : "打开备份位置"}
          </button>
        </div>

        {manualCopyVisible ? (
          <div className="app-failure-manual" id="manual-diagnostic-copy">
            <label htmlFor="manual-diagnostic-text">手动复制诊断文字</label>
            <p>点击文字框后按 Ctrl + A，再按 Ctrl + C。这里不会显示财务资料。</p>
            <textarea
              ref={manualCopyRef}
              id="manual-diagnostic-text"
              value={diagnosticText}
              readOnly
              rows={10}
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        ) : null}

        <details className="app-failure-recovery">
          <summary>查看恢复说明</summary>
          <p>恢复不会自动开始。请先保留原始资料和备份，在临时副本中验证成功后，再由你确认是否写回应用资料。</p>
        </details>
      </section>
    </main>
  );
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { diagnostic: null };

  static getDerivedStateFromError(error: Error): State {
    return { diagnostic: createSafeDiagnostic("react-render", error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const combined = new Error(error.message);
    combined.name = error.name;
    combined.stack = [error.stack, info.componentStack].filter(Boolean).join("\n");
    void reportSafeDiagnostic("react-render", combined).then((diagnostic) => {
      this.setState({ diagnostic });
      void reportStartupStage("react-initialization", "failed", diagnostic.id);
    });
  }

  render() {
    if (!this.state.diagnostic) return this.props.children;
    return <DiagnosticFailurePanel diagnostic={this.state.diagnostic} />;
  }
}
