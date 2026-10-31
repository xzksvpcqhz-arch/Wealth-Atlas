// Display metadata only: amount is a font size, never a financial value.
export const HOME_MODULES = Object.freeze(([
  { id: "free", label: "本月可自由使用", icon: "Sparkle", width: 12, height: 224, amount: 44 },
  { id: "income", label: "本月收入", icon: "ArrowDownLeft", width: 6, height: 160, amount: 30 },
  { id: "expense", label: "本月支出", icon: "ArrowUpRight", width: 6, height: 160, amount: 30 },
  { id: "net-worth", label: "净资产", icon: "ChartLineUp", width: 4, height: 160, amount: 28 },
  { id: "budget", label: "预算剩余", icon: "Scales", width: 4, height: 160, amount: 28 },
  { id: "accounts", label: "账户总览", icon: "Wallet", width: 4, height: 208, amount: 28 },
  { id: "sgd-myr", label: "SGD/MYR 汇率", icon: "Coins", width: 4, height: 160, amount: 30 },
  { id: "usd-sgd", label: "USD/SGD 汇率", icon: "Coins", width: 4, height: 160, amount: 30 },
  { id: "currency", label: "货币暴露", icon: "Globe", width: 4, height: 208, amount: 28 },
  { id: "recent", label: "最近收支记录", icon: "Receipt", width: 8, height: 208, amount: 28 },
  { id: "watchlist", label: "Watchlist", icon: "Binoculars", width: 4, height: 184, amount: 28 },
  { id: "reminders", label: "理财师提醒", icon: "Bell", width: 4, height: 184, amount: 28 },
  { id: "quick", label: "快捷操作", icon: "Lightning", width: 12, height: 160, amount: 28 },
] as const).map((item) => Object.freeze(item)));

export const SIDEBAR_ITEMS = Object.freeze(([
  { id: "home", label: "首页", locked: true, group: "pages" },
  { id: "accounts", label: "账户总览", locked: false, group: "pages" },
  { id: "reports", label: "报表中心", locked: false, group: "pages" },
  { id: "transactions", label: "收支记录", locked: false, group: "pages" },
  { id: "budget", label: "预算管理", locked: false, group: "pages" },
  { id: "assets", label: "资产管理", locked: false, group: "pages" },
  { id: "goals", label: "目标与计划", locked: false, group: "pages" },
  { id: "cashflow", label: "未来现金流", locked: false, group: "pages" },
  { id: "watchlists", label: "Watchlist", locked: false, group: "pages" },
  { id: "insurance", label: "保险管理", locked: false, group: "pages" },
  { id: "insights", label: "理财师提醒", locked: false, group: "pages" },
  { id: "fx", label: "汇率中心", locked: false, group: "pages" },
  { id: "trash", label: "回收站", locked: false, group: "pages" },
  { id: "settings", label: "设置", locked: true, group: "pages" },
  { id: "capture", label: "记一笔", locked: false, group: "shortcuts" },
  { id: "transfer", label: "记转账", locked: false, group: "shortcuts" },
  { id: "obsidian", label: "同步 Obsidian", locked: false, group: "shortcuts" },
  { id: "excel", label: "导出 Excel", locked: false, group: "shortcuts" },
  { id: "theme-mode", label: "日间／夜间模式", locked: false, group: "shortcuts" },
  { id: "appearance", label: "外观", locked: false, group: "shortcuts" },
] as const).map((item) => Object.freeze(item)));

export type DisplayDevice = "desktop" | "tablet" | "mobile";
export type MotionPreset = "none" | "fade" | "up" | "down" | "left" | "right" | "spring" | "zoom" | "reveal";

export interface ModulePreference {
  id: string;
  width: number;
  height: number;
  padding: number;
  title: number;
  amount: number;
  body: number;
  titleWeight: number;
  amountWeight: number;
  bodyWeight: number;
  motion: MotionPreset;
  duration: number;
  visible: boolean;
  detailsExpanded: boolean;
}

export interface DisplayPreferences {
  version: 1;
  sidebar: { hidden: string[] };
  devices: Record<DisplayDevice, {
    enabled: boolean;
    gap: number;
    groupMotion: "none" | "stagger";
    items: ModulePreference[];
  }>;
}

// The caller supplies a verified cloud ID and must invalidate stale identity handlers.
// This module neither resolves authentication nor accesses cloud storage.
export type DisplayScope = {
  kind: "locked" | "local" | "guest" | "cloud";
  ownerId: string | null;
};
export type Scope = DisplayScope;

