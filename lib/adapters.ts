import type { Account, FxRate, Transaction } from "./types";

export interface BankSyncAdapter {
  connect(): Promise<void>;
  importAccounts(): Promise<Account[]>;
  importTransactions(): Promise<Transaction[]>;
  disconnect(): Promise<void>;
}

export interface FxRateAdapter {
  connect(): Promise<void>;
  getRates(): Promise<FxRate[]>;
  disconnect(): Promise<void>;
}

export type ExternalIntegrationSettings = {
  bankSyncEnabled: boolean;
  liveFxEnabled: boolean;
  providerName?: string;
};

export const defaultExternalIntegrationSettings: ExternalIntegrationSettings = {
  bankSyncEnabled: false,
  liveFxEnabled: false,
};

export function detectDuplicateTransactions(existing: Transaction[], incoming: Transaction[]) {
  return incoming.filter((item) => existing.some((saved) => !saved.deleted && saved.date === item.date && saved.amount === item.amount && saved.category === item.category && saved.accountId === item.accountId));
}
