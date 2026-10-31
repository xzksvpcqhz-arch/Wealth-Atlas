/* Packaged-app regression. A NEW UUID profile, synthetic credentials/data and a
 * process-local deny proxy only. Never connects to hosted Supabase or opens an
 * existing profile. Auth uses the shipped SDK/default persistent storage. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(process.argv[2] ?? "");
const relative = path.relative(path.join(root, "desktop-dist", "candidates"), destination);
assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
const report = JSON.parse(await readFile(path.join(destination, "candidate-check.json"), "utf8"));
assert.match(report.version, /^\d+\.\d+\.\d+-rc\.\d+$/);
assert.equal(report.githubPublished, false);
const runLabel = process.argv[3];
if (runLabel !== undefined) assert.match(runLabel, /^[a-z0-9-]{1,48}$/, "Only a safe QA report label is accepted");
const resultPath = path.join(destination, runLabel ? `offline-cold-check-${runLabel}.json` : "offline-cold-check.json");
const qaSession = randomUUID();
const profile = path.join(process.env.APPDATA, "Wealth Atlas Sync Candidate", report.version, "isolated-qa", qaSession);
await assert.rejects(access(profile), { code: "ENOENT" });
const user = { id: "55555555-5555-4555-8555-555555555555", email: "cold-start@example.invalid",
  aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const syntheticAccount = "qa-cold-account";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
let cloudRow = null, online = true, authUserUnavailable = false, clockOffset = 0, unexpected = 0, serial = 0;
const denyProxy = net.createServer((socket) => socket.destroy());
await new Promise((resolve, reject) => { denyProxy.once("error", reject); denyProxy.listen(0, "127.0.0.1", resolve); });
const proxyPort = denyProxy.address().port;
function session() {
  const now = Math.floor((Date.now() + clockOffset) / 1000), encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return { access_token: encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ sub: user.id, exp: now + 3600,
    iat: now, session_id: "66666666-6666-4666-8666-666666666666" }) + ".synthetic-signature",
    refresh_token: "synthetic-refresh-" + ++serial, token_type: "bearer", expires_in: 3600, user };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve)); return port;
}
async function connect(port, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error("Isolated candidate exited early");
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((item) => item.type === "page" && item.url === "about:blank");
      if (target?.webSocketDebuggerUrl) {
        const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(), listeners = new Map(); let id = 0;
        await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (pending.has(message.id)) {
            const operation = pending.get(message.id); clearTimeout(operation.timer); pending.delete(message.id);
            message.error ? operation.reject(new Error("Isolated CDP command failed")) : operation.resolve(message.result);
          } else listeners.get(message.method)?.(message.params);
        });
        socket.addEventListener("close", () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Isolated CDP closed")); } pending.clear(); });
        return { socket, on(method, callback) { listeners.set(method, callback); }, send(method, params = {}) {
          return new Promise((resolve, reject) => { const requestId = ++id;
            const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Isolated CDP timeout")); }, 15000);
            pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params })); });
        } };
      }
    } catch { /* Startup only. */ }
    await delay(250);
  }
  throw new Error("Isolated cold-start page unavailable");
}
async function launch(reportedOnline = online) {
  const port = await freePort(), env = { ...process.env };
  for (const key of ["WEALTH_ATLAS_DESKTOP_SMOKE", "WEALTH_ATLAS_TEST_PROFILE", "WEALTH_ATLAS_TEST_VAULT", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  const child = spawn(path.join(destination, "windows", "win-unpacked", "Wealth Atlas Sync Candidate.exe"), [
    `--candidate-qa-session=${qaSession}`, "--candidate-qa-first-document", `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`,
    `--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=<-loopback>",
    "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
  ], { cwd: root, env, windowsHide: true, stdio: "ignore" });
  const cdp = await connect(port, child);
  cdp.on("Fetch.requestPaused", async (event) => {
    try {
      const request = event.request, url = new URL(request.url);
      const reply = (body, code = 200) => cdp.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: code,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" },
          { name: "Access-Control-Allow-Headers", value: "*" }, { name: "Access-Control-Allow-Methods", value: "GET,POST,PATCH,OPTIONS,DELETE" }],
        body: Buffer.from(code === 204 ? "" : JSON.stringify(body)).toString("base64") });
      if (!online) return void await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "InternetDisconnected" });
      if (request.method === "OPTIONS") return void await reply(null, 204);
      if (url.pathname === "/auth/v1/token") return void await reply(session());
      if (url.pathname === "/auth/v1/user" && request.method === "GET") return void await reply(authUserUnavailable
        ? { code: "unexpected_failure", msg: "Synthetic temporary verification failure" } : user, authUserUnavailable ? 503 : 200);
      if (url.pathname === "/auth/v1/logout") return void await reply(null, 204);
      if (url.pathname === "/rest/v1/user_data") {
        if (request.method === "GET") return void await reply(cloudRow ? [cloudRow] : []);
        if (["POST", "PATCH"].includes(request.method)) {
          const input = JSON.parse(request.postData);
          if (request.method === "PATCH" && url.searchParams.get("updated_at") !== `eq.${cloudRow?.updated_at}`) return void await reply([]);
          if (request.method === "POST" && cloudRow) return void await reply({ code: "23505" }, 409);
          cloudRow = { data: input.data, updated_at: new Date(Date.now() + ++serial).toISOString() };
          return void await reply([cloudRow], request.method === "POST" ? 201 : 200);
        }
      }
      unexpected++; await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
    } catch { /* Never echo request details or credentials. */ }
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] });
  await cdp.send("Page.enable");
  const documentMarker = randomUUID();
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    window.__qaColdDocument = ${JSON.stringify(documentMarker)};
    const now = Date.now.bind(Date); Date.now = () => now() + ${clockOffset};
    window.__qaNetworkOnline = ${reportedOnline};
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => window.__qaNetworkOnline === true });
    // Only this fresh synthetic QA profile: exercise the default SDK probe's
    // memory-fallback trap, plus an actual SDK-cache write failure on demand.
    // No session value is inspected, copied into another store, or printed.
    window.__qaRejectAuthWrites = false; window.__qaRejectedAuthWrites = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === window.localStorage && /^lswt-/.test(key))
        throw new DOMException("Synthetic SDK probe failure", "SecurityError");
      if (this === window.localStorage && window.__qaRejectAuthWrites && /^sb-.*-auth-token(?:$|-)/.test(key)) {
        window.__qaRejectedAuthWrites++;
        throw new DOMException("Synthetic auth persistence failure", "QuotaExceededError");
      }
      return set.call(this, key, value);
    };
  })()` });
  // This is the FIRST application document in a new process, not a warm reload.
  // The bootstrap pause is accepted only in this new isolated QA UUID profile.
  await cdp.send("Page.navigate", { url: "wealth-atlas://app/" });
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error("Synthetic page operation failed (" + (result.exceptionDetails.exception?.className ?? "unknown") + ")");
    return result.result.value;
  };
  await until(() => evaluate(`window.__qaColdDocument === ${JSON.stringify(documentMarker)} && Boolean(document.querySelector(".app-shell"))`), "fresh document");
  const currentTime = await evaluate("Date.now()");
  assert.ok(Math.abs(currentTime - Date.now() - clockOffset) < 5000, "Synthetic clock is active before auth initialization");
  return { cdp, evaluate, async close() {
    void cdp.send("Browser.close").catch(() => {});
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(8000)]);
    cdp.socket.close(); if (child.exitCode === null) child.kill();
    await delay(500);
  } };
}
async function until(action, label, limit = 160) {
  for (let attempt = 0; attempt < limit; attempt++) { try { if (await action()) return; } catch {} await delay(250); }
  throw new Error("Synthetic check timed out: " + label);
}
const readQaRows = `(${async function () {
  const database = await new Promise((resolve, reject) => { const request = indexedDB.open("wealth-atlas"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Synthetic DB unavailable")); });
  try { return await new Promise((resolve, reject) => { const request = database.transaction("snapshots").objectStore("snapshots").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error("Synthetic rows unavailable")); }); }
  finally { database.close(); }
}})()`;
// Only safe because the UUID/profile did not exist at script start and all
// network traffic is blocked/locally fulfilled. No values are printed.
const ui = `(() => { const t = document.body?.innerText ?? ""; return {
  login: /登录并同步/.test(t), connected: /登出/.test(t), offline: /上传暂停|暂时无法在线验证/.test(t),
  error: /没有匹配|无法确认账号|Application error/.test(t), qaVisible: t.includes("qa-cold-account"),
  latest: /已是最新/.test(t), version: window.wealthAtlasDesktop?.appVersion }; })()`;
