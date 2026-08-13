"use client";

import { useMemo,useState } from "react";
import {
  ArrowRight,
  Bank,
  ChartLineUp,
  CheckCircle,
  Coins,
  FilePdf,
  FileXls,
  PiggyBank,
  Receipt,
  TrendUp,
  Warning,
  Wallet,
} from "@phosphor-icons/react";
import { exportChartPng,exportExcel,exportPdfReport } from "@/lib/exporters";
import {
  formatMoney,
  getBudgetSpent,
  getLocalDate,
  getRateAgeDays,
  getRateAtDate,
  getRateRecord,
} from "@/lib/finance";
import { formatMonthLabel,getMonthEnd,getMonthReferenceDate,SharedMonthPicker,useSharedMonth } from "@/components/MonthPicker";
import type { Account,CurrencyCode,Transaction,Transfer,WealthData } from "@/lib/types";

type FlowKind="income"|"expense";
type RankedRow={ name: string; amount: number; previousAmount: number; percent: number; };
type Suggestion={ id: string; tone: "success"|"warning"|"accent"; title: string; detail: string; destination: string; };
type Props={
  data: WealthData;
  onToast: (message: string) => void;
  onNavigate: (page: string) => void;
  onOpenTransactions: (kind: FlowKind,category: string) => void;
};

const currencies: CurrencyCode[]=["MYR","SGD","USD"];
const today=getLocalDate();

