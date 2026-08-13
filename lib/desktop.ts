export type DesktopVaultConnection = {
  connected: boolean;
  name: string;
};

export type WealthAtlasDesktopBridge = {
  isDesktop: true;
  getDataLocation: () => Promise<string>;
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
