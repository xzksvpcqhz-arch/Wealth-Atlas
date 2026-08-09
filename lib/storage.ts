import Dexie, { type Table } from "dexie";
import type { WealthData } from "./types";

class WealthAtlasDatabase extends Dexie {
  snapshots!: Table<{ id: string; data: WealthData; updatedAt: string }, string>;

  constructor() {
    super("wealth-atlas");
    this.version(1).stores({ snapshots: "id, updatedAt" });
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
