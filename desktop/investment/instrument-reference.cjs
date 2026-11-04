'use strict';
module.exports=function createInstrumentReference(catalog){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const find=alias=>catalog.instruments.find(i=>i.alias===alias||i.ticker===alias||i.isin===alias);
 const queryTerms=alias=>{const i=find(alias);return i?[i.alias,i.name,i.ticker,i.stockCode,i.isin,i.sedol,i.cusip,i.reuters,...Object.values(i.providerAliases||{})].filter(Boolean).join(' ').toLowerCase():String(alias).toLowerCase();};
 const compact=alias=>{const i=find(alias);return i?`${i.display} · ${i.stockCode}${i.exchange==='London Stock Exchange'?' · LSE':''}`:alias;};
 const source=(i,field)=>{const id=i.fieldSources[field]||i.sourceIds[0],s=catalog.sources[id];return `<a class="instrument-source" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">[${id}]</a>`;};
 const row=(i,label,value,field)=>`<div class="instrument-fact"><dt>${esc(label)}</dt><dd>${esc(value)} ${source(i,field)}</dd></div>`;
 function html(alias){
   const i=find(alias);if(!i)return '';
   const fields=[['正式名称',i.name,'name'],['交易所 / 市场',i.exchange+(i.board?' · '+i.board:''),'exchange'],['股票代码 / 简称',i.stockCode+' / '+i.ticker,i.fieldSources.stockCode?'stockCode':'ticker'],['ISIN',i.isin,'isin'],['交易币种',i.tradingCurrency,'tradingCurrency'],['类型',i.assetClass,'assetClass']];
   for(const [key,label] of [['fundBaseCurrency','基金基础币种'],['domicile','注册地'],['benchmark','基准'],['distribution','分配方式'],['sedol','SEDOL'],['cusip','CUSIP'],['bloomberg','Bloomberg'],['reuters','Reuters'],['wkn','WKN']])if(i[key])fields.push([label,i[key],key]);
   if(i.fee)fields.push([i.fee.label,`${i.fee.percent}% / 年 · 资料 ${i.fee.asOf.replace('-access','（访问日）')}`,'fee']);
   return `<section class="instrument-reference" aria-label="${esc(i.display)} 公开证券资料"><div class="instrument-ref-head"><h3>证券资料</h3><span>公开资料核对：${catalog.verifiedAt}</span></div><p class="instrument-description">${esc(i.description)} ${source(i,'description')}</p><dl class="instrument-facts">${fields.map(([label,value,key])=>row(i,label,value,key)).join('')}</dl><p class="instrument-boundary">券商内部 ID（IBKR conid / moomoo）：未取得；数量、成本与账户归属仍未知。以下资料不代表券商持仓已匹配。</p>${i.providerAliases?`<p class="instrument-boundary">网站别名：${Object.entries(i.providerAliases).map(([name,value])=>esc(name)+' = '+esc(value)).join('；')}。交易所代码以本表为准。</p>`:''}<details class="instrument-provenance"><summary>公开来源、资料日期与核验限制</summary><ul>${i.sourceIds.map(id=>{const s=catalog.sources[id];return `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${id} · ${esc(s.title)}</a><small>${esc(s.checked)}${s.asOf?' · 资料 '+esc(s.asOf):''}</small></li>`;}).join('')}</ul>${i.notes.map(n=>`<p>${esc(n)}</p>`).join('')}</details></section>`;
 }
 return Object.freeze({find,queryTerms,compact,html});
};
