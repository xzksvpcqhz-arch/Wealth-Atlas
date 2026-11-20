import { assertActiveDataProfile, getDataProfile, type DataProfile } from "./data-profile";
import type { UpdateReply } from "./update-center";

export type DesktopVaultConnection = {
  connected: boolean;
  name: string;
};

export type DiagnosticFileResult = {
  fileName: string;
};

export type BackupEntry = {
  id: string;
  kind: "autosave" | "backup";
  path: string;
  createdAt: string | null;
  appVersion: string;
  schemaVersion: number | null;
};

export type RestoreSafetyBackup = {
  id: string;
  kind: "backup";
  path: string;
  createdAt: string;
  snapshotSha256: string;
  reused: false;
};

export type BackupWithIntegrity = {
  snapshot: unknown;
  snapshotSha256: string;
  integrity: "verified" | "legacy-unverified";
  schemaVersion: number | null;
  backupVersion: number | null;
};

export type WealthAtlasDesktopBridge = {
  isDesktop: true;
  activateDataProfile?: (key: string) => Promise<string>;
  appVersion: string;
  electronVersion: string;
  platform: string;
  isDiagnosticTest: boolean;
  isStorageReadFailureTest: boolean;
  startupTestMode: string;
  getUpdateState?: () => Promise<UpdateReply>;
  checkForUpdates?: () => Promise<UpdateReply>;
  openUpdateReleaseNotes?: () => Promise<{ ok: boolean; code?: string }>;
  getDataLocation: () => Promise<string>;
  getStartupContext: () => Promise<{ appVersion: string; previousAppVersion: string | null; requiresUpdateBackup: boolean; backupsPath: string }>;
  reportStartupStage: (stage: { stage: string; status: "running" | "success" | "failed"; errorId?: string }) => Promise<boolean>;
  createDataBackup: (payload: { snapshot: unknown; schemaVersion: number; reason: "app-update" | "migration" | "app-update-and-migration" }) => Promise<{ path: string; createdAt: string; reused?: boolean }>;
  createRestoreSafetyBackup: (payload: { snapshot: unknown; schemaVersion: number }) => Promise<RestoreSafetyBackup>;
  writeAutosave: (payload: { snapshot: unknown; schemaVersion: number }) => Promise<{ path: string; createdAt: string }>;
  listBackups: () => Promise<BackupEntry[]>;
  readBackup: (id: string, kind: "autosave" | "backup") => Promise<unknown>;
  readBackupWithIntegrity: (id: string, kind: "autosave" | "backup") => Promise<BackupWithIntegrity>;
  markStartupReady: () => Promise<boolean>;
  restartApp: () => Promise<boolean>;
  openBackupsLocation: () => Promise<boolean>;
  openLogsLocation: () => Promise<boolean>;
  copyDiagnostic: (diagnostic: unknown) => Promise<boolean>;
  saveDiagnostic: (diagnostic: unknown) => Promise<DiagnosticFileResult>;
  reportDiagnostic: (diagnostic: unknown) => Promise<boolean>;
  investmentRequest: (route: string, payload?: unknown) => Promise<{ok: boolean; value?: unknown; error?: string; status?: number}>;
  openInvestmentNote: (alias: string) => Promise<boolean>;
  selectVault: () => Promise<DesktopVaultConnection | null>;
  getVaultConnection: () => Promise<DesktopVaultConnection>;
  disconnectVault: () => Promise<boolean>;
  ensureDirectory: (relativePath: string, create: boolean) => Promise<boolean>;
  ensureFile: (relativePath: string, create: boolean) => Promise<boolean>;
  readFile: (relativePath: string) => Promise<string>;
  writeFile: (relativePath: string, content: string) => Promise<boolean>;
};

declare global {
  interface Window {
    wealthAtlasDesktop?: WealthAtlasDesktopBridge;
  }
}

const privateMethods = new Set(["investmentRequest", "openInvestmentNote", "getDataLocation", "getStartupContext", "createDataBackup", "createRestoreSafetyBackup", "writeAutosave", "listBackups", "readBackup", "readBackupWithIntegrity", "markStartupReady", "openBackupsLocation", "selectVault", "getVaultConnection", "disconnectVault", "ensureDirectory", "ensureFile", "readFile", "writeFile"]);

export async function activateDesktopDataProfile(scope: DataProfile): Promise<string | undefined> {
  const raw = typeof window === "undefined" ? null : window.wealthAtlasDesktop;
  if (!raw) return undefined;
  if (scope.kind === "local" && !raw.activateDataProfile) return undefined;
  if (!raw.activateDataProfile) throw new Error("桌面资料隔离桥接不可用，请先更新桌面应用。");
  return raw.activateDataProfile(scope.key);
}

export function getDesktopBridge() {
  if (typeof window === "undefined") return null;
  const raw = window.wealthAtlasDesktop;
  if (!raw) return null;
  const scope = getDataProfile();
  // contextBridge freezes its exposed object. Proxying that object directly
  // cannot replace non-configurable function values (Proxy invariants).
  return new Proxy({ ...raw }, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (!privateMethods.has(String(property)) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        assertActiveDataProfile(scope);
        return value(...args, { key: scope.key, token: scope.desktopToken });
      };
    },
  });
}

export function isDesktopApp() {
  return Boolean(getDesktopBridge()?.isDesktop);
}
