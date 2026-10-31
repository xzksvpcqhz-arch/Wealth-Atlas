// 自定义背景（图片/动图）：IndexedDB 持久化（支持 4K 大图），最多保留 10 张历史。
import { assertActiveDataProfile, getDataProfile, isActiveDataProfile, type DataProfile } from "./data-profile";
export interface BackgroundItem {
  id: string;
  name: string;
  dataUrl: string;
  createdAt: string;
}

export const MAX_BACKGROUNDS = 10;
const DB_NAME = "wealth-atlas-backgrounds";
const STORE = "backgrounds";
const ACTIVE_KEY = "wealth-atlas-background-active";

function openDb(scope: DataProfile): Promise<IDBDatabase> {
  assertActiveDataProfile(scope);
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB 不可用")); return; }
    const req = indexedDB.open(scope.kind === "local" ? DB_NAME : `${DB_NAME}:profile:v1:${scope.key}`, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadBackgrounds(scope: DataProfile = getDataProfile()): Promise<BackgroundItem[]> {
  try {
    const db = await openDb(scope);
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const list = (req.result as BackgroundItem[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        resolve(isActiveDataProfile(scope) ? list.slice(0, MAX_BACKGROUNDS) : []);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function deleteBackgroundRecord(id: string, scope: DataProfile): Promise<void> {
  const db = await openDb(scope);
  assertActiveDataProfile(scope);
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** 新增背景（dataUrl），裁剪到最多 MAX_BACKGROUNDS 张。返回更新后的列表。 */
export async function addBackground(name: string, dataUrl: string): Promise<BackgroundItem[]> {
  const scope = getDataProfile();
  const item: BackgroundItem = { id: `bg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, dataUrl, createdAt: new Date().toISOString() };
  const db = await openDb(scope);
  assertActiveDataProfile(scope);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  const list = await loadBackgrounds(scope);
  for (const excess of list.slice(MAX_BACKGROUNDS)) await deleteBackgroundRecord(excess.id, scope);
  return loadBackgrounds(scope);
}

export async function removeBackground(id: string): Promise<BackgroundItem[]> {
  const scope = getDataProfile();
  await deleteBackgroundRecord(id, scope);
  assertActiveDataProfile(scope);
  if (loadActiveId() === id) setActiveId(null);
  return loadBackgrounds(scope);
}

const activeKey = () => getDataProfile().kind === "local" ? ACTIVE_KEY : `${ACTIVE_KEY}:profile:v1:${getDataProfile().key}`;

export function loadActiveId(): string | null {
  if (typeof window === "undefined" || getDataProfile().kind === "locked") return null;
  try { return window.localStorage.getItem(activeKey()); } catch { return null; }
}

export function setActiveId(id: string | null) {
  if (typeof window === "undefined" || getDataProfile().kind === "locked") return;
  try {
    if (id) window.localStorage.setItem(activeKey(), id);
    else window.localStorage.removeItem(activeKey());
  } catch { /* 忽略 */ }
}

/** 读取当前激活背景的 dataUrl。 */
export async function getActiveBackgroundData(): Promise<string | null> {
  const id = loadActiveId();
  if (!id) return null;
  const list = await loadBackgrounds();
  return list.find((item) => item.id === id)?.dataUrl ?? null;
}

/** 背景媒体类型：视频 / 图片（含动图 GIF）。 */
export function mediaKind(dataUrl: string): "video" | "image" {
  return dataUrl.startsWith("data:video/") ? "video" : "image";
}

export const BACKGROUND_CHANGE_EVENT = "wealth-atlas:background-change";

/** 通知背景已变更（供应用层重新渲染媒体层）。 */
export function notifyBackgroundChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BACKGROUND_CHANGE_EVENT));
}
