const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, session, shell } = require("electron");
// electron-updater 仅桌面版需要，未打包时静默跳过（不阻断启动）
let autoUpdater = null;
try { autoUpdater = require("electron-updater").autoUpdater; } catch { /* 开发/未打包 electron-updater 时忽略 */ }
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const SCHEME = "wealth-atlas";
const APP_ORIGIN = `${SCHEME}://app`;
const devUrlArgument = process.argv.find((argument) => argument.startsWith("--dev-url="));
const devUrl = app.isPackaged ? null : (devUrlArgument?.slice("--dev-url=".length) ?? null);
const smokeMode = process.env.WEALTH_ATLAS_DESKTOP_SMOKE
  ?? process.argv.find((argument) => argument.startsWith("--desktop-smoke="))?.slice("--desktop-smoke=".length)
  ?? null;
const explicitTestProfile = process.env.WEALTH_ATLAS_TEST_PROFILE;
const MAX_LOG_BYTES = 512 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;
let rendererLogQueue = Promise.resolve();
let vaultDisconnectInvocationCount = 0;
let restartInvocationCount = 0;
let diagnosticClipboardInvocationCount = 0;
let diagnosticSaveInvocationCount = 0;
let logsOpenInvocationCount = 0;
let sessionBackup = null;
const startedAt = new Date().toISOString();
const startupStages = [];
let startupStatus = "starting";
let startupLastEvent = "process-start";

function sanitizeLogValue(value, maxLength = 1200) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]*(?:PRIVATE|OPENSSH) KEY-----[\s\S]*?-----END [^-]*KEY-----/gi, "[redacted-key]")
    .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, "[redacted-path]")
    .replace(/\b(?:MYR|SGD|USD|RM)\s*[-+]?\d[\d,.]*/gi, "[redacted-financial-value]")
    .replace(/("(?:account|balance|transaction|budget|asset|fxRate|obsidian)[^"]*"\s*:\s*)"[^"]*"/gi, "$1\"[redacted]\"")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .slice(0, maxLength);
}

function normalizeSafeDiagnostic(payload) {
  const input = payload && typeof payload === "object" ? payload : {};
  const schemaVersion = Number(input.schemaVersion);
  return {
    id: sanitizeLogValue(input.id || makeStartupErrorId(), 80),
    timestamp: sanitizeLogValue(input.timestamp || new Date().toISOString(), 60),
    name: sanitizeLogValue(input.name || "Error", 80),
    message: sanitizeLogValue(input.message || "Unexpected application error", 700),
    stack: sanitizeLogValue(input.stack || "unavailable", 1600),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    mode: app.isPackaged ? "desktop-production" : "desktop-development",
    stage: sanitizeLogValue(input.stage || "react-initialization", 80),
    schemaVersion: Number.isInteger(schemaVersion) && schemaVersion > 0 ? schemaVersion : "unknown",
  };
}

function formatSafeDiagnostic(payload) {
  const diagnostic = normalizeSafeDiagnostic(payload);
  return [
    "Wealth Atlas " + diagnostic.appVersion,
    "Schema version: " + diagnostic.schemaVersion,
    "Error ID: " + diagnostic.id,
    "Time: " + diagnostic.timestamp,
    "Error: " + diagnostic.name + ": " + diagnostic.message,
    "Electron: " + diagnostic.electronVersion,
    "Platform: " + diagnostic.platform,
    "Mode: " + diagnostic.mode,
    "Startup stage: " + diagnostic.stage,
    "Stack: " + diagnostic.stack,
  ].join("\n");
}

function diagnosticFileName(payload) {
  const diagnostic = normalizeSafeDiagnostic(payload);
  const safeId = diagnostic.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return "diagnostic-" + safeId + ".txt";
}
function rendererLogPath() {
  return path.join(app.getPath("userData"), "logs", "renderer.log");
}

async function writeDiagnosticLog(event, details = {}) {
  const next = rendererLogQueue.catch(() => undefined).then(async () => {
    try {
      const logPath = rendererLogPath();
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      try {
        const stat = await fs.stat(logPath);
        if (stat.size >= MAX_LOG_BYTES) {
          const current = await fs.readFile(logPath, "utf8");
          await fs.writeFile(logPath, current.slice(-Math.floor(LOG_KEEP_BYTES / 2)), "utf8");
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const safeDetails = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, sanitizeLogValue(value)]));
      const entry = { timestamp: new Date().toISOString(), event: sanitizeLogValue(event, 80), appVersion: app.getVersion(), electronVersion: process.versions.electron, platform: process.platform, mode: app.isPackaged ? "desktop-production" : "desktop-development", ...safeDetails };
      await fs.appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // Diagnostics must never prevent the application from starting.
    }
  });
  rendererLogQueue = next;
  await next;
}

function logsDirectory() {
  return path.join(app.getPath("userData"), "logs");
}

function mainLogPath() {
  return path.join(logsDirectory(), "main.log");
}

function startupPath() {
  return path.join(logsDirectory(), "startup.json");
}

function buildMainEntry(event, details = {}) {
  const safeDetails = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, sanitizeLogValue(value)]));
  return {
    timestamp: new Date().toISOString(),
    event: sanitizeLogValue(event, 80),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    mode: app.isPackaged ? "desktop-production" : "desktop-development",
    ...safeDetails,
  };
}

function startupSnapshot() {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    mode: app.isPackaged ? "desktop-production" : "desktop-development",
    startedAt,
    updatedAt: new Date().toISOString(),
    status: startupStatus,
    lastEvent: startupLastEvent,
    stages: startupStages.slice(-40),
  };
}