export type DisplayPreferencesReadResult = {
  value: DisplayPreferences;
  raw: string | null;
  status: "default" | "stored" | "invalid" | "unavailable" | "locked";
};
export type DisplayPreferencesWriteResult = {
  ok: boolean;
  raw: string | null;
  reason?: "invalid" | "unavailable" | "conflict" | "locked";
};

const DEVICES: readonly DisplayDevice[] = ["desktop", "tablet", "mobile"];
const MOTIONS: readonly string[] = ["none", "fade", "up", "down", "left", "right", "spring", "zoom", "reveal"];
const MODULE_IDS = new Set<string>(HOME_MODULES.map((item) => item.id));
const HIDEABLE_IDS = new Set<string>(SIDEBAR_ITEMS.filter((item) => !item.locked).map((item) => item.id));
const MODULE_KEYS = [
  "id", "width", "height", "padding", "title", "amount", "body", "titleWeight",
  "amountWeight", "bodyWeight", "motion", "duration", "visible", "detailsExpanded",
] as const;
const STORAGE_PREFIX = "wealth-atlas.display-preferences.v1";
// Valid compact schemas are under 12 KiB. Bound parsing of untrusted storage too.
const MAX_RAW_LENGTH = 32_768;

export function createDisplayPreferences(): DisplayPreferences {
  const layout = (): DisplayPreferences["devices"][DisplayDevice] => ({
    enabled: false,
    gap: 24,
    groupMotion: "none",
    items: HOME_MODULES.map((item) => ({
      id: item.id, width: item.width, height: item.height, padding: 22,
      title: 18, amount: item.amount, body: 13,
      titleWeight: 600, amountWeight: 700, bodyWeight: 400,
      motion: "none", duration: 280, visible: true, detailsExpanded: true,
    })),
  });
  return {
    version: 1,
    sidebar: { hidden: [] },
    devices: { desktop: layout(), tablet: layout(), mobile: layout() },
  };
}

// Read own enumerable data properties only; never invoke getters or retain input
// objects/toJSON methods. Symbols, prototypes and even non-enumerable extras fail.
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function boundedArray(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isInteger(length) || length < 0 || length > maximum) return null;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseModule(value: unknown): ModulePreference | null {
  const item = exactRecord(value, MODULE_KEYS);
  if (!item || typeof item.id !== "string" || !MODULE_IDS.has(item.id)
    || !boundedInteger(item.width, 4, 12) || ![4, 6, 8, 12].includes(item.width)
    || !boundedInteger(item.height, 144, 400) || !boundedInteger(item.padding, 14, 32)
    || !boundedInteger(item.title, 13, 28) || !boundedInteger(item.amount, 20, 64)
    || !boundedInteger(item.body, 13, 18) || !boundedInteger(item.duration, 120, 600)
    || !boundedInteger(item.titleWeight, 400, 700) || ![400, 600, 700].includes(item.titleWeight)
    || !boundedInteger(item.amountWeight, 400, 700) || ![400, 600, 700].includes(item.amountWeight)
    || !boundedInteger(item.bodyWeight, 400, 700) || ![400, 600, 700].includes(item.bodyWeight)
    || typeof item.motion !== "string" || !MOTIONS.includes(item.motion)
    || typeof item.visible !== "boolean" || typeof item.detailsExpanded !== "boolean") return null;
  return {
    id: item.id, width: item.width, height: item.height, padding: item.padding,
    title: item.title, amount: item.amount, body: item.body,
    titleWeight: item.titleWeight, amountWeight: item.amountWeight, bodyWeight: item.bodyWeight,
    motion: item.motion as MotionPreset, duration: item.duration,
    visible: item.visible, detailsExpanded: item.detailsExpanded,
  };
}

