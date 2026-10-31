"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowCounterClockwise, ArrowClockwise, ArrowsOutSimple, Check, DotsSixVertical, Eye, EyeSlash, SlidersHorizontal } from "@phosphor-icons/react";
import { createDisplayPreferences, HOME_MODULES, SIDEBAR_ITEMS, type DisplayDevice, type DisplayPreferences, type ModulePreference } from "@/lib/display-preferences";
import type { DisplayPreferenceController } from "@/lib/use-display-preferences";
import styles from "./HomeCustomization.module.css";

export type DisplayModule = { id: string; label: string; children: ReactNode };
const deviceNames: Record<DisplayDevice, string> = { desktop: "桌面", tablet: "平板", mobile: "手机" };
const motions = [["none", "无动画"], ["fade", "基础淡入"], ["up", "向上淡入"], ["down", "向下淡入"], ["left", "从左淡入"], ["right", "从右淡入"], ["spring", "轻弹簧落位"], ["zoom", "柔和缩放"], ["reveal", "展开显现（说明）"]] as const;

export function useDisplayDevice(): DisplayDevice {
  const [device, setDevice] = useState<DisplayDevice>("desktop");
  useEffect(() => {
    const update = () => setDevice(window.innerWidth < 641 ? "mobile" : window.innerWidth < 1101 ? "tablet" : "desktop");
    update(); window.addEventListener("resize", update); return () => window.removeEventListener("resize", update);
  }, []);
  return device;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => { const media = matchMedia("(prefers-reduced-motion: reduce)"); const update = () => setReduced(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  return reduced;
}

function DisplayCard({ module, item, editing = false, delay = 0, replay = 0, stagger = false, onToggleDetails }: { module: DisplayModule; item: ModulePreference; editing?: boolean; delay?: number; replay?: number; stagger?: boolean; onToggleDetails?: () => void }) {
  const content = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const detailsId = useId();
  const [localExpanded, setLocalExpanded] = useState(item.detailsExpanded);
  useEffect(() => setLocalExpanded(item.detailsExpanded), [item.detailsExpanded]);
  const expanded = editing ? item.detailsExpanded : localExpanded;
  useEffect(() => {
    const target = content.current;
    if (!target || reduced) return;
    const preset = stagger && ["none", "reveal"].includes(item.motion) ? "fade" : item.motion;
    const frames: Record<string, Keyframe[]> = {
      fade: [{ opacity: .45 }, { opacity: 1 }], up: [{ opacity: .45, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }],
      down: [{ opacity: .45, transform: "translateY(-16px)" }, { opacity: 1, transform: "none" }], left: [{ opacity: .45, transform: "translateX(-16px)" }, { opacity: 1, transform: "none" }],
      right: [{ opacity: .45, transform: "translateX(16px)" }, { opacity: 1, transform: "none" }], zoom: [{ opacity: .5, transform: "scale(.96)" }, { opacity: 1, transform: "none" }],
      spring: [{ opacity: .5, transform: "translateY(12px) scale(.98)", offset: 0 }, { opacity: 1, transform: "translateY(-1px) scale(1.002)", offset: .75 }, { opacity: 1, transform: "none", offset: 1 }],
    };
    if (!frames[preset]) return;
    try { const animation = target.animate(frames[preset], { duration: item.duration, delay, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" }); void animation.finished.catch(() => {}); return () => animation.cancel(); }
    catch { /* An unsupported animation never hides the content or breaks startup. */ }
  }, [item.motion, item.duration, replay, reduced, delay, stagger]);

  useEffect(() => {
    const root = content.current;
    if (!root) return;
    const fit = () => {
      for (const value of root.querySelectorAll<HTMLElement>(".stat-value,.hero-number,.diy-money,.home-rate-panel>strong")) {
        value.style.fontSize = `${item.amount}px`;
        if (value.clientWidth && value.scrollWidth > value.clientWidth) value.style.fontSize = `${Math.max(16, Math.floor(item.amount * value.clientWidth / value.scrollWidth) - 1)}px`;
      }
    };
    const observer = new ResizeObserver(fit); observer.observe(root); fit(); return () => observer.disconnect();
  }, [item.amount, item.width, item.padding]);

  const variables = { "--diy-title": `${item.title}px`, "--diy-amount": `${item.amount}px`, "--diy-body": `${item.body}px`, "--diy-padding": `${item.padding}px`, "--diy-title-weight": item.titleWeight, "--diy-amount-weight": item.amountWeight, "--diy-body-weight": item.bodyWeight, "--diy-duration": `${item.duration}ms`, minHeight: item.height } as CSSProperties;
  return <div className={styles.cardContent} style={variables}>
    <div ref={content} className={styles.content} inert={editing || undefined}>{module.children}</div>
    {item.motion === "reveal" && <div className={styles.explanation}>
      <div id={detailsId} className={styles.details} data-expanded={expanded} aria-hidden={!expanded}><div><p>此模块显示现有{module.label}结果。调整显示不会修改账户、交易、历史汇率或计算依据。</p></div></div>
      <button type="button" className="secondary-button compact" aria-controls={detailsId} aria-expanded={expanded} title={expanded ? "收起说明" : "展开说明"} onClick={() => editing ? onToggleDetails?.() : setLocalExpanded(value => !value)}>{expanded ? "收起说明" : "展开说明"}</button>
    </div>}
  </div>;
}

export function HomeDiyGrid({ modules, preferences, device, editing = false, selected, onSelect, onMove, onResize, onToggleDetails, replays }: { modules: DisplayModule[]; preferences: DisplayPreferences; device: DisplayDevice; editing?: boolean; selected?: string; onSelect?: (id: string) => void; onMove?: (from: string, to: string) => void; onResize?: (id: string, width: number, height: number) => void; onToggleDetails?: (id: string) => void; replays?: Record<string, number> }) {
  const layout = preferences.devices[device];
  const visible = layout.items.filter(item => item.visible);
  const dragId = useRef<string | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => { resizeCleanup.current?.(); dragId.current = null; }, [device, editing, preferences]);
  return <div className={styles.grid} data-device={device} style={{ gap: layout.gap }} aria-label="自定义首页模块">
    {visible.map((item, index) => {
      const module = modules.find(module => module.id === item.id);
      if (!module) return null;
      return <section key={item.id} data-home-module={item.id} className={`${styles.card} ${editing && selected === item.id ? styles.selected : ""}`} style={{ gridColumn: `span ${device === "mobile" ? 12 : device === "tablet" ? Math.max(6, item.width) : item.width}` }}
        onDragOver={event => { if (editing && dragId.current) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (dragId.current && dragId.current !== item.id) onMove?.(dragId.current, item.id); dragId.current = null; }}>
        <DisplayCard module={module} item={item} editing={editing} delay={layout.groupMotion === "stagger" ? Math.round(index / Math.max(1, visible.length - 1) * 200) : 0} stagger={layout.groupMotion === "stagger"} replay={replays?.[item.id] ?? 0} onToggleDetails={() => onToggleDetails?.(item.id)} />
        {editing && <>
          <button type="button" className={styles.dragHandle} draggable title={`拖动${module.label}，也可使用属性中的前移／后移`} aria-label={`选择并拖动${module.label}`} onClick={() => onSelect?.(item.id)} onDragStart={event => { dragId.current = item.id; event.dataTransfer.setData("text/plain", item.id); }} onDragEnd={() => { dragId.current = null; }}><DotsSixVertical size={17} /></button>
          <button type="button" className={styles.resizeHandle} title="方向键调整卡片宽高" aria-label={`调整${module.label}尺寸，左右调宽，上下调高`} onClick={() => onSelect?.(item.id)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault();
            const widths = [4, 6, 8, 12], current = widths.indexOf(item.width);
            onResize?.(item.id, event.key === "ArrowLeft" ? widths[Math.max(0, current - 1)] : event.key === "ArrowRight" ? widths[Math.min(3, current + 1)] : item.width, Math.max(144, Math.min(400, item.height + (event.key === "ArrowUp" ? -8 : event.key === "ArrowDown" ? 8 : 0))));
          }} onPointerDown={event => {
            if (device === "mobile" || event.button !== 0 || !event.isPrimary || resizeCleanup.current) return;
            event.preventDefault();
            const button = event.currentTarget, card = button.closest<HTMLElement>("[data-home-module]")!, body = card.firstElementChild as HTMLElement;
            const startX = event.clientX, startY = event.clientY, pointer = event.pointerId;
            const gridWidth = button.closest(`.${styles.grid}`)?.getBoundingClientRect().width ?? 1;
            const originalColumn = card.style.gridColumn, originalHeight = body.style.minHeight;
            let width = item.width, height = item.height;
            const move = (next: PointerEvent) => {
              if (next.pointerId !== pointer) return;
              const columns = item.width + (next.clientX - startX) / gridWidth * 12;
              width = [4, 6, 8, 12].reduce((best, value) => Math.abs(value - columns) < Math.abs(best - columns) ? value : best, 4);
              height = Math.max(144, Math.min(400, Math.round(item.height + next.clientY - startY)));
              card.style.gridColumn = `span ${device === "tablet" ? Math.max(6, width) : width}`;
              body.style.minHeight = `${height}px`;
            };
            const cleanup = () => {
              window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", cancel);
              button.removeEventListener("lostpointercapture", end); card.style.gridColumn = originalColumn; body.style.minHeight = originalHeight;
              resizeCleanup.current = null;
              try { if (button.hasPointerCapture(pointer)) button.releasePointerCapture(pointer); } catch { /* Capture may already have been released. */ }
            };
            const cancel = () => cleanup();
            const end = (next: PointerEvent) => {
              if (next.pointerId !== pointer) return;
              if (next.type === "pointerup") move(next);
              cleanup();
              if (next.type === "pointerup") onResize?.(item.id, width, height);
            };
            resizeCleanup.current = cleanup;
            window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end); window.addEventListener("blur", cancel);
            button.addEventListener("lostpointercapture", end);
            try { button.setPointerCapture(pointer); } catch { cleanup(); }
          }}><ArrowsOutSimple size={17} /></button>
        </>}
      </section>;
    })}
    {!visible.length && <div className={styles.empty}><strong>全部首页模块已隐藏，资料没有删除。</strong><p>请从“已隐藏模块”逐一加回，或恢复默认首页排版。</p></div>}
  </div>;
}

function NumberControl({ label, value, min, max, unit = "px", onChange, onInvalid }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (value: number) => void; onInvalid: (invalid: boolean) => void }) {
  const [text, setText] = useState(String(value)), [error, setError] = useState(false);
  const id = useId();
  useEffect(() => { setText(String(value)); setError(false); onInvalid(false); }, [value, onInvalid]);
  const commit = (raw = text) => { const number = Number(raw); const invalid = !raw.trim() || !Number.isInteger(number) || number < min || number > max; setError(invalid); onInvalid(invalid); if (!invalid) onChange(number); };
  return <div className={styles.numberControl}><div><label htmlFor={id}>{label}</label><span><input id={id} type="number" required min={min} max={max} step="1" inputMode="numeric" value={text} aria-label={`手动输入${label}（${unit}）`} aria-invalid={error} aria-describedby={error ? `${id}-error` : undefined} onChange={event => setText(event.target.value)} onBlur={event => commit(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(event.currentTarget.value); } if (event.key === "Escape") { setText(String(value)); setError(false); onInvalid(false); } }} />{unit}</span></div><input type="range" min={min} max={max} value={value} aria-label={label} onChange={event => { setError(false); onInvalid(false); onChange(Number(event.target.value)); }} />{error && <p id={`${id}-error`} role="status">请输入 {min}–{max} 的整数 {unit}，原设置未改变。</p>}</div>;
}