function rotateLogSync(logPath) {
  try {
    const stat = fsSync.statSync(logPath);
    if (stat.size < MAX_LOG_BYTES) return;
    const current = fsSync.readFileSync(logPath, "utf8");
    fsSync.writeFileSync(logPath, current.slice(-Math.floor(LOG_KEEP_BYTES / 2)), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function updateStartupStatus(event) {
  startupLastEvent = sanitizeLogValue(event, 80);
  if (event === "load-url-finished" && !new Set(["failed", "startup-failed", "load-failed", "renderer-gone", "crashed"]).has(startupStatus)) startupStatus = "renderer-loading";
  else if (event === "did-fail-load") startupStatus = "load-failed";
  else if (event === "render-process-gone") startupStatus = "renderer-gone";
  else if (event === "uncaught-exception") startupStatus = "crashed";
  else if (event === "startup-failed") startupStatus = "startup-failed";
}

function initializeDiagnosticsSync() {
  try {
    fsSync.mkdirSync(logsDirectory(), { recursive: true });
    for (const logPath of [mainLogPath(), rendererLogPath()]) {
      rotateLogSync(logPath);
      fsSync.closeSync(fsSync.openSync(logPath, "a"));
    }
    fsSync.writeFileSync(startupPath(), JSON.stringify(startupSnapshot(), null, 2) + "\n", "utf8");
  } catch {
    // Diagnostics must never prevent the application from starting.
  }
}

function writeMainLog(event, details = {}) {
  try {
    fsSync.mkdirSync(logsDirectory(), { recursive: true });
    rotateLogSync(mainLogPath());
    fsSync.appendFileSync(mainLogPath(), JSON.stringify(buildMainEntry(event, details)) + "\n", "utf8");
    updateStartupStatus(event);
    fsSync.writeFileSync(startupPath(), JSON.stringify(startupSnapshot(), null, 2) + "\n", "utf8");
  } catch {
    // Diagnostics must never prevent the application from starting.
  }
}

const STARTUP_STAGE_NAMES = new Set([
  "electron-app-ready",
  "local-protocol",
  "logs-directory",
  "browser-window",
  "static-page",
  "react-initialization",
  "indexeddb-initialization",
  "data-read",
  "migration",
  "home-ready",
]);

function makeStartupErrorId() {
  return `WA-MAIN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function recordStartupStage(stage, status, errorId = "") {
  if (!STARTUP_STAGE_NAMES.has(stage)) throw new Error("Unknown startup stage.");
  if (!new Set(["running", "success", "failed"]).has(status)) throw new Error("Unknown startup stage status.");
  const entry = {
    stage,
    status,
    errorId: status === "failed" ? sanitizeLogValue(errorId || makeStartupErrorId(), 80) : "",
    timestamp: new Date().toISOString(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
  };
  startupStages.push(entry);
  if (startupStages.length > 40) startupStages.splice(0, startupStages.length - 40);
  startupLastEvent = `stage:${stage}:${status}`;
  if (status === "failed" && !new Set(["startup-failed", "load-failed", "renderer-gone", "crashed"]).has(startupStatus)) startupStatus = "failed";
  else if (stage === "home-ready" && status === "success") {
    const unresolvedFailure = startupStages.some((failedEntry, index) => failedEntry.status === "failed" && !startupStages.slice(index + 1).some((laterEntry) => laterEntry.stage === failedEntry.stage && laterEntry.status === "success"));
    if (!unresolvedFailure) startupStatus = "ready";
  }
  try {
    fsSync.mkdirSync(logsDirectory(), { recursive: true });
    fsSync.appendFileSync(mainLogPath(), JSON.stringify(buildMainEntry("startup-stage", entry)) + "\n", "utf8");
    fsSync.writeFileSync(startupPath(), JSON.stringify(startupSnapshot(), null, 2) + "\n", "utf8");
  } catch {
    // Startup diagnostics must never prevent the application from starting.
  }
  return entry;
}

function backupsDirectory() {
  return path.join(app.getPath("userData"), "backups");
}

function releaseStatePath() {
  return path.join(app.getPath("userData"), "release-state.json");
}

async function readReleaseState() {
  try {
    const parsed = JSON.parse(await fs.readFile(releaseStatePath(), "utf8"));
    return typeof parsed?.lastReadyAppVersion === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeReleaseState() {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(releaseStatePath(), JSON.stringify({ lastReadyAppVersion: app.getVersion(), updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
}

function backupFolderStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

async function findReusableBackup(snapshotSha256, schemaVersion, reason) {
  try {
    const entries = await fs.readdir(backupsDirectory(), { withFileTypes: true });
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const destination = path.join(backupsDirectory(), entry.name);
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(destination, "metadata.json"), "utf8"));
        if (
          metadata?.backupVersion !== 2
          || metadata?.appVersion !== app.getVersion()
          || Number(metadata?.schemaVersion) !== schemaVersion
          || metadata?.reason !== reason
          || metadata?.snapshotSha256 !== snapshotSha256
          || Date.parse(metadata?.createdAt) < cutoff
        ) continue;
        const snapshotFile = await fs.readFile(path.join(destination, "wealth-data.json"));
        const storedHash = createHash("sha256").update(snapshotFile).digest("hex");
        if (storedHash !== snapshotSha256) continue;
        return { path: destination, createdAt: metadata.createdAt, reused: true };
      } catch {
        // An incomplete or legacy backup is never reused and is never deleted.
      }
    }
  } catch {
    // Failure to scan existing backups falls back to creating a new safe backup.
  }
  return null;
}

async function createDataBackup(payload) {
  if (sessionBackup) return sessionBackup;
  const allowedReasons = new Set(["app-update", "migration", "app-update-and-migration"]);
  if (!allowedReasons.has(payload?.reason)) throw new Error("Backup reason is invalid.");
  const schemaVersion = Number(payload?.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error("Backup schema version is invalid.");

  const snapshotJson = JSON.stringify(payload.snapshot ?? null, null, 2) + "\n";
  const snapshotBuffer = Buffer.from(snapshotJson, "utf8");
  const snapshotSha256 = createHash("sha256").update(snapshotBuffer).digest("hex");
  await fs.mkdir(backupsDirectory(), { recursive: true });

  const reusable = await findReusableBackup(snapshotSha256, schemaVersion, payload.reason);
  if (reusable) {
    sessionBackup = reusable;
    writeMainLog("data-backup-reused", { schemaVersion, reason: payload.reason });
    return sessionBackup;
  }

  const createdAt = new Date();
  const milliseconds = String(createdAt.getUTCMilliseconds()).padStart(3, "0");
  const folderName = backupFolderStamp(createdAt) + milliseconds + "-v" + app.getVersion() + "-schema-" + schemaVersion;
  const destination = path.join(backupsDirectory(), folderName);
  await fs.mkdir(destination, { recursive: false });

  const metadata = {
    backupVersion: 2,
    createdAt: createdAt.toISOString(),
    appVersion: app.getVersion(),
    schemaVersion,
    reason: payload.reason,
    source: "wealth-atlas-desktop",
    networkUpload: false,
    snapshotSha256,
    manifest: "manifest.json",
  };
  const manifest = {
    createdAt: metadata.createdAt,
    appVersion: metadata.appVersion,
    schemaVersion,
    files: [{
      name: "wealth-data.json",
      bytes: snapshotBuffer.byteLength,
      sha256: snapshotSha256,
    }],
  };

  await fs.writeFile(path.join(destination, "wealth-data.json"), snapshotBuffer);
  await fs.writeFile(path.join(destination, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  sessionBackup = { path: destination, createdAt: metadata.createdAt, reused: false };
  writeMainLog("data-backup-created", { folder: folderName, schemaVersion, reason: payload.reason });
  return sessionBackup;
}
async function writeSmokeLog(message) {
  if (!smokeMode) return;
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.appendFile(path.join(app.getPath("userData"), "smoke.log"), `${new Date().toISOString()} ${sanitizeLogValue(message)}\n`, "utf8");
}

if (smokeMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
      codeCache: true,
    },
  },
]);

if (explicitTestProfile) {
  app.setPath("userData", path.resolve(explicitTestProfile));
} else {
  app.setPath("userData", path.join(app.getPath("appData"), "Wealth Atlas"));
}

initializeDiagnosticsSync();
writeMainLog("process-start");
writeMainLog("privileged-scheme-registered", { scheme: SCHEME });

process.on("uncaughtExceptionMonitor", (error) => {
  writeMainLog("uncaught-exception", { name: error?.name, message: error?.message, stack: error?.stack });
});
process.on("unhandledRejection", (reason) => {
  writeMainLog("unhandled-rejection", {
    name: reason?.name ?? "UnhandledRejection",
    message: reason?.message ?? reason,
    stack: reason?.stack,
  });
});

function isTrustedSender(event) {
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  return senderUrl.startsWith(APP_ORIGIN) || (devUrl ? senderUrl.startsWith(devUrl) : false);
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error("拒绝来自非 Wealth Atlas 页面请求的桌面操作。");
}

function vaultConfigPath() {
  return path.join(app.getPath("userData"), "vault-connection.json");
}

async function readVaultConfig() {
  try {
    const raw = await fs.readFile(vaultConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.path === "string" && typeof parsed?.name === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function saveVaultConfig(config) {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.writeFile(vaultConfigPath(), JSON.stringify(config, null, 2), "utf8");
}

function normalizeRelativePath(relativePath) {
  if (typeof relativePath !== "string") throw new Error("Vault 路径无效。");
  const normalized = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (normalized.some((segment) => segment === "." || segment === "..")) throw new Error("Vault 路径超出已选择的目录。");
  return normalized;
}

async function resolveVaultPath(relativePath) {
  const config = await readVaultConfig();
  if (!config) throw new Error("尚未连接 Obsidian Vault，请重新选择文件夹。");
  const root = path.resolve(config.path);
  const target = path.resolve(root, ...normalizeRelativePath(relativePath));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Vault 路径超出已选择的目录。");
  return { config, target };
}

function registerDesktopIpc() {
  ipcMain.on("desktop:get-app-version", (event) => { event.returnValue = app.getVersion(); });

  ipcMain.handle("desktop:get-data-location", (event) => {
    assertTrustedSender(event);
    return app.getPath("userData");
  });

  ipcMain.handle("desktop:get-startup-context", async (event) => {
    assertTrustedSender(event);
    const releaseState = await readReleaseState();
    return {
      appVersion: app.getVersion(),
      previousAppVersion: releaseState?.lastReadyAppVersion ?? null,
      requiresUpdateBackup: releaseState?.lastReadyAppVersion !== app.getVersion(),
      backupsPath: backupsDirectory(),
    };
  });

  ipcMain.handle("desktop:report-startup-stage", async (event, payload) => {
    assertTrustedSender(event);
    recordStartupStage(payload?.stage, payload?.status, payload?.errorId);
    return true;
  });

  ipcMain.handle("desktop:create-data-backup", async (event, payload) => {
    assertTrustedSender(event);
    try {
      return await createDataBackup(payload);
    } catch (error) {
      writeMainLog("data-backup-failed", { name: error?.name, message: error?.message });
      throw error;
    }
  });

  ipcMain.handle("desktop:mark-startup-ready", async (event) => {
    assertTrustedSender(event);
    await writeReleaseState();
    return true;
  });

  ipcMain.handle("desktop:restart-app", async (event) => {
    assertTrustedSender(event);
    restartInvocationCount += 1;
    if (smokeMode === "error-boundary") return true;
    setImmediate(() => {
      app.relaunch();
      app.exit(0);
    });
    return true;
  });

  ipcMain.handle("desktop:open-backups-location", async (event) => {
    assertTrustedSender(event);
    await fs.mkdir(backupsDirectory(), { recursive: true });
    if (smokeMode) return true;
    const result = await shell.openPath(backupsDirectory());
    if (result) throw new Error("Unable to open the local backup directory.");
    return true;
  });

  ipcMain.handle("diagnostics:copy", async (event, payload) => {
    assertTrustedSender(event);
    diagnosticClipboardInvocationCount += 1;
    if (smokeMode === "diagnostic-ipc-failure") throw new Error("Diagnostic clipboard smoke failure");
    const diagnosticText = formatSafeDiagnostic(payload);
    clipboard.writeText(diagnosticText);
    if (clipboard.readText() !== diagnosticText) throw new Error("The operating system clipboard did not accept the diagnostic text.");
    return true;
  });

  ipcMain.handle("diagnostics:save", async (event, payload) => {
    assertTrustedSender(event);
    diagnosticSaveInvocationCount += 1;
    if (smokeMode === "diagnostic-save-failure") throw new Error("Diagnostic save smoke failure");
    await fs.mkdir(logsDirectory(), { recursive: true });
    const fileName = diagnosticFileName(payload);
    await fs.writeFile(path.join(logsDirectory(), fileName), formatSafeDiagnostic(payload) + "\n", "utf8");
    return { fileName };
  });

  ipcMain.handle("diagnostics:open-location", async (event) => {
    assertTrustedSender(event);
    logsOpenInvocationCount += 1;
    await fs.mkdir(logsDirectory(), { recursive: true });
    if (smokeMode) return true;
    const result = await shell.openPath(logsDirectory());
    if (result) throw new Error("Unable to open the local logs directory.");
    return true;
  });

  ipcMain.handle("diagnostics:renderer", async (event, payload) => {
    assertTrustedSender(event);
    const safePayload = normalizeSafeDiagnostic(payload);
    await writeDiagnosticLog("renderer-diagnostic", safePayload);
    return true;
  });
  ipcMain.handle("vault:get-connection", async (event) => {
    assertTrustedSender(event);
    const config = await readVaultConfig();
    return config ? { connected: true, name: config.name } : { connected: false, name: "" };
  });

  ipcMain.handle("vault:select", async (event) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(owner, {
      title: "选择 Obsidian Vault",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selectedPath = path.resolve(result.filePaths[0]);
    const config = { path: selectedPath, name: path.basename(selectedPath), connectedAt: new Date().toISOString() };
    await saveVaultConfig(config);
    return { connected: true, name: config.name };
  });

  ipcMain.handle("vault:disconnect", async (event) => {
    assertTrustedSender(event);
    vaultDisconnectInvocationCount += 1;
    if (smokeMode === "obsidian-disconnect-failure") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      throw new Error("Obsidian disconnect smoke failure");
    }
    if (smokeMode === "obsidian-disconnect-success") await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      await fs.unlink(vaultConfigPath());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return true;
  });

  ipcMain.handle("vault:ensure-directory", async (event, payload) => {
    assertTrustedSender(event);
    const { target } = await resolveVaultPath(payload?.relativePath);
    if (payload?.create === true) await fs.mkdir(target, { recursive: true });
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw new Error("目标不是文件夹。");
    return true;
  });

  ipcMain.handle("vault:ensure-file", async (event, payload) => {
    assertTrustedSender(event);
    const { target } = await resolveVaultPath(payload?.relativePath);
    if (payload?.create === true) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const handle = await fs.open(target, "a");
      await handle.close();
    }
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("目标不是文件。");
    return true;
  });

  ipcMain.handle("vault:read-file", async (event, payload) => {
    assertTrustedSender(event);
    const { target } = await resolveVaultPath(payload?.relativePath);
    return fs.readFile(target, "utf8");
  });

  ipcMain.handle("vault:write-file", async (event, payload) => {
    assertTrustedSender(event);
    if (typeof payload?.content !== "string") throw new Error("写入内容无效。");
    const { target } = await resolveVaultPath(payload?.relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, payload.content, "utf8");
    return true;
  });
}

function resolveAppAsset(requestUrl) {
  const staticRoot = path.resolve(app.getAppPath(), "out");
  const url = new URL(requestUrl);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  else if (!path.extname(pathname)) pathname = `${pathname.replace(/\/$/, "")}/index.html`;
  const candidate = path.resolve(staticRoot, `.${pathname}`);
  if (candidate !== staticRoot && !candidate.startsWith(`${staticRoot}${path.sep}`)) return null;
  return candidate;
}

async function registerAppProtocol() {
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  await protocol.handle(SCHEME, async (request) => {
    const assetPath = resolveAppAsset(request.url);
    if (!assetPath) return new Response("Not found", { status: 404 });
    try {
      const body = await fs.readFile(assetPath);
      const contentType = contentTypes[path.extname(assetPath).toLowerCase()] ?? "application/octet-stream";
      return new Response(body, { status: 200, headers: { "content-type": contentType } });
    } catch (error) {
      return new Response(error?.code === "ENOENT" ? "Not found" : "Unable to load asset", { status: error?.code === "ENOENT" ? 404 : 500 });
    }
  });
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 320,
    minHeight: 600,
    show: !smokeMode || ["layout", "obsidian-disconnect-failure", "obsidian-disconnect-success"].includes(smokeMode),
    opacity: ["layout", "obsidian-disconnect-failure", "obsidian-disconnect-success"].includes(smokeMode) ? 0 : 1,
    skipTaskbar: Boolean(smokeMode),
    backgroundColor: "#040b15",
    title: "Wealth Atlas",
    icon: path.join(app.getAppPath(), "build", "icon.svg"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    const allowed = navigationUrl.startsWith(APP_ORIGIN) || (devUrl ? navigationUrl.startsWith(devUrl) : false);
    if (!allowed) event.preventDefault();
  });
  window.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    const errorId = makeStartupErrorId();
    void writeSmokeLog(`did-fail-load ${code} ${description} ${validatedUrl}`);
    writeMainLog("did-fail-load", { code, description, url: validatedUrl, errorId });
    recordStartupStage("static-page", "failed", errorId);
    console.error(`WEALTH_ATLAS_LOAD_ERROR ${code} ${description} ${validatedUrl}`);
  });
  window.webContents.on("did-finish-load", () => {
    writeMainLog("load-url-finished", { url: window.webContents.getURL() });
    recordStartupStage("static-page", "success");
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    const errorId = makeStartupErrorId();
    writeMainLog("render-process-gone", { reason: details.reason, exitCode: details.exitCode, url: window.webContents.getURL(), errorId });
    const currentStage = startupStages.at(-1)?.stage ?? "static-page";
    recordStartupStage(currentStage, "failed", errorId);
  });
  window.webContents.on("console-message", (details) => {
    if (details.level !== "warning" && details.level !== "error") return;
    void writeDiagnosticLog("renderer-console-error", { level: details.level, message: "Renderer console error", line: details.lineNumber, source: details.sourceId });
  });
  return window;
}

function snapshotScript(operation) {
  const testData = {
    reportCurrency: "MYR",
    schemaVersion: 10,
    categories: [],
    accounts: [
      { id: "desktop-test-account", name: "桌面测试账户", type: "bank", currency: "MYR", balance: 100 },
      { id: "desktop-test-sgd", name: "桌面 SGD 账户", type: "bank", currency: "SGD", balance: 20 },
    ],
    transactions: [
      { id: "desktop-test-transaction", type: "income", accountId: "desktop-test-account", amount: 25, currency: "MYR", category: "桌面测试", date: "2026-08-13" },
      { id: "desktop-test-trash-transaction", type: "expense", accountId: "desktop-test-account", amount: 3, currency: "MYR", category: "桌面测试", date: "2026-08-13", deleted: true, deletedAt: "2026-08-13T10:00:00.000Z" },
    ],
    transfers: [{ id: "desktop-test-transfer", fromAccountId: "desktop-test-sgd", toAccountId: "desktop-test-account", fromAmount: 5, fromCurrency: "SGD", toAmount: 17.5, toCurrency: "MYR", rate: 3.5, fee: 0, feeCurrency: "SGD", date: "2026-08-13" }],
    fxRates: [{ id: "desktop-test-fx", baseCurrency: "SGD", quoteCurrency: "MYR", rate: 3.5, effectiveDate: "2026-08-13", source: "桌面隔离测试", isDefault: true, active: true }],
    goals: [{ id: "desktop-test-goal", name: "桌面测试目标", current: 10, target: 100, currency: "MYR", percent: 10, due: "2026-12-31", cadence: "monthly", status: "on-track" }],
    assets: [{ id: "desktop-test-asset", name: "桌面测试资产", category: "测试", purchaseValue: 80, purchaseCurrency: "MYR", purchaseDate: "2026-08-01", currentValue: 70, currentCurrency: "MYR", currency: "MYR", dailyCost: 0, usageDays: 13, usageStartMode: "purchaseDate", usageStartDate: "2026-08-01", status: "active" }],
    plannedPayments: [{ id: "desktop-test-payment", name: "桌面测试付款", amount: 8, currency: "MYR", due: "2026-08-20", cadence: "once", category: "测试" }],
    budgets: [{ id: "desktop-test-budget", month: "2026-08", category: "桌面测试", limit: 50, currency: "MYR" }],
    annualPlans: [{ id: "desktop-test-plan", year: 2026, month: 12, name: "桌面测试计划", category: "测试", amount: 60, currency: "MYR", status: "planned" }],
    watchlists: [{ id: "desktop-test-watchlist", name: "桌面测试 Watchlist", spent: 3, limit: 20, average: 4, forecast: 8, currency: "MYR" }],
    investments: [{ id: "desktop-test-investment", name: "桌面测试投资", assetType: "测试", currency: "USD", costBasis: 10, currentValue: 11, valuationDate: "2026-08-13" }],
    liabilities: [{ id: "desktop-test-liability", name: "桌面测试负债", type: "other", principal: 20, remainingPrincipal: 18, interestRate: 2, minimumPayment: 2, currency: "MYR", status: "active" }],
    subscriptions: [{ id: "desktop-test-subscription", name: "桌面测试订阅", amount: 2, currency: "MYR", cadence: "monthly", nextDate: "2026-09-01", category: "测试", active: true }],
  };
  return `(${async function run(mode, seed) {
    const request = indexedDB.open("wealth-atlas");
    const database = await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const read = () => new Promise((resolve, reject) => {
      const transaction = database.transaction("snapshots", "readonly");
      const query = transaction.objectStore("snapshots").get("current");
      query.onsuccess = () => resolve(query.result?.data ?? null);
      query.onerror = () => reject(query.error);
    });
    const write = (data) => new Promise((resolve, reject) => {
      const transaction = database.transaction("snapshots", "readwrite");
      transaction.objectStore("snapshots").put({ id: "current", data, updatedAt: new Date().toISOString() });
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
    });
    if (mode.startsWith("seed") || ["edit", "soft-delete", "restore", "permanent-delete"].includes(mode)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    let current = await read();
    if (mode.startsWith("verify-startup-") || mode === "verify-legacy-migration") {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const emptyReady = mode === "verify-startup-empty-object" && current?.schemaVersion === 10 && Array.isArray(current?.accounts) && (current?.migrationBackups ?? []).some((backup) => backup.id?.startsWith("startup-repair-"));
        const partialReady = mode === "verify-startup-partial-snapshot" && current?.accounts?.some((account) => account.id === "partial-account") && Array.isArray(current?.transactions) && Array.isArray(current?.budgets);
        const legacyReady = mode === "verify-legacy-migration" && current?.schemaVersion === 10 && current?.transactions?.find((item) => item.id === "legacy-transaction")?.categoryId === "income:Legacy income" && (current?.migrationHistory ?? []).some((entry) => entry.from === 7 && entry.to === 10);
        if (emptyReady || partialReady || legacyReady) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
        current = await read();
      }
    }
    if (mode === "seed-empty-object") {
      await write({});
      return { pass: true, mode };
    }
    if (mode === "verify-startup-empty-object") {
      const required = ["accounts", "transactions", "transfers", "fxRates", "goals", "assets", "plannedPayments", "budgets", "annualPlans", "watchlists"];
      const missing = required.filter((key) => !Array.isArray(current?.[key]));
      const backupIds = (current?.migrationBackups ?? []).map((backup) => backup.id);
      return { pass: missing.length === 0 && current?.reportCurrency === "MYR" && current?.schemaVersion === 10 && backupIds.some((id) => id.startsWith("startup-repair-")), mode, missing, reportCurrency: current?.reportCurrency, schemaVersion: current?.schemaVersion, backupIds };
    }
    if (mode === "seed-partial-snapshot") {
      await write({ reportCurrency: "SGD", schemaVersion: 10, accounts: [{ id: "partial-account", name: "Partial", type: "bank", currency: "SGD", balance: 12 }] });
      return { pass: true, mode };
    }
    if (mode === "verify-startup-partial-snapshot") {
      return { pass: current?.accounts?.some((account) => account.id === "partial-account") && Array.isArray(current?.transactions) && Array.isArray(current?.budgets) && Array.isArray(current?.goals) && Array.isArray(current?.assets) && current?.reportCurrency === "SGD", mode };
    }
    if (mode === "seed-legacy-snapshot") {
      await write({ reportCurrency: "MYR", schemaVersion: 7, accounts: [{ id: "legacy-account", name: "Legacy", type: "bank", currency: "MYR", balance: 20 }], transactions: [{ id: "legacy-transaction", type: "income", accountId: "legacy-account", amount: 5, currency: "MYR", category: "Legacy income", date: "2026-08-13" }], transfers: [], fxRates: [], goals: [], assets: [], plannedPayments: [], budgets: [], watchlists: [] });
      return { pass: true, mode };
    }
    if (mode === "verify-legacy-migration") {
      return { pass: current?.schemaVersion === 10 && current?.transactions?.find((item) => item.id === "legacy-transaction")?.categoryId === "income:Legacy income" && (current?.migrationHistory ?? []).some((entry) => entry.from === 7 && entry.to === 10) && (current?.migrationBackups ?? []).length > 0, mode };
    }
    if (mode === "migration-failure") {
      return { pass: current?.schemaVersion === 7 && current?.transactions?.some((item) => item.id === "legacy-transaction"), mode, schemaVersion: current?.schemaVersion };
    }
    if (mode === "empty") {
      const collections = ["accounts", "transactions", "transfers", "fxRates", "goals", "assets", "plannedPayments", "budgets", "annualPlans", "watchlists"];
      return { pass: collections.every((key) => (current?.[key] ?? []).length === 0), mode, counts: Object.fromEntries(collections.map((key) => [key, (current?.[key] ?? []).length])) };
    }
    if (mode === "seed") {
      await write(seed);
      return { pass: true, mode };
    }
    if (mode === "verify") {
      const ids = [
        ["accounts", "desktop-test-account"], ["transactions", "desktop-test-transaction"], ["transfers", "desktop-test-transfer"],
        ["fxRates", "desktop-test-fx"], ["budgets", "desktop-test-budget"], ["goals", "desktop-test-goal"],
        ["annualPlans", "desktop-test-plan"], ["assets", "desktop-test-asset"], ["plannedPayments", "desktop-test-payment"],
        ["watchlists", "desktop-test-watchlist"], ["investments", "desktop-test-investment"], ["liabilities", "desktop-test-liability"],
        ["subscriptions", "desktop-test-subscription"],
      ];
      return { pass: ids.every(([collection, id]) => current?.[collection]?.some((item) => item.id === id)), mode };
    }
    if (mode === "edit") {
      const next = {
        ...current,
        accounts: current.accounts.map((item) => item.id === "desktop-test-account" ? { ...item, name: "桌面测试账户（已编辑）" } : item),
        budgets: current.budgets.map((item) => item.id === "desktop-test-budget" ? { ...item, limit: 75 } : item),
        goals: current.goals.map((item) => item.id === "desktop-test-goal" ? { ...item, name: "桌面测试目标（已编辑）" } : item),
        assets: current.assets.map((item) => item.id === "desktop-test-asset" ? { ...item, currentValue: 65 } : item),
      };
      await write(next);
      return { pass: true, mode };
    }
    if (mode === "verify-edit") return { pass: current?.accounts?.find((item) => item.id === "desktop-test-account")?.name === "桌面测试账户（已编辑）" && current?.budgets?.find((item) => item.id === "desktop-test-budget")?.limit === 75 && current?.goals?.find((item) => item.id === "desktop-test-goal")?.name.includes("已编辑") && current?.assets?.find((item) => item.id === "desktop-test-asset")?.currentValue === 65, mode };
    if (mode === "soft-delete") {
      const deletedAt = new Date().toISOString();
      const next = { ...current, transactions: current.transactions.map((item) => item.id === "desktop-test-transaction" ? { ...item, deleted: true, deletedAt } : item) };
      await write(next);
      return { pass: true, mode };
    }
    if (mode === "verify-soft-delete") return { pass: current?.transactions?.find((item) => item.id === "desktop-test-transaction")?.deleted === true, mode };
    if (mode === "restore") {
      const next = { ...current, transactions: current.transactions.map((item) => item.id === "desktop-test-transaction" ? { ...item, deleted: false, deletedAt: undefined } : item) };
      await write(next);
      return { pass: true, mode };
    }
    if (mode === "verify-restore") return { pass: current?.transactions?.find((item) => item.id === "desktop-test-transaction")?.deleted !== true, mode };
    if (mode === "permanent-delete") {
      const next = { ...current, transactions: current.transactions.filter((item) => item.id !== "desktop-test-trash-transaction") };
      await write(next);
      return { pass: true, mode };
    }
    if (mode === "verify-permanent-delete") return { pass: !current?.transactions?.some((item) => item.id === "desktop-test-trash-transaction") && current?.transactions?.some((item) => item.id === "desktop-test-transaction") && current?.accounts?.some((item) => item.id === "desktop-test-account") && current?.budgets?.some((item) => item.id === "desktop-test-budget"), mode };
    return { pass: false, mode, error: "unknown-mode" };
  }})(${JSON.stringify(operation)}, ${JSON.stringify(testData)})`;
}

async function waitForAppReady(_window) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (["ready", "failed", "load-failed", "renderer-gone", "startup-failed"].includes(startupStatus)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("桌面页面未完成安全启动阶段。");
}

async function waitForSmokeSelector(window, selector, present = true) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const found = await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if (found === present) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for selector ${selector} (${present ? "present" : "absent"}).`);
}

async function reloadSmokeWindow(window) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out reloading the desktop smoke window.")), 10000);
    window.webContents.once("did-finish-load", () => { clearTimeout(timeout); resolve(); });
    window.webContents.reload();
  });
  await waitForAppReady(window);
}

