const { contextBridge, ipcRenderer } = require("electron");

const startupTestMode = process.env.WEALTH_ATLAS_DESKTOP_SMOKE ?? "";
const diagnosticTestModes = new Set([
  "error-boundary",
  "diagnostic-browser-clipboard",
  "diagnostic-ipc-clipboard",
  "diagnostic-ipc-failure",
  "diagnostic-save-failure",
]);
const privateInvoke = (channel, payload, profile) => ipcRenderer.invoke(channel, { payload, __profile: profile });

contextBridge.exposeInMainWorld("wealthAtlasDesktop", {
  isDesktop: true,
  appVersion: ipcRenderer.sendSync("desktop:get-app-version"),
  electronVersion: process.versions.electron,
  platform: process.platform,
  isDiagnosticTest: diagnosticTestModes.has(startupTestMode),
  isStorageReadFailureTest: startupTestMode === "indexeddb-read-failure",
  startupTestMode,
  activateDataProfile: (key) => ipcRenderer.invoke("desktop:activate-data-profile", key),
  getDataLocation: (profile) => privateInvoke("desktop:get-data-location", undefined, profile),
  getStartupContext: (profile) => privateInvoke("desktop:get-startup-context", undefined, profile),
  reportStartupStage: (stage) => ipcRenderer.invoke("desktop:report-startup-stage", stage),
  createDataBackup: (payload, profile) => privateInvoke("desktop:create-data-backup", payload, profile),
  writeAutosave: (payload, profile) => privateInvoke("desktop:write-autosave", payload, profile),
  listBackups: (profile) => privateInvoke("desktop:list-backups", undefined, profile),
  readBackup: (id, kind, profile) => privateInvoke("desktop:read-backup", { id, kind }, profile),
  markStartupReady: (profile) => privateInvoke("desktop:mark-startup-ready", undefined, profile),
  restartApp: () => ipcRenderer.invoke("desktop:restart-app"),
  openBackupsLocation: (profile) => privateInvoke("desktop:open-backups-location", undefined, profile),
  openLogsLocation: () => ipcRenderer.invoke("diagnostics:open-location"),
  copyDiagnostic: (diagnostic) => ipcRenderer.invoke("diagnostics:copy", diagnostic),
  saveDiagnostic: (diagnostic) => ipcRenderer.invoke("diagnostics:save", diagnostic),
  reportDiagnostic: (diagnostic) => ipcRenderer.invoke("diagnostics:renderer", diagnostic),
  selectVault: (profile) => privateInvoke("vault:select", undefined, profile),
  getVaultConnection: (profile) => privateInvoke("vault:get-connection", undefined, profile),
  disconnectVault: (profile) => privateInvoke("vault:disconnect", undefined, profile),
  ensureDirectory: (relativePath, create, profile) => privateInvoke("vault:ensure-directory", { relativePath, create }, profile),
  ensureFile: (relativePath, create, profile) => privateInvoke("vault:ensure-file", { relativePath, create }, profile),
  readFile: (relativePath, profile) => privateInvoke("vault:read-file", { relativePath }, profile),
  writeFile: (relativePath, content, profile) => privateInvoke("vault:write-file", { relativePath, content }, profile),
});
