// 外观引擎：主题 / 强调色 / 玻璃面板 的可切换外观偏好（非敏感 UI 偏好，持久化到 localStorage）
export type ThemeId = "deep-space" | "dsh-glass" | "violet" | "emerald" | "graphite" | "day-clean" | "day-warm" | "day-glacier";
export type AccentId = "cyan" | "blue" | "violet" | "pink" | "orange" | "green" | "gold" | "red";
export type PanelStyle = "standard" | "glass";
export type ThemeMode = "dark" | "light";

export interface Appearance {
  theme: ThemeId;
  accent: AccentId;
  panels: PanelStyle;
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  mode: ThemeMode;
  swatch: string;
}

export const THEMES: ThemeDef[] = [
  { id: "deep-space", name: "深空星图", mode: "dark", swatch: "#06101d" },
  { id: "dsh-glass", name: "DSH 玻璃", mode: "dark", swatch: "#0c121b" },
  { id: "violet", name: "紫罗兰夜", mode: "dark", swatch: "#141030" },
  { id: "emerald", name: "墨绿森林", mode: "dark", swatch: "#0a1f18" },
  { id: "graphite", name: "石墨灰", mode: "dark", swatch: "#13161b" },
  { id: "day-clean", name: "简约亮白", mode: "light", swatch: "#f5f7fa" },
  { id: "day-warm", name: "暖纸", mode: "light", swatch: "#fbf6ec" },
  { id: "day-glacier", name: "冰川浅蓝", mode: "light", swatch: "#edf4fb" },
];

export const ACCENTS: Array<{ id: AccentId; name: string; color: string }> = [
  { id: "cyan", name: "青", color: "#3cd9f5" },
  { id: "blue", name: "蓝", color: "#4a7fd9" },
  { id: "violet", name: "紫", color: "#a78bfa" },
  { id: "pink", name: "粉", color: "#f472b6" },
  { id: "orange", name: "橙", color: "#fb923c" },
  { id: "green", name: "绿", color: "#4ade80" },
  { id: "gold", name: "金", color: "#e8bc75" },
  { id: "red", name: "红", color: "#f87171" },
];

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "deep-space",
  accent: "cyan",
  panels: "glass",
};

const STORAGE_KEY = "wealth-atlas-appearance";
const LAST_DARK_KEY = "wealth-atlas-appearance-last-dark";
const LAST_LIGHT_KEY = "wealth-atlas-appearance-last-light";

function readStorage<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略写入失败（本地存储不可用时外观偏好仅本次会话生效）
  }
}

export function loadAppearance(): Appearance {
  const stored = readStorage<Partial<Appearance>>(STORAGE_KEY, {});
  const theme = THEMES.some((t) => t.id === stored.theme) ? (stored.theme as ThemeId) : DEFAULT_APPEARANCE.theme;
  const accent = ACCENTS.some((a) => a.id === stored.accent) ? (stored.accent as AccentId) : DEFAULT_APPEARANCE.accent;
  const panels = stored.panels === "standard" ? "standard" : "glass";
  return { theme, accent, panels };
}

export function saveAppearance(appearance: Appearance) {
  writeStorage(STORAGE_KEY, appearance);
  const mode = THEMES.find((t) => t.id === appearance.theme)?.mode ?? "dark";
  writeStorage(mode === "dark" ? LAST_DARK_KEY : LAST_LIGHT_KEY, appearance.theme);
}

export function themeMode(theme: ThemeId): ThemeMode {
  return THEMES.find((t) => t.id === theme)?.mode ?? "dark";
}

/** 日/夜切换：切到"上次使用的另一模式主题"。 */
export function toggleMode(appearance: Appearance): Appearance {
  const currentMode = themeMode(appearance.theme);
  const targetMode: ThemeMode = currentMode === "dark" ? "light" : "dark";
  const lastId = readStorage<ThemeId | null>(targetMode === "dark" ? LAST_DARK_KEY : LAST_LIGHT_KEY, null);
  const fallbackTheme = THEMES.find((t) => t.mode === targetMode)?.id ?? DEFAULT_APPEARANCE.theme;
  const nextTheme = lastId && THEMES.some((t) => t.id === lastId) ? lastId : fallbackTheme;
  return { ...appearance, theme: nextTheme };
}