function shiftMonth(month: string,offset: number) {
  const [year,monthIndex]=month.split("-").map(Number);
  const value=new Date(Date.UTC(year,monthIndex-1+offset,1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth()+1).padStart(2,"0")}`;
}

function transactionValue(data: WealthData,item: Transaction,quote: CurrencyCode) {
  if(item.currency===quote) return item.amount;
  const snapshot=item.fxSnapshot;
  if(snapshot?.originalCurrency===item.currency&&snapshot.convertedCurrency===quote&&snapshot.originalAmount>0) {
    return snapshot.convertedAmount*(item.amount/snapshot.originalAmount);
  }
  const rate=getRateAtDate(data.fxRates,item.currency,quote,snapshot?.rateDate??item.date);
  return rate===null? null:item.amount*rate;
}

function transferAmountValue(data: WealthData,item: Transfer,amount: number,currency: CurrencyCode,quote: CurrencyCode) {
  if(currency===quote) return amount;
  const snapshot=item.fxSnapshot;
  if(snapshot?.originalCurrency===currency&&snapshot.convertedCurrency===quote&&snapshot.originalAmount>0) {
    return snapshot.convertedAmount*(amount/snapshot.originalAmount);
  }
  const rate=getRateAtDate(data.fxRates,currency,quote,snapshot?.rateDate??item.rateDate??item.date);
  return rate===null? null:amount*rate;
}

function summarizeMonth(data: WealthData,month: string,quote: CurrencyCode) {
  const rows=data.transactions.filter((item) => !item.deleted&&item.date.slice(0,7)===month);
  const converted=rows.map((item) => ({ item,value: transactionValue(data,item,quote) }));
  const income=converted.filter(({ item }) => item.type==="income").reduce((sum,{ value }) => sum+(value??0),0);
  const expense=converted.filter(({ item }) => item.type==="expense").reduce((sum,{ value }) => sum+(value??0),0);
  return { rows,converted,income,expense,saving: income-expense,incomplete: converted.some(({ value }) => value===null) };
}

function aggregateByCategory(data: WealthData,month: string,quote: CurrencyCode,kind: FlowKind) {
  const map=new Map<string,number>();
  data.transactions.filter((item) => !item.deleted&&item.type===kind&&item.date.slice(0,7)===month).forEach((item) => {
    const value=transactionValue(data,item,quote);
    if(value!==null) map.set(item.category,(map.get(item.category)??0)+value);
  });
  return map;
}

function rankCategories(current: Map<string,number>,previous: Map<string,number>,limit: number,total: number) {
  const sorted=[...current.entries()].filter(([,amount]) => amount>0).sort((a,b) => b[1]-a[1]);
  const primary=sorted.slice(0,limit).map(([name,amount]) => ({ name,amount,previousAmount: previous.get(name)??0,percent: total>0? amount/total*100:0 }));
  const remaining=sorted.slice(limit);
  if(remaining.length) {
    const names=new Set(remaining.map(([name]) => name));
    const amount=remaining.reduce((sum,[,value]) => sum+value,0);
    const previousAmount=[...previous.entries()].filter(([name]) => names.has(name)).reduce((sum,[,value]) => sum+value,0);
    primary.push({ name: "其他",amount,previousAmount,percent: total>0? amount/total*100:0 });
  }
  return primary;
}

function percentChange(current: number,previous: number) {
  if(previous===0) return null;
  return (current-previous)/Math.abs(previous)*100;
}

function compareLabel(current: number,previous: number,suffix="%") {
  const change=percentChange(current,previous);
  if(change===null) return "上月暂无数据";
  const sign=change>0? "+":"";
  return `比上月 ${sign}${change.toFixed(0)}${suffix}`;
}

function rateForAccount(data: WealthData,amount: number,base: CurrencyCode,quote: CurrencyCode,date: string) {
  if(base===quote) return amount;
  const rate=getRateAtDate(data.fxRates,base,quote,date);
  return rate===null? null:amount*rate;
}

function accountBalanceAt(data: WealthData,account: Account,endDate: string) {
  let balance=account.balance;
  data.transactions.filter((item) => !item.deleted&&item.accountId===account.id&&item.date<=endDate).forEach((item) => {
    const value=transactionValue(data,item,account.currency);
    if(value!==null) balance+=item.type==="income"? value:-value;
  });
  data.transfers.filter((item) => !item.deleted&&item.date<=endDate).forEach((item) => {
    if(item.fromAccountId===account.id) {
      const sent=transferAmountValue(data,item,item.fromAmount,item.fromCurrency,account.currency);
      const fee=transferAmountValue(data,item,item.fee,item.feeCurrency,account.currency);
      if(sent!==null) balance-=sent;
      if(fee!==null) balance-=fee;
    }
    if(item.toAccountId===account.id) {
      const received=transferAmountValue(data,item,item.toAmount,item.toCurrency,account.currency);
      if(received!==null) balance+=received;
    }
  });
  return balance;
}

function Delta({ current,previous,enabled,points=false }: { current: number; previous: number; enabled: boolean; points?: boolean; }) {
  if(!enabled) return null;
  if(points) {
    const difference=current-previous;
    return <small className={difference>=0? "report-positive":"report-warning"}>比上月 {difference>0? "+":""}{difference.toFixed(0)} 个百分点</small>;
  }
  const change=percentChange(current,previous);
  if(change===null) return <small>上月暂无数据</small>;
  return <small className={change>=0? "report-positive":"report-warning"}>比上月 {change>0? "+":""}{change.toFixed(0)}%</small>;
}

function RankedList({ rows,total,currency,compare,onSelect }: { rows: RankedRow[]; total: number; currency: CurrencyCode; compare: boolean; onSelect: (name: string) => void; }) {
  if(!rows.length) return <div className="reports-empty compact"><Receipt size={25}/><strong>这个月份没有可显示的记录</strong><span>切换月份或先记录一笔收支。</span></div>;
  return <div className="report-ranked-list">{rows.map((row) => <button type="button" className="report-ranked-row" key={row.name} onClick={() => onSelect(row.name)} aria-label={`查看 ${row.name} 的收支记录`} title={`查看 ${row.name} 的收支记录`}><span className="report-ranked-heading"><strong>{row.name}</strong><b>{formatMoney(row.amount,currency)}</b><em>{row.percent.toFixed(0)}%</em></span><span className="report-bar" aria-hidden="true"><i style={{ width: `${Math.max(2,total>0? row.amount/total*100:0)}%` }}/></span>{compare&&<small>{compareLabel(row.amount,row.previousAmount)}</small>}</button>)}</div>;
}

export default function MoneyReportsCenter({ data,onToast,onNavigate,onOpenTransactions }: Props) {
  const [selectedMonth]=useSharedMonth(today.slice(0,7));
  const [reportCurrency,setReportCurrency]=useState<CurrencyCode>(data.reportCurrency);
  const [comparePrevious,setComparePrevious]=useState(true);
  const previousMonth=shiftMonth(selectedMonth,-1);
  const monthEnd=getMonthEnd(selectedMonth);
  const monthReference=getMonthReferenceDate(selectedMonth,today);
  const current=useMemo(() => summarizeMonth(data,selectedMonth,reportCurrency),[data,selectedMonth,reportCurrency]);
  const previous=useMemo(() => summarizeMonth(data,previousMonth,reportCurrency),[data,previousMonth,reportCurrency]);
  const savingsRate=current.income>0? current.saving/current.income*100:null;
  const previousSavingsRate=previous.income>0? previous.saving/previous.income*100:null;
  const incomeRows=useMemo(() => rankCategories(aggregateByCategory(data,selectedMonth,reportCurrency,"income"),aggregateByCategory(data,previousMonth,reportCurrency,"income"),3,current.income),[data,selectedMonth,previousMonth,reportCurrency,current.income]);
  const expenseRows=useMemo(() => rankCategories(aggregateByCategory(data,selectedMonth,reportCurrency,"expense"),aggregateByCategory(data,previousMonth,reportCurrency,"expense"),5,current.expense),[data,selectedMonth,previousMonth,reportCurrency,current.expense]);

  const accountFlows=useMemo(() => {
    const values=new Map<string,number>();
    current.converted.forEach(({ item,value }) => {
      if(value!==null) values.set(item.accountId,(values.get(item.accountId)??0)+value);
    });
    return [...values.entries()].map(([accountId,amount]) => ({ account: data.accounts.find((item) => item.id===accountId),amount })).filter((row): row is { account: Account; amount: number } => Boolean(row.account)).sort((a,b) => b.amount-a.amount).slice(0,3);
  },[current.converted,data.accounts]);

  const currencyRows=useMemo(() => {
    const rows=currencies.map((currency) => {
      const raw=data.accounts.filter((account) => account.currency===currency&&account.status!=="deleted").reduce((sum,account) => sum+Math.max(0,accountBalanceAt(data,account,monthEnd)),0);
      const converted=rateForAccount(data,raw,currency,reportCurrency,monthEnd);
      return { currency,raw,value: converted };
    });
    const total=rows.reduce((sum,row) => sum+(row.value??0),0);
    return rows.map((row) => ({ ...row,percent: total>0&&row.value!==null? row.value/total*100:0 }));
  },[data,monthEnd,reportCurrency]);

  const sgdMyrTransfers=data.transfers.filter((item) => !item.deleted&&item.date.slice(0,7)===selectedMonth&&item.fromCurrency==="SGD"&&item.toCurrency==="MYR");
  const transferredSgd=sgdMyrTransfers.reduce((sum,item) => sum+item.fromAmount,0);
  const previousSgdMyr=getRateAtDate(data.fxRates,"SGD","MYR",getMonthEnd(previousMonth));
  const fxImpact=previousSgdMyr===null||!sgdMyrTransfers.length? null:sgdMyrTransfers.reduce((sum,item) => sum+(item.toAmount-item.fromAmount*previousSgdMyr),0);

  const suggestions=useMemo(() => {
    const rows: Suggestion[]=[];
    const expenseMap=aggregateByCategory(data,selectedMonth,reportCurrency,"expense");
    const priorMonths=[1,2,3].map((offset) => aggregateByCategory(data,shiftMonth(selectedMonth,-offset),reportCurrency,"expense"));
    const expenseTrend=[...expenseMap.entries()].map(([name,amount]) => ({ name,amount,average: priorMonths.reduce((sum,map) => sum+(map.get(name)??0),0)/3 })).filter((item) => item.average>0&&item.amount>item.average*1.1).sort((a,b) => (b.amount/b.average)-(a.amount/a.average))[0];
    if(expenseTrend) rows.push({ id: "expense-rise",tone: "warning",title: `${expenseTrend.name}高于过去 3 个月平均`,detail: `本月高 ${Math.round((expenseTrend.amount/expenseTrend.average-1)*100)}%`,destination: "transactions" });
    const activeBudget=(data.budgets??[]).filter((budget) => (budget.period??budget.month)===selectedMonth&&budget.active!==false&&!budget.deleted&&budget.status!=="inactive"&&budget.status!=="deleted").map((budget) => ({ budget,spent: getBudgetSpent(data,budget),limit: budget.budgetAmount??budget.limit })).filter(({ spent,limit }) => limit>0&&spent/limit>=.8).sort((a,b) => b.spent/b.limit-a.spent/a.limit)[0];
    if(activeBudget) rows.push({ id: "budget-limit",tone: "warning",title: `${activeBudget.budget.category}预算接近上限`,detail: `已使用 ${Math.round(activeBudget.spent/activeBudget.limit*100)}%`,destination: "budget" });
    if(savingsRate!==null) rows.push({ id: "saving-rate",tone: savingsRate>=0? "success":"warning",title: `本月储蓄率 ${savingsRate.toFixed(0)}%`,detail: savingsRate>=0? "收入仍高于支出":"支出高于收入",destination: "goals" });
    const stalePairs=([ ["SGD","MYR"],["USD","SGD"] ] as Array<[CurrencyCode,CurrencyCode]>).filter(([base,quote]) => {
      const record=getRateRecord(data.fxRates,base,quote,monthEnd,true);
      return !record||(getRateAgeDays(record,monthReference)??31)>30;
    });
    if(stalePairs.length) rows.push({ id: "fx-stale",tone: "accent",title: `${stalePairs.map((pair) => pair.join("/")).join("、")} 汇率需要更新`,detail: "历史交易快照保持不变",destination: "fx" });
    return rows.slice(0,3);
  },[data,selectedMonth,reportCurrency,monthEnd,monthReference,savingsRate]);

  const runExport=async (task: () => Promise<void>,message: string) => {
    try { await task(); onToast(message); }
    catch(error) { onToast(`导出失败：${error instanceof Error? error.message:"未知错误"}`); }
  };
  const pdfReports=[
    ["monthly","月度"],["annual","年度"],["net-worth","净资产"],["investment","投资"],["asset","物品资产"],["fx","汇率"],["cashflow","现金流"],
  ] as const;
  const pngCharts=[
    ["income-expense","收入支出"],["savings","储蓄率"],["net-worth","净资产"],["assets","资产"],["currency","货币"],["fx","汇率"],["investment","投资"],["watchlist","Watchlist"],["cashflow","现金流"],
  ] as const;
  const hasReportData=current.rows.length>0;

  return <main className="main-content module-page reports-center-page">
    <header className="page-header module-header reports-header">
      <div><div className="breadcrumb">WEALTH ATLAS / MONEY CONSTELLATION</div><h1>报表中心</h1><p className="page-description">看清收入来源、支出去向和多币种资金分布。</p></div>
      <div className="reports-filters">
        <SharedMonthPicker ariaLabel="选择报表月份" />
        <label className="report-currency-control"><span>报告货币</span><select value={reportCurrency} onChange={(event) => setReportCurrency(event.target.value as CurrencyCode)} aria-label="选择报告货币">{currencies.map((currency) => <option value={currency} key={currency}>{currency}</option>)}</select></label>
        <button type="button" className={`secondary-button compact report-compare-button ${comparePrevious? "active":""}`} aria-pressed={comparePrevious} onClick={() => setComparePrevious((value) => !value)}><TrendUp size={16}/> 对比上个月</button>
      </div>
    </header>

    {!hasReportData?<section className="panel reports-empty"><ChartLineUp size={31}/><strong>{formatMonthLabel(selectedMonth)}还没有足够的报表资料</strong><span>这个月份没有未删除的收入或支出记录。账户和历史资料没有被修改。</span><button type="button" className="secondary-button compact" onClick={() => onNavigate("transactions")}>打开收支记录</button></section>:<>
      <section className="reports-summary" aria-label={`${formatMonthLabel(selectedMonth)}财务摘要`}>
        <article><Wallet size={20}/><span>本月收入</span><strong>{formatMoney(current.income,reportCurrency)}</strong><Delta current={current.income} previous={previous.income} enabled={comparePrevious}/></article>
        <article><Receipt size={20}/><span>本月支出</span><strong>{formatMoney(current.expense,reportCurrency)}</strong><Delta current={current.expense} previous={previous.expense} enabled={comparePrevious}/></article>
        <article><PiggyBank size={20}/><span>本月储蓄</span><strong>{formatMoney(current.saving,reportCurrency)}</strong><Delta current={current.saving} previous={previous.saving} enabled={comparePrevious}/></article>
        <article><ChartLineUp size={20}/><span>储蓄率</span><strong>{savingsRate===null? "暂无数据":`${savingsRate.toFixed(0)}%`}</strong>{savingsRate!==null&&previousSavingsRate!==null&&<Delta current={savingsRate} previous={previousSavingsRate} enabled={comparePrevious} points/>}</article>
      </section>
      {current.incomplete&&<div className="report-data-notice"><Warning size={17}/><span>部分记录缺少可用历史汇率，未计入报告货币汇总；原始交易保持不变。</span></div>}

      <section className="reports-split-grid">
        <article className="panel report-breakdown"><div className="panel-title-row"><div><h2>收入来自哪里</h2><span>按真实收入分类汇总，最多显示 3 个主要来源。</span></div><Wallet size={21}/></div><RankedList rows={incomeRows} total={current.income} currency={reportCurrency} compare={comparePrevious} onSelect={(category) => onOpenTransactions("income",category)}/></article>
        <article className="panel report-breakdown"><div className="panel-title-row"><div><h2>钱花到哪里</h2><span>按真实支出分类汇总，最多显示 5 个主要去向。</span></div><Receipt size={21}/></div><RankedList rows={expenseRows} total={current.expense} currency={reportCurrency} compare={comparePrevious} onSelect={(category) => onOpenTransactions("expense",category)}/></article>
      </section>

      <section className="panel money-constellation-panel">
        <div className="panel-title-row"><div><h2>资金星座</h2><span>只展示 {formatMonthLabel(selectedMonth)}真实出现的收入来源、账户和支出去向。</span></div><ChartLineUp size={21}/></div>
        <div className="money-constellation" aria-label="真实月度资金流">
          <div className="constellation-column"><h3>收入来源</h3>{incomeRows.slice(0,3).map((row) => <button type="button" className="constellation-node income" key={row.name} onClick={() => onOpenTransactions("income",row.name)}><span>{row.name}</span><b>{formatMoney(row.amount,reportCurrency)}</b></button>)}</div>
          <ArrowRight className="constellation-arrow" size={24}/>
          <div className="constellation-column"><h3>关联账户</h3>{accountFlows.map((row) => <div className="constellation-node account" key={row.account.id}><Bank size={17}/><span>{row.account.name}</span><b>{formatMoney(row.amount,reportCurrency)}</b></div>)}</div>
          <ArrowRight className="constellation-arrow" size={24}/>
          <div className="constellation-column"><h3>支出去向</h3>{expenseRows.slice(0,5).map((row) => <button type="button" className="constellation-node expense" key={row.name} onClick={() => onOpenTransactions("expense",row.name)}><span>{row.name}</span><b>{formatMoney(row.amount,reportCurrency)}</b></button>)}</div>
          {current.saving>0&&<><ArrowRight className="constellation-arrow" size={24}/><div className="constellation-column savings-column"><h3>结余</h3><div className="constellation-node saving"><PiggyBank size={17}/><span>本月储蓄</span><b>{formatMoney(current.saving,reportCurrency)}</b></div></div></>}
        </div>
      </section>

      <section className="reports-split-grid reports-bottom-grid">
        <article className="panel currency-distribution"><div className="panel-title-row"><div><h2>货币分布</h2><span>按所选月末账户余额和当时可用手动汇率计算。</span></div><Coins size={21}/></div><div className="currency-distribution-list">{currencyRows.map((row) => <div className="currency-distribution-row" key={row.currency}><div><strong>{row.currency}</strong><b>{row.percent.toFixed(0)}%</b></div><span className="report-bar" aria-hidden="true"><i style={{ width: `${row.percent}%` }}/></span><small>{row.value===null? "暂无汇率":`${formatMoney(row.value,reportCurrency)} 报告价值`}</small></div>)}</div><div className="currency-transfer-summary"><span>本月 SGD 转 MYR<strong>{formatMoney(transferredSgd,"SGD")}</strong></span><span>相对上月末汇率影响<strong className={fxImpact!==null&&fxImpact>=0? "report-positive":"report-warning"}>{fxImpact===null? "暂无可比较汇率":`${fxImpact>=0? "+":""}${formatMoney(fxImpact,"MYR")}`}</strong></span></div></article>
        <article className="panel report-suggestions"><div className="panel-title-row"><div><h2>建议调整</h2><span>最多 3 条，只根据当前本地资料生成。</span></div><CheckCircle size={21}/></div>{suggestions.length?<div className="suggestion-list">{suggestions.map((suggestion) => <button type="button" className={`suggestion-row ${suggestion.tone}`} key={suggestion.id} onClick={() => onNavigate(suggestion.destination)}><span><strong>{suggestion.title}</strong><small>{suggestion.detail}</small></span><ArrowRight size={16}/></button>)}</div>:<div className="reports-empty compact"><CheckCircle size={25}/><strong>目前没有需要调整的项目</strong><span>没有足够的真实资料时，系统不会生成提醒。</span></div>}</article>
      </section>
    </>}

    <details className="panel report-export-drawer"><summary><span><FileXls size={20}/><strong>导出与归档</strong></span><small>Excel、PDF 与 PNG</small></summary><div className="report-export-actions"><div className="report-export-group"><span>工作簿</span><button type="button" className="primary-button compact" onClick={() => void runExport(() => exportExcel(data),"Excel 已下载")}><FileXls size={16}/> 导出 Excel</button></div><div className="report-export-group"><span>PDF 报告</span><div className="button-row">{pdfReports.map(([key,label]) => <button type="button" className="secondary-button compact" key={key} onClick={() => void runExport(() => exportPdfReport(data,key,selectedMonth),`${label} PDF 已下载`)}><FilePdf size={15}/>{label}</button>)}</div></div><div className="report-export-group"><span>PNG 图表</span><div className="button-row">{pngCharts.map(([key,label]) => <button type="button" className="secondary-button compact" key={key} onClick={() => void runExport(() => exportChartPng(data,key,selectedMonth),`${label} PNG 已下载`)}><ChartLineUp size={15}/>{label}</button>)}</div></div><button type="button" className="text-button" onClick={() => onNavigate("insights")}>查看完整分析 <ArrowRight size={15}/></button></div></details>
  </main>;
}
