(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.InvestmentModel=factory();})(globalThis,function(){
 'use strict';
 const kinds=['account','policy','event','benchmark','lookthrough','reference'];
 const fail=message=>{throw new Error(message);};
 const text=(v,max=6000)=>{if(v===null||v===undefined)return '';if(typeof v!=='string'||v.length>max)fail('文字格式或长度不正确');return v.trim();};
 const number=(v,min=-Infinity,max=Infinity)=>{if(v===null||v===undefined||(typeof v==='string'&&!v.trim()))return null;if(!['number','string'].includes(typeof v))fail('数字格式无效');const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)fail('数字不在允许范围');return n;};
 const date=v=>{const s=text(v,10);if(!s)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail('日期无效');return s;};
 const currency=v=>['MYR','SGD','USD'].includes(v)?v:fail('请选择 MYR、SGD 或 USD');
 const url=v=>{const s=text(v,2000);if(!s)return '';try{const u=new URL(s);if(u.protocol!=='https:'||u.username||u.password)fail('来源需使用不带凭证的 HTTPS 地址');return u.href;}catch{fail('来源需使用不带凭证的 HTTPS 地址');}};
 function compareReturns(d){
   const start=date(d.start),end=date(d.end);if(!start||!end||start>=end)fail('请提供先后正确的同一比较期间');
   const portfolio=number(d.portfolio,-100),benchmark=number(d.benchmark,-100);if(portfolio===null||benchmark===null)fail('请提供两项已核实累计总回报');
   if(d.totalReturnConfirmed!==true)fail('请确认两项都是同币种、同期间、含分红口径的累计总回报');
   return {start,end,currency:currency(d.currency),portfolio,benchmark,excessPercentagePoints:Number((portfolio-benchmark).toFixed(8)),method:'user-supplied-cumulative-total-returns',portfolioSource:text(d.portfolioSource,2000)||fail('请填写组合回报出处'),benchmarkSource:text(d.benchmarkSource,2000)||fail('请填写基准回报出处'),totalReturnConfirmed:true};
 }
 function csvRows(input){
   if(typeof input!=='string'||input.length>2000000)fail('CSV 文件需小于 2 MB');
   const rows=[];let row=[],cell='',quoted=false;
   const src=input.replace(/^\uFEFF/,'');
   for(let n=0;n<src.length;n++){const c=src[n];if(c==='"'){if(quoted&&src[n+1]==='"'){cell+='"';n++;}else if(!quoted&&cell==='')quoted=true;else if(quoted)quoted=false;else fail('CSV 引号格式不正确');}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&src[n+1]==='\n')n++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';}else cell+=c;}
   if(quoted)fail('CSV 有未闭合的引号');row.push(cell);if(row.some(v=>v.trim()))rows.push(row);return rows;
 }
 function constituents(input,meta){
   const asOf=date(meta.asOf);if(!asOf)fail('请填写成分资料实际日期');const source=url(meta.source);if(!source)fail('请填写成分资料来源');
   const rows=csvRows(input);if(rows.length<2||rows.length>20001)fail('CSV 需要表头和至少一行，最多 20,000 行');
   const header=rows.shift().map(s=>s.trim().toLowerCase());if(new Set(header).size!==header.length)fail('CSV 表头不能重复');
   const idIndex=header.indexOf('security_id'),weightIndex=header.indexOf('weight_percent');if(idIndex<0||weightIndex<0)fail('CSV 需要 security_id 和 weight_percent 两列');
   const values=[],seen=new Set();let covered=0;
   for(const row of rows){if(row.length!==header.length)fail('CSV 行的列数与表头不一致');const securityId=text(row[idIndex],160);if(!securityId)fail('每行都需要稳定证券 ID，不能仅用公司简称');if(seen.has(securityId))fail('发现重复证券 ID，请先核对份额及重复行');seen.add(securityId);const weight=number(row[weightIndex],0,100);if(weight===null)fail('成分权重不能为空');covered+=weight;values.push({securityId,weight,country:text(row[header.indexOf('country')],160)||'未分类',sector:text(row[header.indexOf('sector')],160)||'未分类'});}
   if(covered>100.0001)fail('权重超过100%；本工具仅适用于非杠杆股票成分表，不自动归一化');
   return {asOf,source,label:text(meta.label,160)||'用户提供的成分表',coveredPercent:Number(covered.toFixed(8)),uncoveredPercent:Number(Math.max(0,100-covered).toFixed(8)),holdings:values,verification:'user-supplied-not-independently-verified'};
 }
 function aggregate(dataset,field){const result={};for(const h of dataset.holdings)result[h[field]]=(result[h[field]]||0)+h.weight;if(dataset.uncoveredPercent>0)result['未覆盖']=dataset.uncoveredPercent;return Object.entries(result).map(([name,weight])=>({name,weight:Number(weight.toFixed(8))})).sort((a,b)=>b.weight-a.weight);}
 function overlap(a,b){if(a.asOf!==b.asOf)fail('两份成分表日期不同，不能当作同日重叠比较');const other=new Map(b.holdings.map(h=>[h.securityId,h.weight]));const matched=a.holdings.filter(h=>other.has(h.securityId)).map(h=>({securityId:h.securityId,weight:Math.min(h.weight,other.get(h.securityId))}));return {asOf:a.asOf,matchedWeightPercent:Number(matched.reduce((sum,h)=>sum+h.weight,0).toFixed(8)),partial:a.uncoveredPercent>0||b.uncoveredPercent>0,description:'按稳定证券ID计算Σmin(权重A,权重B)，不自动当作同一公司的不同股类',matched};}
 function validate(kind,input,aliases){
   if(!kinds.includes(kind)||!input||typeof input!=='object'||Array.isArray(input))fail('不支持的记录类型');
   const asset=text(input.asset,100);if(!aliases.includes(asset))fail('请从已核对的六项标的中选择');
   let data={asset};
   if(kind==='account'){
     if(!['IBKR','moomoo','待确认'].includes(input.broker))fail('券商无效');
     data={...data,broker:input.broker,accountLabel:text(input.accountLabel,120)||fail('请填写账户匿名标签'),externalSecurityId:text(input.externalSecurityId,160),evidence:text(input.evidence,2000),status:'proposed-not-verified'};
     if(data.externalSecurityId&&!data.evidence)fail('填写券商内部ID时，需附合同详情或导出定位');
   }else if(kind==='policy'){
     const min=number(input.min,0,100),max=number(input.max,0,100);if(min!==null&&max!==null&&min>max)fail('目标下限不能高于上限');
     data={...data,role:text(input.role,600),reason:text(input.reason),horizon:text(input.horizon,300),min,max,budget:number(input.budget,0),currency:currency(input.currency),reviewCondition:text(input.reviewCondition,3000),threshold:number(input.threshold,0,100),quietHours:text(input.quietHours,100),notificationsEnabled:false};
     if(!data.role&&!data.reason&&!data.reviewCondition)fail('至少填写资产用途、持有理由或复核条件之一');
     if(data.quietHours&&!/^([01]\d|2[0-3]):[0-5]\d\s*[-–]\s*([01]\d|2[0-3]):[0-5]\d$/.test(data.quietHours))fail('安静时段请用 HH:mm-HH:mm 格式');
   }else if(kind==='event'){
     if(!['dividend','split','transfer','earnings','other'].includes(input.eventType))fail('事件类型无效');if(!['estimated','announced','cancelled'].includes(input.status))fail('日历只登记预计、公告或取消；到账需对账证据');
     data={...data,eventType:input.eventType,status:input.status,eventDate:date(input.eventDate),exDate:date(input.exDate),payDate:date(input.payDate),amount:number(input.amount,0),currency:currency(input.currency),source:url(input.source),sourceEventId:text(input.sourceEventId,160),note:text(input.note,3000),paid:false,ledgerApplied:false};
     if(data.status==='announced'&&!data.source)fail('公告事件必须提供来源地址');if(!data.eventDate&&!data.exDate&&!data.payDate)fail('至少提供一个明确事件日期');
   }else if(kind==='benchmark')data={...data,...compareReturns(input)};
   else if(kind==='lookthrough'){
     data={...data,first:constituents(input.csvA,{asOf:input.dateA,source:input.sourceA,label:input.labelA}),second:input.csvB?constituents(input.csvB,{asOf:input.dateB,source:input.sourceB,label:input.labelB}):null};
     data.result=data.second?overlap(data.first,data.second):null;
   }else{
     if(!['name','ticker','isin','fee'].includes(input.field))fail('请选择允许核查的资料字段');
     data={...data,field:input.field,proposedValue:text(input.proposedValue,1000)||fail('请填写新资料'),source:url(input.source)||fail('请提供新资料来源'),asOf:date(input.asOf)||fail('请提供来源日期'),note:text(input.note,3000),status:'pending-review-not-applied'};
   }
   return data;
 }
 return {kinds,validate,compareReturns,constituents,aggregate,overlap};
});