async function readObsidianSmokeState(window) {
  return window.webContents.executeJavaScript(`(${async function readState() {
    const request = indexedDB.open("wealth-atlas");
    const database = await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const readStore = (storeName, key) => new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const query = transaction.objectStore(storeName).get(key);
      query.onsuccess = () => resolve(query.result ?? null);
      query.onerror = () => reject(query.error);
    });
    const snapshot = await readStore("snapshots", "current");
    const handle = await readStore("obsidianHandles", "current");
    const data = snapshot?.data ?? {};
    return {
      obsidian: data.obsidian ?? null,
      hasHandle: Boolean(handle),
      hasFinanceMarker: (data.accounts ?? []).some((item) => item.id === "obsidian-finance-marker") && (data.transactions ?? []).some((item) => item.id === "obsidian-transaction-marker"),
      hasSyncLogMarker: (data.syncLogs ?? []).some((item) => item.id === "obsidian-sync-log-marker"),
    };
  }})()`);
}

async function capturePageSafely(window) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await window.webContents.capturePage(); }
    catch (error) {
      await writeSmokeLog(`capture-page-retry ${attempt + 1} ${error?.name ?? "Error"}`);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  await writeSmokeLog("capture-page-skipped-after-retries");
  return null;
}
async function setSmokeWindowBounds(window, width, height) {
  window.unmaximize();
  window.restore();
  await new Promise((resolve) => setTimeout(resolve, 70));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    window.setBounds({ x: 0, y: 0, width, height }, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bounds = window.getBounds();
    if (Math.abs(bounds.width - width) < 3 && Math.abs(bounds.height - height) < 3) return;
  }
}
async function runObsidianDisconnectSmoke(window, mode) {
  const testVaultPath = process.env.WEALTH_ATLAS_TEST_VAULT ? path.resolve(process.env.WEALTH_ATLAS_TEST_VAULT) : null;
  if (!testVaultPath) return { pass: false, mode, error: "test-vault-missing" };
  const vaultName = path.basename(testVaultPath);
  const sentinelPath = path.join(testVaultPath, "wealth-atlas-disconnect-preserve.md");
  await fs.writeFile(sentinelPath, "This synthetic file must survive disconnect.\n", "utf8");
  const invocationStart = vaultDisconnectInvocationCount;
  await new Promise((resolve) => setTimeout(resolve, 600));

  await window.webContents.executeJavaScript(`(${async function seedState(selectedVaultName) {
    const request = indexedDB.open("wealth-atlas");
    const database = await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const readSnapshot = () => new Promise((resolve, reject) => {
      const transaction = database.transaction("snapshots", "readonly");
      const query = transaction.objectStore("snapshots").get("current");
      query.onsuccess = () => resolve(query.result?.data ?? {});
      query.onerror = () => reject(query.error);
    });
    const current = await readSnapshot();
    const next = {
      ...current,
      accounts: [...(current.accounts ?? []).filter((item) => item.id !== "obsidian-finance-marker"), { id: "obsidian-finance-marker", name: "Synthetic account", type: "bank", currency: "MYR", balance: 0 }],
      transactions: [...(current.transactions ?? []).filter((item) => item.id !== "obsidian-transaction-marker"), { id: "obsidian-transaction-marker", type: "income", accountId: "obsidian-finance-marker", amount: 0, currency: "MYR", category: "Synthetic", date: "2026-08-14" }],
      syncLogs: [{ id: "obsidian-sync-log-marker", syncedAt: "2026-08-14T00:00:00.000Z", vaultName: selectedVaultName, fileCount: 1, added: 0, updated: 0, skipped: 1, failed: 0 }, ...(current.syncLogs ?? []).filter((item) => item.id !== "obsidian-sync-log-marker")],
      obsidian: { vaultName: selectedVaultName, status: "connected" },
    };
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(["snapshots", "obsidianHandles"], "readwrite");
      transaction.objectStore("snapshots").put({ id: "current", data: next, updatedAt: new Date().toISOString() });
      transaction.objectStore("obsidianHandles").put({ id: "current", handle: { kind: "desktop-vault" }, vaultName: selectedVaultName, updatedAt: new Date().toISOString() });
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error);
    });
    return true;
  }})(${JSON.stringify(vaultName)})`);

  await reloadSmokeWindow(window);
  await window.webContents.executeJavaScript(`(() => {
    const target = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Obsidian") && button.closest("nav, .sidebar-bottom"));
    if (!target) throw new Error("Obsidian navigation button not found.");
    target.click();
  })()`);
  await waitForSmokeSelector(window, ".vault-disconnect-button");

  const layoutResults = [];
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [390, 844], [320, 720]]) {
    await setSmokeWindowBounds(window, width, height);
    window.webContents.focus();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const layout = await window.webContents.executeJavaScript(`(() => {
      const actions = [...document.querySelectorAll(".vault-actions > button")];
      const reconnect = actions.find((button) => button.getAttribute("aria-label")?.startsWith("重新连接"));
      const disconnect = document.querySelector(".vault-disconnect-button");
      const rectangles = actions.map((button) => button.getBoundingClientRect());
      const overlaps = rectangles.some((first, index) => rectangles.slice(index + 1).some((second) => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top));
      const metrics = (button) => { const style = getComputedStyle(button); return button ? { height: button.getBoundingClientRect().height, radius: style.borderRadius, padding: style.padding, fontSize: style.fontSize, fontWeight: style.fontWeight, borderWidth: style.borderWidth } : null; };
      const reconnectMetrics = metrics(reconnect);
      const disconnectMetrics = metrics(disconnect);
      return {
        width: window.innerWidth,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        buttonCount: actions.length,
        overlaps,
        buttonsInside: rectangles.every((rect) => rect.left >= 0 && rect.right <= window.innerWidth + 1),
        sameStructure: Boolean(reconnectMetrics && disconnectMetrics && reconnectMetrics.height === disconnectMetrics.height && reconnectMetrics.radius === disconnectMetrics.radius && reconnectMetrics.padding === disconnectMetrics.padding && reconnectMetrics.fontSize === disconnectMetrics.fontSize && reconnectMetrics.fontWeight === disconnectMetrics.fontWeight && reconnectMetrics.borderWidth === disconnectMetrics.borderWidth),
        disconnectIsButton: disconnect?.tagName === "BUTTON" && disconnect?.getAttribute("type") === "button" && Boolean(disconnect?.getAttribute("aria-label")) && Boolean(disconnect?.getAttribute("title")),
      };
    })()`);
    layoutResults.push({ requested: `${width}x${height}`, ...layout });
  }

  await setSmokeWindowBounds(window, 390, 844);
  window.webContents.focus();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const connectionBefore = await window.webContents.executeJavaScript("window.wealthAtlasDesktop.getVaultConnection()");

  await window.webContents.executeJavaScript("document.querySelector('.vault-disconnect-button').click()");
  await waitForSmokeSelector(window, ".obsidian-disconnect-modal");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const modalLayout = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector(".obsidian-disconnect-modal");
    const rect = dialog.getBoundingClientRect();
    return { fits: rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight, labelled: Boolean(dialog.getAttribute("aria-labelledby")), described: Boolean(dialog.getAttribute("aria-describedby")), focusInside: dialog.contains(document.activeElement) };
  })()`);
  const screenshotDirectory = path.join(app.getPath("userData"), "screenshots");
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const modalScreenshot = await capturePageSafely(window);
  if (modalScreenshot) await fs.writeFile(path.join(screenshotDirectory, `obsidian-disconnect-${mode}-390x844.png`), modalScreenshot.toPNG());

  await window.webContents.executeJavaScript("document.querySelector('.obsidian-disconnect-modal .secondary-button').click()");
  await waitForSmokeSelector(window, ".obsidian-disconnect-modal", false);
  const cancelState = await window.webContents.executeJavaScript("({ connected: Boolean(document.querySelector('.vault-disconnect-button')), focusReturned: document.activeElement?.classList?.contains('vault-disconnect-button') === true })");

  await window.webContents.executeJavaScript("document.querySelector('.vault-disconnect-button').click()");
  await waitForSmokeSelector(window, ".obsidian-disconnect-modal");
  await window.webContents.executeJavaScript("document.querySelector('.obsidian-disconnect-backdrop').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
  await waitForSmokeSelector(window, ".obsidian-disconnect-modal", false);
  const backdropState = await window.webContents.executeJavaScript("Boolean(document.querySelector('.vault-disconnect-button'))");

  await window.webContents.executeJavaScript("document.querySelector('.vault-disconnect-button').click()");
  await waitForSmokeSelector(window, ".obsidian-disconnect-modal");
  await window.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitForSmokeSelector(window, ".obsidian-disconnect-modal", false);
  const escapeState = await window.webContents.executeJavaScript("Boolean(document.querySelector('.vault-disconnect-button'))");

  await window.webContents.executeJavaScript("document.querySelector('.vault-disconnect-button').click()");
  await waitForSmokeSelector(window, ".obsidian-disconnect-modal");
  await window.webContents.executeJavaScript("(() => { const button = document.querySelector('.obsidian-disconnect-confirm'); button.click(); button.click(); })()");
  await new Promise((resolve) => setTimeout(resolve, 40));
  const loadingState = await window.webContents.executeJavaScript("({ busy: document.querySelector('.obsidian-disconnect-modal')?.getAttribute('aria-busy') === 'true', disabled: document.querySelector('.obsidian-disconnect-confirm')?.disabled === true })");

  if (mode === "obsidian-disconnect-failure") {
    await waitForSmokeSelector(window, ".obsidian-disconnect-error");
    const state = await readObsidianSmokeState(window);
    const connection = await window.webContents.executeJavaScript("window.wealthAtlasDesktop.getVaultConnection()");
    const ui = await window.webContents.executeJavaScript("({ connected: Boolean(document.querySelector('.vault-disconnect-button')), dialogOpen: Boolean(document.querySelector('.obsidian-disconnect-modal')), retryEnabled: document.querySelector('.obsidian-disconnect-confirm')?.disabled === false })");
    const sentinelExists = fsSync.existsSync(sentinelPath);
    const invocations = vaultDisconnectInvocationCount - invocationStart;
    return { pass: connectionBefore?.connected === true && connection?.connected === true && state.obsidian?.status === "connected" && state.hasHandle && state.hasFinanceMarker && state.hasSyncLogMarker && ui.connected && ui.dialogOpen && ui.retryEnabled && sentinelExists && invocations === 1 && layoutResults.every((item) => Math.abs(item.width - Number(item.requested.split("x")[0])) < 40 && !item.overflow && !item.overlaps && item.buttonsInside && item.sameStructure && item.disconnectIsButton) && modalLayout.fits && modalLayout.labelled && modalLayout.described && modalLayout.focusInside && cancelState.connected && cancelState.focusReturned && backdropState && escapeState && loadingState.busy && loadingState.disabled, mode, invocations, layoutResults, modalLayout, cancelState, backdropState, escapeState, loadingState, state, connection, sentinelExists };
  }

  await waitForSmokeSelector(window, ".obsidian-disconnect-modal", false);
  await waitForSmokeSelector(window, ".vault-disconnect-button", false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const state = await readObsidianSmokeState(window);
  const connection = await window.webContents.executeJavaScript("window.wealthAtlasDesktop.getVaultConnection()");
  const ui = await window.webContents.executeJavaScript("({ disconnected: document.querySelector('.vault-status')?.classList.contains('disconnected') === true, noOldVaultName: !document.querySelector('.vault-identity')?.innerText.includes(" + JSON.stringify(vaultName) + "), toastShown: document.querySelector('.toast')?.textContent?.includes('已断开 Obsidian Vault 连接') === true, focusMoved: document.activeElement?.getAttribute('aria-label')?.includes('选择') === true })");
  const sentinelExists = fsSync.existsSync(sentinelPath);
  const invocations = vaultDisconnectInvocationCount - invocationStart;

  await reloadSmokeWindow(window);
  await window.webContents.executeJavaScript(`(() => { const target = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Obsidian") && button.closest("nav, .sidebar-bottom")); target?.click(); })()`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const refreshed = await window.webContents.executeJavaScript("({ disconnected: document.querySelector('.vault-status')?.classList.contains('disconnected') === true, noDisconnectButton: !document.querySelector('.vault-disconnect-button'), noOldVaultName: !document.querySelector('.vault-identity')?.innerText.includes(" + JSON.stringify(vaultName) + ") })");
  return { pass: connectionBefore?.connected === true && connection?.connected === false && state.obsidian?.status === "disconnected" && !state.hasHandle && state.hasFinanceMarker && state.hasSyncLogMarker && ui.disconnected && ui.noOldVaultName && ui.toastShown && ui.focusMoved && sentinelExists && invocations === 1 && refreshed.disconnected && refreshed.noDisconnectButton && refreshed.noOldVaultName && layoutResults.every((item) => Math.abs(item.width - Number(item.requested.split("x")[0])) < 40 && !item.overflow && !item.overlaps && item.buttonsInside && item.sameStructure && item.disconnectIsButton) && modalLayout.fits && modalLayout.labelled && modalLayout.described && modalLayout.focusInside && cancelState.connected && cancelState.focusReturned && backdropState && escapeState && loadingState.busy && loadingState.disabled, mode, invocations, layoutResults, modalLayout, cancelState, backdropState, escapeState, loadingState, state, connection, ui, refreshed, sentinelExists };
}
async function runDiagnosticClipboardSmoke(window, mode) {
  await setSmokeWindowBounds(window, 390, 844);
  window.webContents.focus();
  await waitForSmokeSelector(window, ".app-failure-panel");

  const clipboardStart = diagnosticClipboardInvocationCount;
  const saveStart = diagnosticSaveInvocationCount;
  const logsStart = logsOpenInvocationCount;
  const renderer = await window.webContents.executeJavaScript("(" + async function verifyDiagnosticActions(testMode) {
    const useBrowserClipboard = testMode === "diagnostic-browser-clipboard";
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: useBrowserClipboard
            ? async (text) => { window.__wealthAtlasCopiedDiagnostic = text; }
            : async () => { throw new Error("Browser clipboard unavailable"); },
        },
      });
    } catch {}

    const copyButton = document.querySelector('[aria-label="复制安全诊断信息"]');
    const saveButton = document.querySelector('[aria-label="保存安全诊断文件"]');
    const logsButton = document.querySelector('[aria-label="打开诊断文件位置"]');
    copyButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 180));

    let saveSuccessBeforeOpen = false;
    if (testMode === "diagnostic-ipc-failure") {
      saveButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      saveSuccessBeforeOpen = document.body.innerText.includes("诊断文件已保存");
      logsButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (testMode === "diagnostic-save-failure") {
      saveButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
    }

    const textarea = document.querySelector("#manual-diagnostic-text");
    return {
      browserCopied: typeof window.__wealthAtlasCopiedDiagnostic === "string",
      copiedStatus: document.body.innerText.includes("诊断信息已复制"),
      manualVisible: Boolean(textarea),
      manualSelectable: Boolean(textarea?.readOnly && textarea.value.includes("Error ID:")),
      saveSuccess: saveSuccessBeforeOpen || document.body.innerText.includes("诊断文件已保存"),
      saveFailure: document.body.innerText.includes("无法保存诊断文件"),
      noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      stillInteractive: Boolean(document.querySelector('[aria-label="重新启动 Wealth Atlas"]')),
    };
  }.toString() + ")(" + JSON.stringify(mode) + ")");

  const files = await fs.readdir(logsDirectory());
  const savedDiagnostic = files.some((name) => name.startsWith("diagnostic-WA-") && name.endsWith(".txt"));
  const ipcClipboardCalls = diagnosticClipboardInvocationCount - clipboardStart;
  const saveCalls = diagnosticSaveInvocationCount - saveStart;
  const logsCalls = logsOpenInvocationCount - logsStart;
  const clipboardText = clipboard.readText();

  const expectations = {
    "diagnostic-browser-clipboard": renderer.browserCopied && renderer.copiedStatus && ipcClipboardCalls === 0,
    "diagnostic-ipc-clipboard": renderer.copiedStatus && ipcClipboardCalls === 1 && clipboardText.includes("Error ID:"),
    "diagnostic-ipc-failure": renderer.manualVisible && renderer.manualSelectable && renderer.saveSuccess && savedDiagnostic && ipcClipboardCalls === 1 && saveCalls === 1 && logsCalls === 1,
    "diagnostic-save-failure": renderer.saveFailure && renderer.manualVisible && saveCalls === 1,
  };
  return { pass: Boolean(expectations[mode]) && renderer.noOverflow && renderer.stillInteractive, mode, renderer, ipcClipboardCalls, saveCalls, logsCalls, savedDiagnostic };
}
async function runSmoke(window, mode) {
  await waitForAppReady(window);
  if (new Set(["diagnostic-browser-clipboard", "diagnostic-ipc-clipboard", "diagnostic-ipc-failure", "diagnostic-save-failure"]).has(mode)) return runDiagnosticClipboardSmoke(window, mode);
  if (mode === "obsidian-disconnect-failure" || mode === "obsidian-disconnect-success") return runObsidianDisconnectSmoke(window, mode);
  if (mode === "startup-diagnostics") {
    const directory = logsDirectory();
    const required = ["main.log", "renderer.log", "startup.json"];
    const files = Object.fromEntries(await Promise.all(required.map(async (fileName) => {
      try {
        const stat = await fs.stat(path.join(directory, fileName));
        return [fileName, { exists: true, size: stat.size }];
      } catch {
        return [fileName, { exists: false, size: 0 }];
      }
    })));
    const mainLog = await fs.readFile(path.join(directory, "main.log"), "utf8");
    const startup = JSON.parse(await fs.readFile(path.join(directory, "startup.json"), "utf8"));
    const events = ["process-start", "app-ready", "static-protocol-registered", "browser-window-created", "load-url-start", "load-url-finished"];
    const stages = ["electron-app-ready", "local-protocol", "logs-directory", "browser-window", "static-page", "react-initialization", "indexeddb-initialization", "data-read", "migration", "home-ready"];
    return { pass: required.every((fileName) => files[fileName].exists) && events.every((event) => mainLog.includes('"event":"' + event + '"')) && stages.every((stage) => startup.stages?.some((entry) => entry.stage === stage && entry.status === "success")) && startup.status === "ready" && startup.appVersion === app.getVersion(), mode, files, startup };
  }
  if (mode === "main-error-hooks") {
    process.emit("uncaughtExceptionMonitor", new Error("Main diagnostic hook test"), "uncaughtException");
    process.emit("unhandledRejection", new Error("Main rejection diagnostic test"), Promise.resolve());
    const mainLog = fsSync.readFileSync(mainLogPath(), "utf8");
    return { pass: mainLog.includes('"event":"uncaught-exception"') && mainLog.includes('"event":"unhandled-rejection"'), mode };
  }
  if (mode === "renderer-process-crash") {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ pass: false, mode, error: "render-process-gone-timeout" }), 5000);
      window.webContents.once("render-process-gone", (_event, details) => {
        clearTimeout(timeout);
        setTimeout(() => {
          let logged = false;
          try { logged = fsSync.readFileSync(mainLogPath(), "utf8").includes('"event":"render-process-gone"'); } catch {}
          resolve({ pass: logged, mode, reason: details.reason, logged });
        }, 100);
      });
      window.webContents.forcefullyCrashRenderer();
    });
  }
  if (mode === "migration-failure") {
    const state = await window.webContents.executeJavaScript(snapshotScript(mode));
    const startup = JSON.parse(await fs.readFile(startupPath(), "utf8"));
    let backupFound = false;
    try {
      const folders = await fs.readdir(backupsDirectory(), { withFileTypes: true });
      backupFound = folders.some((entry) => entry.isDirectory() && entry.name.includes(`v${app.getVersion()}-schema-7`));
    } catch {}
    return { ...state, pass: state.pass && backupFound && startup.stages?.some((entry) => entry.stage === "migration" && entry.status === "failed"), backupFound, startupStatus: startup.status };
  }
  if (mode === "localstorage-unavailable") {
    return window.webContents.executeJavaScript("({ pass: document.body?.innerText?.includes('WEALTH ATLAS') === true && document.documentElement.scrollWidth <= document.documentElement.clientWidth, mode: 'localstorage-unavailable' })");
  }
  if (mode === "obsidian-disconnected") {
    return window.webContents.executeJavaScript("(async () => { const connection = await window.wealthAtlasDesktop?.getVaultConnection(); return { pass: connection?.connected === false && connection?.name === '', mode: 'obsidian-disconnected' }; })()");
  }
  if (new Set(["indexeddb-read-failure", "indexeddb-open-failure", "indexeddb-blocked", "indexeddb-versionchange"]).has(mode)) {
    await waitForSmokeSelector(window, ".app-failure-panel");
    const result = await window.webContents.executeJavaScript("(" + function verifyStorageFailure(testMode) {
      const panel = document.querySelector(".app-failure-panel");
      const retry = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("重新尝试"));
      return {
        pass: Boolean(panel) && Boolean(retry) && document.body.innerText.includes("没有被自动删除") && document.body.innerText.includes("打开备份位置") && document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        mode: testMode,
        retryAvailable: Boolean(retry),
      };
    }.toString() + ")(" + JSON.stringify(mode) + ")");
    const startup = JSON.parse(await fs.readFile(startupPath(), "utf8"));
    result.pass = result.pass && startup.stages?.some((entry) => entry.status === "failed" && ["indexeddb-initialization", "data-read"].includes(entry.stage));
    return result;
  }  if (mode === "error-boundary") {
    await setSmokeWindowBounds(window, 390, 844);
    window.webContents.focus();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const invocationStart = restartInvocationCount;
    const result = await window.webContents.executeJavaScript(`(${async function verifyErrorBoundary() {
      const panel = document.querySelector(".app-failure-panel");
      const restart = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("重新启动"));
      restart?.click();
      restart?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        pass: Boolean(panel) && document.body.innerText.includes("错误 ID") && document.body.innerText.includes("启动阶段") && document.body.innerText.includes("复制诊断信息") && document.body.innerText.includes("打开备份位置") && document.body.innerText.includes("不要删除") && restart?.disabled === true && document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        mode: "error-boundary",
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        restartDisabled: restart?.disabled === true,
      };
    }})()`);
    result.restartInvocations = restartInvocationCount - invocationStart;
    result.pass = result.pass && result.restartInvocations === 1;
    const screenshotDirectory = path.join(app.getPath("userData"), "screenshots");
    await fs.mkdir(screenshotDirectory, { recursive: true });
    const screenshot = await capturePageSafely(window);
    if (screenshot) await fs.writeFile(path.join(screenshotDirectory, "error-boundary-390x844.png"), screenshot.toPNG());
    return result;
  }
  if (mode === "asset-audit") {
    return window.webContents.executeJavaScript(`(${async function auditAssets() {
      const urls = [...document.querySelectorAll("link[href],script[src]")].map((element) => element.href || element.src).filter((url) => url.startsWith("wealth-atlas://app/"));
      const responses = await Promise.all(urls.map(async (url) => { try { const response = await fetch(url); return { url, status: response.status, ok: response.ok }; } catch { return { url, status: 0, ok: false }; } }));
      const cssLoaded = [...document.styleSheets].some((sheet) => sheet.href?.startsWith("wealth-atlas://app/") && (() => { try { return (sheet.cssRules?.length ?? 0) > 0; } catch { return false; } })());
      const scripts = [...document.scripts].map((script) => script.src).filter(Boolean);
      let serviceWorkerCount = 0;
      let serviceWorkerStatus = "unavailable";
      try {
        const serviceWorkers = await navigator.serviceWorker?.getRegistrations?.() ?? [];
        serviceWorkerCount = serviceWorkers.length;
        serviceWorkerStatus = "available";
      } catch (error) {
        serviceWorkerStatus = error instanceof Error ? error.name : "unavailable";
      }
      return { pass: location.origin === "wealth-atlas://app" && urls.length > 0 && responses.every((item) => item.ok) && cssLoaded && scripts.every((url) => url.startsWith("wealth-atlas://app/")) && !urls.some((url) => /localhost|127\.0\.0\.1/.test(url)) && serviceWorkerCount === 0, mode: "asset-audit", resourceCount: urls.length, failed: responses.filter((item) => !item.ok), cssLoaded, serviceWorkerCount, serviceWorkerStatus, finalUrl: location.href };
    }})()`);
  }
  if (mode === "diagnostics") {
    return window.webContents.executeJavaScript(`(${async function verifyDiagnostics() {
      const bridge = window.wealthAtlasDesktop;
      if (!bridge?.reportDiagnostic) return { pass: false, mode: "diagnostics", error: "bridge-missing" };
      await bridge.reportDiagnostic({ id: "WA-SMOKE-DIAGNOSTIC", level: "error", source: "diagnostic-test", name: "SmokeError", message: "Technical startup test", stack: "SmokeError: Technical startup test", mode: "desktop-production" });
      return { pass: true, mode: "diagnostics", appVersion: bridge.appVersion, electronVersion: bridge.electronVersion, platform: bridge.platform };
    }})()`);
  }
  if (mode === "vault-bridge") {
    return window.webContents.executeJavaScript(`(${async function verifyVaultBridge() {
      const bridge = window.wealthAtlasDesktop;
      if (!bridge?.isDesktop) return { pass: false, mode: "vault-bridge", error: "bridge-missing" };
      await bridge.ensureDirectory("财富理财师/01-每日/2026", true);
      await bridge.ensureFile("财富理财师/01-每日/2026/2026-08-13.md", true);
      const content = "---\\ntype: daily-finance\\nobsidian_source: wealth-atlas-test\\n---\\n";
      await bridge.writeFile("财富理财师/01-每日/2026/2026-08-13.md", content);
      const restored = await bridge.readFile("财富理财师/01-每日/2026/2026-08-13.md");
      let traversalRejected = false;
      try { await bridge.readFile("../outside.md"); } catch { traversalRejected = true; }
      return { pass: restored === content && traversalRejected, mode: "vault-bridge", traversalRejected };
    }})()`);
  }
  if (mode === "layout") {
    const results = [];
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [390, 844], [320, 720]]) {
      await setSmokeWindowBounds(window, width, height);
      window.webContents.focus();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = await window.webContents.executeJavaScript(`({ width: window.innerWidth, height: window.innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, bodyBackground: getComputedStyle(document.body).backgroundColor, hasNavigation: Boolean(document.querySelector('.sidebar, .mobile-nav')), hasPanel: Boolean(document.querySelector('.panel')) })`);
      const screenshotDirectory = path.join(app.getPath("userData"), "screenshots");
      await fs.mkdir(screenshotDirectory, { recursive: true });
      const screenshot = await capturePageSafely(window);
      if (screenshot) await fs.writeFile(path.join(screenshotDirectory, `${width}x${height}.png`), screenshot.toPNG());
      results.push({ requested: `${width}x${height}`, bounds: window.getBounds(), ...result });
    }
    const pass = results.every((item) => Math.abs(item.width - item.bounds.width) < 40 && !item.overflow && item.hasNavigation && item.hasPanel && item.bodyBackground !== "rgba(0, 0, 0, 0)");
    return { pass, mode, results };
  }
  return window.webContents.executeJavaScript(snapshotScript(mode));
}

