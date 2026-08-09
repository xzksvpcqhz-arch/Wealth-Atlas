"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ArrowsLeftRight,
  Bell,
  BookOpenText,
  Briefcase,
  CalendarDots,
  ChartLineUp,
  Check,
  CaretDown,
  CloudArrowUp,
  Coins,
  CreditCard,
  DownloadSimple,
  FileXls,
  GearSix,
  House,
  Lightning,
  ListChecks,
  MagnifyingGlass,
  Plus,
  Receipt,
  Scales,
  ShieldCheck,
  Sparkle,
  Target,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { buildDailyMarkdown, exportExcel, exportObsidianPackage } from "@/lib/exporters";
import { convert, formatMoney, getRate, totalExpensesInCurrency, totalIncomeInCurrency, totalInCurrency } from "@/lib/finance";
import { loadWealthData, saveWealthData } from "@/lib/storage";
import type { CurrencyCode, WealthData } from "@/lib/types";

const today = new Date().toISOString().slice(0, 10);

const initialData: WealthData = {
  reportCurrency: "MYR",
  accounts: [
    { id: "sgd-main", name: "新加坡工资账户", type: "bank", currency: "SGD", balance: 0 },
    { id: "myr-main", name: "马来西亚生活账户", type: "bank", currency: "MYR", balance: 0 },
    { id: "usd-invest", name: "USD 投资账户", type: "investment", currency: "USD", balance: 5000 },
  ],
  transactions: [
    { id: "salary", type: "income", accountId: "sgd-main", amount: 8600, currency: "SGD", category: "新加坡工资", date: "2026-08-01" },
    { id: "food-1", type: "expense", accountId: "myr-main", amount: 620, currency: "MYR", category: "外食", merchant: "本月累计", date: today },
    { id: "rent", type: "expense", accountId: "myr-main", amount: 1600, currency: "MYR", category: "房租", date: "2026-08-02" },
    { id: "insurance", type: "expense", accountId: "myr-main", amount: 450, currency: "MYR", category: "保险", date: "2026-08-04" },
  ],
  transfers: [
    { id: "transfer-1", fromAccountId: "sgd-main", toAccountId: "myr-main", fromAmount: 2000, fromCurrency: "SGD", toAmount: 6960, toCurrency: "MYR", rate: 3.48, fee: 5, feeCurrency: "SGD", date: "2026-08-02" },
  ],
  fxRates: [
    { id: "sgd-myr", baseCurrency: "SGD", quoteCurrency: "MYR", rate: 3.48, effectiveDate: "2026-08-10", note: "手动输入" },
    { id: "usd-sgd", baseCurrency: "USD", quoteCurrency: "SGD", rate: 1.34, effectiveDate: "2026-08-10", note: "手动输入" },
  ],
  goals: [
    { id: "travel", name: "旅行基金", current: 7200, target: 10000, currency: "MYR", percent: 72, due: "2026-12-01", cadence: "monthly", status: "on-track" },
    { id: "house", name: "房屋首期", current: 38000, target: 100000, currency: "MYR", percent: 38, due: "2030-01-01", cadence: "yearly", status: "watch" },
    { id: "study", name: "学习基金", current: 4200, target: 5000, currency: "MYR", percent: 84, due: "2026-10-15", cadence: "custom", status: "on-track" },
  ],
  assets: [
    { id: "macbook", name: "MacBook", category: "数码", purchaseValue: 6999, currentValue: 4800, currency: "MYR", dailyCost: 3.42, usageDays: 642, status: "active" },
    { id: "camera", name: "相机", category: "创作", purchaseValue: 5500, currentValue: 4200, currency: "MYR", dailyCost: 2.74, usageDays: 475, status: "active" },
    { id: "gold", name: "黄金", category: "贵重资产", purchaseValue: 10000, currentValue: 11200, currency: "MYR", dailyCost: 3.84, usageDays: 312, status: "active" },
  ],
  plannedPayments: [
    { id: "insurance", name: "保险预留", amount: 450, currency: "MYR", due: "2026-08-18", cadence: "monthly", category: "保险" },
    { id: "sgd-transfer", name: "SGD 转 MYR", amount: 2000, currency: "SGD", due: "2026-08-25", cadence: "monthly", category: "资金转换" },
  ],
  watchlists: [
    { id: "food", name: "外食", spent: 620, limit: 800, average: 710, forecast: 940, currency: "MYR" },
    { id: "shopping", name: "购物", spent: 340, limit: 600, average: 520, forecast: 480, currency: "MYR" },
  ],
};

