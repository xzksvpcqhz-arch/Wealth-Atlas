"use client";

import { useEffect, useMemo, useState, type Dispatch, type ElementType, type SetStateAction } from "react";
import {
  ArrowsLeftRight,
  ArrowRight,
  Bank,
  Bell,
  Briefcase,
  CalendarDots,
  ChartLineUp,
  ChartPieSlice,
  Check,
  Coins,
  CreditCard,
  FileXls,
  GearSix,
  House,
  ListChecks,
  Money,
  Plus,
  Receipt,
  Scales,
  ShieldCheck,
  Sparkle,
  Target,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { exportExcel } from "@/lib/exporters";
import ObsidianWorkbench from "@/components/ObsidianWorkbench";
import FxCenter from "@/components/FxCenter";
import {
  calculateFreeToSpend,
  convert,
  formatMoney,
  getAccountActivityCount,
  getAccountBalance,
  getBudgetRemaining,
  getBudgetSpent,
  getAnnualPlanTotal,
  getGoalGap,
  getGoalMonthsRemaining,
  getGoalPeriodLabel,
  getGoalProgress,
  getGoalRequiredPerPeriod,
  getGoalRequiredPerMonth,
  getLiquidBalanceInCurrency,
  getMonthTransactions,
  getRate,
  getRateAtDate,
  getRateRecord,
  createFxSnapshot,
  getTransferEffectiveRate,
  getCurrencyExposures,
  getLocalDate,
  getUpcomingPlannedPayments,
  totalExpensesInCurrency,
  totalIncomeInCurrency,
  totalInCurrency,
} from "@/lib/finance";
import { loadWealthData, saveWealthData } from "@/lib/storage";
import type { Account, CurrencyCode, Goal, MonthlyBudget, WealthData } from "@/lib/types";

const today = getLocalDate();
const currentMonth = today.slice(0, 7);
const currencies: CurrencyCode[] = ["SGD", "MYR", "USD"];

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
    { id: "transfer-1", fromAccountId: "sgd-main", toAccountId: "myr-main", fromAmount: 2000, fromCurrency: "SGD", toAmount: 6960, toCurrency: "MYR", rate: 3.48, fee: 5, feeCurrency: "SGD", date: "2026-08-02", inputRate: 3.48, actualRate: 3.48, effectiveRate: 3.4713216957605985, rateDate: "2026-08-02", rateSource: "手动输入", fxSnapshot: { originalAmount: 2000, originalCurrency: "SGD", convertedAmount: 6960, convertedCurrency: "MYR", rateDirection: "SGD/MYR", rate: 3.48, rateDate: "2026-08-02", rateSource: "手动输入", rateId: "sgd-myr-old", fee: 5, feeCurrency: "SGD", effectiveRate: 3.4713216957605985 } },
  ],
  fxRates: [
    { id: "sgd-myr", baseCurrency: "SGD", quoteCurrency: "MYR", rate: 3.48, effectiveDate: today, enteredAt: `${today}T08:00:00.000Z`, source: "手动输入", isDefault: true, active: true, useCount: 4, note: "当前手动输入" },
    { id: "sgd-myr-old", baseCurrency: "SGD", quoteCurrency: "MYR", rate: 3.42, effectiveDate: "2026-07-08", enteredAt: "2026-07-08T08:00:00.000Z", source: "手动输入", isDefault: false, active: true, useCount: 1, note: "历史记录" },
    { id: "usd-sgd", baseCurrency: "USD", quoteCurrency: "SGD", rate: 1.34, effectiveDate: today, enteredAt: `${today}T08:05:00.000Z`, source: "手动输入", isDefault: true, active: true, useCount: 2, note: "当前手动输入" },
    { id: "usd-sgd-old", baseCurrency: "USD", quoteCurrency: "SGD", rate: 1.31, effectiveDate: "2026-07-08", enteredAt: "2026-07-08T08:05:00.000Z", source: "手动输入", isDefault: false, active: true, useCount: 0, note: "历史记录" },
  ],
  budgets: [
    { id: "budget-food", month: currentMonth, category: "外食", limit: 800, currency: "MYR" },
    { id: "budget-shopping", month: currentMonth, category: "购物", limit: 600, currency: "MYR" },
  ],
  goals: [
    { id: "travel", name: "旅行基金", current: 7200, target: 10000, currency: "MYR", percent: 72, due: "2026-12-01", cadence: "monthly", status: "on-track" },
    { id: "house", name: "房屋首期", current: 38000, target: 100000, currency: "MYR", percent: 38, due: "2030-01-01", cadence: "yearly", status: "watch" },
    { id: "study", name: "学习基金", current: 4200, target: 5000, currency: "MYR", percent: 84, due: "2026-10-15", cadence: "custom", status: "on-track" },
  ],
  annualPlans: [
    { id: "plan-travel", year: 2026, month: 12, name: "年底旅行", category: "旅行", amount: 10000, currency: "MYR", status: "funded", goalId: "travel", note: "与旅行基金目标关联" },
    { id: "plan-insurance", year: 2026, month: 11, name: "保险年缴", category: "保险", amount: 5400, currency: "MYR", status: "planned", note: "提前两个月预留" },
    { id: "plan-device", year: 2027, month: 3, name: "设备更新", category: "数码", amount: 3000, currency: "MYR", status: "planned", note: "预留给下一台工作设备" },
  ],
  assets: [
    { id: "macbook", name: "MacBook", category: "数码", purchaseValue: 6999, currentValue: 4800, currency: "MYR", dailyCost: 3.42, usageDays: 642, status: "active" },
    { id: "camera", name: "相机", category: "创作", purchaseValue: 5500, currentValue: 4200, currency: "MYR", dailyCost: 2.74, usageDays: 475, status: "active" },
    { id: "gold", name: "黄金", category: "贵重资产", purchaseValue: 10000, currentValue: 11200, currency: "MYR", dailyCost: 3.84, usageDays: 312, status: "active" },
  ],
  plannedPayments: [
    { id: "insurance-reserve", name: "保险预留", amount: 450, currency: "MYR", due: `${currentMonth}-18`, cadence: "monthly", category: "保险" },
    { id: "sgd-transfer", name: "SGD 转 MYR", amount: 2000, currency: "SGD", due: `${currentMonth}-25`, cadence: "monthly", category: "资金转换" },
  ],
  watchlists: [
    { id: "food", name: "外食", spent: 620, limit: 800, average: 710, forecast: 940, currency: "MYR" },
    { id: "shopping", name: "购物", spent: 340, limit: 600, average: 520, forecast: 480, currency: "MYR" },
  ],
};

type ModalType = "transaction" | "transfer" | "fx" | "account" | "budget" | "goal" | "annual-plan" | null;
type NavItem = { label: string; icon: ElementType; key: string };
type TransactionDraft = { type: "income" | "expense"; accountId: string; amount: string; category: string; merchant: string; date: string; note: string };
type TransferDraft = { fromAccountId: string; toAccountId: string; amount: string; rate: string; fee: string; feeCurrency: CurrencyCode; date: string };
type AccountDraft = { name: string; type: Account["type"]; currency: CurrencyCode; balance: string };
type BudgetDraft = { month: string; category: string; limit: string; currency: CurrencyCode };
type GoalDraft = { name: string; current: string; target: string; currency: CurrencyCode; due: string; cadence: Goal["cadence"]; status: Goal["status"] };
type AnnualPlanDraft = { year: string; month: string; name: string; category: string; amount: string; currency: CurrencyCode; status: "planned" | "funded" | "complete"; goalId: string; note: string };

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
  { label: "汇率中心", icon: Coins, key: "fx" },
];

