import type { WealthData } from "./types";
import { CURRENT_SCHEMA_VERSION, migrateWealthData } from "./migrations";

export type DataProfile = {
  key: string;
  kind: "locked" | "local" | "guest" | "cloud";
  ownerId: string | null;
  epoch: number;
  desktopToken?: string;
};

const initialProfile: DataProfile = { key: "locked", kind: "locked", ownerId: null, epoch: 0 };
let profile = initialProfile;
let serial = 0;
const listeners = new Set<() => void>();
const ownership = new WeakMap<object, DataProfile>();

export const getDataProfile = () => profile;
export const getServerDataProfile = () => initialProfile;
export function subscribeDataProfile(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function makeDataProfile(kind: DataProfile["kind"], ownerId: string | null = null): DataProfile {
  if (kind === "cloud" && (!ownerId || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerId))) throw new Error("账号工作区标识无效。");
  return { key: kind === "cloud" ? `cloud:${ownerId}` : kind, kind, ownerId: kind === "cloud" ? ownerId : null, epoch: ++serial };
}
export function publishDataProfile(next: DataProfile) { profile = next; listeners.forEach((listener) => listener()); }
export function isActiveDataProfile(expected: DataProfile) { return profile === expected && expected.kind !== "locked"; }
export function assertActiveDataProfile(expected: DataProfile) {
  if (!isActiveDataProfile(expected)) throw new Error("账号已经切换，已取消旧工作区操作。");
}
export function tagProfileObject<T extends object>(value: T, scope: DataProfile): T { ownership.set(value, scope); return value; }
export function getObjectProfile(value: object) { return ownership.get(value); }
export function inheritProfileOwnership(previous: WealthData, next: WealthData, expected: DataProfile): WealthData {
  assertActiveDataProfile(expected);
  const previousOwner = ownership.get(previous);
  const nextOwner = ownership.get(next);
  if (previousOwner && previousOwner !== expected || nextOwner && nextOwner !== expected) throw new Error("资料不属于当前账号，未执行写入。");
  return tagProfileObject(next, expected);
}
export function snapshotKey(scope: DataProfile) {
  if (scope.kind === "locked") throw new Error("账号工作区尚未就绪。");
  return scope.kind === "local" ? "current" : `profile:v1:${scope.key}`;
}
export function profileMetadataKey(scope: DataProfile, name: string) { return `${snapshotKey(scope)}:${name}`; }

/** A new, unowned workspace is never seeded from another person's legacy snapshot. */
export function createBlankWealthData(): WealthData {
  return migrateWealthData({
    reportCurrency: "MYR", schemaVersion: CURRENT_SCHEMA_VERSION,
    accounts: [], transactions: [], transfers: [], fxRates: [], goals: [], assets: [], plannedPayments: [],
    budgets: [], categories: [], annualPlans: [], syncLogs: [], watchlists: [], investments: [],
    investmentTransactions: [], liabilities: [], netWorthHistory: [], subscriptions: [], reviews: [], importReviews: [],
    migrationHistory: [], migrationBackups: [], migrationNotices: [], assetMigrationBackups: [],
    obsidian: { vaultName: "", status: "disconnected" },
    cashFlowSettings: { safetyBalance: 0, currency: "MYR" },
    externalIntegrations: { bankSyncEnabled: false, liveFxEnabled: false },
  });
}
