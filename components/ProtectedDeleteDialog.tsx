"use client";

import type { ReactNode } from "react";
import { ShieldCheck, Trash, X } from "@phosphor-icons/react";

type ProtectedDeleteDialogProps = {
  title: string;
  titleId: string;
  lead: ReactNode;
  warning: ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  isProcessing: boolean;
  summary?: ReactNode;
};

/**
 * Shared protected-action boundary for local user-created records.
 * It deliberately reuses the established confirmation surface instead of
 * introducing a second modal design or relying on browser confirm dialogs.
 */
export default function ProtectedDeleteDialog({
  title,
  titleId,
  lead,
  warning,
  confirmLabel,
  onCancel,
  onConfirm,
  isProcessing,
  summary,
}: ProtectedDeleteDialogProps) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!isProcessing && event.currentTarget === event.target) onCancel();
      }}
    >
      <div className="modal confirm-modal danger-confirm-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-header">
          <div>
            <div className="panel-kicker">LOCAL DATA PROTECTION</div>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onCancel} disabled={isProcessing} aria-label={`关闭${title}`} title="关闭">
            <X size={19} />
          </button>
        </div>
        <p className="confirm-lead">{lead}</p>
        {summary}
        <div className="confirm-warning">
          <ShieldCheck size={18} />
          <span>{warning}</span>
        </div>
        <div className="confirm-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={isProcessing}>
            取消
          </button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={isProcessing} aria-label={confirmLabel} title={confirmLabel}>
            {isProcessing ? "处理中…" : <><Trash size={17} />{confirmLabel}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
