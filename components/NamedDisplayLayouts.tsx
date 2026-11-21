"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { getDataProfile, getServerDataProfile, isActiveDataProfile, subscribeDataProfile, type DataProfile } from "@/lib/data-profile";
import { HOME_MODULES, type DisplayDevice, type DisplayPreferences, type MotionPreset } from "@/lib/display-preferences";
import type { DisplayPreferenceController } from "@/lib/use-display-preferences";
import { useNamedDisplayLayouts } from "@/lib/use-named-display-layouts";
import type { NamedLayoutConflictToken } from "@/lib/named-layout-sync";
import { layoutNameKey, normalizeLayoutName } from "@/lib/named-display-layouts";
import styles from "./NamedDisplayLayouts.module.css";

type Scheme = { id: string; name: string; preferences: DisplayPreferences };
type Action =
  | { kind: "save"; resume?: Scheme }
  | { kind: "rename" | "copy" | "delete" | "apply" | "dirty"; target: Scheme }
  | { kind: "sync"; choice: "local" | "remote"; confirmed: NamedLayoutConflictToken };
type FocusOrigin = { node: HTMLButtonElement; id?: string; action?: string };

const deviceNames: Record<DisplayDevice, string> = { desktop: "桌面", tablet: "平板", mobile: "手机" };
const motionNames: Record<MotionPreset, string> = { none: "无动画", fade: "基础淡入", up: "向上淡入", down: "向下淡入", left: "从左淡入", right: "从右淡入", spring: "轻弹簧落位", zoom: "柔和缩放", reveal: "展开显现（说明）" };
const encode = (value: unknown) => JSON.stringify(value);
const moduleName = (id: string) => HOME_MODULES.find(item => item.id === id)?.label ?? id;
const isNaming = (action: Action | null) => action?.kind === "save" || action?.kind === "rename" || action?.kind === "copy";

/** A profile boundary remounts both the library hook and every open operation. */
export default function NamedDisplayLayouts({ display }: { display: DisplayPreferenceController }) {
  const profile = useSyncExternalStore(subscribeDataProfile, getDataProfile, getServerDataProfile);
  return <NamedDisplayLayoutsInner key={`${profile.key}:${profile.epoch}`} profile={profile} display={display} />;
}

