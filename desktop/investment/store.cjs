'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const model=require('./investment-model.js'),ledger=require('./ledger-model.cjs');
const titles={account:'账户匹配',policy:'投资政策',event:'股息与公司行动',benchmark:'基准比较',lookthrough:'ETF穿透',reference:'资料变更提案',snapshot:'持仓快照',trades:'交易对账'};
function createStore({vaultRoot,catalog}){
 const root=path.resolve(vaultRoot),base=path.join(root,'99_系统','投资联动'),journal=path.join(base,'commits');
 let queue=Promise.resolve();
 const empty=()=>({version:1,revision:0,records:{},history:[]});
 function check(s){if(s?.version!==1||!Number.isSafeInteger(s.revision)||s.revision<0||!s.records||!Array.isArray(s.history))throw Error('投资索引损坏，请恢复备份后重试；没有覆盖旧记录');return s;}
 async function safeDir(dir,create=false){
  const rel=path.relative(root,dir);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('记录目录超出已连接的 Vault');
  let current=await fs.realpath(root);
  for(const part of rel.split(path.sep).filter(Boolean)){
   current=path.join(current,part);
   let info;try{info=await fs.lstat(current);}catch(e){
    if(e.code!=='ENOENT')throw e;
    if(!create)return null;
    try{await fs.mkdir(current);}catch(error){if(error.code!=='EEXIST')throw error;}
    info=await fs.lstat(current);
   }
   if(!info.isDirectory()||info.isSymbolicLink())throw Error('投资记录目录不能使用链接');
  }
  return current;
 }
 async function readStateFile(dir,name){
  const file=path.join(dir,name),info=await fs.lstat(file);
  if(!info.isFile()||info.isSymbolicLink())throw Error('投资记录必须是普通文件，不能使用链接');
  return check(JSON.parse(await fs.readFile(file,'utf8')));
 }
 async function read(){
  const baseDir=await safeDir(base);
  let state=empty();if(!baseDir)return state;
  try{state=await readStateFile(baseDir,'index.json');}catch(e){if(e.code!=='ENOENT')throw e;}
  const journalDir=await safeDir(journal);
  if(!journalDir)return state;
  const files=(await fs.readdir(journalDir)).filter(n=>/^revision-\d{12}\.json$/.test(n)).sort();
  for(const n of files){const rev=Number(n.slice(9,21)),next=await readStateFile(journalDir,n);if(next.revision!==rev)throw Error('投资版本序号不匹配');if(rev<=state.revision){const a=state.history.find(h=>h.revision===rev),b=next.history.find(h=>h.revision===rev);if(a?.id!==b?.id||a?.contentHash!==b?.contentHash)throw Error('旧预览索引与正式版本发生分叉，已停止读取与覆盖，请核查历史记录');continue;}if(rev!==state.revision+1)throw Error('投资版本序列不完整，请核查备份');state=next;}
  return state;
 }
 const conflict=()=>{const e=Error('记录已在另一页面更新，请刷新并核对后保存；当前输入仍保留');e.status=409;return e;};
 async function write(req){
  if(!req||typeof req!=='object'||!Object.hasOwn(titles,req.kind))throw Error('记录类型无效');
  const kind=req.kind;
  if(kind==='event'&&!/^[a-f0-9-]{36}$/.test(req.eventId||''))throw Error('事件标识无效');
  let data=['snapshot','trades'].includes(kind)?ledger.validate(kind,req.data):model.validate(kind,req.data,catalog.instruments.map(i=>i.alias));
  const state=await read();if(req.expectedRevision!==state.revision)throw conflict();
  let duplicates=0;
  if(kind==='trades'){const result=ledger.reconcile(state,data);if(result.conflicts.length)throw Error('相同券商、账户与成交 ID 出现不同资料：'+result.conflicts.map(t=>t.tradeId).join('、')+'。本批未写入，请核查原账单');duplicates=result.duplicates.length;if(!result.fresh.length)return {state,unchanged:true,duplicates};data={...data,trades:result.fresh};}
  if(data.currency&&data.currency===data.reportCurrency&&data.fxRate!==undefined&&data.fxRate!==1)throw Error('原币与报告币相同时，汇率必须为 1');
  if(kind==='trades'&&data.currency===data.reportCurrency&&data.trades.some(t=>t.fxRate!==1))throw Error('相同币种的成交汇率必须为 1');
  const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
  const identity=['snapshot','trades'].includes(kind)?(kind==='snapshot'?ledger.accountKey(data)+'|'+data.asOf:crypto.randomUUID()):kind==='event'?req.eventId:data.asset+'|'+(kind==='account'?data.broker+'|'+data.accountLabel:'');
  const key=['snapshot','trades'].includes(kind)?kind+'-'+hash(identity).slice(0,32):kind==='event'?'event-'+req.eventId:kind+'-'+catalog.instruments.find(i=>i.alias===data.asset).profile+(kind==='account'?'-'+data.broker+'-'+hash(data.accountLabel).slice(0,16):'');
  const prior=state.records[key],contentHash=hash(JSON.stringify(data));
  if(prior?.contentHash===contentHash)return {state,unchanged:true,duplicates};
  if(kind==='policy'&&Object.values(state.records).filter(r=>r.kind==='policy'&&r.key!==key).reduce((n,r)=>n+(r.data.min??0),data.min??0)>100.0001)throw Error('所有政策的配置下限合计超过 100%');
  const revision=state.revision+1,id=crypto.randomUUID(),at=new Date().toISOString(),stem=at.replace(/[:.]/g,'-')+'-'+id;
  const note='20_领域/投资/'+(['snapshot','trades'].includes(kind)?'持仓与对账/':'投资管理记录/')+kind+'/'+stem+'.md';
  const record={id,key,kind,revision,at,contentHash,previousId:prior?.id??null,data};
  const next={...state,revision,records:{...state.records,[key]:record},history:[...state.history,{id,key,kind,asset:data.asset,revision,at,previousId:record.previousId,contentHash,note}]};
  const journalDir=await safeDir(journal,true),versionsDir=await safeDir(path.join(base,'versions'),true),noteDir=await safeDir(path.dirname(path.join(root,note)),true);
  await fs.writeFile(path.join(versionsDir,stem+'.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  const md=`---\ntype: investment-management-record\nrecord-kind: ${kind}\nrevision: ${revision}\nrecorded-at: ${JSON.stringify(at)}\ncommit-id: ${id}\n---\n\n# ${data.asset==='portfolio'?data.broker+' · '+data.account:data.asset} · ${titles[kind]}\n\n来源：用户在正式投资工作台明确保存。公开资料、账户快照、成交和未执行计划分别保留；不执行交易或付款。\n\n此版本以 99_系统/投资联动/commits/revision-${String(revision).padStart(12,'0')}.json 中的 commit-id 为准。若保存冲突或中断，未被提交索引引用的文件不是成功记录。\n\n\`\`\`json\n${JSON.stringify(data,null,2).replace(/`/g,'\\u0060')}\n\`\`\`\n\n前一版本：${record.previousId||'无'}\n\nSHA256：${contentHash}\n`;
  await fs.writeFile(path.join(noteDir,path.basename(note)),md,{flag:'wx'});
  // Publish a complete immutable state in one atomic, exclusive NTFS link.
  // Two independent apps cannot both win the same revision. Files are never deleted.
  const pending=path.join(versionsDir,'state-'+id+'.json');await fs.writeFile(pending,JSON.stringify(next,null,2)+'\n',{flag:'wx'});
  try{await fs.link(pending,path.join(journalDir,'revision-'+String(revision).padStart(12,'0')+'.json'));}catch(e){if(e.code==='EEXIST')throw conflict();throw Error('此磁盘无法安全提交投资版本，请检查文件权限和硬链接支持。');}
  return {state:next,unchanged:false,duplicates};
 }
 return {read,save:req=>{const p=queue.then(()=>write(req));queue=p.catch(()=>{});return p;},base};
}
module.exports={createStore};
