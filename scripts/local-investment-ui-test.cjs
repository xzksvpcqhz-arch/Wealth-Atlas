'use strict';
// Render actual production components against an isolated synthetic account/Vault.
const path=require('node:path'),root=path.resolve(__dirname,'..');
if(process.type==='browser'){
 const {app,BrowserWindow,protocol}=require('electron'),fs=require('node:fs');
 // Software offscreen frames avoid capturePage's transient compositor-surface
 // failure when the full regression suite resizes several hidden test windows.
 app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
 const profile=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'wa-investment-ui-qa-'));
 app.setPath('userData',profile);app.setPath('sessionData',profile);app.on('window-all-closed',()=>{});
 protocol.registerSchemesAsPrivileged([{scheme:'wa-invest-ui-test',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
 app.whenReady().then(async()=>{
  let network=0;
  protocol.handle('wa-invest-ui-test',request=>{
   const name=new URL(request.url).pathname;
   if(/^\/fonts\/space-grotesk-(400|500|600|700)\.ttf$/.test(name))return new Response(fs.readFileSync(path.join(root,'public',name)),{headers:{'Content-Type':'font/ttf'}});
   return new Response('<html><body><div id="root"></div></body></html>',{headers:{'Content-Type':'text/html'}});
  });
  const win=new BrowserWindow({show:false,width:1440,height:900,useContentSize:true,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false,offscreen:true}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>{network++;cb({cancel:true});});
  await win.loadURL('wa-invest-ui-test://app/');await win.webContents.executeJavaScript(`require(${JSON.stringify(__filename)}).setup()`);
  const run=code=>win.webContents.executeJavaScript(`(async()=>{const {assert,React,act}=ui;${code}})()`);
  let captureId=20;
  const captureFrame=()=>new Promise((resolve,reject)=>{
   const [width,height]=win.getContentSize();let timer;
   const shade=++captureId;
   const cleanup=()=>{clearTimeout(timer);win.webContents.removeListener('paint',paint);};
   const paint=(_event,_dirty,image)=>{
    const size=image.getSize();if(image.isEmpty()||size.width!==width||size.height!==height)return;
    // A one-pixel synthetic QA marker identifies this DOM commit, not a queued
    // pre-resize surface of the same bitmap dimensions. It never enters app code.
    const pixel=image.crop({x:0,y:0,width:1,height:1}).toBitmap();
    if(pixel.length<4||pixel[0]!==shade||pixel[1]!==shade||pixel[2]!==shade||pixel[3]!==255)return;
    cleanup();resolve(image.toPNG());
   };
   timer=setTimeout(()=>{cleanup();reject(Error(`Synthetic offscreen frame timeout: ${width}x${height}`));},5000);
   win.webContents.on('paint',paint);
   win.webContents.executeJavaScript(`(()=>{let marker=document.getElementById('synthetic-qa-frame');if(!marker){marker=document.createElement('div');marker.id='synthetic-qa-frame';marker.setAttribute('aria-hidden','true');document.body.append(marker);}marker.style.cssText='all:initial;position:fixed;left:0;top:0;width:1px;height:1px;z-index:2147483647;pointer-events:none;background:rgb(${shade},${shade},${shade})';})()`).then(()=>win.webContents.invalidate(),error=>{cleanup();reject(error);});
  });
  await run(`await ui.mount();await ui.wait(()=>document.querySelector('#investment-space-title'));await ui.wait(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='启用账号投资空间'&&!b.disabled));
   await ui.click('启用账号投资空间');assert.equal(document.querySelector('dialog').open,true);assert.equal((await qa.api.status()).enabled,false);assert.equal(ui.button('确认启用投资空间').disabled,true);await ui.click('取消');assert.equal((await qa.api.status()).enabled,false);
   await ui.setVerified(false);await ui.click('启用账号投资空间');assert.equal(document.querySelector('dialog').open,false);assert.equal((await qa.api.status()).enabled,false);await ui.setVerified(true);await ui.click('重新读取');await ui.wait(()=>ui.button('启用账号投资空间')&&!ui.button('启用账号投资空间').disabled);
   await ui.click('启用账号投资空间');await act(async()=>document.querySelector('dialog input').click());await ui.click('确认启用投资空间',true);await ui.wait(()=>document.querySelector('.workspace:not([hidden]) .ni-toolbar')?.textContent.includes('账号投资空间'));assert.equal((await qa.api.read()).revision,0);assert.equal((await qa.api.status()).selected,true);`);
  const checks=['actual React chooser confirmation/cancel, acknowledgment, repeated click guard and account adapter mount'];
  await run(`ui.native('[data-ni-tab="import"]').click();const field=ui.native('[name="account"]');field.value='SYNTHETIC UNSAVED';field.dispatchEvent(new Event('input',{bubbles:true}));await ui.click('本机 Vault');await ui.wait(()=>ui.button('打开账号投资空间')&&!ui.button('打开账号投资空间').disabled);await ui.click('打开账号投资空间');await ui.wait(()=>document.querySelector('.workspace:not([hidden]) [name="account"]'));assert.equal(ui.native('[name="account"]').value,'SYNTHETIC UNSAVED');assert.equal(document.querySelector('dialog').open,false);
   ui.native('[data-ni-tab="manage"]').click();await ui.wait(()=>ui.native('[data-tab="policy"]'));ui.native('[data-tab="policy"]').click();await ui.wait(()=>ui.native('[name="role"]'));ui.native('[name="role"]').value='SYNTHETIC UI POLICY';ui.native('[name="role"]').dispatchEvent(new Event('input',{bubbles:true}));ui.native('form[data-kind="policy"]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await ui.waitAsync(async()=>(await qa.api.read()).revision===1);await ui.wait(()=>ui.native('.fi-message').textContent.includes('已保存到本机账号空间'));assert.equal((await ui.vault.read()).revision,0);assert.equal((await qa.api.read()).history.length,1);`);
  checks.push('real investment form saves through local account adapter, correct destination copy, preserved unsaved import draft across workspace views, zero Vault writes');
  await run(`const before=ui.vaultReads;await act(async()=>{ui.root.unmount();});await ui.mount();await ui.wait(()=>document.querySelector('.workspace:not([hidden]) .ni-toolbar')?.textContent.includes('账号投资空间'));await ui.wait(()=>document.querySelector('.workspace:not([hidden]) .ni-toolbar')?.textContent.includes('版本 1'));assert.equal((await qa.api.read()).revision,1);assert.equal(ui.vaultReads,before);`);
  checks.push('component remount restores selected account workspace and actual saved record');
  await run(`const original=(await qa.rows()).find(row=>row.owner===qa.active.ownerId);await qa.mutate(row=>({...row,version:99}));const bad=JSON.stringify(await qa.rows());await act(async()=>ui.root.unmount());await ui.mount();await ui.wait(()=>ui.button('重新读取'));assert.ok(document.querySelector('h1'));assert.equal(JSON.stringify(await qa.rows()),bad);await qa.mutate(()=>original);await ui.click('重新读取');await ui.wait(()=>document.querySelector('.workspace:not([hidden]) .ni-toolbar')?.textContent.includes('账号投资空间'));`);
  checks.push('actual read-failure UI retains corrupted fixture without blank overwrite, remains operable and retries after synthetic-only manual repair');
  const sizes=[];
  for(const [width,height] of [[1440,900],[1280,800],[390,844],[320,720]]){
   win.setContentSize(width,height);await run(`await ui.wait(()=>innerWidth===${width}&&innerHeight===${height});await document.fonts.ready;window.scrollTo(0,0);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));`);
   const metrics=await run(`for(const target of document.querySelectorAll('.chooser,.chooser button,.workspace:not([hidden])')){const r=target.getBoundingClientRect();assert.ok(r.left>=0&&r.right<=innerWidth,JSON.stringify({width:innerWidth,left:r.left,right:r.right}));}return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};`);
   require('node:assert/strict').equal(metrics.overflow,false);sizes.push(metrics);
   fs.writeFileSync(path.join(profile,`actual-account-${width}.png`),await captureFrame());
  }
  await run(`ui.native('[data-ni-tab="research"]').click();assert.equal(ui.native('[data-ni-open]').textContent,'前往 Obsidian 工作台');ui.native('[data-ni-open]').click();assert.deepEqual(ui.navigations,['obsidian']);ui.native('[data-ni-tab="cashflow"]').click();assert.ok(ui.native('.ni-content').textContent.includes('账号投资记录仅保存在本机，不自动写入 Obsidian'));`);
  checks.push('research uses supported explicit Obsidian navigation; account cashflow never claims a Vault copy exists');
  for(const tab of ['research','cashflow'])for(const width of [1280,390]){
   win.setContentSize(width,844);
   await run(`await ui.wait(()=>innerWidth===${width}&&innerHeight===844);ui.native('[data-ni-tab="${tab}"]').click();const target=ui.native('${tab==='research'?'[data-ni-open]':'.ni-empty'}');assert.ok(target);await document.fonts.ready;target.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const r=target.getBoundingClientRect();assert.ok(r.top>=0&&r.bottom<=innerHeight,JSON.stringify({tab:'${tab}',width:innerWidth,height:innerHeight,top:r.top,bottom:r.bottom}));`);
   fs.writeFileSync(path.join(profile,`actual-${tab}-${width}.png`),await captureFrame());
  }
  if(network!==0)throw Error('Unexpected backend request');
  console.log('LOCAL_INVESTMENT_UI_PASS '+JSON.stringify({checks,sizes,screenshots:profile,realBackendRequests:network,productionDataAccessed:false}));app.exit(0);
 }).catch(error=>{console.error('LOCAL_INVESTMENT_UI_FAIL '+error.stack);app.exit(1);});
}else{
 exports.setup=()=>{
  require('./local-investment-space-test.cjs').setup();
  const fs=require('node:fs'),ts=require('typescript'),React=require('react'),{createRoot}=require('react-dom/client'),assert=require('node:assert/strict');
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  qa.active={kind:'cloud',ownerId:'synthetic-ui',key:'cloud:synthetic-ui',epoch:1};
  const vaultRoot=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'wa-investment-vault-synthetic-'));
  const vault=require('../desktop/investment/store.cjs').createStore({vaultRoot,catalog:require('../desktop/investment/instruments.json')});
  const modules=new Map();
  function load(name){
   if(modules.has(name))return modules.get(name).exports;
   if(!['InvestmentWorkbench','InvestmentSpaceChooser'].includes(name))throw Error('Only target component sources allowed');
   const module={exports:{}};modules.set(name,module);
   const source=fs.readFileSync(path.join(root,'components',name+'.tsx'),'utf8');
   const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
   new Function('require','module','exports',code)(id=>{
    if(id==='react'||id==='react/jsx-runtime')return require(id);
    if(id.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_t,p)=>p})};
    if(id==='./InvestmentSpaceChooser')return load('InvestmentSpaceChooser');
    if(id.startsWith('@/desktop/investment/'))return require(path.join(root,id.slice(2)));
    if(id==='@/lib/data-profile')return {getDataProfile:()=>qa.active,assertActiveDataProfile:expected=>assert.equal(expected,qa.active)};
    if(id==='@/lib/account-boundary')return {getAccountRevision:()=>ui.accountRevision,isAccountVerified:()=>ui.verified,subscribeAccountBoundary:fn=>{ui.listeners.add(fn);return()=>ui.listeners.delete(fn);}};
    if(id==='@/lib/desktop')return {getDesktopBridge:()=>({investmentRequest:async(route,request)=>{if(route==='state')ui.vaultReads++;return {ok:true,value:route==='state'?await vault.read():await vault.save(request)};}})};
    if(id==='@/lib/finance')return {convert:value=>value,getBudgetRemaining:()=>0,getCashFlowForecast:()=>({fromDate:'2026-11-01',toDate:'2026-12-01',occurrences:[],endBalance:0,safetyBalance:0,currency:'MYR',startBalance:0,projectedIncome:0,projectedExpenses:0,plannedSavings:0,plannedInvestments:0})};
    throw Error('Unexpected component dependency: '+id);
   },module,module.exports);return module.exports;
  }
  for(const file of ['app/globals.css','desktop/investment/investment-features.css','desktop/investment/native.css','components/InvestmentSpaceChooser.module.css']){const style=document.createElement('style');style.textContent=fs.readFileSync(path.join(root,file),'utf8').replace('@import "tailwindcss";','');document.head.append(style);}
  const Workbench=load('InvestmentWorkbench').default,act=React.act;
  const ui=globalThis.ui={React,act,assert,vault,vaultReads:0,navigations:[],verified:true,accountRevision:0,listeners:new Set()};
  ui.setVerified=value=>act(async()=>{ui.verified=value;ui.accountRevision++;for(const listener of ui.listeners)listener();});
  ui.mount=async()=>{ui.root=createRoot(document.getElementById('root'));await act(async()=>ui.root.render(React.createElement(Workbench,{data:{reportCurrency:'MYR',accounts:[],transactions:[],budgets:[],plannedPayments:[],subscriptions:[],investments:[],fxRates:[]},onNavigate:page=>ui.navigations.push(page)})));};
  ui.button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text&&!b.closest('[hidden]'));
  ui.click=async(text,twice=false)=>act(async()=>{const b=ui.button(text);assert.ok(b,'Required button: '+text);b.click();if(twice)b.click();});
  ui.native=selector=>document.querySelector('.workspace:not([hidden])')?.querySelector(selector);
  ui.wait=async predicate=>{const until=Date.now()+4000;while(!predicate()){if(Date.now()>until)throw Error('Synthetic UI state wait timed out');await act(()=>new Promise(r=>setTimeout(r,10)));}};
  ui.waitAsync=async predicate=>{const until=Date.now()+4000;while(!await predicate()){if(Date.now()>until)throw Error('Synthetic UI persistence wait timed out');await act(()=>new Promise(r=>setTimeout(r,10)));}};
 };
}
