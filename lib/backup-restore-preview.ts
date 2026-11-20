import { normalizeAssets } from "./asset-normalization";
import { CURRENT_SCHEMA_VERSION, migrateWealthData } from "./migrations";
import type { WealthData } from "./types";

type RecordValue = Record<string, unknown>;
export type RestoreDifferenceKind = "added" | "changed" | "same" | "currentOnly";
export type RestoreFieldDifference = { key: string; before: unknown; after: unknown };
export type RestoreDetail = {
  module: string;
  /** Entity ID, or an opaque comparison-local token for an ID-less value. Never an array index. */
  id: string;
  label: string;
  kind: RestoreDifferenceKind;
  /** Relative JSON-pointer paths (without the initial slash); missing values are undefined. */
  fields: RestoreFieldDifference[];
};
export type RestoreCounts = { added: number; changed: number; same: number; currentOnly: number };
export type RestoreModule = RestoreCounts & { key: string; label: string; current: number; backup: number; reordered: boolean };
export type RestorePreview = {
  /** Deeply frozen at runtime. Persist this exact prepared value; do not migrate it again. */
  candidate: WealthData;
  currentFingerprint: string;
  sourceFingerprint: string;
  targetFingerprint: string;
  /** Ignores entity/ID-less collection order, but not ordered arrays inside settings or rows. */
  sameData: boolean;
  reordered: boolean;
  modules: RestoreModule[];
  details: RestoreDetail[];
  totals: RestoreCounts;
  /** These operational fields always come from current, even when absent there. */
  excludedFields: readonly ["obsidian", "syncLogs"];
};

export type RestorePreviewErrorCode = "INVALID_BACKUP" | "UNSUPPORTED_VERSION" | "SCHEMA_MISMATCH";
export class RestorePreviewError extends Error {
  readonly code: RestorePreviewErrorCode;
  constructor(code: RestorePreviewErrorCode = "INVALID_BACKUP") {
    super(code === "UNSUPPORTED_VERSION" ? "此备份版本暂不支持恢复。"
      : code === "SCHEMA_MISMATCH" ? "备份版本资料不一致，无法安全恢复。"
        : "备份资料未通过安全检查，无法预览恢复。");
    this.name = "RestorePreviewError";
    this.code = code;
  }
}

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const currencies = new Set(["MYR", "SGD", "USD"]);
// Kept local deliberately: importing snapshot-backup would load storage/Vault side effects.
const snapshotFormat = "wealth-atlas-snapshot";
const snapshotVersion = 1;
const excludedFields = ["obsidian", "syncLogs"] as const;
const labels: Record<string, string> = {
  accounts: "账户", transactions: "收支记录", transfers: "转账", fxRates: "汇率",
  goals: "目标", assets: "物品资产", plannedPayments: "计划付款", budgets: "预算",
  categories: "分类", annualPlans: "年度计划", syncLogs: "同步历史（保留当前）",
  watchlists: "关注清单", investments: "投资", investmentTransactions: "投资记录",
  liabilities: "负债", netWorthHistory: "净资产历史", subscriptions: "订阅",
  reviews: "财务复盘", importReviews: "导入历史", assetMigrationBackups: "资产迁移历史",
  migrationHistory: "资料迁移历史", migrationBackups: "资料迁移备份", migrationNotices: "迁移提示",
  obsidian: "Obsidian 连接（保留当前）", obsidianTemplates: "Obsidian 模板",
  cashFlowSettings: "现金流设置", externalIntegrations: "外部服务设置",
  reportCurrency: "报告币种", schemaVersion: "资料版本",
};
const entityKeys = [
  "accounts", "transactions", "transfers", "fxRates", "goals", "assets", "plannedPayments",
  "budgets", "categories", "annualPlans", "syncLogs", "watchlists", "investments",
  "investmentTransactions", "liabilities", "netWorthHistory", "subscriptions", "reviews",
  "importReviews", "migrationBackups",
] as const;
const historyKeys = ["assetMigrationBackups", "migrationHistory", "migrationNotices"] as const;
const emptyCounts = (): RestoreCounts => ({ added: 0, changed: 0, same: 0, currentOnly: 0 });
function fail(): never { throw new RestorePreviewError(); }

