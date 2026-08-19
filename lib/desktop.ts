export type DesktopVaultConnection = {
  connected: boolean;
  name: string;
};

export type DiagnosticFileResult = {
  fileName: string;
};

export type WealthAtlasDesktopBridge = {
  isDesktop: true;
  appVersion: string;
  electronVersion: string;
  platform: string;
  isDiagnosticTest: boolean;
  isStorageReadFailureTest: boolean;
  startupTestMode: string;
  getDataLocation: () => Promise<string>;
  getStartupContext: () => Promise<{ appVersion: string; previousAppVersion: string | null; requiresUpdateBackup: boolean; backupsPath: string }>;
  reportStartupStage: (stage: { stage: string; status: "running" | "success" | "failed"; errorId?: string }) => Promise<boolean>;
  createDataBackup: (payload: { snapshot: unknown; schemaVersion: number; reason: "app-update" | "migration" | "app-update-and-migration" }) => Promise<{ path: string; createdAt: string; reused?: boolean }>;
  markStartupReady: () => Promise<boolean>;
  restartApp: () => Promise<boolean>;
  openBackupsLocation: () => Promise<boolean>;
  openLogsLocation: () => Promise<boolean>;
  copyDiagnostic: (diagnostic: unknown) => Promise<boolean>;
  saveDiagnostic: (diagnostic: unknown) => Promise<DiagnosticFileResult>;
  reportDiagnostic: (diagnostic: unknown) => Promise<boolean>;
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

export function getDesktopBridge() {
  if (typeof window === "undefined") return null;
  return window.wealthAtlasDesktop ?? null;
}

export function isDesktopApp() {
  return Boolean(getDesktopBridge()?.isDesktop);
}
