"use client";

import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  ArrowClockwise,
  ArrowRight,
  ChartLineUp,
  Check,
  Clock,
  Coins,
  FloppyDisk,
  PencilSimple,
  Plus,
  ShieldCheck,
  Trash,
  TrendDown,
  TrendUp,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  formatMoney,
  getCurrencyExposures,
  getFutureMyrNeed,
  getFxUsageCount,
  getInvestmentConversion,
  getLocalDate,
  getRate,
  getRateAtDate,
  getRateAgeDays,
  getRateRecord,
  simulateFx,
} from "@/lib/finance";
import { SharedMonthPicker,formatMonthLabel,getMonthEnd,getMonthReferenceDate,useSharedMonth } from "@/components/MonthPicker";
import type { CurrencyCode, FxRate, WealthData } from "@/lib/types";

const pairs = ["SGD/MYR", "USD/SGD", "MYR/SGD", "SGD/USD"] as const;
type Pair = typeof pairs[number];

function newId() {
  return `fx-${crypto.randomUUID()}`;
}

function splitPair(pair: Pair) {
  return pair.split("/") as [CurrencyCode, CurrencyCode];
}

function today() {
  return getLocalDate();
}

function formatRate(rate: number | null) {
  return rate === null ? "—" : rate.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function rateDelta(current: number | null, previous: number | undefined) {
  if (current === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function FxDeleteConfirmModal({ rate, isUsed, onCancel, onConfirm, isProcessing }: { rate: FxRate; isUsed: boolean; onCancel: () => void; onConfirm: () => void; isProcessing: boolean }) {
  const actionLabel=isUsed? "确认停用":"确认删除";
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!isProcessing && event.currentTarget === event.target) onCancel(); }}><div className="modal confirm-modal danger-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="fx-delete-title"><div className="modal-header"><div><div className="panel-kicker">FX HISTORY</div><h2 id="fx-delete-title">{isUsed? "确认停用汇率记录":"确认删除汇率记录"}</h2></div><button type="button" className="icon-button" onClick={onCancel} disabled={isProcessing} aria-label="关闭汇率删除确认" title="关闭"><X size={19} /></button></div><p className="confirm-lead">{rate.baseCurrency}/{rate.quoteCurrency} · {formatRate(rate.rate)}</p><div className="confirm-record-summary"><div><span>生效日期</span><strong>{rate.effectiveDate}</strong></div><div><span>来源</span><strong>{rate.source ?? "手动输入"}</strong></div><div><span>处理方式</span><strong>{isUsed? "停用并保留快照":"永久移除本地汇率记录"}</strong></div></div><div className="confirm-warning"><ShieldCheck size={18} /><span>{isUsed? "这条汇率已被历史资料使用，会改为停用；历史交易、转账和投资快照不会改变。":"删除后这条汇率历史会从本地记录移除；相关历史快照仍保留在交易、转账和投资中。"}</span></div><div className="confirm-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={isProcessing}>取消</button><button type="button" className="danger-button" onClick={onConfirm} disabled={isProcessing} aria-label={actionLabel} title={actionLabel}>{isProcessing ? "处理中…" : actionLabel}</button></div></div></div>;
}

