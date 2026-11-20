import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Source-only allowlist. No profile files, environment files, storage, desktop, Vault,
// subprocesses, network, or filesystem fixtures are used by this isolated suite.
const modules = new Map();
const allowed = new Set(["backup-restore-preview", "asset-normalization", "migrations", "finance"]);
const calls = { migration: 0, normalization: 0 };
function load(name) {
  assert.ok(allowed.has(name), "Unexpected dependency in the pure preview engine");
  if (modules.has(name)) return modules.get(name);
  const module = { exports: {} };
  modules.set(name, module.exports);
  const code = ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", code)(id => load(id.replace(/^\.\//, "")), module, module.exports);
  if (name === "migrations") {
    const migrate = module.exports.migrateWealthData;
    module.exports.migrateWealthData = (...args) => { calls.migration++; return migrate(...args); };
  }
  if (name === "asset-normalization") {
    const normalize = module.exports.normalizeAssets;
    module.exports.normalizeAssets = (...args) => { calls.normalization++; return normalize(...args); };
  }
  return module.exports;
}
const { prepareRestorePreview, stableRestoreFingerprint, RestorePreviewError } = load("backup-restore-preview");
const { migrateWealthData, CURRENT_SCHEMA_VERSION } = load("migrations");
const finance = load("finance");
const clone = structuredClone;
const entityKeys = ["accounts", "transactions", "transfers", "fxRates", "goals", "assets", "plannedPayments",
  "budgets", "categories", "annualPlans", "syncLogs", "watchlists", "investments", "investmentTransactions",
  "liabilities", "netWorthHistory", "subscriptions", "reviews", "importReviews", "migrationBackups"];
