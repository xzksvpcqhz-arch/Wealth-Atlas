"use client";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ArrowRight, Bank, CalendarDots, ChartLineUp, Check, CloudArrowDown, DownloadSimple, FileCsv, FilePdf, FileXls, FloppyDisk, GearSix, HardDrives, Lightning, MagnifyingGlass, PencilSimple, Plus, ShieldCheck, Sparkle, Target, Trash, TrendUp, UploadSimple, WifiHigh, WifiSlash } from "@phosphor-icons/react";
import { detectDuplicateTransactions } from "@/lib/adapters";
import { exportChartPng as exportChartPngFile, exportExcel, exportPdfReport as exportPdfReportFile } from "@/lib/exporters";
import { formatMoney, getCashFlowForecast, getCashFlowForecastSet, getFinanceAlerts, getLocalDate, getWatchlistMetrics, totalExpensesInCurrency, totalIncomeInCurrency, totalInCurrency } from "@/lib/finance";
import ProtectedDeleteDialog from "@/components/ProtectedDeleteDialog";
import { SharedMonthPicker,formatMonthLabel,getMonthReferenceDate,getMonthStart,useSharedMonth } from "@/components/MonthPicker";
import type { CurrencyCode, FinancialReview, Liability, PlannedPayment, Transaction, Watchlist, WealthData } from "@/lib/types";
type AdvancedPage = "cashflow" | "watchlists" | "reports" | "analysis" | "integrations";
type Props = {
    page: AdvancedPage;
    data: WealthData;
    setData: Dispatch<SetStateAction<WealthData>>;
    onToast: (message: string, action?: () => void) => void;
    onNavigate: (page: string) => void;
};
const currencies: CurrencyCode[] = ["MYR", "SGD", "USD"];
const today = getLocalDate();
function useDeleteGuard() {
  const inFlightRef=useRef(false);
  const [isProcessing,setIsProcessing]=useState(false);
  const run=(operation: () => void) => {
    if(inFlightRef.current) return false;
    inFlightRef.current=true;
    setIsProcessing(true);
    try { operation(); return true; } finally { inFlightRef.current=false; setIsProcessing(false); }
  };
  return { isProcessing,run };
}
function makeId(prefix: string) {
    return `${prefix}-${crypto.randomUUID()}`;
}
function PageFrame({ eyebrow, title, description, children }: {
    eyebrow: string;
    title: string;
    description: string;
    children: React.ReactNode;
}) {
    return <main className="main-content module-page advanced-page"><div className="page-header module-header transaction-page-header"><div><div className="breadcrumb">WEALTH ATLAS / {eyebrow}</div><h1>{title}</h1><p className="page-description">{description}</p></div><div className="header-actions"><SharedMonthPicker ariaLabel={`选择${title}查看月份`} /></div></div>{children}</main>;
}
function MoneyPair({ label, value, currency }: {
    label: string;
    value: number;
    currency: CurrencyCode;
}) {
    return <div className="advanced-metric"><span>{label}</span><strong>{formatMoney(value, currency)}</strong></div>;
}
function getAccountForCurrency(data: WealthData, currency: CurrencyCode) {
    return data.accounts.find((account) => account.currency === currency)?.id ?? data.accounts[0]?.id ?? "";
}
function PlanForm({ data, onSave, editing, onCancelEdit }: {
    data: WealthData;
    onSave: (draft: PlannedPayment) => void;
    editing?: PlannedPayment | null;
    onCancelEdit?: () => void;
}) {
    const blankDraft = () => ({ name: "", amount: "0", currency: data.reportCurrency, due: today, cadence: "monthly" as PlannedPayment["cadence"], category: "固定支出", direction: "expense" as NonNullable<PlannedPayment["direction"]>, isFixed: true, isAnnualReserve: false });
    const [draft, setDraft] = useState(blankDraft);

    useEffect(() => {
        setDraft(editing ? {
            name: editing.name,
            amount: String(editing.amount),
            currency: editing.currency,
            due: editing.due,
            cadence: editing.cadence,
            category: editing.category,
            direction: editing.direction ?? "expense",
            isFixed: editing.isFixed ?? false,
            isAnnualReserve: editing.isAnnualReserve ?? false,
        } : blankDraft());
    }, [editing?.id, data.reportCurrency]);

    const update = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((current) => ({ ...current, [key]: value }));

    return <form className="panel advanced-form" onSubmit={(event) => {
        event.preventDefault();
        const amount = Number(draft.amount);
        if (!draft.name.trim() || !Number.isFinite(amount) || amount <= 0 || !draft.due) return;
        onSave({
            id: editing?.id ?? makeId("payment"),
            name: draft.name.trim(),
            amount,
            currency: draft.currency,
            due: draft.due,
            cadence: draft.cadence,
            category: draft.category.trim() || "固定支出",
            direction: draft.direction,
            accountId: editing?.accountId ?? getAccountForCurrency(data, draft.currency),
            isAutomatic: editing?.isAutomatic ?? false,
            isFixed: draft.isFixed,
            isAnnualReserve: draft.isAnnualReserve,
        });
    }}><div className="panel-title-row"><div><h2>{editing ? "编辑计划付款" : "新增计划付款"}</h2><span>发薪、账单、储蓄与投资都会进入未来现金流。</span></div><CalendarDots size={22}/></div><div className="form-grid"><label>名称<input required value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="例如：房租"/></label><label>金额<input required type="number" min="0" step="0.01" value={draft.amount} onChange={(event) => update("amount", event.target.value)}/></label></div><div className="form-grid"><label>货币<select value={draft.currency} onChange={(event) => update("currency", event.target.value as CurrencyCode)}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label><label>下次日期<input required type="date" value={draft.due} onChange={(event) => update("due", event.target.value)}/></label></div><div className="form-grid"><label>周期<select value={draft.cadence} onChange={(event) => update("cadence", event.target.value as PlannedPayment["cadence"])}><option value="once">一次</option><option value="monthly">每月</option><option value="yearly">每年</option></select></label><label>类别<input value={draft.category} onChange={(event) => update("category", event.target.value)}/></label></div><div className="form-grid"><label>方向<select value={draft.direction} onChange={(event) => update("direction", event.target.value as NonNullable<PlannedPayment["direction"]>)}><option value="income">预计收入</option><option value="expense">固定支出</option><option value="saving">储蓄转账</option><option value="investment">投资转账</option><option value="transfer">SGD 转 MYR</option></select></label><label className="checkbox-label"><input type="checkbox" checked={draft.isFixed} onChange={(event) => update("isFixed", event.target.checked)}/>固定支出</label></div><label className="checkbox-label"><input type="checkbox" checked={draft.isAnnualReserve} onChange={(event) => update("isAnnualReserve", event.target.checked)}/>年度预留</label><div className="inline-actions"><button className="primary-button" type="submit"><FloppyDisk size={17}/>{editing ? "保存计划变更" : "保存计划"}</button>{editing && <button className="secondary-button" type="button" onClick={() => onCancelEdit?.()}>取消编辑</button>}</div></form>;
}
function CashFlowPageLegacy({ data, setData, onToast }: Pick<Props, "data" | "setData" | "onToast">) {
    const forecasts = getCashFlowForecastSet(data, today);
    const [safety, setSafety] = useState(String(data.cashFlowSettings?.safetyBalance ?? 0));
    const savePayment = (payment: PlannedPayment) => { setData((current) => ({ ...current, plannedPayments: [...current.plannedPayments, payment] })); onToast("计划付款已保存，现金流预测已更新"); };
    const saveSafety = () => { const value = Number(safety); if (!Number.isFinite(value) || value < 0)
        return onToast("请输入有效的安全余额"); setData((current) => ({ ...current, cashFlowSettings: { safetyBalance: value, currency: current.reportCurrency } })); onToast("安全余额已保存"); };
    return <PageFrame eyebrow="CASH FLOW" title="未来现金流" description="把当前余额、预计余额、安全余额和可自由使用金额分开看。"><section className="module-summary forecast-summary"><MoneyPair label="当前余额" value={forecasts[30].startBalance} currency={forecasts[30].currency}/><MoneyPair label="预计 30 天余额" value={forecasts[30].endBalance} currency={forecasts[30].currency}/><MoneyPair label="安全余额" value={forecasts[30].safetyBalance} currency={forecasts[30].currency}/><MoneyPair label="可自由使用" value={forecasts[30].freeToSpend} currency={forecasts[30].currency}/></section><section className="forecast-grid">{([7, 30, 60, 90] as const).map((days) => { const forecast = forecasts[days]; return <article className="panel forecast-card" key={days}><div className="panel-title-row"><div><span>未来 {days} 天</span><h2>{formatMoney(forecast.endBalance, forecast.currency)}</h2></div><TrendUp size={20}/></div><div className="forecast-line"><span>预计收入</span><b className="positive">+{formatMoney(forecast.projectedIncome, forecast.currency)}</b></div><div className="forecast-line"><span>固定支出</span><b className="negative">-{formatMoney(forecast.fixedExpenses, forecast.currency)}</b></div><div className="forecast-line"><span>储蓄 / 投资</span><b>-{formatMoney(forecast.plannedSavings + forecast.plannedInvestments, forecast.currency)}</b></div></article>; })}<article className="panel forecast-card forecast-month-end"><div className="panel-title-row"><div><span>预计月底余额</span><h2>{formatMoney(forecasts.monthEnd.endBalance, forecasts.monthEnd.currency)}</h2></div><ShieldCheck size={20}/></div><p>现金流安全边界为 {formatMoney(forecasts.monthEnd.safetyBalance, forecasts.monthEnd.currency)}，可自由使用 {formatMoney(forecasts.monthEnd.freeToSpend, forecasts.monthEnd.currency)}。</p></article></section><div className="advanced-two-column"><PlanForm data={data} onSave={savePayment}/><section className="panel"><div className="panel-title-row"><div><h2>安全余额</h2><span>只用于预测，不会改变账户余额。</span></div><ShieldCheck size={22}/></div><div className="form-stack"><label>安全余额（{data.reportCurrency}）<input type="number" min="0" step="0.01" value={safety} onChange={(event) => setSafety(event.target.value)}/></label><button type="button" className="secondary-button" onClick={saveSafety}>保存安全余额</button></div></section></div><section className="panel forecast-calendar"><div className="panel-title-row"><div><h2>计划付款日历</h2><span>只显示未来 90 天，重复付款会展开为实际日期。</span></div><CalendarDots size={22}/></div>{forecasts[90].occurrences.length ? <div className="calendar-list">{forecasts[90].occurrences.map((item) => <div className="calendar-row" key={item.id}><div><strong>{item.date}</strong><span>{item.name} · {item.kind === "income" ? "预计收入" : item.kind === "saving" ? "储蓄" : item.kind === "investment" ? "投资" : item.kind === "transfer" ? "SGD 转 MYR" : "固定支出"}</span></div><b className={item.kind === "income" ? "positive" : "negative"}>{item.kind === "income" ? "+" : item.kind === "transfer" ? "↔ " : "-"}{formatMoney(item.amount, item.currency)}</b><small>{item.fixed ? "固定" : "计划"}{item.annualReserve ? " · 年度预留" : ""}</small></div>)}</div> : <div className="empty-state compact-empty"><CalendarDots size={28}/><strong>未来 90 天没有计划付款</strong><span>添加发薪日、房租、保险、订阅或 SGD 转 MYR 日期。</span></div>}</section></PageFrame>;
}
function WatchlistForm({ data, onSave, editing, onCancelEdit }: {
    data: WealthData;
    onSave: (watchlist: Watchlist) => void;
    editing?: Watchlist | null;
    onCancelEdit?: () => void;
}) {
    const blankDraft = () => ({ name: "", category: "", merchant: "", currency: data.reportCurrency as CurrencyCode, limit: "800", warningAmount: "640", tags: "", itemType: "" });
    const [draft, setDraft] = useState(blankDraft);

    useEffect(() => {
        setDraft(editing ? {
            name: editing.name,
            category: editing.category ?? "",
            merchant: editing.merchant ?? "",
            currency: editing.currency,
            limit: String(editing.limit),
            warningAmount: String(editing.warningAmount ?? editing.limit * .8),
            tags: (editing.tags ?? []).join(", "),
            itemType: editing.itemType ?? "",
        } : blankDraft());
    }, [editing?.id, data.reportCurrency]);

    const update = (key: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));

    return <form className="panel advanced-form" onSubmit={(event) => {
        event.preventDefault();
        const limit = Number(draft.limit);
        const warningAmount = Number(draft.warningAmount);
        if (!draft.name.trim() || !Number.isFinite(limit) || limit <= 0) return;
        onSave({
            ...(editing ?? {}),
            id: editing?.id ?? makeId("watch"),
            name: draft.name.trim(),
            category: draft.category.trim() || undefined,
            merchant: draft.merchant.trim() || undefined,
            currency: draft.currency,
            limit,
            warningAmount: Number.isFinite(warningAmount) && warningAmount >= 0 ? warningAmount : limit * .8,
            spent: editing?.spent ?? 0,
            average: editing?.average ?? 0,
            forecast: editing?.forecast ?? 0,
            tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
            itemType: draft.itemType.trim() || undefined,
        });
    }}><div className="panel-title-row"><div><h2>{editing ? "编辑 Watchlist" : "新增 Watchlist"}</h2><span>按分类、商户、账户、币种或物品类型追踪支出。</span></div><MagnifyingGlass size={22}/></div><label>名称<input required value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="例如：外食"/></label><div className="form-grid"><label>分类<input value={draft.category} onChange={(event) => update("category", event.target.value)} placeholder="外食"/></label><label>商户<input value={draft.merchant} onChange={(event) => update("merchant", event.target.value)} placeholder="Grab"/></label></div><div className="form-grid"><label>货币<select value={draft.currency} onChange={(event) => update("currency", event.target.value)}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label><label>预算<input type="number" min="0" step="0.01" value={draft.limit} onChange={(event) => update("limit", event.target.value)}/></label></div><div className="form-grid"><label>警戒金额<input type="number" min="0" step="0.01" value={draft.warningAmount} onChange={(event) => update("warningAmount", event.target.value)}/></label><label>标签<input value={draft.tags} onChange={(event) => update("tags", event.target.value)} placeholder="外食,生活"/></label></div><label>物品类型（可选）<input value={draft.itemType} onChange={(event) => update("itemType", event.target.value)} placeholder="电脑、课程、会员"/></label><div className="inline-actions"><button className="primary-button" type="submit"><FloppyDisk size={17}/>{editing ? "保存 Watchlist" : "保存 Watchlist"}</button>{editing && <button type="button" className="secondary-button" onClick={() => onCancelEdit?.()}>取消编辑</button>}</div></form>;
}
function WatchlistsPageLegacy({ data, setData, onToast }: Pick<Props, "data" | "setData" | "onToast">) {
    const [query, setQuery] = useState("");
    const saveWatchlist = (watchlist: Watchlist) => { setData((current) => ({ ...current, watchlists: [...current.watchlists, watchlist] })); onToast("Watchlist 已保存"); };
    const metrics = data.watchlists.map((watchlist) => getWatchlistMetrics(data, watchlist, today.slice(0, 7), today)).filter((item) => !query || item.name.toLowerCase().includes(query.toLowerCase()));
    return <PageFrame eyebrow="WATCHLISTS" title="Watchlist" description="关注正在变快的支出，而不是等月底才发现超支。"><div className="advanced-toolbar"><label className="search-field"><MagnifyingGlass size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Watchlist"/></label><span>{metrics.length} 个关注项</span></div><section className="watchlist-grid">{metrics.length ? metrics.map((item) => <article className="panel watchlist-card" key={item.id}><div className="panel-title-row"><div><h2>{item.name}</h2><span>{[item.category, item.merchant, item.itemType].filter(Boolean).join(" · ") || "自定义支出范围"}</span></div><span className={`status-chip ${item.overBudget ? "risk" : item.warning ? "attention" : "safe"}`}>{item.overBudget ? "可能超支" : item.warning ? "接近警戒" : "正常"}</span></div><div className="watchlist-number"><strong>{formatMoney(item.monthSpent, item.currency)}</strong><span>本月已用 / {formatMoney(item.limit, item.currency)}</span></div><div className="watchlist-bar"><span style={{ width: `${Math.min(100, item.limit ? (item.monthSpent / item.limit) * 100 : 0)}%` }}/></div><div className="watchlist-details"><div><span>12 个月平均</span><b>{formatMoney(item.average12Months, item.currency)}</b></div><div><span>当前支出速度</span><b>{formatMoney(item.spendRate, item.currency)} / 日</b></div><div><span>预计月底</span><b>{formatMoney(item.forecastAtMonthEnd, item.currency)}</b></div><div><span>警戒金额</span><b>{formatMoney(item.warningAmount ?? item.limit * 0.8, item.currency)}</b></div></div></article>) : <div className="panel empty-state"><MagnifyingGlass size={30}/><strong>还没有 Watchlist</strong><span>从外食、购物、订阅或物品类型开始追踪。</span></div>}</section><WatchlistForm data={data} onSave={saveWatchlist}/></PageFrame>;
}
function CashFlowPage({ data, setData, onToast }: Pick<Props, "data" | "setData" | "onToast">) {
  const [selectedMonth]=useSharedMonth(today.slice(0,7));
  const forecastStart=getMonthStart(selectedMonth);
  const isHistoricalMonth=selectedMonth<today.slice(0,7);
  const forecasts=getCashFlowForecastSet(data,forecastStart);
  const [deleteTarget,setDeleteTarget]=useState<PlannedPayment | null>(null);
  const [editingPayment,setEditingPayment]=useState<PlannedPayment | null>(null);
  const { isProcessing,run }=useDeleteGuard();
  const savePayment=(payment: PlannedPayment) => {
    setData((current) => {
      const exists=current.plannedPayments.some((item) => item.id===payment.id);
      return { ...current,plannedPayments: exists ? current.plannedPayments.map((item) => item.id===payment.id ? payment : item) : [...current.plannedPayments,payment] };
    });
    setEditingPayment(null);
    onToast(editingPayment ? "计划付款已更新，现金流预测已刷新" : "计划付款已保存，现金流预测已更新");
  };
  const confirmDelete=() => {
    const target=deleteTarget;
    if(!target) return;
    run(() => {
      setData((current) => ({ ...current,plannedPayments: current.plannedPayments.filter((item) => item.id!==target.id) }));
      setEditingPayment((current) => current?.id===target.id ? null : current);
      setDeleteTarget(null);
      onToast("计划付款已删除，现金流预测已更新");
    });
  };
  return <PageFrame eyebrow="CASH FLOW" title="未来现金流" description={isHistoricalMonth? `${formatMonthLabel(selectedMonth)}没有已保存的历史预测；以下计划从所选月份起计算，仅供回看。`:`从 ${formatMonthLabel(selectedMonth)} 起查看预测；计划付款不会自动生成交易。`}>
    <section className="module-summary forecast-summary"><MoneyPair label="当前余额" value={forecasts[30].startBalance} currency={forecasts[30].currency}/><MoneyPair label="预计 30 天余额" value={forecasts[30].endBalance} currency={forecasts[30].currency}/><MoneyPair label="安全余额" value={forecasts[30].safetyBalance} currency={forecasts[30].currency}/><MoneyPair label="可自由使用" value={forecasts[30].freeToSpend} currency={forecasts[30].currency}/></section>
    <div className="advanced-two-column"><PlanForm data={data} onSave={savePayment} editing={editingPayment} onCancelEdit={() => setEditingPayment(null)}/><section className="panel planned-payment-panel"><div className="panel-title-row"><div><h2>已保存计划付款</h2><span>删除只移除未来预测，不会影响账户、交易或历史记录。</span></div><CalendarDots size={22}/></div>{data.plannedPayments.length?<div className="planned-payment-list">{data.plannedPayments.map((item) => <div className="planned-payment-row" key={item.id}><div><strong>{item.name}</strong><span>{item.due} · {item.cadence==="monthly"? "每月":item.cadence==="yearly"? "每年":"一次"}</span></div><b>{formatMoney(item.amount,item.currency)}</b><div className="planned-payment-actions"><button type="button" className="icon-button" onClick={() => setEditingPayment(item)} aria-label={"编辑计划付款 "+item.name} title={"编辑计划付款 "+item.name} disabled={isProcessing}><PencilSimple size={16}/></button><button type="button" className="icon-button danger-icon" onClick={() => setDeleteTarget(item)} aria-label={"删除计划付款 "+item.name} title={"删除计划付款 "+item.name} disabled={isProcessing}><Trash size={16}/></button></div></div>)}</div>:<div className="empty-state compact-empty"><CalendarDots size={28}/><strong>还没有计划付款</strong></div>}</section></div>
    <section className="panel forecast-calendar"><div className="panel-title-row"><div><h2>未来 90 天付款日历</h2><span>按当前计划展开，金额不会写入正式账本。</span></div><TrendUp size={22}/></div>{forecasts[90].occurrences.length?<div className="calendar-list">{forecasts[90].occurrences.map((item) => <div className="calendar-row" key={item.id}><div><strong>{item.date}</strong><span>{item.name}</span></div><b>{formatMoney(item.amount,item.currency)}</b></div>)}</div>:<div className="empty-state compact-empty"><strong>未来 90 天没有计划付款</strong></div>}</section>
    {deleteTarget&&<ProtectedDeleteDialog title="删除计划付款" titleId="delete-planned-payment" lead={deleteTarget.name} summary={<div className="confirm-record-summary"><div><span>下次日期</span><strong>{deleteTarget.due}</strong></div><div><span>金额</span><strong>{formatMoney(deleteTarget.amount,deleteTarget.currency)}</strong></div><div><span>货币</span><strong>{deleteTarget.currency}</strong></div><div><span>处理方式</span><strong>移除未来预测</strong></div></div>} warning="删除后会立即从现金流日历与预测中移除；不会删除任何交易、账户余额或历史记录。" confirmLabel="确认删除计划付款" onCancel={() => setDeleteTarget(null)} onConfirm={confirmDelete} isProcessing={isProcessing}/>}
  </PageFrame>;
}

