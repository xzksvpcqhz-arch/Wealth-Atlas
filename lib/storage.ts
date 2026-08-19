import Dexie, { type Table } from "dexie";
import { getDesktopBridge } from "./desktop";
import type { WealthData } from "./types";

export type StorageLifecycleEvent =
  | "open-start"
  | "open-success"
  | "blocked"
  | "versionchange"
  | "read-start"
  | "read-success"
  | "write-start"
  | "write-success";

export type StorageLifecycleReporter = (event: StorageLifecycleEvent) => void;

export class WealthStorageError extends Error {
  constructor(
    message: string,
    public readonly storageStage: "open" | "blocked" | "versionchange" | "read" | "write",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WealthStorageError";
  }
}

let lifecycleReporter: StorageLifecycleReporter | null = null;

function emitLifecycle(event: StorageLifecycleEvent) {
  try {
    lifecycleReporter?.(event);
  } catch {
    // A diagnostics callback must never break local storage.
  }
}

class WealthAtlasDatabase extends Dexie {
  snapshots!: Table<{ id: string; data: WealthData; updatedAt: string }, string>;
  obsidianHandles!: Table<{ id: string; handle: unknown; vaultName: string; updatedAt: string }, string>;
  blockedDuringOpen = false;
  versionChanged = false;

  constructor() {
    super("wealth-atlas");
    this.version(1).stores({ snapshots: "id, updatedAt" });
    this.version(2).stores({ snapshots: "id, updatedAt", obsidianHandles: "id, updatedAt" });
    this.on("blocked", () => {
      this.blockedDuringOpen = true;
      emitLifecycle("blocked");
    });
    this.on("versionchange", () => {
      this.versionChanged = true;
      emitLifecycle("versionchange");
      this.close({ disableAutoOpen: true });
    });
  }
}

export const db = typeof window !== "undefined" ? new WealthAtlasDatabase() : null;

function storageTestMode() {
  return getDesktopBridge()?.startupTestMode ?? "";
}

export async function initializeWealthStorage(reporter?: StorageLifecycleReporter) {
  if (!db) return;
  lifecycleReporter = reporter ?? lifecycleReporter;
  emitLifecycle("open-start");

  const testMode = storageTestMode();
  if (testMode === "indexeddb-open-failure") {
    throw new WealthStorageError("IndexedDB open diagnostic test", "open");
  }
  if (testMode === "indexeddb-blocked") {
    emitLifecycle("blocked");
    throw new WealthStorageError("IndexedDB is blocked by another application window.", "blocked");
  }
  if (testMode === "indexeddb-versionchange") {
    emitLifecycle("versionchange");
    throw new WealthStorageError("IndexedDB version changed during startup.", "versionchange");
  }

  try {
    db.blockedDuringOpen = false;
    db.versionChanged = false;
    if (!db.isOpen()) {
      const timeout = new Promise<never>((_, reject) => {
        window.setTimeout(() => {
          const stage = db.blockedDuringOpen ? "blocked" : "open";
          reject(new WealthStorageError(
            stage === "blocked"
              ? "IndexedDB is blocked by another application window."
              : "IndexedDB did not finish opening in time.",
            stage,
          ));
        }, 10000);
      });
      await Promise.race([db.open(), timeout]);
    }
    if (db.versionChanged) {
      throw new WealthStorageError("IndexedDB version changed during startup.", "versionchange");
    }
    emitLifecycle("open-success");
  } catch (error) {
    if (error instanceof WealthStorageError) throw error;
    throw new WealthStorageError("IndexedDB could not be opened. Existing data was not changed.", "open", { cause: error });
  }
}

export async function retryWealthStorage(reporter?: StorageLifecycleReporter) {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Explicit reopen below remains the source of truth.
  }
  await initializeWealthStorage(reporter);
}

export async function saveWealthData(data: WealthData) {
  if (!db) return;
  await initializeWealthStorage();
  emitLifecycle("write-start");
  try {
    await db.snapshots.put({ id: "current", data, updatedAt: new Date().toISOString() });
    emitLifecycle("write-success");
  } catch (error) {
    throw new WealthStorageError("The local snapshot could not be saved. Existing data was not cleared.", "write", { cause: error });
  }
}

export async function loadWealthData(reporter?: StorageLifecycleReporter) {
  if (!db) return null;
  await initializeWealthStorage(reporter);
  emitLifecycle("read-start");
  try {
    if (getDesktopBridge()?.isStorageReadFailureTest) {
      throw new Error("IndexedDB startup diagnostic test");
    }
    const snapshot = await db.snapshots.get("current");
    emitLifecycle("read-success");
    return snapshot?.data ?? null;
  } catch (error) {
    throw new WealthStorageError("The current local snapshot could not be read. Existing data was not changed.", "read", { cause: error });
  }
}

export async function saveObsidianHandle(handle: unknown, vaultName: string) {
  if (!db) return;
  await initializeWealthStorage();
  const storedHandle = getDesktopBridge() ? { kind: "desktop-vault" } : handle;
  await db.obsidianHandles.put({ id: "current", handle: storedHandle, vaultName, updatedAt: new Date().toISOString() });
}

export async function loadObsidianHandle() {
  if (!db) return null;
  await initializeWealthStorage();
  const stored = await db.obsidianHandles.get("current");
  return stored ? { handle: stored.handle, vaultName: stored.vaultName } : null;
}

export async function clearObsidianHandle() {
  if (!db) return;
  await initializeWealthStorage();
  await getDesktopBridge()?.disconnectVault();
  await db.obsidianHandles.delete("current");
}
