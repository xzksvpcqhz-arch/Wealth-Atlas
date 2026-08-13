import type { CurrencyCode, FxRate, FxSnapshot, Goal, MonthlyBudget, PlannedPayment, Watchlist, WealthData } from "./types";

export function getLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const formatMoney = (amount: number, currency: CurrencyCode = "MYR") =>
  new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);

export function getRate(rates: FxRate[], base: CurrencyCode, quote: CurrencyCode): number | null {
  if (base === quote) return 1;
  const direct = getRateRecord(rates, base, quote);
  if (direct) return direct.rate;
  const reverse = getRateRecord(rates, quote, base);
  if (reverse) return 1 / reverse.rate;

  // Keep the three supported currencies composable. This makes USD → SGD → MYR
  // valuation explicit while preserving the original manual rates.
  const bridge: CurrencyCode = base === "MYR" ? "SGD" : base === "USD" ? "SGD" : "MYR";
  if (bridge !== base && bridge !== quote) {
    const first = getRate(rates, base, bridge);
    const second = getRate(rates, bridge, quote);
    if (first !== null && second !== null) return first * second;
  }
  return null;
}

export function getRateRecord(rates: FxRate[], base: CurrencyCode, quote: CurrencyCode, asOfDate?: string, includeInactive = false) {
  return [...rates]
    .filter((rate) => rate.baseCurrency === base && rate.quoteCurrency === quote && (includeInactive || rate.active !== false) && (!asOfDate || rate.effectiveDate <= asOfDate))
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || (b.enteredAt ?? "").localeCompare(a.enteredAt ?? ""))[0] ?? null;
}

export function getRateAtDate(rates: FxRate[], base: CurrencyCode, quote: CurrencyCode, asOfDate: string): number | null {
  if (base === quote) return 1;
  const direct = getRateRecord(rates, base, quote, asOfDate, true);
  if (direct) return direct.rate;
  const reverse = getRateRecord(rates, quote, base, asOfDate, true);
  if (reverse) return 1 / reverse.rate;
  const bridge: CurrencyCode = base === "MYR" ? "SGD" : base === "USD" ? "SGD" : "MYR";
  if (bridge !== base && bridge !== quote) {
    const first: number | null = getRateAtDate(rates, base, bridge, asOfDate);
    const second: number | null = getRateAtDate(rates, bridge, quote, asOfDate);
    if (first !== null && second !== null) return first * second;
  }
  return null;
}