function WatchlistsPage({ data, setData, onToast }: Pick<Props, "data" | "setData" | "onToast">) {
  const [selectedMonth]=useSharedMonth(today.slice(0,7));
  const [query,setQuery]=useState("");
  const [deleteTarget,setDeleteTarget]=useState<Watchlist | null>(null);
  const [editingWatchlist,setEditingWatchlist]=useState<Watchlist | null>(null);
  const { isProcessing,run }=useDeleteGuard();
  const monthReference=getMonthReferenceDate(selectedMonth,today);
  const metrics=data.watchlists.map((watchlist) => getWatchlistMetrics(data,watchlist,selectedMonth,monthReference)).filter((item) => !query||item.name.toLowerCase().includes(query.toLowerCase()));
  const saveWatchlist=(watchlist: Watchlist) => {
    setData((current) => {
      const exists=current.watchlists.some((item) => item.id===watchlist.id);
      return { ...current,watchlists: exists ? current.watchlists.map((item) => item.id===watchlist.id ? watchlist : item) : [...current.watchlists,watchlist] };
    });
    setEditingWatchlist(null);
    onToast(editingWatchlist ? "Watchlist 已更新" : "Watchlist 已保存");
  };
  const confirmDelete=() => {
    const target=deleteTarget;
    if(!target) return;
    run(() => {
      setData((current) => ({ ...current,watchlists: current.watchlists.filter((item) => item.id!==target.id) }));
      setEditingWatchlist((current) => current?.id===target.id ? null : current);
      setDeleteTarget(null);
      onToast("Watchlist 已删除，交易和预算未改变");
    });
  };
  return <PageFrame eyebrow="WATCHLISTS" title="Watchlist" description="追踪支出速度与预算提醒；删除规则不会删除任何交易。"><div className="advanced-toolbar"><label className="search-field"><MagnifyingGlass size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Watchlist"/></label><span>{metrics.length} 个关注项</span></div><section className="watchlist-grid">{metrics.length?metrics.map((item) => <article className="panel watchlist-card" key={item.id}><div className="panel-title-row"><div><h2>{item.name}</h2><span>{[item.category,item.merchant,item.itemType].filter(Boolean).join(" · ")||"自定义支出范围"}</span></div><div className="watchlist-card-actions"><span className={"status-chip "+(item.overBudget?"risk":item.warning?"attention":"safe")}>{item.overBudget?"可能超支":item.warning?"接近警戒":"正常"}</span><button type="button" className="icon-button" onClick={() => setEditingWatchlist(data.watchlists.find((watchlist) => watchlist.id===item.id)??null)} aria-label={"编辑 Watchlist "+item.name} title={"编辑 Watchlist "+item.name} disabled={isProcessing}><PencilSimple size={16}/></button><button type="button" className="icon-button danger-icon" onClick={() => setDeleteTarget(data.watchlists.find((watchlist) => watchlist.id===item.id)??null)} aria-label={"删除 Watchlist "+item.name} title={"删除 Watchlist "+item.name} disabled={isProcessing}><Trash size={16}/></button></div></div><div className="watchlist-number"><strong>{formatMoney(item.monthSpent,item.currency)}</strong><span>本月已用 / {formatMoney(item.limit,item.currency)}</span></div><div className="watchlist-bar"><span style={{ width: String(Math.min(100,item.limit?item.monthSpent/item.limit*100:0))+"%" }}/></div></article>):<div className="panel empty-state"><MagnifyingGlass size={30}/><strong>还没有 Watchlist</strong></div>}</section><WatchlistForm data={data} onSave={saveWatchlist} editing={editingWatchlist} onCancelEdit={() => setEditingWatchlist(null)}/>{deleteTarget&&<ProtectedDeleteDialog title="删除 Watchlist" titleId="delete-watchlist" lead={deleteTarget.name} summary={<div className="confirm-record-summary"><div><span>预算</span><strong>{formatMoney(deleteTarget.limit,deleteTarget.currency)}</strong></div><div><span>警戒金额</span><strong>{formatMoney(deleteTarget.warningAmount??deleteTarget.limit*.8,deleteTarget.currency)}</strong></div><div><span>货币</span><strong>{deleteTarget.currency}</strong></div><div><span>处理方式</span><strong>仅删除提醒规则</strong></div></div>} warning="这只会删除 Watchlist 规则和提醒，不会删除交易、账户或预算。" confirmLabel="确认删除 Watchlist" onCancel={() => setDeleteTarget(null)} onConfirm={confirmDelete} isProcessing={isProcessing}/>}</PageFrame>;
}
function simulateDebt(liability: Liability, extra: number) {
    let balance = liability.remainingPrincipal;
    let months = 0;
    let interest = 0;
    const monthlyRate = liability.interestRate / 100 / 12;
    while (balance > 0.01 && months < 600) {
        const accrued = balance * monthlyRate;
        interest += accrued;
        const payment = Math.max(1, liability.minimumPayment + extra);
        balance = Math.max(0, balance + accrued - payment);
        months += 1;
    }
    const payoff = new Date(`${today}T00:00:00Z`);
    payoff.setUTCMonth(payoff.getUTCMonth() + months);
    return { months, interest, remaining: balance, payoff: payoff.toISOString().slice(0, 7) };
}
function AnalysisPage({ data, setData, onToast }: Pick<Props, "data" | "setData" | "onToast">) {
    const [selectedMonth] = useSharedMonth(today.slice(0,7));
    const [extra, setExtra] = useState("300");
    const [review, setReview] = useState<Partial<FinancialReview>>({ period: selectedMonth });
    useEffect(() => { setReview((current) => ({ ...current, period: selectedMonth })); }, [selectedMonth]);
    const activeDebt = (data.liabilities ?? []).find((item) => item.status === "active");
    const debt = activeDebt ?? { id: "demo", name: "示例负债", type: "loan" as const, principal: 10000, remainingPrincipal: 10000, interestRate: 4.5, minimumPayment: 400, currency: "MYR" as CurrencyCode, status: "active" as const };
    const scenarios = [{ name: "方案 A：每月多还 MYR 300", value: 300 }, { name: "方案 B：每月多还 MYR 600", value: 600 }, { name: "方案 C：暂不提前还款，优先建立预备金", value: 0 }].map((scenario) => ({ ...scenario, result: simulateDebt(debt, scenario.value) }));
    const cash = totalInCurrency(data, data.reportCurrency);
    const investments = (data.investments ?? []).reduce((sum, item) => sum + (item.currentValue * 1), 0);
    const assets = data.assets.reduce((sum, item) => sum + item.currentValue, 0);
    const liabilities = (data.liabilities ?? []).reduce((sum, item) => sum + item.remainingPrincipal, 0);
    const saveReview = () => { if (!review.period)
        return onToast("请先选择复盘期间"); const next = { id: makeId("review"), period: review.period, good: review.good, overspend: review.overspend, largestExpense: review.largestExpense, goals: review.goals, investment: review.investment, fx: review.fx, nextPlan: review.nextPlan, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; setData((current) => ({ ...current, reviews: [...(current.reviews ?? []).filter((item) => item.period !== next.period), next] })); onToast("复盘已保存"); };
    return <PageFrame eyebrow="ANALYSIS" title="分析与复盘" description="把负债、资金流和资产变化拆开，帮助下一步行动更具体。"><section className="panel analysis-block"><div className="panel-title-row"><div><h2>债务还款模拟器</h2><span>模拟不会修改真实负债或账户数据。</span></div><Lightning size={22}/></div><div className="form-grid"><label>额外还款<input type="number" min="0" step="100" value={extra} onChange={(event) => setExtra(event.target.value)}/></label><div className="analysis-context"><span>{debt.name}</span><strong>{formatMoney(debt.remainingPrincipal, debt.currency)}</strong><small>利率 {debt.interestRate}% · 最低还款 {formatMoney(debt.minimumPayment, debt.currency)}</small></div></div><div className="scenario-grid">{scenarios.map((scenario) => <article key={scenario.name}><strong>{scenario.name}</strong><div><span>预计还清</span><b>{scenario.result.payoff}</b></div><div><span>总利息</span><b>{formatMoney(scenario.result.interest, debt.currency)}</b></div><div><span>还款期</span><b>{scenario.result.months} 个月</b></div></article>)}</div><p className="form-help">方案只用于比较提前还款、现金流和预备金之间的取舍，不是金融建议。</p></section><section className="panel flow-panel"><div className="panel-title-row"><div><h2>资金流</h2><span>按当前账户、转账和计划方向查看资金路径。</span></div><ArrowRight size={22}/></div><div className="flow-map"><div className="flow-node source"><Bank size={19}/><strong>SGD 工资</strong><span>收入与 SGD 账户</span></div><div className="flow-branches"><div>转入 MYR</div><div>新加坡支出</div><div>USD 投资</div></div><div className="flow-node target"><Target size={19}/><strong>MYR 生活</strong><span>支出、目标与自由使用</span></div></div><div className="decomposition-grid"><MoneyPair label="现金与账户" value={cash} currency={data.reportCurrency}/><MoneyPair label="投资变化" value={investments} currency={data.reportCurrency}/><MoneyPair label="物品资产" value={assets} currency={data.reportCurrency}/><MoneyPair label="负债" value={-liabilities} currency={data.reportCurrency}/><MoneyPair label="储蓄增加" value={totalIncomeInCurrency(data, data.reportCurrency) - totalExpensesInCurrency(data, data.reportCurrency)} currency={data.reportCurrency}/><MoneyPair label="汇率变化" value={0} currency={data.reportCurrency}/><MoneyPair label="其他变化" value={0} currency={data.reportCurrency}/></div></section><section className="panel review-panel"><div className="panel-title-row"><div><h2>财务复盘</h2><span>先保存事实，再写下下个月的调整动作。</span></div><Sparkle size={22}/></div><div className="form-grid"><label>期间<input type="month" value={review.period ?? ""} onChange={(event) => setReview((current) => ({ ...current, period: event.target.value }))}/></label><label>本月做得好的地方<input value={review.good ?? ""} onChange={(event) => setReview((current) => ({ ...current, good: event.target.value }))}/></label></div><div className="form-grid"><label>本月超支项目<input value={review.overspend ?? ""} onChange={(event) => setReview((current) => ({ ...current, overspend: event.target.value }))}/></label><label>本月最大支出<input value={review.largestExpense ?? ""} onChange={(event) => setReview((current) => ({ ...current, largestExpense: event.target.value }))}/></label></div><div className="form-grid"><label>储蓄目标完成情况<input value={review.goals ?? ""} onChange={(event) => setReview((current) => ({ ...current, goals: event.target.value }))}/></label><label>投资与汇率变化<input value={`${review.investment ?? ""}${review.fx ? ` / ${review.fx}` : ""}`} onChange={(event) => setReview((current) => ({ ...current, investment: event.target.value }))}/></label></div><label>下个月调整计划<textarea value={review.nextPlan ?? ""} onChange={(event) => setReview((current) => ({ ...current, nextPlan: event.target.value }))}/></label><button type="button" className="primary-button" onClick={saveReview}><FloppyDisk size={17}/>保存复盘</button>{(data.reviews ?? []).length > 0 && <div className="saved-review-list">{(data.reviews ?? []).slice(-3).reverse().map((item) => <div key={item.id}><strong>{item.period}</strong><span>{item.nextPlan || item.good || "已保存复盘"}</span></div>)}</div>}</section></PageFrame>;
}
function parseCsv(text: string, data: WealthData) {
    const lines = text.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2)
        return [];
    const headers = lines[0].split(",").map((header) => header.trim().toLowerCase());
    return lines.slice(1).map((line) => {
        const values = line.split(",").map((value) => value.trim());
        const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
        const currency = currencies.includes(row.currency as CurrencyCode) ? row.currency as CurrencyCode : data.reportCurrency;
        const type: Transaction["type"] = row.type === "income" ? "income" : "expense";
        return { type, accountId: row.accountid || getAccountForCurrency(data, currency), amount: Number(row.amount) || 0, currency, category: row.category || "CSV 导入", merchant: row.merchant || undefined, date: row.date || today, note: row.note || undefined };
    }).filter((row) => row.amount > 0 && row.date);
}
function IntegrationsPageLegacy({ data, setData, onToast }: Pick<Props, "data" | "setData" | "onToast">) {
    const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
    const [installEvent, setInstallEvent] = useState<Event | null>(null);
    const pendingImports = (data.importReviews ?? []).filter((item) => item.status === "pending");
    useEffect(() => { const onlineHandler = () => setOnline(true); const offlineHandler = () => setOnline(false); window.addEventListener("online", onlineHandler); window.addEventListener("offline", offlineHandler); if (process.env.NODE_ENV === "production") void navigator.serviceWorker?.register("/sw.js"); const handler = (event: Event) => { event.preventDefault(); setInstallEvent(event); }; window.addEventListener("beforeinstallprompt", handler); return () => { window.removeEventListener("online", onlineHandler); window.removeEventListener("offline", offlineHandler); window.removeEventListener("beforeinstallprompt", handler); }; }, []);
    const handleFile = async (file: File) => { const text = await file.text(); const rows = parseCsv(text, data); const duplicates = detectDuplicateTransactions(data.transactions, rows as Transaction[]); if (!rows.length)
        return onToast("CSV 中没有可审核的有效记录"); const review = { id: makeId("import"), fileName: file.name, importedAt: new Date().toISOString(), status: "pending" as const, duplicateCount: duplicates.length, rows }; setData((current) => ({ ...current, importReviews: [...(current.importReviews ?? []), review] })); onToast(duplicates.length ? `CSV 已进入审核，${duplicates.length} 笔可能重复` : "CSV 已进入审核中心"); };
    const applyImport = (id: string) => { const review = (data.importReviews ?? []).find((item) => item.id === id); if (!review || review.status !== "pending")
        return; const transactions = review.rows.map((row) => ({ ...row, id: makeId("csv"), convertedAmount: row.amount, convertedCurrency: row.currency } as Transaction)); setData((current) => ({ ...current, transactions: [...transactions, ...current.transactions], importReviews: (current.importReviews ?? []).map((item) => item.id === id ? { ...item, status: "applied", appliedTransactionIds: transactions.map((transaction) => transaction.id) } : item) })); onToast("CSV 导入已应用，可以在回收站恢复撤销的数据"); };
    const undoImport = (id: string) => { const review = (data.importReviews ?? []).find((item) => item.id === id); if (!review?.appliedTransactionIds?.length)
        return; const deletedAt = new Date().toISOString(); setData((current) => ({ ...current, transactions: current.transactions.map((item) => review.appliedTransactionIds?.includes(item.id) ? { ...item, deleted: true, deletedAt } : item), importReviews: (current.importReviews ?? []).map((item) => item.id === id ? { ...item, status: "undone" } : item) })); onToast("CSV 导入已撤销，记录保留在回收站"); };
    const install = async () => { const prompt = installEvent as (Event & {
        prompt?: () => Promise<void>;
        userChoice?: Promise<unknown>;
    }) | null; if (!prompt?.prompt)
        return onToast("当前浏览器还没有提供安装提示"); await prompt.prompt(); setInstallEvent(null); };
    const importHistory = (data.importReviews ?? []).filter((item) => item.status !== "pending");
    return <PageFrame eyebrow="INTEGRATIONS" title="保险管理" description="保险与外部连接管理。外部连接默认关闭，CSV 先进入审核中心，不会直接写入正式流水。"><section className="integration-status-grid"><article className="panel integration-status"><div className="status-icon">{online ? <WifiHigh size={24}/> : <WifiSlash size={24}/>}</div><div><strong>{online ? "在线" : "离线"}</strong><span>{online ? "IndexedDB 可以继续保存本地记录" : "当前离线，记录会留在本地"}</span></div></article><article className="panel integration-status"><div className="status-icon"><HardDrives size={24}/></div><div><strong>银行同步 Adapter 已关闭</strong><span>没有服务连接，也不会上传真实资料。</span><button type="button" className="text-button" onClick={() => onToast("银行连接前需要明确授权；当前版本只保留接口，不会上传资料。")}>查看权限说明</button></div></article><article className="panel integration-status"><div className="status-icon"><TrendUp size={24}/></div><div><strong>实时汇率 Adapter 已关闭</strong><span>手动汇率优先，历史快照不变。</span><button type="button" className="text-button" onClick={() => onToast("实时汇率只作参考；当前版本不启用 API，也不会修改历史汇率。")}>查看权限说明</button></div></article></section><section className="advanced-two-column"><section className="panel import-panel"><div className="panel-title-row"><div><h2>CSV 审核中心</h2><span>支持 date,type,amount,currency,category,merchant,note,accountId 列。</span></div><FileCsv size={22}/></div><label className="file-drop"><UploadSimple size={22}/><span>选择 CSV 文件</span><input type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file)
        void handleFile(file); event.currentTarget.value = ""; }}/></label>{pendingImports.length ? pendingImports.map((review) => <div className="import-review-row" key={review.id}><div><strong>{review.fileName}</strong><span>{review.rows.length} 笔待审核 · {new Date(review.importedAt).toLocaleString("zh-CN")}</span></div><div><button type="button" className="secondary-button compact" onClick={() => applyImport(review.id)}>应用导入</button><button type="button" className="text-button" onClick={() => setData((current) => ({ ...current, importReviews: (current.importReviews ?? []).map((item) => item.id === review.id ? { ...item, status: "undone" } : item) }))}>取消</button></div></div>) : <div className="empty-state compact-empty"><FileCsv size={28}/><strong>没有待审核导入</strong><span>导入后的数据会先停在这里。</span></div>}</section><section className="panel"><div className="panel-title-row"><div><h2>PWA 安装</h2><span>安装后可以离线查看最近的本地数据。</span></div><CloudArrowDown size={22}/></div><div className="pwa-card"><strong>Wealth Atlas</strong><span>{installEvent ? "浏览器已准备好安装" : "如果浏览器支持，安装提示会在这里出现"}</span><button type="button" className="primary-button" onClick={install}><DownloadSimple size={17}/>安装到设备</button></div><div className="integration-note"><ShieldCheck size={18}/><span>银行同步和实时汇率只保留 Adapter 接口，默认关闭。</span></div><section className="panel import-history"><div className="panel-title-row"><div><h2>导入历史</h2><span>应用后的导入仍可撤销，撤销会软删除导入交易。</span></div><FileCsv size={22}/></div>{importHistory.length ? importHistory.slice(-8).reverse().map((review) => <div className="import-review-row" key={review.id}><div><strong>{review.fileName}</strong><small>{review.status === "applied" ? "已应用" : "已撤销"} · {review.duplicateCount ?? 0} 笔可能重复</small></div>{review.status === "applied" && <button type="button" className="secondary-button compact" onClick={() => undoImport(review.id)}>撤销导入</button>}</div>) : <div className="empty-state compact-empty"><Check size={28}/><strong>还没有导入历史</strong><span>CSV 应用后会显示在这里。</span></div>}</section></section></section></PageFrame>;
}
type ImportActionTarget = {
    id: string;
    fileName: string;
    rowCount: number;
    mode: "cancel" | "undo";
};

