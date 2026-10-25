const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");

async function accountFlow(phase) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (value, message) => { if (!value) throw new Error(message); };
  const wait = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(100); } throw new Error("Synthetic account UI wait timed out"); };
  const button = (scope, text) => [...scope.querySelectorAll("button")].find((item) => item.textContent.trim() === text);
  const field = (text) => [...document.querySelectorAll(".modal label")].find((item) => item.textContent.startsWith(text))?.querySelector("input,select");
  const change = async (item, value) => {
    check(item, "Account field missing");
    const proto = item.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(item, value);
    item.dispatchEvent(new Event(item.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    await delay(30);
  };
  const snapshot = () => new Promise((resolve, reject) => {
    const request = indexedDB.open("wealth-atlas");
    request.onerror = () => reject(new Error("Synthetic snapshot read failed"));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("snapshots", "readonly");
      const record = tx.objectStore("snapshots").get("current");
      record.onsuccess = () => resolve(record.result?.data);
      record.onerror = () => reject(new Error("Synthetic snapshot read failed"));
      tx.oncomplete = () => db.close();
    };
  });
  const row = (name) => [...document.querySelectorAll(".account-ccy-row")].find((item) => item.querySelector("strong")?.textContent === name);
  await wait(() => [...document.querySelectorAll("button")].some((item) => item.textContent.includes("账户")));
  await wait(() => {
    if (document.querySelector(".account-ledger-toolbar")) return true;
    [...document.querySelectorAll(".sidebar button,.mobile-nav button")].find((item) => item.textContent.includes("账户"))?.click();
    return false;
  });
  await wait(async () => Array.isArray((await snapshot())?.accounts));
  const mainName = "Synthetic USD main";
  const childName = "Synthetic MYR child / 跨币种子账户长名称测试";
  if (phase === "seed") {
    const original = await snapshot();
    check(original.accounts.length === 0 && original.transactions.length === 0, "Test did not start in an empty isolated profile");
    const add = async (name, currency, amount, parentId) => {
      button(document.querySelector(".module-header"), parentId ? "新增账户" : "新增主账号").click();
      await wait(() => document.querySelector("#account-modal-title"));
      await change(field("账户名称"), name);
      await change(field("币种"), currency);
      await change(field("开户余额"), amount);
      if (parentId) await change(field("主账号"), parentId);
      button(document.querySelector(".modal"), "保存账户").click();
      await wait(() => !document.querySelector("#account-modal-title"));
      await wait(async () => (await snapshot())?.accounts.some((item) => item.name === name));
    };
    await add(mainName, "USD", "200");
    const main = (await snapshot()).accounts.find((item) => item.name === mainName);
    await add(childName, "MYR", "-1234567.89", main.id);
    await add("Synthetic SGD main", "SGD", "0");
    check(row(childName), "Cross-currency child is missing from the account list");
    const saved = await snapshot();
    const child = saved.accounts.find((item) => item.name === childName);
    const unrelated = JSON.stringify(Object.fromEntries(Object.entries(saved).filter(([key]) => key !== "accounts")));
    const summary = document.querySelector(".module-summary").textContent;
    row(childName).querySelector('button[title="编辑"]').click();
    await wait(() => document.querySelector("#account-modal-title"));
    check(field("主账号").value === main.id, "Display grouping changed the saved parent");
    button(document.querySelector(".modal"), "取消").click();
    row(childName).querySelector('button[title="移入回收站"]').click();
    await wait(() => document.querySelector("#account-archive-title"));
    button(document.querySelector(".confirm-modal"), "取消").click();
    check(row(childName), "Cancel archived the child account");
    row(childName).querySelector('button[title="移入回收站"]').click();
    await wait(() => document.querySelector("#account-archive-title"));
    button(document.querySelector(".confirm-actions"), "移入回收站").click();
    await wait(() => !row(childName));
    const recovery = [...document.querySelectorAll(".account-recovery-row")].find((item) => item.querySelector("strong")?.textContent === childName);
    check(recovery, "Archived child missing from recovery");
    button(recovery, "恢复").click();
    await wait(() => row(childName));
    await wait(async () => (await snapshot()).accounts.find((item) => item.id === child.id).status === "active");
    const after = await snapshot();
    check(after.accounts.find((item) => item.id === main.id).balance === 200, "Parent balance changed");
    check(after.accounts.find((item) => item.id === child.id).balance === -1234567.89, "Child balance changed");
    check(unrelated === JSON.stringify(Object.fromEntries(Object.entries(after).filter(([key]) => key !== "accounts"))), "Unrelated financial records changed");
    check(summary === document.querySelector(".module-summary").textContent, "Restoring the child changed totals");
  }
  const saved = await snapshot();
  check(saved.accounts.length === 3 && document.querySelectorAll(".account-ccy-row").length === 3, "Accounts disappeared or were duplicated");
  check(row(childName)?.closest(".account-ccy-col").querySelector(".account-ccy-head > span").textContent === "MYR", "Child displayed in the wrong currency column");
  check(saved.accounts.find((item) => item.name === childName).parentAccountId === saved.accounts.find((item) => item.name === mainName).id, "Hierarchy did not persist");
  return { pass: true, phase, accounts: 3, crossCurrencyVisible: true, independentBalances: true };
}