export function getRateAgeDays(rate: FxRate | null, fromDate = getLocalDate()) {
  if (!rate) return null;
  const from = new Date(`${fromDate}T00:00:00Z`).getTime();
  const effective = new Date(`${rate.effectiveDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((from - effective) / 86400000));
}

export function getFxUsageCount(data: WealthData, rateId: string) {
  const transactionUses = data.transactions.filter((item) => !item.deleted && item.fxSnapshot?.rateId === rateId).length;
  const transferUses = data.transfers.filter((item) => !item.deleted && item.fxSnapshot?.rateId === rateId).length;
  return transactionUses + transferUses;
}

export function createFxSnapshot({ amount, originalCurrency, convertedAmount, convertedCurrency, date, rate, rateId, source = "手动输入", fee = 0, feeCurrency = originalCurrency }: { amount: number; originalCurrency: CurrencyCode; convertedAmount: number; convertedCurrency: CurrencyCode; date: string; rate: number; rateId?: string; source?: string; fee?: number; feeCurrency?: CurrencyCode }): FxSnapshot {
  const effectiveRate = amount + (feeCurrency === originalCurrency ? fee : 0) > 0 ? convertedAmount / (amount + (feeCurrency === originalCurrency ? fee : 0)) : rate;
  return { originalAmount: amount, originalCurrency, convertedAmount, convertedCurrency, rateDirection: `${originalCurrency}/${convertedCurrency}`, rate, rateDate: date, rateSource: source, rateId, fee, feeCurrency, effectiveRate };
}

export function getTransferEffectiveRate(fromAmount: number, receivedAmount: number, fee: number, feeCurrency: CurrencyCode, fromCurrency: CurrencyCode) {
  const actualDebited = fromAmount + (feeCurrency === fromCurrency ? fee : 0);
  return actualDebited > 0 ? receivedAmount / actualDebited : 0;
}

export function convert(amount: number, base: CurrencyCode, quote: CurrencyCode, rates: FxRate[]) {
  const rate = getRate(rates, base, quote);
  return rate === null ? null : amount * rate;
}

function snapshotValue(snapshot: FxSnapshot | undefined, amount: number, currency: CurrencyCode, quote: CurrencyCode) {
  if (!snapshot) return null;
  if (snapshot.originalCurrency === quote && currency === quote) return amount;
  if (snapshot.originalCurrency === currency && snapshot.convertedCurrency === quote && snapshot.originalAmount !== 0) {
    return snapshot.convertedAmount * (amount / snapshot.originalAmount);
  }
  return null;
}

function transactionValue(data: WealthData, item: WealthData["transactions"][number], quote: CurrencyCode) {
  return snapshotValue(item.fxSnapshot, item.amount, item.currency, quote) ?? convert(item.amount, item.currency, quote, data.fxRates) ?? 0;
}

function transferValue(data: WealthData, amount: number, currency: CurrencyCode, quote: CurrencyCode, snapshot: FxSnapshot | undefined) {
  return snapshotValue(snapshot, amount, currency, quote) ?? convert(amount, currency, quote, data.fxRates) ?? 0;
}

export function getAccountBalance(data: WealthData, accountId: string) {
  const account = data.accounts.find((item) => item.id === accountId);
  if (!account) return 0;
  const income = data.transactions
    .filter((item) => !item.deleted && item.accountId === accountId && item.type === "income")
    .reduce((sum, item) => sum + transactionValue(data, item, account.currency), 0);
  const expenses = data.transactions
    .filter((item) => !item.deleted && item.accountId === accountId && item.type === "expense")
    .reduce((sum, item) => sum + transactionValue(data, item, account.currency), 0);
  const sent = data.transfers
    .filter((item) => !item.deleted && item.fromAccountId === accountId)
    .reduce((sum, item) => sum + transferValue(data, item.fromAmount, item.fromCurrency, account.currency, item.fxSnapshot) + (item.feeCurrency === item.fromCurrency ? item.fee : (convert(item.fee, item.feeCurrency, account.currency, data.fxRates) ?? 0)), 0);
  const received = data.transfers
    .filter((item) => !item.deleted && item.toAccountId === accountId)
    .reduce((sum, item) => sum + transferValue(data, item.toAmount, item.toCurrency, account.currency, item.fxSnapshot), 0);
  return account.balance + income - expenses - sent + received;
}

export function getAccountActivityCount(data: WealthData, accountId: string) {
  return data.transactions.filter((item) => !item.deleted && item.accountId === accountId).length
    + data.transfers.filter((item) => !item.deleted && (item.fromAccountId === accountId || item.toAccountId === accountId)).length;
}

export function getMonthTransactions(data: WealthData, month: string) {
  return data.transactions.filter((item) => !item.deleted && item.date.startsWith(month));
}

export function getBudgetSpent(data: WealthData, budget: MonthlyBudget) {
  const period = budget.period ?? budget.month;
  return getMonthTransactions(data, period)
    .filter((item) => {
      if (item.type !== "expense" || item.currency !== budget.currency) return false;
      if (budget.categoryId) return item.categoryId ? item.categoryId === budget.categoryId : item.category.trim().toLowerCase() === budget.category.trim().toLowerCase();
      return item.category.trim().toLowerCase() === budget.category.trim().toLowerCase();
    })
    .reduce((sum, item) => sum + transactionValue(data, item, budget.currency), 0);
}

export function getBudgetRemaining(data: WealthData, budget: MonthlyBudget) {
  return Math.max(0, (budget.budgetAmount ?? budget.limit) - getBudgetSpent(data, budget));
}

export function getLiquidBalanceInCurrency(data: WealthData, quote: CurrencyCode) {
  return data.accounts
    .filter((account) => (account.type === "bank" || account.type === "cash") && account.status !== "inactive" && account.status !== "deleted")
    .reduce((total, account) => total + (convert(getAccountBalance(data, account.id), account.currency, quote, data.fxRates) ?? 0), 0);
}

export function getUpcomingPlannedPayments(data: WealthData, month: string, fromDate: string) {
  // A planned transfer moves value between liquid accounts; it should not
  // reduce the combined amount the user can spend across those accounts.
  return data.plannedPayments.filter((payment) => payment.due.startsWith(month) && payment.due >= fromDate && payment.category !== "资金转换");
}

export function calculateFreeToSpend(data: WealthData, month: string, fromDate: string) {
  const liquidBalance = getLiquidBalanceInCurrency(data, data.reportCurrency);
  const budgetRemaining = (data.budgets ?? [])
    .filter((budget) => (budget.period ?? budget.month) === month && budget.active !== false && budget.status !== "inactive" && budget.status !== "deleted" && !budget.deleted)
    .reduce((sum, budget) => sum + (convert(getBudgetRemaining(data, budget), budget.currency, data.reportCurrency, data.fxRates) ?? 0), 0);
  const plannedCommitments = getUpcomingPlannedPayments(data, month, fromDate)
    .reduce((sum, payment) => sum + (convert(payment.amount, payment.currency, data.reportCurrency, data.fxRates) ?? 0), 0);
  return Math.max(0, liquidBalance - budgetRemaining - plannedCommitments);
}

export type CashFlowOccurrence = {
  id: string;
  date: string;
  name: string;
  amount: number;
  currency: CurrencyCode;
  kind: "income" | "expense" | "transfer" | "saving" | "investment";
  fixed: boolean;
  annualReserve: boolean;
};

export type CashFlowForecast = {
  horizon: number;
  fromDate: string;
  toDate: string;
  currency: CurrencyCode;
  startBalance: number;
  projectedIncome: number;
  fixedExpenses: number;
  projectedExpenses: number;
  plannedSavings: number;
  plannedInvestments: number;
  plannedTransfers: number;
  endBalance: number;
  safetyBalance: number;
  freeToSpend: number;
  occurrences: Array<CashFlowOccurrence & { convertedAmount: number }>;
};

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function addMonths(date: string, months: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}

function paymentKind(payment: PlannedPayment): CashFlowOccurrence["kind"] {
  if (payment.direction) return payment.direction;
  const label = `${payment.category} ${payment.name}`.toLowerCase();
  if (label.includes("薪") || label.includes("收入") || label.includes("salary")) return "income";
  if (label.includes("投资") || label.includes("invest")) return "investment";
  if (label.includes("储蓄") || label.includes("目标") || label.includes("saving")) return "saving";
  if (label.includes("转") || label.includes("换汇") || label.includes("transfer")) return "transfer";
  return "expense";
}

function paymentOccurrences(payment: PlannedPayment, fromDate: string, toDate: string) {
  const rows: CashFlowOccurrence[] = [];
  let cursor = payment.due;
  let guard = 0;
  while (cursor <= toDate && guard < 240) {
    if (cursor >= fromDate) rows.push({ id: `${payment.id}-${cursor}`, date: cursor, name: payment.name, amount: payment.amount, currency: payment.currency, kind: paymentKind(payment), fixed: payment.isFixed ?? paymentKind(payment) === "expense", annualReserve: payment.isAnnualReserve ?? false });
    if (payment.cadence === "once") break;
    cursor = payment.cadence === "yearly" ? addMonths(cursor, 12) : addMonths(cursor, 1);
    guard += 1;
  }
  return rows;
}

export function getCashFlowOccurrences(data: WealthData, fromDate = getLocalDate(), horizon = 90) {
  const toDate = addDays(fromDate, horizon);
  return data.plannedPayments.flatMap((payment) => paymentOccurrences(payment, fromDate, toDate)).concat(
    (data.subscriptions ?? []).filter((subscription) => subscription.active).flatMap((subscription) => paymentOccurrences({ id: subscription.id, name: subscription.name, amount: subscription.amount, currency: subscription.currency, due: subscription.nextDate, cadence: subscription.cadence, category: subscription.category, accountId: subscription.accountId, direction: "expense", isFixed: true }, fromDate, toDate)),
  ).sort((a, b) => a.date.localeCompare(b.date));
}

export function getCashFlowForecast(data: WealthData, horizon = 30, fromDate = getLocalDate()): CashFlowForecast {
  const currency = data.reportCurrency;
  const occurrences = getCashFlowOccurrences(data, fromDate, horizon).map((item) => ({ ...item, convertedAmount: convert(item.amount, item.currency, currency, data.fxRates) ?? 0 }));
  const projectedIncome = occurrences.filter((item) => item.kind === "income").reduce((sum, item) => sum + item.convertedAmount, 0);
  const projectedExpenses = occurrences.filter((item) => item.kind === "expense").reduce((sum, item) => sum + item.convertedAmount, 0);
  const fixedExpenses = occurrences.filter((item) => item.kind === "expense" && item.fixed).reduce((sum, item) => sum + item.convertedAmount, 0);
  const plannedSavings = occurrences.filter((item) => item.kind === "saving").reduce((sum, item) => sum + item.convertedAmount, 0);
  const plannedInvestments = occurrences.filter((item) => item.kind === "investment").reduce((sum, item) => sum + item.convertedAmount, 0);
  const plannedTransfers = occurrences.filter((item) => item.kind === "transfer").reduce((sum, item) => sum + item.convertedAmount, 0);
  const startBalance = getLiquidBalanceInCurrency(data, currency);
  const endBalance = startBalance + projectedIncome - projectedExpenses - plannedSavings - plannedInvestments;
  const safetyBalance = convert(data.cashFlowSettings?.safetyBalance ?? 0, data.cashFlowSettings?.currency ?? currency, currency, data.fxRates) ?? 0;
  return { horizon, fromDate, toDate: addDays(fromDate, horizon), currency, startBalance, projectedIncome, fixedExpenses, projectedExpenses, plannedSavings, plannedInvestments, plannedTransfers, endBalance, safetyBalance, freeToSpend: Math.max(0, endBalance - safetyBalance), occurrences };
}

export function getCashFlowForecastSet(data: WealthData, fromDate = getLocalDate()) {
  const monthEnd = new Date(`${fromDate.slice(0, 7)}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  monthEnd.setUTCDate(0);
  const monthEndDate = monthEnd.toISOString().slice(0, 10);
  const monthDays = Math.max(0, Math.floor((new Date(`${monthEndDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / 86400000));
  return { 7: getCashFlowForecast(data, 7, fromDate), 30: getCashFlowForecast(data, 30, fromDate), 60: getCashFlowForecast(data, 60, fromDate), 90: getCashFlowForecast(data, 90, fromDate), monthEnd: getCashFlowForecast(data, monthDays, fromDate) };
}

export type WatchlistMetrics = Watchlist & { monthSpent: number; warning: boolean; overBudget: boolean; average12Months: number; spendRate: number; forecastAtMonthEnd: number };

function watchlistMatches(item: WealthData["transactions"][number], watchlist: Watchlist) {
  if (watchlist.category && item.category.toLowerCase() !== watchlist.category.toLowerCase()) return false;
  if (watchlist.merchant && !(item.merchant ?? "").toLowerCase().includes(watchlist.merchant.toLowerCase())) return false;
  if (watchlist.accountId && item.accountId !== watchlist.accountId) return false;
  if (watchlist.currency && item.currency !== watchlist.currency) return false;
  return true;
}

export function getWatchlistMetrics(data: WealthData, watchlist: Watchlist, month = getLocalDate().slice(0, 7), today = getLocalDate()): WatchlistMetrics {
  const current = data.transactions.filter((item) => !item.deleted && item.type === "expense" && item.date.startsWith(month) && watchlistMatches(item, watchlist)).reduce((sum, item) => sum + (convert(item.amount, item.currency, watchlist.currency, data.fxRates) ?? 0), 0);
  const monthStart = new Date(`${month}-01T00:00:00Z`);
  const history = Array.from({ length: 12 }, (_, index) => { const date = new Date(monthStart); date.setUTCMonth(date.getUTCMonth() - index); return date.toISOString().slice(0, 7); });
  const historyTotal = data.transactions.filter((item) => !item.deleted && item.type === "expense" && history.includes(item.date.slice(0, 7)) && watchlistMatches(item, watchlist)).reduce((sum, item) => sum + (convert(item.amount, item.currency, watchlist.currency, data.fxRates) ?? 0), 0);
  const elapsed = Math.max(1, Number(today.slice(8, 10)));
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const spendRate = current / elapsed;
  const forecastAtMonthEnd = spendRate * daysInMonth;
  const warningAmount = watchlist.warningAmount ?? watchlist.limit * 0.8;
  return { ...watchlist, monthSpent: current, warning: current >= warningAmount || forecastAtMonthEnd >= warningAmount, overBudget: current > watchlist.limit || forecastAtMonthEnd > watchlist.limit, average12Months: historyTotal / 12, spendRate, forecastAtMonthEnd };
}

export function getFinanceAlerts(data: WealthData, fromDate = getLocalDate()) {
  const forecast = getCashFlowForecast(data, 30, fromDate);
  const alerts: Array<{ id: string; level: "attention" | "risk" | "info"; title: string; detail: string }> = [];
  if (forecast.endBalance < forecast.safetyBalance) alerts.push({ id: "cashflow-safety", level: "risk", title: "预计现金流低于安全余额", detail: `未来 30 天预计余额 ${formatMoney(forecast.endBalance, forecast.currency)}，安全余额为 ${formatMoney(forecast.safetyBalance, forecast.currency)}。` });
  data.plannedPayments.filter((item) => item.due >= fromDate && item.due <= addDays(fromDate, 7)).forEach((item) => alerts.push({ id: `payment-${item.id}`, level: "attention", title: "固定付款即将发生", detail: `${item.name} 将于 ${item.due} 支出 ${formatMoney(item.amount, item.currency)}。` }));
  data.watchlists.map((item) => getWatchlistMetrics(data, item, fromDate.slice(0, 7), fromDate)).filter((item) => item.warning).forEach((item) => alerts.push({ id: `watch-${item.id}`, level: item.overBudget ? "risk" : "attention", title: `Watchlist ${item.name} 接近警戒`, detail: `本月 ${formatMoney(item.monthSpent, item.currency)}，预计月底 ${formatMoney(item.forecastAtMonthEnd, item.currency)}。` }));
  const stale = data.fxRates.some((rate) => (getRateAgeDays(rate, fromDate) ?? 0) > 30);
  if (stale) alerts.push({ id: "fx-stale", level: "attention", title: "汇率超过 30 天未更新", detail: "请在汇率中心录入新的手动汇率，历史交易快照不会改变。" });
  return alerts;
}

export function totalInCurrency(data: WealthData, quote: CurrencyCode) {
  return data.accounts.reduce((total, account) => {
    const balance = getAccountBalance(data, account.id);
    const converted = convert(balance, account.currency, quote, data.fxRates);
    return total + (converted ?? 0);
  }, 0);
}

export function totalExpensesInCurrency(data: WealthData, quote: CurrencyCode) {
  return data.transactions
    .filter((item) => !item.deleted && item.type === "expense")
    .reduce((total, item) => total + transactionValue(data, item, quote), 0);
}

export function totalIncomeInCurrency(data: WealthData, quote: CurrencyCode) {
  return data.transactions
    .filter((item) => !item.deleted && item.type === "income")
    .reduce((total, item) => total + transactionValue(data, item, quote), 0);
}

export function getDailyCost(purchase: number, current: number, usageDays: number) {
  return usageDays > 0 ? Math.max(0, purchase - current) / usageDays : 0;
}

export function getAssetPurchaseCurrency(asset: { purchaseCurrency?: CurrencyCode; currency: CurrencyCode }) {
  return asset.purchaseCurrency ?? asset.currency;
}

export function getAssetCurrentCurrency(asset: { currentCurrency?: CurrencyCode; currency: CurrencyCode }) {
  return asset.currentCurrency ?? asset.currency;
}

export function getAssetRealizedValue(asset: { currentValue: number; sellPrice?: number; status: "active" | "unused" | "sold" }) {
  return asset.status === "sold" ? asset.sellPrice ?? asset.currentValue : asset.currentValue;
}

export function getAssetUsageStartDate(asset: { purchaseDate?: string; usageStartMode?: "purchaseDate" | "customDate"; usageStartDate?: string }) {
  return asset.usageStartMode === "customDate" ? asset.usageStartDate : asset.purchaseDate;
}

export function getAssetEndDate(asset: { status: "active" | "unused" | "sold"; saleDate?: string }, today = getLocalDate()) {
  return asset.status === "sold" ? asset.saleDate ?? today : today;
}

export function getAssetUsageDays(asset: { purchaseDate?: string; usageStartMode?: "purchaseDate" | "customDate"; usageStartDate?: string; status: "active" | "unused" | "sold"; saleDate?: string; usageDays?: number }, today = getLocalDate()) {
  const startDate = getAssetUsageStartDate(asset);
  if (!startDate) return Math.max(0, asset.usageDays ?? 0);
  const endDate = getAssetEndDate(asset, today);
  if (startDate > endDate) return 0;
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((end - start) / 86400000) + 1);
}

export function getAssetDailyCost(asset: { purchaseValue: number; currentValue: number; sellPrice?: number; usageDays?: number; purchaseDate?: string; usageStartMode?: "purchaseDate" | "customDate"; usageStartDate?: string; saleDate?: string; status: "active" | "unused" | "sold" }, today = getLocalDate()) {
  return getDailyCost(asset.purchaseValue, getAssetRealizedValue(asset), getAssetUsageDays(asset, today));
}

export function getAssetCostPerUse(asset: { purchaseValue: number; currentValue: number; sellPrice?: number; usageDays?: number; useCount?: number; purchaseDate?: string; usageStartMode?: "purchaseDate" | "customDate"; usageStartDate?: string; saleDate?: string; status: "active" | "unused" | "sold" }, today = getLocalDate()) {
  const useCount = asset.useCount ?? 0;
  const usageDays = getAssetUsageDays(asset, today);
  return useCount > 0 && usageDays > 0 ? Math.max(0, asset.purchaseValue - getAssetRealizedValue(asset)) / useCount : null;
}

export function getAssetValueChange(asset: { purchaseValue: number; currentValue: number; sellPrice?: number; status: "active" | "unused" | "sold" }) {
  return getAssetRealizedValue(asset) - asset.purchaseValue;
}

export function getGoalGap(goal: Goal) {
  return Math.max(0, goal.target - goal.current);
}

export function getGoalProgress(goal: Goal) {
  return goal.target > 0 ? Math.min(100, Math.max(0, (goal.current / goal.target) * 100)) : 0;
}

export function getGoalMonthsRemaining(goal: Goal, fromDate = getLocalDate()) {
  const start = goal.startDate && goal.startDate > fromDate ? goal.startDate : fromDate;
  const from = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  const dueDate = goal.endDate ?? goal.due;
  const due = new Date(`${dueDate.slice(0, 7)}-01T00:00:00Z`);
  const months = (due.getUTCFullYear() - from.getUTCFullYear()) * 12 + due.getUTCMonth() - from.getUTCMonth() + 1;
  return Math.max(1, months);
}

export function getGoalPeriodLabel(cadence: Goal["cadence"]) {
  return cadence === "weekly" ? "每周" : cadence === "monthly" ? "每月" : cadence === "quarterly" ? "每季度" : cadence === "yearly" ? "每年" : cadence === "once" ? "一次性" : "自定义周期";
}

export function getGoalRequiredPerMonth(goal: Goal, fromDate?: string) {
  return getGoalGap(goal) / getGoalMonthsRemaining(goal, fromDate);
}

export function getGoalRequiredPerPeriod(goal: Goal, fromDate?: string) {
  if (goal.periodAmount !== undefined) return Math.max(0, goal.periodAmount);
  if (goal.cadence === "once") return getGoalGap(goal);
  if (goal.cadence === "weekly") return getGoalRequiredPerMonth(goal, fromDate) / 4.345;
  const monthsPerPeriod = goal.cadence === "quarterly" ? 3 : goal.cadence === "yearly" ? 12 : 1;
  return getGoalRequiredPerMonth(goal, fromDate) * monthsPerPeriod;
}

export function getAnnualPlanTotal(data: WealthData, year: number, quote: CurrencyCode) {
  return (data.annualPlans ?? [])
    .filter((plan) => plan.year === year && plan.active !== false && !plan.deleted)
    .reduce((total, plan) => total + (convert(plan.amount, plan.currency, quote, data.fxRates) ?? 0), 0);
}

export type CurrencyExposure = {
  currency: CurrencyCode;
  value: number;
  percent: number;
  cash: number;
  investment: number;
  liability: number;
  goals: number;
  future: number;
};

function futureDateRange(fromDate: string, days: number) {
  const end = new Date(`${fromDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + days);
  return end.toISOString().slice(0, 10);
}

export function getCurrencyExposures(data: WealthData, quote: CurrencyCode, fromDate = getLocalDate()): CurrencyExposure[] {
  const endDate = futureDateRange(fromDate, 30);
  const rows = (['MYR', 'SGD', 'USD'] as CurrencyCode[]).map((currency) => {
    const accountRows = data.accounts.filter((account) => account.currency === currency);
    const cash = accountRows.filter((account) => account.type === 'bank' || account.type === 'cash').reduce((sum, account) => sum + Math.max(0, getAccountBalance(data, account.id)), 0);
    const investment = accountRows.filter((account) => account.type === 'investment').reduce((sum, account) => sum + Math.max(0, getAccountBalance(data, account.id)), 0);
    const liability = accountRows.filter((account) => account.type === 'credit-card').reduce((sum, account) => sum + Math.max(0, getAccountBalance(data, account.id)), 0);
    const goals = data.goals.filter((goal) => goal.currency === currency).reduce((sum, goal) => sum + Math.max(0, goal.current), 0);
    const future = data.plannedPayments.filter((payment) => payment.currency === currency && payment.due >= fromDate && payment.due <= endDate).reduce((sum, payment) => sum + payment.amount, 0);
    const value = (convert(cash + investment + goals + future, currency, quote, data.fxRates) ?? 0) - (convert(liability, currency, quote, data.fxRates) ?? 0);
    return { currency, value, percent: 0, cash, investment, liability, goals, future };
  });
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
  return rows.map((row) => ({ ...row, percent: total > 0 ? (Math.max(0, row.value) / total) * 100 : 0 }));
}

export function getFutureMyrNeed(data: WealthData, fromDate = getLocalDate(), days = 30) {
  const endDate = futureDateRange(fromDate, days);
  const planned = data.plannedPayments.filter((payment) => payment.due >= fromDate && payment.due <= endDate).reduce((sum, payment) => sum + (convert(payment.amount, payment.currency, 'MYR', data.fxRates) ?? 0), 0);
  const budgetNeed = (data.budgets ?? []).filter((budget) => budget.month === fromDate.slice(0, 7)).reduce((sum, budget) => sum + (convert(getBudgetRemaining(data, budget), budget.currency, 'MYR', data.fxRates) ?? 0), 0);
  const myrBalance = data.accounts.filter((account) => (account.type === 'bank' || account.type === 'cash') && account.currency === 'MYR').reduce((sum, account) => sum + getAccountBalance(data, account.id), 0);
  const gap = Math.max(0, planned + budgetNeed - myrBalance);
  const sgdMyr = getRate(data.fxRates, 'SGD', 'MYR');
  return { planned, budgetNeed, demand: planned + budgetNeed, myrBalance, gap, sgdMyr, sgdNeeded: sgdMyr && sgdMyr > 0 ? gap / sgdMyr : null };
}

export function getInvestmentConversion(data: WealthData, accountId = 'usd-invest') {
  const account = data.accounts.find((item) => item.id === accountId) ?? data.accounts.find((item) => item.type === 'investment' && item.currency === 'USD');
  if (!account) return null;
  const usdValue = getAccountBalance(data, account.id);
  const usdSgd = getRateRecord(data.fxRates, 'USD', 'SGD');
  const sgdMyr = getRateRecord(data.fxRates, 'SGD', 'MYR');
  const sgdValue = usdSgd ? usdValue * usdSgd.rate : null;
  const myrValue = sgdValue !== null && sgdMyr ? sgdValue * sgdMyr.rate : null;
  return { account, usdValue, usdSgd, sgdMyr, sgdValue, myrValue };
}

export function simulateFx({ currentRate, simulatedRate, monthlySgd, usdAmount, months }: { currentRate: number; simulatedRate: number; monthlySgd: number; usdAmount: number; months: number }) {
  const monthlyMyrDelta = monthlySgd * (simulatedRate - currentRate);
  const investmentSgdDelta = usdAmount * (simulatedRate - currentRate);
  return { monthlyMyrDelta, periodMyrDelta: monthlyMyrDelta * months, investmentSgdDelta };
}