export function parseDisplayPreferences(value: unknown): DisplayPreferences | null {
  try {
    const root = exactRecord(value, ["version", "sidebar", "devices"]);
    if (!root || root.version !== 1) return null;
    const sidebar = exactRecord(root.sidebar, ["hidden"]);
    const hidden = sidebar && boundedArray(sidebar.hidden, HIDEABLE_IDS.size);
    if (!hidden || hidden.some((id) => typeof id !== "string" || !HIDEABLE_IDS.has(id))
      || new Set(hidden).size !== hidden.length) return null;
    const devices = exactRecord(root.devices, DEVICES);
    if (!devices) return null;
    const result = createDisplayPreferences();
    result.sidebar.hidden = hidden as string[];
    for (const device of DEVICES) {
      const layout = exactRecord(devices[device], ["enabled", "gap", "groupMotion", "items"]);
      if (!layout || typeof layout.enabled !== "boolean" || !boundedInteger(layout.gap, 12, 32)
        || (layout.groupMotion !== "none" && layout.groupMotion !== "stagger")) return null;
      const values = boundedArray(layout.items, HOME_MODULES.length);
      if (!values || values.length !== HOME_MODULES.length) return null;
      const items: ModulePreference[] = [];
      const seen = new Set<string>();
      for (const value of values) {
        const item = parseModule(value);
        if (!item || seen.has(item.id)) return null;
        seen.add(item.id);
        items.push(item);
      }
      result.devices[device] = {
        enabled: layout.enabled, gap: layout.gap, groupMotion: layout.groupMotion, items,
      };
    }
    return result;
  } catch {
    // Revoked/hostile proxies and malformed runtime input are invalid, not errors.
    return null;
  }
}

export function displayStorageKey(scope: DisplayScope): string | null {
  try {
    const value = exactRecord(scope, ["kind", "ownerId"]);
    if (!value || (value.ownerId !== null && typeof value.ownerId !== "string")) return null;
    // Non-cloud scopes deliberately never put owner metadata in a storage key.
    if (value.kind === "local" || value.kind === "guest") return `${STORAGE_PREFIX}.${value.kind}`;
    if (value.kind === "cloud" && typeof value.ownerId === "string"
      && /^[A-Za-z0-9_-]{1,128}$/.test(value.ownerId)) return `${STORAGE_PREFIX}.cloud.${value.ownerId}`;
    return null;
  } catch {
    return null;
  }
}

function parseRaw(raw: string): DisplayPreferences | null {
  if (raw.length > MAX_RAW_LENGTH) return null;
  try {
    return parseDisplayPreferences(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readDisplayPreferences(
  scope: DisplayScope,
  storage?: Pick<Storage, "getItem">,
): DisplayPreferencesReadResult {
  const fallback = (status: DisplayPreferencesReadResult["status"], raw: string | null = null): DisplayPreferencesReadResult => ({
    value: createDisplayPreferences(), raw, status,
  });
  const key = displayStorageKey(scope);
  if (key === null) return fallback("locked");
  try {
    // Resolving browser storage can itself throw (privacy/security restrictions).
    const target = storage === undefined ? globalThis.localStorage : storage;
    const raw = target.getItem(key);
    if (raw === null) return fallback("default");
    if (typeof raw !== "string") return fallback("unavailable");
    const value = parseRaw(raw);
    return value ? { value, raw, status: "stored" } : fallback("invalid", raw);
  } catch {
    return fallback("unavailable");
  }
}

export function writeDisplayPreferences(
  scope: DisplayScope,
  value: DisplayPreferences,
  expectedRaw: string | null,
  storage?: Pick<Storage, "getItem" | "setItem">,
): DisplayPreferencesWriteResult {
  const key = displayStorageKey(scope);
  if (key === null) return { ok: false, raw: null, reason: "locked" };
  const parsed = parseDisplayPreferences(value);
  if (!parsed || (expectedRaw !== null && typeof expectedRaw !== "string")) {
    return { ok: false, raw: null, reason: "invalid" };
  }
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const currentRaw = target.getItem(key);
    if (currentRaw !== null && typeof currentRaw !== "string") {
      return { ok: false, raw: null, reason: "unavailable" };
    }
    if (currentRaw !== expectedRaw) return { ok: false, raw: currentRaw, reason: "conflict" };
    // Corrupt/unknown versions need an explicit recovery workflow, not a save.
    if (currentRaw !== null && !parseRaw(currentRaw)) {
      return { ok: false, raw: currentRaw, reason: "invalid" };
    }
    const raw = JSON.stringify(parsed);
    target.setItem(key, raw);
    const readback = target.getItem(key);
    if (readback !== raw) return { ok: false, raw: null, reason: "unavailable" };
    return { ok: true, raw };
  } catch {
    // No exception text, storage contents, identities or tokens in diagnostics.
    return { ok: false, raw: null, reason: "unavailable" };
  }
}