const accountTypeLabels: Record<Account["type"], string> = { bank: "银行账户", cash: "现金", investment: "投资账户", "credit-card": "信用卡" };

function getAccount(data: WealthData, id: string) {
  return data.accounts.find((account) => account.id === id);
}

function GoalEntryModal({ type, onClose, onGoal, onAnnualPlan, data, goalDraft, setGoalDraft, annualPlanDraft, setAnnualPlanDraft }: { type: "goal" | "annual-plan"; onClose: () => void; onGoal: () => void; onAnnualPlan: () => void; data: WealthData; goalDraft: GoalDraft; setGoalDraft: Dispatch<SetStateAction<GoalDraft>>; annualPlanDraft: AnnualPlanDraft; setAnnualPlanDraft: Dispatch<SetStateAction<AnnualPlanDraft>> }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="goal-modal-title"><div className="modal-header"><div><div className="panel-kicker">WEALTH ATLAS / PLAN</div><h2 id="goal-modal-title">{type === "goal" ? "新增储蓄目标" : "新增年度计划"}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>{type === "goal" ? <div className="form-stack"><label>目标名称<input placeholder="例如：旅行基金" value={goalDraft.name} onChange={(event) => setGoalDraft((draft) => ({ ...draft, name: event.target.value }))} /></label><div className="form-grid"><label>当前金额<input type="number" min="0" step="0.01" value={goalDraft.current} onChange={(event) => setGoalDraft((draft) => ({ ...draft, current: event.target.value }))} /></label><label>目标金额<input type="number" min="0" step="0.01" value={goalDraft.target} onChange={(event) => setGoalDraft((draft) => ({ ...draft, target: event.target.value }))} /></label></div><div className="form-grid"><label>币种<select value={goalDraft.currency} onChange={(event) => setGoalDraft((draft) => ({ ...draft, currency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label><label>目标周期<select value={goalDraft.cadence} onChange={(event) => setGoalDraft((draft) => ({ ...draft, cadence: event.target.value as Goal["cadence"] }))}><option value="monthly">每月</option><option value="quarterly">每季度</option><option value="yearly">每年</option><option value="custom">自定义周期</option></select></label></div><div className="form-grid"><label>截止日期<input type="date" value={goalDraft.due} onChange={(event) => setGoalDraft((draft) => ({ ...draft, due: event.target.value }))} /></label><label>状态<select value={goalDraft.status} onChange={(event) => setGoalDraft((draft) => ({ ...draft, status: event.target.value as Goal["status"] }))}><option value="on-track">进行中</option><option value="watch">需要关注</option><option value="paused">已暂停</option></select></label></div><p className="form-help">保存后会按截止日期计算剩余月份和每个目标周期建议金额。</p><button className="primary-button full" onClick={onGoal}>保存储蓄目标</button></div> : <div className="form-stack"><div className="form-grid"><label>年份<input type="number" min="2020" step="1" value={annualPlanDraft.year} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft, year: event.target.value }))} /></label><label>月份<select value={annualPlanDraft.month} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft, month: event.target.value }))}>{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={String(index + 1)}>{index + 1} 月</option>)}</select></label></div><label>计划名称<input placeholder="例如：保险年缴" value={annualPlanDraft.name} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft, name: event.target.value }))} /></label><div className="form-grid"><label>分类<input placeholder="例如：保险" value={annualPlanDraft.category} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft, category: event.target.value }))} /></label><label>金额<input type="number" min="0" step="0.01" value={annualPlanDraft.amount} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft, amount: event.target.value }))} /></label></div><div className="form-grid"><label>币种<select value={annualPlanDraft.currency} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft, currency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label><label>状态<select value={annualPlanDraft.status} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft, status: event.target.value as AnnualPlanDraft["status"] }))}><option value="planned">待准备</option><option value="funded">已预留</option><option value="complete">已完成</option></select></label></div><label>关联目标<select value={annualPlanDraft.goalId} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft, goalId: event.target.value }))}><option value="">不关联目标</option>{data.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.name}</option>)}</select></label><label>备注<input placeholder="可选说明" value={annualPlanDraft.note} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft, note: event.target.value }))} /></label><button className="primary-button full" onClick={onAnnualPlan}>保存年度计划</button></div>}</div></div>;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(`${date}T00:00:00`));
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function Stat({ icon: Icon, label, value, detail, tone = "cyan" }: { icon: ElementType; label: string; value: string; detail: string; tone?: string }) {
  return <div className="stat-cell"><div className={`stat-icon ${tone}`}><Icon size={18} weight="fill" /></div><div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-hint">{detail}</div></div></div>;
}