export function HomeDiyEditor({ controller: c, modules, initialDevice, onClose }: { controller: DisplayPreferenceController; modules: DisplayModule[]; initialDevice: DisplayDevice; onClose: () => void }) {
  const [device, setDevice] = useState(initialDevice), [selected, setSelected] = useState("free"), [panel, setPanel] = useState("canvas"), [replays, setReplays] = useState<Record<string, number>>({});
  const visibilityFocus = useRef<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<Set<string>>(new Set());
  const layout = c.draft.devices[device], item = layout.items.find(value => value.id === selected)!;
  const updateItem = (change: (item: ModulePreference) => void) => c.update(next => { next.devices[device].enabled = true; change(next.devices[device].items.find(value => value.id === selected)!); });
  const move = (id: string, to: string) => c.update(next => { const items = next.devices[device].items, from = items.findIndex(item => item.id === id), index = items.findIndex(item => item.id === to); if (from < 0 || index < 0) return; items.splice(index, 0, ...items.splice(from, 1)); next.devices[device].enabled = true; });
  const markInvalid = useRef(new Map<string, (invalid: boolean) => void>());
  const invalidCallback = (key: string) => { if (!markInvalid.current.has(key)) markInvalid.current.set(key, invalid => setInvalidFields(current => { const next = new Set(current); invalid ? next.add(key) : next.delete(key); return next; })); return markInvalid.current.get(key)!; };
  useEffect(() => { setInvalidFields(new Set()); }, [selected, device]);
  const changeVisibility = (id: string, visible: boolean) => { visibilityFocus.current = id; c.update(next => { next.devices[device].enabled = true; next.devices[device].items.find(item => item.id === id)!.visible = visible; }); };
  useEffect(() => { if (visibilityFocus.current) { document.querySelector<HTMLButtonElement>(`[data-module-visibility="${visibilityFocus.current}"]`)?.focus(); visibilityFocus.current = null; } }, [layout.items]);
  const select = (id: string) => { setSelected(id); setPanel("inspector"); };
  const play = () => { if (item.motion === "reveal") updateItem(next => { next.detailsExpanded = !next.detailsExpanded; }); else setReplays(value => ({ ...value, [selected]: (value[selected] ?? 0) + 1 })); setPanel("canvas"); };
  useEffect(() => { const key = (event: KeyboardEvent) => { if ((event.target as HTMLElement)?.matches("input,select,textarea,[contenteditable]")) return; if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? c.redo() : c.undo(); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [c.undo, c.redo]);
  const step = (delta: number) => { const index = layout.items.findIndex(value => value.id === selected), target = layout.items[index + delta]; if (target) move(selected, target.id); };
  return <main className={styles.editor} data-panel={panel} aria-label="首页自定义排版编辑器">
    <header className={styles.toolbar}><div><h1>首页自定义排版</h1><p>只改变显示，不改变金额和计算。编辑模式中的财务按钮不执行操作。</p></div><div className={styles.actions}><button type="button" className="secondary-button" disabled={!c.canUndo} onClick={c.undo} aria-label="撤销排版修改"><ArrowCounterClockwise size={16} /></button><button type="button" className="secondary-button" disabled={!c.canRedo} onClick={c.redo} aria-label="重做排版修改"><ArrowClockwise size={16} /></button><button type="button" className="secondary-button" onClick={() => { c.cancel(); onClose(); }}>取消修改</button><button type="button" className="primary-button" disabled={!c.ready || !c.readable || invalidFields.size > 0} onClick={event => { const fields = event.currentTarget.closest("main")?.querySelectorAll<HTMLInputElement>('input[type="number"]'); const invalid = Array.from(fields ?? []).find(field => !field.checkValidity() || !field.value.trim()); if (invalid) { setPanel("inspector"); invalid.reportValidity(); return; } if (c.save()) onClose(); }}><Check size={16} />保存排版</button><button type="button" className="secondary-button" onClick={onClose}>返回设置，保留草稿</button></div></header>
    <div className={styles.status} role="status">{c.message || (c.dirty ? "有未保存的显示修改。" : "当前显示方案已保持。 ")} {c.syncMessage}</div>
    <nav className={styles.mobileTabs} aria-label="编辑器面板">{[["library", "模块"], ["canvas", "画布"], ["inspector", "属性"]].map(([id, text]) => <button type="button" key={id} aria-pressed={panel === id} onClick={() => setPanel(id)}>{text}</button>)}</nav>
    <div className={styles.shell}>
      <aside className={styles.library} aria-label="首页模块"><h2>首页模块</h2><p>隐藏只是收起模块，随时可以加回来。</p>{layout.items.filter(item => item.visible).map(item => <div className={styles.moduleRow} key={item.id}><button type="button" aria-pressed={selected === item.id} onClick={() => select(item.id)}>{HOME_MODULES.find(module => module.id === item.id)!.label}</button><button type="button" data-module-visibility={item.id} title={`隐藏${HOME_MODULES.find(module => module.id === item.id)!.label}`} aria-label={`隐藏${HOME_MODULES.find(module => module.id === item.id)!.label}`} onClick={() => changeVisibility(item.id, false)}><Eye size={17} /></button></div>)}
        <h3>已隐藏模块</h3>{layout.items.filter(item => !item.visible).map(item => <div className={styles.hiddenRow} key={item.id}><span>{HOME_MODULES.find(module => module.id === item.id)!.label}</span><button type="button" data-module-visibility={item.id} onClick={() => changeVisibility(item.id, true)} aria-label={`加回首页${HOME_MODULES.find(module => module.id === item.id)!.label}`}>加回首页</button></div>)}
        {!layout.items.some(item => !item.visible) && <p>没有隐藏的首页模块。</p>}<button type="button" className="secondary-button" onClick={() => c.update(next => { next.devices[device] = createDisplayPreferences().devices[device]; })}>恢复此设备默认首页</button><p>只恢复此设备排版；侧边栏和财务资料不变。保存后生效。</p>
      </aside>
      <section className={styles.canvas} aria-label="首页实时画布"><div className={styles.canvasToolbar}><div>{(Object.keys(deviceNames) as DisplayDevice[]).map(id => <button type="button" key={id} aria-pressed={device === id} onClick={() => setDevice(id)}>{deviceNames[id]}</button>)}</div><span>{deviceNames[device]}布局 · {layout.items.filter(item => item.visible).length} / 13 模块</span></div><HomeDiyGrid modules={modules} preferences={c.draft} device={device} editing selected={selected} onSelect={select} onMove={move} onResize={(id, width, height) => c.update(next => { const target = next.devices[device].items.find(item => item.id === id)!; target.width = width; target.height = height; next.devices[device].enabled = true; })} onToggleDetails={id => c.update(next => { const target = next.devices[device].items.find(item => item.id === id)!; target.detailsExpanded = !target.detailsExpanded; })} replays={replays} /></section>
      <aside className={styles.inspector} aria-label="模块属性"><h2>{HOME_MODULES.find(module => module.id === selected)!.label}</h2>
        <fieldset key={`${device}-${selected}`}><legend>文字</legend>{([["title", "标题字号", 13, 28], ["amount", "金额字号", 20, 64], ["body", "说明／列表字号", 13, 18]] as const).map(([field, label, min, max]) => <div key={field}><NumberControl label={label} value={item[field]} min={min} max={max} onInvalid={invalidCallback(field)} onChange={value => updateItem(next => { next[field] = value; })} /><label className={styles.selectLabel}>{label.replace("字号", "字重")}<select value={item[`${field}Weight`]} onChange={event => { const value = Number(event.target.value); updateItem(next => { next[`${field}Weight`] = value; }); }}><option value="400">常规 400</option><option value="600">中粗 600</option><option value="700">加粗 700</option></select></label></div>)}</fieldset>
        <fieldset><legend>尺寸与间距</legend><label className={styles.selectLabel}>卡片宽度<select value={item.width} disabled={device === "mobile"} onChange={event => { const value = Number(event.target.value); updateItem(next => { next.width = value; }); }}><option value="4">1/3 行</option><option value="6">半行</option><option value="8">2/3 行</option><option value="12">整行</option></select></label><NumberControl label="最小高度" value={item.height} min={144} max={400} onInvalid={invalidCallback("height")} onChange={value => updateItem(next => { next.height = value; })} /><NumberControl label="卡片内边距" value={item.padding} min={14} max={32} onInvalid={invalidCallback("padding")} onChange={value => updateItem(next => { next.padding = value; })} /><NumberControl label="模块间距" value={layout.gap} min={12} max={32} onInvalid={invalidCallback("gap")} onChange={value => c.update(next => { next.devices[device].enabled = true; next.devices[device].gap = value; })} /><div className={styles.actions}><button type="button" disabled={layout.items[0].id === selected} onClick={() => step(-1)}>前移</button><button type="button" disabled={layout.items.at(-1)!.id === selected} onClick={() => step(1)}>后移</button></div></fieldset>
        <fieldset><legend>模块动效</legend><label className={styles.selectLabel}>模块动画<select value={item.motion} onChange={event => { const value = event.target.value as ModulePreference["motion"]; updateItem(next => { next.motion = value; }); }}>{motions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><NumberControl label="动效时长" value={item.duration} min={120} max={600} unit="ms" onInvalid={invalidCallback("duration")} onChange={value => updateItem(next => { next.duration = value; })} /><button type="button" onClick={play}>播放选中模块动效</button><p>系统“减少动态效果”优先。展开只收起说明，不隐藏金额或主要操作。</p></fieldset>
        <fieldset><legend>整组模块动效</legend><label className={styles.selectLabel}>首页入场方式<select value={layout.groupMotion} onChange={event => { const value = event.target.value as "none" | "stagger"; c.update(next => { next.devices[device].enabled = true; next.devices[device].groupMotion = value; }); }}><option value="none">不使用整组动画</option><option value="stagger">依次入场</option></select></label><button type="button" onClick={() => { setReplays(value => { const next = { ...value }; for (const item of layout.items) if (item.visible) next[item.id] = (next[item.id] ?? 0) + 1; return next; }); setPanel("canvas"); }}>播放整组模块</button><p>只播放一次，总延迟不超过 200ms。</p></fieldset>
      </aside>
    </div>
  </main>;
}

export function DisplaySettingsPanel({ controller: c, onOpenEditor }: { controller: DisplayPreferenceController; onOpenEditor: () => void }) {
  const focusId = useRef<string | null>(null);
  useEffect(() => { if (focusId.current) { document.querySelector<HTMLButtonElement>(`[data-sidebar-visibility="${focusId.current}"]`)?.focus(); focusId.current = null; } }, [c.draft.sidebar.hidden]);
  const toggle = (id: string, visible: boolean) => { focusId.current = id; c.update(next => { next.sidebar.hidden = visible ? next.sidebar.hidden.filter(item => item !== id) : [...new Set([...next.sidebar.hidden, id])]; }); };
  const row = (item: typeof SIDEBAR_ITEMS[number]) => <div key={item.id} className={styles.sidebarRow}><span>{item.label}</span>{item.locked ? <small>固定保留</small> : <button type="button" data-sidebar-visibility={item.id} title={`${c.draft.sidebar.hidden.includes(item.id) ? "恢复" : "隐藏"}侧边栏${item.label}`} aria-label={`${c.draft.sidebar.hidden.includes(item.id) ? "恢复" : "隐藏"}侧边栏${item.label}`} onClick={() => toggle(item.id, c.draft.sidebar.hidden.includes(item.id))}>{c.draft.sidebar.hidden.includes(item.id) ? "加回侧边栏" : <><EyeSlash size={16} />隐藏</>}</button>}</div>;
  return <section className={`main-content ${styles.settings}`} aria-label="显示与排版设置"><section className={`panel ${styles.settingEntry}`}><div><h2>首页自定义排版</h2><p>调整字体、卡片尺寸、模块位置和动效；只改变显示，不改变账户或交易。</p><small>本机按工作区隔离保存；登录后仅同步当前账号的显示参数。{c.syncMessage}</small></div><button type="button" className="primary-button" disabled={!c.ready || !c.readable} onClick={onOpenEditor}><SlidersHorizontal size={18} />自定义首页</button></section>
    <section className={`panel ${styles.sidebarSettings}`}><div className={styles.sectionHeading}><div><h2>侧边栏显示</h2><p>隐藏只收起入口，不删除页面、功能或资料。首页和设置始终保留。</p></div><button type="button" className="secondary-button" disabled={!c.ready || !c.readable} onClick={() => c.update(next => { next.sidebar.hidden = []; })}>恢复默认侧边栏</button></div><div className={styles.sidebarColumns}><div><h3>已隐藏 · {c.draft.sidebar.hidden.length}</h3>{SIDEBAR_ITEMS.filter(item => c.draft.sidebar.hidden.includes(item.id)).map(row)}{!c.draft.sidebar.hidden.length && <p>没有隐藏的侧边栏项目。</p>}</div><div><h3>页面入口与快捷操作</h3>{SIDEBAR_ITEMS.filter(item => !c.draft.sidebar.hidden.includes(item.id)).map(row)}</div></div></section>
    <div className={styles.actions}><button type="button" className="secondary-button" onClick={c.cancel}>取消修改并重新读取</button><button type="button" className="primary-button" disabled={!c.ready || !c.readable} onClick={() => c.save()}>保存显示设置</button></div><p className={styles.status} role="status">{c.message || (c.dirty ? "有未保存的显示草稿；保存包含首页排版和侧边栏设置。" : "显示设置已保持。")} {c.syncMessage}</p>
    {c.syncStatus === "error" && <button type="button" className="secondary-button" onClick={() => void c.retrySync()}>重试显示方案同步</button>}
    {c.syncStatus === "conflict" && <div><p>先保存或取消未保存草稿，再选择保留哪一份显示方案。此操作只涉及排版，不涉及财务资料。</p><div className={styles.actions}><button type="button" disabled={c.dirty} onClick={() => void c.resolveSync("remote")}>采用云端显示方案</button><button type="button" disabled={c.dirty} onClick={() => void c.resolveSync("local")}>用已保存的本机方案更新云端</button></div></div>}
  </section>;
}
