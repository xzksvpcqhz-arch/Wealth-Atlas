import type { CurrencyCode, FxRate, FxSnapshot, Goal, MonthlyBudget, WealthData } from "./types";

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
  const transactionUses = data.transactions.filter((item) => item.fxSnapshot?.rateId === rateId).length;
  const transferUses = data.transfers.filter((item) => item.fxSnapshot?.rateId === rateId).length;
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
    .filter((item) => item.accountId === accountId && item.type === "income")
    .reduce((sum, item) => sum + transactionValue(data, item, account.currency), 0);
  const expenses = data.transactions
    .filter((item) => item.accountId === accountId && item.type === "expense")
    .reduce((sum, item) => sum + transactionValue(data, item, account.currency), 0);
  const sent = data.transfers
    .filter((item) => item.fromAccountId === accountId)
    .reduce((sum, item) => sum + transferValue(data, item.fromAmount, item.fromCurrency, account.currency, item.fxSnapshot) + (item.feeCurrency === item.fromCurrency ? item.fee : (convert(item.fee, item.feeCurrency, account.currency, data.fxRates) ?? 0)), 0);
  const received = data.transfers
    .filter((item) => item.toAccountId === accountId)
    .reduce((sum, item) => sum + transferValue(data, item.toAmount, item.toCurrency, account.currency, item.fxSnapshot), 0);
  return account.balance + income - expenses - sent + received;
}

export function getAccountActivityCount(data: WealthData, accountId: string) {
  return data.transactions.filter((item) => item.accountId === accountId).length
    + data.transfers.filter((item) => item.fromAccountId === accountId || item.toAccountId === accountId).length;
}

export function getMonthTransactions(data: WealthData, month: string) {
  return data.transactions.filter((item) => item.date.startsWith(month));
}

export function getBudgetSpent(data: WealthData, budget: MonthlyBudget) {
  return getMonthTransactions(data, budget.month)
    .filter((item) => item.type === "expense" && item.category.trim().toLowerCase() === budget.category.trim().toLowerCase())
    .reduce((sum, item) => sum + transactionValue(data, item, budget.currency), 0);
}

export function getBudgetRemaining(data: WealthData, budget: MonthlyBudget) {
  return Math.max(0, budget.limit - getBudgetSpent(data, budget));
}

export function getLiquidBalanceInCurrency(data: WealthData, quote: CurrencyCode) {
  return data.accounts
    .filter((account) => account.type === "bank" || account.type === "cash")
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
    .filter((budget) => budget.month === month)
    .reduce((sum, budget) => sum + (convert(getBudgetRemaining(data, budget), budget.currency, data.reportCurrency, data.fxRates) ?? 0), 0);
  const plannedCommitments = getUpcomingPlannedPayments(data, month, fromDate)
    .reduce((sum, payment) => sum + (convert(payment.amount, payment.currency, data.reportCurrency, data.fxRates) ?? 0), 0);
  return Math.max(0, liquidBalance - budgetRemaining - plannedCommitments);
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
    .filter((item) => item.type === "expense")
    .reduce((total, item) => total + transactionValue(data, item, quote), 0);
}

export function totalIncomeInCurrency(data: WealthData, quote: CurrencyCode) {
  return data.transactions
    .filter((item) => item.type === "income")
    .reduce((total, item) => total + transactionValue(data, item, quote), 0);
}

export function getDailyCost(purchase: number, current: number, usageDays: number) {
  return usageDays > 0 ? Math.max(0, purchase - current) / usageDays : 0;
}

export function getGoalGap(goal: Goal) {
  return Math.max(0, goal.target - goal.current);
}

export function getGoalProgress(goal: Goal) {
  return goal.target > 0 ? Math.min(100, Math.max(0, (goal.current / goal.target) * 100)) : 0;
}

export function getGoalMonthsRemaining(goal: Goal, fromDate = getLocalDate()) {
  const from = new Date(`${fromDate.slice(0, 7)}-01T00:00:00Z`);
  const due = new Date(`${goal.due.slice(0, 7)}-01T00:00:00Z`);
  const months = (due.getUTCFullYear() - from.getUTCFullYear()) * 12 + due.getUTCMonth() - from.getUTCMonth() + 1;
  return Math.max(1, months);
}

export function getGoalPeriodLabel(cadence: Goal["cadence"]) {
  return cadence === "monthly" ? "每月" : cadence === "quarterly" ? "每季度" : cadence === "yearly" ? "每年" : "自定义周期";
}

export function getGoalRequiredPerMonth(goal: Goal, fromDate?: string) {
  return getGoalGap(goal) / getGoalMonthsRemaining(goal, fromDate);
}

export function getGoalRequiredPerPeriod(goal: Goal, fromDate?: string) {
  const monthsPerPeriod = goal.cadence === "quarterly" ? 3 : goal.cadence === "yearly" ? 12 : 1;
  return getGoalRequiredPerMonth(goal, fromDate) * monthsPerPeriod;
}

export function getAnnualPlanTotal(data: WealthData, year: number, quote: CurrencyCode) {
  return (data.annualPlans ?? [])
    .filter((plan) => plan.year === year)
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
