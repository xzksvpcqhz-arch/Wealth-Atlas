// Production login component in an isolated Chromium profile. No hosted Auth or financial I/O.
const path = require("node:path");
if (process.type === "browser") {
  const { app, BrowserWindow, protocol, ipcMain } = require("electron");
  const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
  const profile = path.resolve(__dirname, "../../work/login-history-tests", require("node:crypto").randomUUID());
  mkdirSync(profile, { recursive: true }); app.setPath("userData", profile); app.setPath("sessionData", profile);
  protocol.registerSchemesAsPrivileged([{ scheme: "wa-history-test", privileges: { standard: true, secure: true } }]);
  app.whenReady().then(async () => {
    let externalRequests = 0;
    const styleArgument = process.argv.find(value => value.startsWith("--styles="));
    const styles = styleArgument ? path.resolve(styleArgument.slice(9)) : null;
    const approvedBuildRoot = path.resolve(__dirname, "../../../wealth-atlas-ui-qa");
    if (styles && !new RegExp("^[0-9a-f-]{36}[\\\\/]source[\\\\/]out$", "i").test(path.relative(approvedBuildRoot, styles))) throw new Error("Only an isolated QA build may supply styles");
    const css = styles ? readdirSync(path.join(styles, "_next/static/css")).filter(name => name.endsWith(".css")).map(name => readFileSync(path.join(styles, "_next/static/css", name), "utf8")).join("\n") : "";
    protocol.handle("wa-history-test", request => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/assets.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
      if (styles && /^\/fonts\/space-grotesk-(400|500|600|700)\.ttf$/.test(pathname)) return new Response(readFileSync(path.join(styles, pathname)), { headers: { "Content-Type": "font/ttf" } });
      if (pathname !== "/") return new Response("", { status: 404 });
      return new Response(`<html><head>${styles ? "<link rel='stylesheet' href='/assets.css'>" : ""}</head><body><div class='app-shell'><div id='root' class='module-stack settings-stack'></div></div></body></html>`, { headers: { "Content-Type": "text/html" } });
    });
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
    ipcMain.handle("wa-history:key", async (_event, key) => {
      if (!["Space", "Return", "Tab"].includes(key)) throw new Error("Unsupported synthetic key");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
      if (key === "Return") win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    ipcMain.handle("wa-history:size", async (_event, width, height) => {
      if (![[1440,900],[1280,800],[1024,768],[390,844],[320,720]].some(size => size[0] === width && size[1] === height)) throw new Error("Unsupported QA size");
      win.setContentSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 60));
    });
    ipcMain.handle("wa-history:capture", async (_event, variant, width) => {
      if (!["signed-out", "connected"].includes(variant) || ![1440,1280,1024,390,320].includes(width)) throw new Error("Unsupported QA capture");
      const directory = path.join(profile, "screenshots"); mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, `${variant}-${width}.png`), (await win.webContents.capturePage()).toPNG(), { flag: "wx" });
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => { externalRequests++; callback({ cancel: true }); });
    await win.loadURL("wa-history-test://app/");
    const report = await win.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).run(false, ${Boolean(styles)})`);
    const loaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve)); win.webContents.reload(); await loaded;
    await win.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).run(true)`);
    if (externalRequests) throw new Error("Unexpected network request");
    console.log("LOGIN_HISTORY_PASS " + JSON.stringify({ ...report, refreshPersistence: true, realNetworkRequests: 0, financialDataAccessed: false, ...(styles ? { screenshots: path.join(profile, "screenshots") } : {}) }));
    win.destroy(); app.exit(0);
  }).catch((error) => { console.error("LOGIN_HISTORY_FAIL " + error.message); app.exit(1); });
} else {
  exports.run = async (reloaded, styled = false) => {
    const assert = require("node:assert/strict"), { readFileSync } = require("node:fs"), ts = require("typescript");
    const React = require("react"), { createRoot } = require("react-dom/client"), { act } = React;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const modules = new Map();
    const icons = new Proxy({}, { get: () => props => React.createElement("svg", { "aria-hidden": true, width: props.size ?? 16, height: props.size ?? 16 }) });
    function load(file) {
      if (modules.has(file)) return modules.get(file).exports;
      const mod = { exports: {} }; modules.set(file, mod);
      const source = readFileSync(path.resolve(__dirname, "../..", file), "utf8");
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
      new Function("require", "module", "exports", compiled)((name) => name === "@phosphor-icons/react" ? icons
        : name === "@/lib/login-history" ? load("lib/login-history.ts")
        : name === "@/lib/auto-login" ? load("lib/auto-login.ts") : require(name), mod, mod.exports);
      return mod.exports;
    }
    const memory = load("lib/login-history.ts"), Panel = load("components/CloudSyncPanel.tsx").default;
    const autoLogin = load("lib/auto-login.ts");
    const calls = [];
    const cloud = { user: null, status: "signed-out", lastSyncedAt: null, error: null, recovering: false,
      signIn: async (...args) => { calls.push(args); }, signUp: async () => {}, signOut: async () => {}, syncNow: async () => {}, resetPassword: async () => {}, completePasswordReset: async () => {} };
    const root = createRoot(document.getElementById("root")); let serial = 0;
    async function mount() { await act(async () => { root.render(React.createElement(Panel, { cloud, key: ++serial })); }); }
    const button = (text) => [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text);
    const select = () => document.querySelector('select[aria-label="选择历史登录账号"]');
    const email = () => document.querySelector('input[type="email"]');
    const password = () => document.querySelector('input[type="password"]');
    const checkbox = () => document.querySelector('input[type="checkbox"]');
    const autoSwitch = () => document.querySelector('button[role="switch"][aria-label="下次自动登录，仅此设备"]');
    function input(element, value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    async function choose(value) { await act(async () => { select().value = value; select().dispatchEvent(new Event("change", { bubbles: true })); }); }
    if (reloaded) {
      await mount(); assert.equal(select().options.length, 2); assert.equal(select().options[1].value, "two@example.invalid");
      assert.equal(autoSwitch().getAttribute("aria-checked"), "false", "Next-login setting survives a real page reload");
      assert.equal(checkbox().checked, false); assert.equal(calls.length, 0); await act(async () => root.unmount()); return;
    }
    await mount(); assert.equal(select().disabled, true); assert.equal(checkbox().checked, false);
    assert.equal(autoSwitch().type, "button"); assert.equal(autoSwitch().getAttribute("aria-checked"), "true");
    assert.ok(autoSwitch().title); assert.ok(document.getElementById(autoSwitch().getAttribute("aria-describedby")));
    await act(async () => autoSwitch().click());
    assert.equal(autoSwitch().getAttribute("aria-checked"), "false");
    assert.equal(calls.length, 0); assert.equal(autoLogin.readAutoLoginPreference().enabled, false);
    checkbox().focus();
    await act(async () => require("electron").ipcRenderer.invoke("wa-history:key", "Tab"));
    assert.equal(document.activeElement, autoSwitch(), "Tab reaches the switch in the real login form");
    await act(async () => require("electron").ipcRenderer.invoke("wa-history:key", "Space"));
    assert.equal(autoSwitch().getAttribute("aria-checked"), "true");
    await act(async () => require("electron").ipcRenderer.invoke("wa-history:key", "Return"));
    assert.equal(autoSwitch().getAttribute("aria-checked"), "false");
    assert.equal(calls.length, 0, "Keyboard use of the switch never submits the form");
    assert.match(document.body.textContent, /首次请手动输入邮箱/);
    await act(async () => { memory.rememberLoginEmail("one@example.invalid"); memory.rememberLoginEmail("two@example.invalid"); });
    assert.equal(select().options.length, 3);
    await act(async () => input(password(), "synthetic-secret"));
    await choose("one@example.invalid"); assert.equal(email().value, "one@example.invalid"); assert.equal(password().value, ""); assert.equal(calls.length, 0);
    await act(async () => input(password(), "synthetic-secret"));
    await act(async () => { document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(calls.length, 1); assert.equal(calls[0][2], false);
    await act(async () => checkbox().click());
    await act(async () => { document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(calls.length, 2); assert.equal(calls[1][2], true);
    await act(async () => button("移除此邮箱记忆").click());
    assert.equal(document.activeElement, button("确认移除此邮箱记忆"));
    await act(async () => button("取消").click());
    assert.equal(memory.readLoginHistory().emails.length, 2);
    await act(async () => button("移除此邮箱记忆").click());
    await act(async () => document.querySelector('.cloud-forget-confirm').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(memory.readLoginHistory().emails.length, 2);
    await act(async () => button("移除此邮箱记忆").click());
    await act(async () => button("确认移除此邮箱记忆").click());
    assert.equal(memory.readLoginHistory().emails.join(","), "two@example.invalid");
    assert.equal(select().options.length, 2); assert.equal(calls.length, 2);
    assert.match(document.body.textContent, /已移除此邮箱记忆/);
    await act(async () => button("注册新账号").click());
    assert.equal(select(), null); assert.equal(checkbox(), null);
    await act(async () => button("登录").click());
    await act(async () => button("忘记密码？").click());
    assert.equal(select(), null); assert.ok(button("发送重置邮件"));
    assert.equal(autoSwitch(), null, "Recovery request form is unchanged");
    cloud.user = { id: "synthetic-connected-owner", email: "connected@example.invalid" }; cloud.status = "ready";
    await mount();
    assert.equal(autoSwitch().getAttribute("aria-checked"), "false");
    const profileBefore = cloud.user;
    await act(async () => autoSwitch().click());
    assert.equal(cloud.user, profileBefore, "Preference changes never sign out or change owner");
    assert.equal(autoSwitch().getAttribute("aria-checked"), "true");
    await act(async () => autoSwitch().click());
    autoSwitch().focus();
    await act(async () => require("electron").ipcRenderer.invoke("wa-history:key", "Space"));
    assert.equal(autoSwitch().getAttribute("aria-checked"), "true", "Native Space toggles the real button");
    await act(async () => require("electron").ipcRenderer.invoke("wa-history:key", "Return"));
    assert.equal(autoSwitch().getAttribute("aria-checked"), "false", "Native Enter toggles without submitting the login form");
    assert.equal(calls.length, 2);
    let layoutChecks = 0;
    if (styled) {
      await document.fonts.ready;
      for (const variant of ["connected", "signed-out"]) {
        cloud.user = variant === "connected" ? { id: "synthetic-layout-owner", email: "layout@example.invalid" } : null;
        await mount();
        for (const [width, height] of [[1440,900],[1280,800],[1024,768],[390,844],[320,720]]) {
          await require("electron").ipcRenderer.invoke("wa-history:size", width, height);
          autoSwitch().scrollIntoView({ block: "center", behavior: "instant" }); autoSwitch().focus();
          const rect = autoSwitch().getBoundingClientRect();
          assert.ok(document.documentElement.scrollWidth <= document.documentElement.clientWidth, `${variant} ${width}: no document overflow`);
          assert.ok(rect.width <= innerWidth && rect.left >= 0 && rect.right <= innerWidth && rect.height >= 44, `${variant} ${width}: usable complete switch`);
          assert.ok(autoSwitch().scrollWidth <= autoSwitch().clientWidth, `${variant} ${width}: complete label`);
          assert.ok(getComputedStyle(autoSwitch()).outlineWidth !== "0px", "Keyboard focus is visible");
          const painted = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          assert.ok(painted === autoSwitch() || autoSwitch().contains(painted), "Switch is not covered");
          await require("electron").ipcRenderer.invoke("wa-history:capture", variant, width);
          layoutChecks++;
        }
      }
    }
    cloud.user = null; cloud.status = "signed-out";
    await act(async () => root.unmount());
    return { emptyState: true, selectionIsEmailOnly: true, passwordClearedOnSelection: true,
      optInDefaultOff: true, submitPassesOptIn: true, cancelAndEscapeKeepMemory: true,
      confirmedRemovalOnly: true, signupAndRecoveryPreserved: true, focusEntersConfirmation: true,
      autoLoginSwitchIndependent: true, autoLoginDoesNotSignOut: true, nativeKeyboardVerified: true, layoutChecks };
  };
}
