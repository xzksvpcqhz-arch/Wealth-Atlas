const { contextBridge, ipcRenderer } = require("electron");

const startupTestMode = process.env.WEALTH_ATLAS_DESKTOP_SMOKE ?? "";
const diagnosticTestModes = new Set([
  "error-boundary",
  "diagnostic-browser-clipboard",
  "diagnostic-ipc-clipboard",
  "diagnostic-ipc-failure",
  "diagnostic-save-failure",
]);

contextBridge.exposeInMainWorld("wealthAtlasDesktop", {
  isDesktop: true,
  appVersion: ipcRenderer.sendSync("desktop:get-app-version"),
  electronVersion: process.versions.electron,
  platform: process.platform,
  isDiagnosticTest: diagnosticTestModes.has(startupTestMode),
  isStorageReadFailureTest: startupTestMode === "indexeddb-read-failure",
  startupTestMode,
  getDataLocation: () => ipcRenderer.invoke("desktop:get-data-location"),
  getStartupContext: () => ipcRenderer.invoke("desktop:get-startup-context"),
  reportStartupStage: (stage) => ipcRenderer.invoke("desktop:report-startup-stage", stage),
  createDataBackup: (payload) => ipcRenderer.invoke("desktop:create-data-backup", payload),
  markStartupReady: () => ipcRenderer.invoke("desktop:mark-startup-ready"),
  restartApp: () => ipcRenderer.invoke("desktop:restart-app"),
  openBackupsLocation: () => ipcRenderer.invoke("desktop:open-backups-location"),
  openLogsLocation: () => ipcRenderer.invoke("diagnostics:open-location"),
  copyDiagnostic: (diagnostic) => ipcRenderer.invoke("diagnostics:copy", diagnostic),
  saveDiagnostic: (diagnostic) => ipcRenderer.invoke("diagnostics:save", diagnostic),
  reportDiagnostic: (diagnostic) => ipcRenderer.invoke("diagnostics:renderer", diagnostic),
  selectVault: () => ipcRenderer.invoke("vault:select"),
  getVaultConnection: () => ipcRenderer.invoke("vault:get-connection"),
  disconnectVault: () => ipcRenderer.invoke("vault:disconnect"),
  ensureDirectory: (relativePath, create) => ipcRenderer.invoke("vault:ensure-directory", { relativePath, create }),
  ensureFile: (relativePath, create) => ipcRenderer.invoke("vault:ensure-file", { relativePath, create }),
  readFile: (relativePath) => ipcRenderer.invoke("vault:read-file", { relativePath }),
  writeFile: (relativePath, content) => ipcRenderer.invoke("vault:write-file", { relativePath, content }),
});