const settings = `(() => { const button = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "设置"); button?.click(); return Boolean(button); })()`;
let running;
async function financialView() {
  await running.evaluate(`(() => { [...document.querySelectorAll("nav button")].find(b => b.textContent.trim() === "账户总览")?.click(); })()`);
  await until(() => running.evaluate(`(() => { const text = document.body.innerText; return text.includes("qa-cold-account") && /RM\\s*88\\.00/.test(text); })()`), "synthetic account visible with correct balance");
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844], [320, 720]]) {
    await running.cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await delay(100);
    assert.equal(await running.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth"), false, "No horizontal overflow at " + width);
  }
  await running.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await running.evaluate(settings);
}
try {
  running = await launch();
  await until(() => running.evaluate(`Boolean(document.querySelector(".app-shell"))`), "initial shell");
  await running.evaluate(settings);
  await until(() => running.evaluate(`Boolean(document.querySelector("input[type=email]"))`), "synthetic login form");
  await until(async () => (await running.evaluate(readQaRows)).some(row => row.id === "profile:v1:guest"), "durable guest before login");
  await running.evaluate(settings);
  const initialRows = await running.evaluate(readQaRows);
  const guest = initialRows.find((row) => row.id === "profile:v1:guest");
  assert.ok(guest?.data?.accounts && guest.data.transactions);
  const originalGuest = JSON.stringify(guest.data);
  const blank = structuredClone(guest.data);
  blank.accounts = [{ id: syntheticAccount, name: syntheticAccount, type: "bank", currency: "MYR", balance: 0, parentAccountId: null, status: "active", includeInNetWorth: true }];
  blank.categories.push({ id: "income:Synthetic", name: "Synthetic", kind: "income", color: "#7fc9a3", active: true },
    { id: "expense:Synthetic", name: "Synthetic", kind: "expense", color: "#d7aa6f", active: true });
  blank.transactions = [{ id: "qa-cold-in", type: "income", accountId: syntheticAccount, currency: "MYR", amount: 100, category: "Synthetic", categoryId: "income:Synthetic", date: "2026-10-27" },
    { id: "qa-cold-out", type: "expense", accountId: syntheticAccount, currency: "MYR", amount: 12, category: "Synthetic", categoryId: "expense:Synthetic", date: "2026-10-27" }];
  cloudRow = { data: blank, updated_at: new Date().toISOString() };
  await running.evaluate(`(() => { const set = (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }; set(document.querySelector("input[type=email]"), "cold-start@example.invalid"); set(document.querySelector("input[type=password]"), "synthetic-password"); })()`);
  await running.evaluate("window.__qaRejectAuthWrites = true");
  await running.evaluate(`document.querySelector(".cloud-form").requestSubmit()`);
  await until(async () => await running.evaluate("window.__qaRejectedAuthWrites > 0") || (await running.evaluate(ui)).connected, "auth-cache write rejection exercised");
  assert.ok(await running.evaluate("window.__qaRejectedAuthWrites > 0"), "A blocked SDK probe cannot silently switch the packaged app to memory-only login");
  await until(() => running.evaluate(`Boolean(document.querySelector('.cloud-form button[type="submit"]:not(:disabled)'))`), "failed login settled");
  assert.equal((await running.evaluate(ui)).connected, false, "Failed persistence must not report a successful login backed only by memory");
  assert.ok(await running.evaluate("Boolean(document.querySelector('.sync-error[role=alert]'))"), "Failed persistence must show an explicit error");
  const failedRows = await running.evaluate(readQaRows);
  assert.equal(JSON.stringify(failedRows.find(row => row.id === "profile:v1:guest")?.data), originalGuest);
  assert.ok(!failedRows.some(row => row.id === "profile:v1:cloud:" + user.id || row.id === "auth-verified:v1:" + user.id), "Failed persistence cannot activate or issue a verified receipt");
  checks.push({ name: "SDK cache write failure is explicit, never activates a memory-only login, and preserves guest data", pass: true });
  await running.evaluate("window.__qaRejectAuthWrites = false");
  await running.evaluate(settings);
  await running.evaluate(`(() => { const set = (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }; set(document.querySelector("input[type=email]"), "cold-start@example.invalid"); set(document.querySelector("input[type=password]"), "synthetic-password"); })()`);
  await running.evaluate(`document.querySelector(".cloud-form").requestSubmit()`);
  await until(async () => (await running.evaluate(ui)).connected, "online login");
  await until(async () => (await running.evaluate(ui)).latest, "online snapshot saved");
  const seededRows = await running.evaluate(readQaRows);
  const owned = seededRows.find((row) => row.id === "profile:v1:cloud:" + user.id);
  assert.equal(owned?.data.transactions.length, 2); assert.equal(owned.data.accounts.length, 1);
  assert.ok(seededRows.some((row) => row.id === "auth-verified:v1:" + user.id));
  const original = JSON.stringify(owned.data);
  await financialView();
  checks.push({ name: "online seed uses shipped SDK and real localStorage/IndexedDB", pass: true });
  await running.close(); running = null;
  online = false;
  running = await launch();
  await until(() => running.evaluate(`Boolean(document.querySelector(".app-shell"))`), "offline shell");
  await running.evaluate(settings);
  await until(async () => { const state = await running.evaluate(ui); return state.connected || state.login || state.error; }, "offline boundary");
  // Let auth reads settle: a login form is briefly visible before boundary init.
  await delay(12000); await running.evaluate(settings);
  const offline = await running.evaluate(ui);
  assert.equal(offline.connected, true, "Cold offline startup must retain the verified account, not silently open a blank guest");
  assert.equal(offline.offline, true, "Offline cloud uploads must be paused");
  assert.equal(offline.version, report.version);
  assert.ok(JSON.stringify((await running.evaluate(readQaRows)).find(row => row.id === owned.id).data) === original, "Offline original snapshot unchanged");
  await financialView();
  checks.push({ name: "separate-process offline cold start retains exact workspace", pass: true });
  online = true;
  await running.evaluate(`window.__qaNetworkOnline = true; window.dispatchEvent(new Event("online"))`);
  await until(async () => (await running.evaluate(ui)).latest, "network recovery");
  assert.ok(JSON.stringify((await running.evaluate(readQaRows)).find(row => row.id === owned.id).data) === original, "Reconnect snapshot unchanged");
  await financialView();
  checks.push({ name: "reconnect verifies and retains exact snapshot without duplication", pass: true });
  await running.close(); running = null;
  // Close again, cross the token's expiry, and start offline in a new process.
  clockOffset = 3700000; online = false;
  running = await launch();
  await until(() => running.evaluate(`Boolean(document.querySelector(".app-shell"))`), "expired-session shell");
  await running.evaluate(settings); await delay(15000); await running.evaluate(settings);
  const expired = await running.evaluate(ui);
  checks.push({ name: "expired-token offline result", connected: expired.connected, login: expired.login, error: expired.error, offline: expired.offline });
  assert.ok(JSON.stringify((await running.evaluate(readQaRows)).find(row => row.id === owned.id).data) === original, "Expired-session snapshot unchanged");
  assert.equal(expired.connected, true, "An offline reopen after token expiry must not look like financial data was erased");
  await financialView();
  online = true;
  await running.evaluate(`window.__qaNetworkOnline = true; window.dispatchEvent(new Event("online"))`);
  await until(async () => (await running.evaluate(ui)).latest, "expired-token network recovery");
  assert.ok(JSON.stringify((await running.evaluate(readQaRows)).find(row => row.id === owned.id).data) === original, "Post-expiry recovery snapshot unchanged");
  await financialView();
  checks.push({ name: "expired-token local view, four widths and online recovery", pass: true });
  await running.close(); running = null;
  clockOffset += 3700000; online = false;
  running = await launch(true); // LAN connected, but Auth/Internet unavailable.
  await running.evaluate(settings); await delay(15000); await running.evaluate(settings);
  const weakNetwork = await running.evaluate(ui);
  assert.equal(weakNetwork.connected, true, "Expired-token weak-network cold start retains the verified local workspace");
  assert.equal(weakNetwork.offline, true, "Weak-network uploads remain paused");
  assert.ok(JSON.stringify((await running.evaluate(readQaRows)).find(row => row.id === owned.id).data) === original, "Weak-network snapshot unchanged");
  await financialView();
  checks.push({ name: "expired-token weak-network cold start retains local data", pass: true });
  online = true; // Deliberately no online/focus event: bounded recovery owns this.
  await until(async () => (await running.evaluate(ui)).latest, "missed-online-event recovery");
  assert.ok(JSON.stringify((await running.evaluate(readQaRows)).find(row => row.id === owned.id).data) === original, "Missed-event recovery snapshot unchanged");
  await financialView();
  checks.push({ name: "network recovery without an online event preserves original data", pass: true });
  await running.close(); running = null;
  // Real SDK refresh succeeds, but the following getUser request cannot verify.
  // This rotates the persisted SDK tokens while the last receipt still binds
  // the old tokens. Startup must already have accepted its exact local proof.
  clockOffset += 3700000; authUserUnavailable = true;
  running = await launch(true);
  await running.evaluate(settings); await delay(15000); await running.evaluate(settings);
  const rotatingCache = await running.evaluate(ui);
  assert.equal(rotatingCache.connected, true, "Temporary re-verification failure cannot discard the already-open local grant");
  assert.equal(rotatingCache.offline, true, "A refreshed token alone must never resume uploads");
  const raceLog = await readFile(path.join(profile, "logs", "renderer.log"), "utf8");
  assert.ok(raceLog.includes('"message":"OFFLINE_CONTEXT_RETAINED"'), "The shipped SDK cache/receipt race was exercised");
  assert.ok(JSON.stringify((await running.evaluate(readQaRows)).find(row => row.id === owned.id).data) === original);
  await financialView();
  authUserUnavailable = false; // No online event, reload or personal login.
  await until(async () => (await running.evaluate(ui)).latest, "post-refresh verification recovery");
  assert.ok(JSON.stringify((await running.evaluate(readQaRows)).find(row => row.id === owned.id).data) === original);
  checks.push({ name: "real SDK token rotation plus temporary getUser failure retains local grant then recovers", pass: true });
  assert.equal(unexpected, 0, "No unhandled synthetic HTTP endpoints");
  await writeFile(resultPath, JSON.stringify({ status: "PASS", version: report.version, checks,
    isolatedProfile: true, defaultSdkStorage: true, denyProxy: true, firstApplicationDocument: true, pageReloads: 0,
    hostedRequestsSent: false, realProfileAccessed: false }, null, 2) + "\n");
  console.log("Packaged synthetic offline cold-start PASS: " + JSON.stringify(checks));
} catch (error) {
  console.error("Packaged synthetic offline cold-start FAIL: " + error.message);
  console.error("Completed synthetic checks: " + JSON.stringify(checks));
  await writeFile(resultPath, JSON.stringify({ status: "FAIL", version: report.version, checks,
    failure: error.message, hostedRequestsSent: false, realProfileAccessed: false }, null, 2) + "\n");
  process.exitCode = 1;
} finally { if (running) await running.close(); await new Promise(resolve => denyProxy.close(resolve)); }