function IntegrationsPage({ data, setData, onToast }: Pick<Props, "data" | "setData" | "onToast">) {
    const [selectedMonth] = useSharedMonth(today.slice(0,7));
    const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
    const [installEvent, setInstallEvent] = useState<Event | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<ImportActionTarget | null>(null);
    const { isProcessing, run } = useDeleteGuard();
    const pendingImports = (data.importReviews ?? []).filter((item) => item.status === "pending");
    const importHistory = (data.importReviews ?? []).filter((item) => item.status !== "pending" && getLocalDate(new Date(item.importedAt)).slice(0,7) === selectedMonth);

    useEffect(() => {
        const onlineHandler = () => setOnline(true);
        const offlineHandler = () => setOnline(false);
        const promptHandler = (event: Event) => { event.preventDefault(); setInstallEvent(event); };
        window.addEventListener("online", onlineHandler);
        window.addEventListener("offline", offlineHandler);
        window.addEventListener("beforeinstallprompt", promptHandler);
        if (process.env.NODE_ENV === "production") {
            void navigator.serviceWorker?.register("/sw.js");
        }
        return () => {
            window.removeEventListener("online", onlineHandler);
            window.removeEventListener("offline", offlineHandler);
            window.removeEventListener("beforeinstallprompt", promptHandler);
        };
    }, []);

    const handleFile = async (file: File) => {
        try {
            const text = await file.text();
            const rows = parseCsv(text, data);
            const duplicates = detectDuplicateTransactions(data.transactions, rows as Transaction[]);
            if (!rows.length) {
                onToast("CSV 中没有可审核的有效记录");
                return;
            }
            const review = { id: makeId("import"), fileName: file.name, importedAt: new Date().toISOString(), status: "pending" as const, duplicateCount: duplicates.length, rows };
            setData((current) => ({ ...current, importReviews: [...(current.importReviews ?? []), review] }));
            onToast(duplicates.length ? `CSV 已进入审核，${duplicates.length} 笔可能重复` : "CSV 已进入审核中心");
        } catch (error) {
            onToast(`读取 CSV 失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
    };

    const applyImport = (id: string) => {
        const review = (data.importReviews ?? []).find((item) => item.id === id);
        if (!review || review.status !== "pending") {
            onToast("这份导入已不在待审核列表，请刷新后重试");
            return;
        }
        const transactions = review.rows.map((row) => ({ ...row, id: makeId("csv"), convertedAmount: row.amount, convertedCurrency: row.currency } as Transaction));
        setData((current) => ({
            ...current,
            transactions: [...transactions, ...current.transactions],
            importReviews: (current.importReviews ?? []).map((item) => item.id === id ? { ...item, status: "applied", appliedTransactionIds: transactions.map((transaction) => transaction.id) } : item),
        }));
        onToast("CSV 导入已应用，可以在回收站恢复撤销的数据");
    };

    const confirmImportAction = () => {
        const target = deleteTarget;
        if (!target) return;
        const exists = (data.importReviews ?? []).some((item) => item.id === target.id && (target.mode === "cancel" ? item.status === "pending" : item.status === "applied"));
        if (!exists) {
            setDeleteTarget(null);
            onToast("这份导入状态已改变，请刷新后查看");
            return;
        }
        run(() => {
            setData((current) => {
                const currentReview = (current.importReviews ?? []).find((item) => item.id === target.id);
                if (!currentReview) return current;
                if (target.mode === "cancel") {
                    return { ...current, importReviews: (current.importReviews ?? []).map((item) => item.id === target.id ? { ...item, status: "undone" } : item) };
                }
                const deletedAt = new Date().toISOString();
                return {
                    ...current,
                    transactions: current.transactions.map((item) => currentReview.appliedTransactionIds?.includes(item.id) ? { ...item, deleted: true, deletedAt } : item),
                    importReviews: (current.importReviews ?? []).map((item) => item.id === target.id ? { ...item, status: "undone" } : item),
                };
            });
            setDeleteTarget(null);
            onToast(target.mode === "cancel" ? "已取消待审核导入，未写入任何交易" : "CSV 导入已撤销，导入交易已移入回收站");
        });
    };

    const install = async () => {
        const prompt = installEvent as (Event & { prompt?: () => Promise<void> }) | null;
        if (!prompt?.prompt) {
            onToast("当前浏览器还没有提供安装提示");
            return;
        }
        await prompt.prompt();
        setInstallEvent(null);
    };

    return <PageFrame eyebrow="INTEGRATIONS" title="保险管理" description="保险与外部连接管理。外部连接默认关闭，CSV 先进入审核中心，不会直接写入正式流水。">
        <section className="integration-status-grid">
            <article className="panel integration-status"><div className="status-icon">{online ? <WifiHigh size={24}/> : <WifiSlash size={24}/>}</div><div><strong>{online ? "在线" : "离线"}</strong><span>{online ? "IndexedDB 可以继续保存本地记录" : "当前离线，记录会留在本地"}</span></div></article>
            <article className="panel integration-status"><div className="status-icon"><HardDrives size={24}/></div><div><strong>银行同步 Adapter 已关闭</strong><span>没有服务连接，也不会上传真实资料。</span><button type="button" className="text-button" onClick={() => onToast("银行连接前需要明确授权；当前版本只保留接口，不会上传资料。")} aria-label="查看银行连接权限说明" title="查看银行连接权限说明">查看权限说明</button></div></article>
            <article className="panel integration-status"><div className="status-icon"><TrendUp size={24}/></div><div><strong>实时汇率 Adapter 已关闭</strong><span>手动汇率优先，历史快照不变。</span><button type="button" className="text-button" onClick={() => onToast("实时汇率只作参考；当前版本不启用 API，也不会修改历史汇率。")} aria-label="查看实时汇率权限说明" title="查看实时汇率权限说明">查看权限说明</button></div></article>
        </section>
        <section className="advanced-two-column">
            <section className="panel import-panel">
                <div className="panel-title-row"><div><h2>CSV 审核中心</h2><span>支持 date,type,amount,currency,category,merchant,note,accountId 列。</span></div><FileCsv size={22}/></div>
                <label className="file-drop"><UploadSimple size={22}/><span>选择 CSV 文件</span><input type="file" accept=".csv,text/csv" aria-label="选择需要审核的 CSV 文件" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleFile(file); event.currentTarget.value = ""; }}/></label>
                {pendingImports.length ? pendingImports.map((review) => <div className="import-review-row" key={review.id}><div><strong>{review.fileName}</strong><span>{review.rows.length} 笔待审核 · {new Date(review.importedAt).toLocaleString("zh-CN")}</span></div><div className="inline-actions"><button type="button" className="secondary-button compact" onClick={() => applyImport(review.id)} aria-label={`应用导入 ${review.fileName}`} title="应用导入">应用导入</button><button type="button" className="text-button" onClick={() => setDeleteTarget({ id: review.id, fileName: review.fileName, rowCount: review.rows.length, mode: "cancel" })} aria-label={`取消导入 ${review.fileName}`} title="取消待审核导入" disabled={isProcessing}>取消</button></div></div>) : <div className="empty-state compact-empty"><FileCsv size={28}/><strong>没有待审核导入</strong><span>导入后的数据会先停在这里。</span></div>}
            </section>
            <section className="panel"><div className="panel-title-row"><div><h2>PWA 安装</h2><span>安装后可以离线查看最近的本地数据。</span></div><CloudArrowDown size={22}/></div><div className="pwa-card"><strong>Wealth Atlas</strong><span>{installEvent ? "浏览器已准备好安装" : "如果浏览器支持，安装提示会在这里出现"}</span><button type="button" className="primary-button" onClick={() => void install()} aria-label="安装 Wealth Atlas 到设备" title="安装 Wealth Atlas"><DownloadSimple size={17}/>安装到设备</button></div><div className="integration-note"><ShieldCheck size={18}/><span>银行同步和实时汇率只保留 Adapter 接口，默认关闭。</span></div></section>
        </section>
        <section className="panel import-history"><div className="panel-title-row"><div><h2>导入历史</h2><span>应用后的导入仍可撤销，撤销会软删除导入交易。</span></div><FileCsv size={22}/></div>{importHistory.length ? importHistory.slice(-8).reverse().map((review) => <div className="import-review-row" key={review.id}><div><strong>{review.fileName}</strong><small>{review.status === "applied" ? "已应用" : "已撤销"} · {review.duplicateCount ?? 0} 笔可能重复</small></div>{review.status === "applied" && <button type="button" className="secondary-button compact" onClick={() => setDeleteTarget({ id: review.id, fileName: review.fileName, rowCount: review.rows.length, mode: "undo" })} aria-label={`撤销导入 ${review.fileName}`} title="撤销导入" disabled={isProcessing}>撤销导入</button>}</div>) : <div className="empty-state compact-empty"><Check size={28}/><strong>还没有导入历史</strong><span>CSV 应用后会显示在这里。</span></div>}</section>
        {deleteTarget && <ProtectedDeleteDialog title={deleteTarget.mode === "cancel" ? "取消待审核导入" : "撤销已应用导入"} titleId="confirm-import-action" lead={deleteTarget.fileName} summary={<div className="confirm-record-summary"><div><span>导入记录</span><strong>{deleteTarget.rowCount} 笔</strong></div><div><span>操作</span><strong>{deleteTarget.mode === "cancel" ? "不写入交易" : "移入回收站"}</strong></div></div>} warning={deleteTarget.mode === "cancel" ? "取消只会关闭这份待审核导入，不会删除账户、预算或现有交易。" : "撤销会将该次导入创建的交易移入回收站；不会影响其他交易。"} confirmLabel={deleteTarget.mode === "cancel" ? "确认取消导入" : "确认撤销导入"} onCancel={() => setDeleteTarget(null)} onConfirm={confirmImportAction} isProcessing={isProcessing}/>}
    </PageFrame>;
}

function ReportsPage({ data, onToast }: Pick<Props, "data" | "onToast">) {
    const [selectedMonth] = useSharedMonth(today.slice(0,7));
    const exportPdfReport = (source: WealthData, report: "monthly" | "annual" | "net-worth" | "investment" | "asset" | "fx" | "cashflow") => exportPdfReportFile(source,report,selectedMonth);
    const exportChartPng = (source: WealthData, chart: "cashflow" | "net-worth" | "currency" | "income-expense" | "savings" | "assets" | "fx" | "investment" | "watchlist") => exportChartPngFile(source,chart,selectedMonth);
    const run = async (task: () => Promise<void>, success: string) => { try {
        await task();
        onToast(success);
    }
    catch (error) {
        onToast(`导出失败：${error instanceof Error ? error.message : "未知错误"}`);
    } };
    const pdfReports: Array<[
        "monthly" | "annual" | "net-worth" | "investment" | "asset" | "fx" | "cashflow",
        string
    ]> = [["monthly", "月度"], ["annual", "年度"], ["net-worth", "净资产"], ["investment", "投资"], ["asset", "物品资产"], ["fx", "汇率"], ["cashflow", "现金流"]];
    const pngCharts: Array<[
        "cashflow" | "net-worth" | "currency" | "income-expense" | "savings" | "assets" | "fx" | "investment" | "watchlist",
        string
    ]> = [["income-expense", "收入支出"], ["savings", "储蓄率"], ["net-worth", "净资产"], ["assets", "资产"], ["currency", "货币"], ["fx", "汇率"], ["investment", "投资"], ["watchlist", "Watchlist"], ["cashflow", "现金流"]];
    return <PageFrame eyebrow="REPORTS" title="报表与导出" description="导出文件只读取当前本地快照，不会修改账户、交易或历史汇率。"><section className="report-export-grid"><article className="panel report-export-card"><FileXls size={26}/><h2>Excel 工作簿</h2><p>完整导出账户、流水、投资、资产、负债、汇率、Watchlist 和现金流，保留原始金额与历史汇率快照。</p><button type="button" className="primary-button" onClick={() => void run(() => exportExcel(data), "Excel 已下载")}>导出 Excel</button></article><article className="panel report-export-card"><FilePdf size={26}/><h2>PDF 报告</h2><p>选择需要归档的财务报告。</p><div className="button-row">{pdfReports.map(([key, label]) => <button type="button" key={key} className="secondary-button compact" onClick={() => void run(() => exportPdfReport(data, key), `${label} PDF 已下载`)}>{label}</button>)}</div></article><article className="panel report-export-card"><ChartLineUp size={26}/><h2>图表 PNG</h2><p>导出当前本地快照的关键趋势图。</p><div className="button-row">{pngCharts.map(([key, label]) => <button type="button" key={key} className="secondary-button compact" onClick={() => void run(() => exportChartPng(data, key), `${label} PNG 已下载`)}>{label}</button>)}</div></article></section><section className="panel report-inventory"><div className="panel-title-row"><div><h2>工作表清单</h2><span>v0.9.0 导出结构</span></div><Check size={22}/></div><div className="export-sheet-list">{["Transactions", "Transfers", "Monthly Summary", "Annual Summary", "Goals", "Accounts", "Investments", "Investment Transactions", "Asset Items", "Liabilities", "Net Worth History", "Subscriptions", "FX Rates", "Watchlists", "Cash Flow Forecast", "Settings"].map((sheet) => <span key={sheet}>{sheet}</span>)}</div></section></PageFrame>;
}
export default function AdvancedWorkbench({ page, data, setData, onToast, onNavigate }: Props) {
    if (page === "cashflow")
        return <CashFlowPage data={data} setData={setData} onToast={onToast}/>;
    if (page === "watchlists")
        return <WatchlistsPage data={data} setData={setData} onToast={onToast}/>;
    if (page === "analysis")
        return <AnalysisPage data={data} setData={setData} onToast={onToast}/>;
    if (page === "integrations")
        return <IntegrationsPage data={data} setData={setData} onToast={onToast}/>;
    return <ReportsPage data={data} onToast={onToast}/>;
}
