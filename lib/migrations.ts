import type { WealthData } from "./types";

export const CURRENT_SCHEMA_VERSION = 9;

/**
 * Snapshot migrations are additive only. Missing collections receive empty defaults;
 * existing personal records are copied through unchanged so rollback is possible.
 */
export function migrateWealthData(input: WealthData): WealthData {
  const from = input.schemaVersion ?? 7;
  if (from >= CURRENT_SCHEMA_VERSION) {
    return {
      ...input,
      budgets: input.budgets ?? [],
      annualPlans: input.annualPlans ?? [],
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
    };
  }

  return {
    ...input,
    budgets: input.budgets ?? [],
    annualPlans: input.annualPlans ?? [],
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
    schemaVersion: CURRENT_SCHEMA_VERSION,
    migrationHistory: [...(input.migrationHistory ?? []), { from, to: CURRENT_SCHEMA_VERSION, appliedAt: new Date().toISOString() }],
  };
}
