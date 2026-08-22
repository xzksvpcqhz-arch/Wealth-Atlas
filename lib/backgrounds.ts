// 自定义背景（图片/动图）：localStorage 持久化，最多保留 10 张历史。
export interface BackgroundItem {
  id: string;
  name: string;
  dataUrl: string;
  createdAt: string;
}

const STORAGE_KEY = "wealth-atlas-backgrounds";
const ACTIVE_KEY = "wealth-atlas-background-active";
export const MAX_BACKGROUNDS = 10;

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略写入失败
  }
}

export function loadBackgrounds(): BackgroundItem[] {
  const list = read<BackgroundItem[]>(STORAGE_KEY, []);
  return Array.isArray(list) ? list.slice(0, MAX_BACKGROUNDS) : [];
}

export function loadActiveBackground(): string | null {
  return read<string | null>(ACTIVE_KEY, null);
}

/** 新增背景（dataUrl），裁剪到最多 MAX_BACKGROUNDS 张。返回更新后的列表。 */
export function addBackground(name: string, dataUrl: string): BackgroundItem[] {
  const list = loadBackgrounds();
  const item: BackgroundItem = { id: `bg-${Date.now()}`, name, dataUrl, createdAt: new Date().toISOString() };
  const next = [item, ...list].slice(0, MAX_BACKGROUNDS);
  write(STORAGE_KEY, next);
  return next;
}

export function removeBackground(id: string): BackgroundItem[] {
  const next = loadBackgrounds().filter((item) => item.id !== id);
  write(STORAGE_KEY, next);
  if (loadActiveBackground() === id) setActiveBackground(null);
  return next;
}

export function setActiveBackground(id: string | null) {
  write(ACTIVE_KEY, id);
}

export function getActiveBackgroundData(): string | null {
  const id = loadActiveBackground();
  if (!id) return null;
  return loadBackgrounds().find((item) => item.id === id)?.dataUrl ?? null;
}

/** 把背景（dataUrl 或 null）应用到根元素 CSS 变量。 */
export function applyBackgroundToDom(dataUrl: string | null) {
  if (typeof document === "undefined") return;
  if (dataUrl) {
    document.documentElement.style.setProperty("--custom-bg", `url("${dataUrl}")`);
    document.documentElement.dataset.customBg = "1";
  } else {
    document.documentElement.style.removeProperty("--custom-bg");
    delete document.documentElement.dataset.customBg;
  }
}