export default function WealthAtlasV2() {
  const [data, setData] = useState<WealthData>(initialData);
  const [active, setActive] = useState("home");
  const [fxMode, setFxMode] = useState(false);
  const [modal, setModal] = useState<ModalType>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [transactionFilter, setTransactionFilter] = useState<"all" | "income" | "expense">("all");
  const [fxDraft, setFxDraft] = useState({ pair: "SGD/MYR", rate: "3.48", date: today, note: "" });
  const [transactionDraft, setTransactionDraft] = useState<TransactionDraft>({ type: "expense", accountId: "myr-main", amount: "", category: "外食", merchant: "", date: today, note: "" });
  const [transferDraft, setTransferDraft] = useState<TransferDraft>({ fromAccountId: "sgd-main", toAccountId: "myr-main", amount: "", rate: "3.48", fee: "5", feeCurrency: "SGD", date: today });
  const [accountDraft, setAccountDraft] = useState<AccountDraft>({ name: "", type: "bank", currency: "SGD", balance: "0" });
  const [budgetDraft, setBudgetDraft] = useState<BudgetDraft>({ month: currentMonth, category: "外食", limit: "800", currency: "MYR" });
  const [goalPeriodFilter, setGoalPeriodFilter] = useState<"all" | Goal["cadence"]>("all");
  const [planYear, setPlanYear] = useState(Number(currentMonth.slice(0, 4)));
  const [goalDraft, setGoalDraft] = useState<GoalDraft>({ name: "", current: "0", target: "10000", currency: "MYR", due: `${Number(currentMonth.slice(0, 4))}-12-31`, cadence: "monthly", status: "on-track" });
  const [annualPlanDraft, setAnnualPlanDraft] = useState<AnnualPlanDraft>({ year: String(Number(currentMonth.slice(0, 4))), month: "12", name: "", category: "", amount: "0", currency: "MYR", status: "planned", goalId: "", note: "" });

  useEffect(() => {
    loadWealthData().then((saved) => {
      if (saved) setData({ ...initialData, ...saved, budgets: saved.budgets ?? initialData.budgets, annualPlans: saved.annualPlans ?? initialData.annualPlans });
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (active === "fx") {
      setFxMode(true);
      setActive("settings");
    } else if (active !== "settings") {
      setFxMode(false);
    }
  }, [active]);

  useEffect(() => { if (loaded) void saveWealthData(data); }, [data, loaded]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(null), 3200); return () => window.clearTimeout(timeout); }, [toast]);

  const reportCurrency = data.reportCurrency;
  const monthTransactions = useMemo(() => getMonthTransactions(data, currentMonth), [data]);
  const monthlyIncome = totalIncomeInCurrency({ ...data, transactions: monthTransactions }, reportCurrency);
  const monthlyExpenses = totalExpensesInCurrency({ ...data, transactions: monthTransactions }, reportCurrency);
  const liquidBalance = getLiquidBalanceInCurrency(data, reportCurrency);
  const freeToSpend = calculateFreeToSpend(data, currentMonth, today);
  const netWorth = totalInCurrency(data, reportCurrency) + data.assets.reduce((sum, asset) => sum + (convert(asset.currentValue, asset.currency, reportCurrency, data.fxRates) ?? 0), 0);
  const monthlyBudgets = (data.budgets ?? []).filter((budget) => budget.month === currentMonth);
  const budgetRemaining = monthlyBudgets.reduce((sum, budget) => sum + (convert(getBudgetRemaining(data, budget), budget.currency, reportCurrency, data.fxRates) ?? 0), 0);
  const upcomingPayments = getUpcomingPlannedPayments(data, currentMonth, today);
  const upcomingTotal = upcomingPayments.reduce((sum, payment) => sum + (convert(payment.amount, payment.currency, reportCurrency, data.fxRates) ?? 0), 0);
  const latestSgdMyr = getRate(data.fxRates, "SGD", "MYR") ?? 0;
  const latestUsdSgd = getRate(data.fxRates, "USD", "SGD") ?? 0;
  const currencyExposures = getCurrencyExposures(data, reportCurrency);

  const showToast = (message: string) => setToast(message);
  const openTransaction = () => { setTransactionDraft((draft) => ({ ...draft, accountId: draft.accountId || data.accounts[0]?.id || "" })); setModal("transaction"); };

  const addTransaction = () => {
    const amount = Number(transactionDraft.amount);
    const account = getAccount(data, transactionDraft.accountId);
    if (!account || !amount || amount <= 0 || !transactionDraft.category.trim()) return showToast("请填写账户、金额和分类");
    const rateRecord = getRateRecord(data.fxRates, account.currency, reportCurrency, transactionDraft.date);
    const historicalRate = getRateAtDate(data.fxRates, account.currency, reportCurrency, transactionDraft.date);
    const convertedAmount = historicalRate === null ? amount : amount * historicalRate;
    const fxSnapshot = createFxSnapshot({ amount, originalCurrency: account.currency, convertedAmount, convertedCurrency: reportCurrency, date: rateRecord?.effectiveDate ?? transactionDraft.date, rate: historicalRate ?? 1, rateId: rateRecord?.id, source: rateRecord?.source ?? "缺少汇率" });
    setData((current) => ({ ...current, transactions: [{ id: makeId("transaction"), type: transactionDraft.type, accountId: account.id, amount, currency: account.currency, category: transactionDraft.category.trim(), merchant: transactionDraft.merchant.trim() || undefined, date: transactionDraft.date, note: transactionDraft.note.trim() || undefined, convertedAmount, convertedCurrency: reportCurrency, fxRate: historicalRate ?? undefined, fxSnapshot }, ...current.transactions] }));
    setModal(null);
    showToast("交易已保存，账户余额已更新");
  };

  const addTransfer = () => {
    const amount = Number(transferDraft.amount);
    const rate = Number(transferDraft.rate);
    const fee = Number(transferDraft.fee) || 0;
    const from = getAccount(data, transferDraft.fromAccountId);
    const to = getAccount(data, transferDraft.toAccountId);
    if (!from || !to) return showToast("请选择有效的转出和转入账户");
    const feeCurrency = transferDraft.feeCurrency === to.currency ? to.currency : from.currency;
    const grossReceived = amount * rate;
    const receivedAmount = Math.max(0, grossReceived - (feeCurrency === to.currency ? fee : 0));
    const effectiveRate = getTransferEffectiveRate(amount, receivedAmount, fee, feeCurrency, from.currency);
    if (!from || !to || from.id === to.id || !amount || amount <= 0 || !rate || rate <= 0 || fee < 0 || receivedAmount <= 0) return showToast("请填写有效的转账账户、金额、手续费和汇率");
    const rateRecord = getRateRecord(data.fxRates, from.currency, to.currency, transferDraft.date);
    const fxSnapshot = createFxSnapshot({ amount, originalCurrency: from.currency, convertedAmount: receivedAmount, convertedCurrency: to.currency, date: rateRecord?.effectiveDate ?? transferDraft.date, rate, rateId: rateRecord?.id, source: rateRecord ? "手动输入" : "单笔覆盖", fee, feeCurrency });
    setData((current) => ({ ...current, transfers: [{ id: makeId("transfer"), fromAccountId: from.id, toAccountId: to.id, fromAmount: amount, fromCurrency: from.currency, toAmount: receivedAmount, toCurrency: to.currency, rate, fee, feeCurrency, date: transferDraft.date, inputRate: rate, actualRate: amount > 0 ? grossReceived / amount : rate, effectiveRate, rateDate: rateRecord?.effectiveDate ?? transferDraft.date, rateSource: rateRecord?.source ?? "单笔覆盖", fxSnapshot }, ...current.transfers] }));
    setModal(null);
    showToast(`${from.currency} 转账已保存，两个账户余额已联动`);
  };

  const addAccount = () => {
    const balance = Number(accountDraft.balance);
    if (!accountDraft.name.trim() || !Number.isFinite(balance)) return showToast("请填写账户名称和有效余额");
    setData((current) => ({ ...current, accounts: [...current.accounts, { id: makeId("account"), name: accountDraft.name.trim(), type: accountDraft.type, currency: accountDraft.currency, balance }] }));
    setAccountDraft({ name: "", type: "bank", currency: "SGD", balance: "0" });
    setModal(null);
    showToast("账户已添加");
  };

  const addBudget = () => {
    const limit = Number(budgetDraft.limit);
    if (!budgetDraft.category.trim() || !budgetDraft.month || !limit || limit <= 0) return showToast("请填写预算月份、分类和限额");
    setData((current) => ({ ...current, budgets: [...(current.budgets ?? []), { id: makeId("budget"), month: budgetDraft.month, category: budgetDraft.category.trim(), limit, currency: budgetDraft.currency }] }));
    setModal(null);
    showToast("月度预算已保存");
  };

  const addGoal = () => {
    const current = Number(goalDraft.current);
    const target = Number(goalDraft.target);
    if (!goalDraft.name.trim() || !Number.isFinite(current) || !Number.isFinite(target) || current < 0 || target <= 0 || current > target || !goalDraft.due) return showToast("请填写有效的目标名称、金额和截止日期");
    const goal = { id: makeId("goal"), name: goalDraft.name.trim(), current, target, currency: goalDraft.currency, percent: Math.round(target > 0 ? (current / target) * 100 : 0), due: goalDraft.due, cadence: goalDraft.cadence, status: goalDraft.status };
    setData((currentData) => ({ ...currentData, goals: [...currentData.goals, goal] }));
    setGoalDraft({ name: "", current: "0", target: "10000", currency: "MYR", due: `${Number(currentMonth.slice(0, 4))}-12-31`, cadence: "monthly", status: "on-track" });
    setModal(null);
    showToast("储蓄目标已保存");
  };

  const addAnnualPlan = () => {
    const year = Number(annualPlanDraft.year);
    const month = Number(annualPlanDraft.month);
    const amount = Number(annualPlanDraft.amount);
    if (!annualPlanDraft.name.trim() || !annualPlanDraft.category.trim() || !Number.isInteger(year) || year < 2020 || !Number.isInteger(month) || month < 1 || month > 12 || !amount || amount <= 0) return showToast("请填写有效的年度计划名称、月份和金额");
    setData((currentData) => ({ ...currentData, annualPlans: [...(currentData.annualPlans ?? []), { id: makeId("annual-plan"), year, month, name: annualPlanDraft.name.trim(), category: annualPlanDraft.category.trim(), amount, currency: annualPlanDraft.currency, status: annualPlanDraft.status, goalId: annualPlanDraft.goalId || undefined, note: annualPlanDraft.note.trim() || undefined }] }));
    setAnnualPlanDraft({ year: String(planYear), month: "12", name: "", category: "", amount: "0", currency: "MYR", status: "planned", goalId: "", note: "" });
    setModal(null);
    showToast("年度计划已保存");
  };

  const saveFxRate = () => {
    const rate = Number(fxDraft.rate);
    if (!rate || rate <= 0) return showToast("请输入有效汇率");
    const [baseCurrency, quoteCurrency] = fxDraft.pair.split("/") as [CurrencyCode, CurrencyCode];
    const enteredAt = new Date().toISOString();
    setData((current) => ({ ...current, fxRates: [...current.fxRates.map((item) => item.baseCurrency === baseCurrency && item.quoteCurrency === quoteCurrency ? { ...item, isDefault: false } : item), { id: makeId("fx"), baseCurrency, quoteCurrency, rate, effectiveDate: fxDraft.date, enteredAt, source: "手动输入", note: fxDraft.note || undefined, isDefault: true, active: true, useCount: 0 }] }));
    setModal(null);
    showToast(`${fxDraft.pair} 手动汇率已更新`);
  };

  const renderHeader = (eyebrow: string, title: string, action?: { label: string; onClick: () => void; icon?: ElementType }) => <header className="page-header module-header"><div><div className="breadcrumb">WEALTH ATLAS / {eyebrow}</div><h1>{title}</h1></div><div className="header-actions"><div className="month-select"><CalendarDots size={18} /> {currentMonth.replace("-", "年")}月</div>{action && <button className="primary-button compact" onClick={action.onClick}>{action.icon && <action.icon size={17} weight="bold" />}{action.label}</button>}<div className="local-pill"><ShieldCheck size={17} weight="fill" /> 本地数据</div></div></header>;

  const renderHome = () => <main className="main-content">
    {renderHeader("HOME", "我的财富星图", { label: "记一笔", onClick: openTransaction, icon: Plus })}
    <section className="hero-grid v2-hero-grid">
      <div className="panel cashflow-hero">
        <div className="panel-kicker">本月可自由使用</div>
        <div className="hero-number">{formatMoney(freeToSpend, reportCurrency)}</div>
        <div className="hero-support">流动余额 <strong>{formatMoney(liquidBalance, reportCurrency)}</strong></div>
        <div className="calculation-line"><span>预算剩余</span><b>- {formatMoney(budgetRemaining, reportCurrency)}</b><span>固定付款</span><b>- {formatMoney(upcomingTotal, reportCurrency)}</b></div>
        <div className="hero-note"><Check size={15} weight="bold" /> 余额来自账户流水与转账的实时合计</div>
      </div>
      <div className="panel stats-panel"><Stat icon={Wallet} label="本月收入" value={formatMoney(monthlyIncome, reportCurrency)} detail={`${monthTransactions.filter((item) => item.type === "income").length} 笔已关联账户`} /><Stat icon={Receipt} label="本月支出" value={formatMoney(monthlyExpenses, reportCurrency)} detail={`${monthTransactions.filter((item) => item.type === "expense").length} 笔已关联账户`} tone="amber" /><Stat icon={ChartLineUp} label="净资产" value={formatMoney(netWorth, reportCurrency)} detail="含投资账户与物品资产" tone="violet" /><Stat icon={Scales} label="预算剩余" value={formatMoney(budgetRemaining, reportCurrency)} detail={`${monthlyBudgets.length} 个本月预算`} tone="green" /></div>
      <div className="panel goals-panel account-snapshot-panel"><div className="panel-title-row"><div><div className="panel-kicker">账户总览</div><h2>钱现在在哪里</h2></div><button className="icon-button" onClick={() => setActive("accounts")} aria-label="查看账户"><ArrowsLeftRight size={18} /></button></div><div className="account-snapshot-list">{data.accounts.slice(0, 4).map((account) => <div className="account-snapshot-row" key={account.id}><div className={`account-type-icon ${account.type}`}><Bank size={17} /></div><div><strong>{account.name}</strong><span>{account.currency} · {getAccountActivityCount(data, account.id)} 笔活动</span></div><b>{formatMoney(getAccountBalance(data, account.id), account.currency)}</b></div>)}</div></div>
    </section>
    <section className="summary-strip"><div><span>流动账户余额</span><strong>{formatMoney(liquidBalance, reportCurrency)}</strong><em><Check size={14} /> 实时计算</em></div><button className="summary-rate" onClick={() => setActive("fx")}><span>SGD/MYR</span><strong>{latestSgdMyr.toFixed(2)}</strong><em>打开汇率中心</em></button><button className="summary-rate" onClick={() => setActive("fx")}><span>USD/SGD</span><strong>{latestUsdSgd.toFixed(2)}</strong><em>打开汇率中心</em></button><div><span>下一笔固定付款</span><strong>{upcomingPayments[0] ? formatMoney(upcomingPayments[0].amount, upcomingPayments[0].currency) : "暂无"}</strong><em>{upcomingPayments[0] ? `${upcomingPayments[0].name} · ${formatDate(upcomingPayments[0].due)}` : "本月已安排"}</em></div></section>
    <section className="panel currency-mini-panel"><div className="panel-title-row"><div><div className="panel-kicker">CURRENCY MAP</div><h2>货币暴露</h2></div><button className="text-button" onClick={() => setActive("fx")}>查看详情 <ArrowRight size={15} /></button></div><div className="currency-mini-list">{currencyExposures.map((row) => <div className="currency-mini-row" key={row.currency}><div><strong>{row.currency}</strong><span>{row.percent.toFixed(0)}%</span></div><div className="currency-mini-track"><span style={{ width: `${row.percent}%` }} /></div><small>{formatMoney(row.value, reportCurrency)} 报告价值</small></div>)}</div></section>
    <section className="lower-grid"><div className="panel assets-panel"><div className="panel-title-row"><div><div className="panel-kicker">本月活动</div><h2>最近记录</h2></div><button className="text-button" onClick={() => setActive("transactions")}>查看全部 <ArrowsLeftRight size={16} /></button></div><div className="activity-list">{monthTransactions.slice(0, 5).map((item) => <div className="activity-row" key={item.id}><div className={`activity-icon ${item.type}`}><Receipt size={17} /></div><div><strong>{item.merchant || item.category}</strong><span>{item.category} · {getAccount(data, item.accountId)?.name || "未关联"} · {formatDate(item.date)}</span></div><b className={item.type === "income" ? "positive" : "negative"}>{item.type === "income" ? "+" : "-"}{formatMoney(item.amount, item.currency)}</b></div>)}</div></div><div className="panel insight-panel"><div className="panel-title-row"><div><div className="panel-kicker">今日观察</div><h2>预算与汇率</h2></div><Sparkle size={21} className="sparkle" weight="fill" /></div><div className="insight-list"><div className="insight-row"><div className="insight-icon safe"><Check size={17} weight="bold" /></div><div><strong>可自由使用金额已接入真实余额</strong><span>账户、交易、转账和本月预算会共同影响结果</span></div></div><div className="insight-row"><div className="insight-icon rate"><ArrowsLeftRight size={17} weight="bold" /></div><div><strong>SGD/MYR {latestSgdMyr.toFixed(2)} · USD/SGD {latestUsdSgd.toFixed(2)}</strong><span>可从快捷操作继续记录手动汇率</span></div></div><div className="insight-row"><div className="insight-icon food"><ChartPieSlice size={17} weight="fill" /></div><div><strong>本月还有 {formatMoney(budgetRemaining, reportCurrency)} 预算空间</strong><span>下一笔固定付款预留 {formatMoney(upcomingTotal, reportCurrency)}</span></div></div></div></div></section>
    <section className="lower-grid bottom-grid"><div className="panel watchlist-panel"><div className="panel-title-row"><div><div className="panel-kicker">保存的结构</div><h2>目标与资产仍在这里</h2></div><Target size={19} /></div><div className="preserved-grid"><div><strong>{data.goals.length}</strong><span>储蓄目标</span></div><div><strong>{data.assets.length}</strong><span>物品资产</span></div><div><strong>{data.watchlists.length}</strong><span>关注项</span></div></div></div><div className="panel actions-panel"><div className="panel-title-row"><div><div className="panel-kicker">快捷操作</div><h2>继续记录</h2></div></div><div className="action-grid"><button className="action-card primary" onClick={openTransaction}><Receipt size={22} /><span>记录收支</span><small>收入或支出</small></button><button className="action-card" onClick={() => setModal("transfer")}><ArrowsLeftRight size={22} /><span>账户转账</span><small>跨币种与账户</small></button><button className="action-card" onClick={() => setModal("fx")}><Coins size={22} /><span>更新汇率</span><small>保留手动报价</small></button><button className="action-card" onClick={() => void exportExcel(data)}><FileXls size={22} /><span>导出 Excel</span><small>完整工作簿</small></button></div></div></section>
  </main>;

  const renderAccounts = () => <main className="main-content module-page">{renderHeader("ACCOUNTS", "账户管理", { label: "新增账户", onClick: () => setModal("account"), icon: Plus })}<section className="module-summary"><div><span>可用流动余额</span><strong>{formatMoney(liquidBalance, reportCurrency)}</strong><small>只计入银行与现金账户</small></div><div><span>全部账户净值</span><strong>{formatMoney(totalInCurrency(data, reportCurrency), reportCurrency)}</strong><small>包含投资账户</small></div><div><span>账户数量</span><strong>{data.accounts.length}</strong><small>每笔记录都必须绑定账户</small></div></section><div className="module-toolbar"><div><div className="panel-kicker">BALANCE LEDGER</div><h2>余额由流水推导</h2></div><p>开户余额 + 收入 - 支出 - 转出 + 转入。转账不会凭空改变净资产。</p></div><section className="account-grid">{data.accounts.map((account) => { const balance = getAccountBalance(data, account.id); return <article className="panel account-card" key={account.id}><div className="account-card-top"><div className={`account-type-icon ${account.type}`}><Bank size={20} /></div><span className="currency-badge">{account.currency}</span></div><h3>{account.name}</h3><div className="account-balance">{formatMoney(balance, account.currency)}</div><div className="account-meta"><span>{accountTypeLabels[account.type]}</span><span>{getAccountActivityCount(data, account.id)} 笔活动</span></div><div className="account-card-foot"><span>开户余额 {formatMoney(account.balance, account.currency)}</span><button className="text-button" onClick={() => { setActive("transactions"); setTransactionFilter("all"); }}>查看活动</button></div></article>; })}</section></main>;

  const records = [...data.transactions.map((item) => ({ kind: item.type, id: item.id, date: item.date, title: item.merchant || item.category, subtitle: `${item.category} · ${getAccount(data, item.accountId)?.name || "未关联账户"}`, amount: item.amount, currency: item.currency })), ...data.transfers.map((item) => ({ kind: "transfer" as const, id: item.id, date: item.date, title: `${getAccount(data, item.fromAccountId)?.name || item.fromCurrency} → ${getAccount(data, item.toAccountId)?.name || item.toCurrency}`, subtitle: `汇率 ${item.rate.toFixed(4)} · 手续费 ${formatMoney(item.fee, item.feeCurrency)}`, amount: item.fromAmount, currency: item.fromCurrency }))].filter((item) => transactionFilter === "all" || item.kind === transactionFilter).sort((a, b) => b.date.localeCompare(a.date));

  const renderTransactions = () => <main className="main-content module-page">{renderHeader("TRANSACTIONS", "收支与转账", { label: "记录收支", onClick: openTransaction, icon: Plus })}<div className="module-toolbar transaction-toolbar"><div><div className="panel-kicker">ACTIVITY LOG</div><h2>{records.length} 笔记录</h2></div><button className="secondary-button" onClick={() => setModal("transfer")}><ArrowsLeftRight size={17} /> 记录转账</button></div><div className="filter-tabs">{(["all", "income", "expense"] as const).map((filter) => <button key={filter} className={transactionFilter === filter ? "active" : ""} onClick={() => setTransactionFilter(filter)}>{filter === "all" ? "全部" : filter === "income" ? "收入" : "支出"}<span>{filter === "all" ? data.transactions.length + data.transfers.length : data.transactions.filter((item) => item.type === filter).length}</span></button>)}</div><section className="panel record-panel"><div className="record-head"><span>日期与分类</span><span>账户 / 说明</span><span>金额</span></div>{records.length ? records.map((record) => <div className="record-row" key={`${record.kind}-${record.id}`}><div className={`record-icon ${record.kind}`}><Receipt size={17} /></div><div><strong>{record.title}</strong><span>{formatDate(record.date)} · {record.kind === "transfer" ? "转账" : record.kind === "income" ? "收入" : "支出"}</span></div><div className="record-subtitle">{record.subtitle}</div><b className={record.kind === "income" ? "positive" : record.kind === "expense" ? "negative" : "transfer"}>{record.kind === "income" ? "+" : record.kind === "expense" ? "-" : "↔ "}{formatMoney(record.amount, record.currency)}</b></div>) : <div className="empty-state"><ListChecks size={30} /><strong>还没有匹配记录</strong><span>从“记录收支”开始，所有记录都会绑定到对应账户。</span><button className="primary-button compact" onClick={openTransaction}>新增第一笔</button></div>}</section></main>;

  const renderBudget = () => <main className="main-content module-page">{renderHeader("BUDGET", "月度预算", { label: "新增预算", onClick: () => setModal("budget"), icon: Plus })}<section className="budget-hero-grid"><div className="panel budget-free-panel"><div className="panel-kicker">本月可自由使用</div><strong>{formatMoney(freeToSpend, reportCurrency)}</strong><p>从流动余额开始，扣除本月每个预算的剩余额度，再扣除今天之后的固定付款。</p><div className="budget-formula"><span>流动余额<b>{formatMoney(liquidBalance, reportCurrency)}</b></span><span>预算剩余<b>- {formatMoney(budgetRemaining, reportCurrency)}</b></span><span>固定付款<b>- {formatMoney(upcomingTotal, reportCurrency)}</b></span></div></div><div className="panel budget-side-panel"><div className="panel-kicker">本月节奏</div><div className="budget-side-row"><span>已用预算</span><strong>{formatMoney(Math.max(0, monthlyBudgets.reduce((sum, budget) => sum + (convert(getBudgetSpent(data, budget), budget.currency, reportCurrency, data.fxRates) ?? 0), 0)), reportCurrency)}</strong></div><div className="budget-side-row"><span>收入 - 支出</span><strong>{formatMoney(monthlyIncome - monthlyExpenses, reportCurrency)}</strong></div><div className="budget-side-row"><span>本月记录</span><strong>{monthTransactions.length} 笔</strong></div></div></section><div className="module-toolbar"><div><div className="panel-kicker">{currentMonth} · MONTHLY PLAN</div><h2>分类预算</h2></div><p>预算只统计同月份、同分类的支出，并按手动汇率换算到报告币种。</p></div><section className="budget-list">{monthlyBudgets.length ? monthlyBudgets.map((budget) => { const spent = getBudgetSpent(data, budget); const remaining = getBudgetRemaining(data, budget); const percent = Math.min(100, budget.limit ? (spent / budget.limit) * 100 : 0); return <article className="panel budget-row" key={budget.id}><div className="budget-category"><div className="budget-dot" /><div><strong>{budget.category}</strong><span>{budget.currency} · {budget.month}</span></div></div><div className="budget-progress"><div><span style={{ width: `${percent}%` }} /></div><small>{formatMoney(spent, budget.currency)} / {formatMoney(budget.limit, budget.currency)}</small></div><div className={`budget-remaining ${remaining <= 0 ? "danger" : ""}`}><span>剩余</span><strong>{formatMoney(remaining, budget.currency)}</strong></div></article>; }) : <div className="empty-state panel"><ChartPieSlice size={30} /><strong>还没有本月预算</strong><span>添加一个分类限额，让可自由使用金额开始变得可解释。</span><button className="primary-button compact" onClick={() => setModal("budget")}>新增预算</button></div>}</section>{upcomingPayments.length > 0 && <section className="panel commitments-panel"><div className="panel-title-row"><div><div className="panel-kicker">UPCOMING COMMITMENTS</div><h2>本月固定付款</h2></div><CalendarDots size={19} /></div>{upcomingPayments.map((payment) => <div className="commitment-row" key={payment.id}><div><strong>{payment.name}</strong><span>{payment.category} · {formatDate(payment.due)}</span></div><b>{formatMoney(payment.amount, payment.currency)}</b></div>)}</section>}</main>;

  const renderGoals = () => {
    const visibleGoals = data.goals.filter((goal) => goalPeriodFilter === "all" || goal.cadence === goalPeriodFilter);
    const totalCurrent = data.goals.reduce((sum, goal) => sum + (convert(goal.current, goal.currency, reportCurrency, data.fxRates) ?? 0), 0);
    const totalTarget = data.goals.reduce((sum, goal) => sum + (convert(goal.target, goal.currency, reportCurrency, data.fxRates) ?? 0), 0);
    const totalGap = Math.max(0, totalTarget - totalCurrent);
    const totalProgress = totalTarget > 0 ? Math.round((totalCurrent / totalTarget) * 100) : 0;
    const plans = (data.annualPlans ?? []).filter((plan) => plan.year === planYear).sort((a, b) => a.month - b.month);
    const planTotal = getAnnualPlanTotal(data, planYear, reportCurrency);
    const fundedPlanTotal = plans.filter((plan) => plan.status !== "planned").reduce((sum, plan) => sum + (convert(plan.amount, plan.currency, reportCurrency, data.fxRates) ?? 0), 0);
    const statusLabels = { "on-track": "进行中", watch: "需要关注", paused: "已暂停" };
    const planStatusLabels = { planned: "待准备", funded: "已预留", complete: "已完成" };
    const planGoalName = (goalId?: string) => data.goals.find((goal) => goal.id === goalId)?.name;

    return <main className="main-content module-page goals-page">{renderHeader("GOALS", "储蓄目标与年度计划", { label: "新增目标", onClick: () => setModal("goal"), icon: Plus })}<section className="goals-summary"><div><span>目标当前累计</span><strong>{formatMoney(totalCurrent, reportCurrency)}</strong><small>{data.goals.length} 个储蓄目标</small></div><div><span>目标总额</span><strong>{formatMoney(totalTarget, reportCurrency)}</strong><small>按当前手动汇率换算</small></div><div><span>待完成差额</span><strong>{formatMoney(totalGap, reportCurrency)}</strong><small>距离全部目标</small></div><div><span>整体进度</span><strong>{totalProgress}%</strong><small>当前 / 目标</small></div></section><section className="goals-workspace"><div className="panel goal-focus-panel"><div className="panel-title-row"><div><div className="panel-kicker">SAVINGS MAP</div><h2>目标周期与储蓄节奏</h2></div><Target size={21} className="sparkle" /></div><p className="module-intro">每个目标都会根据截止日期计算剩余月份，并显示下一周期需要准备的金额。</p><div className="period-tabs">{(["all", "monthly", "quarterly", "yearly", "custom"] as const).map((period) => <button key={period} className={goalPeriodFilter === period ? "active" : ""} onClick={() => setGoalPeriodFilter(period)}>{period === "all" ? "全部" : period === "monthly" ? "每月" : period === "quarterly" ? "每季度" : period === "yearly" ? "每年" : "自定义"}</button>)}</div><div className="goal-list">{visibleGoals.length ? visibleGoals.map((goal) => { const progress = getGoalProgress(goal); const gap = getGoalGap(goal); const months = getGoalMonthsRemaining(goal, today); const perMonth = getGoalRequiredPerMonth(goal, today); const perPeriod = getGoalRequiredPerPeriod(goal, today); return <article className="goal-card" key={goal.id}><div className="goal-card-top"><div><strong>{goal.name}</strong><span>{getGoalPeriodLabel(goal.cadence)} · 截止 {formatDate(goal.due)}</span></div><span className={`goal-status ${goal.status}`}>{statusLabels[goal.status]}</span></div><div className="goal-progress-row"><div className="goal-progress"><span style={{ width: `${progress}%` }} /></div><b>{Math.round(progress)}%</b></div><div className="goal-card-meta"><span>已存 <b>{formatMoney(goal.current, goal.currency)}</b></span><span>目标 <b>{formatMoney(goal.target, goal.currency)}</b></span><span>差额 <b>{formatMoney(gap, goal.currency)}</b></span></div><div className="goal-cycle"><div><span>剩余周期</span><strong>{months} 个月</strong></div><div><span>{goal.cadence === "quarterly" ? "每季度建议" : "每月建议"}</span><strong>{formatMoney(goal.cadence === "quarterly" ? perPeriod : perMonth, goal.currency)}</strong></div></div></article>; }) : <div className="empty-state"><Target size={30} /><strong>没有匹配的目标周期</strong><span>切换周期筛选，或新增一个储蓄目标。</span><button className="primary-button compact" onClick={() => setModal("goal")}>新增目标</button></div>}</div></div><div className="panel annual-plan-panel"><div className="panel-title-row"><div><div className="panel-kicker">ANNUAL ROADMAP</div><h2>{planYear} 年度计划</h2></div><button className="secondary-button compact" onClick={() => setModal("annual-plan")}><Plus size={16} /> 新增计划</button></div><div className="year-switcher"><button className="icon-button" onClick={() => setPlanYear((year) => year - 1)} aria-label="上一年">←</button><strong>{planYear}</strong><button className="icon-button" onClick={() => setPlanYear((year) => year + 1)} aria-label="下一年">→</button></div><div className="annual-summary"><div><span>年度总额</span><b>{formatMoney(planTotal, reportCurrency)}</b></div><div><span>已预留</span><b>{formatMoney(fundedPlanTotal, reportCurrency)}</b></div></div><div className="annual-plan-list">{plans.length ? plans.map((plan) => <div className="annual-plan-row" key={plan.id}><div className="annual-month">{String(plan.month).padStart(2, "0")}<small>月</small></div><div><strong>{plan.name}</strong><span>{plan.category}{planGoalName(plan.goalId) ? ` · 关联 ${planGoalName(plan.goalId)}` : ""}</span></div><div className={`plan-status ${plan.status}`}>{planStatusLabels[plan.status]}</div><b>{formatMoney(plan.amount, plan.currency)}</b></div>) : <div className="empty-state"><CalendarDots size={28} /><strong>这一年还没有计划</strong><span>把大额支出或年度储蓄动作放到时间线上。</span><button className="secondary-button compact" onClick={() => setModal("annual-plan")}>新增年度计划</button></div>}</div></div></section></main>;
  };

  const renderSettings = () => fxMode ? <FxCenter data={data} setData={setData} onToast={showToast} onNavigate={(page) => setActive(page)} /> : <ObsidianWorkbench mode="settings" data={data} setData={setData} onToast={showToast} onNavigate={(page) => setActive(page)} />;
  const renderObsidian = () => <ObsidianWorkbench mode="sync" data={data} setData={setData} onToast={showToast} onNavigate={(page) => setActive(page)} />;
  const renderPlaceholder = () => <main className="main-content placeholder-page"><div className="page-header"><div><div className="breadcrumb">WEALTH ATLAS / MODULE</div><h1>{navItems.find((item) => item.key === active)?.label ?? "模块"}</h1></div></div><div className="panel empty-module"><Sparkle size={32} weight="fill" /><h2>这个模块保留在你的产品地图里</h2><p>本次版本先把账户、交易和预算闭环跑通，现有目标、资产、保险、报表和提醒结构仍然保留。</p><button className="primary-button" onClick={() => setActive("home")}>返回首页</button></div></main>;

  return <div className="app-shell"><div className="starfield" /><aside className="sidebar"><div className="brand"><div className="brand-mark"><Sparkle size={20} weight="fill" /></div><div><strong>我的财富星图</strong><span>WEALTH ATLAS</span></div></div><nav>{navItems.map(({ label, icon: Icon, key }) => <button key={key} className={active === key ? "active" : ""} onClick={() => setActive(key)}><Icon size={20} weight={active === key ? "fill" : "regular"} /><span>{label}</span></button>)}</nav><div className="sidebar-bottom"><button className="side-action" onClick={openTransaction}><Plus size={18} weight="bold" /> 记一笔</button><button className="side-action secondary" onClick={() => setModal("transfer")}><ArrowsLeftRight size={18} /> 记转账</button><button className="side-action secondary" onClick={() => setActive("obsidian")}><ShieldCheck size={18} /> 同步 Obsidian</button><button className="side-action secondary" onClick={() => void exportExcel(data)}><FileXls size={18} /> 导出 Excel</button><button className="settings-button" onClick={() => setActive("settings")}><GearSix size={18} /> 设置</button></div></aside>{active === "home" ? renderHome() : active === "accounts" ? renderAccounts() : active === "transactions" ? renderTransactions() : active === "budget" ? renderBudget() : active === "goals" ? renderGoals() : active === "obsidian" ? renderObsidian() : active === "settings" ? renderSettings() : renderPlaceholder()}{modal && <EntryModal type={modal} onClose={() => setModal(null)} onTransaction={addTransaction} onTransfer={addTransfer} onAccount={addAccount} onBudget={addBudget} onGoal={addGoal} onAnnualPlan={addAnnualPlan} onFx={saveFxRate} data={data} transactionDraft={transactionDraft} setTransactionDraft={setTransactionDraft} transferDraft={transferDraft} setTransferDraft={setTransferDraft} accountDraft={accountDraft} setAccountDraft={setAccountDraft} budgetDraft={budgetDraft} setBudgetDraft={setBudgetDraft} goalDraft={goalDraft} setGoalDraft={setGoalDraft} annualPlanDraft={annualPlanDraft} setAnnualPlanDraft={setAnnualPlanDraft} fxDraft={fxDraft} setFxDraft={setFxDraft} />}{toast && <div className="toast"><Check size={17} weight="bold" /> {toast}<button onClick={() => setToast(null)} aria-label="关闭提示"><X size={15} /></button></div>}</div>;
}

