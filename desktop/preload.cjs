const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wealthAtlasDesktop", {
  isDesktop: true,
  getDataLocation: () => ipcRenderer.invoke("desktop:get-data-location"),
  selectVault: () => ipcRenderer.invoke("vault:select"),
  getVaultConnection: () => ipcRenderer.invoke("vault:get-connection"),
  disconnectVault: () => ipcRenderer.invoke("vault:disconnect"),
  ensureDirectory: (relativePath, create) => ipcRenderer.invoke("vault:ensure-directory", { relativePath, create }),
  ensureFile: (relativePath, create) => ipcRenderer.invoke("vault:ensure-file", { relativePath, create }),
  readFile: (relativePath) => ipcRenderer.invoke("vault:read-file", { relativePath }),
  writeFile: (relativePath, content) => ipcRenderer.invoke("vault:write-file", { relativePath, content }),
});
