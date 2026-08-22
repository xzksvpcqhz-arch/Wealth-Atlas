"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowsOutCardinal, Check, DotsSixVertical, Sparkle } from "@phosphor-icons/react";
import { Responsive, WidthProvider, type LayoutItem, type ResponsiveLayouts } from "react-grid-layout/legacy";

const ResponsiveGrid = WidthProvider(Responsive);
const STORAGE_KEY = "wealth-atlas.home-layout";
const BREAKPOINTS = ["lg", "md", "sm"] as const;
type HomeBreakpoint = (typeof BREAKPOINTS)[number];
type HomeLayouts = ResponsiveLayouts<HomeBreakpoint>;

const COLUMNS: Record<HomeBreakpoint, number> = { lg: 12, md: 8, sm: 1 };

export const DEFAULT_HOME_LAYOUTS: HomeLayouts = {
  lg: [
    { i: "free", x: 0, y: 0, w: 5, h: 5 },
    { i: "income", x: 5, y: 0, w: 3, h: 3 },
    { i: "expense", x: 8, y: 0, w: 4, h: 3 },
    { i: "net-worth", x: 5, y: 3, w: 3, h: 2 },
    { i: "budget", x: 8, y: 3, w: 4, h: 2 },
    { i: "accounts", x: 0, y: 5, w: 5, h: 5 },
    { i: "sgd-myr", x: 5, y: 5, w: 2, h: 3 },
    { i: "usd-sgd", x: 7, y: 5, w: 2, h: 3 },
    { i: "currency", x: 9, y: 5, w: 3, h: 3 },
    { i: "recent", x: 0, y: 10, w: 6, h: 6 },
    { i: "watchlist", x: 6, y: 10, w: 3, h: 5 },
    { i: "reminders", x: 9, y: 10, w: 3, h: 5 },
  ],
  md: [
    { i: "free", x: 0, y: 0, w: 8, h: 5 },
    { i: "income", x: 0, y: 5, w: 4, h: 3 },
    { i: "expense", x: 4, y: 5, w: 4, h: 3 },
    { i: "net-worth", x: 0, y: 8, w: 4, h: 3 },
    { i: "budget", x: 4, y: 8, w: 4, h: 3 },
    { i: "accounts", x: 0, y: 11, w: 8, h: 5 },
    { i: "sgd-myr", x: 0, y: 16, w: 4, h: 3 },
    { i: "usd-sgd", x: 4, y: 16, w: 4, h: 3 },
    { i: "currency", x: 0, y: 19, w: 8, h: 3 },
    { i: "recent", x: 0, y: 22, w: 8, h: 5 },
    { i: "watchlist", x: 0, y: 27, w: 8, h: 5 },
    { i: "reminders", x: 0, y: 32, w: 8, h: 5 },
  ],
  sm: [
    { i: "free", x: 0, y: 0, w: 1, h: 5 },
    { i: "income", x: 0, y: 5, w: 1, h: 3 },
    { i: "expense", x: 0, y: 8, w: 1, h: 3 },
    { i: "net-worth", x: 0, y: 11, w: 1, h: 3 },
    { i: "budget", x: 0, y: 14, w: 1, h: 3 },
    { i: "accounts", x: 0, y: 17, w: 1, h: 5 },
    { i: "sgd-myr", x: 0, y: 22, w: 1, h: 3 },
    { i: "usd-sgd", x: 0, y: 25, w: 1, h: 3 },
    { i: "currency", x: 0, y: 28, w: 1, h: 3 },
    { i: "recent", x: 0, y: 31, w: 1, h: 5 },
    { i: "watchlist", x: 0, y: 36, w: 1, h: 5 },
    { i: "reminders", x: 0, y: 41, w: 1, h: 5 },
  ],
};

export type HomeLayoutItem = {
  id: string;
  label: string;
  children: ReactNode;
};

