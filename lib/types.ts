export type CurrencyCode = "MYR" | "SGD" | "USD";

export type FxRate = {
  id: string;
  baseCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  rate: number;
  effectiveDate: string;
  enteredAt?: string;
  source?: string;
  note?: string;
  isDefault?: boolean;
  active?: boolean;
  useCount?: number;
};

export type FxSnapshot = {
  originalAmount: number;
  originalCurrency: CurrencyCode;
  convertedAmount: number;
  convertedCurrency: CurrencyCode;
  rateDirection: string;
  rate: number;
  rateDate: string;
  rateSource: string;
  rateId?: string;
  fee: number;
  feeCurrency: CurrencyCode;
  effectiveRate: number;
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
  fxSnapshot?: FxSnapshot;
  deleted?: boolean;
  deletedAt?: string;
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
  inputRate?: number;
  actualRate?: number;
  effectiveRate?: number;
  rateDate?: string;
  rateSource?: string;
  fxSnapshot?: FxSnapshot;
  deleted?: boolean;
  deletedAt?: string;
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
  purchaseCurrency?: CurrencyCode;
  purchaseDate?: string;
  currentValue: number;
  currentCurrency?: CurrencyCode;
  sellPrice?: number;
  saleDate?: string;
  currency: CurrencyCode;
  dailyCost: number;
  usageDays: number;
  usageStartMode?: "purchaseDate" | "customDate";
  usageStartDate?: string;
  legacyUsageDays?: number;
  useCount?: number;
  costPerUse?: number;
  status: "active" | "unused" | "sold";
  note?: string;
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

export type ObsidianTemplateKey = "daily" | "monthly" | "yearly" | "goal" | "asset" | "review";

export type ObsidianSettings = {
  vaultName: string;
  status: "connected" | "permission-error" | "disconnected";
  connectedAt?: string;
  lastScanAt?: string;
  lastSyncAt?: string;
  lastError?: string;
};

export type SyncLog = {
  id: string;
  syncedAt: string;
  vaultName: string;
  fileCount: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  errorReason?: string;
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
  obsidian?: ObsidianSettings;
  syncLogs?: SyncLog[];
  obsidianTemplates?: Partial<Record<ObsidianTemplateKey, string>>;
  assetMigrationBackups?: Array<{ assetId: string; backedUpAt: string; usageDays: number; purchaseDate?: string }>;
  watchlists: Watchlist[];
  reportCurrency: CurrencyCode;
};
