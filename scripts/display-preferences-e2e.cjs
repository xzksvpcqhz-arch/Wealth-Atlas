// Production exported UI, fresh synthetic profile, loopback only. No credentials.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const origin = process.argv[2];
if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(origin || '')) throw new Error('Loopback origin required');
const qaRoot = path.resolve(__dirname, '../work/display-integration-qa', randomUUID());
fs.mkdirSync(qaRoot, { recursive: true }); app.setPath('userData', path.join(qaRoot, 'profile')); app.setPath('sessionData', path.join(qaRoot, 'session'));
const results = []; let win, last = '', errors = 0;
const js = code => { last = code; return win.webContents.executeJavaScript(code); };
const check = (name, value) => { assert.ok(value, name); results.push(name); };
const tick = () => new Promise(resolve=>setTimeout(resolve,80));
// Hidden Electron may return the previous compositor frame on its first
// capture. Request a paint, then save the subsequent frame as visual evidence.
const capture = async name => { await win.webContents.capturePage();await new Promise(resolve=>setTimeout(resolve,160));fs.writeFileSync(path.join(qaRoot,name),(await win.webContents.capturePage()).toPNG()); };
const wait = async code => { for (let i = 0; i < 150; i++) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error(`UI condition timed out: ${code.slice(0,100)}`); };
const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
const named = (label, exact = true) => js(`Array.from(document.querySelectorAll('button')).find(button=>button.getClientRects().length && ${exact ? 'button.textContent.trim()===' : 'button.textContent.includes('}${JSON.stringify(label)}${exact ? '' : ')'}).click()`);
// Hidden Chromium cannot receive OS focus reliably. Exercise React's input and
// focusout paths explicitly; native fill/Tab is checked separately with CUA.
const input = async (label, value) => { await js(`(() => {const input=Array.from(document.querySelectorAll('input')).find(node=>node.getAttribute('aria-label')===${JSON.stringify(label)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(value))});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await tick();await js(`document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]' ).dispatchEvent(new FocusEvent('focusout',{bubbles:true}))`);await tick(); };
const select = async(label,value)=>{await js(`(()=>{const select=Array.from(document.querySelectorAll('select')).find(node=>node.closest('label')?.textContent.startsWith(${JSON.stringify(label)}));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(value)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await tick();};
const snapshot = () => js(`new Promise((resolve,reject)=>{const request=indexedDB.open('wealth-atlas');request.onerror=()=>reject(new Error('Synthetic snapshot unavailable'));request.onsuccess=()=>{const db=request.result;const tx=db.transaction('snapshots','readonly');const get=tx.objectStore('snapshots').get('current');get.onsuccess=()=>{const data=JSON.stringify(get.result?.data??null);db.close();resolve(data);};get.onerror=()=>reject(new Error('Synthetic snapshot unavailable'));};})`);
for(const flag of ['disable-renderer-backgrounding','disable-background-timer-throttling','disable-backgrounding-occluded-windows'])app.commandLine.appendSwitch(flag);
const watchdog=setTimeout(()=>{console.error(JSON.stringify({status:'FAIL',check:'Isolated UI watchdog expired',lastPassed:results.at(-1),qaRoot}));app.exit(1);},120_000);
app.once('will-quit',()=>clearTimeout(watchdog));
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin) }));
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors++; });
  await win.loadURL(origin); await wait('document.querySelectorAll(".home-layout-item").length===9'); await tick();
  const financeBefore = await snapshot();
  // Simulate just the reduced-motion media notification, never OS settings.
  await js(`(()=>{const native=window.matchMedia.bind(window),media=new EventTarget();let reduced=false;Object.defineProperty(media,'matches',{get:()=>reduced});window.matchMedia=query=>query==='(prefers-reduced-motion: reduce)'?media:native(query);window.__toggleDisplayReduced=value=>{reduced=value;media.dispatchEvent(new Event('change'));};})()`);
  check('approved default home remains the original nine grid cards', await js('document.querySelectorAll(".home-layout-item").length===9 && !!document.querySelector(".zodiac-side")'));
  await capture('baseline-1440.png');
  await click('.settings-button'); await wait('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.includes("自定义首页")&&!b.disabled)');
  check('real Settings owns the DIY entry', await js('!!document.querySelector("[aria-label=显示与排版设置]")'));
  await click('[data-sidebar-visibility=budget]'); await tick();
  check('hide sidebar affects the actual navigation only', await js('!Array.from(document.querySelectorAll(".sidebar nav button")).some(b=>b.textContent==="预算管理") && !!document.querySelector(".settings-button")'));
  await named('取消修改并重新读取'); await tick();
  check('cancel restores the actual navigation', await js('Array.from(document.querySelectorAll(".sidebar nav button")).some(b=>b.textContent==="预算管理")'));
  await click('[data-sidebar-visibility=budget]'); await named('保存显示设置'); await tick();
  check('save discloses local display-only persistence', await js('document.body.textContent.includes("显示设置已保存在本机当前工作区")'));
  await named('自定义首页'); await wait('!!document.querySelector("[aria-label=首页自定义排版编辑器]")');
  await js(`(()=>{const original=Element.prototype.animate;window.__displayAnimations=[];Element.prototype.animate=function(...args){window.__displayAnimations.push(this.closest('[data-home-module]')?.dataset.homeModule);return original.apply(this,args);};})()`);
  check('editor renders thirteen real modules', await js('document.querySelectorAll("[data-home-module]").length===13'));
  check('financial actions are inert inside editing mode', await js('Array.from(document.querySelectorAll("[data-home-module] .quick-toolbar-button")).every(b=>!!b.closest("[inert]"))'));
  await input('手动输入标题字号（px）', 24); await tick();
  await select('模块动画','fade'); await select('首页入场方式','stagger'); await named('播放整组模块'); await tick();
  await js('window.__displayAnimations=[]'); await named('播放选中模块动效'); await tick();
  check('single-module playback never replays sibling cards',await js('window.__displayAnimations.length===1 && window.__displayAnimations[0]==="free"'));
  await select('金额字重','400'); await select('说明／列表字重','700');
  check('amount and description weights change independently of the title',await js('getComputedStyle(document.querySelector("[data-home-module=free] .hero-number")).fontWeight==="400" && getComputedStyle(document.querySelector("[data-home-module=free] .zodiac-calc")).fontWeight==="700" && getComputedStyle(document.querySelector("[data-home-module=free] .panel-kicker")).fontWeight==="600"'));
  for(const motion of ['up','down','left','right','spring','zoom']){await select('模块动画',motion);await js('window.__displayAnimations=[]');await named('播放选中模块动效');await tick();check(`${motion} preset is executable and scoped to the selected module`,await js('window.__displayAnimations.length===1 && window.__displayAnimations[0]==="free"'));}
  await select('模块动画','reveal');
  const expandedBefore=await js('document.querySelector("[data-home-module=free] [aria-expanded]").getAttribute("aria-expanded")');await named('播放选中模块动效');await tick();
  check('reveal toggles explanatory text without hiding the financial read model',await js(`!!document.querySelector('[data-home-module=free] .hero-number') && document.querySelector('[data-home-module=free] [aria-expanded]').getAttribute('aria-expanded')!==${JSON.stringify(expandedBefore)}`));
  await select('模块动画','fade');
  await js('window.__toggleDisplayReduced(true)');await tick();await js('window.__displayAnimations=[]');await named('播放选中模块动效');await tick();
  check('simulated reduced-motion skips spatial playback without hiding content',await js('window.__displayAnimations.length===0 && getComputedStyle(document.querySelector("[data-home-module=free] .hero-number")).display!=="none"'));
  await js('window.__toggleDisplayReduced(false)');await tick();
  const resizeButton = '[data-home-module=free] button[aria-label^="调整"]';
  const sizeBefore = await js('document.querySelector("[data-home-module=free]").firstElementChild.style.minHeight');
  await js(`(()=>{const button=document.querySelector(${JSON.stringify(resizeButton)});button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));})()`);await tick();
  check('keyboard resize changes the actual module height',await js('document.querySelector("[data-home-module=free]").firstElementChild.style.minHeight')!==sizeBefore);
  const heightBeforePointer=await js('document.querySelector("[data-home-module=free]").firstElementChild.style.minHeight');
  await js(`(()=>{const button=document.querySelector(${JSON.stringify(resizeButton)});button.__capture=null;button.setPointerCapture=id=>{button.__capture=id;};button.hasPointerCapture=id=>button.__capture===id;button.releasePointerCapture=()=>{button.__capture=null;};button.dispatchEvent(new PointerEvent('pointerdown',{pointerId:21,isPrimary:true,button:0,clientX:100,clientY:100,bubbles:true}));window.dispatchEvent(new PointerEvent('pointermove',{pointerId:21,clientX:160,clientY:130,bubbles:true}));})()`);await tick();
  const transientHeight=await js('document.querySelector("[data-home-module=free]").firstElementChild.style.minHeight');
  await js('window.dispatchEvent(new Event("blur"))');await tick();
  const cancelledGeometry=await js(`({capture:document.querySelector(${JSON.stringify(resizeButton)}).__capture,height:document.querySelector('[data-home-module=free]').firstElementChild.style.minHeight})`);
  check(`interrupted pointer resize clears capture and discards transient geometry (${heightBeforePointer}/${transientHeight}/${cancelledGeometry.height}/${cancelledGeometry.capture})`,cancelledGeometry.capture===null && cancelledGeometry.height===heightBeforePointer);
  await js(`(()=>{const button=document.querySelector(${JSON.stringify(resizeButton)});button.dispatchEvent(new PointerEvent('pointerdown',{pointerId:22,isPrimary:true,button:0,clientX:100,clientY:100,bubbles:true}));window.dispatchEvent(new PointerEvent('pointermove',{pointerId:23,clientX:400,clientY:400,bubbles:true}));window.dispatchEvent(new PointerEvent('pointerup',{pointerId:22,clientX:100,clientY:116,bubbles:true}));})()`);await tick();
  check('resize works after cancellation and ignores a second pointer',await js(`document.querySelector(${JSON.stringify(resizeButton)}).__capture===null && document.querySelector('[data-home-module=free]').firstElementChild.style.minHeight!==${JSON.stringify(sizeBefore)}`));
  check('manual px changes actual module typography', await js('getComputedStyle(document.querySelector("[data-home-module=free] .panel-kicker")).fontSize==="24px"'));
  await input('手动输入标题字号（px）', 99); await tick();
  check('invalid px cannot save or mutate the last valid value', await js('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="保存排版").disabled && getComputedStyle(document.querySelector("[data-home-module=free] .panel-kicker")).fontSize==="24px"'));
  await input('手动输入标题字号（px）', 24); await tick();
  await click('[data-module-visibility=watchlist]'); await tick();
  check('hidden module has a real add-back entry', await js('!document.querySelector("[data-home-module=watchlist]") && document.querySelector("[data-module-visibility=watchlist]").textContent==="加回首页"'));
  await click('[data-module-visibility=watchlist]'); await tick();
  check('add-back never duplicates a module', await js('document.querySelectorAll("[data-home-module=watchlist]").length===1'));
  await named('保存排版'); await wait('!!document.querySelector(".settings-button")'); await named('首页'); await wait('document.querySelectorAll("[data-home-module]").length===13');
  check('saved custom homepage uses real read models with live actions', await js('document.querySelectorAll("[data-home-module]").length===13 && !document.querySelector("[data-home-module=quick] [inert]") && !document.querySelector(".home-layout-item")'));
  check('display edits did not change the persisted financial snapshot', await snapshot() === financeBefore);
  const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.reload(); await reloaded; await wait('document.querySelectorAll("[data-home-module]").length===13');
  check('real app refresh preserves saved layout and sidebar visibility', await js('getComputedStyle(document.querySelector("[data-home-module=free] .panel-kicker")).fontSize==="24px" && !Array.from(document.querySelectorAll(".sidebar nav button")).some(b=>b.textContent==="预算管理")'));
  await click('[aria-label="记一笔收支"]'); await wait('!!document.querySelector(".modal-overlay,.modal-backdrop,[role=dialog]")');
  check('existing transaction form still opens from customized home', await js('!!document.querySelector(".modal-overlay,.modal-backdrop,[role=dialog]")'));
  await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'); await tick();
  // No form is submitted; reload only this synthetic origin if the original modal
  // does not implement Escape. No user finance or browser storage is reset.
  if (await js('!!document.querySelector(".modal-overlay,.modal-backdrop,[role=dialog]")')) { const closed = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.reload(); await closed; await wait('document.querySelectorAll("[data-home-module]").length===13'); }
  for (const [width, height] of [[1440,900],[1280,800],[1024,800],[390,844],[320,720]]) {
    win.setContentSize(width,height); await tick();
    await click('.settings-button'); await tick();
    await named('自定义首页'); await tick();
    const layout = await js('({width:innerWidth,page:document.documentElement.scrollWidth,dark:getComputedStyle(document.documentElement).backgroundColor})');
    check(`${width}px editor has no horizontal overflow`,layout.page<=layout.width);
    await capture(`editor-${width}.png`);
    if (width <= 390) { await named('属性');await tick();await capture(`properties-${width}.png`); }
    await named('取消修改'); await wait('!!document.querySelector(".settings-button")');
    check(`${width}px settings has no horizontal overflow`,await js('document.documentElement.scrollWidth<=innerWidth'));
    await capture(`settings-${width}.png`);
  }
  check('financial snapshot remains unchanged after responsive and modal checks',await snapshot()===financeBefore);
  check('no client-side exception or renderer error',errors===0 && await js('!document.body.textContent.includes("Application error")'));
  fs.writeFileSync(path.join(qaRoot,'result.json'),JSON.stringify({status:'PASS',syntheticOnly:true,cloudTested:false,checks:results,errors},null,2));
  console.log(JSON.stringify({status:'PASS',checks:results.length,qaRoot,syntheticOnly:true,cloudTested:false}));app.exit(0);
}).catch(async error => { const numeric = await js('({value:document.querySelector("input[type=number]")?.value,font:document.querySelector("[data-home-module=free] .panel-kicker")?getComputedStyle(document.querySelector("[data-home-module=free] .panel-kicker")).fontSize:null,ready:document.readyState,buttons:document.querySelectorAll("button").length})').catch(()=>null); if(win&&!win.isDestroyed())fs.writeFileSync(path.join(qaRoot,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(JSON.stringify({status:'FAIL',check:error.message,lastPassed:results.at(-1),numeric,qaRoot,errors}));app.exit(1); });
