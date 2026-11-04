'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const ledger=require('./ledger-model.cjs'),{createStore}=require('./store.cjs'),catalog=require('./instruments.json');
const root=path.join(require('node:os').tmpdir(),'wealth-atlas-investment-synthetic-'+crypto.randomUUID());
const snapshot=(date,cash=0)=>({broker:'IBKR',account:'SYNTHETIC-ONLY',source:'SYNTHETIC STATEMENT',currency:'USD',reportCurrency:'MYR',asOf:date,fxRate:4,fxAsOf:date,cash,csv:'security_id,name,quantity,price\nUS4642852044,SYNTHETIC IAU,10,100'});
const batch=(rows)=>({broker:'IBKR',account:'SYNTHETIC-ONLY',source:'SYNTHETIC TRADES',currency:'USD',reportCurrency:'MYR',csv:'trade_id,date,type,security_id,quantity,amount,fx_rate,fx_asof\n'+rows});
test('snapshot validation preserves exact IDs and explicit zero, rejects blanks and duplicate security IDs',()=>{
 const d=ledger.validate('snapshot',snapshot('2026-10-01'));assert.equal(d.cash,0);assert.equal(d.positions[0].securityId,'US4642852044');
 assert.throws(()=>ledger.validate('snapshot',{...snapshot('2026-10-01'),cash:''}));assert.throws(()=>ledger.validate('snapshot',{...snapshot('2026-10-01'),csv:snapshot('2026-10-01').csv+'\nUS4642852044,X,1,1'}));
 assert.throws(()=>ledger.validate('trades',batch(',2026-10-05,deposit,,,100,4,2026-10-05')));
 assert.equal(ledger.validate('snapshot',{...snapshot('2026-10-01'),csv:'security_id,name,quantity,price',cash:250}).positions.length,0);
});
test('versioned native store preserves old notes, deduplicates trades and refuses same-ID changed facts',async()=>{
 await fs.mkdir(root,{recursive:true});const store=createStore({vaultRoot:root,catalog});assert.equal((await store.read()).revision,0);
 let result=await store.save({kind:'snapshot',data:snapshot('2026-10-01'),expectedRevision:0});assert.equal(result.state.revision,1);
 const old=await fs.readFile(path.join(root,result.state.history[0].note),'utf8');
 const data=batch('ID-001,2026-10-05,deposit,,,100,4,2026-10-05');result=await store.save({kind:'trades',data,expectedRevision:1});assert.equal(result.state.revision,2);
 result=await store.save({kind:'trades',data,expectedRevision:2});assert.equal(result.unchanged,true);assert.equal(result.duplicates,1);assert.equal(result.state.revision,2);
 await assert.rejects(store.save({kind:'trades',data:batch('ID-001,2026-10-05,deposit,,,101,4,2026-10-05'),expectedRevision:2}),/不同资料/);
 assert.equal(await fs.readFile(path.join(root,(await store.read()).history[0].note),'utf8'),old);
 await assert.rejects(store.save({kind:'snapshot',data:snapshot('2026-10-02'),expectedRevision:0}),e=>e.status===409);
});
test('two independent native processes cannot silently overwrite the same revision',async()=>{
 const raceRoot=root+'-race';await fs.mkdir(raceRoot,{recursive:true});
 const source=`const {createStore}=require(${JSON.stringify(path.join(__dirname,'store.cjs'))});const catalog=require(${JSON.stringify(path.join(__dirname,'instruments.json'))});createStore({vaultRoot:${JSON.stringify(raceRoot)},catalog}).save({kind:'snapshot',data:JSON.parse(process.argv[1]),expectedRevision:0}).then(x=>console.log('SAVED')).catch(e=>{console.log('STATUS:'+e.status);process.exitCode=e.status===409?0:1});`;
 const run=d=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',source,JSON.stringify(d)],{windowsHide:true});let out='';child.stdout.on('data',s=>out+=s);child.on('exit',code=>code?reject(Error(out)):resolve(out));child.on('error',reject);});
 const results=await Promise.all([run(snapshot('2026-10-01')),run(snapshot('2026-10-02'))]);assert.equal(results.filter(s=>s.includes('SAVED')).length,1);assert.equal(results.filter(s=>s.includes('STATUS:409')).length,1);assert.equal((await createStore({vaultRoot:raceRoot,catalog}).read()).revision,1);
});
test('return components reconcile exactly, preserving external contributions and flow-date FX',()=>{
 const a=ledger.validate('snapshot',snapshot('2026-10-01',0));a.fxRate=3;
 const b=ledger.validate('snapshot',snapshot('2026-11-01',200));b.positions[0].price=120;b.fxRate=4;
 const trades=ledger.validate('trades',batch('D1,2026-10-05,deposit,,,100,3.5,2026-10-05\nDIV1,2026-10-07,dividend,,,10,3.7,2026-10-07\nF1,2026-10-08,fee,,,2,3.6,2026-10-08\nBUY1,2026-10-10,buy,US4642852044,1,50,3.5,2026-10-10'));
 const state={records:{t:{kind:'trades',key:'t',data:trades}},history:[{kind:'trades',key:'t'}]};const r=ledger.breakdown(state,{data:a},{data:b});assert.ok(Math.abs(r.residual)<1e-8);assert.equal(r.external,350);assert.equal(r.dividends,37);assert.equal(r.fees,-7.2);assert.equal(r.delta,2600);
 assert.throws(()=>ledger.breakdown(state,{data:a},{data:{...b,reportCurrency:'SGD'}}));
});
test('latest holdings do not duplicate one account when report currency changes',()=>{
 const a=ledger.validate('snapshot',snapshot('2026-10-01')),b=ledger.validate('snapshot',{...snapshot('2026-11-01'),reportCurrency:'SGD',fxRate:1.3});
 assert.equal(ledger.latest({records:{a:{kind:'snapshot',revision:1,data:a},b:{kind:'snapshot',revision:2,data:b}}}).length,1);
});
test('holdings audit identifies missing trades without inventing a fill or corporate action',()=>{
 const a=ledger.validate('snapshot',snapshot('2026-10-01')),b=ledger.validate('snapshot',snapshot('2026-11-01'));b.positions[0].quantity=12;
 const trades=ledger.validate('trades',batch('B1,2026-10-03,buy,US4642852044,1,100,4,2026-10-03'));
 const state={records:{t:{kind:'trades',key:'t',data:trades}},history:[{kind:'trades',key:'t'}]};
 assert.deepEqual(ledger.reconcileHoldings(state,{data:a},{data:b}),[{securityId:'US4642852044',expected:11,actual:12,difference:1}]);
});
test('available cash reserves unspent budget after overlapping bills and safety buffer',()=>{
 const r=ledger.cashReserve({endBalance:1000,safety:100,budgets:[{key:'food',remaining:400,coveredPlanned:150},{key:'food',remaining:400,coveredPlanned:150},{key:'phone',remaining:70,coveredPlanned:70}]});assert.equal(r.budgetReserve,250);assert.equal(r.available,650);
});
test('event editing retains the event identity used by the production management UI',async()=>{
 const eventRoot=root+'-events';await fs.mkdir(eventRoot,{recursive:true});const store=createStore({vaultRoot:eventRoot,catalog}),id=crypto.randomUUID();
 const data={asset:'IAU',eventType:'other',status:'estimated',eventDate:'2026-11-03',currency:'USD',source:'https://example.com/event',note:'SYNTHETIC'};
 let r=await store.save({kind:'event',data,eventId:id,expectedRevision:0});assert.ok(r.state.records['event-'+id]);
 r=await store.save({kind:'event',data:{...data,status:'cancelled'},eventId:id,expectedRevision:1});assert.equal(Object.keys(r.state.records).length,1);assert.equal(r.state.history.length,2);assert.equal(r.state.records['event-'+id].data.paid,false);
});
test('linked Vault subdirectories cannot redirect reads or create records outside the selected Vault',async()=>{
 const vaultRoot=root+'-link-vault',outside=root+'-link-outside';
 await fs.mkdir(vaultRoot);await fs.mkdir(outside);
 await fs.symlink(outside,path.join(vaultRoot,'99_系统'),process.platform==='win32'?'junction':'dir');
 const store=createStore({vaultRoot,catalog});
 await assert.rejects(store.read(),/不能使用链接/);
 await assert.rejects(store.save({kind:'snapshot',data:snapshot('2026-10-01'),expectedRevision:0}),/不能使用链接/);
 assert.deepEqual(await fs.readdir(outside),[]);
});
test('linked note directories are rejected before creating outside directories or committing',async()=>{
 const vaultRoot=root+'-note-vault',outside=root+'-note-outside';
 await fs.mkdir(vaultRoot);await fs.mkdir(outside);
 await fs.symlink(outside,path.join(vaultRoot,'20_领域'),process.platform==='win32'?'junction':'dir');
 const store=createStore({vaultRoot,catalog});
 await assert.rejects(store.save({kind:'snapshot',data:snapshot('2026-10-01'),expectedRevision:0}),/不能使用链接/);
 assert.deepEqual(await fs.readdir(outside),[]);
 assert.equal((await store.read()).revision,0);
});
test('HTML in persisted snapshot fields is rendered as text, not as markup',async()=>{
 const {createWorkbench}=require('./workbench.cjs');
 const data=ledger.validate('snapshot',snapshot('2026-10-01'));
 const marker='<img src=x onerror=alert(1)>';
 data.asOf=marker;data.fxAsOf=marker;data.positions[0].quantity=marker;
 const host={isConnected:true,classList:{add(){}},addEventListener(){},removeEventListener(){},innerHTML:''};
 const workbench=createWorkbench({api:async()=>({version:1,revision:1,records:{a:{kind:'snapshot',revision:1,data}},history:[]})});
 workbench.mount(host);
 await new Promise(setImmediate);
 assert.ok(host.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
 assert.ok(!host.innerHTML.includes(marker));
 workbench.destroy();
});
