/* Real Settings acceptance, not a substitute renderer or an installer test.
 * Usage: node scripts/backup-restore-desktop-test.cjs --stage=C:\Users\J\Documents\Codex\wa1710-qa-1234abcd
 * Stage is supplied/built by the parent. No build, install, profile reuse, Vault,
 * cloud credentials, production edits, or cleanup is performed by this script.
 * The ONLY fabricated service response is the updater. IPC/storage are real.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const argument = name => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value);
const copy = value => JSON.parse(json(value));
const holdKey = "current:restore-isolation:v1";
const safetyChannel = "desktop:create-restore-safety-backup";
const integrityChannel = "desktop:read-backup-with-integrity";

function contained(parent, target) {
  const relative = path.relative(parent, target);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Path outside test allowlist");
}
function ordinaryChain(directory, missing = false) {
  let current = path.parse(directory).root;
  for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (missing && error.code === "ENOENT") return; throw error; }
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Links/junctions are forbidden in test paths");
  }
}
function ordinaryFile(file) {
  ordinaryChain(path.dirname(file));
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Expected ordinary, non-hardlinked file");
}
function absent(target) {
  try { fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Refusing to reuse/overwrite existing test output: " + target);
}
function stagePath() {
  assert.ok(argument("stage"), "Supply a parent-built code-only --stage=<absolute sibling path>");
  assert.ok(path.isAbsolute(argument("stage")), "Stage must be absolute");
  const stage = path.resolve(argument("stage"));
  assert.equal(path.dirname(stage).toLowerCase(), path.dirname(root).toLowerCase(), "Stage must be a short sibling of the repository");
  assert.match(path.basename(stage), /^wa1710-qa-[a-f0-9]{8}$/i, "Stage allowlist: wa1710-qa-<8hex>");
  ordinaryChain(stage);
  const allowed = new Set(["desktop", "out", "build", "package.json"]);
  for (const entry of fs.readdirSync(stage)) assert.ok(allowed.has(entry), "Stage must contain code/static assets only: " + entry);
  const walk = directory => {
    ordinaryChain(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.ok(!/^(profiles?|backups|autosaves|vault|logs|IndexedDB|Local Storage|Session Storage|Network|update-token\.json|\.env.*)$/i.test(entry.name), "Private material is forbidden in stage");
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target); else ordinaryFile(target);
    }
  };
  walk(stage);
  for (const file of ["package.json", "out/index.html", "desktop/main.cjs", "desktop/preload.cjs", "desktop/backup-safety.cjs"]) ordinaryFile(path.join(stage, file));
  assert.match(fs.readFileSync(path.join(stage, "desktop/preload.cjs"), "utf8"), /readBackupWithIntegrity/);
  assert.match(fs.readFileSync(path.join(stage, "desktop/main.cjs"), "utf8"), /WEALTH_ATLAS_TEST_PROFILE/);
  return stage;
}
function testPath(value) {
  const target = path.resolve(value);
  assert.equal(path.dirname(target).toLowerCase(), path.join(root, "work").toLowerCase());
  assert.match(path.basename(target), /^restore-ui-[a-f0-9-]{36}$/i);
  ordinaryChain(target);
  return target;
}

// Installed BEFORE the first real application document/hydration. It observes
// native transactions; it never replaces IndexedDB reads/writes or app modules.
function observeIndexedDB() {
  const state = { attempts: [], commits: [], aborts: 0, transactions: 0 };
  Object.defineProperty(window, "__restoreAcceptance", { value: state });
  const transactions = new WeakMap();
  for (const method of ["put", "add", "delete", "clear"]) {
    const original = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function (...args) {
      const key = args[0]?.id ?? (method === "delete" ? args[0] : null);
      const event = { store: this.name, key, method };
      state.attempts.push(event);
      let events = transactions.get(this.transaction);
      if (!events) {
        events = []; events.id = ++state.transactions; transactions.set(this.transaction, events);
        this.transaction.addEventListener("complete", () => state.commits.push(...events.map(item => ({ ...item, at: Date.now() }))));
        this.transaction.addEventListener("abort", () => state.aborts++);
      }
      const request = original.apply(this, args);
      event.transaction = events.id;
      events.push(event);
      return request;
    };
  }
}

function syntheticData() {
  const data = { schemaVersion: 10, reportCurrency: "MYR" };
  for (const key of ["accounts", "transactions", "transfers", "fxRates", "goals", "assets", "plannedPayments", "budgets", "categories", "annualPlans", "syncLogs", "watchlists", "investments", "investmentTransactions", "liabilities", "netWorthHistory", "subscriptions", "reviews", "importReviews", "migrationHistory", "migrationBackups", "migrationNotices", "assetMigrationBackups"]) data[key] = [];
  data.accounts = [
    { id: "restore-ui-shared", name: "虚构当前账户", type: "bank", currency: "MYR", balance: 123, status: "active", includeInNetWorth: true },
    { id: "restore-ui-current-only", name: "虚构当前独有账户", type: "cash", currency: "MYR", balance: 8, status: "inactive", includeInNetWorth: true },
  ];
  data.transactions = [{ id: "restore-ui-trash", type: "expense", accountId: "restore-ui-shared", amount: 3, currency: "MYR", category: "其他支出", date: "2026-11-01", deleted: true, deletedAt: "2026-11-02T00:00:00.000Z" }];
  // Connection METADATA only. No desktop config, path or usable handle is seeded.
  data.obsidian = { vaultName: "SYNTHETIC-NO-VAULT", status: "connected", connectedAt: "2026-11-01T00:00:00.000Z" };
  data.syncLogs = [{ id: "restore-ui-retain-log", syncedAt: "2026-11-01T00:00:00.000Z", vaultName: "SYNTHETIC-NO-VAULT", fileCount: 0, added: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 }];
  data.cashFlowSettings = { safetyBalance: 0, currency: "MYR" };
  data.externalIntegrations = { bankSyncEnabled: false, liveFxEnabled: false };
  return data;
}

async function electronTest() {
  const electron = require("electron");
  const { app, BrowserWindow, session } = electron;
  const Module = require("node:module");
  const stage = stagePath(), testRoot = testPath(argument("test-root"));
  const profile = path.join(testRoot, "p");
  assert.equal(process.env.WEALTH_ATLAS_TEST_PROFILE, profile);
  assert.equal(process.env.WA_RESTORE_RUN, path.basename(testRoot));
  assert.equal(process.env.WEALTH_ATLAS_DESKTOP_SMOKE, undefined);
  assert.equal(process.env.WEALTH_ATLAS_TEST_VAULT, undefined);
  assert.deepEqual(fs.readdirSync(profile), [], "Only a fresh empty profile is accepted");
  const version = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8")).version;
  assert.equal(version, "1.7.10");
  assert.equal(app.getVersion(), version);
  app.setAppPath(stage);
  app.setPath("userData", profile); app.setPath("sessionData", profile);
  app.setPath("crashDumps", path.join(testRoot, "tmp"));
  app.disableHardwareAcceleration();
  for (const flag of ["disable-background-networking", "disable-component-update", "disable-sync"]) app.commandLine.appendSwitch(flag);
  app.commandLine.appendSwitch("proxy-server", "http://127.0.0.1:9");
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");

  let window, done = false, active = 0, startupReady = 0;
  const report = { pass: false, stage, testRoot, version, realMainAndPreload: true, actualInstallerExecuted: false, userProfileOpened: false, vaultOpened: false, syntheticUpdater: true, checks: [], screenshots: [], phases: [], networkBlocked: {}, limitations: ["Source/static-stage Electron acceptance, not an installed/packaged or cross-device test.", "Connection metadata is synthetic; no actual Vault handle/path is opened. Cloud/Vault execution after resume is intentionally not exercised.", "Network denied in Chromium and Node/Electron APIs; this is not an OS firewall against arbitrary native addons.", "Safety IO/quota failures, account races and multiple-window concurrency are delegated to the separate core harness, not asserted here."] };
  function phase(name) {
    // Call sites pass fixed enums only: no DOM text, paths, URLs, snapshot data,
    // bridge arguments, or exception messages enter this live progress stream.
    assert.match(name, /^[A-Z0-9_]+$/);
    const entry = { phase: name, at: new Date().toISOString() };
    report.phases.push(entry);
    fs.appendFileSync(path.join(testRoot, "phases.jsonl"), json(entry) + "\n");
    console.log("RESTORE_UI_PHASE " + json(entry));
  }
  async function bounded(promise, name, milliseconds = 15000) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Harness phase timed out: " + name)), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  }
  report.harnessRevision = "live-renderer-observer-v2";
  phase("HARNESS_LIVE_RENDERER_OBSERVER_V2");
  phase("ISOLATION_VALIDATED");
  const blocked = kind => { report.networkBlocked[kind] = (report.networkBlocked[kind] || 0) + 1; throw new Error("RESTORE_UI_NETWORK_DENIED"); };
  // Deny, never forward, all Node networking (including loopback). Main uses
  // fs-backed wealth-atlas: protocol, so no HTTP test server is necessary.
  require("node:net").Socket.prototype.connect = () => blocked("node-socket");
  require("node:tls").connect = () => blocked("node-tls");
  for (const name of ["node:http", "node:https"]) for (const method of ["request", "get"]) require(name)[method] = () => blocked(name);
  require("node:dgram").createSocket = () => blocked("node-dgram");
  require("node:http2").connect = () => blocked("node-http2");
  const dns = require("node:dns");
  for (const method of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) {
    for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) if (typeof target[method] === "function") target[method] = () => blocked("node-dns");
  }
  globalThis.fetch = async () => blocked("node-fetch");
  for (const method of ["request", "fetch"]) electron.net[method] = () => blocked("electron-net");
  const protectSession = target => target.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const allowed = url.protocol === "wealth-atlas:" && url.hostname === "app" || ["data:", "blob:", "about:"].includes(url.protocol);
    if (!allowed) report.networkBlocked.chromium = (report.networkBlocked.chromium || 0) + 1;
    callback({ cancel: !allowed });
  });
  app.on("session-created", protectSession);
  app.whenReady().then(() => { protectSession(session.defaultSession); assert.equal(path.resolve(session.defaultSession.storagePath), profile); phase("SESSION_NETWORK_GUARD_READY"); }).catch(fail);

  const ipc = [], mainPath = path.join(stage, "desktop", "main.cjs");
  const realLoad = Module._load;
  const updater = { getState: () => ({ status: "disabled", reason: "isolated-test", retryAfterMs: 0 }), check: async () => ({ status: "disabled", reason: "isolated-test" }) };
  class IsolatedWindow extends BrowserWindow {
    constructor(options) {
      assert.equal(window, undefined, "Only the real main window is allowed");
      for (const key of ["contextIsolation", "sandbox", "webSecurity"]) assert.equal(options.webPreferences[key], true);
      assert.equal(options.webPreferences.nodeIntegration, false);
      assert.equal(options.webPreferences.preload, path.join(stage, "desktop", "preload.cjs"));
      super({ ...options, show: false, skipTaskbar: true, enableLargerThanScreen: true });
      window = this;
      phase("MAIN_WINDOW_CREATED");
      let started = false;
      this.webContents.on("did-finish-load", () => {
        if (this.webContents.getURL() === "about:blank") { phase("BOOTSTRAP_DOCUMENT_FINISHED"); return; }
        if (this.webContents.getURL() !== "wealth-atlas://app/") { fail(new Error("Unexpected main document")); return; }
        phase(started ? "APP_RELOAD_DOCUMENT_FINISHED" : "APP_DOCUMENT_FINISHED");
        if (!started) { started = true; void run().catch(fail); }
      });
      this.webContents.on("dom-ready", () => phase(this.webContents.getURL() === "about:blank" ? "BOOTSTRAP_DOM_READY" : "APP_DOM_READY"));
      this.webContents.on("preload-error", () => fail(new Error("Real sandboxed preload failed")));
      this.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame) { phase("MAIN_DOCUMENT_LOAD_FAILED"); fail(new Error("Main document load failed with code " + code)); }
      });
      this.webContents.on("render-process-gone", () => fail(new Error("Real renderer exited unexpectedly")));
      // A new BrowserWindow may have no live page target yet. Awaiting Page.*
      // before its first navigation can deadlock target creation. Bootstrap the
      // SAME sandboxed main window with an inert document, then install the
      // observer before the FIRST application document. Nothing runs in blank.
      // Assign on the instance: Electron may install own loadURL delegates.
      const realNavigation = this.webContents.loadURL.bind(this.webContents);
      this.loadURL = async (...args) => {
        try {
          assert.equal(args[0], "wealth-atlas://app/", "Only the real static app is loaded");
          phase("BOOTSTRAP_NAVIGATION_START");
          await bounded(realNavigation("about:blank"), "BOOTSTRAP_NAVIGATION");
          phase("BOOTSTRAP_NAVIGATION_COMPLETE");
          // observerReady is created ONLY after the blank renderer has loaded.
          // Bound both commands separately and the whole ready barrier, so a
          // debugger target that never responds cannot consume the 240s suite.
          this.observerReady = bounded((async () => {
            this.webContents.debugger.attach("1.3"); phase("DEBUGGER_ATTACHED");
            phase("PAGE_ENABLE_START");
            await bounded(this.webContents.debugger.sendCommand("Page.enable"), "PAGE_ENABLE");
            phase("PAGE_ENABLE_COMPLETE"); phase("OBSERVER_INSTALL_START");
            await bounded(this.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `(${observeIndexedDB.toString()})()` }), "OBSERVER_INSTALL");
            phase("OBSERVER_INSTALL_COMPLETE");
          })(), "OBSERVER_READY", 20000);
          await this.observerReady;
          phase("OBSERVER_READY_COMPLETE"); phase("APP_NAVIGATION_START");
          await bounded(realNavigation(...args), "APP_NAVIGATION", 25000);
          phase("APP_NAVIGATION_COMPLETE");
        } catch (error) { fail(error); throw error; }
      };
    }
  }
  Module._load = function (request, parent, ...rest) {
    if (parent?.filename === mainPath && request === "./updater.cjs") return { setupAutoUpdates: () => updater };
    if (parent?.filename === mainPath && request === "electron-updater") return { autoUpdater: {} };
    if (parent?.filename === mainPath && request === "electron") return { ...electron, BrowserWindow: IsolatedWindow,
      shell: { ...electron.shell, openExternal: () => blocked("external-open"), openPath: () => blocked("shell-open") },
      ipcMain: { on: (...args) => electron.ipcMain.on(...args), handle(channel, handler) {
        electron.ipcMain.handle(channel, async (event, ...args) => {
          assert.equal(event.sender, window.webContents, "Owned main window IPC only");
          assert.equal(event.senderFrame, window.webContents.mainFrame, "Owned top frame IPC only");
          const sender = new URL(event.senderFrame.url);
          assert.equal(sender.protocol, "wealth-atlas:"); assert.equal(sender.hostname, "app");
          if (channel === "desktop:activate-data-profile") assert.equal(args[0], "local", "Never open cloud/guest profiles");
          if (/^vault:/.test(channel) || /^investment:/.test(channel) || /restart-app|open-.*location/.test(channel)) throw new Error("RESTORE_UI_FORBIDDEN_SIDE_EFFECT: " + channel);
          // Never let the production rolling-autosave cleanup delete test files.
          // Fail before entering that handler if a slow run reaches the cap.
          if (channel === "desktop:write-autosave") {
            const autosaves = path.join(profile, "autosaves");
            if (fs.existsSync(autosaves) && fs.readdirSync(autosaves, { withFileTypes: true }).filter(item => item.isDirectory()).length >= 10) {
              fail(new Error("Autosave cap reached; stopped before any rolling deletion. Evidence retained."));
              throw new Error("RESTORE_UI_AUTOSAVE_CAP");
            }
          }
          const entry = { channel, at: Date.now() }; ipc.push(entry); active++;
          try {
            const result = await handler(event, ...args);
            entry.completedAt = Date.now(); entry.ok = true;
            if (channel === safetyChannel) entry.result = result;
            if (channel === "desktop:mark-startup-ready") startupReady++;
            return result;
          } catch (error) { entry.ok = false; throw error; }
          finally { active--; }
        });
      } },
    };
    return realLoad.call(this, request, parent, ...rest);
  };
  const js = code => bounded(window.webContents.executeJavaScript(code, true), "RENDERER_EVALUATION");
  const panel = `document.querySelector('[data-testid="backup-restore"]')`;
  const dialog = `document.querySelector('dialog[open]')`;
  const button = (scope, label) => `[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${json(label)})`;
  const count = channel => ipc.filter(item => item.channel === channel).length;
  async function until(predicate, label, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await predicate()) return; await pause(80); }
    throw new Error("Timed out: " + label);
  }
  const wait = (expression, label, timeout) => until(() => js(expression), label, timeout);
  const text = label => wait(`${dialog}?.innerText.includes(${json(label)})`, label);
  async function click(expression, repetitions = 1) {
    await wait(`Boolean(${expression})`, "action exists: " + expression);
    await js(`(()=>{const b=${expression};b.scrollIntoView({block:'center'});b.focus();for(let i=0;i<${repetitions};i++)b.click()})()`);
  }
  async function key(keyCode, modifiers = []) {
    window.setOpacity(0); window.showInactive(); window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Return") window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await pause(80);
  }
  async function settings() {
    phase("SETTINGS_OPEN_START");
    await wait(`Boolean(${button("document", "设置")})`, "Settings navigation");
    await until(async () => { await click(button("document", "设置")); return js(`Boolean(${panel})`); }, "actual Settings render");
    await wait(`${panel}&&!${panel}.innerText.includes('正在核对恢复保护状态')&&!${panel}.innerText.includes('正在读取备份…')`, "backup list and durable hold loaded");
    phase("SETTINGS_OPEN_COMPLETE");
  }
  async function quiet() {
    let signature = "", since = Date.now();
    await until(async () => {
      const next = json([count(safetyChannel), count("desktop:write-autosave"), await js(`window.__restoreAcceptance.attempts.length`)]);
      if (next !== signature || active) { signature = next; since = Date.now(); }
      return Date.now() - since >= 2900 && !active;
    }, "startup/autosave settlement", 20000);
  }
  async function database(operation, payload) {
    return js(`(${async function (op, value) {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open("wealth-atlas"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(["snapshots", "obsidianHandles"], op === "seed" ? "readwrite" : "readonly");
          let result;
          tx.onabort = tx.onerror = () => reject(tx.error || new Error("IDB transaction aborted"));
          tx.oncomplete = () => resolve(result);
          if (op === "seed") { tx.objectStore("snapshots").put({ id: "current", data: value, updatedAt: new Date().toISOString() }); result = true; }
          else { result = {}; for (const name of ["snapshots", "obsidianHandles"]) { const r = tx.objectStore(name).getAll(); r.onsuccess = () => { result[name] = r.result; }; } }
        });
      } finally { db.close(); }
    }.toString()})(${json(operation)},${json(payload ?? null)})`);
  }
  const rows = () => database("read");
  const current = all => all.snapshots.find(row => row.id === "current");
  const hold = all => all.snapshots.find(row => row.id === holdKey)?.hold;
  async function mark() { return { data: await rows(), safety: count(safetyChannel), writes: await js(`window.__restoreAcceptance.attempts.length`), commits: await js(`window.__restoreAcceptance.commits.length`) }; }
  async function unchanged(before) {
    assert.deepEqual(await rows(), before.data, "Read-only UI changed IndexedDB rows");
    assert.equal(count(safetyChannel), before.safety, "Read-only UI created a safety backup");
    assert.equal(await js(`window.__restoreAcceptance.attempts.length`), before.writes, "Preview/cancel attempted IndexedDB writes");
  }
  async function reload() {
    phase("APP_RELOAD_START");
    const ready = startupReady;
    const loaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.webContents.reload(); await bounded(loaded, "APP_RELOAD", 25000);
    await settings(); await until(() => startupReady > ready, "real startup completed after reload"); await quiet();
    phase("APP_RELOAD_COMPLETE");
  }
  let source;
  async function preview() {
    const entries = await js("window.wealthAtlasDesktop.listBackups()");
    const listed = count("desktop:list-backups");
    await click(`${panel}.querySelector('[aria-label="刷新备份列表"]')`);
    await until(() => count("desktop:list-backups") > listed && active === 0, "real list refresh");
    await wait(`${panel}.querySelector('[aria-label="刷新备份列表"]').disabled===false&&${panel}.querySelectorAll('.backup-row').length===${entries.length}`, "refreshed backup rows");
    const index = entries.findIndex(item => item.id === source.id && item.kind === source.kind);
    assert.ok(index >= 0, "Selected backup still listed");
    await click(`${panel}.querySelectorAll('.backup-row button')[${index}]`);
    await text("恢复前，先看看会改变什么");
    await wait(`${dialog}?.querySelector('table')||${dialog}?.innerText.includes('这份备份与当前资料相同')`, "validated real preview");
    assert.ok(count(integrityChannel) > 0, "Real integrity IPC used by actual component");
  }
  async function finalStep() {
    await preview(); await click(button(dialog, "继续，确认恢复")); await text("最后确认恢复这份备份？");
    assert.equal(await js(`${button(dialog, "创建安全备份并恢复")}.disabled`), true, "Explicit acknowledgement is required");
  }
  async function acknowledge() {
    await js(`${dialog}.querySelector('input[type=checkbox]').focus()`); await key("Space");
    await wait(`${dialog}.querySelector('input[type=checkbox]').checked`, "native keyboard acknowledgement");
  }
  async function cancel() { await key("Escape"); await wait(`!${dialog}`, "Escape closes native dialog"); }
  async function capture(name, width, height) {
    phase("SCREENSHOT_START");
    window.setContentSize(width, height);
    await wait(`innerWidth===${width}&&innerHeight===${height}`, "exact content viewport");
    await js("document.fonts.ready");
    await js(`if (!${dialog}) ${panel}.scrollIntoView({block:'start'})`);
    await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const layout = await js(`(()=>{const d=${dialog},p=${panel},rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,panel:rect(p),dialog:d?rect(d):null,modal:d?.matches(':modal'),actions:d?[...d.querySelectorAll('footer button,header button')].map(rect):[]}})()`);
    const runCode = path.basename(testRoot).slice("restore-ui-".length, "restore-ui-".length + 8);
    const file = path.join(root, ".impeccable", "review", `restore-${runCode}-${name}.png`);
    ordinaryChain(path.dirname(file), true); fs.mkdirSync(path.dirname(file), { recursive: true }); absent(file);
    fs.writeFileSync(file, (await bounded(window.webContents.capturePage(), "SCREENSHOT_CAPTURE")).toPNG(), { flag: "wx" });
    report.screenshots.push({ file, width, height, layout });
    assert.ok(layout.documentWidth <= width + 1, "Horizontal page overflow at " + width);
    if (layout.dialog) {
      assert.equal(layout.modal, true, "A real native showModal dialog is required");
      assert.ok(layout.dialog.x >= 0 && layout.dialog.y >= 0 && layout.dialog.right <= width + 1 && layout.dialog.bottom <= height + 1, "Dialog clipped at " + width);
      assert.ok(layout.actions.every(r => r.height >= 44 && r.x >= 0 && r.right <= width + 1 && r.y >= 0 && r.bottom <= height + 1), "Dialog actions clipped or under 44px at " + width);
    }
    phase("SCREENSHOT_COMPLETE");
  }
  function backupBytes() {
    contained(profile, source.path); ordinaryChain(source.path);
    const result = {};
    for (const entry of fs.readdirSync(source.path)) { const file = path.join(source.path, entry); ordinaryFile(file); result[entry] = fs.readFileSync(file); }
    return result;
  }
  async function run() {
    phase("ACCEPTANCE_START");
    await wait(`Boolean(window.__restoreAcceptance)`, "observer present before real application tests");
    await settings(); await until(() => startupReady > 0, "real startup ready"); await quiet();
    assert.equal(await js("typeof require"), "undefined");
    assert.equal(await js("Object.isFrozen(window.wealthAtlasDesktop)"), true);
    assert.equal(await js("window.wealthAtlasDesktop.startupTestMode"), "restore-ui-local-only");
    assert.equal(await js("window.wealthAtlasDesktop.getDataLocation()"), profile);
    assert.equal(app.getPath("userData"), profile); assert.equal(app.getPath("sessionData"), profile);
    report.checks.push("real main/preload, sandbox, context isolation, owned top-frame private IPC, fresh local-only profile");
    phase("FIXTURE_SEED_START");
    await database("seed", syntheticData()); await reload();
    phase("FIXTURE_SEED_COMPLETE");
    const baseline = await rows(), live = current(baseline).data;
    assert.equal(live.accounts[0].name, "虚构当前账户");
    assert.deepEqual(baseline.obsidianHandles, [], "Never seed a usable Vault handle");
    const candidate = copy(live);
    candidate.accounts = [{ ...candidate.accounts[0], name: "虚构恢复账户", balance: 456 }, { id: "restore-ui-added", name: "虚构新增账户", type: "cash", currency: "MYR", balance: 7, status: "active", includeInNetWorth: true }];
    candidate.transactions.push({ id: "restore-ui-added-transaction", type: "income", accountId: "restore-ui-added", amount: 7, currency: "MYR", category: "其他收入", categoryId: "income:其他收入", date: "2026-11-03" });
    candidate.obsidian = { vaultName: "BACKUP-CONNECTION-MUST-NOT-REPLACE", status: "disconnected" };
    candidate.syncLogs = [];
    // Create the source through the REAL private bridge, not private filesystem seeding.
    const created = await js(`window.wealthAtlasDesktop.createRestoreSafetyBackup({snapshot:${json(candidate)},schemaVersion:10})`);
    const entries = await js("window.wealthAtlasDesktop.listBackups()");
    source = entries.find(item => item.path === created.path); assert.ok(source);
    const original = backupBytes(), originalHashes = Object.fromEntries(Object.entries(original).map(([name, bytes]) => [name, hash(bytes)]));
    const packet = await js(`window.wealthAtlasDesktop.readBackupWithIntegrity(${json(source.id)},${json(source.kind)})`);
    assert.deepEqual(packet.snapshot, candidate); assert.equal(packet.schemaVersion, 10);
    await click(`${panel}.querySelector('[aria-label="刷新备份列表"]')`); await quiet();
    const beforePreview = await mark();
    phase("PREVIEW_CANCEL_START");
    await preview();
    assert.equal(await js(`${dialog}.matches(':modal')&&${dialog}.contains(document.activeElement)&&document.activeElement.tagName==='H2'`), true);
    assert.equal(await js(`Boolean(document.getElementById(${dialog}.getAttribute('aria-labelledby'))&&document.getElementById(${dialog}.getAttribute('aria-describedby')))`), true);
    for (const [name, width, height] of [["preview-1440", 1440, 900], ["preview-1280", 1280, 800], ["preview-390", 390, 844], ["preview-320", 320, 720]]) await capture(name, width, height);
    await key("Tab");
    assert.equal(await js(`${dialog}.contains(document.activeElement)&&document.activeElement.matches(':focus-visible')`), true);
    assert.ok(await js("parseFloat(getComputedStyle(document.activeElement).outlineWidth)>=2"));
    const focusable = await js(`${dialog}.querySelectorAll('button:not([disabled]),input,summary').length`);
    for (let i = 0; i < focusable + 2; i++) { await key("Tab"); assert.equal(await js(`${dialog}.contains(document.activeElement)`), true, "Native modal focus containment"); }
    await key("Tab", ["shift"]); assert.equal(await js(`${dialog}.contains(document.activeElement)`), true);
    await cancel();
    assert.equal(await js(`document.activeElement?.textContent.trim()==='预览恢复'`), true, "Escape returns focus to source trigger");
    await unchanged(beforePreview);
    await preview(); await click(button(dialog, "取消，不恢复")); await wait(`!${dialog}`, "cancel button"); await unchanged(beforePreview);
    report.checks.push("preview/cancel/Escape make zero snapshot, hold, or safety writes; native modal labels, heading focus, Tab containment, visible focus, trigger focus return; four exact viewports");
    phase("PREVIEW_CANCEL_COMPLETE"); phase("ACKNOWLEDGEMENT_START");

    await finalStep();
    const beforeAck = await mark(); await click(button(dialog, "创建安全备份并恢复"), 100); await unchanged(beforeAck);
    await acknowledge(); await click(button(dialog, "返回差异预览")); await click(button(dialog, "继续，确认恢复"));
    assert.equal(await js(`${dialog}.querySelector('input').checked`), false, "Returning resets acknowledgement");
    await cancel(); await unchanged(beforeAck);
    report.checks.push("two distinct steps, disabled no-ack action, acknowledgement reset and final cancellation");
    phase("ACKNOWLEDGEMENT_COMPLETE"); phase("STALE_SOURCE_START");

    // An actual integrity failure in the selected SYNTHETIC source after preview.
    // Restore the bytes in finally; no file is deleted, and success uses the original.
    await finalStep(); await acknowledge(); const beforeStale = await mark();
    const snapshotFile = path.join(source.path, "wealth-data.json");
    try {
      fs.writeFileSync(snapshotFile, Buffer.concat([original["wealth-data.json"], Buffer.from(" ")]));
      await click(button(dialog, "创建安全备份并恢复")); await text("恢复未完成"); await unchanged(beforeStale);
    } finally { fs.writeFileSync(snapshotFile, original["wealth-data.json"]); }
    await cancel();
    report.checks.push("real integrity reread rejects source changed after preview, before any safety/snapshot write");
    phase("STALE_SOURCE_COMPLETE"); phase("STALE_DATA_START");

    // Another writer changes durable current after the preview, while React still
    // holds the old preview baseline. The real compare-and-swap must refuse it.
    await finalStep(); await acknowledge();
    const raced = copy(live); raced.accounts[0].name = "虚构并发保存，必须保留";
    await database("seed", raced); const beforeRace = await mark();
    await click(button(dialog, "创建安全备份并恢复")); await text("恢复未完成");
    assert.deepEqual(await rows(), beforeRace.data, "Stale durable data must not be replaced");
    assert.equal(count(safetyChannel), beforeRace.safety + 1, "Stale durable CAS occurs after a genuine safety backup");
    await cancel(); await reload();
    report.checks.push("stale durable current rejects atomic restore and retains the newer synthetic snapshot");
    phase("STALE_DATA_COMPLETE"); phase("DURABLE_RESTORE_START");

    await finalStep(); await acknowledge(); await capture("final-390", 390, 844);
    const beforeRestore = await mark();
    const expected = { ...candidate, obsidian: current(beforeRestore.data).data.obsidian, syncLogs: current(beforeRestore.data).data.syncLogs };
    await click(button(dialog, "创建安全备份并恢复"), 100);
    await wait(`!${dialog}&&${panel}?.innerText.includes('当前为本机恢复保护模式')`, "successful durable restore + paused UI");
    assert.equal(await js(`Boolean(document.querySelector('.toast')?.textContent.includes('已恢复本机资料'))`), true, "Real success toast follows completed restore");
    const afterRestore = await rows();
    assert.deepEqual(current(afterRestore).data, expected);
    assert.equal(count(safetyChannel), beforeRestore.safety + 1, "100 rapid clicks create exactly one safety backup");
    assert.equal(hold(afterRestore).paused, true); assert.equal(hold(afterRestore).generation, 1);
    assert.deepEqual(afterRestore.obsidianHandles, beforeRestore.data.obsidianHandles);
    assert.deepEqual(afterRestore.snapshots.filter(row => !["current", holdKey].includes(row.id)), beforeRestore.data.snapshots.filter(row => !["current", holdKey].includes(row.id)));
    const safety = ipc.filter(item => item.channel === safetyChannel).at(-1);
    assert.equal(safety.ok, true); assert.equal(safety.result.reused, false); contained(profile, safety.result.path);
    const saved = await js(`window.wealthAtlasDesktop.readBackupWithIntegrity(${json(safety.result.id)},'backup')`);
    assert.deepEqual(saved.snapshot, current(beforeRestore.data).data, "Real safety backup holds exact pre-restore data");
    for (const name of ["wealth-data.json", "metadata.json", "manifest.json"]) ordinaryFile(path.join(safety.result.path, name));
    const safetyHash = hash(fs.readFileSync(path.join(safety.result.path, "wealth-data.json")));
    assert.equal(safetyHash, safety.result.snapshotSha256);
    const metadata = JSON.parse(fs.readFileSync(path.join(safety.result.path, "metadata.json"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(safety.result.path, "manifest.json"), "utf8"));
    assert.equal(metadata.reason, "pre-restore"); assert.equal(metadata.networkUpload, false); assert.equal(metadata.snapshotSha256, safetyHash); assert.equal(manifest.files[0].sha256, safetyHash);
    const commits = await js(`window.__restoreAcceptance.commits.slice(${beforeRestore.commits}).filter(x=>x.key==='current'||x.key===${json(holdKey)})`);
    assert.equal(commits.filter(item => item.key === "current").length, 1);
    assert.equal(commits.filter(item => item.key === holdKey).length, 1);
    assert.equal(new Set(commits.map(item => item.transaction)).size, 1, "Snapshot and hold commit in the same native transaction");
    assert.ok(commits.every(item => item.at >= safety.completedAt), "Snapshot/hold commit must follow safety completion");
    assert.deepEqual(Object.fromEntries(Object.entries(backupBytes()).map(([name, bytes]) => [name, hash(bytes)])), originalHashes, "Selected backup intact");
    report.checks.push("100-click real restore: one verified/fsynced safety backup, durable current+pause after safety, selected backup intact, syncLogs/connection/other metadata retained");
    phase("DURABLE_RESTORE_COMPLETE"); phase("PERSISTENT_HOLD_START");
    await quiet(); await reload();
    const afterReload = await rows(); assert.deepEqual(current(afterReload).data, expected); assert.deepEqual(hold(afterReload), hold(afterRestore));
    await wait(`${panel}.innerText.includes('当前为本机恢复保护模式')`, "paused state survives reload");
    await capture("paused-390", 390, 844);
    await preview(); await text("这份备份与当前资料相同");
    assert.equal(await js(`${button(dialog, "继续，确认恢复")}.disabled`), true); await cancel();
    report.checks.push("restored snapshot and paused generation survive real reload; unchanged backup cannot restore again");
    phase("PERSISTENT_HOLD_COMPLETE"); phase("EXPLICIT_RESUME_START");

    const resumeButton = `${panel}.querySelector('[aria-label="检查并恢复自动写入"]')`;
    const beforeResume = await mark(); await click(resumeButton); await text("确认恢复自动写入？");
    assert.equal(await js(`${button(dialog, "确认恢复自动写入")}.disabled`), true);
    await click(button(dialog, "确认恢复自动写入")); await click(button(dialog, "继续保持暂停")); await wait(`!${dialog}`, "keep paused"); await unchanged(beforeResume);
    await click(resumeButton); await cancel(); await unchanged(beforeResume);
    await click(resumeButton); await acknowledge(); await click(button(dialog, "确认恢复自动写入"), 100);
    await wait(`!${dialog}&&!${panel}.innerText.includes('当前为本机恢复保护模式')`, "explicit acknowledged resume");
    const resumed = await rows(); assert.equal(hold(resumed).paused, false); assert.equal(hold(resumed).generation, 1); assert.equal(hold(resumed).revision, hold(afterRestore).revision + 1);
    assert.deepEqual(current(resumed), current(beforeResume.data)); assert.equal(count(safetyChannel), beforeResume.safety);
    await quiet(); await reload(); assert.equal(hold(await rows()).paused, false); assert.deepEqual(current(await rows()).data, expected);
    assert.deepEqual(Object.fromEntries(Object.entries(backupBytes()).map(([name, bytes]) => [name, hash(bytes)])), originalHashes);
    report.checks.push("resume cancellation/Escape/no-ack retain pause; acknowledged repeated-click resume only changes hold once and persists after reload");
    phase("EXPLICIT_RESUME_COMPLETE");
    report.ipcCounts = Object.fromEntries([...new Set(ipc.map(item => item.channel))].map(channel => [channel, count(channel)]));
    report.idb = await js("window.__restoreAcceptance");
    report.mainSha256 = hash(fs.readFileSync(mainPath)); report.preloadSha256 = hash(fs.readFileSync(path.join(stage, "desktop", "preload.cjs")));
    report.pass = true; finish(0);
  }
  function finish(code) {
    if (done) return; done = true;
    phase(code === 0 ? "ACCEPTANCE_PASS" : "ACCEPTANCE_FAIL");
    const file = path.join(testRoot, "result.json"); fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log("BACKUP_RESTORE_DESKTOP_TEST " + json(report)); app.exit(code);
  }
  function fail(error) { if (done) return; report.error = String(error?.stack || error); finish(1); }
  setTimeout(() => fail(new Error("Restore acceptance exceeded 240 seconds")), 240000).unref();
  phase("REAL_MAIN_REQUIRE_START");
  require(mainPath);
  phase("REAL_MAIN_REQUIRE_COMPLETE");
  // Main already captured smokeMode=null synchronously. Only subsequently
  // spawned preload inherits this EXISTING local-startup marker. Thus the real
  // account boundary selects local, while main does not run/exit its smoke suite.
  process.env.WEALTH_ATLAS_DESKTOP_SMOKE = "restore-ui-local-only";
  phase("LOCAL_ONLY_STARTUP_MARKER_READY");
}

async function launch() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/backup-restore-desktop-test.cjs --stage=C:\\Users\\J\\Documents\\Codex\\wa1710-qa-<8hex>\nFresh profile: repo/work/restore-ui-UUID/p. No installation/build/dependencies/cleanup.\nPNG evidence: repo/.impeccable/review/restore-<run8>-*.png (absolute paths in result.json).\nAll runs are retained; nothing is deleted or overwritten."); return;
  }
  assert.equal(process.platform, "win32", "Windows real-main acceptance only");
  assert.equal(argument("test-root"), undefined, "Test root is generated, never user-supplied/reused");
  const stage = stagePath(); // Validate everything before creating runtime outputs.
  const review = path.join(root, ".impeccable", "review"); ordinaryChain(review, true);
  const work = path.join(root, "work"); ordinaryChain(work, true); fs.mkdirSync(work, { recursive: true });
  const testRoot = path.join(work, "restore-ui-" + randomUUID()); absent(testRoot); fs.mkdirSync(testRoot);
  for (const name of ["p", "h", "r", "l", "tmp", "app"]) fs.mkdirSync(path.join(testRoot, name));
  const version = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8")).version; assert.equal(version, "1.7.10");
  fs.writeFileSync(path.join(testRoot, "app", "package.json"), json({ name: "wealth-atlas-restore-ui-test", version, main: "bootstrap.cjs" }), { flag: "wx" });
  fs.writeFileSync(path.join(testRoot, "app", "bootstrap.cjs"), `require(${json(__filename)});`, { flag: "wx" });
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.join(systemRoot, "System32"),
    USERPROFILE: path.join(testRoot, "h"), HOME: path.join(testRoot, "h"),
    HOMEDRIVE: path.parse(testRoot).root.slice(0, 2), HOMEPATH: path.join(testRoot, "h").slice(2),
    APPDATA: path.join(testRoot, "r"), LOCALAPPDATA: path.join(testRoot, "l"), TEMP: path.join(testRoot, "tmp"), TMP: path.join(testRoot, "tmp"),
    WEALTH_ATLAS_TEST_PROFILE: path.join(testRoot, "p"), WA_RESTORE_RUN: path.basename(testRoot) };
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(require("electron"), [path.join(testRoot, "app"), `--stage=${stage}`, `--test-root=${testRoot}`], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", progressBuffer = "";
    const watchdog = setTimeout(() => { child.kill(); }, 270000); watchdog.unref();
    child.stdout.on("data", chunk => {
      output += chunk; progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/); progressBuffer = lines.pop();
      for (const line of lines) if (line.startsWith("RESTORE_UI_PHASE ")) console.log(line);
    });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", error => { clearTimeout(watchdog); reject(error); });
    child.on("close", code => {
      clearTimeout(watchdog); fs.writeFileSync(path.join(testRoot, "driver.log"), output, { flag: "wx" });
      const file = path.join(testRoot, "result.json");
      const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      console.log(json({ exitCode: code, testRoot, resultPath: file, result }));
      resolve(code === 0 && result?.pass === true ? 0 : 1);
    });
  });
  process.exitCode = exitCode;
}
(process.versions.electron ? electronTest() : launch()).catch(error => {
  console.error(error); process.exitCode = 1;
  if (process.versions.electron) require("electron").app.exit(1);
});
