const { app, BrowserWindow, dialog, ipcMain, protocol, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const SCHEME = "wealth-atlas";
const APP_ORIGIN = `${SCHEME}://app`;
const devUrlArgument = process.argv.find((argument) => argument.startsWith("--dev-url="));
const devUrl = devUrlArgument?.slice("--dev-url=".length) ?? null;
const smokeMode = process.env.WEALTH_ATLAS_DESKTOP_SMOKE
  ?? process.argv.find((argument) => argument.startsWith("--desktop-smoke="))?.slice("--desktop-smoke=".length)
  ?? null;
const explicitTestProfile = process.env.WEALTH_ATLAS_TEST_PROFILE;

async function writeSmokeLog(message) {
  if (!smokeMode) return;
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  await fs.appendFile(path.join(app.getPath("userData"), "smoke.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
}

void writeSmokeLog(`module-loaded argv=${JSON.stringify(process.argv)}`);

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
  ipcMain.handle("desktop:get-data-location", (event) => {
    assertTrustedSender(event);
    return app.getPath("userData");
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
    show: !smokeMode || smokeMode === "layout",
    opacity: smokeMode === "layout" ? 0 : 1,
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
    void writeSmokeLog(`did-fail-load ${code} ${description} ${validatedUrl}`);
    console.error(`WEALTH_ATLAS_LOAD_ERROR ${code} ${description} ${validatedUrl}`);
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
    const current = await read();
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

async function waitForAppReady(window) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await window.webContents.executeJavaScript("document.body?.innerText?.includes('正在读取首页排版') === false");
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("桌面页面一直停留在读取状态。");
}

async function runSmoke(window, mode) {
  await waitForAppReady(window);
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
      window.setBounds({ x: 0, y: 0, width, height }, false);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = await window.webContents.executeJavaScript(`({ width: window.innerWidth, height: window.innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, bodyBackground: getComputedStyle(document.body).backgroundColor, hasNavigation: Boolean(document.querySelector('.sidebar, .mobile-nav')), hasPanel: Boolean(document.querySelector('.panel')) })`);
      const screenshotDirectory = path.join(app.getPath("userData"), "screenshots");
      await fs.mkdir(screenshotDirectory, { recursive: true });
      const screenshot = await window.webContents.capturePage();
      await fs.writeFile(path.join(screenshotDirectory, `${width}x${height}.png`), screenshot.toPNG());
      results.push({ requested: `${width}x${height}`, bounds: window.getBounds(), ...result });
    }
    const pass = results.every((item) => Math.abs(item.width - item.bounds.width) < 40 && !item.overflow && item.hasNavigation && item.hasPanel && item.bodyBackground !== "rgba(0, 0, 0, 0)");
    return { pass, mode, results };
  }
  return window.webContents.executeJavaScript(snapshotScript(mode));
}

app.whenReady().then(async () => {
  await writeSmokeLog("app-ready");
  if (smokeMode && process.env.WEALTH_ATLAS_TEST_VAULT) {
    const testVaultPath = path.resolve(process.env.WEALTH_ATLAS_TEST_VAULT);
    await fs.mkdir(testVaultPath, { recursive: true });
    await saveVaultConfig({ path: testVaultPath, name: path.basename(testVaultPath), connectedAt: new Date().toISOString() });
  }
  app.setAppUserModelId("com.wealthatlas.desktop");
  registerDesktopIpc();
  if (!devUrl) await registerAppProtocol();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  const window = createMainWindow();
  await writeSmokeLog("window-created");
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
});

app.on("window-all-closed", () => app.quit());