const historyKeys = ["assetMigrationBackups", "migrationHistory", "migrationNotices"];
function base() {
  const data = Object.fromEntries([...entityKeys, ...historyKeys].map(key => [key, []]));
  return JSON.parse(JSON.stringify(migrateWealthData({ ...data,
    schemaVersion: CURRENT_SCHEMA_VERSION, reportCurrency: "MYR",
    accounts: [
      { id: "bank-a", name: "Synthetic A", type: "bank", currency: "MYR", balance: 123.45 },
      { id: "bank-b", name: "Synthetic B", type: "bank", currency: "USD", balance: -12.25, status: "deleted" },
    ],
    obsidian: { vaultName: "Synthetic current connection", status: "connected" },
    cashFlowSettings: { safetyBalance: 0, currency: "MYR" },
    externalIntegrations: { bankSyncEnabled: false, liveFxEnabled: false },
  })));
}
function frozen(value) { if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
function assertDeepFrozen(value) {
  if (value && typeof value === "object") { assert.equal(Object.isFrozen(value), true); Object.values(value).forEach(assertDeepFrozen); }
}
function rejects(raw, code = "INVALID_BACKUP", metadata) {
  assert.throws(() => prepareRestorePreview(base(), raw, metadata), error => {
    assert.ok(error instanceof RestorePreviewError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /SECRET|SyntaxError|bank-a|amount|accounts|stack|undefined/);
    return true;
  });
}
const rowTemplates = {
  transactions: { type: "expense", accountId: "bank-a", amount: 4.25, currency: "MYR", category: "食物", date: "2026-01-02", deleted: true },
  transfers: { fromAccountId: "bank-a", toAccountId: "bank-b", fromAmount: 5, fromCurrency: "MYR", toAmount: 1, toCurrency: "USD", rate: 0.2, fee: 0, feeCurrency: "MYR", date: "2026-01-02", deleted: true },
  fxRates: { baseCurrency: "MYR", quoteCurrency: "USD", rate: 0.2, effectiveDate: "2026-01-02", active: false },
  goals: { name: "Synthetic goal", current: 1, target: 10, currency: "MYR", due: "2026-12-01", cadence: "monthly", status: "on-track", deleted: true },
  assets: { name: "Synthetic asset", category: "other", purchaseValue: 9, currentValue: 4, currency: "MYR", status: "unused", usageDays: 0, deleted: true },
  plannedPayments: { name: "Synthetic payment", amount: 1, currency: "MYR", due: "2026-12-01", cadence: "once", category: "食物" },
  budgets: { month: "2026-01", category: "食物", limit: 10, currency: "MYR", deleted: true },
  categories: { name: "Synthetic category", kind: "expense", active: false },
  annualPlans: { year: 2026, month: 12, name: "Synthetic plan", category: "食物", status: "planned", amount: 5, currency: "MYR", deleted: true },
  watchlists: { name: "Synthetic watch", spent: 1, limit: 3, average: 1, forecast: 2, currency: "MYR", accountId: "bank-a" },
  investments: { name: "Synthetic fund", assetType: "fund", valuationDate: "2026-01-02", costBasis: 3, currentValue: 4, currency: "MYR", accountId: "bank-a" },
  investmentTransactions: { investmentId: "shared-id", type: "buy", date: "2026-01-02", amount: 1, currency: "MYR", deleted: true },
  liabilities: { name: "Synthetic loan", type: "loan", status: "active", principal: 6, remainingPrincipal: 3, interestRate: 2, minimumPayment: 1, currency: "MYR" },
  netWorthHistory: { date: "2026-01-02", value: 1, cash: 2, investments: 3, assets: 4, liabilities: 8, currency: "MYR" },
  subscriptions: { name: "Synthetic subscription", nextDate: "2026-12-01", cadence: "monthly", category: "食物", amount: 1, currency: "MYR", accountId: "bank-a", active: false },
  reviews: { period: "2026-01", good: "Synthetic only", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
  importReviews: { fileName: "synthetic.csv", importedAt: "2026-01-02T00:00:00.000Z", rows: [{ type: "expense", accountId: "bank-a", amount: 1, currency: "MYR", category: "食物", date: "2026-01-02" }], status: "undone" },
  migrationBackups: { from: 7, to: 10, createdAt: "2026-01-02", snapshot: { synthetic: true } },
};

test("API provides exact source/current/target fingerprints, zero differences and actual counts", () => {
  const current = base(), result = prepareRestorePreview(current, current);
  assert.equal(result.sourceFingerprint, stableRestoreFingerprint(current));
  assert.equal(result.currentFingerprint, stableRestoreFingerprint(current));
  assert.equal(result.targetFingerprint, stableRestoreFingerprint(result.candidate));
  assert.equal(result.sameData, true);
  assert.equal(result.reordered, false);
  assert.deepEqual(result.totals, { added: 0, changed: 0, same: result.details.length, currentOnly: 0 });
  const accounts = result.modules.find(module => module.key === "accounts");
  assert.equal(accounts.current, 2); assert.equal(accounts.backup, 2); assert.equal(accounts.same, 2);
  for (const key of [...entityKeys, ...historyKeys]) assert.ok(result.modules.some(module => module.key === key));
  assertDeepFrozen(result);
});

test("Obsidian connection and sync history are always retained from current and disclosed", () => {
  const current = base(), target = base();
  current.syncLogs = [{ id: "current-sync", syncedAt: "2026-01-02", vaultName: "Synthetic current", fileCount: 2 }];
  target.syncLogs = [{ id: "old-sync", syncedAt: "2025-01-02", vaultName: "Synthetic old" }];
  target.obsidian = { vaultName: "Synthetic old connection", status: "disconnected" };
  const result = prepareRestorePreview(current, target);
  assert.deepEqual(result.excludedFields, ["obsidian", "syncLogs"]);
  assert.deepEqual(result.candidate.obsidian, current.obsidian);
  assert.deepEqual(result.candidate.syncLogs, current.syncLogs);
  assert.notEqual(result.candidate.syncLogs, current.syncLogs);
  assert.equal(result.sameData, true);
  assert.equal(result.modules.find(module => module.key === "syncLogs").backup, 1);
  delete current.obsidian; delete current.syncLogs;
  const withoutConnection = prepareRestorePreview(current, target);
  assert.equal(Object.hasOwn(withoutConnection.candidate, "obsidian"), false);
  assert.equal(Object.hasOwn(withoutConnection.candidate, "syncLogs"), false);
});

test("all entity modules use collection+ID, disclose unknown field changes and include deleted/archived rows", () => {
  let current = base();
  for (const [key, row] of Object.entries(rowTemplates)) current[key].push({ id: "shared-id", ...row, syntheticExtension: { flag: "before" } });
  current = clone(prepareRestorePreview(current, current).candidate);
  const target = clone(current);
  for (const key of Object.keys(rowTemplates)) target[key].find(row => row.id === "shared-id").syntheticExtension.flag = "after";
  target.accounts[1].balance = -20;
  const result = prepareRestorePreview(current, target);
  for (const key of Object.keys(rowTemplates)) {
    const detail = result.details.find(detail => detail.module === key && detail.id === "shared-id");
    assert.equal(detail.kind, "changed", key);
    assert.ok(detail.fields.some(field => field.key === "syntheticExtension/flag" && field.before === "before" && field.after === "after"));
  }
  assert.equal(result.details.find(detail => detail.module === "accounts" && detail.id === "bank-b").kind, "changed");
  assert.equal(result.modules.find(module => module.key === "assets").current, 1);
  assert.equal(result.modules.find(module => module.key === "assets").backup, 1);
  assert.equal(result.sameData, false);
});

test("current-only and backup-only IDs and all fields are visible, not mislabeled by position", () => {
  const current = base(), target = base();
  target.accounts = [{ ...target.accounts[1], id: "new-bank" }];
  const result = prepareRestorePreview(current, target);
  const module = result.modules.find(module => module.key === "accounts");
  assert.deepEqual([module.current, module.backup, module.added, module.currentOnly, module.changed], [2, 1, 1, 2, 0]);
  assert.equal(result.details.find(detail => detail.id === "bank-a").kind, "currentOnly");
  assert.equal(result.details.find(detail => detail.id === "new-bank").kind, "added");
  const fields = result.details.find(detail => detail.id === "new-bank").fields;
  for (const [key, value] of Object.entries(target.accounts[0])) {
    assert.ok(fields.some(field => field.key === key && field.before === undefined && field.after === value));
  }
});

test("reorders preserve ID identity and sameData but change exact fingerprints", () => {
  const current = base(), target = base();
  current.migrationNotices = ["Synthetic A", "Synthetic B", "Synthetic A"];
  target.migrationNotices = ["Synthetic B", "Synthetic A", "Synthetic A"];
  target.accounts.reverse(); target.categories.reverse();
  const result = prepareRestorePreview(current, target);
  assert.equal(result.sameData, true); assert.equal(result.reordered, true);
  assert.notEqual(result.currentFingerprint, result.targetFingerprint);
  assert.equal(result.modules.find(module => module.key === "accounts").changed, 0);
  assert.equal(result.modules.find(module => module.key === "migrationNotices").same, 3);
  assert.equal(result.modules.find(module => module.key === "migrationNotices").reordered, true);
});

test("unknown settings, nested ordered arrays, ID-less arrays and duplicate occurrences are included", () => {
  const current = base(), target = base();
  current.futureSetting = { "a/b~": ["one", "two"], remove: true };
  target.futureSetting = { "a/b~": ["two", "one"], add: { x: 1 } };
  current.extensionHistory = [{ event: "A" }, { event: "A" }, { event: "B" }];
  target.extensionHistory = [{ event: "B" }, { event: "A" }, { event: "C" }];
  current.onlyCurrentSetting = true;
  target.unknownCollection = [{ id: "extension-row", payload: { keep: "untouched" } }];
  const result = prepareRestorePreview(current, target);
  const fields = result.details.find(detail => detail.module === "futureSetting").fields;
  assert.ok(fields.some(field => field.key === "a~1b~0"));
  assert.ok(fields.some(field => field.key === "remove" && field.after === undefined));
  assert.deepEqual(result.candidate.unknownCollection, target.unknownCollection);
  const history = result.modules.find(module => module.key === "extensionHistory");
  assert.deepEqual([history.current, history.backup, history.same, history.added, history.currentOnly], [3, 3, 2, 1, 1]);
  assert.equal(result.details.find(detail => detail.module === "onlyCurrentSetting").kind, "currentOnly");
});

test("frozen inputs, shared nested objects and independent previews never mutate or alias", () => {
  const current = base(), target = base(), shared = { values: [1, 2, { flag: true }] };
  current.extra = shared; target.extra = shared;
  target.assets = [{ id: "asset-legacy", ...rowTemplates.assets, usageDays: 3, purchaseDate: "2026-01-02" }];
  const before = clone(target), beforeCurrent = clone(current);
  frozen(current); frozen(target);
  const prior = { ...calls }, result = prepareRestorePreview(current, target);
  assert.equal(calls.migration - prior.migration, 1); assert.equal(calls.normalization - prior.normalization, 1);
  const fingerprint = result.targetFingerprint;
  assert.throws(() => { result.candidate.accounts[0].balance = 999; }, TypeError);
  assert.throws(() => { result.candidate.extra.values.push(3); }, TypeError);
  assert.throws(() => { result.details[0].kind = "added"; }, TypeError);
  assert.notEqual(result.candidate.extra, shared);
  assert.deepEqual(current, beforeCurrent); assert.deepEqual(target, before);
  assert.equal(stableRestoreFingerprint(result.candidate), fingerprint);
  const other = prepareRestorePreview(current, target);
  assert.notEqual(other.candidate, result.candidate);
  assert.equal(result.targetFingerprint, fingerprint);
});

test("legitimate legacy omissions are migrated and normalized once, without mutating input", () => {
  const raw = { reportCurrency: "MYR", accounts: [{ id: "legacy", name: "Legacy synthetic", type: "cash", currency: "MYR", balance: 0 }],
    budgets: [{ id: "legacy-budget", category: "食物", month: "2026-01", limit: 5 }],
    unknownSetting: { preserved: [1, true, null] } };
  const before = clone(raw), result = prepareRestorePreview(base(), raw, { schemaVersion: null });
  assert.equal(result.candidate.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(result.candidate.accounts[0].status, "active");
  assert.equal(result.candidate.budgets[0].currency, "MYR");
  assert.ok(result.candidate.migrationBackups.length > 0);
  assert.deepEqual(result.candidate.unknownSetting, raw.unknownSetting);
  assert.deepEqual(raw, before);
});

test("raw objects, JSON strings and valid v1 envelopes preserve their exact reread fingerprint", () => {
  const data = base(), envelope = { format: "wealth-atlas-snapshot", version: 1, schemaVersion: 10, exportedAt: "2026-01-02", data };
  for (const raw of [data, JSON.stringify(data), envelope, JSON.stringify(envelope, null, 2)]) {
    const result = prepareRestorePreview(base(), raw, { schemaVersion: 10 });
    assert.equal(result.sourceFingerprint, stableRestoreFingerprint(clone(raw)));
    assert.equal(result.sameData, true);
  }
  delete envelope.data.schemaVersion;
  assert.equal(prepareRestorePreview(base(), envelope, { schemaVersion: 10 }).candidate.schemaVersion, 10);
});

test("future versions, contradictory metadata and invalid version types are rejected", () => {
  for (const schemaVersion of [11, 1000]) rejects({ ...base(), schemaVersion }, "UNSUPPORTED_VERSION");
  rejects({ format: "wealth-atlas-snapshot", version: 2, schemaVersion: 10, data: base() }, "UNSUPPORTED_VERSION");
  rejects({ format: "wealth-atlas-snapshot", version: 1, schemaVersion: 11, data: base() }, "UNSUPPORTED_VERSION");
  rejects(base(), "UNSUPPORTED_VERSION", { schemaVersion: 11 });
  rejects(base(), "SCHEMA_MISMATCH", { schemaVersion: 9 });
  rejects({ format: "wealth-atlas-snapshot", version: 1, schemaVersion: 9, data: base() }, "SCHEMA_MISMATCH");
  for (const schemaVersion of [null, "10", -1, 0, 1.5, true]) rejects({ ...base(), schemaVersion });
  for (const version of [null, undefined, 0, -1, "1", 1.5]) rejects({ format: "wealth-atlas-snapshot", version, data: base() });
  rejects({ format: "SECRET", version: 1, data: base() });
  rejects({ format: "wealth-atlas-snapshot", version: 1, data: null });
});

test("every supplied known collection rejects corruption before global migration can erase it", () => {
  for (const key of [...entityKeys, ...historyKeys]) {
    for (const value of [null, undefined, {}, "SECRET", 0, true]) rejects({ ...base(), [key]: value });
    rejects({ ...base(), [key]: [null] });
  }
  for (const raw of [null, [], {}, 1, "SECRET", '{"SECRET":', { accounts: [], reportCurrency: "SECRET" }]) rejects(raw);
  for (const key of ["obsidian", "cashFlowSettings", "obsidianTemplates", "externalIntegrations"]) {
    for (const value of [null, [], false, "SECRET"]) rejects({ ...base(), [key]: value });
  }
});

test("blank, non-string and duplicate IDs are refused, with cross-collection IDs allowed", () => {
  for (const key of entityKeys) {
    for (const id of [undefined, null, "", "  ", 1]) rejects({ ...base(), [key]: [{ id }] });
  }
  for (const id of ["bank-a", " __proto__ ", "constructor"]) {
    const raw = base(); raw.accounts = [raw.accounts[0], { ...raw.accounts[0], id }, { ...raw.accounts[0], id }]; rejects(raw);
  }
  rejects({ ...base(), extension: [{ id: "same" }, { id: "same" }] });
  rejects({ ...base(), extension: [{ id: " " }] });
  const raw = base(); raw.goals = [{ id: "bank-a", ...rowTemplates.goals }];
  assert.ok(prepareRestorePreview(base(), raw).candidate.goals.length);
});

test("nonfinite, unsafe, nonnumeric and null amounts fail, including optional/nested money", () => {
  for (const balance of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "123", null]) rejects({ ...base(), accounts: [{ ...base().accounts[0], balance }] });
  for (const [key, field] of [["transactions", "amount"], ["transfers", "fee"], ["assets", "sellPrice"], ["goals", "periodAmount"], ["investments", "quantity"], ["investmentTransactions", "fee"], ["liabilities", "extraPayment"]]) {
    const raw = base(); raw[key] = [{ id: "synthetic", ...rowTemplates[key], [field]: "SECRET" }]; rejects(raw);
  }
  const raw = base(); raw.transactions = [{ id: "fx", ...rowTemplates.transactions, fxSnapshot: { originalAmount: null, convertedAmount: 2, rate: 1, fee: 0, effectiveRate: 1 } }]; rejects(raw);
  rejects({ ...base(), unknownSetting: { amount: Infinity } });
  const valid = base(); valid.accounts[0].balance = Number.MAX_SAFE_INTEGER;
  assert.equal(prepareRestorePreview(base(), valid).candidate.accounts[0].balance, Number.MAX_SAFE_INTEGER);
});

test("dangling account, transfer, hierarchy, goal and investment references fail even in deleted rows", () => {
  for (const key of ["transactions", "plannedPayments", "watchlists", "investments", "subscriptions"]) {
    const raw = base(); raw[key] = [{ id: "orphan", ...rowTemplates[key], accountId: "SECRET" }]; rejects(raw);
  }
  for (const field of ["fromAccountId", "toAccountId"]) {
    const raw = base(); raw.transfers = [{ id: "orphan", ...rowTemplates.transfers, [field]: "SECRET" }]; rejects(raw);
  }
  const same = base(); same.transfers = [{ id: "loop", ...rowTemplates.transfers, toAccountId: "bank-a" }]; rejects(same);
  for (const parentAccountId of ["SECRET", "", "bank-a"]) {
    const raw = base(); raw.accounts[0].parentAccountId = parentAccountId; rejects(raw);
  }
  const cycle = base(); cycle.accounts[0].parentAccountId = "bank-b"; cycle.accounts[1].parentAccountId = "bank-a"; rejects(cycle);
  const raw = base(); raw.investmentTransactions = [{ id: "orphan", ...rowTemplates.investmentTransactions }]; rejects(raw);
  raw.investmentTransactions = []; raw.annualPlans = [{ id: "orphan", ...rowTemplates.annualPlans, goalId: "SECRET" }]; rejects(raw);
  const imported = base(); imported.importReviews = [{ id: "orphan", rows: [{ ...rowTemplates.transactions, accountId: "SECRET" }] }]; rejects(imported);
  const valid = base(); valid.accounts[0].parentAccountId = "bank-b";
  valid.transactions = [{ id: "historical", ...rowTemplates.transactions, accountId: "bank-b" }];
  assert.ok(prepareRestorePreview(base(), valid).candidate.transactions[0].deleted);
});

test("malformed supplied nested arrays, asset dates and supplied flags are not silently normalized", () => {
  const cases = [
    ["assets", { purchaseDate: "2026-02-30" }], ["assets", { useCount: null }],
    ["assets", { usageStartMode: "SECRET" }], ["transactions", { deleted: "true" }],
    ["importReviews", { rows: null }], ["importReviews", { rows: [null] }],
    ["importReviews", { appliedTransactionIds: [null] }], ["watchlists", { tags: {} }],
  ];
  for (const [key, override] of cases) { const raw = base(); raw[key] = [{ id: "malformed", ...rowTemplates[key], ...override }]; rejects(raw); }
});

test("fingerprints are canonical, order-sensitive, complete and safe for special own keys", () => {
  assert.equal(stableRestoreFingerprint({ b: 2, a: 1 }), stableRestoreFingerprint({ a: 1, b: 2 }));
  assert.equal(stableRestoreFingerprint({ a: undefined }), stableRestoreFingerprint({}));
  assert.notEqual(stableRestoreFingerprint([1, 2]), stableRestoreFingerprint([2, 1]));
  assert.notEqual(stableRestoreFingerprint({ extra: null }), stableRestoreFingerprint({}));
  const current = base(), raw = JSON.parse(JSON.stringify(base()));
  Object.defineProperty(raw, "__proto__", { value: { synthetic: "kept" }, enumerable: true });
  raw.constructor = { extension: true };
  const result = prepareRestorePreview(current, raw);
  assert.equal(Object.hasOwn(result.candidate, "__proto__"), true);
  assert.deepEqual(result.candidate.__proto__, { synthetic: "kept" });
  assert.equal({}.synthetic, undefined);
  assert.equal(result.details.find(detail => detail.module === "constructor").kind, "added");
  assert.equal(result.details.find(detail => detail.module === "__proto__").kind, "added");
});

test("adversarial runtime objects cannot invoke getters/toJSON or leak thrown values", () => {
  let accessed = 0;
  const getter = base(); Object.defineProperty(getter, "unknown", { enumerable: true, get() { accessed++; throw new Error("SECRET"); } }); rejects(getter);
  assert.equal(accessed, 0);
  const cyclic = base(); cyclic.self = cyclic; rejects(cyclic);
  const sparse = base(); sparse.accounts = new Array(2); rejects(sparse);
  for (const value of [new Date(), new Map(), new Set(), 1n, Symbol("SECRET"), () => "SECRET"]) rejects({ ...base(), unknown: value });
  rejects({ ...base(), unknown: { toJSON() { accessed++; throw new Error("SECRET"); } } });
  assert.equal(accessed, 0);
  const symbol = base(); symbol[Symbol("SECRET")] = 1; rejects(symbol);
  let deep = {}; const root = deep;
  for (let i = 0; i < 205; i++) { deep.next = {}; deep = deep.next; }
  rejects({ ...base(), unknown: root });
});

function populated() {
  const raw = base();
  for (const [key, row] of Object.entries(rowTemplates)) raw[key].push({ id: "shared-id", ...clone(row) });
  raw.syncLogs = [{ id: "synthetic-sync", syncedAt: "2026-01-02T00:00:00.000Z", vaultName: "Synthetic vault" }];
  return raw;
}

test("P1: planned-payment due/cadence corruption is rejected before persistence; valid candidates reach real finance consumers", () => {
  const bad = base(); bad.plannedPayments = [{ id: "payment", ...rowTemplates.plannedPayments, due: {} }];
  assert.throws(() => finance.getUpcomingPlannedPayments(bad, "2026-12", "2026-12-01"), TypeError);
  let durable = stableRestoreFingerprint(base()), writes = 0;
  assert.throws(() => {
    const preview = prepareRestorePreview(base(), bad);
    durable = stableRestoreFingerprint(preview.candidate); writes++;
  }, RestorePreviewError);
  assert.equal(writes, 0); assert.equal(durable, stableRestoreFingerprint(base()));
  for (const due of [{}, [], null, 1, true, undefined, "", "SECRET", "2026-02-30", "2026-13-01"]) {
    rejects({ ...base(), plannedPayments: [{ id: "payment", ...rowTemplates.plannedPayments, due }] });
  }
  for (const cadence of [{}, [], null, 1, true, undefined, "", "weekly", "SECRET"]) {
    rejects({ ...base(), plannedPayments: [{ id: "payment", ...rowTemplates.plannedPayments, cadence }] });
  }
  const valid = base(); valid.plannedPayments = [{ id: "payment", ...rowTemplates.plannedPayments }];
  valid.subscriptions = [{ id: "subscription", ...rowTemplates.subscriptions, active: true }];
  const candidate = prepareRestorePreview(base(), valid).candidate;
  assert.deepEqual(finance.getUpcomingPlannedPayments(candidate, "2026-12", "2026-12-01").map(row => row.id), ["payment"]);
  assert.equal(finance.getCashFlowOccurrences(candidate, "2026-12-01", 30).length, 2);
  assert.ok(Number.isFinite(finance.getCashFlowForecast(candidate, 30, "2026-12-01").endBalance));
});

test("every known scalar textual property in lib/types rejects supplied non-strings, including archived records", () => {
  const tree = ts.createSourceFile("types.ts", readFileSync(new URL("../lib/types.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const aliases = new Map(tree.statements.filter(ts.isTypeAliasDeclaration).map(node => [node.name.text, node.type]));
  const isText = node => node.kind === ts.SyntaxKind.StringKeyword || ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)
    || ts.isUnionTypeNode(node) && node.types.every(isText) || ts.isTypeReferenceNode(node) && aliases.has(node.typeName.getText(tree)) && isText(aliases.get(node.typeName.getText(tree)));
  const entities = { accounts: "Account", transactions: "Transaction", transfers: "Transfer", fxRates: "FxRate", goals: "Goal",
    assets: "AssetItem", plannedPayments: "PlannedPayment", budgets: "MonthlyBudget", categories: "TransactionCategory",
    annualPlans: "AnnualPlan", watchlists: "Watchlist", investments: "Investment", investmentTransactions: "InvestmentTransaction",
    liabilities: "Liability", netWorthHistory: "NetWorthSnapshot", subscriptions: "Subscription", reviews: "FinancialReview",
    importReviews: "ImportReview", syncLogs: "SyncLog" };
  const initial = populated();
  assert.doesNotThrow(() => prepareRestorePreview(base(), initial));
  let covered = 0;
  for (const [key, alias] of Object.entries(entities)) for (const property of aliases.get(alias).members) {
    if (!isText(property.type)) continue;
    const field = property.name.getText(tree);
    for (const value of [{ SECRET: true }, [], null, 1, false]) {
      const raw = clone(initial); raw[key][0][field] = value;
      assert.throws(() => prepareRestorePreview(base(), raw), RestorePreviewError, `${key}.${field}`);
    }
    covered++;
  }
  assert.ok(covered > 130, `Expected broad type-driven coverage; covered ${covered} properties`);
});

test("required rendered names/text cannot be omitted or persisted as objects", () => {
  for (const key of ["accounts", "categories", "assets", "goals", "annualPlans", "plannedPayments", "watchlists", "investments", "liabilities", "subscriptions"]) {
    for (const value of [undefined, { SECRET: true }]) {
      const raw = populated(); raw[key][0].name = value;
      let writes = 0;
      assert.throws(() => { const { candidate } = prepareRestorePreview(base(), raw); void candidate; writes++; }, RestorePreviewError, key);
      assert.equal(writes, 0);
    }
  }
  for (const [key, field] of [["investments", "valuationDate"], ["investments", "assetType"], ["subscriptions", "nextDate"],
    ["subscriptions", "category"], ["annualPlans", "category"], ["reviews", "period"], ["reviews", "createdAt"],
    ["reviews", "updatedAt"], ["importReviews", "fileName"], ["importReviews", "importedAt"]]) {
    const raw = populated(); delete raw[key][0][field]; rejects(raw);
  }
});

test("supplied nested FX, history and settings text is checked without coercion", () => {
  const snapshot = { originalAmount: 1, originalCurrency: "MYR", convertedAmount: 1, convertedCurrency: "MYR", rateDirection: "MYR/MYR",
    rate: 1, rateDate: "2026-01-02", rateSource: "Synthetic manual", fee: 0, feeCurrency: "MYR", effectiveRate: 1 };
  for (const field of ["rateDirection", "rateDate", "rateSource", "rateId"]) {
    const raw = populated(); raw.transactions[0].fxSnapshot = { ...snapshot, [field]: {} }; rejects(raw);
  }
  for (const field of ["vaultName", "connectedAt", "lastScanAt", "lastSyncAt", "lastError", "status"]) {
    const raw = base(); raw.obsidian[field] = {}; rejects(raw);
  }
  rejects({ ...base(), externalIntegrations: { bankSyncEnabled: false, liveFxEnabled: false, providerName: {} } });
  for (const [key, row, field] of [
    ["assetMigrationBackups", { assetId: "asset", backedUpAt: "2026-01-02", usageDays: 1 }, "backedUpAt"],
    ["assetMigrationBackups", { assetId: "asset", backedUpAt: "2026-01-02", usageDays: 1 }, "purchaseDate"],
    ["migrationHistory", { from: 7, to: 10, appliedAt: "2026-01-02" }, "appliedAt"],
    ["migrationBackups", { id: "migration", from: 7, to: 10, createdAt: "2026-01-02", snapshot: {} }, "createdAt"],
  ]) rejects({ ...base(), [key]: [{ ...row, [field]: {} }] });
});

test("supported legacy omissions and optional text remain safe; unknown fields survive intact", () => {
  const raw = populated();
  delete raw.accounts[0].status; delete raw.budgets[0].currency; delete raw.budgets[0].period;
  delete raw.goals[0].startDate; delete raw.goals[0].endDate;
  raw.reviews[0].good = ""; raw.reviews[0].overspend = "Synthetic only"; raw.reviews[0].nextPlan = "Synthetic plan";
  raw.reviews[0].bad = { futureExtension: [null, 1] }; raw.reviews[0].plans = ["future", { raw: true }];
  raw.subscriptions[0].nextDue = { unknownExtension: true };
  raw.investments[0].unknownLabel = { nested: "preserved" };
  const before = clone(raw), candidate = prepareRestorePreview(base(), frozen(raw)).candidate;
  assert.deepEqual(raw, before);
  assert.equal(candidate.accounts[0].status, "active"); assert.equal(candidate.budgets[0].currency, "MYR");
  assert.equal(candidate.budgets[0].period, candidate.budgets[0].month);
  assert.equal(candidate.goals[0].endDate, candidate.goals[0].due);
  assert.deepEqual(candidate.reviews[0].bad, before.reviews[0].bad); assert.deepEqual(candidate.reviews[0].plans, before.reviews[0].plans);
  assert.deepEqual(candidate.subscriptions[0].nextDue, before.subscriptions[0].nextDue);
  assert.deepEqual(candidate.investments[0].unknownLabel, before.investments[0].unknownLabel);
  assert.ok(Number.isFinite(finance.getGoalMonthsRemaining(candidate.goals[0], "2026-01-02")));
  assert.doesNotThrow(() => finance.getWatchlistMetrics(candidate, candidate.watchlists[0], "2026-01", "2026-01-02"));
  assert.doesNotThrow(() => finance.getCashFlowForecast(candidate, 30, "2026-01-02"));
});
