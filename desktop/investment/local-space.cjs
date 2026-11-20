'use strict';
// Independent local database only. No financial snapshot, Vault or network APIs.
const model=require('./investment-model.js'),ledger=require('./ledger-model.cjs'),catalog=require('./instruments.json');
const kinds=['snapshot','trades','account','policy','event','benchmark','lookthrough','reference'];
const blank=()=>({version:1,revision:0,records:{},history:[]});
const failure=()=>Error('本机投资空间无法读取或保存，原资料未被覆盖。请重试，不要清空资料。');
const conflict=()=>Object.assign(Error('投资记录已更新，请刷新并核对后保存；当前输入仍保留。'),{status:409});
const digest=async(value,crypto)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
function check(row,owner){
 if(!row||row.version!==1||row.owner!==owner||row.enabled!==true||typeof row.selected!=='boolean')throw failure();
 const s=row.state;
 if(!s||s.version!==1||!Number.isSafeInteger(s.revision)||s.revision<0||!s.records||typeof s.records!=='object'||Array.isArray(s.records)||!Array.isArray(s.history)||s.history.length!==s.revision)throw failure();
 const latest=new Map(),ids=new Set();
 for(let i=0;i<s.history.length;i++){
  const h=s.history[i];
  if(h?.revision!==i+1||!kinds.includes(h.kind)||typeof h.key!=='string'||!h.key||typeof h.id!=='string'||ids.has(h.id)||!/^[a-f0-9]{64}$/.test(h.contentHash)||typeof h.at!=='string'||!Number.isFinite(Date.parse(h.at))||h.note!==null||h.previousId!==(latest.get(h.key)?.id??null))throw failure();
  ids.add(h.id);latest.set(h.key,h);
 }
 if(Object.keys(s.records).length!==latest.size)throw failure();
 for(const [key,h] of latest){
  if(!Object.hasOwn(s.records,key))throw failure();const r=s.records[key];
  if(!r||!r.data||typeof r.data!=='object'||Array.isArray(r.data)||h.asset!==r.data.asset||['id','key','kind','revision','at','contentHash','previousId'].some(field=>r[field]!==h[field]))throw failure();
 }
 return row;
}
async function prepare(state,req,crypto){
 if(!req||typeof req!=='object'||!kinds.includes(req.kind)||JSON.stringify(req).length>5000000)throw Error('投资记录类型或大小无效。');
 const kind=req.kind;
 if(kind==='event'&&!/^[a-f0-9-]{36}$/.test(req.eventId||''))throw Error('事件标识无效');
 let data=['snapshot','trades'].includes(kind)?ledger.validate(kind,req.data):model.validate(kind,req.data,catalog.instruments.map(i=>i.alias));
 if(req.expectedRevision!==state.revision)throw conflict();
 let duplicates=0;
 if(kind==='trades'){const result=ledger.reconcile(state,data);if(result.conflicts.length)throw Error('相同成交 ID 的内容不同，本批没有写入，请核查原账单。');duplicates=result.duplicates.length;if(!result.fresh.length)return {state,unchanged:true,duplicates};data={...data,trades:result.fresh};}
 if(data.currency&&data.currency===data.reportCurrency&&data.fxRate!==undefined&&data.fxRate!==1)throw Error('原币与报告币相同时，汇率必须为 1');
 if(kind==='trades'&&data.currency===data.reportCurrency&&data.trades.some(t=>t.fxRate!==1))throw Error('相同币种的成交汇率必须为 1');
 const hash=value=>digest(value,crypto);
 const identity=['snapshot','trades'].includes(kind)?(kind==='snapshot'?ledger.accountKey(data)+'|'+data.asOf:crypto.randomUUID()):kind==='event'?req.eventId:data.asset+'|'+(kind==='account'?data.broker+'|'+data.accountLabel:'');
 const key=['snapshot','trades'].includes(kind)?kind+'-'+(await hash(identity)).slice(0,32):kind==='event'?'event-'+req.eventId:kind+'-'+catalog.instruments.find(i=>i.alias===data.asset).profile+(kind==='account'?'-'+data.broker+'-'+(await hash(data.accountLabel)).slice(0,16):'');
 const prior=state.records[key],contentHash=await hash(JSON.stringify(data));
 if(prior?.contentHash===contentHash)return {state,unchanged:true,duplicates};
 if(kind==='policy'&&Object.values(state.records).filter(r=>r.kind==='policy'&&r.key!==key).reduce((n,r)=>n+(r.data.min??0),data.min??0)>100.0001)throw Error('所有政策的配置下限合计超过 100%');
 const revision=state.revision+1,id=crypto.randomUUID(),at=new Date().toISOString();
 const record={id,key,kind,revision,at,contentHash,previousId:prior?.id??null,data};
 const next={...state,revision,records:{...state.records,[key]:record},history:[...state.history,{id,key,kind,asset:data.asset,revision,at,previousId:record.previousId,contentHash,note:null}]};
 return {state:next,record,unchanged:false,duplicates};
}
function createLocalInvestmentSpace({getScope,assertScope,indexedDB=globalThis.indexedDB,crypto=globalThis.crypto}){
 let connection=null,pending=null;
 const capture=()=>{const scope=getScope(),owner=scope.ownerId;const guard=()=>{assertScope(scope);if(scope.kind!=='cloud'||scope.ownerId!==owner||!owner||!/^[A-Za-z0-9_-]{1,128}$/.test(owner))throw Error('请先验证现有账号，再打开其本机投资空间。');};guard();return {owner,guard};};
 function open(){
  if(connection)return Promise.resolve(connection);if(pending)return pending;
  pending=new Promise((resolve,reject)=>{
   if(!indexedDB){reject(failure());return;}
   let request;try{request=indexedDB.open('wealth-atlas-investment-local-v1',1);}catch{reject(failure());return;}
   let settled=false;
   const fail=()=>{if(!settled){settled=true;clearTimeout(timer);reject(failure());}};
   const timer=setTimeout(fail,10000);
   request.onupgradeneeded=()=>{if(settled){request.transaction.abort();return;}const db=request.result;db.createObjectStore('spaces',{keyPath:'owner'});db.createObjectStore('versions',{keyPath:['owner','revision']}).createIndex('owner','owner');};
   request.onerror=fail;request.onblocked=fail;
   request.onsuccess=()=>{if(settled){request.result.close();return;}settled=true;clearTimeout(timer);const db=request.result;connection=db;db.onversionchange=()=>{db.close();if(connection===db)connection=null;};resolve(db);};
  }).finally(()=>{pending=null;});return pending;
 }
 async function transaction(scope,write,fn){
  scope.guard();const db=await open();scope.guard();
  return new Promise((resolve,reject)=>{
   let tx,result,error;try{tx=db.transaction(['spaces','versions'],write?'readwrite':'readonly');}catch{reject(failure());return;}
   const request=r=>new Promise((done,fail)=>{r.onsuccess=()=>{try{scope.guard();done(r.result);}catch(e){error=e;tx.abort();fail(e);}};r.onerror=()=>fail(failure());});
   tx.oncomplete=()=>{try{scope.guard();resolve(result);}catch(e){reject(e);}};
   tx.onabort=tx.onerror=()=>reject(error||failure());
   Promise.resolve().then(()=>{scope.guard();return fn(tx.objectStore('spaces'),tx.objectStore('versions'),request);}).then(value=>{result=value;}).catch(e=>{error=e;try{tx.abort();}catch{reject(e);}});
  });
 }
 async function row(scope,write=false,create=false){return transaction(scope,write,async(spaces,versions,request)=>{
  const current=await request(spaces.get(scope.owner));
  if(current){check(current,scope.owner);if(await request(versions.index('owner').count(scope.owner))!==current.state.revision)throw failure();return current;}
  if(await request(versions.index('owner').count(scope.owner)))throw failure();
  if(!create)return null;
  const value={version:1,owner:scope.owner,enabled:true,selected:true,state:blank()};await request(spaces.add(value));return value;
 });}
 async function verifiedRow(scope){
  const value=await row(scope);if(!value)return null;
  // Validate an immutable prefix one body at a time; do not hold an IDB tx
  // across WebCrypto awaits or load the entire version archive into memory.
  const latest=new Map(value.state.history.map(h=>[h.key,h.revision]));
  for(const h of value.state.history){
   const version=await transaction(scope,false,async(_spaces,versions,request)=>request(versions.get([scope.owner,h.revision]))),r=version?.record;
   if(!version||version.owner!==scope.owner||version.revision!==h.revision||!r||!r.data||h.asset!==r.data.asset||['id','key','kind','revision','at','contentHash','previousId'].some(field=>r[field]!==h[field]))throw failure();
   if(!crypto?.subtle||await digest(JSON.stringify(r.data),crypto)!==h.contentHash)throw failure();
   if(latest.get(h.key)===h.revision&&JSON.stringify(value.state.records[h.key])!==JSON.stringify(r))throw failure();
  }
  scope.guard();return value;
 }
 return {
  async status(){const scope=capture(),value=await verifiedRow(scope);return {enabled:!!value,selected:value?.selected??false};},
  async enable(){const scope=capture();await row(scope,true,true);await verifiedRow(scope);return {enabled:true};},
  async select(selected){if(typeof selected!=='boolean')throw failure();const scope=capture(),verified=await verifiedRow(scope);if(!verified)throw failure();return transaction(scope,true,async(spaces,_versions,request)=>{const current=check(await request(spaces.get(scope.owner)),scope.owner);if(JSON.stringify(current.state)!==JSON.stringify(verified.state))throw conflict();await request(spaces.put({...current,selected}));});},
  async read(){const scope=capture(),current=await verifiedRow(scope);if(!current)throw Error('当前账号尚未启用本机投资空间。');return current.state;},
  async save(req){
   const scope=capture(),current=await verifiedRow(scope);if(!current)throw Error('当前账号尚未启用本机投资空间。');
   if(!crypto?.subtle||!crypto?.randomUUID)throw Error('此环境不支持安全保存投资版本，请使用当前桌面版。');
   const plan=await prepare(current.state,structuredClone(req),crypto);scope.guard();
   return transaction(scope,true,async(spaces,versions,request)=>{
    const live=check(await request(spaces.get(scope.owner)),scope.owner);if(live.state.revision!==current.state.revision||JSON.stringify(live.state)!==JSON.stringify(current.state))throw conflict();
    if(!plan.unchanged){await request(versions.add({owner:scope.owner,revision:plan.state.revision,record:plan.record}));await request(spaces.put({...live,state:plan.state}));}
    return {state:plan.state,unchanged:plan.unchanged,duplicates:plan.duplicates};
   });
  },
  close(){connection?.close();connection=null;},
 };
}
module.exports={createLocalInvestmentSpace};
