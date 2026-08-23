"use client";

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { ArrowClockwise, Database, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import { getDesktopBridge, type BackupEntry } from "@/lib/desktop";
import { normalizeAssets } from "@/lib/asset-normalization";
import { getWealthDataSchemaVersion, migrateWealthData } from "@/lib/migrations";
import { parseSnapshot } from "@/lib/snapshot-backup";
import type { WealthData } from "@/lib/types";

function formatTime(value: string | null) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(date);
}

export default function BackupRestorePanel({ data, setData, onToast }: {
  data: WealthData;
  setData: Dispatch<SetStateAction<WealthData>>;
  onToast: (message: string) => void;
}) {
  const [entries, setEntries] = useState<BackupEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<BackupEntry | null>(null);
  const [restoring, setRestoring] = useState(false);

  const refresh = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge) { setEntries([]); return; }
    setLoading(true);
    setError("");
    try {
      setEntries(await bridge.listBackups());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取备份列表");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const doRestore = async () => {
    if (!confirmTarget) return;
    const bridge = getDesktopBridge();
    if (!bridge) return;
    setRestoring(true);
    setError("");
    try {
      // 恢复前先把「当前数据」再留一份 autosave，让恢复操作本身可反悔。
      await bridge.writeAutosave({ snapshot: data, schemaVersion: getWealthDataSchemaVersion(data) });
      const snapshot = await bridge.readBackup(confirmTarget.id, confirmTarget.kind);
      const next = migrateWealthData(parseSnapshot(snapshot));
      const assetMigration = normalizeAssets(next.assets);
      setData({
        ...next,
        assets: assetMigration.normalized,
        assetMigrationBackups: [
          ...(next.assetMigrationBackups ?? []),
          ...assetMigration.backups.filter((backup) => !(next.assetMigrationBackups ?? []).some((item) => item.assetId === backup.assetId)),
        ],
      });
      setConfirmTarget(null);
      onToast("已从备份恢复，资料已重新载入");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复失败");
    } finally {
      setRestoring(false);
    }
  };

  return <main className="main-content module-page backup-restore-page">
    <header className="page-header module-header">
      <div>
        <div className="breadcrumb">WEALTH ATLAS / SETTINGS</div>
        <h1>备份与恢复</h1>
      </div>
      <button className="secondary-button compact" onClick={() => void refresh()} disabled={loading} aria-label="刷新备份列表" title="刷新备份列表">
        <ArrowClockwise size={16} /> {loading ? "读取中…" : "刷新"}
      </button>
    </header>

    <section className="panel">
      <div className="panel-title-row">
        <div><div className="panel-kicker">LOCAL RECOVERY</div><h2>本地快照与更新备份</h2></div>
        <ShieldCheck size={20} />
      </div>
      <p className="backup-intro">
        每次修改会自动在本机留存快照（保留最近 10 份），每次更新/迁移前也会自动备份。选择一份即可把资料完整还原。
      </p>

      {error && <div className="sync-error" role="alert"><WarningCircle size={18} /><div><strong>需要处理</strong><span>{error}</span></div></div>}

      {entries === null ? <div className="empty-state compact-empty"><Database size={28} /><strong>正在读取备份…</strong></div>
        : entries.length === 0 ? <div className="empty-state compact-empty"><Database size={28} /><strong>还没有本地备份</strong><span>改动过资料后，快照会自动出现在这里。</span></div>
        : <div className="backup-list">
          {entries.map((entry) => <div className="backup-row" key={`${entry.kind}-${entry.id}`}>
            <div className="backup-row-main">
              <strong>{formatTime(entry.createdAt)}</strong>
              <span>{entry.kind === "autosave" ? "自动快照" : "更新/迁移备份"} · v{entry.appVersion || "未知"} · schema {entry.schemaVersion ?? "—"}</span>
            </div>
            <button type="button" className="secondary-button compact" onClick={() => setConfirmTarget(entry)} aria-label={`恢复 ${formatTime(entry.createdAt)} 的备份`} title="恢复此备份">恢复</button>
          </div>)}
        </div>}
    </section>

    {confirmTarget && <div className="modal-backdrop" role="presentation" onPointerDown={(event) => { if (event.currentTarget === event.target && !restoring) setConfirmTarget(null); }}>
      <div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="restore-title">
        <div className="modal-header">
          <div><div className="panel-kicker">RESTORE BACKUP</div><h2 id="restore-title">确认恢复这份备份吗？</h2></div>
        </div>
        <p className="confirm-lead">{formatTime(confirmTarget.createdAt)}</p>
        <div className="confirm-record-summary">
          <div><span>类型</span><strong>{confirmTarget.kind === "autosave" ? "自动快照" : "更新/迁移备份"}</strong></div>
          <div><span>版本</span><strong>v{confirmTarget.appVersion || "未知"}</strong></div>
        </div>
        <div className="confirm-warning"><ShieldCheck size={18} /><span>恢复会用这份备份覆盖当前资料。恢复前会自动把当前资料另存一份，你仍可再改回来。</span></div>
        <div className="confirm-actions">
          <button type="button" className="secondary-button" onClick={() => setConfirmTarget(null)} disabled={restoring}>取消</button>
          <button type="button" className="primary-button" onClick={() => void doRestore()} disabled={restoring} aria-label="确认恢复" title="确认恢复">{restoring ? "恢复中…" : "确认恢复"}</button>
        </div>
      </div>
    </div>}
  </main>;
}