/** Clone only data, never invoke getters/toJSON, retain unknown own keys (including __proto__). */
function cloneData(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (depth > 200) fail();
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail();
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail();
  if (Object.getOwnPropertySymbols(value).length) fail();
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    const rows: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.value === undefined) fail();
      rows.push(cloneData(descriptor.value, ancestors, depth + 1));
    }
    // JSON would silently discard these; refusing is safer than losing unknown data.
    if (Object.keys(value).length !== value.length) fail();
    result = rows;
  } else {
    const next: RecordValue = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) fail();
      Object.defineProperty(next, key, { value: cloneData(descriptor.value, ancestors, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    result = next;
  }
  ancestors.delete(value);
  return result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/** Exact canonical persisted-JSON content, not a digest. Sensitive: never log/store in telemetry.
 * Object key order/undefined optional properties do not matter; every array order does.
 * For a raw JSON string this fingerprints the string itself, including whitespace.
 */
export function stableRestoreFingerprint(value: unknown): string {
  try { return canonical(cloneData(value)); } catch { throw new RestorePreviewError(); }
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail();
  if (value > CURRENT_SCHEMA_VERSION) throw new RestorePreviewError("UNSUPPORTED_VERSION");
  return value;
}

function extract(raw: unknown, metadata?: { schemaVersion?: number | null }): RecordValue {
  const parsed = cloneData(typeof raw === "string" ? JSON.parse(raw) : raw);
  if (!record(parsed)) fail();
  const versions: number[] = [];
  let body = parsed;
  if (own(parsed, "format") || (!own(parsed, "accounts") && own(parsed, "data"))) {
    if (parsed.format !== snapshotFormat || !Number.isSafeInteger(parsed.version) || (parsed.version as number) < 1) fail();
    if ((parsed.version as number) > snapshotVersion) throw new RestorePreviewError("UNSUPPORTED_VERSION");
    if (!record(parsed.data)) fail();
    body = parsed.data;
    if (own(parsed, "schemaVersion")) versions.push(version(parsed.schemaVersion));
  }
  if (own(body, "schemaVersion")) versions.push(version(body.schemaVersion));
  if (metadata !== undefined) {
    const copied = cloneData(metadata);
    if (!record(copied)) fail();
    if (copied.schemaVersion !== undefined && copied.schemaVersion !== null) versions.push(version(copied.schemaVersion));
  }
  if (new Set(versions).size > 1) throw new RestorePreviewError("SCHEMA_MISMATCH");
  // Missing legacy body version may be supplied by the envelope/index; absent everywhere means v7.
  if (!own(body, "schemaVersion") && versions.length) body.schemaVersion = versions[0];
  return body;
}

function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function numberField(row: RecordValue, key: string, required = false) {
  if (row[key] === undefined && !required) return;
  if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || Math.abs(row[key] as number) > Number.MAX_SAFE_INTEGER) fail();
}
function strings(row: RecordValue, required: readonly string[] = [], optional: readonly string[] = []) {
  for (const key of required) if (typeof row[key] !== "string") fail();
  for (const key of optional) if (row[key] !== undefined && typeof row[key] !== "string") fail();
}
function enumField(row: RecordValue, key: string, values: string[], required = false) {
  if (row[key] === undefined && !required) return;
  if (!values.includes(row[key] as string)) fail();
}
function dateField(row: RecordValue, key: string, required = false) {
  if (row[key] === undefined || row[key] === "") { if (required) fail(); return; }
  if (typeof row[key] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row[key] as string)) fail();
  const date = new Date(`${row[key]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== row[key]) fail();
}

// Explicit lib/types boundaries, not a recursive name-based heuristic: unknown extension
// properties stay opaque. Only omissions actually filled by migration remain optional.
const textFields: Record<string, { required: readonly string[]; optional?: readonly string[] }> = {
  accounts: { required: ["name"], optional: ["accountGroup", "institution", "deactivatedAt", "deletedAt"] },
  transactions: { required: ["category", "date"], optional: ["merchant", "note", "deletedAt"] },
  transfers: { required: ["date"], optional: ["rateDate", "rateSource", "deletedAt"] },
  fxRates: { required: ["effectiveDate"], optional: ["enteredAt", "source", "note"] },
  categories: { required: ["name"], optional: ["icon", "color", "createdAt", "updatedAt"] },
  goals: { required: ["name", "due"], optional: ["startDate", "endDate", "deletedAt"] },
  assets: { required: ["name", "category"], optional: ["purchaseDate", "saleDate", "usageStartDate", "note", "deletedAt"] },
  plannedPayments: { required: ["name", "due", "category"] },
  budgets: { required: ["category", "month"], optional: ["period", "deletedAt"] },
  annualPlans: { required: ["name", "category"], optional: ["note", "deletedAt"] },
  watchlists: { required: ["name"], optional: ["category", "merchant", "itemType"] },
  investments: { required: ["name", "assetType", "valuationDate"], optional: ["note"] },
  investmentTransactions: { required: ["date"], optional: ["note", "deletedAt"] },
  liabilities: { required: ["name"], optional: ["dueDate", "note"] },
  netWorthHistory: { required: ["date"], optional: ["note"] },
  subscriptions: { required: ["name", "nextDate", "category"] },
  reviews: { required: ["period", "createdAt", "updatedAt"], optional: ["good", "overspend", "largestExpense", "goals", "investment", "fx", "nextPlan"] },
  importReviews: { required: ["fileName", "importedAt"] },
  syncLogs: { required: ["syncedAt", "vaultName"], optional: ["errorReason"] },
  migrationBackups: { required: ["createdAt"] },
};

const requiredNumbers: Record<string, string[]> = {
  accounts: ["balance"], transactions: ["amount"], transfers: ["fromAmount", "toAmount", "rate", "fee"],
  fxRates: ["rate"], goals: ["current", "target"], assets: ["purchaseValue", "currentValue"],
  plannedPayments: ["amount"], budgets: ["limit"], annualPlans: ["year", "month", "amount"],
  watchlists: ["spent", "limit", "average", "forecast"], investments: ["costBasis", "currentValue"],
  investmentTransactions: ["amount"], liabilities: ["principal", "remainingPrincipal", "interestRate", "minimumPayment"],
  netWorthHistory: ["value", "cash", "investments", "assets", "liabilities"], subscriptions: ["amount"],
};
const optionalNumbers: Record<string, string[]> = {
  transactions: ["convertedAmount", "fxRate"], transfers: ["inputRate", "actualRate", "effectiveRate"],
  fxRates: ["useCount"], goals: ["percent", "periodAmount"],
  assets: ["sellPrice", "dailyCost", "usageDays", "legacyUsageDays", "useCount", "costPerUse"],
  budgets: ["budgetAmount"], watchlists: ["warningAmount"], investments: ["quantity", "feeTotal"],
  investmentTransactions: ["quantity", "price", "fee"], liabilities: ["extraPayment", "termMonths"],
  importReviews: ["duplicateCount"], syncLogs: ["fileCount", "added", "updated", "unchanged", "skipped", "failed"],
};
function validateRow(key: string, row: RecordValue) {
  const fields = textFields[key];
  if (fields) strings(row, fields.required, fields.optional);
  for (const field of optionalNumbers[key] ?? []) numberField(row, field);
  for (const field of requiredNumbers[key] ?? []) numberField(row, field, true);
  for (const field of ["currency", "baseCurrency", "quoteCurrency", "purchaseCurrency", "currentCurrency", "convertedCurrency", "fromCurrency", "toCurrency", "feeCurrency", "targetCurrency"]) {
    if (row[field] !== undefined && !currencies.has(row[field] as string)) fail();
  }
  // Fields historically introduced by migrations remain optional; invalid supplied values do not.
  for (const field of ["active", "deleted", "includeInNetWorth", "isDefault", "isAutomatic", "isFixed", "isAnnualReserve"]) {
    if (row[field] !== undefined && typeof row[field] !== "boolean") fail();
  }
  if (own(requiredNumbers, key) && key !== "fxRates" && key !== "transfers" && !(key === "budgets" && row.currency === undefined) && !currencies.has(row.currency as string)) fail();
  switch (key) {
    case "accounts":
      strings(row, ["name"]); enumField(row, "type", ["bank", "cash", "investment", "credit-card"], true);
      enumField(row, "status", ["active", "inactive", "deleted"]); break;
    case "transactions":
      dateField(row, "date", true); enumField(row, "type", ["income", "expense"], true); break;
    case "transfers":
      dateField(row, "date", true); dateField(row, "rateDate");
      for (const field of ["fromCurrency", "toCurrency", "feeCurrency"]) if (!currencies.has(row[field] as string)) fail();
      if ((row.rate as number) <= 0 || (row.fromAmount as number) < 0 || (row.toAmount as number) < 0 || (row.fee as number) < 0) fail();
      break;
    case "fxRates":
      dateField(row, "effectiveDate", true);
      if (!currencies.has(row.baseCurrency as string) || !currencies.has(row.quoteCurrency as string) || (row.rate as number) <= 0) fail();
      break;
    case "categories": strings(row, ["name"]); enumField(row, "kind", ["income", "expense"], true); break;
    case "assets":
      strings(row, ["name", "category"]); enumField(row, "status", ["active", "unused", "sold"], true);
      enumField(row, "usageStartMode", ["purchaseDate", "customDate"]);
      for (const field of ["purchaseDate", "usageStartDate", "saleDate"]) dateField(row, field);
      break;
    case "goals":
      dateField(row, "due", true);
      for (const field of ["startDate", "endDate"]) if (row[field] !== undefined) dateField(row, field, true);
      enumField(row, "cadence", ["weekly", "monthly", "quarterly", "yearly", "custom", "once"], true);
      enumField(row, "status", ["on-track", "watch", "paused"], true);
      enumField(row, "priority", ["high", "medium", "low"]); break;
    case "plannedPayments":
      dateField(row, "due", true);
      enumField(row, "cadence", ["once", "monthly", "yearly"], true);
      enumField(row, "direction", ["income", "expense", "transfer", "saving", "investment"]); break;
    case "budgets":
      for (const field of ["month", "period"]) if (row[field] !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(row[field] as string)) fail();
      enumField(row, "status", ["active", "inactive", "deleted"]); break;
    case "annualPlans":
      if (!Number.isSafeInteger(row.year) || !Number.isSafeInteger(row.month) || (row.month as number) < 1 || (row.month as number) > 12) fail();
      enumField(row, "status", ["planned", "funded", "complete"], true);
      break;
    case "investments": dateField(row, "valuationDate", true); break;
    case "investmentTransactions":
      dateField(row, "date", true); enumField(row, "type", ["buy", "sell", "dividend", "fee"], true); break;
    case "liabilities":
      dateField(row, "dueDate"); enumField(row, "type", ["loan", "credit-card", "other"], true);
      enumField(row, "status", ["active", "paid"], true); break;
    case "netWorthHistory": dateField(row, "date", true); break;
    case "subscriptions":
      dateField(row, "nextDate", true); enumField(row, "cadence", ["monthly", "yearly"], true); break;
    case "importReviews":
      enumField(row, "status", ["pending", "applied", "undone"], true);
      if (!Array.isArray(row.rows)) fail();
      for (const item of row.rows) { if (!record(item)) fail(); validateRow("transactions", item); }
      if (row.appliedTransactionIds !== undefined && (!Array.isArray(row.appliedTransactionIds) || !row.appliedTransactionIds.every(text))) fail();
      break;
  }
  if (row.tags !== undefined && (!Array.isArray(row.tags) || !row.tags.every((item) => typeof item === "string"))) fail();
  if (row.fxSnapshot !== undefined) {
    if (!record(row.fxSnapshot)) fail();
    strings(row.fxSnapshot, ["rateDirection", "rateDate", "rateSource"], ["rateId"]);
    dateField(row.fxSnapshot, "rateDate", true);
    for (const field of ["originalAmount", "convertedAmount", "rate", "fee", "effectiveRate"]) numberField(row.fxSnapshot, field, true);
    for (const field of ["originalCurrency", "convertedCurrency", "feeCurrency"]) if (!currencies.has(row.fxSnapshot[field] as string)) fail();
    if ((row.fxSnapshot.rate as number) <= 0 || (row.fxSnapshot.fee as number) < 0) fail();
  }
}

function validateBody(body: RecordValue) {
  if (!Array.isArray(body.accounts) || !currencies.has(body.reportCurrency as string)) fail();
  for (const key of entityKeys) {
    if (!own(body, key)) continue;
    if (!Array.isArray(body[key])) fail();
    const ids = new Set<string>();
    for (const row of body[key]) {
      if (!record(row) || !text(row.id) || ids.has(row.id)) fail();
      ids.add(row.id); validateRow(key, row);
    }
  }
  for (const key of historyKeys) {
    if (!own(body, key)) continue;
    if (!Array.isArray(body[key])) fail();
    for (const row of body[key]) {
      if (key === "migrationNotices") { if (typeof row !== "string") fail(); continue; }
      if (!record(row)) fail();
      if (key === "assetMigrationBackups") {
        if (!text(row.assetId)) fail(); numberField(row, "usageDays", true);
        strings(row, ["backedUpAt"], ["purchaseDate"]); dateField(row, "purchaseDate");
      }
      else {
        for (const field of ["from", "to"]) if (!Number.isSafeInteger(row[field]) || (row[field] as number) < 1 || (row[field] as number) > CURRENT_SCHEMA_VERSION) fail();
        strings(row, ["appliedAt"]);
      }
    }
  }
  for (const key of ["obsidian", "obsidianTemplates", "cashFlowSettings", "externalIntegrations"]) {
    if (own(body, key) && !record(body[key])) fail();
  }
  if (record(body.cashFlowSettings)) {
    numberField(body.cashFlowSettings, "safetyBalance", true);
    if (!currencies.has(body.cashFlowSettings.currency as string)) fail();
  }
  if (record(body.obsidianTemplates) && Object.values(body.obsidianTemplates).some((value) => typeof value !== "string")) fail();
  if (record(body.obsidian)) {
    strings(body.obsidian, ["vaultName"], ["connectedAt", "lastScanAt", "lastSyncAt", "lastError"]);
    enumField(body.obsidian, "status", ["connected", "permission-error", "disconnected"], true);
  }
  if (record(body.externalIntegrations)) strings(body.externalIntegrations, [], ["providerName"]);
  // Unknown top-level entity collections still get ID checks, without inventing a schema for their contents.
  for (const [key, rows] of Object.entries(body)) {
    if (!Array.isArray(rows) || (entityKeys as readonly string[]).includes(key)) continue;
    const ids = new Set<string>();
    for (const row of rows) if (record(row) && own(row, "id")) {
      if (!text(row.id) || ids.has(row.id)) fail();
      ids.add(row.id);
    }
  }
  validateReferences(body);
}

function validateReferences(body: RecordValue) {
  const rows = (key: string) => (body[key] ?? []) as RecordValue[];
  const ids = (key: string) => new Set(rows(key).map((row) => row.id));
  const accounts = ids("accounts"), investments = ids("investments"), goals = ids("goals"), categories = ids("categories");
  function reference(row: RecordValue, key: string, targets: Set<unknown>, required = false, nullable = false) {
    const value = row[key];
    if (value === undefined && !required || value === null && nullable) return;
    if (!text(value) || !targets.has(value)) fail();
  }
  const parents = new Map<unknown, unknown>();
  for (const row of rows("accounts")) {
    reference(row, "parentAccountId", accounts, false, true);
    parents.set(row.id, row.parentAccountId);
  }
  const checked = new Set<unknown>();
  for (const id of accounts) {
    const path = new Set<unknown>(); let cursor: unknown = id;
    while (cursor !== undefined && cursor !== null && !checked.has(cursor)) {
      if (path.has(cursor)) fail();
      path.add(cursor); cursor = parents.get(cursor);
    }
    path.forEach((value) => checked.add(value));
  }
  for (const row of rows("transactions")) reference(row, "accountId", accounts, true);
  for (const row of rows("transfers")) {
    reference(row, "fromAccountId", accounts, true); reference(row, "toAccountId", accounts, true);
    if (row.fromAccountId === row.toAccountId) fail();
  }
  for (const key of ["plannedPayments", "watchlists", "investments", "subscriptions"]) for (const row of rows(key)) reference(row, "accountId", accounts);
  for (const row of rows("investmentTransactions")) reference(row, "investmentId", investments, true);
  for (const row of rows("annualPlans")) reference(row, "goalId", goals);
  // Legacy category IDs can be generated during migration; check them on the prepared result.
  if (body.schemaVersion === CURRENT_SCHEMA_VERSION && categories.size) {
    for (const key of ["transactions", "budgets"]) for (const row of rows(key)) reference(row, "categoryId", categories);
  }
  for (const review of rows("importReviews")) {
    for (const row of review.rows as RecordValue[]) reference(row, "accountId", accounts, true);
  }
  // appliedTransactionIds are historical undo receipts; those transactions may no longer exist.
}

const pointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
function fieldDifferences(before: unknown, after: unknown, key = ""): RestoreFieldDifference[] {
  if (canonical(before) === canonical(after)) return [];
  if ((record(before) || before === undefined) && (record(after) || after === undefined)) {
    const left = before ?? {}, right = after ?? {};
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    if (keys.length) return keys.flatMap((field) =>
      fieldDifferences(own(left, field) ? left[field] : undefined, own(right, field) ? right[field] : undefined, key ? `${key}/${pointer(field)}` : pointer(field)));
  }
  return [{ key: key || "$", before, after }];
}
function entityArray(value: unknown[]): value is RecordValue[] {
  return value.length > 0 && value.every((row) => record(row) && text(row.id)) && new Set(value.map((row) => (row as RecordValue).id)).size === value.length;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

function compare(current: RecordValue, target: RecordValue) {
  const modules: RestoreModule[] = [], details: RestoreDetail[] = [], totals = emptyCounts();
  for (const key of [...new Set([...entityKeys, ...historyKeys, ...Object.keys(current), ...Object.keys(target)])].sort()) {
    const before = own(current, key) ? current[key] : undefined, after = own(target, key) ? target[key] : undefined;
    const count = (value: unknown) => Array.isArray(value) ? value.length : value === undefined ? 0 : 1;
    const module: RestoreModule = { key, label: own(labels, key) ? labels[key] : key,
      current: count(before), backup: count(after), ...emptyCounts(), reordered: false };
    function add(id: string, left: unknown, right: unknown, hasLeft: boolean, hasRight: boolean) {
      const kind: RestoreDifferenceKind = !hasLeft ? "added" : !hasRight ? "currentOnly" : canonical(left) === canonical(right) ? "same" : "changed";
      module[kind] += 1; totals[kind] += 1;
      const row = record(right) ? right : record(left) ? left : undefined;
      details.push({ module: key, id, label: row && typeof row.name === "string" ? row.name : id,
        kind, fields: kind === "same" ? [] : fieldDifferences(left, right) });
    }
    if ((before === undefined || Array.isArray(before)) && (after === undefined || Array.isArray(after)) && (Array.isArray(before) || Array.isArray(after))) {
      const left = (before ?? []) as unknown[], right = (after ?? []) as unknown[];
      const byId = (entityKeys as readonly string[]).includes(key) || ((left.length === 0 || entityArray(left)) && (right.length === 0 || entityArray(right)) && left.length + right.length > 0);
      if (byId) {
        const leftMap = new Map((left as RecordValue[]).map((row) => [row.id as string, row]));
        const rightMap = new Map((right as RecordValue[]).map((row) => [row.id as string, row]));
        for (const id of [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort()) add(id, leftMap.get(id), rightMap.get(id), leftMap.has(id), rightMap.has(id));
        const sharedLeft = left.filter((row) => rightMap.has((row as RecordValue).id as string)).map((row) => (row as RecordValue).id);
        const sharedRight = right.filter((row) => leftMap.has((row as RecordValue).id as string)).map((row) => (row as RecordValue).id);
        module.reordered = canonical(sharedLeft) !== canonical(sharedRight);
      } else {
        // ID-less collections are multisets: exact values + occurrence counts, never index identity.
        const buckets = (values: unknown[]) => {
          const map = new Map<string, unknown[]>();
          for (const value of values) { const token = canonical(value); const bucket = map.get(token) ?? []; bucket.push(value); map.set(token, bucket); }
          return map;
        };
        const leftMap = buckets(left), rightMap = buckets(right);
        let token = 0;
        for (const fingerprint of [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort()) {
          const a = leftMap.get(fingerprint) ?? [], b = rightMap.get(fingerprint) ?? [];
          for (let n = 0; n < Math.max(a.length, b.length); n += 1) add(`entry-${++token}`, a[n], b[n], n < a.length, n < b.length);
        }
        module.reordered = module.added + module.currentOnly === 0 && canonical(left) !== canonical(right);
      }
      // Explicitly disclose absent versus supplied empty collections as a field change.
      if ((before === undefined) !== (after === undefined) && left.length + right.length === 0) add("$", before, after, before !== undefined, after !== undefined);
    } else if (before !== undefined || after !== undefined) add("$", before, after, before !== undefined, after !== undefined);
    modules.push(module);
  }
  return { modules, details, totals, sameData: totals.added + totals.changed + totals.currentOnly === 0, reordered: modules.some((module) => module.reordered) };
}

/** Pure restore-only boundary. No storage, auth, cloud, Vault, or global migration changes.
 * The source and current are detached before migration/normalization, which run exactly once.
 */
export function prepareRestorePreview(current: WealthData, raw: unknown, metadata?: { schemaVersion?: number | null }): RestorePreview {
  try {
    const currentClone = cloneData(current);
    if (!record(currentClone)) fail();
    const sourceFingerprint = stableRestoreFingerprint(raw);
    const body = extract(raw, metadata);
    validateBody(body);
    const migrated = migrateWealthData(body);
    const assets = normalizeAssets(migrated.assets);
    const prepared: WealthData = { ...migrated, assets: assets.normalized,
      assetMigrationBackups: [...(migrated.assetMigrationBackups ?? []),
        ...assets.backups.filter((backup) => !(migrated.assetMigrationBackups ?? []).some((item) => item.assetId === backup.assetId))] };
    const candidate = prepared as WealthData & RecordValue;
    for (const key of excludedFields) {
      if (own(currentClone, key)) Object.defineProperty(candidate, key, { value: currentClone[key], writable: true, enumerable: true, configurable: true });
      else delete candidate[key];
    }
    validateBody(candidate);
    // Canonical JSON round-trip drops undefined optional properties exactly as persisted snapshots do.
    const detached = JSON.parse(canonical(candidate)) as WealthData & RecordValue;
    const currentFingerprint = canonical(currentClone), targetFingerprint = canonical(detached);
    return freeze({ candidate: detached, currentFingerprint, sourceFingerprint, targetFingerprint,
      ...compare(currentClone, detached), excludedFields });
  } catch (error) {
    if (error instanceof RestorePreviewError) throw error;
    // Never expose parser, accessor, migration or normalization exceptions containing source data.
    throw new RestorePreviewError();
  }
}