type LayoutSnapshot = {
  homeLayout: HomeLayouts;
  homeLayoutUpdatedAt: string;
};

function cloneLayouts(layouts: HomeLayouts): HomeLayouts {
  return Object.fromEntries(BREAKPOINTS.map((breakpoint) => [breakpoint, (layouts[breakpoint] ?? []).map((item) => ({ ...item }))])) as HomeLayouts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidLayout(value: unknown, ids: string[], breakpoint: HomeBreakpoint): value is LayoutItem[] {
  if (!Array.isArray(value) || value.length !== ids.length) return false;
  const seen = new Set<string>();
  return value.every((item) => {
    if (!isRecord(item) || typeof item.i !== "string" || seen.has(item.i)) return false;
    seen.add(item.i);
    if (!ids.includes(item.i)) return false;
    if (![item.x, item.y, item.w, item.h].every((number) => typeof number === "number" && Number.isInteger(number) && Number.isFinite(number))) return false;
    if ((item.x as number) < 0 || (item.y as number) < 0 || (item.w as number) < 1 || (item.h as number) < 1) return false;
    return (item.x as number) + (item.w as number) <= COLUMNS[breakpoint];
  }) && seen.size === ids.length;
}

function isValidHomeLayouts(value: unknown, ids: string[]): value is HomeLayouts {
  if (!isRecord(value)) return false;
  return BREAKPOINTS.every((breakpoint) => isValidLayout(value[breakpoint], ids, breakpoint));
}

function migrateLegacyQuickActionLayout(value: unknown, ids: string[]): HomeLayouts | null {
  if (!isRecord(value)) return null;
  const migrated = Object.fromEntries(BREAKPOINTS.map((breakpoint) => {
    const layout = value[breakpoint];
    return [breakpoint, Array.isArray(layout) ? layout.filter((item) => isRecord(item) && item.i !== "quick-actions") : layout];
  }));
  return isValidHomeLayouts(migrated, ids) ? cloneLayouts(migrated) : null;
}

function persistLayouts(layouts: HomeLayouts, onNotify: (message: string) => void) {
  try {
    const snapshot: LayoutSnapshot = { homeLayout: cloneLayouts(layouts), homeLayoutUpdatedAt: new Date().toISOString() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    return true;
  } catch {
    onNotify("首页排版无法保存，请检查浏览器的本地存储权限");
    return false;
  }
}

export default function HomeLayoutGrid({ items, onNotify }: { items: HomeLayoutItem[]; onNotify: (message: string) => void }) {
  const [layouts, setLayouts] = useState<HomeLayouts>(() => cloneLayouts(DEFAULT_HOME_LAYOUTS));
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [activeBreakpoint, setActiveBreakpoint] = useState<HomeBreakpoint>("lg");
  const visibleItems = items.filter((item) => item.id !== "quick-actions");
  const ids = visibleItems.map((item) => item.id);
  const isMobile = activeBreakpoint === "sm";
  const layoutEditing = isEditing && !isMobile;

  useEffect(() => {
    const fallback = cloneLayouts(DEFAULT_HOME_LAYOUTS);
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        setLayouts(fallback);
        setIsLoading(false);
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      const storedLayouts = isRecord(parsed) ? parsed.homeLayout : undefined;
      if (isValidHomeLayouts(storedLayouts, ids)) {
        setLayouts(cloneLayouts(storedLayouts));
      } else if (migrateLegacyQuickActionLayout(storedLayouts, ids)) {
        const migrated = migrateLegacyQuickActionLayout(storedLayouts, ids)!;
        setLayouts(migrated);
        persistLayouts(migrated, onNotify);
        onNotify("快捷操作已移到首页顶部，其余首页排版已保留");
      } else {
        setLayouts(fallback);
        persistLayouts(fallback, onNotify);
        onNotify("首页排版数据无效，已自动恢复默认排版");
      }
    } catch {
      setLayouts(fallback);
      persistLayouts(fallback, onNotify);
      onNotify("首页排版数据损坏，已自动恢复默认排版");
    }
    setIsLoading(false);
  }, []);

  const handleLayoutChange = (_layout: readonly LayoutItem[], allLayouts: HomeLayouts) => {
    if (!layoutEditing) return;
    setLayouts((current) => {
      const next = { ...current, ...allLayouts };
      return isValidHomeLayouts(next, ids) ? cloneLayouts(next) : current;
    });
  };

  const finishEditing = () => {
    setIsEditing(false);
    if (persistLayouts(layouts, onNotify)) onNotify("首页排版已保存");
  };

  const resetLayouts = () => {
    const fallback = cloneLayouts(DEFAULT_HOME_LAYOUTS);
    setLayouts(fallback);
    if (persistLayouts(fallback, onNotify)) onNotify("已恢复默认排版");
  };

  return <section className="home-layout-workbench" aria-label="首页排版管理">
    <div className="home-layout-toolbar">
      <div className="home-layout-toolbar-copy">
        <div className="panel-kicker">HOME LAYOUT</div>
        <h2>把首页排成你的工作台</h2>
        <p>{isMobile ? "手机端保持单栏浏览" : layoutEditing ? "拖动模块改变顺序，拖右下角手柄调整大小" : "拖动模块调整位置与尺寸 · 只保存排版，不保存金额"}</p>
      </div>
      <div className="home-layout-toolbar-actions">
        {isEditing && <button type="button" className="secondary-button compact" onClick={resetLayouts} aria-label="恢复默认首页排版" title="恢复默认排版"><Sparkle size={16} />恢复默认排版</button>}
        {isEditing ? <button type="button" className="primary-button compact" onClick={finishEditing} aria-label="完成首页排版" title="完成排版"><Check size={16} weight="bold" />完成排版</button> : <button type="button" className="secondary-button compact" onClick={() => setIsEditing(true)} disabled={isMobile} aria-label={isMobile ? "手机端保持单栏排版" : "调整首页排版"} title={isMobile ? "手机端保持单栏排版" : "调整排版"}><ArrowsOutCardinal size={16} />{isMobile ? "手机端单栏" : "调整排版"}</button>}
      </div>
    </div>
    {layoutEditing && <div className="home-layout-edit-notice" role="status"><DotsSixVertical size={17} /><span>编辑模式已开启，完成后点击“完成排版”才会退出。</span></div>}
    {isLoading ? <div className="home-layout-loading" role="status"><div className="home-layout-skeleton skeleton-wide" /><div className="home-layout-skeleton" /><div className="home-layout-skeleton" /><span>正在读取首页排版…</span></div> : visibleItems.length === 0 ? <div className="panel home-layout-empty"><Sparkle size={28} /><strong>暂无可调整的首页模块</strong><span>首页模块加载后会出现在这里。</span></div> : <ResponsiveGrid className="home-layout-grid" layouts={layouts} breakpoints={{ lg: 1100, md: 760, sm: 0 }} cols={COLUMNS} rowHeight={56} margin={[14, 14]} containerPadding={[0, 0]} compactType="vertical" preventCollision={false} isDraggable={layoutEditing} isResizable={layoutEditing} resizeHandles={layoutEditing ? ["se"] : []} draggableHandle=".home-layout-drag-handle" onBreakpointChange={(breakpoint) => setActiveBreakpoint(breakpoint as HomeBreakpoint)} onLayoutChange={handleLayoutChange}>
      {visibleItems.map((item) => <div key={item.id} className="home-layout-item" data-editing={layoutEditing ? "true" : "false"} data-home-module={item.id} aria-label={item.label}>
        {layoutEditing && <span className="home-layout-drag-handle" aria-label={`拖动${item.label}模块`} role="img"><DotsSixVertical size={16} weight="bold" /></span>}
        {item.children}
      </div>)}
    </ResponsiveGrid>}
  </section>;
}