type ModalType = "transaction" | "transfer" | "fx" | "goal" | null;
type NavItem = { label: string; icon: React.ElementType; key: string };

const navItems: NavItem[] = [
  { label: "首页", icon: House, key: "home" },
  { label: "账户总览", icon: Wallet, key: "accounts" },
  { label: "收支记录", icon: Receipt, key: "transactions" },
  { label: "预算管理", icon: Scales, key: "budget" },
  { label: "资产管理", icon: Briefcase, key: "assets" },
  { label: "目标与计划", icon: Target, key: "goals" },
  { label: "保险管理", icon: ShieldCheck, key: "insurance" },
  { label: "报表中心", icon: ChartLineUp, key: "reports" },
  { label: "理财师提醒", icon: Bell, key: "insights" },
];

const chartData = [
  { day: "8/1", income: 3.4, spend: 1.8 },
  { day: "8/8", income: 5.8, spend: 2.4 },
  { day: "8/15", income: 6.2, spend: 2.9 },
  { day: "8/22", income: 8.2, spend: 3.3 },
  { day: "8/29", income: 10.1, spend: 3.7 },
];

function Stat({ icon: Icon, label, value, hint, tone = "cyan" }: { icon: React.ElementType; label: string; value: string; hint?: string; tone?: "cyan" | "green" | "amber" | "violet" }) {
  return (
    <div className="stat-cell">
      <div className={`stat-icon ${tone}`}><Icon size={18} weight="fill" /></div>
      <div>
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {hint && <div className="stat-hint">{hint}</div>}
      </div>
    </div>
  );
}

