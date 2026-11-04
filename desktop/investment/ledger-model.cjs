'use strict';
const fail=s=>{throw new Error(s);};
const text=(x,max=180)=>typeof x==='string'&&x.trim()&&x.length<=max?x.trim():fail('请填写完整的文字字段');
const num=(x,min=-Infinity)=>x!==''&&x!==null&&x!==undefined&&Number.isFinite(Number(x))&&Number(x)>=min?Number(x):fail('金额、数量与汇率必须是明确数字');
const date=x=>/^\d{4}-\d{2}-\d{2}$/.test(x||'')&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x?x:fail('日期无效');
const currency=x=>['MYR','USD','SGD'].includes(x)?x:fail('请选择 MYR、USD 或 SGD');
function csv(raw,required=[]){
 if(typeof raw!=='string'||raw.length>2000000)fail('CSV 需小于 2MB');
 const rows=[];let row=[],value='',quoted=false;
 for(let i=0;i<=raw.length;i++){const c=raw[i];if(c==='"'){if(quoted&&raw[i+1]==='"'){value+='"';i++;}else if(!value||quoted)quoted=!quoted;else fail('CSV 引号格式无效');}else if((c===','||c==='\n'||c===undefined)&&!quoted){row.push(value.replace(/\r$/,''));value='';if(c!==','){if(row.some(v=>v.trim()))rows.push(row);row=[];}}else value+=c??'';}
 if(quoted||rows.length<1||rows.length>20001)fail('CSV 需要表头，最多 20,000 行');
 const headers=rows.shift().map(s=>s.trim().replace(/^\uFEFF/,''));if(new Set(headers).size!==headers.length)fail('CSV 表头重复');
 if(required.some(h=>!headers.includes(h)))fail('CSV 缺少必需表头：'+required.filter(h=>!headers.includes(h)).join(', '));
 return rows.map(r=>{if(r.length!==headers.length)fail('CSV 列数与表头不一致');return Object.fromEntries(headers.map((h,i)=>[h,r[i].trim()]));});
}
function validate(kind,d){
 const common={broker:['IBKR','moomoo','其他'].includes(d.broker)?d.broker:fail('请选择券商'),account:text(d.account,80),source:text(d.source,500),currency:currency(d.currency),reportCurrency:currency(d.reportCurrency)};
 if(kind==='snapshot'){
  const positions=csv(d.csv,['security_id','quantity','price']).map(r=>({securityId:text(r.security_id,100),name:text(r.name||r.security_id),quantity:num(r.quantity,0),price:num(r.price,0)}));
  if(new Set(positions.map(p=>p.securityId)).size!==positions.length)fail('同一快照的证券 ID 重复，请先合并后导入');
  return {...common,asOf:date(d.asOf),fxRate:num(d.fxRate,Number.MIN_VALUE),fxAsOf:date(d.fxAsOf),cash:num(d.cash,0),positions,sourceType:'user-imported-statement',asset:'portfolio'};
 }
 if(kind==='trades'){
  const trades=csv(d.csv,['trade_id','date','type','security_id','quantity','amount','fx_rate','fx_asof']).map(r=>{const type=r.type;if(!['buy','sell','dividend','fee','deposit','withdrawal'].includes(type))fail('交易类型只接受 buy / sell / dividend / fee / deposit / withdrawal');if(['buy','sell'].includes(type)&&!r.security_id)fail('买卖必须填写证券 ID');return {tradeId:text(r.trade_id,120),date:date(r.date),type,securityId:r.security_id?text(r.security_id,100):'',quantity:['buy','sell'].includes(type)?num(r.quantity,Number.MIN_VALUE):null,amount:num(r.amount,0),fxRate:num(r.fx_rate,Number.MIN_VALUE),fxAsOf:date(r.fx_asof)};});
  if(!trades.length)fail('流水 CSV 没有资料行');
  return {...common,trades,asset:'portfolio',sourceType:'user-imported-statement'};
 }
 fail('记录类型无效');
}
const accountKey=d=>JSON.stringify([d.broker,d.account,d.currency]);
const tradeKey=(batch,t)=>JSON.stringify([batch.broker,batch.account,t.tradeId]);
const signature=(batch,t)=>JSON.stringify([batch.currency,batch.reportCurrency,t.date,t.type,t.securityId,t.quantity,t.amount,t.fxRate,t.fxAsOf]);
function tradeIndex(state){const map=new Map();for(const r of state.history.filter(r=>r.kind==='trades')){const record=state.records[r.key];if(record)for(const t of record.data.trades)map.set(tradeKey(record.data,t),{batch:record.data,trade:t});}return map;}
function reconcile(state,batch){const index=tradeIndex(state),fresh=[],duplicates=[],conflicts=[];for(const t of batch.trades){const key=tradeKey(batch,t),prior=index.get(key);if(prior){if(signature(prior.batch,prior.trade)===signature(batch,t))duplicates.push(t);else conflicts.push(t);}else{fresh.push(t);index.set(key,{batch,trade:t});}}return {fresh,duplicates,conflicts};}
function snapshots(state){return Object.values(state.records).filter(r=>r.kind==='snapshot').sort((a,b)=>a.data.asOf.localeCompare(b.data.asOf)||a.revision-b.revision);}
function latest(state){const map=new Map();for(const r of snapshots(state))map.set(accountKey(r.data),r);return [...map.values()];}
function total(d){return d.cash+d.positions.reduce((n,p)=>n+p.quantity*p.price,0);}
function breakdown(state,start,end){
 const a=start.data,b=end.data;if(accountKey(a)!==accountKey(b)||a.reportCurrency!==b.reportCurrency||a.asOf>=b.asOf)fail('请选择同一券商、账户、原币和报告币的前后两期快照');
 const entries=[...tradeIndex(state).values()].filter(x=>accountKey(x.batch)===accountKey(a)&&x.trade.date>a.asOf&&x.trade.date<=b.asOf&&!['buy','sell'].includes(x.trade.type));
 if(entries.some(x=>x.batch.reportCurrency!==a.reportCurrency))fail('期间流水的报告币不同，请先核对换算口径');
 const flows=entries.map(x=>x.trade);
 const signed=t=>['fee','withdrawal'].includes(t.type)?-t.amount:t.amount;
 const external=flows.filter(t=>['deposit','withdrawal'].includes(t.type)).reduce((n,t)=>n+signed(t)*t.fxRate,0);
 const dividends=flows.filter(t=>t.type==='dividend').reduce((n,t)=>n+t.amount*t.fxRate,0),fees=-flows.filter(t=>t.type==='fee').reduce((n,t)=>n+t.amount*t.fxRate,0);
 const market=(total(b)-total(a)-flows.reduce((n,t)=>n+signed(t),0))*b.fxRate;
 const fx=total(a)*(b.fxRate-a.fxRate)+flows.reduce((n,t)=>n+signed(t)*(b.fxRate-t.fxRate),0);
 const delta=total(b)*b.fxRate-total(a)*a.fxRate;
 return {market,fx,dividends,fees,external,delta,residual:delta-market-fx-dividends-fees-external,currency:b.reportCurrency};
}
function reconcileHoldings(state,start,end){
 const a=start.data,b=end.data;if(accountKey(a)!==accountKey(b)||a.asOf>=b.asOf)fail('请选择同一账户的前后两期快照');
 const expected=new Map(a.positions.map(p=>[p.securityId,p.quantity]));
 for(const {batch,trade:t} of tradeIndex(state).values())if(accountKey(batch)===accountKey(a)&&t.date>a.asOf&&t.date<=b.asOf&&['buy','sell'].includes(t.type))expected.set(t.securityId,(expected.get(t.securityId)||0)+(t.type==='buy'?1:-1)*t.quantity);
 const actual=new Map(b.positions.map(p=>[p.securityId,p.quantity]));
 return [...new Set([...expected.keys(),...actual.keys()])].map(id=>({securityId:id,expected:expected.get(id)||0,actual:actual.get(id)||0,difference:(actual.get(id)||0)-(expected.get(id)||0)})).filter(r=>Math.abs(r.difference)>1e-8);
}
function cashReserve({endBalance,safety,budgets}){const grouped=new Map();for(const b of budgets){if(![b.remaining,b.coveredPlanned].every(Number.isFinite))fail('预算金额或汇率缺失');grouped.set(b.key,Math.max(grouped.get(b.key)||0,b.remaining-b.coveredPlanned,0));}const budgetReserve=[...grouped.values()].reduce((n,v)=>n+v,0);return {budgetReserve,available:endBalance-budgetReserve-safety};}
module.exports={csv,validate,accountKey,tradeKey,reconcile,tradeIndex,snapshots,latest,total,breakdown,reconcileHoldings,cashReserve};
