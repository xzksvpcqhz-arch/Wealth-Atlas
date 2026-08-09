import type { CurrencyCode, FxRate, MonthlyBudget, WealthData } from "./types";

export const formatMoney = (amount: number, currency: CurrencyCode = "MYR") =>
  new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);

export function getRate(rates: FxRate[], base: CurrencyCode, quote: CurrencyCode): number | null {
  if (base === quote) return 1;
  const direct = rates.find((rate) => rate.baseCurrency === base && rate.quoteCurrency === quote);
  if (direct) return direct.rate;
  const reverse = rates.find((rate) => rate.baseCurrency === quote && rate.quoteCurrency === base);
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

export function convert(amount: number, base: CurrencyCode, quote: CurrencyCode, rates: FxRate[]) {
  const rate = getRate(rates, base, quote);
  return rate === null ? null : amount * rate;
}

export function getAccountBalance(data: WealthData, accountId: string) {
  const account = data.accounts.find((item) => item.id === accountId);
  if (!account) return 0;
  const income = data.transactions
    .filter((item) => item.accountId === accountId && item.type === "income")
    .reduce((sum, item) => sum + (convert(item.amount, item.currency, account.currency, data.fxRates) ?? 0), 0);
  const expenses = data.transactions
    .filter((item) => item.accountId === accountId && item.type === "expense")
    .reduce((sum, item) => sum + (convert(item.amount, item.currency, account.currency, data.fxRates) ?? 0), 0);
  const sent = data.transfers
    .filter((item) => item.fromAccountId === accountId)
    .reduce((sum, item) => sum + (convert(item.fromAmount, item.fromCurrency, account.currency, data.fxRates) ?? 0) + (convert(item.fee, item.feeCurrency, account.currency, data.fxRates) ?? 0), 0);
  const received = data.transfers
    .filter((item) => item.toAccountId === accountId)
    .reduce((sum, item) => sum + (convert(item.toAmount, item.toCurrency, account.currency, data.fxRates) ?? 0), 0);
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
    .reduce((sum, item) => sum + (convert(item.amount, item.currency, budget.currency, data.fxRates) ?? 0), 0);
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
    .reduce((total, item) => total + (convert(item.amount, item.currency, quote, data.fxRates) ?? 0), 0);
}

export function totalIncomeInCurrency(data: WealthData, quote: CurrencyCode) {
  return data.transactions
    .filter((item) => item.type === "income")
    .reduce((total, item) => total + (convert(item.amount, item.currency, quote, data.fxRates) ?? 0), 0);
}

export function getDailyCost(purchase: number, current: number, usageDays: number) {
  return usageDays > 0 ? Math.max(0, purchase - current) / usageDays : 0;
}
