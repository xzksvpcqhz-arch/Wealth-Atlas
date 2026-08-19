import type { Account, CurrencyCode, TransactionCategory, WealthData } from "./types";

export const CURRENT_SCHEMA_VERSION = 10;

const defaultCategories: TransactionCategory[] = [
  ...["新加坡工资", "奖金", "自由职业收入", "股息", "利息", "其他收入"].map((name) => ({ id: `income:${name}`, name, kind: "income" as const, color: "#7fc9a3", active: true })),
  ...["房租", "食物", "外食", "交通", "保险", "娱乐", "购物", "旅行", "家庭支援", "投资", "贷款", "税务", "其他支出"].map((name) => ({ id: `expense:${name}`, name, kind: "expense" as const, color: "#d7aa6f", active: true })),
];

function categoryId(kind: TransactionCategory["kind"], name: string) {
  return `${kind}:${name.trim()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const supportedCurrencies = new Set<CurrencyCode>(["MYR", "SGD", "USD"]);
const collectionKeys = [
  "accounts",
  "transactions",
  "transfers",
  "fxRates",
  "goals",
  "assets",
  "plannedPayments",
  "budgets",
  "categories",
  "annualPlans",
  "syncLogs",
  "watchlists",
  "investments",
  "investmentTransactions",
  "liabilities",
  "netWorthHistory",
  "subscriptions",
  "reviews",
  "importReviews",
  "assetMigrationBackups",
  "migrationHistory",
  "migrationBackups",
  "migrationNotices",
] as const;

function prepareInput(input: unknown) {
  const raw = isRecord(input) ? input : {};
  const repairedFields: string[] = [];
  const prepared: Record<string, unknown> = { ...raw };

  for (const key of collectionKeys) {
    if (!Array.isArray(raw[key])) {
      prepared[key] = [];
      repairedFields.push(key);
    }
  }

  if (!supportedCurrencies.has(raw.reportCurrency as CurrencyCode)) {
    prepared.reportCurrency = "MYR";
    repairedFields.push("reportCurrency");
  }
  if (!isRecord(raw.obsidian)) {
    prepared.obsidian = { vaultName: "", status: "disconnected" };
    repairedFields.push("obsidian");
  }
  if (!isRecord(raw.cashFlowSettings)) {
    prepared.cashFlowSettings = { safetyBalance: 0, currency: prepared.reportCurrency };
    repairedFields.push("cashFlowSettings");
  }
  if (!isRecord(raw.externalIntegrations)) {
    prepared.externalIntegrations = { bankSyncEnabled: false, liveFxEnabled: false };
    repairedFields.push("externalIntegrations");
  }

  return { prepared: prepared as WealthData, raw, repairedFields };
}

function normalizeCategories(input: WealthData) {
  const categories = [...(input.categories ?? [])];
  const ensure = (name: string, kind: TransactionCategory["kind"]) => {
    const id = categoryId(kind, name);
    if (!categories.some((item) => item.id === id || (item.kind === kind && item.name === name))) {
      categories.push({ id, name, kind, color: kind === "income" ? "#7fc9a3" : "#d7aa6f", active: true });
    }
  };
  defaultCategories.forEach((item) => ensure(item.name, item.kind));
  input.transactions.forEach((item) => ensure(item.category, item.type));
  return categories;
}

function normalizeAccounts(accounts: WealthData["accounts"]): Account[] {
  return accounts.map((account) => ({
    ...account,
    includeInNetWorth: account.includeInNetWorth !== false,
    status: account.status ?? "active",
  }));
}

export function getWealthDataSchemaVersion(value: unknown) {
  if (!isRecord(value)) return 7;
  const version = Number(value.schemaVersion);
  return Number.isInteger(version) && version > 0 ? version : 7;
}

export function needsWealthDataMigration(value: unknown) {
  const { repairedFields } = prepareInput(value);
  return getWealthDataSchemaVersion(value) < CURRENT_SCHEMA_VERSION || repairedFields.length > 0;
}

/** Additive, reversible v1.1 migration. The original snapshot is retained in IndexedDB. */
export function migrateWealthData(value: unknown): WealthData {
  const { prepared: input, raw, repairedFields } = prepareInput(value);
  const from = getWealthDataSchemaVersion(value);
  const categories = normalizeCategories(input);
  const notices = [...(input.migrationNotices ?? [])];
  const categoryByName = new Map(categories.map((item) => [`${item.kind}:${item.name}`, item]));
  const transactions = input.transactions.map((item) => ({
    ...item,
    categoryId: item.categoryId ?? categoryByName.get(`${item.type}:${item.category}`)?.id ?? categoryId(item.type, item.category),
  }));
  const budgets = (input.budgets ?? []).map((budget) => {
    const currency = budget.currency ?? input.reportCurrency;
    if (!budget.currency) notices.push(`预算“${budget.category}”缺少币种，已按报告币种 ${input.reportCurrency} 迁移。`);
    const category = categoryByName.get(`expense:${budget.category}`);
    return {
      ...budget,
      currency,
      categoryId: budget.categoryId ?? category?.id,
      period: budget.period ?? budget.month,
      budgetAmount: budget.budgetAmount ?? budget.limit,
      active: budget.active !== false,
      status: budget.status ?? "active",
    };
  });
  const goals = input.goals.map((goal) => ({
    ...goal,
    startDate: goal.startDate ?? goal.due,
    endDate: goal.endDate ?? goal.due,
    active: goal.active !== false && !goal.deleted,
  }));
  const base: WealthData = {
    ...input,
    accounts: normalizeAccounts(input.accounts),
    categories,
    transactions,
    budgets,
    goals,
    annualPlans: (input.annualPlans ?? []).map((plan) => ({
      ...plan,
      active: plan.active !== false && !plan.deleted,
    })),
    watchlists: input.watchlists ?? [],
    plannedPayments: input.plannedPayments ?? [],
    cashFlowSettings: input.cashFlowSettings ?? { safetyBalance: 0, currency: input.reportCurrency },
    investments: input.investments ?? [],
    investmentTransactions: input.investmentTransactions ?? [],
    liabilities: input.liabilities ?? [],
    netWorthHistory: input.netWorthHistory ?? [],
    subscriptions: input.subscriptions ?? [],
    reviews: input.reviews ?? [],
    importReviews: input.importReviews ?? [],
    externalIntegrations: input.externalIntegrations ?? { bankSyncEnabled: false, liveFxEnabled: false },
    schemaVersion: Math.max(from, CURRENT_SCHEMA_VERSION),
    migrationNotices: notices,
  };
  if (from >= CURRENT_SCHEMA_VERSION && repairedFields.length === 0) return base;
  const snapshot = JSON.parse(JSON.stringify(raw)) as unknown;
  const repairNotice = repairedFields.length
    ? `启动时已安全补足缺少的资料结构：${repairedFields.join(", ")}。原始 snapshot 已保留在本地迁移备份中。`
    : null;
  return {
    ...base,
    migrationBackups: [...(input.migrationBackups ?? []), { id: `${repairedFields.length ? "startup-repair" : "migration"}-${Date.now()}`, from, to: CURRENT_SCHEMA_VERSION, createdAt: new Date().toISOString(), snapshot }],
    migrationHistory: from < CURRENT_SCHEMA_VERSION
      ? [...(input.migrationHistory ?? []), { from, to: CURRENT_SCHEMA_VERSION, appliedAt: new Date().toISOString() }]
      : input.migrationHistory,
    migrationNotices: repairNotice ? [...notices, repairNotice] : notices,
  };
}
