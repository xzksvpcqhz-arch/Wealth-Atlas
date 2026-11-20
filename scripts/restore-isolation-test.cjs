/* Source-only harness. A new temporary Chromium profile, synthetic data/Vault,
 * network denied. Never load the application's desktop main process. */
const path = require("node:path");
const root = path.resolve(__dirname, "..");
if (process.type === "browser") {
  const { app, BrowserWindow, protocol } = require("electron");
  const assert = require("node:assert/strict");
  const { mkdtempSync } = require("node:fs");
  const os = require("node:os");
  const profile = mkdtempSync(path.join(os.tmpdir(), "wealth-atlas-restore-isolated-"));
  app.setPath("userData", profile); app.setPath("sessionData", profile);
  protocol.registerSchemesAsPrivileged([{ scheme: "wa-restore-test", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const checks = [];
  let realBackendRequests = 0;
  app.whenReady().then(async () => {
    protocol.handle("wa-restore-test", () => new Response("<html><body><div id='root'></div></body></html>", { headers: { "Content-Type": "text/html" } }));
    async function makeWindow() {
      const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
      win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => { realBackendRequests++; callback({ cancel: true }); });
      await win.loadURL("wa-restore-test://app/");
      await win.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).setupRenderer()`);
      return win;
    }
    const a = await makeWindow(), b = await makeWindow();
    const run = (win, code) => win.webContents.executeJavaScript(`(async()=>{ const { assert, profiles, scope, storage, iso, merge, snap, calls } = wa; ${code} })()`);
    await run(a, `assert.ok(navigator.locks); await storage.prepareAccountWorkspace(scope); await storage.saveWealthData(wa.initial, scope); await storage.saveObsidianHandle({ synthetic: true }, "synthetic-vault", scope); wa.current = await storage.loadWealthData(undefined, scope); wa.expected = iso.restoreFingerprint(wa.current);`);
    await run(b, `wa.current = await storage.loadWealthData(undefined, scope); wa.expected = iso.restoreFingerprint(wa.current);`);
    checks.push("normal save, same synthetic workspace in two independent windows");
    await run(a, `const pending=storage.saveWealthData({...wa.current},scope); profiles.publishDataProfile(profiles.makeDataProfile("locked")); await pending; await assert.rejects(storage.saveWealthData(wa.current,scope)); profiles.publishDataProfile(scope);assert.equal(iso.restoreFingerprint(await storage.loadWealthData(undefined,scope)),wa.expected);`);
    checks.push("account UI lock drains previously admitted saves in original scope but rejects new saves");
    await run(a, `const old = wa.expected; await assert.rejects(iso.withLocalRestore(scope, async()=>{throw new Error("synthetic safety backup failure");})); assert.equal(iso.restoreFingerprint(await storage.loadWealthData(undefined,scope)),old); assert.equal((await iso.loadRestoreHold(scope)).paused,false);`);
    checks.push("safety backup failure leaves snapshot and hold untouched");
    await run(a, `await assert.rejects(iso.commitRestoredSnapshot(scope,wa.expected,wa.candidate())); const locks=navigator.locks; Object.defineProperty(navigator,"locks",{value:undefined,configurable:true}); let called=false; try {await assert.rejects(iso.withLocalRestore(scope,async()=>{called=true;})); assert.equal(called,false);} finally {Object.defineProperty(navigator,"locks",{value:locks,configurable:true});}`);
    checks.push("restore refuses no barrier and unavailable Web Locks");
    await run(a, `await assert.rejects(iso.withLocalRestore(scope,()=>iso.commitRestoredSnapshot(scope,"stale",wa.candidate()))); await assert.rejects(iso.withLocalRestore(scope,()=>iso.commitRestoredSnapshot(scope,wa.expected,{...wa.candidate(),syncLogs:[]}))); assert.equal((await iso.loadRestoreHold(scope)).generation,0);`);
    checks.push("transaction rejects stale fingerprints and changed protected logs");
    await run(a, `const fail=(_key,row)=>{if(row.id===iso.restoreHoldKey(scope))throw new Error("synthetic quota failure")}; storage.db.snapshots.hook("creating",fail); try {await assert.rejects(iso.withLocalRestore(scope,()=>iso.commitRestoredSnapshot(scope,wa.expected,wa.candidate())));}finally{storage.db.snapshots.hook("creating").unsubscribe(fail);} assert.equal(iso.restoreFingerprint(await storage.loadWealthData(undefined,scope)),wa.expected); assert.equal((await iso.loadRestoreHold(scope)).paused,false);`);
    checks.push("real IndexedDB transaction rollback after snapshot put and failed hold put");
    await run(a, `wa.abortNextTransaction(); try {await assert.rejects(iso.withLocalRestore(scope,()=>iso.commitRestoredSnapshot(scope,wa.expected,wa.candidate())));}finally{wa.restoreTransaction();} assert.equal(iso.restoreFingerprint(await storage.loadWealthData(undefined,scope)),wa.expected); assert.equal((await iso.loadRestoreHold(scope)).paused,false);`);
    checks.push("transaction completion abort after both puts never reports durability or publishes a hold");
    await run(a, `await storage.db.snapshots.put({id:profiles.profileMetadataKey(scope,"synthetic-auth-preservation"),data:{synthetic:"receipt"},updatedAt:"synthetic"}); await storage.saveCloudDeletions(scope.ownerId,{version:1,tombstones:{transactions:{["a".repeat(64)]:["b".repeat(64)]}}},scope); wa.metadataBefore=await wa.metadata();`);
    // A queued old save in B pauses BEFORE entering its actual IndexedDB tx.
    await run(b, `wa.tx=storage.db.transaction; wa.dbGate=new Promise(resolve=>wa.releaseSave=resolve); storage.db.transaction=async function(...args){if(args[0]==="rw"){wa.signal("old-save-queued");await wa.dbGate;}return wa.tx.apply(this,args)}; wa.oldSave=storage.saveWealthData({...wa.current,reportCurrency:"SGD"},scope).then(()=>"unexpected",()=>"rejected");await wa.waitSignal("old-save-queued");`);
    // A real full-session lock in A must settle before B's restore safety backup.
    await run(a, `wa.cloudGate=new Promise(resolve=>wa.releaseCloud=resolve); wa.cloudWork=iso.withRestoreSideEffects(scope,async()=>{calls.cloudStarted++;wa.signal("cloud-started");await wa.cloudGate;calls.cloudSettled++;});await wa.waitSignal("cloud-started");`);
    // Use A for restore: it is independent from B's queued snapshot save.
    await run(a, `wa.restoring=iso.withLocalRestore(scope,async()=>{calls.backupStarted++; assert.equal(calls.cloudSettled,1); return iso.commitRestoredSnapshot(scope,wa.expected,wa.candidate());});`);
    await run(a, `await wa.assertLockState(1,1);`);
    assert.equal(await run(a, `return calls.backupStarted;`), 0);
    await run(a, `wa.releaseCloud(); await wa.cloudWork; wa.hold=await wa.restoring; assert.equal(wa.hold.paused,true); assert.equal(wa.hold.generation,1);`);
    checks.push("restore waits for complete in-flight cloud session before safety backup");
    await run(b, `storage.db.transaction=wa.tx; wa.releaseSave(); assert.equal(await wa.oldSave,"rejected");`);
    checks.push("queued old save from independent window rejected by durable generation in tx");
    await run(a, `assert.equal(await wa.metadata(),wa.metadataBefore); wa.current=await storage.loadWealthData(undefined,scope); assert.equal(wa.current.reportCurrency,"USD"); assert.deepEqual(wa.current.syncLogs,wa.initial.syncLogs); assert.deepEqual(wa.current.obsidian,wa.initial.obsidian);`);
    checks.push("atomic restore preserves baseline, outbox, auth-like rows, Vault handle and protected fields");
    await run(a, `const metadata=await wa.metadata(); await storage.saveWealthData(wa.current,scope); assert.equal(await wa.metadata(),metadata);`);
    checks.push("identical restored object save does not queue cloud revision or deletion journal");
    await run(a, `const before={...calls}; await assert.rejects(wa.transport.pull()); await assert.rejects(wa.transport.compareAndSet(wa.current,null)); await snap.writeObsidianSnapshot(wa.current,scope); assert.equal(calls.pulls,before.pulls); assert.equal(calls.uploads,before.uploads); assert.equal(calls.vaultWrites,before.vaultWrites);`);
    checks.push("paused transport pull/upload and automatic Vault all remain quarantined");
    await run(a, `await assert.rejects(storage.saveCloudBaseline(scope,await merge.fingerprintSnapshot(wa.current))); await assert.rejects(storage.resumeCloudSync(scope)); assert.equal(await wa.metadata(),wa.metadataBefore);`);
    checks.push("cloud metadata mutations cannot bypass durable hold");
    await run(b, `await iso.loadRestoreHold(scope); await assert.rejects(storage.saveWealthData({...wa.current,reportCurrency:"MYR"},scope));`);
    checks.push("reading peer hold never upgrades stale financial view write generation");
    // A new renderer/module instance is the reload/startup test.
    b.destroy(); const c = await makeWindow();
    await run(c, `wa.current=await storage.loadWealthData(undefined,scope); assert.equal((await iso.loadRestoreHold(scope)).paused,true); assert.equal(wa.current.reportCurrency,"USD"); await assert.rejects(wa.transport.pull()); await snap.writeObsidianSnapshot(wa.current,scope); assert.equal(calls.pulls,0); assert.equal(calls.vaultWrites,0);`);
    checks.push("reopened independent renderer loads persisted hold before any side effect");
    await run(c, `await wa.mountHook();`);
    await run(c, `assert.equal(wa.controller.status,"paused"); assert.match(wa.controller.error,/暂停/); await wa.controller.syncNow(); assert.equal(calls.pulls,0); assert.equal(calls.uploads,0); await wa.updateAccountError("synthetic account error");`);
    await run(c, `assert.equal(wa.controller.status,"error"); assert.equal(wa.controller.error,"synthetic account error"); await wa.updateAccountError(null);`);
    await run(c, `await wa.unmountHook();`);
    checks.push("actual React cloud hook is paused on startup, never syncs manually and retains account-error precedence");
    await run(a, `wa.abortNextTransaction();try{await assert.rejects(iso.resumeRestoreSideEffects(scope));}finally{wa.restoreTransaction();}assert.equal((await iso.loadRestoreHold(scope)).paused,true);`);
    checks.push("failed explicit resume transaction leaves durable quarantine intact");
    await run(a, `await iso.resumeRestoreSideEffects(scope); assert.equal((await iso.loadRestoreHold(scope)).paused,false); assert.equal(await wa.metadata(),wa.metadataBefore); await wa.transport.pull(); await wa.transport.compareAndSet(wa.current,null); await snap.writeObsidianSnapshot(wa.current,scope); assert.equal(calls.pulls,1); assert.equal(calls.uploads,1); assert.equal(calls.vaultWrites,1);`);
    checks.push("explicit resume retains journals/baseline/outbox and restores normal cloud/Vault behavior");
    // Hold the automatic Vault write until its close has run; restore must wait.
    await run(c, `await iso.loadRestoreHold(scope); wa.vaultGate=new Promise(resolve=>wa.releaseVault=resolve); wa.vaultWork=snap.writeObsidianSnapshot(wa.current,scope);await wa.waitSignal("vault-write-started");`);
    await run(a, `wa.expected=iso.restoreFingerprint(await storage.loadWealthData(undefined,scope)); wa.beforeBackup=calls.backupStarted; wa.restoring=iso.withLocalRestore(scope,async()=>{calls.backupStarted++;return iso.commitRestoredSnapshot(scope,wa.expected,{...wa.candidate(),reportCurrency:"SGD"});});`);
    await run(a, `await wa.assertLockState(1,1);`);
    assert.equal(await run(a, `return calls.backupStarted===wa.beforeBackup;`), true);
    await run(c, `wa.releaseVault(); await wa.vaultWork; assert.equal(calls.vaultCloses,1);`);
    await run(a, `await wa.restoring; wa.current=await storage.loadWealthData(undefined,scope); assert.equal(wa.current.reportCurrency,"SGD");`);
    checks.push("cross-window restore waits for full automatic Vault write and close");
    await run(c, `await assert.rejects(storage.saveWealthData({...wa.current,reportCurrency:"MYR"},scope)); wa.current=await storage.loadWealthData(undefined,scope); await storage.saveWealthData({...wa.current,reportCurrency:"MYR"},scope); assert.equal((await iso.loadRestoreHold(scope)).paused,true);`);
    checks.push("stale window refused until reload; new generation local edits work while held");
    // Ordinary peer saves can occur during safety preparation; the atomic CAS
    // must reject them rather than overwriting those edits.
    await run(a, `wa.current=await storage.loadWealthData(undefined,scope); wa.expected=iso.restoreFingerprint(wa.current); wa.commitGate=new Promise(resolve=>wa.releaseCommit=resolve); wa.restoring=iso.withLocalRestore(scope,async()=>{wa.signal("restore-before-commit");await wa.commitGate;return iso.commitRestoredSnapshot(scope,wa.expected,wa.candidate());}).then(()=>"unexpected",()=>"rejected");await wa.waitSignal("restore-before-commit");`);
    await run(c, `wa.current=await storage.loadWealthData(undefined,scope); await storage.saveWealthData({...wa.current,reportCurrency:"USD"},scope);`);
    await run(a, `wa.releaseCommit(); assert.equal(await wa.restoring,"rejected"); wa.current=await storage.loadWealthData(undefined,scope); assert.equal(wa.current.reportCurrency,"USD");`);
    checks.push("peer save between safety backup and commit invalidates atomic fingerprint CAS");
    await run(a, `const original=scope; await assert.rejects(iso.withLocalRestore(scope,async()=>{profiles.publishDataProfile(profiles.makeDataProfile("guest")); profiles.publishDataProfile(profiles.makeDataProfile("cloud","synthetic-restore"));return iso.commitRestoredSnapshot(original,iso.restoreFingerprint(wa.current),wa.candidate());})); profiles.publishDataProfile(original);`);
    checks.push("exact profile identity rejects A-B-A epoch changes");
    await run(a, `const key=iso.restoreHoldKey(scope),row=await storage.db.snapshots.get(key); await storage.db.snapshots.put({...row,hold:{...row.hold,version:999}}); await assert.rejects(iso.loadRestoreHold(scope)); await assert.rejects(wa.transport.pull()); await assert.rejects(storage.saveWealthData({...wa.current,reportCurrency:"SGD"},scope)); await storage.db.snapshots.put(row); await iso.loadRestoreHold(scope);`);
    checks.push("corrupt persisted hold fails closed for reads, cloud and snapshot saves");
    await run(a, `const data=wa.current, reversed=Object.fromEntries(Object.entries(data).reverse()); assert.equal(iso.restoreFingerprint(data),iso.restoreFingerprint(reversed)); assert.equal(storage.db.verno,2);`);
    checks.push("stable object-order fingerprint and unchanged database schema v2");
    await run(a, `wa.current=await storage.loadWealthData(undefined,scope);wa.raceExpected=iso.restoreFingerprint(wa.current);`);
    await run(c, `wa.current=await storage.loadWealthData(undefined,scope);wa.raceExpected=iso.restoreFingerprint(wa.current);`);
    await run(a,`wa.raceGate=new Promise(resolve=>wa.releaseRace=resolve);wa.raced=iso.withLocalRestore(scope,async()=>{wa.signal("race-first-entered");await wa.raceGate;return iso.commitRestoredSnapshot(scope,wa.raceExpected,{...wa.candidate(),reportCurrency:"SGD"});}).then(()=>"committed",()=>"rejected");await wa.waitSignal("race-first-entered");`);
    await run(c,`wa.raced=iso.withLocalRestore(scope,()=>iso.commitRestoredSnapshot(scope,wa.raceExpected,{...wa.candidate(),reportCurrency:"MYR"})).then(()=>"committed",()=>"rejected");`);
    await run(a,`await wa.assertLockState(1,1);wa.releaseRace();`);
    const raced=await Promise.all([run(a,`return wa.raced;`),run(c,`return wa.raced;`)]);
    assert.deepEqual(raced.sort(),["committed","rejected"]);
    checks.push("simultaneous cross-window restores serialize and only one identical-current CAS commits");
    // This intentionally adds a DIFFERENT profile's metadata. Keep it after
    // the cloud restore's byte-for-byte metadata-preservation assertions.
    await run(c, `wa.configured=false;wa.hookScope=profiles.makeDataProfile("local");profiles.publishDataProfile(wa.hookScope);await storage.db.snapshots.put({id:iso.restoreHoldKey(wa.hookScope),hold:{version:1,paused:true,generation:1,revision:1,restoredAt:new Date().toISOString()}});await wa.mountHook();`);
    await run(c, `assert.equal(wa.controller.status,"unconfigured");assert.equal(wa.controller.user,null);assert.equal((await iso.loadRestoreHold(wa.hookScope)).paused,true);await wa.unmountHook();wa.configured=true;wa.hookScope=null;profiles.publishDataProfile(scope);`);
    checks.push("local restored Vault hold does not turn an unconfigured cloud panel into a login form");
    a.destroy(); c.destroy();
    console.log(`RESTORE_ISOLATION_PASS ${JSON.stringify({checks,realBackendRequests,productionDataAccessed:false,twoIndependentWindows:true})}`);
    app.exit(0);
  }).catch(error => { console.error("RESTORE_ISOLATION_FAIL", JSON.stringify({afterCheck:checks.length,message:error.message,stack:error.stack?.split("\n").slice(1,4)})); app.exit(1); });
} else {
  exports.setupRenderer = async () => {
    const assert = require("node:assert/strict"), fs = require("node:fs"), ts = require("typescript");
    const modules = new Map();
    const calls = { cloudStarted:0,cloudSettled:0,backupStarted:0,pulls:0,uploads:0,vaultWrites:0,vaultCloses:0 };
    const vault = { async getDirectoryHandle() { return vault; }, async getFileHandle() { return vault; }, async createWritable() { return {
      async write() { calls.vaultWrites++; wa.signal("vault-write-started");if(wa.vaultGate) await wa.vaultGate; }, async close() { calls.vaultCloses++; }, async abort() {},
    }; } };
    const desktop = { getDesktopBridge:()=>null };
    const fakeTransport = { async pull() {calls.pulls++;return null;}, async compareAndSet(data) {calls.uploads++;return {data,updatedAt:"synthetic"};} };
    function load(file) {
      const full=path.resolve(root,file);
      assert.ok(full.startsWith(path.join(root,"lib")+path.sep),"Only lib source may be loaded");
      if(modules.has(full)) return modules.get(full).exports;
      const module={exports:{}}; modules.set(full,module);
      const source=fs.readFileSync(full,"utf8");
      const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
      new Function("require","module","exports",code)((id)=>{
        if(id.startsWith("@/lib/"))id="./"+id.slice("@/lib/".length);
        if(id==="./desktop")return desktop;
        if(id==="./obsidian")return {OBSIDIAN_ROOT:"SYNTHETIC",restoreVaultHandle:async()=>vault};
        if(id==="./supabase-client")return {getSupabaseClient:()=>({synthetic:true}),isCloudConfigured:()=>globalThis.wa?.configured!==false};
        if(id==="./cloud-transport")return {createSnapshotTransport:()=>fakeTransport};
        if(id==="./auth-diagnostics")return {reportAuthDiagnostic(){}};
        if(id==="./account-boundary")return {getAccountError:()=>globalThis.wa.accountError??null,getAccountRevision:()=>globalThis.wa.accountRevision??0,
          subscribeAccountBoundary:(fn)=>{globalThis.wa.accountListener=fn;return()=>{globalThis.wa.accountListener=null;}},
          getAccountUser:()=>({id:"synthetic-restore"}),isAccountBusy:()=>false,isAccountVerified:()=>true,initializeAccountBoundary:async()=>{},retryAccountVerification:async()=>{throw new Error("Unexpected auth call");}};
        if(id.startsWith("./")||id.startsWith("@/lib/"))return load(id.startsWith("@/")?id.slice(2)+".ts":path.relative(root,path.resolve(path.dirname(full),id+".ts")));
        if(id==="dexie")return require("dexie");
        if(id==="react")return require("react");
        throw new Error("Unexpected synthetic harness dependency: "+id);
      },module,module.exports);
      return module.exports;
    }
    const profiles=load("lib/data-profile.ts"),scope=profiles.makeDataProfile("cloud","synthetic-restore"); profiles.publishDataProfile(scope);
    const storage=load("lib/storage.ts"),iso=load("lib/restore-isolation.ts"),merge=load("lib/cloud-merge.ts"),snap=load("lib/snapshot-backup.ts");
    const initial={...profiles.createBlankWealthData(),obsidian:{vaultName:"synthetic-vault",status:"connected"},syncLogs:[{id:"synthetic-log",message:"retain"}]};
    const cloud=load("lib/cloud-sync.ts");
    const signals=new Map();
    function deferred(name){if(!signals.has(name)){let resolve;const promise=new Promise(done=>resolve=done);signals.set(name,{promise,resolve});}return signals.get(name);}
    globalThis.wa={assert,profiles,scope,storage,iso,merge,snap,calls,initial,transport:cloud.getCloudTransport(scope.ownerId),
      signal(name){deferred(name).resolve();},
      async waitSignal(name){let timer;try{await Promise.race([deferred(name).promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("Synthetic barrier timed out: "+name)),5000);})]);}finally{clearTimeout(timer);}},
      async assertLockState(held,pending){const name="wealth-atlas:restore-effects:"+profiles.snapshotKey(scope),state=await navigator.locks.query();assert.equal(state.held.filter(lock=>lock.name===name).length,held,"held profile locks");assert.equal(state.pending.filter(lock=>lock.name===name).length,pending,"queued profile locks");},
      candidate(){return {...structuredClone(initial),reportCurrency:"USD"};},
      async metadata(){return JSON.stringify({rows:(await storage.db.snapshots.toArray()).filter(row=>row.id!==profiles.snapshotKey(scope)&&row.id!==iso.restoreHoldKey(scope)).sort((a,b)=>a.id.localeCompare(b.id)),handles:await storage.db.obsidianHandles.toArray()});},
      bumpAccount(){wa.accountRevision=(wa.accountRevision??0)+1;wa.accountListener?.();},
      async updateAccountError(error){await require("react").act(async()=>{wa.accountError=error;wa.bumpAccount();});},
      abortNextTransaction(){
        const original=storage.db.transaction;wa.originalTransaction=original;
        storage.db.transaction=function(mode,...args){if(mode==="rw"){const callback=args.pop();args.push(async()=>{const result=await callback();require("dexie").currentTransaction.abort();return result;});}return original.call(this,mode,...args);};
      },
      restoreTransaction(){storage.db.transaction=wa.originalTransaction;},
      async mountHook(){
        const React=require("react"),{createRoot}=require("react-dom/client"),{useCloudSync}=load("lib/use-cloud-sync.ts");
        globalThis.IS_REACT_ACT_ENVIRONMENT=true;
        const activeScope=wa.hookScope??scope;
        function Harness(){const[data,setData]=React.useState(()=>profiles.tagProfileObject(structuredClone(wa.current),activeScope));wa.controller=useCloudSync(data,setData,true,activeScope);React.useEffect(()=>{void storage.saveWealthData(data,activeScope).catch(()=>{});},[data]);return null;}
        wa.reactRoot=createRoot(document.getElementById("root"));await React.act(async()=>{wa.reactRoot.render(React.createElement(Harness));});
      },
      async unmountHook(){await require("react").act(async()=>{wa.reactRoot.unmount();});},
    };
    await storage.initializeWealthStorage();
    return {isolated:true};
  };
}