async function rendererPhase(phase) {
  const { app, BrowserWindow, protocol } = require("electron");
  const profile = process.argv.find((arg) => arg.startsWith("--profile="))?.slice(10);
  assert.ok(profile && profile.startsWith(path.join(root, "work", "account-currency-tests") + path.sep));
  require("node:fs").mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  protocol.registerSchemesAsPrivileged([{ scheme: "wealth-atlas", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  await app.whenReady();
  const version = require("../package.json").version;
  const staticRoot = path.join(root, "desktop-dist", `v${version}`, "win-unpacked", "resources", "app.asar", "out");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json" };
  protocol.handle("wealth-atlas", async (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === "/") pathname = "/index.html";
    const file = path.resolve(staticRoot, "." + pathname);
    if (!file.startsWith(staticRoot + path.sep)) return new Response("", { status: 404 });
    try { return new Response(await fs.readFile(file), { headers: { "content-type": types[path.extname(file)] || "application/octet-stream" } }); }
    catch { return new Response("", { status: 404 }); }
  });
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: true, opacity: 0, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL("wealth-atlas://app/");
  const result = await win.webContents.executeJavaScript(`(${accountFlow.toString()})(${JSON.stringify(phase)})`);
  if (phase === "seed") {
    result.layouts = [];
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [390, 844], [320, 720]]) {
      win.setContentSize(width, height);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const layout = await win.webContents.executeJavaScript(`(() => {
        const rows=[...document.querySelectorAll('.account-ccy-row')];
        const fits=rows.every(row=>{const amt=row.querySelector('.tx-row-amt').getBoundingClientRect();const actions=row.querySelector('.tx-row-actions').getBoundingClientRect();return row.querySelector('.tx-row-amt').scrollWidth<=row.querySelector('.tx-row-amt').clientWidth+1&&(amt.right<=actions.left+1||amt.bottom<=actions.top+1||actions.bottom<=amt.top+1)});
        return {width:innerWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,amountsFit:fits,rows:rows.length};
      })()`);
      assert.ok(!layout.overflow && layout.amountsFit && layout.rows === 3, JSON.stringify(layout));
      result.layouts.push(layout);
      await win.webContents.executeJavaScript("document.querySelector('.account-currency-grid').scrollIntoView({block:'start'})");
      await fs.writeFile(path.join(profile, `accounts-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    result.keyboard = [];
    for (const key of ["Enter", "Space"]) {
      await win.webContents.executeJavaScript("document.querySelector('.account-ccy-row button[title=编辑]').focus()");
      win.focus(); win.webContents.focus();
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
      win.webContents.sendInputEvent({ type: "char", keyCode: key === "Enter" ? "\r" : " " });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(await win.webContents.executeJavaScript("!!document.querySelector('#account-modal-title')"), "Keyboard edit failed");
      result.keyboard.push(key);
      await win.webContents.executeJavaScript("document.querySelector('.modal-header button').click()");
    }
  }
  console.log(JSON.stringify(result));
  win.destroy(); app.quit();
}

async function run() {
  if (process.versions.electron) return rendererPhase(process.argv.includes("--verify") ? "verify" : "seed");
  const profile = path.join(root, "work", "account-currency-tests", randomUUID());
  for (const phase of ["seed", "verify"]) await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, "node_modules", "electron", "dist", "electron.exe"), [__filename, `--${phase}`, `--profile=${profile}`, "--disable-gpu", "--in-process-gpu"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Isolated account test timed out")); }, 60000);
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timeout); process.stdout.write(output); code === 0 && output.includes('"pass":true') ? resolve() : reject(new Error(`Account UI phase failed: ${phase}`)); });
  });
  console.log(`Synthetic account screenshots: ${profile}`);
}
run().catch((error) => { console.error(error.message); if (process.versions.electron) require("electron").app.exit(1); else process.exitCode = 1; });
