"use client";

import { useEffect, useRef, useState } from "react";
import { X, Check, ImageSquare, Trash, Plus } from "@phosphor-icons/react";
import { ACCENTS, THEMES, type Appearance } from "@/lib/appearance";
import {
  addBackground, loadActiveId, loadBackgrounds, notifyBackgroundChange,
  removeBackground, setActiveId, type BackgroundItem,
} from "@/lib/backgrounds";

interface AppearanceModalProps {
  appearance: Appearance;
  onChange: (next: Appearance) => void;
  onClose: () => void;
}

const MAX_PIXELS = 3840 * 2160; // 4K 分辨率上限
const MAX_SIZE = 30 * 1024 * 1024; // 30MB 硬上限（防异常）

export default function AppearanceModal({ appearance, onChange, onClose }: AppearanceModalProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [backgrounds, setBackgrounds] = useState<BackgroundItem[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [bgError, setBgError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadBackgrounds().then((list) => { if (!cancelled) setBackgrounds(list); });
    setActiveIdState(loadActiveId());
    return () => { cancelled = true; };
  }, []);

  const pickBackground = (item: BackgroundItem | null) => {
    const id = item ? item.id : null;
    setActiveId(id);
    setActiveIdState(id);
    notifyBackgroundChange();
  };

  const handleUpload = (file: File) => {
    setBgError(null);
    if (!file) return;
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isImage && !isVideo) { setBgError("只支持图片、动图或视频文件"); return; }
    if (file.size > MAX_SIZE) { setBgError("文件超过 30MB"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const proceed = () => {
        addBackground(file.name, dataUrl).then((next) => {
          setBackgrounds(next);
          const added = next[0];
          if (added) pickBackground(added);
        });
      };
      if (isVideo) { proceed(); return; } // 视频跳过 4K 像素校验
      const img = new Image();
      img.onload = () => {
        if (img.width * img.height > MAX_PIXELS) {
          setBgError(`图片超过 4K 分辨率（${img.width}×${img.height}）`);
          return;
        }
        proceed();
      };
      img.onerror = () => { setBgError("无法读取图片尺寸"); };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleRemove = (id: string) => {
    removeBackground(id).then((next) => {
      setBackgrounds(next);
      if (activeId === id) {
        setActiveIdState(null);
        notifyBackgroundChange();
      }
    });
  };

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

        <div className="appearance-group">
          <label className="appearance-label">背景（图片 / 动图 · 最高 4K · 保留 10 张）</label>
          <div className="bg-history">
            <button type="button" className={"bg-thumb" + (activeId === null ? " on" : "")} onClick={() => pickBackground(null)} aria-label="无背景" title="无背景">
              <span className="bg-thumb-none"><X size={16} /></span>
            </button>
            {backgrounds.map((item) => (
              <div className={"bg-thumb-wrap" + (activeId === item.id ? " on" : "")} key={item.id}>
                <button type="button" className="bg-thumb" onClick={() => pickBackground(item)} aria-label={`使用背景 ${item.name}`} title={item.name}>
                  <img src={item.dataUrl} alt={item.name} />
                </button>
                <button type="button" className="bg-thumb-del" onClick={() => handleRemove(item.id)} aria-label={`删除背景 ${item.name}`} title="删除"><Trash size={11} /></button>
              </div>
            ))}
            <button type="button" className="bg-upload" onClick={() => fileRef.current?.click()} aria-label="上传背景" title="上传背景">
              <Plus size={16} weight="bold" />
            </button>
          </div>
          {bgError && <span className="bg-error">{bgError}</span>}
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ""; }}
          />
          <div className="appearance-hint" style={{ marginTop: 8 }}><ImageSquare size={14} /> 支持图片、动图 GIF 与视频，最高 4K。</div>
        </div>
      </div>
    </div>
  );
}