function NamedDisplayLayoutsInner({ profile, display }: { profile: DataProfile; display: DisplayPreferenceController }) {
  const layouts = useNamedDisplayLayouts(profile);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [device, setDevice] = useState<DisplayDevice>("desktop");
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [nameInvalid, setNameInvalid] = useState(false);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [focusTicket, setFocusTicket] = useState(0);
  const consumedFocusTicket = useRef(0);
  const pendingRef = useRef(false);
  const completedAction = useRef(false);
  const mounted = useRef(false);
  const latest = useRef({ display, layouts });
  latest.current = { display, layouts };
  const root = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const dialogHeading = useRef<HTMLHeadingElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const origin = useRef<FocusOrigin | null>(null);
  const prefix = useId();
  const active = () => mounted.current && isActiveDataProfile(profile);
  const busy = pending || layouts.busy;
  const libraryUsable = layouts.ready && layouts.readable && profile.kind !== "locked";
  const displayUsable = display.ready && display.readable;
  const canChangeLibrary = libraryUsable && !busy && layouts.syncStatus !== "conflict";
  const savedValue = encode(display.saved);
  const applied = layouts.library.schemes.filter(scheme => encode(scheme.preferences) === savedValue);
  const selected = layouts.library.schemes.find(scheme => scheme.id === selectedId) ?? applied[0] ?? layouts.library.schemes[0];
  const selectedApplied = !!selected && encode(selected.preferences) === savedValue;
  const layout = selected?.preferences.devices[device];
  const example = layout?.items.find(item => item.visible) ?? layout?.items[0];

  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    return () => { mounted.current = false; element?.close(); };
  }, []);

  useEffect(() => {
    if (!action || !dialog.current || !isActiveDataProfile(profile)) return;
    if (!dialog.current.open) dialog.current.showModal();
    const frame = requestAnimationFrame(() => {
      if (isNaming(action)) { input.current?.focus(); input.current?.select(); }
      else dialogHeading.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [action, profile]);

  const restoreFocus = () => setFocusTicket(ticket => ticket + 1);
  // Wait for React to remove the dialog and re-enable controls. A frame queued
  // inside the submit handler can run while every destination is still disabled.
  useEffect(() => {
    if (!focusTicket || consumedFocusTicket.current === focusTicket || action || busy) return;
    const previous = origin.current;
    const frame = requestAnimationFrame(() => {
      if (!active() || dialog.current?.open) return;
      consumedFocusTicket.current = focusTicket;
      if (previous?.node.isConnected && !previous.node.disabled) { previous.node.focus(); return; }
      const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("button[data-layout-action]") ?? []);
      const target = buttons.find(button => !button.disabled && button.dataset.layoutId === previous?.id && button.dataset.layoutAction === previous?.action)
        ?? buttons.find(button => !button.disabled && button.dataset.layoutId === previous?.id && button.dataset.layoutAction === "select")
        ?? buttons.find(button => !button.disabled && button.dataset.layoutId === selected?.id && button.dataset.layoutAction === "select");
      (target ?? saveButton.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTicket, action, busy, selected?.id, profile]);

  const close = () => {
    if (pendingRef.current || latest.current.layouts.busy) return;
    completedAction.current = true;
    dialog.current?.close();
    setAction(null);
    setError("");
    restoreFocus();
  };

  const open = (next: Action, trigger: HTMLButtonElement) => {
    if (!active() || pendingRef.current || latest.current.layouts.busy) return;
    completedAction.current = false;
    origin.current = { node: trigger, id: trigger.dataset.layoutId, action: trigger.dataset.layoutAction };
    setError(""); setNameInvalid(false);
    setName(next.kind === "rename" ? next.target.name : next.kind === "copy" ? `${Array.from(next.target.name).slice(0, 27).join("")} 副本` : "");
    setAction(structuredClone(next));
  };

  const validateName = (value: string | null, excludingId?: string) => {
    if (value === null) return "请输入 1–30 个字符的名称，不要使用控制字符或不可见格式字符。";
    if (latest.current.layouts.library.schemes.some(scheme => scheme.id !== excludingId && layoutNameKey(scheme.name) === layoutNameKey(value))) return "已有同名方案，请换一个名称；原方案不会被覆盖。";
    return "";
  };

  const openConflict = (choice: "local" | "remote", trigger: HTMLButtonElement) => {
    const confirmed = latest.current.layouts.getConflictToken();
    if (!confirmed) { setNotice("方案库状态已改变，请重新检查同步状态后再选择。"); return; }
    open({ kind: "sync", choice, confirmed }, trigger);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!action || completedAction.current || !active() || pendingRef.current || latest.current.layouts.busy) return;
    const current = latest.current;
    if (!current.layouts.ready || !current.layouts.readable) { setError("方案库暂不可用，请取消后重试读取；没有覆盖任何方案。"); return; }
    if (action.kind !== "sync" && current.layouts.syncStatus === "conflict") { setError("方案库出现同步冲突。请取消本次操作，先确认保留哪一份方案库。"); return; }
    const target = "target" in action ? current.layouts.library.schemes.find(scheme => scheme.id === action.target.id) : undefined;
    if ("target" in action && (!target || encode(target) !== encode(action.target))) {
      setError("这套方案已在其他操作中更改或移除。请取消后重新选择预览；没有执行本次操作。"); return;
    }
    const normalized = normalizeLayoutName(name);
    if (isNaming(action)) {
      const problem = validateName(normalized, action.kind === "rename" ? action.target.id : undefined);
      if (problem) { setError(problem); setNameInvalid(true); input.current?.focus(); return; }
    }
    setError(""); setNameInvalid(false);
    if (action.kind === "dirty") { setAction({ kind: "save", resume: action.target }); setName(""); return; }
    if (action.kind === "apply" && current.display.dirty) { setAction({ kind: "dirty", target: action.target }); return; }
    if ((action.kind === "apply" || action.kind === "save") && (!current.display.ready || !current.display.readable)) {
      setError("当前显示设置暂不可读取。请取消后重新读取；草稿和方案库没有改变。"); return;
    }
    if (action.kind === "delete" && encode(target!.preferences) === encode(current.display.saved)) {
      setError("这套方案与当前已保存的显示设置相同，请先切换到其他设置再删除。"); return;
    }
    if (action.kind === "sync" && current.layouts.syncStatus !== "conflict") {
      setError("方案库冲突状态已改变，请取消后检查最新同步状态。"); return;
    }

    // The ref closes the same-tick gap before React disables the controls.
    pendingRef.current = true; setPending(true);
    let succeeded = false;
    try {
      if (!active()) return;
      if (action.kind === "save") {
        const snapshot = structuredClone(current.display.draft);
        const ok = await current.layouts.add(normalized!, snapshot);
        if (!active()) return;
        if (!ok) { setError("另存失败，草稿和原方案均已保留。请检查方案库提示后重试。"); return; }
        if (action.resume) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          if (!active()) return;
          // Never cancel a draft edited while the library write was in flight.
          if (encode(latest.current.display.draft) !== encode(snapshot)) {
            setAction({ kind: "dirty", target: action.resume });
            setError("刚才的草稿已另存，但等待期间又有新修改。新草稿仍保留，请再次另存或取消切换。"); return;
          }
          latest.current.display.cancel();
          if (!active()) return;
          setNotice("草稿已另存到方案库，尚未切换显示设置。请再次确认应用。");
          setAction({ kind: "apply", target: action.resume });
          return;
        }
        setNotice("已另存完整显示方案；当前显示设置及未保存草稿没有改变。");
        succeeded = true;
      } else if (action.kind === "rename" || action.kind === "copy" || action.kind === "delete") {
        const ok = action.kind === "rename" ? await current.layouts.rename(action.target.id, normalized!)
          : action.kind === "copy" ? await current.layouts.copy(action.target.id, normalized!)
            : await current.layouts.remove(action.target.id);
        if (!active()) return;
        if (!ok) { setError("操作未完成，原方案已保留。请检查方案库提示后重试。"); return; }
        setNotice(action.kind === "rename" ? "名称已保存；方案内容与当前显示设置没有改变。" : action.kind === "copy" ? "已复制完整方案；原方案与当前显示设置没有改变。" : "已移除所确认的显示方案；当前显示设置和财务资料没有改变。");
        succeeded = true;
      } else if (action.kind === "apply") {
        if (!latest.current.display.applySnapshot(structuredClone(action.target.preferences))) {
          setError("应用未完成。当前草稿与原显示设置已保留，请检查下方显示设置提示后重试。"); return;
        }
        if (!active()) return;
        setNotice("已应用并保存完整显示配置。同步进度请查看下方当前显示设置状态。");
        succeeded = true;
      } else if (action.kind === "sync") {
        const resolved = await current.layouts.resolveSync(action.choice, action.confirmed);
        if (!active()) return;
        if (!resolved) {
          setError(latest.current.layouts.syncMessage || "方案库冲突尚未解决。请检查同步状态后重试；当前显示设置没有改变。"); return;
        }
        setNotice("已按确认的选择处理整份方案库；没有应用或切换当前显示设置。");
        succeeded = true;
      }
    } catch {
      if (active()) setError("操作未完成，请检查方案库状态后重试。未自动丢弃草稿或切换当前显示设置。");
    } finally {
      if (active()) {
        if (succeeded) completedAction.current = true;
        pendingRef.current = false; setPending(false);
        if (succeeded) { dialog.current?.close(); setAction(null); restoreFocus(); }
        else requestAnimationFrame(() => {
          if (active() && dialog.current?.open && !dialog.current.contains(document.activeElement)) dialogHeading.current?.focus();
        });
      }
    }
  };

  const recover = async (kind: "reload" | "sync") => {
    if (!active() || pendingRef.current || latest.current.layouts.busy) return;
    pendingRef.current = true; setPending(true); setNotice("");
    try {
      if (kind === "reload") await latest.current.layouts.reload();
      else await latest.current.layouts.retrySync();
      if (!active()) return;
    } catch { if (active()) setNotice("方案库操作未完成，请稍后重试。当前显示设置没有改变。"); }
    finally { if (active()) { pendingRef.current = false; setPending(false); } }
  };

  const dialogCopy = (() => {
    if (!action) return { title: "显示方案", description: "", confirm: "确认" };
    switch (action.kind) {
      case "save": return { title: action.resume ? "先另存未保存的排版草稿" : "另存为新方案", description: action.resume ? "先把完整草稿保存到方案库。只有另存成功才会取消这份草稿，之后仍需单独确认应用；另存失败会保留草稿。" : "保存当前完整显示配置，包括三个设备的布局、字体、动画与侧边栏。不会覆盖已有方案，也不会自动应用或取消草稿。", confirm: "保存为新方案" };
      case "rename": return { title: "重命名显示方案", description: `只更改“${action.target.name}”的名称，保留全部显示参数及当前显示设置。`, confirm: "保存名称" };
      case "copy": return { title: "复制显示方案", description: `复制“${action.target.name}”的完整显示配置；原方案和当前显示设置保持不变。`, confirm: "创建副本" };
      case "delete": return { title: "删除这套显示方案？", description: `仅删除“${action.target.name}”这一份方案，不删除页面或财务资料，不改变当前显示设置。`, confirm: "确认删除方案" };
      case "dirty": return { title: "先保留未保存的排版草稿", description: "当前有未保存修改。请先把草稿另存为新方案，或取消本次切换；不会静默覆盖草稿。", confirm: "先另存草稿" };
      case "apply": return { title: "应用这套完整显示方案？", description: `将采用“${action.target.name}”的桌面、平板、手机、字体、动画和侧边栏设置，并保存为当前显示设置。不会修改账户、交易、预算或计算。`, confirm: "确认应用" };
      case "sync": return action.choice === "remote"
        ? { title: "用云端整份方案库替换本机方案库？", description: "确认后将采用云端的整份方案库，本机独有或不同的方案可能不再出现在库中。这不是合并，也不会应用任何方案或改变当前显示设置。", confirm: "确认采用云端整份方案库" }
        : { title: "用本机整份方案库替换云端方案库？", description: "确认后将以本机的整份方案库更新云端，云端独有或不同的方案可能被替换。这不是合并，也不会应用任何方案或改变当前显示设置。", confirm: "确认以本机整份方案库更新云端" };
    }
  })();

  return <section ref={root} className={`panel ${styles.manager}`} aria-labelledby={`${prefix}-title`}>
    <header className={styles.sectionHeading}>
      <div><h2 id={`${prefix}-title`}>我的显示方案</h2><p>每套都包含桌面、平板、手机，以及字体、动画和侧边栏设置。</p></div>
      <button ref={saveButton} type="button" className={styles.primary} disabled={!canChangeLibrary || !displayUsable} onClick={event => open({ kind: "save" }, event.currentTarget)}>另存为新方案</button>
    </header>
    <div className={styles.currentLine}>
      <span>当前使用：<strong>{!display.ready ? "正在读取显示设置…" : !display.readable ? "显示设置暂不可读取" : !layouts.ready || !layouts.readable ? "当前已保存显示设置（方案库尚不可读）" : applied.length ? applied.map(scheme => scheme.name).join(" / ") : "当前显示设置（未命名）"}</strong></span>
      <span className={styles.muted}>{display.dirty ? "有未保存的排版草稿" : "没有未保存的排版修改"}</span>
    </div>
    <div className={styles.managerBody}>
      <div className={styles.libraryRegion}>
        <h3>已保存的方案 <span className={styles.count}>{layouts.ready && layouts.readable ? layouts.library.schemes.length : "—"}</span></h3>
        <p className={styles.muted}>先选择预览，再确认应用。</p>
        <div aria-label="命名显示方案列表" aria-busy={!layouts.ready || busy}>
          {!layouts.ready ? <p className={styles.empty} role="status">正在读取当前工作区的方案库…</p>
            : !layouts.readable ? <div className={styles.empty}><p>方案库暂时无法读取。原内容已保留，不会自动覆盖。</p><button type="button" disabled={busy} onClick={() => void recover("reload")}>重新读取方案库</button></div>
              : !layouts.library.schemes.length ? <div className={styles.empty}><h3>还没有保存的方案</h3><p>调整好显示设置后，点击“另存为新方案”，保存完整配置，方便以后切换。</p></div>
                : layouts.library.schemes.map(scheme => {
                  const isApplied = displayUsable && encode(scheme.preferences) === savedValue;
                  return <article key={scheme.id} className={styles.schemeRow}>
                    <button type="button" className={styles.schemeSelect} data-layout-id={scheme.id} data-layout-action="select" aria-pressed={selected?.id === scheme.id} aria-label={`预览方案 ${scheme.name}`} disabled={busy} onClick={() => { if (active()) setSelectedId(scheme.id); }}>
                      <strong>{scheme.name}</strong><span>{isApplied ? "当前使用 · " : ""}桌面 / 平板 / 手机 · 全部显示参数</span>
                    </button>
                    <div className={styles.schemeActions}>
                      <button type="button" data-layout-id={scheme.id} data-layout-action="rename" disabled={!canChangeLibrary} onClick={event => open({ kind: "rename", target: scheme }, event.currentTarget)} aria-label={`重命名方案 ${scheme.name}`}>重命名</button>
                      <button type="button" data-layout-id={scheme.id} data-layout-action="copy" disabled={!canChangeLibrary} onClick={event => open({ kind: "copy", target: scheme }, event.currentTarget)} aria-label={`复制方案 ${scheme.name}`}>复制</button>
                      {isApplied ? <small>当前使用，请先切换再删除</small> : <button type="button" className={styles.danger} data-layout-id={scheme.id} data-layout-action="delete" disabled={!canChangeLibrary || !displayUsable} onClick={event => open({ kind: "delete", target: scheme }, event.currentTarget)} aria-label={`删除方案 ${scheme.name}`}>删除</button>}
                    </div>
                  </article>;
                })}
        </div>
      </div>
      <section className={styles.comparison} aria-labelledby={`${prefix}-preview-title`}>
        <div className={styles.comparisonHeading}><h3 id={`${prefix}-preview-title`}>{libraryUsable && selected ? selected.name : "方案预览"}</h3>{libraryUsable && selected && <span className={styles.statusChip}>{displayUsable && selectedApplied ? "当前使用" : "尚未应用"}</span>}</div>
        {libraryUsable && selected && layout ? <>
          <div className={styles.deviceTabs} role="group" aria-label="预览设备">{(Object.keys(deviceNames) as DisplayDevice[]).map(id => <button key={id} type="button" aria-pressed={device === id} disabled={busy} onClick={() => setDevice(id)}>{deviceNames[id]}</button>)}</div>
          <div className={styles.layoutPreview} data-device={device} aria-label="只含模块名称的排版示意">
            {layout.items.filter(item => item.visible).map(item => <div key={item.id} className={styles.layoutCell} style={{ gridColumn: device === "mobile" ? "1 / -1" : `span ${device === "tablet" ? Math.max(6, item.width) : item.width}` }}>{moduleName(item.id)}</div>)}
            {!layout.items.some(item => item.visible) && <p className={styles.previewEmpty}>此设备方案没有可见的自定义模块。</p>}
          </div>
          <p className={`${styles.muted} ${styles.previewNote}`}>模块位置与样式示意，非实际尺寸，不显示任何财务资料。{!layout.enabled && "此设备未启用自定义排版，实际首页沿用默认布局；此处仅示意已保存参数。"}</p>
          <dl className={styles.summary}>
            <dt>当前预览设备</dt><dd>{deviceNames[device]}</dd>
            <dt>自定义排版</dt><dd>{layout.enabled ? "已启用" : "未启用（使用默认首页）"}</dd>
            <dt>可见首页模块</dt><dd>{layout.items.filter(item => item.visible).length} / {HOME_MODULES.length}</dd>
            {example && <><dt>示例模块</dt><dd>{moduleName(example.id)}</dd>
              <dt>该模块字号（标题 / 数字 / 说明）</dt><dd>{example.title} / {example.amount} / {example.body} px</dd>
              <dt>该模块字重（标题 / 数字 / 说明）</dt><dd>{example.titleWeight} / {example.amountWeight} / {example.bodyWeight}</dd>
              <dt>该模块动画</dt><dd>{motionNames[example.motion]}{example.motion !== "none" ? ` · ${example.duration} ms` : ""}</dd></>}
            <dt>侧边栏隐藏项</dt><dd>{selected.preferences.sidebar.hidden.length} 个</dd>
          </dl>
          <button type="button" className={`${styles.primary} ${styles.applyButton}`} disabled={busy || !displayUsable || selectedApplied || layouts.syncStatus === "conflict"} onClick={event => open({ kind: display.dirty ? "dirty" : "apply", target: selected }, event.currentTarget)}>{selectedApplied ? "这套方案正在使用" : "预览并应用这套方案"}</button>
          <p className={styles.muted}>确认应用才会切换完整显示配置。删除方案不会删除页面或财务资料。</p>
        </> : <p className={styles.empty}>保存方案后，在左侧选择预览。选择不会自动切换当前显示设置。</p>}
      </section>
    </div>
    <div className={styles.libraryStatus}>
      <p role="status" aria-live="polite"><strong>方案库同步：</strong><span data-library-sync-status={layouts.syncStatus}>{layouts.syncMessage}</span>{layouts.message && <> {layouts.message}</>}</p>
      <p className={styles.muted}>这里只同步命名方案库，不代表当前显示设置已同步；当前显示设置的状态见下方原有保存区。方案内不包含账户、交易、预算或其他财务资料。</p>
      {layouts.ready && layouts.readable && profile.kind !== "locked" && <button type="button" disabled={busy} onClick={() => void recover("reload")}>重新读取方案库</button>}
      {layouts.syncStatus === "error" && <button type="button" disabled={busy || !libraryUsable} onClick={() => void recover("sync")}>重试方案库同步</button>}
      {layouts.syncStatus === "conflict" && <div className={styles.conflict}>
        <p>其他设备也修改了方案库，自动同步已暂停。请选择保留哪一整份方案库，下一步会再次确认；不会应用任何方案。</p>
        <div className={styles.syncActions}><button type="button" disabled={busy || !libraryUsable} onClick={event => openConflict("remote", event.currentTarget)}>采用云端整份方案库…</button><button type="button" disabled={busy || !libraryUsable} onClick={event => openConflict("local", event.currentTarget)}>以本机整份方案库更新云端…</button></div>
      </div>}
      <p role="status" aria-live="polite" className={styles.notice}>{notice}</p>
    </div>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${prefix}-dialog-title`} aria-describedby={`${prefix}-dialog-description`} onCancel={event => { event.preventDefault(); close(); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
      <form noValidate onSubmit={event => void submit(event)} aria-busy={busy}>
        <header className={styles.dialogHeader}><h2 ref={dialogHeading} tabIndex={-1} id={`${prefix}-dialog-title`}>{dialogCopy.title}</h2><button type="button" disabled={busy} onClick={close} aria-label="关闭方案操作">关闭</button></header>
        <div className={styles.dialogBody}>
          <p id={`${prefix}-dialog-description`}>{dialogCopy.description}</p>
          {isNaming(action) && <><label htmlFor={`${prefix}-name`}>方案名称</label><input ref={input} id={`${prefix}-name`} name="schemeName" autoComplete="off" value={name} disabled={busy} aria-invalid={nameInvalid} aria-describedby={`${prefix}-name-help ${prefix}-error`} onChange={event => { setName(event.target.value); setNameInvalid(false); setError(""); }} /><p id={`${prefix}-name-help`} className={styles.muted}>1–30 个字符；全角等兼容形式与首尾空格会规范化，英文字母大小写不区分。名称不能重复，不需填写财务信息。</p></>}
          {action?.kind === "apply" && <p className={styles.muted}>只替换当前工作区的显示配置。登录后的当前显示设置沿用原有同步规则；本次不替换方案库。</p>}
          <p id={`${prefix}-error`} className={styles.error} role="alert">{error}</p>
          {layouts.message && action && <p className={styles.muted}>方案库提示：{layouts.message}</p>}
        </div>
        <footer className={styles.dialogFooter}><button type="button" disabled={busy} onClick={close}>{action?.kind === "dirty" || action?.kind === "save" && action.resume ? "取消切换" : "取消"}</button><button type="submit" disabled={busy || !libraryUsable} className={`${styles.primary} ${action?.kind === "delete" || action?.kind === "sync" ? styles.danger : ""}`}>{busy ? "正在处理…" : dialogCopy.confirm}</button></footer>
      </form>
    </dialog>
  </section>;
}
