export type CurrencyCode = "MYR" | "SGD" | "USD";

export type FxRate = {
  id: string;
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  rate: number;
  effectiveDate: string;
  note?: string;
};

export type Account = {
  id: string;
  name: string;
  type: "bank" | "cash" | "investment" | "credit-card";
  currency: CurrencyCode;
  balance: number;
};

export type Transaction = {
  id: string;
  type: "income" | "expense";
  accountId: string;
  amount: number;
  currency: CurrencyCode;
  category: string;
  merchant?: string;
  date: string;
  note?: string;
  convertedAmount?: number;
  convertedCurrency?: CurrencyCode;
  fxRate?: number;
};

export type Transfer = {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  fromAmount: number;
  fromCurrency: CurrencyCode;
  toAmount: number;
  toCurrency: CurrencyCode;
  rate: number;
  fee: number;
  feeCurrency: CurrencyCode;
  date: string;
};

export type Goal = {
  id: string;
  name: string;
  current: number;
  target: number;
  currency: CurrencyCode;
  percent: number;
  due: string;
  cadence: "monthly" | "quarterly" | "yearly" | "custom";
  status: "on-track" | "watch" | "paused";
};

export type AnnualPlan = {
  id: string;
  year: number;
  month: number;
  name: string;
  category: string;
  amount: number;
  currency: CurrencyCode;
  status: "planned" | "funded" | "complete";
  goalId?: string;
  note?: string;
};

export type AssetItem = {
  id: string;
  name: string;
  category: string;
  purchaseValue: number;
  currentValue: number;
  currency: CurrencyCode;
  dailyCost: number;
  usageDays: number;
  status: "active" | "unused" | "sold";
};

export type PlannedPayment = {
  id: string;
  name: string;
  amount: number;
  currency: CurrencyCode;
  due: string;
  cadence: "monthly" | "yearly";
  category: string;
};

export type MonthlyBudget = {
  id: string;
  month: string;
  category: string;
  limit: number;
  currency: CurrencyCode;
};

export type Watchlist = {
  id: string;
  name: string;
  spent: number;
  limit: number;
  average: number;
  forecast: number;
  currency: CurrencyCode;
};

export type WealthData = {
  accounts: Account[];
  transactions: Transaction[];
  transfers: Transfer[];
  fxRates: FxRate[];
  goals: Goal[];
  assets: AssetItem[];
  plannedPayments: PlannedPayment[];
  budgets?: MonthlyBudget[];
  annualPlans?: AnnualPlan[];
  watchlists: Watchlist[];
  reportCurrency: CurrencyCode;
};