export default function FxCenter({ data, setData, onToast, onNavigate }: { data: WealthData; setData: Dispatch<SetStateAction<WealthData>>; onToast: (message: string) => void; onNavigate: (page: "home" | "fx") => void }) {
  const [selectedMonth] = useSharedMonth(today().slice(0,7));
  const selectedMonthEnd = getMonthEnd(selectedMonth);
  const selectedMonthReference = getMonthReferenceDate(selectedMonth,today());
  const [selectedPair, setSelectedPair] = useState<Pair>("SGD/MYR");
  const [dateFilter, setDateFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ rate: "3.48", effectiveDate: today(), source: "手动输入", note: "", isDefault: true });
  const [simulation, setSimulation] = useState({ currentRate: "3.48", simulatedRate: "3.55", monthlySgd: "2000", usdAmount: "5000", months: "12" });
  const [simulated, setSimulated] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FxRate | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const deleteInFlightRef = useRef(false);

  const [baseCurrency, quoteCurrency] = splitPair(selectedPair);
  const pairHistory = useMemo(() => data.fxRates.filter((rate) => rate.baseCurrency === baseCurrency && rate.quoteCurrency === quoteCurrency).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || (b.enteredAt ?? "").localeCompare(a.enteredAt ?? "")), [baseCurrency, data.fxRates, quoteCurrency]);
  const monthHistory = pairHistory.filter((rate) => rate.effectiveDate.slice(0,7) === selectedMonth);
  const filteredHistory = dateFilter ? monthHistory.filter((rate) => rate.effectiveDate === dateFilter) : monthHistory;
  const current = getRateRecord(data.fxRates, baseCurrency, quoteCurrency, selectedMonthEnd, true);
  const previous = pairHistory.find((rate) => rate.id !== current?.id && rate.effectiveDate <= selectedMonthEnd);
  const change = rateDelta(current?.rate ?? getRateAtDate(data.fxRates, baseCurrency, quoteCurrency, selectedMonthEnd), previous?.rate);
  const exposures = getCurrencyExposures(data, data.reportCurrency, selectedMonthReference);
  const futureNeed = getFutureMyrNeed(data,selectedMonthReference);
  const investment = getInvestmentConversion(data);
  const simulationResult = simulated ? simulateFx({ currentRate: Number(simulation.currentRate) || 0, simulatedRate: Number(simulation.simulatedRate) || 0, monthlySgd: Number(simulation.monthlySgd) || 0, usdAmount: Number(simulation.usdAmount) || 0, months: Number(simulation.months) || 0 }) : null;

  const alerts = pairs.flatMap((pair) => {
    const [base, quote] = splitPair(pair);
    const record = getRateRecord(data.fxRates, base, quote,selectedMonthEnd,true) ?? getRateRecord(data.fxRates, quote, base,selectedMonthEnd,true);
    if (!record) return [{ title: `${pair} 缺少必要汇率`, body: "请在汇率中心新增一条手动汇率，相关换算和提醒会恢复。", tone: "warning" }];
    const age = getRateAgeDays(record,selectedMonthReference);
    return age !== null && age > 30 ? [{ title: `${pair} 已超过 30 天未更新`, body: `最近生效日为 ${record.effectiveDate}，会影响当前余额、未来支出和投资估值。`, tone: "warning" }] : [];
  });
  if (!getRateAtDate(data.fxRates, "USD", "SGD",selectedMonthEnd) || !getRateAtDate(data.fxRates, "SGD", "MYR",selectedMonthEnd)) alerts.push({ title: "USD → SGD → MYR 链式路径不完整", body: `${formatMonthLabel(selectedMonth)}缺少完整历史汇率路径，历史交易快照不会被改变。`, tone: "warning" });

  const saveRate = () => {
    const rateValue = Number(form.rate);
    if (!Number.isFinite(rateValue) || rateValue <= 0 || !form.effectiveDate) return onToast("请输入有效汇率和生效日期");
    const id = newId();
    const enteredAt = new Date().toISOString();
    setData((currentData) => ({ ...currentData, fxRates: [...currentData.fxRates.map((item) => item.baseCurrency === baseCurrency && item.quoteCurrency === quoteCurrency ? { ...item, isDefault: false } : item), { id, baseCurrency, quoteCurrency, rate: rateValue, effectiveDate: form.effectiveDate, enteredAt, source: form.source || "手动输入", note: form.note.trim() || undefined, isDefault: form.isDefault, active: true, useCount: 0 }] }));
    setEditingId(null);
    onToast(`${selectedPair} 已保存为新的历史记录，旧汇率未被覆盖`);
  };

  const editRate = (rate: FxRate) => {
    setEditingId(rate.id);
    setForm({ rate: String(rate.rate), effectiveDate: rate.effectiveDate, source: rate.source ?? "手动输入", note: rate.note ?? "", isDefault: true });
  };

  const toggleRate = (rate: FxRate) => {
    const willEnable=rate.active===false;
    setData((currentData) => ({ ...currentData, fxRates: currentData.fxRates.map((item) => item.id === rate.id ? { ...item, active: willEnable } : item) }));
    onToast(willEnable ? "汇率已启用" : "汇率已停用，历史快照未改变");
  };

  const deleteRate = (rate: FxRate) => {
    if (!deleteInFlightRef.current) setDeleteTarget(rate);
  };

  const confirmDeleteRate = () => {
    const target = deleteTarget;
    if (!target || deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setDeleteInFlight(true);
    try {
      const used = getFxUsageCount(data, target.id) + (target.useCount ?? 0) > 0;
      setData((currentData) => {
        const stillUsed = getFxUsageCount(currentData, target.id) + (currentData.fxRates.find((item) => item.id === target.id)?.useCount ?? 0) > 0;
        return stillUsed
          ? { ...currentData, fxRates: currentData.fxRates.map((item) => item.id === target.id ? { ...item, active: false, isDefault: false } : item) }
          : { ...currentData, fxRates: currentData.fxRates.filter((item) => item.id !== target.id) };
      });
      setDeleteTarget(null);
      onToast(used ? "该汇率已有历史使用记录，已停用且历史快照保留" : "历史汇率记录已删除");
    } catch {
      onToast("删除失败，原始汇率记录未改变");
    } finally {
      deleteInFlightRef.current = false;
      setDeleteInFlight(false);
    }
  };

  const renderPairCards = () => <><div className="fx-inline-month"><SharedMonthPicker ariaLabel="选择汇率中心查看月份" /></div><div className="fx-pair-grid">{pairs.map((pair) => { const [base, quote] = splitPair(pair); const record = getRateRecord(data.fxRates, base, quote,selectedMonthEnd,true); const value = getRateAtDate(data.fxRates, base, quote,selectedMonthEnd); return <button type="button" className={`fx-pair-card ${selectedPair === pair ? "active" : ""}`} key={pair} onClick={() => { setSelectedPair(pair); setEditingId(null); }}><span>{pair}</span><strong>{formatRate(value)}</strong><small>{record ? `${record.effectiveDate} · 截至 ${formatMonthLabel(selectedMonth)}` : `${formatMonthLabel(selectedMonth)}缺少汇率`}</small></button>; })}</div></>;

  const renderHistory = () => <section className="panel fx-history-panel"><div className="panel-title-row"><div><div className="panel-kicker">RATE HISTORY</div><h2>{selectedPair} 历史</h2></div><div className="fx-history-tools"><input type="date" aria-label="按生效日期筛选" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} />{dateFilter && <button type="button" className="icon-button" aria-label="清除日期筛选" onClick={() => setDateFilter("")} title="清除日期筛选"><X size={16} /></button>}</div></div><div className="fx-history-meta"><span>当前汇率 <b>{formatRate(current?.rate ?? getRate(data.fxRates, baseCurrency, quoteCurrency))}</b></span><span>最近更新时间 <b>{current?.effectiveDate ?? "未设置"}</b></span><span>变化 <b className={change !== null && change >= 0 ? "positive" : "negative"}>{change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</b></span></div><div className="fx-trend" aria-label={`${selectedPair} 汇率趋势`}><div className="fx-trend-axis"><span>{pairHistory.length ? formatRate(Math.max(...pairHistory.map((rate) => rate.rate))) : "—"}</span><span>{pairHistory.length ? formatRate(Math.min(...pairHistory.map((rate) => rate.rate))) : "—"}</span></div><div className="fx-trend-bars">{pairHistory.slice(0, 12).reverse().map((rate) => { const values = pairHistory.map((item) => item.rate); const min = Math.min(...values); const max = Math.max(...values); const height = max === min ? 50 : 18 + ((rate.rate - min) / (max - min)) * 62; return <div className={`fx-trend-bar ${rate.active === false ? "inactive" : ""}`} key={rate.id} style={{ height: `${height}%` }} title={`${rate.effectiveDate} ${rate.rate}`} />; })}</div></div><div className="fx-history-list">{filteredHistory.length ? filteredHistory.map((rate) => <div className={`fx-history-row ${rate.active === false ? "inactive" : ""}`} key={rate.id}><div><strong>{formatRate(rate.rate)}</strong><span>{rate.effectiveDate} · 输入于 {rate.enteredAt ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(rate.enteredAt)) : "旧记录"}</span></div><div><span>{rate.source ?? "手动输入"}</span><small>{rate.note || "无备注"}</small></div><div><span>{getFxUsageCount(data, rate.id) + (rate.useCount ?? 0)} 次使用</span><small>{rate.isDefault ? "默认" : rate.active === false ? "已停用" : "历史"}</small></div><div className="fx-row-actions"><button type="button" className="icon-button" aria-label={`编辑 ${rate.rate}`} onClick={() => editRate(rate)} title={`编辑汇率 ${rate.rate}`}><PencilSimple size={16} /></button><button type="button" className="icon-button" aria-label={rate.active === false ? `启用 ${rate.rate}` : `停用 ${rate.rate}`} onClick={() => toggleRate(rate)} title={rate.active === false ? "启用汇率" : "停用汇率"}><ArrowClockwise size={16} /></button><button type="button" className="icon-button danger-icon" aria-label={`删除 ${rate.rate}`} onClick={() => deleteRate(rate)} title="删除汇率" disabled={deleteInFlight}><Trash size={16} /></button></div></div>) : <div className="empty-state compact-empty"><ChartLineUp size={28} /><strong>还没有符合条件的历史汇率</strong><span>输入第一条 {selectedPair}，系统会保留每次变更。</span></div>}</div></section>;

  const renderRateForm = () => <section className="panel fx-form-panel"><div className="panel-title-row"><div><div className="panel-kicker">MANUAL RATE ENTRY</div><h2>{editingId ? "新增历史版本" : "输入汇率"}</h2></div><Coins size={20} /></div><p className="fx-form-help">编辑不会覆盖历史记录，只会以新的生效日期和输入时间追加一条记录。</p><div className="form-stack"><label>货币对<select value={selectedPair} onChange={(event) => setSelectedPair(event.target.value as Pair)}>{pairs.map((pair) => <option key={pair}>{pair}</option>)}</select></label><div className="form-grid"><label>汇率<input type="number" min="0" step="0.0001" value={form.rate} onChange={(event) => setForm((current) => ({ ...current, rate: event.target.value }))} /></label><label>生效日期<input type="date" value={form.effectiveDate} onChange={(event) => setForm((current) => ({ ...current, effectiveDate: event.target.value }))} /></label></div><div className="form-grid"><label>来源<input value={form.source} onChange={(event) => setForm((current) => ({ ...current, source: event.target.value }))} /></label><label>备注<input placeholder="例如：银行实际到账汇率" value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} /></label></div><label className="checkbox-row"><input type="checkbox" checked={form.isDefault} onChange={(event) => setForm((current) => ({ ...current, isDefault: event.target.checked }))} /> 设为该货币对的默认汇率</label><div className="form-actions"><button type="button" className="primary-button full" onClick={saveRate}><FloppyDisk size={17} /> 保存汇率</button>{editingId && <button type="button" className="secondary-button full" onClick={() => setEditingId(null)}><X size={17} /> 取消编辑</button>}</div></div></section>;

  const renderExposure = () => <section className="panel exposure-panel"><div className="panel-title-row"><div><div className="panel-kicker">CURRENCY EXPOSURE</div><h2>货币暴露</h2></div><button type="button" className="text-button" onClick={() => onNavigate("fx")}>汇率中心 <ArrowRight size={15} /></button></div><div className="exposure-bars">{exposures.map((row) => <div className="exposure-row" key={row.currency}><div className="exposure-label"><strong>{row.currency}</strong><span>{row.percent.toFixed(0)}%</span></div><div className="exposure-track"><span style={{ width: `${row.percent}%` }} /></div><div className="exposure-detail"><span>现金 {formatMoney(row.cash, row.currency)}</span><span>投资 {formatMoney(row.investment, row.currency)}</span></div></div>)}</div><div className="exposure-mix"><span>现金与投资均按报告货币换算，目标和未来支出单独保留。</span><b>{data.reportCurrency} 报告视角</b></div></section>;

  const renderFutureAndInvestment = () => <div className="fx-analysis-grid"><section className="panel future-fx-panel"><div className="panel-title-row"><div><div className="panel-kicker">NEXT 30 DAYS</div><h2>未来换汇需求</h2></div><ArrowRight size={20} /></div><div className="need-flow"><div><span>未来 MYR 支出需求</span><strong>{formatMoney(futureNeed.demand, "MYR")}</strong></div><div><span>目前 MYR 可用余额</span><strong>{formatMoney(futureNeed.myrBalance, "MYR")}</strong></div><div className="need-gap"><span>预计 MYR 缺口</span><strong>{formatMoney(futureNeed.gap, "MYR")}</strong></div></div><div className="need-result">{futureNeed.sgdNeeded === null ? <><WarningCircle size={18} /><span>缺少 SGD/MYR，暂时不能估算需要多少 SGD。</span></> : <><Check size={18} /><span>按 {formatRate(futureNeed.sgdMyr)} 预计需要 <b>{formatMoney(futureNeed.sgdNeeded, "SGD")}</b></span></>}</div><small>只提供计算结果，不会自动执行换汇。</small></section><section className="panel investment-path-panel"><div className="panel-title-row"><div><div className="panel-kicker">USD INVESTMENT PATH</div><h2>USD 投资换算</h2></div><Coins size={20} /></div>{investment ? <div className="investment-path"><div><span>USD 投资价值</span><strong>{formatMoney(investment.usdValue, "USD")}</strong></div><ArrowRight size={17} /><div><span>USD/SGD</span><strong>{investment.usdSgd ? `× ${formatRate(investment.usdSgd.rate)}` : "缺少"}</strong></div><ArrowRight size={17} /><div><span>SGD 投资价值</span><strong>{investment.sgdValue === null ? "—" : formatMoney(investment.sgdValue, "SGD")}</strong></div><ArrowRight size={17} /><div><span>MYR 报告价值</span><strong>{investment.myrValue === null ? "—" : formatMoney(investment.myrValue, "MYR")}</strong></div></div> : <div className="empty-state compact-empty"><Coins size={26} /><strong>暂无 USD 投资账户</strong></div>}<p className="fx-caption">当前估值路径：USD → SGD → MYR。估值日期和汇率变化会在历史快照中保留。</p></section></div>;

  const renderSimulator = () => <section className="panel simulator-panel"><div className="panel-title-row"><div><div className="panel-kicker">SCENARIO LAB</div><h2>汇率情境模拟器</h2></div><ChartLineUp size={20} /></div><div className="simulator-grid"><label>当前 SGD/MYR<input type="number" step="0.0001" value={simulation.currentRate} onChange={(event) => setSimulation((current) => ({ ...current, currentRate: event.target.value }))} /></label><label>模拟 SGD/MYR<input type="number" step="0.0001" value={simulation.simulatedRate} onChange={(event) => setSimulation((current) => ({ ...current, simulatedRate: event.target.value }))} /></label><label>每月转账 SGD<input type="number" step="1" value={simulation.monthlySgd} onChange={(event) => setSimulation((current) => ({ ...current, monthlySgd: event.target.value }))} /></label><label>USD 投资金额<input type="number" step="1" value={simulation.usdAmount} onChange={(event) => setSimulation((current) => ({ ...current, usdAmount: event.target.value }))} /></label><label>模拟期间（月）<input type="number" min="1" step="1" value={simulation.months} onChange={(event) => setSimulation((current) => ({ ...current, months: event.target.value }))} /></label><button type="button" className="primary-button" onClick={() => setSimulated(true)}><ChartLineUp size={17} /> 运行模拟</button></div>{simulationResult && <div className="simulation-result"><div><span>每月 MYR 变化</span><strong className={simulationResult.monthlyMyrDelta >= 0 ? "positive" : "negative"}>{simulationResult.monthlyMyrDelta >= 0 ? "+" : ""}{formatMoney(simulationResult.monthlyMyrDelta, "MYR")}</strong></div><div><span>{simulation.months} 个月累计</span><strong className={simulationResult.periodMyrDelta >= 0 ? "positive" : "negative"}>{simulationResult.periodMyrDelta >= 0 ? "+" : ""}{formatMoney(simulationResult.periodMyrDelta, "MYR")}</strong></div><div><span>USD 投资 SGD 变化</span><strong className={simulationResult.investmentSgdDelta >= 0 ? "positive" : "negative"}>{simulationResult.investmentSgdDelta >= 0 ? "+" : ""}{formatMoney(simulationResult.investmentSgdDelta, "SGD")}</strong></div></div>}<p className="simulation-disclaimer">这是情境模拟，不是投资建议。不会修改真实汇率、账户或历史记录。</p></section>;

  return <><main className="main-content module-page fx-page"><header className="page-header module-header"><div><div className="breadcrumb">WEALTH ATLAS / FX CENTER</div><h1>多币种与汇率中心</h1></div><div className="header-actions"><button type="button" className="secondary-button compact" onClick={() => onNavigate("home")}><ArrowRight size={16} /> 返回首页</button><div className="local-pill"><ShieldCheck size={17} weight="fill" /> 手动汇率</div></div></header>{alerts.length > 0 && <section className="fx-alert-list">{alerts.map((alert, index) => <div className="fx-alert" key={`${alert.title}-${index}`}><WarningCircle size={18} /><div><strong>{alert.title}</strong><span>{alert.body}</span></div></div>)}</section>}<section className="fx-current-section"><div className="section-heading"><div><div className="panel-kicker">CURRENT RATES</div><h2>当前汇率</h2></div><span>只使用本地手动记录，不接入实时 API</span></div>{renderPairCards()}</section><section className="fx-main-grid"><div>{renderHistory()}{renderExposure()}{renderFutureAndInvestment()}{renderSimulator()}</div><div>{renderRateForm()}</div></section></main>{deleteTarget && <FxDeleteConfirmModal rate={deleteTarget} isUsed={getFxUsageCount(data, deleteTarget.id) + (deleteTarget.useCount ?? 0) > 0} onCancel={() => setDeleteTarget(null)} onConfirm={confirmDeleteRate} isProcessing={deleteInFlight} />}</>
}