export default function WealthAtlas() {
  const [data, setData] = useState<WealthData>(initialData);
  const [active, setActive] = useState("home");
  const [modal, setModal] = useState<ModalType>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [fxDraft, setFxDraft] = useState({ pair: "SGD/MYR", rate: "3.48", date: today, note: "" });
  const [transactionDraft, setTransactionDraft] = useState({ type: "expense" as "income" | "expense", amount: "", currency: "MYR" as CurrencyCode, category: "外食", merchant: "" });
  const [transferDraft, setTransferDraft] = useState({ amount: "", rate: "3.48", fee: "5" });

  useEffect(() => {
    loadWealthData().then((saved) => {
      if (saved) setData(saved);
      setIsLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (isLoaded) saveWealthData(data);
  }, [data, isLoaded]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const reportCurrency = data.reportCurrency;
  const income = totalIncomeInCurrency(data, reportCurrency);
  const expenses = totalExpensesInCurrency(data, reportCurrency);
  const netWorth = totalInCurrency(data, reportCurrency) + data.assets.reduce((sum, asset) => sum + (convert(asset.currentValue, asset.currency, reportCurrency, data.fxRates) ?? 0), 0);
  const savings = Math.max(0, income - expenses);
  const freeToSpend = Math.max(0, income - 3000 - 2100 - 1000);
  const latestSgdMyr = data.fxRates.find((rate) => rate.baseCurrency === "SGD" && rate.quoteCurrency === "MYR")?.rate ?? 0;
  const latestUsdSgd = data.fxRates.find((rate) => rate.baseCurrency === "USD" && rate.quoteCurrency === "SGD")?.rate ?? 0;
  const forecast = Math.max(0, freeToSpend + 3200 - 1100);
  const currencyExposure = useMemo(() => {
    const totals = data.accounts.map((account) => ({ currency: account.currency, value: convert(account.balance, account.currency, reportCurrency, data.fxRates) ?? 0 }));
    const sum = totals.reduce((acc, item) => acc + item.value, 0) || 1;
    return totals.map((item) => ({ ...item, percent: Math.round((item.value / sum) * 100) }));
  }, [data.accounts, data.fxRates, reportCurrency]);

  const showToast = (message: string) => setToast(message);

  const addTransaction = () => {
    const amount = Number(transactionDraft.amount);
    if (!amount || amount <= 0) return showToast("请输入有效金额");
    setData((current) => ({
      ...current,
      transactions: [{ id: crypto.randomUUID(), type: transactionDraft.type, accountId: transactionDraft.currency === "SGD" ? "sgd-main" : "myr-main", amount, currency: transactionDraft.currency, category: transactionDraft.category, merchant: transactionDraft.merchant, date: today }, ...current.transactions],
    }));
    setModal(null);
    showToast("交易已保存到本地");
  };

  const addTransfer = () => {
    const amount = Number(transferDraft.amount);
    const rate = Number(transferDraft.rate);
    const fee = Number(transferDraft.fee) || 0;
    if (!amount || !rate) return showToast("请输入转账金额和汇率");
    setData((current) => ({
      ...current,
      transfers: [{ id: crypto.randomUUID(), fromAccountId: "sgd-main", toAccountId: "myr-main", fromAmount: amount, fromCurrency: "SGD", toAmount: amount * rate, toCurrency: "MYR", rate, fee, feeCurrency: "SGD", date: today }, ...current.transfers],
    }));
    setModal(null);
    showToast(`已记录 SGD ${amount.toLocaleString()} → MYR ${(amount * rate).toLocaleString()}`);
  };

  const saveFxRate = () => {
    const rateValue = Number(fxDraft.rate);
    if (!rateValue) return showToast("请输入有效汇率");
    const [baseCurrency, quoteCurrency] = fxDraft.pair.split("/") as [CurrencyCode, CurrencyCode];
    setData((current) => ({
      ...current,
      fxRates: [{ id: crypto.randomUUID(), baseCurrency, quoteCurrency, rate: rateValue, effectiveDate: fxDraft.date, note: fxDraft.note || "手动输入" }, ...current.fxRates],
    }));
    setModal(null);
    showToast(`已更新 ${fxDraft.pair} 手动汇率`);
  };

  const syncObsidian = async () => {
    if ("showDirectoryPicker" in window) {
      try {
        const picker = await (window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker?.();
        if (picker) {
          const folder = await picker.getDirectoryHandle("财富理财师", { create: true });
          const daily = await folder.getDirectoryHandle("01-每日", { create: true });
          const file = await daily.getFileHandle(`${today}.md`, { create: true });
          const writable = await file.createWritable();
          await writable.write(buildDailyMarkdown(data, today));
          await writable.close();
          return showToast("已写入 Obsidian 每日笔记");
        }
      } catch {
        showToast("文件夹权限未完成，已改为下载 ZIP");
      }
    }
    await exportObsidianPackage(data);
    showToast("Obsidian ZIP 已下载");
  };

  const renderHome = () => (
    <main className="main-content">
      <header className="page-header">
        <div>
          <div className="breadcrumb">WEALTH ATLAS / HOME</div>
          <h1>我的财富星图</h1>
        </div>
        <div className="header-actions">
          <button className="month-select"><CalendarDots size={18} /> 2026年8月 <CaretDown size={16} /></button>
          <div className="local-pill"><ShieldCheck size={17} weight="fill" /> 本地数据</div>
        </div>
      </header>

      <section className="hero-grid">
        <div className="panel cashflow-hero">
          <div className="panel-kicker">本月可自由使用</div>
          <div className="hero-number">{formatMoney(freeToSpend, "MYR")}</div>
          <div className="hero-support">储蓄目标已完成 <strong>68%</strong></div>
          <div className="progress"><span style={{ width: "68%" }} /></div>
          <div className="chart-heading"><span>现金流趋势（MYR）</span><span className="legend"><i className="cyan-line" />收入 <i className="muted-line" />支出</span></div>
          <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} margin={{ top: 8, right: 6, left: -24, bottom: 0 }}><XAxis dataKey="day" tick={{ fill: "#66748e", fontSize: 10 }} axisLine={false} tickLine={false} /><YAxis tick={{ fill: "#66748e", fontSize: 10 }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: "#0c1729", border: "1px solid #253b5e", borderRadius: 12, color: "#fff" }} /><Bar dataKey="income" fill="#3cd9f5" radius={[4, 4, 0, 0]} barSize={8} /><Bar dataKey="spend" fill="#6b7890" radius={[4, 4, 0, 0]} barSize={8} /></BarChart></ResponsiveContainer></div>
        </div>
        <div className="panel stats-panel">
          <Stat icon={Wallet} label="本月收入" value={formatMoney(8600, "SGD")} hint={`约 ${formatMoney(income, reportCurrency)}`} tone="cyan" />
          <Stat icon={Coins} label="本月储蓄" value={formatMoney(savings, reportCurrency)} hint="储蓄率 24.4%" tone="green" />
          <Stat icon={ChartLineUp} label="净资产" value={formatMoney(netWorth, reportCurrency)} hint="本月 + 4.6%" tone="violet" />
          <Stat icon={ShieldCheck} label="紧急预备金" value="4.2个月" hint="距离目标还差 0.8 个月" tone="amber" />
        </div>
        <div className="panel goals-panel">
          <div className="panel-title-row"><h2>储蓄目标星图</h2><button className="icon-button" onClick={() => setModal("goal")}><Plus size={18} /></button></div>
          <div className="constellation">
            <div className="constellation-line line-one" /><div className="constellation-line line-two" />
            {data.goals.map((goal, index) => <div className={`goal-node goal-${index + 1}`} key={goal.id}><div className="goal-star"><Target size={18} weight="fill" /></div><div><strong>{goal.name}</strong><span>{goal.percent}%</span></div></div>)}
          </div>
        </div>
      </section>

      <section className="summary-strip">
        <div><span>未来 30 天预计余额</span><strong>{formatMoney(forecast, "MYR")}</strong><em><ArrowUpRight size={14} /> 预计安全</em></div>
        <div><span>SGD/MYR</span><strong>{latestSgdMyr.toFixed(2)}</strong><em>手动汇率</em></div>
        <div><span>USD/SGD</span><strong>{latestUsdSgd.toFixed(2)}</strong><em>手动汇率</em></div>
        <div><span>下一笔固定付款</span><strong>MYR 450</strong><em>保险 · 8月18日</em></div>
      </section>

      <section className="lower-grid">
        <div className="panel assets-panel">
          <div className="panel-title-row"><div><div className="panel-kicker">物品资产</div><h2>资产陈列柜</h2></div><button className="text-button" onClick={() => setActive("assets")}>查看全部 <ArrowUpRight size={16} /></button></div>
          <div className="asset-list">{data.assets.map((asset) => <div className="asset-item" key={asset.id}><div className={`asset-visual ${asset.category === "贵重资产" ? "gold" : asset.category === "创作" ? "camera" : "laptop"}`}><Briefcase size={24} weight="duotone" /></div><div className="asset-main"><strong>{asset.name}</strong><span>{asset.category}</span></div><div className="asset-numbers"><span>当前价值 <b>{formatMoney(asset.currentValue, asset.currency)}</b></span><span>日均成本 <b>{formatMoney(asset.dailyCost, asset.currency)}</b></span></div><div className="asset-status"><Check size={14} /> 服役中</div></div>)}</div>
        </div>
        <div className="panel insight-panel">
          <div className="panel-title-row"><div><div className="panel-kicker">今日观察</div><h2>理财师提醒</h2></div><Sparkle size={21} className="sparkle" weight="fill" /></div>
          <div className="insight-list"><div className="insight-row"><div className="insight-icon food"><Lightning size={17} weight="fill" /></div><div><strong>外食支出比过去三个月平均高 12%</strong><span>预计月底会超过 MYR 800 预算</span></div><ArrowUpRight size={17} /></div><div className="insight-row"><div className="insight-icon safe"><Check size={17} weight="bold" /></div><div><strong>本月保险预留已完成</strong><span>下一笔付款将在 8 月 18 日发生</span></div><ArrowUpRight size={17} /></div><div className="insight-row"><div className="insight-icon rate"><ArrowsLeftRight size={17} weight="bold" /></div><div><strong>SGD/MYR 汇率已更新</strong><span>你可以记录下一次换汇的有效汇率</span></div><ArrowUpRight size={17} /></div></div>
        </div>
      </section>

      <section className="lower-grid bottom-grid">
        <div className="panel watchlist-panel"><div className="panel-title-row"><div><div className="panel-kicker">重点关注</div><h2>Watchlist</h2></div><MagnifyingGlass size={19} /></div>{data.watchlists.map((watch) => <div className="watch-row" key={watch.id}><div><strong>{watch.name}</strong><span>过去 12 个月平均 {formatMoney(watch.average, watch.currency)}</span></div><div className="watch-progress"><span>{formatMoney(watch.spent, watch.currency)} / {formatMoney(watch.limit, watch.currency)}</span><div><i style={{ width: `${Math.min(100, (watch.spent / watch.limit) * 100)}%` }} /></div></div><div className={`watch-forecast ${watch.forecast > watch.limit ? "danger" : "ok"}`}>{watch.forecast > watch.limit ? "可能超支" : "预计正常"}</div></div>)}</div>
        <div className="panel actions-panel"><div className="panel-title-row"><div><div className="panel-kicker">快捷操作</div><h2>把今天的财务做好</h2></div></div><div className="action-grid"><button className="action-card primary" onClick={() => setModal("transaction")}><Receipt size={22} /><span>记一笔</span><small>记录收入或支出</small></button><button className="action-card" onClick={() => setModal("transfer")}><ArrowsLeftRight size={22} /><span>SGD 转 MYR</span><small>记录跨境资金流</small></button><button className="action-card" onClick={() => setModal("fx")}><Coins size={22} /><span>更新汇率</span><small>手动保存价格</small></button><button className="action-card" onClick={() => exportExcel(data)}><FileXls size={22} /><span>导出 Excel</span><small>生成完整工作簿</small></button></div></div>
      </section>
    </main>
  );

  return (
    <div className="app-shell">
      <div className="starfield" />
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Sparkle size={20} weight="fill" /></div><div><strong>我的财富星图</strong><span>WEALTH ATLAS</span></div></div>
        <nav>{navItems.map(({ label, icon: Icon, key }) => <button key={key} className={active === key ? "active" : ""} onClick={() => { setActive(key); if (key !== "home") showToast(`${label} 模块将在下一版本继续展开`); }}><Icon size={20} weight={active === key ? "fill" : "regular"} /><span>{label}</span></button>)}</nav>
        <div className="sidebar-bottom"><button className="side-action" onClick={() => setModal("transaction")}><Plus size={18} weight="bold" /> 记一笔</button><button className="side-action secondary" onClick={syncObsidian}><BookOpenText size={18} /> 同步 Obsidian</button><button className="side-action secondary" onClick={() => exportExcel(data)}><FileXls size={18} /> 导出 Excel</button><button className="settings-button"><GearSix size={18} /> 设置</button></div>
      </aside>
      {active === "home" ? renderHome() : <main className="main-content placeholder-page"><div className="page-header"><div><div className="breadcrumb">WEALTH ATLAS / MODULE</div><h1>{navItems.find((item) => item.key === active)?.label ?? "模块"}</h1></div></div><div className="panel empty-module"><Sparkle size={32} weight="fill" /><h2>这个模块已经进入你的产品地图</h2><p>首页的核心操作已经可以使用。下一步可以按 Git 版本继续展开这个模块，并保持同一套本地优先数据结构。</p><button className="primary-button" onClick={() => setActive("home")}>返回首页</button></div></main>}
      {modal && <Modal type={modal} onClose={() => setModal(null)} onTransaction={addTransaction} onTransfer={addTransfer} onFx={saveFxRate} transactionDraft={transactionDraft} setTransactionDraft={setTransactionDraft} transferDraft={transferDraft} setTransferDraft={setTransferDraft} fxDraft={fxDraft} setFxDraft={setFxDraft} />}
      {toast && <div className="toast"><Check size={17} weight="bold" /> {toast}<button onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  );
}

function Modal({ type, onClose, onTransaction, onTransfer, onFx, transactionDraft, setTransactionDraft, transferDraft, setTransferDraft, fxDraft, setFxDraft }: { type: ModalType; onClose: () => void; onTransaction: () => void; onTransfer: () => void; onFx: () => void; transactionDraft: { type: "income" | "expense"; amount: string; currency: CurrencyCode; category: string; merchant: string }; setTransactionDraft: React.Dispatch<React.SetStateAction<typeof transactionDraft>>; transferDraft: { amount: string; rate: string; fee: string }; setTransferDraft: React.Dispatch<React.SetStateAction<typeof transferDraft>>; fxDraft: { pair: string; rate: string; date: string; note: string }; setFxDraft: React.Dispatch<React.SetStateAction<typeof fxDraft>> }) {
  const title = type === "transaction" ? "记一笔" : type === "transfer" ? "SGD 转 MYR" : type === "fx" ? "更新汇率" : "添加目标";
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><div className="modal"><div className="modal-header"><div><div className="panel-kicker">WEALTH ATLAS / ACTION</div><h2>{title}</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>{type === "transaction" && <div className="form-stack"><div className="segmented"><button className={transactionDraft.type === "expense" ? "selected" : ""} onClick={() => setTransactionDraft((current) => ({ ...current, type: "expense" }))}>支出</button><button className={transactionDraft.type === "income" ? "selected" : ""} onClick={() => setTransactionDraft((current) => ({ ...current, type: "income" }))}>收入</button></div><label>金额<input type="number" placeholder="0.00" value={transactionDraft.amount} onChange={(event) => setTransactionDraft((current) => ({ ...current, amount: event.target.value }))} /></label><div className="form-grid"><label>货币<select value={transactionDraft.currency} onChange={(event) => setTransactionDraft((current) => ({ ...current, currency: event.target.value as CurrencyCode }))}><option>MYR</option><option>SGD</option><option>USD</option></select></label><label>分类<input value={transactionDraft.category} onChange={(event) => setTransactionDraft((current) => ({ ...current, category: event.target.value }))} /></label></div><label>商户或备注<input placeholder="例如：晚餐、Grab、软件订阅" value={transactionDraft.merchant} onChange={(event) => setTransactionDraft((current) => ({ ...current, merchant: event.target.value }))} /></label><button className="primary-button full" onClick={onTransaction}>保存交易</button></div>}{type === "transfer" && <div className="form-stack"><div className="transfer-pair"><span>SGD</span><ArrowsLeftRight size={18} /><span>MYR</span></div><label>转出金额（SGD）<input type="number" placeholder="2,000" value={transferDraft.amount} onChange={(event) => setTransferDraft((current) => ({ ...current, amount: event.target.value }))} /></label><label>手动汇率（1 SGD = MYR）<input type="number" step="0.0001" value={transferDraft.rate} onChange={(event) => setTransferDraft((current) => ({ ...current, rate: event.target.value }))} /></label><label>手续费（SGD）<input type="number" value={transferDraft.fee} onChange={(event) => setTransferDraft((current) => ({ ...current, fee: event.target.value }))} /></label><div className="conversion-preview">预计到账 <strong>MYR {((Number(transferDraft.amount) || 0) * (Number(transferDraft.rate) || 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><button className="primary-button full" onClick={onTransfer}>保存转账</button></div>}{type === "fx" && <div className="form-stack"><div className="form-grid"><label>汇率方向<select value={fxDraft.pair} onChange={(event) => setFxDraft((current) => ({ ...current, pair: event.target.value }))}><option>SGD/MYR</option><option>USD/SGD</option></select></label><label>汇率<input type="number" step="0.0001" value={fxDraft.rate} onChange={(event) => setFxDraft((current) => ({ ...current, rate: event.target.value }))} /></label></div><label>生效日期<input type="date" value={fxDraft.date} onChange={(event) => setFxDraft((current) => ({ ...current, date: event.target.value }))} /></label><label>备注<input placeholder="例如：银行实际到账汇率" value={fxDraft.note} onChange={(event) => setFxDraft((current) => ({ ...current, note: event.target.value }))} /></label><button className="primary-button full" onClick={onFx}>保存手动汇率</button></div>}{type === "goal" && <div className="empty-modal"><Target size={32} /><p>目标创建流程已预留。当前可以在首页查看已设定的目标星图。</p><button className="primary-button full" onClick={onClose}>知道了</button></div>}</div></div>;
}