function setupAutoUpdater() {
  if (!app.isPackaged || !autoUpdater) return; // 开发模式或未打包 updater 时不检查
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", () => {
    writeMainLog("update-downloaded");
    autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", (error) => writeMainLog("update-error", { message: String(error?.message ?? error) }));
  autoUpdater.checkForUpdatesAndNotify().catch(() => { /* 静默失败，不影响使用 */ });
}

app.whenReady().then(async () => {
  await writeSmokeLog("app-ready");
  writeMainLog("app-ready");
  recordStartupStage("electron-app-ready", "success");
  if (smokeMode === "main-startup-failure") throw new Error("Main startup diagnostic test");
  if (smokeMode && process.env.WEALTH_ATLAS_TEST_VAULT) {
    const testVaultPath = path.resolve(process.env.WEALTH_ATLAS_TEST_VAULT);
    await fs.mkdir(testVaultPath, { recursive: true });
    await saveVaultConfig({ path: testVaultPath, name: path.basename(testVaultPath), connectedAt: new Date().toISOString() });
  }
  app.setAppUserModelId("com.wealthatlas.desktop");
  registerDesktopIpc();
  if (!devUrl) {
    await registerAppProtocol();
    writeMainLog("static-protocol-registered", { scheme: SCHEME });
  }
  recordStartupStage("local-protocol", "success");
  initializeDiagnosticsSync();
  recordStartupStage("logs-directory", "success");
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  const window = createMainWindow();
  setupAutoUpdater();
  await writeSmokeLog("window-created");
  writeMainLog("browser-window-created");
  recordStartupStage("browser-window", "success");
  writeMainLog("load-url-start", { url: devUrl ?? APP_ORIGIN + "/" });
  recordStartupStage("static-page", "running");
  if (smokeMode) {
    window.webContents.once("did-finish-load", async () => {
      await writeSmokeLog("did-finish-load");
      try {
        const result = await runSmoke(window, smokeMode);
        console.log(`WEALTH_ATLAS_SMOKE ${JSON.stringify(result)}`);
        app.exit(result.pass ? 0 : 1);
      } catch (error) {
        const message = error?.stack ?? error?.message ?? JSON.stringify(error) ?? String(error);
        await writeSmokeLog(`smoke-error ${message}`);
        console.error(`WEALTH_ATLAS_SMOKE_ERROR ${message}`);
        app.exit(1);
      }
    });
  }
  await writeSmokeLog(`load-url ${devUrl ?? `${APP_ORIGIN}/`}`);
  void window.loadURL(devUrl ?? `${APP_ORIGIN}/`);
}).catch((error) => {
  const errorId = makeStartupErrorId();
  writeMainLog("startup-failed", { name: error?.name, message: error?.message, stack: error?.stack, errorId });
  const currentStage = startupStages.at(-1)?.stage ?? "electron-app-ready";
  recordStartupStage(currentStage, "failed", errorId);
  if (smokeMode === "main-startup-failure") {
    let pass = false;
    try {
      const mainLog = fsSync.readFileSync(mainLogPath(), "utf8");
      const startup = JSON.parse(fsSync.readFileSync(startupPath(), "utf8"));
      pass = mainLog.includes('"event":"process-start"') && mainLog.includes('"event":"startup-failed"') && startup.status === "startup-failed";
    } catch {}
    console.log("WEALTH_ATLAS_SMOKE " + JSON.stringify({ pass, mode: smokeMode }));
    app.exit(pass ? 0 : 1);
    return;
  }
  console.error(error);
});

app.on("window-all-closed", () => app.quit());
