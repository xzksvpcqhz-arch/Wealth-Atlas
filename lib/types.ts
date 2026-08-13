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
  parentAccountId?: string;
  accountGroup?: string;
  institution?: string;
  includeInNetWorth?: boolean;
  status?: "active" | "inactive" | "deleted";
  deactivatedAt?: string;
  deletedAt?: string;
};

export type TransactionCategory = {
  id: string;
  name: string;
  kind: "income" | "expense";
  icon?: string;
  color?: string;
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type Transaction = {
  id: string;
  type: "income" | "expense";
  accountId: string;
  amount: number;
  currency: CurrencyCode;
  category: string;
  categoryId?: string;
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
  cadence: "weekly" | "monthly" | "quarterly" | "yearly" | "custom" | "once";
  status: "on-track" | "watch" | "paused";
  startDate?: string;
  endDate?: string;
  periodAmount?: number;
  priority?: "high" | "medium" | "low";
  isAutomatic?: boolean;
  active?: boolean;
  deleted?: boolean;
  deletedAt?: string;
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
  active?: boolean;
  deleted?: boolean;
  deletedAt?: string;
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
  deleted?: boolean;
  deletedAt?: string;
};

export type PlannedPayment = {
  id: string;
  name: string;
  amount: number;
  currency: CurrencyCode;
  due: string;
  cadence: "once" | "monthly" | "yearly";
  category: string;
  accountId?: string;
  direction?: "income" | "expense" | "transfer" | "saving" | "investment";
  targetCurrency?: CurrencyCode;
  isAutomatic?: boolean;
  isFixed?: boolean;
  isAnnualReserve?: boolean;
};

export type MonthlyBudget = {
  id: string;
  month: string;
  category: string;
  limit: number;
  currency: CurrencyCode;
  categoryId?: string;
  period?: string;
  budgetAmount?: number;
  active?: boolean;
  deleted?: boolean;
  deletedAt?: string;
  status?: "active" | "inactive" | "deleted";
};

export type Watchlist = {
  id: string;
  name: string;
  spent: number;
  limit: number;
  warningAmount?: number;
  average: number;
  forecast: number;
  currency: CurrencyCode;
  category?: string;
  merchant?: string;
  tags?: string[];
  accountId?: string;
  itemType?: string;
};

export type Investment = {
  id: string;
  name: string;
  accountId?: string;
  assetType: string;
  quantity?: number;
  currency: CurrencyCode;
  costBasis: number;
  currentValue: number;
  valuationDate: string;
  feeTotal?: number;
  note?: string;
};

export type InvestmentTransaction = {
  id: string;
  investmentId: string;
  type: "buy" | "sell" | "dividend" | "fee";
  date: string;
  amount: number;
  currency: CurrencyCode;
  quantity?: number;
  price?: number;
  fee?: number;
  note?: string;
  deleted?: boolean;
  deletedAt?: string;
};

export type Liability = {
  id: string;
  name: string;
  type: "loan" | "credit-card" | "other";
  principal: number;
  remainingPrincipal: number;
  interestRate: number;
  minimumPayment: number;
  extraPayment?: number;
  currency: CurrencyCode;
  dueDate?: string;
  termMonths?: number;
  note?: string;
  status: "active" | "paid";
};

export type NetWorthSnapshot = {
  id: string;
  date: string;
  currency: CurrencyCode;
  value: number;
  cash: number;
  investments: number;
  assets: number;
  liabilities: number;
  note?: string;
};

export type Subscription = {
  id: string;
  name: string;
  amount: number;
  currency: CurrencyCode;
  cadence: "monthly" | "yearly";
  nextDate: string;
  accountId?: string;
  category: string;
  active: boolean;
};

export type FinancialReview = {
  id: string;
  period: string;
  good?: string;
  overspend?: string;
  largestExpense?: string;
  goals?: string;
  investment?: string;
  fx?: string;
  nextPlan?: string;
  createdAt: string;
  updatedAt: string;
};

export type ImportReview = {
  id: string;
  fileName: string;
  importedAt: string;
  status: "pending" | "applied" | "undone";
  appliedTransactionIds?: string[];
  duplicateCount?: number;
  rows: Array<Pick<Transaction, "type" | "accountId" | "amount" | "currency" | "category" | "merchant" | "date" | "note">>;
};

export type CashFlowSettings = {
  safetyBalance: number;
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
  categories?: TransactionCategory[];
  annualPlans?: AnnualPlan[];
  obsidian?: ObsidianSettings;
  syncLogs?: SyncLog[];
  obsidianTemplates?: Partial<Record<ObsidianTemplateKey, string>>;
  assetMigrationBackups?: Array<{ assetId: string; backedUpAt: string; usageDays: number; purchaseDate?: string }>;
  watchlists: Watchlist[];
  reportCurrency: CurrencyCode;
  schemaVersion?: number;
  migrationHistory?: Array<{ from: number; to: number; appliedAt: string }>;
  migrationBackups?: Array<{ id: string; from: number; to: number; createdAt: string; snapshot: unknown }>;
  migrationNotices?: string[];
  cashFlowSettings?: CashFlowSettings;
  investments?: Investment[];
  investmentTransactions?: InvestmentTransaction[];
  liabilities?: Liability[];
  netWorthHistory?: NetWorthSnapshot[];
  subscriptions?: Subscription[];
  reviews?: FinancialReview[];
  importReviews?: ImportReview[];
  externalIntegrations?: {
    bankSyncEnabled: boolean;
    liveFxEnabled: boolean;
    providerName?: string;
  };
};
