"use client";

import { X, Check } from "@phosphor-icons/react";
import { ACCENTS, THEMES, type Appearance } from "@/lib/appearance";

interface AppearanceModalProps {
  appearance: Appearance;
  onChange: (next: Appearance) => void;
  onClose: () => void;
}

export default function AppearanceModal({ appearance, onChange, onClose }: AppearanceModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div className="modal appearance-modal" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
        <div className="modal-header">
          <div>
            <div className="panel-kicker">WEALTH ATLAS / APPEARANCE</div>
            <h2 id="appearance-title">外观</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭外观设置" title="关闭"><X size={19} /></button>
        </div>

        <div className="appearance-group">
          <label className="appearance-label">主题</label>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button
                type="button"
                key={t.id}
                className={"theme-card" + (appearance.theme === t.id ? " on" : "")}
                onClick={() => onChange({ ...appearance, theme: t.id })}
                aria-pressed={appearance.theme === t.id}
              >
                <span className="theme-swatch" style={{ background: t.swatch }}>
                  {appearance.theme === t.id && <Check size={14} weight="bold" />}
                </span>
                <span className="theme-name">{t.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="appearance-group">
          <label className="appearance-label">强调色</label>
          <div className="accent-row">
            {ACCENTS.map((a) => (
              <button
                type="button"
                key={a.id}
                className={"accent-dot" + (appearance.accent === a.id ? " on" : "")}
                style={{ background: a.color }}
                onClick={() => onChange({ ...appearance, accent: a.id })}
                aria-label={`强调色 ${a.name}`}
                aria-pressed={appearance.accent === a.id}
                title={a.name}
              >
                {appearance.accent === a.id && <Check size={14} weight="bold" />}
              </button>
            ))}
          </div>
        </div>

        <div className="appearance-group appearance-glass">
          <div>
            <label className="appearance-label">玻璃面板</label>
            <span className="appearance-hint">侧栏 / 弹窗 / 顶部工具栏的毛玻璃质感</span>
          </div>
          <button
            type="button"
            className={"toggle-btn" + (appearance.panels === "glass" ? " on" : "")}
            onClick={() => onChange({ ...appearance, panels: appearance.panels === "glass" ? "standard" : "glass" })}
            aria-pressed={appearance.panels === "glass"}
          >
            {appearance.panels === "glass" ? "开" : "关"}
          </button>
        </div>
      </div>
    </div>
  );
}