function EntryModal({ type, onClose, onTransaction, onTransfer, onAccount, onBudget, onGoal, onAnnualPlan, onFx, data, transactionDraft, setTransactionDraft, transferDraft, setTransferDraft, accountDraft, setAccountDraft, budgetDraft, setBudgetDraft, goalDraft, setGoalDraft, annualPlanDraft, setAnnualPlanDraft, fxDraft, setFxDraft }: { type: Exclude<ModalType, null>; onClose: () => void; onTransaction: () => void; onTransfer: () => void; onAccount: () => void; onBudget: () => void; onGoal: () => void; onAnnualPlan: () => void; onFx: () => void; data: WealthData; transactionDraft: TransactionDraft; setTransactionDraft: Dispatch<SetStateAction<TransactionDraft>>; transferDraft: TransferDraft; setTransferDraft: Dispatch<SetStateAction<TransferDraft>>; accountDraft: AccountDraft; setAccountDraft: Dispatch<SetStateAction<AccountDraft>>; budgetDraft: BudgetDraft; setBudgetDraft: Dispatch<SetStateAction<BudgetDraft>>; goalDraft: GoalDraft; setGoalDraft: Dispatch<SetStateAction<GoalDraft>>; annualPlanDraft: AnnualPlanDraft; setAnnualPlanDraft: Dispatch<SetStateAction<AnnualPlanDraft>>; fxDraft: { pair: string; rate: string; date: string; note: string }; setFxDraft: Dispatch<SetStateAction<{ pair: string; rate: string; date: string; note: string }>> }) {
  const titles: Record<Exclude<ModalType, null>, string> = { transaction: "记录一笔收支", transfer: "记录账户转账", account: "新增账户", budget: "新增月度预算", goal: "新增储蓄目标", "annual-plan": "新增年度计划", fx: "更新手动汇率" };
  const from = data.accounts.find((account) => account.id === transferDraft.fromAccountId);
  const to = data.accounts.find((account) => account.id === transferDraft.toAccountId);
  if (type === "goal" || type === "annual-plan") return <GoalEntryModal type={type} onClose={onClose} onGoal={onGoal} onAnnualPlan={onAnnualPlan} data={data} goalDraft={goalDraft} setGoalDraft={setGoalDraft} annualPlanDraft={annualPlanDraft} setAnnualPlanDraft={setAnnualPlanDraft} />;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="entry-modal-title"><div className="modal-header"><div><div className="panel-kicker">WEALTH ATLAS / ACTION</div><h2 id="entry-modal-title">{titles[type]}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>{type === "transaction" && <div className="form-stack"><div className="segmented"><button className={transactionDraft.type === "expense" ? "selected" : ""} onClick={() => setTransactionDraft((draft) => ({ ...draft, type: "expense" }))}>支出</button><button className={transactionDraft.type === "income" ? "selected" : ""} onClick={() => setTransactionDraft((draft) => ({ ...draft, type: "income" }))}>收入</button></div><label>关联账户<select value={transactionDraft.accountId} onChange={(event) => setTransactionDraft((draft) => ({ ...draft, accountId: event.target.value }))}>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label><label>金额<input type="number" min="0" step="0.01" placeholder="0.00" value={transactionDraft.amount} onChange={(event) => setTransactionDraft((draft) => ({ ...draft, amount: event.target.value }))} /></label><div className="form-grid"><label>分类<input value={transactionDraft.category} onChange={(event) => setTransactionDraft((draft) => ({ ...draft, category: event.target.value }))} /></label><label>日期<input type="date" value={transactionDraft.date} onChange={(event) => setTransactionDraft((draft) => ({ ...draft, date: event.target.value }))} /></label></div><label>商户或备注<input placeholder="例如：晚餐、Grab、软件订阅" value={transactionDraft.merchant} onChange={(event) => setTransactionDraft((draft) => ({ ...draft, merchant: event.target.value }))} /></label><button className="primary-button full" onClick={onTransaction}>保存收支</button></div>}{type === "transfer" && <div className="form-stack"><div className="form-grid"><label>转出账户<select value={transferDraft.fromAccountId} onChange={(event) => setTransferDraft((draft) => ({ ...draft, fromAccountId: event.target.value }))}>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label><label>转入账户<select value={transferDraft.toAccountId} onChange={(event) => setTransferDraft((draft) => ({ ...draft, toAccountId: event.target.value }))}>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label></div><div className="transfer-pair"><span>{from?.currency || "SGD"}</span><ArrowsLeftRight size={18} /><span>{to?.currency || "MYR"}</span></div><label>转出金额<input type="number" min="0" step="0.01" placeholder="2,000" value={transferDraft.amount} onChange={(event) => setTransferDraft((draft) => ({ ...draft, amount: event.target.value }))} /></label><label>手动汇率（1 {from?.currency || "SGD"} = {to?.currency || "MYR"}）<input type="number" min="0" step="0.0001" value={transferDraft.rate} onChange={(event) => setTransferDraft((draft) => ({ ...draft, rate: event.target.value }))} /></label><label>手续费（{from?.currency || "SGD"}）<input type="number" min="0" step="0.01" value={transferDraft.fee} onChange={(event) => setTransferDraft((draft) => ({ ...draft, fee: event.target.value }))} /></label><label>日期<input type="date" value={transferDraft.date} onChange={(event) => setTransferDraft((draft) => ({ ...draft, date: event.target.value }))} /></label><div className="conversion-preview">预计到账 <strong>{to?.currency || "MYR"} {((Number(transferDraft.amount) || 0) * (Number(transferDraft.rate) || 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><button className="primary-button full" onClick={onTransfer}>保存转账</button></div>}{type === "account" && <div className="form-stack"><label>账户名称<input placeholder="例如：日常现金" value={accountDraft.name} onChange={(event) => setAccountDraft((draft) => ({ ...draft, name: event.target.value }))} /></label><div className="form-grid"><label>类型<select value={accountDraft.type} onChange={(event) => setAccountDraft((draft) => ({ ...draft, type: event.target.value as Account["type"] }))}><option value="bank">银行账户</option><option value="cash">现金</option><option value="investment">投资账户</option><option value="credit-card">信用卡</option></select></label><label>币种<select value={accountDraft.currency} onChange={(event) => setAccountDraft((draft) => ({ ...draft, currency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label></div><label>开户余额<input type="number" step="0.01" value={accountDraft.balance} onChange={(event) => setAccountDraft((draft) => ({ ...draft, balance: event.target.value }))} /></label><p className="form-help">以后新增的收支和转账可以直接选择这个账户，余额会自动联动。</p><button className="primary-button full" onClick={onAccount}>保存账户</button></div>}{type === "budget" && <div className="form-stack"><div className="form-grid"><label>月份<input type="month" value={budgetDraft.month} onChange={(event) => setBudgetDraft((draft) => ({ ...draft, month: event.target.value }))} /></label><label>币种<select value={budgetDraft.currency} onChange={(event) => setBudgetDraft((draft) => ({ ...draft, currency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label></div><label>分类<input placeholder="例如：外食" value={budgetDraft.category} onChange={(event) => setBudgetDraft((draft) => ({ ...draft, category: event.target.value }))} /></label><label>月度限额<input type="number" min="0" step="0.01" value={budgetDraft.limit} onChange={(event) => setBudgetDraft((draft) => ({ ...draft, limit: event.target.value }))} /></label><p className="form-help">同月份、同分类的支出会从限额中扣除，其他币种会按当前手动汇率换算。</p><button className="primary-button full" onClick={onBudget}>保存预算</button></div>}{type === "fx" && <div className="form-stack"><div className="form-grid"><label>汇率方向<select value={fxDraft.pair} onChange={(event) => setFxDraft((draft) => ({ ...draft, pair: event.target.value }))}><option>SGD/MYR</option><option>USD/SGD</option></select></label><label>汇率<input type="number" min="0" step="0.0001" value={fxDraft.rate} onChange={(event) => setFxDraft((draft) => ({ ...draft, rate: event.target.value }))} /></label></div><label>生效日期<input type="date" value={fxDraft.date} onChange={(event) => setFxDraft((draft) => ({ ...draft, date: event.target.value }))} /></label><label>备注<input placeholder="例如：银行实际到账汇率" value={fxDraft.note} onChange={(event) => setFxDraft((draft) => ({ ...draft, note: event.target.value }))} /></label><button className="primary-button full" onClick={onFx}>保存手动汇率</button></div>}</div></div>;
}
