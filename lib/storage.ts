import Dexie, { type Table } from "dexie";
import { getDesktopBridge } from "./desktop";
import type { WealthData } from "./types";

class WealthAtlasDatabase extends Dexie {
  snapshots!: Table<{ id: string; data: WealthData; updatedAt: string }, string>;
  obsidianHandles!: Table<{ id: string; handle: unknown; vaultName: string; updatedAt: string }, string>;

  constructor() {
    super("wealth-atlas");
    this.version(1).stores({ snapshots: "id, updatedAt" });
    this.version(2).stores({ snapshots: "id, updatedAt", obsidianHandles: "id, updatedAt" });
  }
}

export const db = typeof window !== "undefined" ? new WealthAtlasDatabase() : null;

export async function saveWealthData(data: WealthData) {
  if (!db) return;
  await db.snapshots.put({ id: "current", data, updatedAt: new Date().toISOString() });
}

export async function loadWealthData() {
  if (!db) return null;
  const snapshot = await db.snapshots.get("current");
  return snapshot?.data ?? null;
}

export async function saveObsidianHandle(handle: unknown, vaultName: string) {
  if (!db) return;
  const storedHandle = getDesktopBridge() ? { kind: "desktop-vault" } : handle;
  await db.obsidianHandles.put({ id: "current", handle: storedHandle, vaultName, updatedAt: new Date().toISOString() });
}

export async function loadObsidianHandle() {
  if (!db) return null;
  const stored = await db.obsidianHandles.get("current");
  return stored ? { handle: stored.handle, vaultName: stored.vaultName } : null;
}

export async function clearObsidianHandle() {
  if (!db) return;
  await getDesktopBridge()?.disconnectVault();
  await db.obsidianHandles.delete("current");
}
