/* New synthetic temporary profile only. Real Chromium Storage + sandboxed
 * preload + source IPC/lifecycle snippets, not real login or packaged acceptance. */
const { app, BrowserWindow, ipcMain, protocol } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const assert = require("node:assert/strict");
const { enableCandidateDiagnostics, recordCandidateDiagnostic } = require("../../desktop/candidate-diagnostics.cjs");
const ROOT = path.resolve(__dirname, "../..");
const profileArg = process.argv.find(arg => arg.startsWith("--auth-trace-qa-root="));
const mode = process.argv.includes("--reopen") ? "reopen" : "seed";
const profile = path.resolve(profileArg?.slice("--auth-trace-qa-root=".length) ?? ".");
assert.equal(path.dirname(profile).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
assert.match(path.basename(profile), /^wealth-atlas-auth-trace-qa-[A-Za-z0-9]{6}$/);
assert.equal(fs.lstatSync(profile).isDirectory(), true);
assert.equal(fs.lstatSync(profile).isSymbolicLink(), false);
assert.equal(fs.readFileSync(path.join(profile, "synthetic-qa-only.txt"), "utf8"), "WEALTH_ATLAS_SYNTHETIC_AUTH_TRACE_ONLY");
const version = "1.7.5-rc.11"; // Synthetic bridge metadata, not an installed-version assertion.
app.setPath("userData", profile); app.setPath("sessionData", profile);
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: "wa-auth-trace-test", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
enableCandidateDiagnostics(version, path.join(profile, "synthetic-native.exe"), "isolated-qa");
const main = fs.readFileSync(path.join(ROOT, "desktop/main.cjs"), "utf8");
const quitLines = main.split(/\r?\n/).filter(line => /^app\.on\("(?:before-quit|will-quit|window-all-closed)"/.test(line));
assert.equal(quitLines.length, 3);
vm.runInNewContext(quitLines.join("\n"), { app, recordCandidateDiagnostic });
ipcMain.on("desktop:get-app-version", event => { event.returnValue = version; });
const ipcStart = main.indexOf('  ipcMain.handle("diagnostics:renderer",');
const ipcEnd = main.indexOf('  handlePrivate("vault:get-connection",', ipcStart);
assert.ok(ipcStart > 0 && ipcEnd > ipcStart);
let received = 0, blockedExternalRequests = 0;
const codes = require("../../desktop/auth-diagnostic-codes.json");
vm.runInNewContext(main.slice(ipcStart, ipcEnd), { ipcMain, recordCandidateDiagnostic,
  assertTrustedSender(event) { assert.equal(event.senderFrame.url, "wa-auth-trace-test://app/"); },
  normalizeSafeDiagnostic(payload) {
    assert.equal(payload.source, "auth-recovery"); assert.equal(Object.hasOwn(codes, payload.message), true);
    return {}; // Never write arbitrary diagnostic payloads.
  },
  async writeDiagnosticLog() { received++; return true; },
});
const compile = file => ts.transpileModule(fs.readFileSync(path.join(ROOT, file), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const compiled = Object.fromEntries(["lib/auth-storage.ts", "lib/auth-diagnostics.ts", "lib/diagnostics.ts"].map(file => [file, compile(file)]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  protocol.handle("wa-auth-trace-test", () => new Response("<!doctype html><html><body>Isolated technical test</body></html>", { headers: { "Content-Type": "text/html" } }));
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(ROOT, "desktop/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
  } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => {
    blockedExternalRequests++; callback({ cancel: true });
  });
  const closeLines = main.split(/\r?\n/).filter(line => /window\.on\("(?:close|closed)".*recordCandidateDiagnostic/.test(line));
  assert.equal(closeLines.length, 2);
  vm.runInNewContext(closeLines.join("\n"), { window, recordCandidateDiagnostic });
  await window.loadURL("wa-auth-trace-test://app/");
  const result = await window.webContents.executeJavaScript(`(() => {
    const compiled=${JSON.stringify(compiled)},codes=${JSON.stringify(codes)};
    const load=(file,deps)=>{const m={exports:{}};new Function('require','module','exports',compiled[file])(
      name=>{if(!Object.hasOwn(deps,name))throw new Error('SYNTH_IMPORT_FORBIDDEN');return deps[name];},m,m.exports);return m.exports;};
    const diagnostic=load('lib/diagnostics.ts',{'./desktop':{getDesktopBridge:()=>window.wealthAtlasDesktop},'./migrations':{CURRENT_SCHEMA_VERSION:10}});
    const reporting=load('lib/auth-diagnostics.ts',{'./diagnostics':diagnostic,'../desktop/auth-diagnostic-codes.json':codes});
    const storage=load('lib/auth-storage.ts',{}),counts={reads:0,writes:0,removes:0};
    const raw={getItem(k){counts.reads++;return localStorage.getItem(k);},setItem(k,v){counts.writes++;localStorage.setItem(k,v);},removeItem(k){counts.removes++;localStorage.removeItem(k);}};
    const adapter=storage.createAuthStorage(raw,reporting.reportAuthDiagnostic,reporting.reportAuthStorageActivity);
    const key='sb-synthetic-native-auth-token',value='SYNTHETIC_AUTH_TRACE_VALUE_ONLY';
    if(${JSON.stringify(mode)}==='seed'){
      if(adapter.getItem(key)!==null)throw new Error('SYNTH_PROFILE_NOT_EMPTY');
      adapter.setItem(key,value);if(adapter.getItem(key)!==value)throw new Error('SYNTH_WRITE_NOT_VISIBLE');
      adapter.removeItem(key);adapter.setItem(key,value);
      return {pass:counts.reads===5&&counts.writes===2&&counts.removes===1,mode:'seed',...counts};
    }
    return {pass:adapter.getItem(key)===value&&counts.reads===1&&counts.writes===0&&counts.removes===0,mode:'reopen',...counts};
  })()`);
  assert.equal(result.pass, true);
  const expected = mode === "seed" ? 5 : 1;
  for (let i = 0; i < 100 && received < expected; i++) await delay(10);
  assert.equal(received, expected); assert.equal(blockedExternalRequests, 0);
  const trace = JSON.parse(fs.readFileSync(path.join(profile, "candidate-qa-auth-trace.json"), "utf8"));
  const technical = JSON.parse(fs.readFileSync(path.join(profile, "candidate-qa-startup-diagnostic.json"), "utf8"));
  assert.equal(trace.boots.at(-1).bootId, technical.bootId);
  const events = trace.boots.at(-1).events.map(event => event.code);
  assert.ok(events.includes(mode === "seed" ? "AUTH_STORAGE_FIRST_READ_EMPTY" : "AUTH_STORAGE_FIRST_READ_PRESENT"));
  if (mode === "seed") assert.deepEqual(events.filter(code => code.startsWith("AUTH_STORAGE_")), [
    "AUTH_STORAGE_FIRST_READ_EMPTY", "AUTH_STORAGE_WRITE_CONFIRMED", "AUTH_STORAGE_REMOVE_REQUESTED", "AUTH_STORAGE_REMOVE_CONFIRMED", "AUTH_STORAGE_WRITE_CONFIRMED",
  ]);
  else {
    assert.equal(trace.boots.length, 2);
    const previous = trace.boots[0].events.map(event => event.code);
    for (const code of ["CANDIDATE_WINDOW_CLOSE_REQUESTED", "CANDIDATE_WINDOW_CLOSED", "CANDIDATE_APP_BEFORE_QUIT", "CANDIDATE_APP_WILL_QUIT"]) assert.ok(previous.includes(code));
  }
  console.log("AUTH_TRACE_NATIVE_RESULT " + JSON.stringify({ ...result, messages: received, blockedExternalRequests,
    realProfileAccessed: false, realNetworkUsed: false, financialDatabaseOpened: false, packagedReleaseVerified: false }));
  window.close(); // Real normal close + quit; no forced kill, explicit flush, auth login or cleanup.
}).catch(() => {
  console.log('AUTH_TRACE_NATIVE_RESULT {"pass":false,"failureCode":"SYNTH_NATIVE_TRACE_FAILED"}'); app.exit(1);
});
