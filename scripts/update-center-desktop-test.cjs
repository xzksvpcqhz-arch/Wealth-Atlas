// Isolated application test: real static app, main IPC and sandboxed preload.
// Only updater responses are synthetic. No installer, online feed or user profile is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const argument = (name) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);

async function electronTest() {
  const electron = require("electron");
  const { app, BrowserWindow, session } = electron;
  const Module = require("node:module");
  const stage = path.resolve(argument("stage"));
  const testRoot = path.resolve(argument("test-root"));
  assert.ok(stage.startsWith(path.join(root, "work", "update-center-desktop-")));
  assert.ok(testRoot.startsWith(path.join(root, "work", "update-center-tests") + path.sep));
  assert.equal(process.env.WEALTH_ATLAS_TEST_PROFILE, path.join(testRoot, "profile"));
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8")).version;
  assert.equal(app.getVersion(), expectedVersion);
  app.setAppPath(stage);
  app.disableHardwareAcceleration();
  const checks = [];
  const report = { pass: false, appVersion: expectedVersion, realMainAndPreload: true, contextIsolation: true, sandbox: true, syntheticUpdater: true, actualInstallerExecuted: false, userProfileOpened: false, externalNetworkRequests: 0, screenshots: [], checks };
  let state = { status: "idle", retryAfterMs: 0, checkedAt: null };
  let checkCalls = 0;
  let notesCalls = 0;
  let notesFail = false;
  let readMode = "normal";
  let releaseDelayed;
  let mainWindow;
  const mainPath = path.join(stage, "desktop", "main.cjs");
  const sourceLoad = Module._load;
  const controller = {
    getState() { if (readMode === "failure") throw new Error("SYNTHETIC_PRIVATE_DETAIL_NOT_FOR_UI"); return { ...state }; },
    check() { checkCalls++; state = { ...state, status: "checking", checkedAt: Date.now() }; return Promise.resolve(state); },
  };
  class HiddenWindow extends BrowserWindow {
    constructor(options) {
      assert.equal(options.webPreferences.contextIsolation, true);
      assert.equal(options.webPreferences.sandbox, true);
      assert.equal(options.webPreferences.webSecurity, true);
      assert.equal(options.webPreferences.nodeIntegration, false);
      super({ ...options, show: false, skipTaskbar: true, enableLargerThanScreen: true });
      mainWindow = this;
      this.webContents.on("did-finish-load", () => { void run(this).catch(fail); });
    }
  }
  Module._load = function (request, parent, ...rest) {
    if (parent?.filename === mainPath && request === "./updater.cjs") return { setupAutoUpdates: () => controller };
    if (parent?.filename === mainPath && request === "electron") return {
      ...electron,
      BrowserWindow: HiddenWindow,
      ipcMain: { on: (...args) => electron.ipcMain.on(...args), handle(channel, callback) {
        electron.ipcMain.handle(channel, async (...args) => {
          if (channel === "updates:get-state" && readMode === "hang") return new Promise(() => {});
          if (channel === "updates:get-state" && readMode === "delay-once") {
            readMode = "normal";
            const old = await callback(...args);
            return new Promise((resolve) => { releaseDelayed = () => resolve(old); });
          }
          return callback(...args);
        });
      } },
      shell: { ...electron.shell, openExternal: async (url) => {
        assert.equal(url, "https://github.com/xzksvpcqhz-arch/Wealth-Atlas/releases");
        notesCalls++; if (notesFail) throw new Error("SYNTHETIC_NOTES_FAILURE");
      } },
    };
    return sourceLoad.call(this, request, parent, ...rest);
  };
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = /^(wealth-atlas:|data:|blob:|about:)/.test(details.url);
      if (!allowed) report.externalNetworkRequests++;
      callback({ cancel: !allowed });
    });
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const js = (window, code) => window.webContents.executeJavaScript(code);
  const panel = `document.querySelector('[data-testid="update-center"]')`;
  const text = (window) => js(window, `${panel}?.innerText ?? ''`);
  async function wait(window, predicate, label, milliseconds = 12000) {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) { if (await js(window, predicate)) return; await sleep(100); }
    throw new Error("Timed out: " + label);
  }
  async function waitText(window, value, milliseconds) { await wait(window, `${panel}?.innerText.includes(${JSON.stringify(value)})`, value, milliseconds); }
  async function openSettings(window) {
    await wait(window, `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='设置')`, "settings navigation");
    // The app restores its active section asynchronously on first mount.
    // Wait through that existing restoration rather than racing the first click.
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      await js(window, `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='设置').click()`);
      await sleep(150);
      if (await js(window, `Boolean(${panel})`)) return;
    }
    throw new Error("Timed out: real settings render path");
  }
  const checkButton = `${panel}.querySelector('button')`;
  const notesButton = `Array.from(${panel}.querySelectorAll('button')).find(b=>b.textContent.includes('发布说明'))`;
  async function capture(window, name, width, height) {
    window.setContentSize(width, height);
    await sleep(150);
    await js(window, `${panel}.scrollIntoView({block:'start'}); window.scrollTo(0,0)`);
    await sleep(100);
    const layout = await js(window, `(()=>{const p=${panel},w=innerWidth,r=p.getBoundingClientRect();return {viewportWidth:w,documentWidth:document.documentElement.scrollWidth,panelWidth:r.width,buttons:[...p.querySelectorAll('button')].map(b=>{const x=b.getBoundingClientRect();return {width:x.width,height:x.height,left:x.left,right:x.right}}),background:getComputedStyle(document.body).backgroundColor}})()`);
    assert.ok(layout.documentWidth <= width + 1, "Horizontal overflow at " + width);
    assert.ok(layout.panelWidth > 200 && layout.panelWidth <= width, "Panel width at " + width);
    assert.ok(layout.buttons.every((b) => b.height >= 44 && b.left >= 0 && b.right <= width + 1), "Clipped or small update button at " + width);
    const file = path.join(root, ".impeccable", "review", name + ".png");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
    report.screenshots.push({ file, width, height, layout });
    for (const index of [0, 1]) {
      const reachable = await js(window, `(()=>{const b=${panel}.querySelectorAll('button')[${index}];b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect(),e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return e===b||b.contains(e)})()`);
      assert.equal(reachable, true, "Update action covered after scrolling at " + width);
    }
    if (width < 500) {
      const actionsFile = path.join(root, ".impeccable", "review", name + "-actions.png");
      fs.writeFileSync(actionsFile, (await window.webContents.capturePage()).toPNG());
      report.screenshots.push({ file: actionsFile, width, height, actionReachability: true });
    }
    await js(window, `window.scrollTo(0,0)`);
    const fullHeight = await js(window, `Math.ceil(document.documentElement.scrollHeight)`);
    assert.ok(fullHeight < 16000, "Unexpectedly tall synthetic settings page");
    window.setContentSize(width, fullHeight);
    await sleep(150);
    const fullFile = path.join(root, ".impeccable", "review", name + "-full.png");
    fs.writeFileSync(fullFile, (await window.webContents.capturePage()).toPNG());
    report.screenshots.push({ file: fullFile, width, height: fullHeight, fullPage: true });
    window.setContentSize(width, height);
  }
  async function run(window) {
    if (window !== mainWindow || report.running) return;
    report.running = true;
    await openSettings(window);
    await waitText(window, "随时查看更新状态");
    const bridgeState = await js(window, `window.wealthAtlasDesktop.getUpdateState()`);
    assert.equal(bridgeState.ok, true, "Real owned-frame IPC must work");
    assert.equal(bridgeState.state.currentVersion, expectedVersion);
    assert.equal(bridgeState.state.platform, "win32");
    assert.equal(await js(window, `typeof require`), "undefined");
    assert.equal(await js(window, `Object.isFrozen(window.wealthAtlasDesktop)`), true);
    checks.push("real-owned-frame-ipc-and-sandbox");

    const before = checkCalls;
    await js(window, `(()=>{const b=${checkButton}; for(let i=0;i<100;i++) b.click()})()`);
    await waitText(window, "正在检查可用更新");
    assert.equal(checkCalls - before, 1);
    checks.push("100-clicks-one-check");
    state = { status: "downloading", latestVersion: "9.0.0", progressPercent: 37.5, checkedAt: Date.now(), retryAfterMs: 0 };
    await waitText(window, "37.5%");
    assert.equal(await js(window, `${panel}.querySelector('progress').value`), 37.5);
    state = { ...state, progressPercent: 100 };
    await waitText(window, "下载字节已完成");
    assert.ok(!(await text(window)).includes("更新已下载完成"));
    checks.push("real-progress-and-100-percent-awaits-verification");
    state = { status: "downloaded", latestVersion: "9.0.0", version: "9.0.0", checkedAt: Date.now(), retryAfterMs: 0, warningCode: "ENOTFOUND" };
    await waitText(window, "后续网络检查暂时失败");
    assert.equal(await js(window, `${checkButton}.disabled`), true);
    assert.equal(await js(window, `${panel}.querySelectorAll('progress').length`), 0);
    checks.push("verified-ready-survives-network-warning-no-force-quit");
    await capture(window, "desktop", 1440, 900);
    await capture(window, "user-1280", 1280, 800);
    await capture(window, "mobile", 390, 844);
    await capture(window, "user-320", 320, 720);

    state = { status: "error", code: "ERR_CHECKSUM_MISMATCH", checkedAt: Date.now(), retryAfterMs: 1200 };
    await waitText(window, "安装包校验未通过");
    await waitText(window, "为避免重复请求");
    assert.equal(await js(window, `${checkButton}.disabled`), true);
    assert.equal(await js(window, `${checkButton}.getAttribute('aria-label')`), await js(window, `${checkButton}.innerText`));
    state = { ...state, retryAfterMs: 0 };
    await wait(window, `${checkButton}.disabled===false`, "cooldown completed");
    checks.push("integrity-failure-and-visible-retry-cooldown");

    notesFail = true;
    await js(window, `${notesButton}.click()`);
    await waitText(window, "暂时无法打开发布说明");
    assert.equal(notesCalls, 1);
    await sleep(5100); notesFail = false;
    window.setOpacity(0); window.showInactive(); window.focus(); window.webContents.focus();
    await js(window, `${checkButton}.focus()`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await wait(window, `document.activeElement===${notesButton}&&document.activeElement.matches(':focus-visible')`, "Tab reaches release notes with visible focus");
    const focus = await js(window, `({width:getComputedStyle(document.activeElement).outlineWidth,style:getComputedStyle(document.activeElement).outlineStyle})`);
    assert.equal(focus.style, "solid"); assert.ok(parseFloat(focus.width) >= 2);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    const keyEnd = Date.now() + 4000;
    while (notesCalls < 2 && Date.now() < keyEnd) await sleep(50);
    assert.equal(notesCalls, 2);
    await wait(window, `${panel}&&!${notesButton}.disabled`, "keyboard release notes completed");
    window.hide();
    checks.push("fixed-release-link-failure-retry-keyboard-focus");

    readMode = "failure";
    await waitText(window, "暂时无法读取更新状态");
    assert.ok(!(await text(window)).includes("SYNTHETIC_PRIVATE"));
    assert.equal(await js(window, `${checkButton}.getAttribute('aria-label')`), "重新读取状态");
    readMode = "normal"; state = { status: "up-to-date", latestVersion: expectedVersion, retryAfterMs: 0, checkedAt: Date.now() };
    await js(window, `${checkButton}.click()`);
    await waitText(window, "当前没有更高的可用正式版本");
    checks.push("ipc-failure-fixed-copy-and-reload-recovery");

    readMode = "delay-once";
    await wait(window, `${checkButton}.disabled===false`, "check available");
    const delayedEnd = Date.now() + 7000;
    while (!releaseDelayed && Date.now() < delayedEnd) await sleep(50);
    assert.ok(releaseDelayed);
    window.showInactive(); window.focus(); window.webContents.focus();
    await js(window, `${checkButton}.focus()`);
    const callsBeforeSpace = checkCalls;
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    window.webContents.sendInputEvent({ type: "char", keyCode: " " });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await waitText(window, "正在检查可用更新");
    assert.equal(checkCalls, callsBeforeSpace + 1);
    window.hide();
    releaseDelayed();
    await sleep(180);
    await waitText(window, "正在检查可用更新");
    checks.push("stale-poll-cannot-replace-new-check-and-space-key");

    readMode = "hang";
    await waitText(window, "暂时无法读取更新状态", 16000);
    readMode = "normal";
    state = { status: "disabled", reason: "isolated-test", retryAfterMs: 0 };
    await js(window, `${checkButton}.click()`);
    await waitText(window, "隔离测试模式已关闭线上更新");
    checks.push("hung-ipc-timeout-and-disabled-test-environment");
    await js(window, `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='首页').click()`);
    assert.equal(await js(window, `Boolean(${panel})`), false);
    state = { status: "error", code: "UPDATE_CONFIGURATION_FAILED", retryAfterMs: 0 };
    await openSettings(window);
    await waitText(window, "更新器初始化失败");
    assert.equal(await js(window, `${checkButton}.disabled`), true);
    checks.push("unmount-reopen-and-configuration-failure-locked");

    const browser = new BrowserWindow({ show: false, width: 390, height: 844, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    await browser.loadURL("wealth-atlas://app/");
    await openSettings(browser);
    await waitText(browser, "请在 Windows 桌面版检查更新");
    assert.equal(await js(browser, `${checkButton}.disabled`), true);
    assert.equal(await js(browser, `${panel}.querySelector('a').getAttribute('href')`), "https://github.com/xzksvpcqhz-arch/Wealth-Atlas/releases");
    checks.push("real-browser-without-preload-does-not-pretend-to-update");
    browser.destroy();
    assert.equal(app.getPath("userData"), process.env.WEALTH_ATLAS_TEST_PROFILE);
    report.pass = true; delete report.running;
    fs.writeFileSync(path.join(testRoot, "result.json"), JSON.stringify(report, null, 2));
    console.log("UPDATE_CENTER_DESKTOP_TEST " + JSON.stringify(report));
    app.exit(0);
  }
  function fail(error) {
    delete report.running;
    report.error = String(error?.stack ?? error);
    fs.writeFileSync(path.join(testRoot, "result.json"), JSON.stringify(report, null, 2));
    console.error("UPDATE_CENTER_DESKTOP_TEST " + JSON.stringify(report));
    app.exit(1);
  }
  setTimeout(() => fail(new Error("Isolated updater UI test timed out")), 120000).unref();
  require(mainPath);
}

async function launch() {
  const stage = path.resolve(argument("stage") || "");
  assert.ok(stage.startsWith(path.join(root, "work", "update-center-desktop-")), "Pass a code-only static export --stage under work/update-center-desktop-UUID");
  assert.ok(fs.existsSync(path.join(stage, "out", "index.html")));
  const testRoot = path.join(root, "work", "update-center-tests", randomUUID());
  for (const name of ["home", "roaming", "local", "temp", "profile", "app"]) fs.mkdirSync(path.join(testRoot, name), { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8")).version;
  fs.writeFileSync(path.join(testRoot, "app", "package.json"), JSON.stringify({ name: "wealth-atlas-update-center-test", version, main: "bootstrap.cjs" }));
  fs.writeFileSync(path.join(testRoot, "app", "bootstrap.cjs"), `require(${JSON.stringify(__filename)});`);
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const env = {
    SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.join(systemRoot, "System32"),
    USERPROFILE: path.join(testRoot, "home"), HOME: path.join(testRoot, "home"),
    APPDATA: path.join(testRoot, "roaming"), LOCALAPPDATA: path.join(testRoot, "local"),
    TEMP: path.join(testRoot, "temp"), TMP: path.join(testRoot, "temp"),
    WEALTH_ATLAS_TEST_PROFILE: path.join(testRoot, "profile"),
  };
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require("electron"), [path.join(testRoot, "app"), `--stage=${stage}`, `--test-root=${testRoot}`], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.on("error", reject);
    child.on("exit", (exitCode) => {
      fs.writeFileSync(path.join(testRoot, "driver.log"), output);
      console.log(JSON.stringify({ exitCode, testRoot, result: fs.existsSync(path.join(testRoot, "result.json")) ? JSON.parse(fs.readFileSync(path.join(testRoot, "result.json"), "utf8")) : null }));
      resolve(exitCode);
    });
  });
  process.exitCode = code === 0 ? 0 : 1;
}

(process.versions.electron ? electronTest() : launch()).catch((error) => { console.error(error); process.exitCode = 1; });
