'use strict';
// Real Chromium IndexedDB; only a parent-created disposable synthetic profile.
const path=require('node:path');
if(process.type==='browser'){
 const {app,BrowserWindow,protocol}=require('electron'),assert=require('node:assert/strict');
 const profile=process.argv.find(x=>x.startsWith('--qa-profile='))?.slice(13);
 if(!profile||!path.basename(profile).startsWith('wa-investment-local-qa-'))throw Error('Synthetic profile required');
 require('node:fs').mkdirSync(profile,{recursive:true});
 app.setPath('userData',profile);app.setPath('sessionData',profile);
 // Keep the synthetic main process alive while the last renderer is reopened.
 app.on('window-all-closed',()=>{});
 protocol.registerSchemesAsPrivileged([{scheme:'wa-restore-test',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
 const checks=[];let network=0,protocolLoads=0;
 app.whenReady().then(async()=>{
  protocol.handle('wa-restore-test',()=>{protocolLoads++;return new Response('<html><body><div id="root"></div></body></html>',{headers:{'Content-Type':'text/html'}});});
  async function makeWindow(){const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});w.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>{network++;cb({cancel:true});});await w.loadURL('wa-restore-test://app/');await w.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).setup()`);return w;}
  const run=(w,code)=>w.webContents.executeJavaScript(`(async()=>{const {api,assert,snapshot,batch}=qa;${code}})()`);
  const a=await makeWindow();
  if(process.argv.includes('--verify-restart')){
   await run(a,"assert.equal((await api.read()).revision,10);assert.equal((await api.status()).selected,true);assert.equal(await qa.financial(),qa.sentinel);assert.equal((await qa.versions()).length,10);");
   checks.push('new Electron process retains account space, all ten version bodies, selected location and unchanged financial sentinel');
   await run(a,"const before=JSON.stringify(await api.read()),upgraded=await qa.upgrade();await assert.rejects(api.read());assert.equal(JSON.stringify(await qa.stateFrom(upgraded)),before);upgraded.close();");
   checks.push('synthetic versionchange closes the original connection; unsupported database version is refused without rewriting stored data');
  }else{
   const b=await makeWindow();
   await run(a,"await qa.seedFinancial();assert.equal((await api.status()).enabled,false);await assert.rejects(api.read());");
   await Promise.all([run(a,'await api.enable();'),run(b,'await api.enable();')]);
   await run(a,"assert.equal((await api.read()).revision,0);assert.equal((await qa.rows()).length,1);");
   checks.push('fresh profile, explicit enable and concurrent duplicate enable produce one empty owner space');
   const race=await Promise.all([run(a,"return qa.trySave({kind:'snapshot',data:snapshot('2026-10-01',0),expectedRevision:0});"),run(b,"return qa.trySave({kind:'snapshot',data:snapshot('2026-10-01',100),expectedRevision:0});")]);
   assert.equal(race.filter(x=>x.ok).length,1);assert.equal(race.filter(x=>x.status===409).length,1);
   checks.push('two independent renderer windows cannot overwrite the same revision');
   await run(a,`await api.save({kind:'snapshot',data:snapshot('2026-11-01',250),expectedRevision:1});
    const trade={kind:'trades',data:batch(100),expectedRevision:2};await api.save(trade);
    const duplicate=await api.save({...trade,expectedRevision:3});assert.equal(duplicate.unchanged,true);assert.equal(duplicate.duplicates,1);
    await assert.rejects(api.save({kind:'trades',data:batch(101),expectedRevision:3}));
    for(const [kind,data] of Object.entries(qa.management)){const state=await api.read();await api.save({kind,data,eventId:qa.eventId,expectedRevision:state.revision});}
    assert.equal((await api.read()).revision,9);
    await api.save({kind:'event',data:{...qa.management.event,note:'SYNTHETIC revision two'},eventId:qa.eventId,expectedRevision:9});
    assert.equal((await api.read()).revision,10);assert.equal((await qa.versions()).filter(x=>x.record.kind==='event').length,2);
    const before=JSON.stringify(await api.read());await assert.rejects(api.save({kind:'snapshot',data:{...snapshot('2026-12-01',0),reportCurrency:'USD'},expectedRevision:10}));assert.equal(JSON.stringify(await api.read()),before);`);
   checks.push('all eight saved record kinds use existing validators; duplicate trades, changed trade IDs, event identity, full history and same-currency FX guard');
   await run(a,`await api.select(false);assert.equal((await api.status()).selected,false);await api.select(true);
    const before=JSON.stringify(await api.read()),original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,...args){if(this.name==='spaces')throw new DOMException('SYNTHETIC quota','QuotaExceededError');return original.call(this,value,...args);};
    try{await assert.rejects(api.save({kind:'snapshot',data:snapshot('2026-12-01',50),expectedRevision:10}));}finally{IDBObjectStore.prototype.put=original;}
    assert.equal(JSON.stringify(await api.read()),before);assert.equal((await qa.versions()).length,10);`);
   checks.push('quota failure after immutable version add rolls back the complete transaction; original state/history and selected location remain');
   await run(a,`const original=(await qa.rows()).find(row=>row.owner===qa.active.ownerId);await qa.mutate(row=>{const copy=structuredClone(row),key=Object.keys(copy.state.records)[0];copy.state.records[key].data.cash=123;return copy;});const corrupt=JSON.stringify(await qa.rows());await assert.rejects(api.status());await assert.rejects(api.read());await assert.rejects(api.select(true));assert.equal(JSON.stringify(await qa.rows()),corrupt);await qa.mutate(()=>original);`);
   checks.push('record checksum mismatch rejects access and selection without replacing corrupt contents; fixture repaired manually only in the synthetic test');
   await run(a,`const original=(await qa.rows()).find(row=>row.owner===qa.active.ownerId);await qa.mutate(row=>{const copy=structuredClone(row);delete copy.state.records[Object.keys(copy.state.records)[0]];return copy;});const incomplete=JSON.stringify(await qa.rows());await assert.rejects(api.status());await assert.rejects(api.read());await assert.rejects(api.enable());await assert.rejects(api.select(true));await assert.rejects(api.save({kind:'policy',data:qa.management.policy,expectedRevision:10}));assert.equal(JSON.stringify(await qa.rows()),incomplete);await qa.mutate(()=>original);
    const version=(await qa.versions()).find(v=>v.revision===1);await qa.mutateVersion(1,v=>({...v,record:{...v.record,revision:2}}));assert.equal((await qa.versions()).length,10);const badVersions=JSON.stringify(await qa.versions());await assert.rejects(api.status());await assert.rejects(api.read());await assert.rejects(api.select(true));await assert.rejects(api.enable());await assert.rejects(api.save({kind:'policy',data:qa.management.policy,expectedRevision:10}));assert.equal(JSON.stringify(await qa.versions()),badVersions);await qa.mutateVersion(1,()=>version);`);
   checks.push('missing latest index entry and same-count immutable version corruption reject status/read/select/enable/save without recommitting an incomplete state');
   await run(a,`const active=qa.active;qa.active={kind:'cloud',ownerId:'synthetic-B'};assert.equal((await api.status()).enabled,false);await assert.rejects(api.read());await api.enable();assert.equal((await api.read()).revision,0);qa.active=active;assert.equal((await api.read()).revision,10);
    for(const kind of ['local','guest','locked']){qa.active={kind,ownerId:null};await assert.rejects(api.enable());await assert.rejects(api.read());}qa.active=active;
    await qa.staleSave();assert.equal((await api.read()).revision,10);`);
   checks.push('owner separation, no automatic adoption, local/guest/locked rejection and stale A-to-B-to-A asynchronous save fence');
   await run(a,`qa.active={kind:'cloud',ownerId:'synthetic-corrupt'};await api.enable();await qa.mutate(row=>({...row,version:99}));const corrupt=JSON.stringify(await qa.rows());await assert.rejects(api.status());await assert.rejects(api.read());await assert.rejects(api.enable());await assert.rejects(api.select(true));assert.equal(JSON.stringify(await qa.rows()),corrupt);qa.active={kind:'cloud',ownerId:'synthetic-A'};
    for(const kind of ['missing','throw','blocked'])await assert.rejects(qa.failed(kind).status());
    assert.equal((await api.read()).revision,10);assert.equal(await qa.financial(),qa.sentinel);`);
   checks.push('unknown schema, missing IndexedDB, synchronous open failure and blocked open fail closed without replacing data or changing financial/Obsidian sentinel');
   await run(a,'api.close();');a.destroy();await run(b,'api.close();');b.destroy();
   const reopened=await makeWindow();await run(reopened,"assert.equal((await api.read()).revision,10);assert.equal((await api.status()).selected,true);assert.equal(await qa.financial(),qa.sentinel);");reopened.destroy();
   checks.push('renderer close/reopen retains saved records without a network, Vault or cloud request');
  }
  assert.equal(network,0);console.log('LOCAL_INVESTMENT_PASS '+JSON.stringify({checks,realBackendRequests:network,productionDataAccessed:false}));app.exit(0);
 }).catch(error=>{console.error('LOCAL_INVESTMENT_FAIL '+JSON.stringify({protocolLoads,network,completedChecks:checks.length})+' '+error.stack);app.exit(1);});
}else{
 exports.setup=()=>{
  const assert=require('node:assert/strict'),{createLocalInvestmentSpace}=require('../desktop/investment/local-space.cjs');
  const qa=globalThis.qa={assert,active:{kind:'cloud',ownerId:'synthetic-A'}};
  const options={getScope:()=>qa.active,assertScope:expected=>assert.equal(expected,qa.active)};
  qa.api=createLocalInvestmentSpace(options);
  qa.snapshot=(asOf,cash)=>({broker:'IBKR',account:'SYNTHETIC',source:'SYNTHETIC ONLY',currency:'USD',reportCurrency:'MYR',asOf,cash,fxRate:4,fxAsOf:asOf,csv:'security_id,name,quantity,price\nUS4642852044,SYNTHETIC,1,100'});
  qa.batch=amount=>({broker:'IBKR',account:'SYNTHETIC',source:'SYNTHETIC',currency:'USD',reportCurrency:'MYR',csv:'trade_id,date,type,security_id,quantity,amount,fx_rate,fx_asof\nSYNTHETIC-ID,2026-10-05,deposit,,,'+amount+',4,2026-10-05'});
  qa.eventId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  qa.management={policy:{asset:'IAU',role:'SYNTHETIC',currency:'MYR'},account:{asset:'IAU',broker:'IBKR',accountLabel:'SYNTHETIC'},event:{asset:'IAU',eventType:'dividend',status:'estimated',eventDate:'2026-11-01',currency:'USD',note:'SYNTHETIC revision one'},benchmark:{asset:'IAU',start:'2026-01-01',end:'2026-11-01',currency:'USD',portfolio:5,benchmark:4,totalReturnConfirmed:true,portfolioSource:'SYNTHETIC',benchmarkSource:'SYNTHETIC'},lookthrough:{asset:'IAU',csvA:'security_id,weight_percent\nSYNTHETIC,100',dateA:'2026-11-01',sourceA:'https://example.invalid/synthetic'},reference:{asset:'IAU',field:'fee',proposedValue:'SYNTHETIC',source:'https://example.invalid/synthetic',asOf:'2026-11-01'}};
  qa.trySave=async req=>{try{await qa.api.save(req);return {ok:true};}catch(error){return {ok:false,status:error.status};}};
  const open=(name,version,upgrade)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,version);if(upgrade)r.onupgradeneeded=()=>upgrade(r.result);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  qa.sentinel=JSON.stringify({accounts:[{id:'SYNTHETIC-UNCHANGED',balance:88}],transactions:[{id:'SYNTHETIC-HISTORY'}],obsidian:{synthetic:true},syncLogs:[{id:'SYNTHETIC-LOG'}]});
  qa.seedFinancial=async()=>{const db=await open('wealth-atlas',1,db=>db.createObjectStore('snapshots'));await new Promise((done,fail)=>{const tx=db.transaction('snapshots','readwrite');tx.objectStore('snapshots').put(qa.sentinel,'synthetic-sentinel');tx.oncomplete=done;tx.onabort=()=>fail(tx.error);});db.close();};
  qa.financial=async()=>{const db=await open('wealth-atlas',1);const value=await new Promise((done,fail)=>{const r=db.transaction('snapshots').objectStore('snapshots').get('synthetic-sentinel');r.onsuccess=()=>done(r.result);r.onerror=fail;});db.close();return value;};
  qa.rows=async()=>{const db=await open('wealth-atlas-investment-local-v1',1);const rows=await new Promise((done,fail)=>{const r=db.transaction('spaces').objectStore('spaces').getAll();r.onsuccess=()=>done(r.result);r.onerror=fail;});db.close();return rows;};
  qa.versions=async()=>{const db=await open('wealth-atlas-investment-local-v1',1);const rows=await new Promise((done,fail)=>{const r=db.transaction('versions').objectStore('versions').index('owner').getAll(qa.active.ownerId);r.onsuccess=()=>done(r.result);r.onerror=fail;});db.close();return rows;};
  qa.upgrade=()=>open('wealth-atlas-investment-local-v1',2);
  qa.stateFrom=db=>new Promise((done,fail)=>{const r=db.transaction('spaces').objectStore('spaces').get(qa.active.ownerId);r.onsuccess=()=>done(r.result.state);r.onerror=fail;});
  qa.mutate=async transform=>{const db=await open('wealth-atlas-investment-local-v1',1);await new Promise((done,fail)=>{const tx=db.transaction('spaces','readwrite'),store=tx.objectStore('spaces'),r=store.get(qa.active.ownerId);r.onsuccess=()=>store.put(transform(r.result));tx.oncomplete=done;tx.onabort=fail;});db.close();};
  qa.mutateVersion=async(revision,transform)=>{const db=await open('wealth-atlas-investment-local-v1',1);await new Promise((done,fail)=>{const tx=db.transaction('versions','readwrite'),store=tx.objectStore('versions'),r=store.get([qa.active.ownerId,revision]);r.onsuccess=()=>store.put(transform(r.result));tx.oncomplete=done;tx.onabort=fail;});db.close();};
  qa.failed=kind=>createLocalInvestmentSpace({...options,indexedDB:kind==='missing'?null:{open(){if(kind==='throw')throw Error('SYNTHETIC');const r={};queueMicrotask(()=>r.onblocked());return r;}}});
  qa.staleSave=async()=>{
   let release,started;const gate=new Promise(done=>release=done),signal=new Promise(done=>started=done);let count=0;
   const delayAt=Object.keys((await qa.api.read()).records).length+1;
   const delayed=createLocalInvestmentSpace({...options,crypto:{randomUUID:()=>crypto.randomUUID(),subtle:{digest:async(...args)=>{if(++count===delayAt){started();await gate;}return crypto.subtle.digest(...args);}}}});
   const pending=delayed.save({kind:'snapshot',data:qa.snapshot('2026-12-01',50),expectedRevision:10}).then(()=>false,()=>true);
   await signal;qa.active={kind:'cloud',ownerId:'synthetic-B'};assert.equal((await qa.api.read()).revision,0);qa.active={kind:'cloud',ownerId:'synthetic-A'};release();assert.equal(await pending,true);assert.equal((await qa.api.read()).revision,10);delayed.close();
  };
 };
}
