import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson, CloudEditConflictError, createCloudSyncSession,
  fingerprintSnapshot, keyOf, mergeSnapshots, parseSyncBaseline, snapshotsEqual,
  decodeSyncPayload, emptyDeletionMetadata, encodeSyncPayload, inheritRemovalIntents,
  mergeDeletionMetadata, prepareRemovalJournals, registerDeletionOwner, removeConfirmedRecord,
  validateDeletionMetadata,
} from "../lib/cloud-merge.ts";
import * as retryModule from "../lib/cloud-retry.ts";
import { createClient } from "@supabase/supabase-js";
import { getAccountBalance, getBudgetRemaining, totalIncomeInCurrency, totalExpensesInCurrency } from "../lib/finance.ts";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const base = { reportCurrency: "MYR" };

const localRequire = createRequire(import.meta.url);
// Compile the production TS module as the Electron harness does, without changing
// the app's bundler resolution just for Node's extension-only test loader.
const compiledTransport = localRequire("typescript").transpileModule(readFileSync(new URL("../lib/cloud-transport.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: localRequire("typescript").ModuleKind.CommonJS, target: localRequire("typescript").ScriptTarget.ES2022 },
}).outputText;
const transportModule = { exports: {} };
new Function("require", "module", "exports", compiledTransport)((name) => name === "./cloud-retry" ? retryModule : localRequire(name), transportModule, transportModule.exports);
const { createSnapshotTransport, classifyTransportStatus } = transportModule.exports;
const { createDataProfileRouter } = localRequire("../desktop/data-profiles.cjs");

const { CloudTransportError, createCloudRetryController, emptySyncOutbox, failSyncOutbox, hasPendingSync,
  MAX_SYNC_RETRIES, queueSavedSnapshot, resumeSyncOutbox, validateSyncOutbox } = retryModule;

function retryHarness() {
  const state = { outbox: queueSavedSnapshot(emptySyncOutbox(0), 0), clock: 0, online: true, active: true,
    failure: null, runs: 0, activeRuns: 0, maxConcurrent: 0, events: [], gate: null, acknowledge: true };
  const timers = new Map(); let serial = 0;
  const create = () => createCloudRetryController({
    load: async () => validateSyncOutbox(structuredClone(state.outbox)),
    fail: async (code) => (state.outbox = failSyncOutbox(state.outbox, code, state.clock, 0)),
    resume: async (transientOnly) => (state.outbox = resumeSyncOutbox(state.outbox, transientOnly, state.clock)),
    async run() {
      state.runs++; state.activeRuns++; state.maxConcurrent = Math.max(state.maxConcurrent, state.activeRuns);
      try {
        if (state.gate) await state.gate;
        if (state.failure) throw state.failure;
        if (state.acknowledge) state.outbox = { ...emptySyncOutbox(state.clock), revision: state.outbox.revision, acknowledgedRevision: state.outbox.revision };
        return true;
      } finally { state.activeRuns--; }
    },
    online: () => state.online, active: () => state.active,
    onState: (status, reason) => state.events.push({ status, reason }), now: () => state.clock,
    setTimer(callback, delay) { const id = ++serial; timers.set(id, { callback, at: state.clock + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  async function nextTimer() {
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(next, "Expected a bounded retry timer");
    timers.delete(next[0]); state.clock = next[1].at; next[1].callback(); await settle();
  }
  return { state, timers, create, settle, nextTimer };
}

test("outbox coalesces revisions without financial payloads; corrupt metadata fails closed", () => {
  let row = emptySyncOutbox(0);
  for (let i = 0; i < 100; i++) row = queueSavedSnapshot(row, i);
  assert.equal(row.revision, 100); assert.ok(hasPendingSync(row));
  assert.doesNotMatch(JSON.stringify(row), /snapshot|transactions|accounts|token|password|amount|balance/);
  for (const change of [{ version: 99 }, { revision: -1 }, { acknowledgedRevision: 101 }, { attempts: 99 }, { paused: "unknown" }, { lastError: "private-provider-message" }, { nextAttemptAt: -1 }, { snapshot: "synthetic-forbidden-payload" }]) {
    assert.throws(() => validateSyncOutbox({ ...row, ...change }), /未被重置/);
  }
  const paused = failSyncOutbox(row, "conflict", 100);
  assert.equal(queueSavedSnapshot(paused, 101).paused, "conflict");
});

test("offline changes wait without requests; an online event drains the latest durable revision", async () => {
  const env = retryHarness(), runner = env.create(); env.state.online = false;
  await runner.request("initial");
  for (let i = 0; i < 3; i++) env.state.outbox = queueSavedSnapshot(env.state.outbox, 0);
  await runner.request("change");
  assert.equal(env.state.runs, 0); assert.equal(env.timers.size, 0); assert.equal(env.state.outbox.attempts, 0);
  assert.equal(env.state.events.at(-1).reason, "offline");
  env.state.online = true; await runner.request("online");
  assert.equal(env.state.runs, 1); assert.equal(hasPendingSync(env.state.outbox), false);
  assert.equal(env.state.events.at(-1).status, "ready"); runner.dispose();
});

test("retry deadline and attempt count survive controller disposal/recreation", async () => {
  const env = retryHarness(); env.state.failure = new CloudTransportError("network");
  const first = env.create(); await first.request("initial");
  assert.equal(env.state.outbox.attempts, 1); assert.equal(env.state.outbox.nextAttemptAt, 2000);
  first.dispose(); assert.equal(env.timers.size, 0);
  const restarted = env.create(); await restarted.request("initial");
  assert.equal(env.state.runs, 1); assert.equal(env.timers.size, 1);
  env.state.failure = null; await env.nextTimer();
  assert.equal(env.state.runs, 2); assert.equal(hasPendingSync(env.state.outbox), false); restarted.dispose();
});

test("retry backoff is bounded and cannot be bypassed by focus/change events", async () => {
  const env = retryHarness(), runner = env.create(); env.state.failure = new CloudTransportError("server");
  await runner.request("initial");
  for (let i = 1; i < MAX_SYNC_RETRIES; i++) await env.nextTimer();
  assert.equal(env.state.runs, MAX_SYNC_RETRIES); assert.equal(env.state.outbox.paused, "retry-limit");
  assert.equal(env.timers.size, 0);
  for (let i = 0; i < 20; i++) await runner.request(i % 2 ? "focus" : "change");
  await runner.request("online"); // A network hint must not bypass a server rate-limit budget.
  assert.equal(env.state.runs, MAX_SYNC_RETRIES);
  env.state.failure = null; await runner.request("manual");
  assert.equal(env.state.runs, MAX_SYNC_RETRIES + 1); assert.equal(env.state.outbox.attempts, 0); runner.dispose();
});

for (const code of ["authentication", "permission", "storage", "safety", "conflict"]) {
  test(`${code} pauses persistently; online/focus do not silently resume it`, async () => {
    const env = retryHarness(), runner = env.create();
    env.state.failure = code === "conflict" ? new CloudEditConflictError(1) : new CloudTransportError(code);
    await runner.request("initial"); assert.equal(env.state.outbox.paused, code); assert.equal(env.timers.size, 0);
    env.state.outbox = queueSavedSnapshot(env.state.outbox, 1);
    await runner.request("online"); await runner.request("change"); await runner.request("focus");
    assert.equal(env.state.runs, 1); runner.dispose();
    const restarted = env.create(); await restarted.request("initial"); assert.equal(env.state.runs, 1);
    env.state.failure = null; await restarted.request("manual"); assert.equal(env.state.runs, 2); restarted.dispose();
  });
}

test("duplicate retry triggers serialize; disposing an old account cancels its future retries", async () => {
  const env = retryHarness(), runner = env.create(); let release;
  env.state.gate = new Promise((resolve) => { release = resolve; });
  const first = runner.request("manual"), second = runner.request("remote");
  assert.equal(first, second); await env.settle(); assert.equal(env.state.activeRuns, 1);
  runner.dispose(); env.state.failure = new CloudTransportError("network"); release(); await first; await env.settle();
  assert.equal(env.state.runs, 1); assert.equal(env.state.maxConcurrent, 1); assert.equal(env.state.outbox.attempts, 0);
  assert.equal(env.timers.size, 0); assert.equal(hasPendingSync(env.state.outbox), true);
});

test("unknown exceptions never become network retries or persist private messages", async () => {
  const env = retryHarness(), runner = env.create(); env.state.failure = new Error("Private synthetic balance and bank");
  await runner.request("manual");
  assert.equal(env.state.outbox.paused, "safety"); assert.equal(env.timers.size, 0);
  assert.doesNotMatch(JSON.stringify(env.state.outbox), /Private|balance|bank/); runner.dispose();
});

test("a run that never acknowledges the same revision cannot create an endless success loop", async () => {
  const env = retryHarness(), runner = env.create(); env.state.acknowledge = false;
  await runner.request("initial"); assert.equal(env.timers.size, 1);
  await env.nextTimer();
  assert.equal(env.state.runs, 2); assert.equal(env.state.outbox.paused, "storage"); assert.equal(env.timers.size, 0);
  assert.equal(hasPendingSync(env.state.outbox), true); runner.dispose();
});

test("transport status classification retries only connectivity and temporary server failures", async () => {
  for (const status of [408, 425, 429, 500, 503]) assert.equal(classifyTransportStatus(status), "server");
  assert.equal(classifyTransportStatus(0), "network");
  assert.equal(classifyTransportStatus(401), "authentication"); assert.equal(classifyTransportStatus(403), "permission");
  for (const status of [400, 404, 409]) assert.equal(classifyTransportStatus(status), "safety");
  const { transport } = supabaseStub([
    { status: 401, body: { message: "Private auth response" } },
    { status: 429, body: { message: "Private server response" } },
  ]);
  await assert.rejects(transport.pull(), (error) => error.retryCode === "authentication" && !/Private/.test(error.message));
  await assert.rejects(transport.pull(), (error) => error.retryCode === "server" && !/Private/.test(error.message));
});

test("a hanging SDK request times out, aborts and never logs provider contents", async () => {
  let aborted = false;
  const sb = createClient("https://synthetic-timeout.invalid", "synthetic-public-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (_url, init) => new Promise(() => { init.signal.addEventListener("abort", () => { aborted = true; }); }) },
  });
  const transport = createSnapshotTransport(sb, "synthetic-user", 10);
  await assert.rejects(transport.pull(), (error) => error.retryCode === "network");
  assert.equal(aborted, true);
});

test("desktop capabilities reject stale/wrong profiles and pin each async filesystem root", async () => {
  const root = path.resolve("work", "synthetic-router-only");
  const router = createDataProfileRouter(() => root);
  const a = { key: "cloud:synthetic-A", token: router.register(1, "cloud:synthetic-A") };
  const rootA = router.run(1, { payload: null, __profile: a }, () => router.root());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const inFlight = router.run(1, { payload: "synthetic", __profile: a }, async (payload) => {
    assert.equal(payload, "synthetic"); await gate;
    return router.root();
  });
  const b = { key: "cloud:synthetic-B", token: router.register(1, "cloud:synthetic-B") };
  const rootB = router.run(1, { payload: null, __profile: b }, () => router.root());
  assert.notEqual(rootA, rootB);
  assert.notEqual(rootA, root); assert.notEqual(rootB, root);
  assert.throws(() => router.run(1, { __profile: a }, () => {}), /changed/);
  assert.throws(() => router.run(1, undefined, () => {}), /changed/);
  assert.throws(() => router.run(2, { __profile: b }, () => {}), /not ready/);
  assert.throws(() => router.register(1, "../private"), /Invalid/);
  release(); assert.equal(await inFlight, rootA);
  const bToken = b.token;
  b.token = router.register(1, b.key);
  assert.notEqual(b.token, bToken); // Re-login revokes the previous session's capability.
  router.register(2, "local");
  assert.equal(router.run(2, { payload: 2, __profile: undefined }, (p) => p), 2);
  assert.equal(router.run(2, undefined, () => router.root()), root);
});

test("every private preload method carries a profile capability; diagnostics stay separate", async () => {
  const router = createDataProfileRouter(() => path.resolve("work", "synthetic-preload-only"));
  const requests = [];
  let bridge;
  const ipcRenderer = {
    sendSync: () => "1.7.4",
    invoke: async (channel, payload) => {
      requests.push({ channel, payload });
      if (channel === "desktop:activate-data-profile") return router.register(1, payload);
      if (channel.startsWith("diagnostics:")) return true;
      return router.run(1, payload, (value) => ({ value, root: router.root() }));
    },
  };
  runInNewContext(readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }),
    process: { env: {}, versions: { electron: "synthetic" }, platform: "win32" },
  });
  const profile = { key: "cloud:synthetic-A", token: await bridge.activateDataProfile("cloud:synthetic-A") };
  const calls = [
    ["getDataLocation"], ["getStartupContext"], ["createDataBackup", { snapshot: "synthetic" }],
    ["writeAutosave", { snapshot: "synthetic" }], ["listBackups"], ["readBackup", "test", "backup"],
    ["markStartupReady"], ["openBackupsLocation"], ["selectVault"], ["getVaultConnection"],
    ["disconnectVault"], ["ensureDirectory", "test", false], ["ensureFile", "test.md", false],
    ["readFile", "test.md"], ["writeFile", "test.md", "synthetic"],
  ];
  const main = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  for (const [name, ...args] of calls) {
    const result = await bridge[name](...args, profile);
    assert.ok(result.root.includes("profiles"));
    const request = requests.at(-1);
    assert.equal(request.payload.__profile, profile);
    assert.ok(main.includes(`handlePrivate("${request.channel}"`), `${name} must use the main process boundary`);
  }
  await bridge.reportDiagnostic({ id: "synthetic" });
  assert.equal(Object.hasOwn(requests.at(-1).payload, "__profile"), false);
  await bridge.activateDataProfile("guest");
  await assert.rejects(bridge.readFile("test.md", profile), /changed/);
});

test("stable identity is namespaced and object key order is irrelevant", () => {
  assert.equal(keyOf({ id: "a1", name: "x" }), "id:a1");
  assert.notEqual(keyOf({ id: '"notice"' }), keyOf("notice"));
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

test("array fields union by id without dropping local-only items", async () => {
  const local = { ...base, accounts: [{ id: "a1", name: "本地账户" }] };
  const remote = { ...base, accounts: [{ id: "a2", name: "云端账户" }] };
  const merged = await mergeSnapshots(local, remote);
  assert.deepEqual(
    merged.accounts.map((a) => a.id).sort(),
    ["a1", "a2"],
  );
});

test("unknown ancestry never silently chooses remote for the same ID", async () => {
  const local = { ...base, accounts: [{ id: "a1", name: "旧名字", balance: 100 }] };
  const remote = { ...base, accounts: [{ id: "a1", name: "新名字", balance: 250 }] };
  const before = structuredClone({ local, remote });
  await assert.rejects(mergeSnapshots(local, remote), CloudEditConflictError);
  assert.deepEqual({ local, remote }, before);
});

test("empty remote array without ancestry/markers does not wipe local data", async () => {
  const local = { ...base, transactions: [{ id: "t1" }] };
  const remote = { ...base, transactions: [] };
  const merged = await mergeSnapshots(local, remote);
  assert.equal(merged.transactions.length, 1);
});

test("different schemas and unknown settings conflicts stop without migrations", async () => {
  const local = { ...base, reportCurrency: "MYR", schemaVersion: 8 };
  const remote = { ...base, reportCurrency: "SGD", schemaVersion: 10 };
  await assert.rejects(mergeSnapshots(local, remote), /版本不同/);
  await assert.rejects(mergeSnapshots(base, { reportCurrency: "SGD" }), CloudEditConflictError);
});

test("non-id array (migrationHistory) merges without crashing and dedupes", async () => {
  const local = { ...base, migrationHistory: [{ from: 1, to: 2, appliedAt: "2026-01-01" }] };
  const remote = { ...base, migrationHistory: [{ from: 2, to: 3, appliedAt: "2026-02-01" }] };
  const merged = await mergeSnapshots(local, remote);
  assert.equal(merged.migrationHistory.length, 2);
});

test("string array (migrationNotices) unions without crashing", async () => {
  const local = { ...base, migrationNotices: ["a"] };
  const remote = { ...base, migrationNotices: ["b"] };
  const merged = await mergeSnapshots(local, remote);
  assert.deepEqual([...merged.migrationNotices].sort(), ["a", "b"]);
});

test("merge keeps original item identity order stable (local first)", async () => {
  const out = await mergeSnapshots({ ...base, accounts: [{ id: "x" }, { id: "y" }] }, { ...base, accounts: [{ id: "z" }] });
  assert.deepEqual(out.accounts.map((i) => i.id), ["x", "y", "z"]);
});

function fixture() {
  return {
    ...base, schemaVersion: 10,
    accounts: [{ id: "synthetic-account", name: "Synthetic only", balance: 200, currency: "SGD" }],
    transactions: [{ id: "synthetic-one", amount: 10, note: "Original" }, { id: "synthetic-two", amount: 20 }],
    transfers: [{ id: "synthetic-transfer", amount: 100, rate: 3.48 }],
    fxRates: [{ id: "synthetic-rate", rate: 3.48 }], budgets: [], goals: [], assets: [],
    plannedPayments: [], watchlists: [],
  };
}

test("three-way merge keeps local edit when remote is unchanged", async () => {
  const original = fixture(), local = structuredClone(original);
  local.transactions[0].amount = 12;
  const merged = await mergeSnapshots(local, original, await fingerprintSnapshot(original));
  assert.equal(merged.transactions[0].amount, 12);
});

test("three-way merge accepts remote edit when local is unchanged", async () => {
  const original = fixture(), remote = structuredClone(original);
  remote.transactions[0].amount = 13;
  const merged = await mergeSnapshots(original, remote, await fingerprintSnapshot(original));
  assert.equal(merged.transactions[0].amount, 13);
});

test("independent records merge, including settings with a known ancestor", async () => {
  const original = fixture(), local = structuredClone(original), remote = structuredClone(original);
  local.transactions[0].amount = 12;
  remote.transactions[1].amount = 23;
  remote.reportCurrency = "SGD";
  const merged = await mergeSnapshots(local, remote, await fingerprintSnapshot(original));
  assert.deepEqual(merged.transactions.map((item) => item.amount), [12, 23]);
  assert.equal(merged.reportCurrency, "SGD");
});

test("same record changed on both devices is atomic even for different fields", async () => {
  const original = fixture(), local = structuredClone(original), remote = structuredClone(original);
  local.transactions[0].amount = 12;
  remote.transactions[0].note = "Remote changed note";
  const before = structuredClone({ local, remote, original });
  await assert.rejects(mergeSnapshots(local, remote, await fingerprintSnapshot(original)), (error) => {
    assert.equal(error.conflictCount, 1);
    assert.doesNotMatch(error.message, /Synthetic|synthetic-one|Remote changed note|12/);
    return error instanceof CloudEditConflictError;
  });
  assert.deepEqual({ local, remote, original }, before);
});

test("identical concurrent edits are accepted", async () => {
  const original = fixture(), changed = structuredClone(original);
  changed.transactions[0].amount = 15;
  assert.deepEqual(await mergeSnapshots(changed, structuredClone(changed), await fingerprintSnapshot(original)), changed);
});

test("same-ID transfer and account edits conflict without altering amounts or FX snapshots", async () => {
  for (const field of ["accounts", "transfers", "fxRates"]) {
    const original = fixture(), local = structuredClone(original), remote = structuredClone(original);
    local[field][0].note = "Local edit";
    remote[field][0].note = "Remote edit";
    await assert.rejects(mergeSnapshots(local, remote, await fingerprintSnapshot(original)), CloudEditConflictError);
    assert.equal(original.transfers[0].rate, 3.48);
    assert.equal(original.accounts[0].balance, 200);
  }
});

test("malformed collections and duplicate IDs fail closed", async () => {
  await assert.rejects(mergeSnapshots(fixture(), { ...base, transactions: {} }), /列表格式/);
  await assert.rejects(mergeSnapshots(fixture(), { ...base, accounts: [{ id: "a" }, { id: "a" }] }), /重复记录/);
  await assert.rejects(mergeSnapshots(fixture(), null), /格式不完整/);
});

test("hash metadata contains no raw names, amounts, records, notices, or IDs", async () => {
  const data = { ...fixture(), migrationNotices: ["Private synthetic notice"], migrationHistory: [{ from: 9, to: 10, appliedAt: "2026-01-01" }] };
  const metadata = await fingerprintSnapshot(data);
  const text = JSON.stringify(metadata);
  assert.doesNotMatch(text, /Synthetic only|synthetic-account|Private synthetic notice|2026-01-01|Original|3\.48/);
  assert.deepEqual(parseSyncBaseline(text), JSON.parse(text));
  for (const corrupt of [null, "{broken", "null", '{"version":2,"fields":{}}', '{"version":1,"fields":{"x":{"kind":"value","hash":"invalid"}}}']) {
    assert.equal(parseSyncBaseline(corrupt), null);
  }
});

function fakeServer(initial) {
  let version = 0;
  const server = {
    row: initial ? { data: structuredClone(initial), updatedAt: String(version) } : null,
    writes: 0, pulls: 0, beforeWrite: null, failPull: false, failWrite: false,
    replace(data) { server.row = { data: structuredClone(data), updatedAt: String(++version) }; },
    transport: {
      async pull() {
        server.pulls++;
        if (server.failPull) throw new Error("Synthetic network failure");
        return structuredClone(server.row);
      },
      async compareAndSet(data, expected) {
        await server.beforeWrite?.();
        if (server.failWrite) throw new Error("Synthetic network failure");
        if ((server.row?.updatedAt ?? null) !== (expected?.updatedAt ?? null)) return null;
        server.writes++;
        server.replace(data);
        return structuredClone(server.row);
      },
    },
  };
  return server;
}

async function device(server, initial, ancestor = initial) {
  const state = { local: structuredClone(initial), baseline: ancestor ? await fingerprintSnapshot(ancestor) : null, applies: 0, saves: 0, deletions: emptyDeletionMetadata() };
  state.session = createCloudSyncSession({
    transport: server.transport,
    baseline: state.baseline,
    getLocal: () => state.local,
    async loadDeletions() {
      const journals = await prepareRemovalJournals(state.local);
      return mergeDeletionMetadata(state.deletions, journals.get("synthetic-user") ?? emptyDeletionMetadata());
    },
    async saveDeletions(next) { state.deletions = mergeDeletionMetadata(state.deletions, next); },
    async applyLocal(expected, next) {
      if (!snapshotsEqual(state.local, expected)) return false;
      state.applies++;
      state.local = next;
      return true;
    },
    saveBaseline(next) { state.baseline = next; state.saves++; },
  });
  return state;
}

function confirmedRemoval(data, field, id, owner = "synthetic-user") {
  const release = registerDeletionOwner(owner);
  try { return removeConfirmedRecord(data, field, id); } finally { release(); }
}

test("soft deletion and explicit restoration synchronize without hard-delete markers", async () => {
  const original = fixture(), server = fakeServer(original);
  const a = await device(server, original), b = await device(server, original);
  a.local.transactions[0] = { ...a.local.transactions[0], deleted: true, deletedAt: "2026-10-25T01:00:00Z" };
  await a.session.sync(); await b.session.sync();
  assert.equal(b.local.transactions[0].deleted, true);
  b.local.transactions[0] = { ...b.local.transactions[0], deleted: false, deletedAt: undefined };
  await b.session.sync(); await a.session.sync();
  assert.equal(a.local.transactions[0].deleted, false);
  assert.deepEqual(a.deletions, emptyDeletionMetadata());
});

for (const field of ["accounts", "transactions", "transfers", "fxRates", "goals", "assets", "plannedPayments", "budgets", "categories", "annualPlans", "watchlists"]) {
  test(`confirmed ${field} removal propagates and cannot be resurrected by an unchanged replica`, async () => {
    const original = { ...fixture(), [field]: [{ id: "delete-this", currency: "MYR" }, { id: "keep-this", currency: "SGD" }] };
    const before = structuredClone(original), server = fakeServer(original);
    const a = await device(server, original), b = await device(server, original);
    a.local = confirmedRemoval(a.local, field, "delete-this");
    await a.session.sync(); await b.session.sync();
    assert.deepEqual(a.local[field].map((item) => item.id), ["keep-this"]);
    assert.deepEqual(b.local[field].map((item) => item.id), ["keep-this"]);
    assert.deepEqual(decodeSyncPayload(server.row.data).data[field].map((item) => item.id), ["keep-this"]);
    assert.deepEqual(original, before);
    for (const other of Object.keys(original).filter((key) => key !== field)) assert.deepEqual(b.local[other], original[other]);
    await b.session.sync();
    assert.equal(server.writes, 1);
  });
}

test("missing records without confirmed markers pause instead of reviving or deleting", async () => {
  const original = fixture(), missing = { ...original, transactions: [] };
  const ancestor = await fingerprintSnapshot(original);
  await assert.rejects(mergeSnapshots(missing, original, ancestor), CloudEditConflictError);
  await assert.rejects(mergeSnapshots(original, missing, ancestor), CloudEditConflictError);
  const { transactions: _absent, ...partial } = original;
  assert.deepEqual((await mergeSnapshots(partial, original, ancestor)).transactions, original.transactions);
});

test("a stale device with no ancestor can accept a proven unchanged permanent deletion", async () => {
  const original = fixture(), server = fakeServer(original), a = await device(server, original);
  a.local = confirmedRemoval(a.local, "transactions", "synthetic-one");
  await a.session.sync();
  const c = await device(server, original, null);
  await c.session.sync();
  assert.deepEqual(c.local.transactions.map((item) => item.id), ["synthetic-two"]);
});

test("edit versus permanent delete preserves the edited cloud version and local intent", async () => {
  const original = fixture(), server = fakeServer(original), a = await device(server, original);
  a.local = confirmedRemoval(a.local, "transactions", "synthetic-one");
  const edited = structuredClone(original); edited.transactions[0].amount = 55; server.replace(edited);
  await assert.rejects(a.session.sync(), CloudEditConflictError);
  assert.equal(server.row.data.transactions[0].amount, 55);
  assert.equal(a.local.transactions.some((item) => item.id === "synthetic-one"), false);
  assert.equal((await prepareRemovalJournals(a.local)).size, 1);
  assert.equal(server.writes, 0);
});

test("explicit restore versus permanent deletion is a conflict, not silent data loss", async () => {
  const original = fixture(); original.transactions[0].deleted = true;
  const server = fakeServer(original), a = await device(server, original), b = await device(server, original);
  a.local = confirmedRemoval(a.local, "transactions", "synthetic-one");
  b.local.transactions[0].deleted = false;
  await a.session.sync();
  await assert.rejects(b.session.sync(), CloudEditConflictError);
  assert.equal(b.local.transactions[0].deleted, false);
  assert.equal(decodeSyncPayload(server.row.data).data.transactions.some((item) => item.id === "synthetic-one"), false);
});

test("simultaneous deletions of different records converge without duplicates", async () => {
  const original = fixture(), server = fakeServer(original), a = await device(server, original), b = await device(server, original);
  a.local = confirmedRemoval(a.local, "transactions", "synthetic-one");
  b.local = confirmedRemoval(b.local, "transactions", "synthetic-two");
  await Promise.all([a.session.sync(), b.session.sync()]);
  await Promise.all([a.session.sync(), b.session.sync()]);
  assert.equal(a.local.transactions.length, 0);
  assert.equal(b.local.transactions.length, 0);
  assert.equal(Object.keys(decodeSyncPayload(server.row.data).deletions.tombstones.transactions).length, 2);
});

test("a deletion made during upload is journaled, rebased, then synchronized", async () => {
  const original = fixture(), server = fakeServer(original), a = await device(server, original);
  a.local.transactions[1].amount = 28;
  server.beforeWrite = () => {
    a.local = confirmedRemoval(a.local, "transactions", "synthetic-one");
    server.beforeWrite = null;
  };
  await a.session.sync();
  assert.deepEqual(a.local.transactions.map((item) => item.id), ["synthetic-two"]);
  assert.equal(decodeSyncPayload(server.row.data).data.transactions[0].amount, 28);
  assert.equal(decodeSyncPayload(server.row.data).data.transactions.length, 1);
});

test("batched deletion then another edit retains both confirmed IDs without exposing metadata", async () => {
  const original = fixture();
  const first = confirmedRemoval(original, "transactions", "synthetic-one");
  const edited = inheritRemovalIntents(first, { ...first, reportCurrency: "SGD" });
  const second = confirmedRemoval(edited, "transactions", "synthetic-two");
  const journals = await prepareRemovalJournals(inheritRemovalIntents(edited, second));
  const journal = journals.get("synthetic-user");
  assert.equal(Object.keys(journal.tombstones.transactions).length, 2);
  assert.doesNotMatch(JSON.stringify(journal), /synthetic-one|synthetic-two|Original|amount|note/);
  assert.equal(Object.hasOwn(second, "__wealthAtlasSync"), false);
  assert.equal(second.reportCurrency, "SGD");
  assert.deepEqual(await prepareRemovalJournals(confirmedRemoval(second, "transactions", "missing-id")), journals);
});

test("deletion metadata is validated and never attached to local financial snapshots", async () => {
  const original = fixture(), removed = confirmedRemoval(original, "transactions", "synthetic-one");
  const journal = (await prepareRemovalJournals(removed)).get("synthetic-user");
  const encoded = encodeSyncPayload(removed, journal);
  assert.deepEqual(decodeSyncPayload(encoded).data, removed);
  assert.ok(Object.hasOwn(encoded, "__wealthAtlasSync"));
  for (const invalid of [{ version: 2, tombstones: {} }, { version: 1, tombstones: { migrationBackups: {} } }, { version: 1, tombstones: { transactions: { "raw-id": ["raw-record"] } } }]) {
    assert.throws(() => validateDeletionMetadata(invalid), /删除同步标记/);
    assert.throws(() => decodeSyncPayload({ ...original, __wealthAtlasSync: invalid }), /删除同步标记/);
  }
  assert.throws(() => removeConfirmedRecord(original, "migrationBackups", "readonly"), /没有永久删除规则/);
});

test("unknown owner and cancelled/aborted transitions never create another user's intent", async () => {
  const original = fixture();
  assert.equal((await prepareRemovalJournals(original)).size, 0);
  const removed = confirmedRemoval(original, "transactions", "synthetic-one", "account-A");
  const journal = await prepareRemovalJournals(removed);
  assert.ok(journal.has("account-A")); assert.equal(journal.has("account-B"), false);
  const notCommitted = inheritRemovalIntents(removed, { ...original });
  assert.equal((await prepareRemovalJournals(notCommitted)).size, 0);
});

test("new historical references block account/category/FX removal without cascading", async () => {
  for (const field of ["accounts", "categories", "fxRates"]) {
    const original = { ...fixture(), [field]: [{ id: "reference-target", createdAt: "2026-01-01" }] };
    const removed = confirmedRemoval(original, field, "reference-target");
    const markers = (await prepareRemovalJournals(removed)).get("synthetic-user");
    const remote = structuredClone(original);
    remote.transactions.push({ id: "remote-history", accountId: field === "accounts" ? "reference-target" : "other", categoryId: field === "categories" ? "reference-target" : undefined, fxSnapshot: field === "fxRates" ? { rateId: "reference-target" } : undefined });
    const before = structuredClone(remote);
    await assert.rejects(mergeSnapshots(removed, remote, await fingerprintSnapshot(original), markers), CloudEditConflictError);
    assert.deepEqual(remote, before);
  }
});

test("fresh device and restarted client keep server and local tombstones", async () => {
  const original = fixture(), server = fakeServer(original), a = await device(server, original);
  a.local = confirmedRemoval(a.local, "transactions", "synthetic-one");
  await a.session.sync();
  const fresh = await device(server, { ...base, schemaVersion: 10, transactions: [] }, null);
  await fresh.session.sync();
  assert.deepEqual(fresh.local.transactions.map((item) => item.id), ["synthetic-two"]);
  const ledger = structuredClone(a.deletions);
  server.replace(original); // Simulate an old writer dropping the protocol envelope.
  const restarted = await device(server, a.local, a.local);
  restarted.deletions = ledger;
  await restarted.session.sync();
  assert.deepEqual(restarted.local.transactions.map((item) => item.id), ["synthetic-two"]);
  assert.deepEqual(decodeSyncPayload(server.row.data).data.transactions.map((item) => item.id), ["synthetic-two"]);
});

test("failed incoming journal persistence cannot apply a remote deletion or mark sync ready", async () => {
  const original = fixture(), removed = confirmedRemoval(original, "transactions", "synthetic-one");
  const ledger = (await prepareRemovalJournals(removed)).get("synthetic-user");
  const server = fakeServer(encodeSyncPayload(removed, ledger));
  let applied = 0, saved = 0;
  const session = createCloudSyncSession({
    transport: server.transport, baseline: await fingerprintSnapshot(original), getLocal: () => original,
    async applyLocal() { applied++; return true; }, async saveDeletions() { throw new Error("Synthetic disk failure"); },
    saveBaseline() { saved++; },
  });
  await assert.rejects(session.sync(), /Synthetic disk failure/);
  assert.equal(applied, 0); assert.equal(saved, 0);
  assert.equal(original.transactions.length, 2);
});

test("soft-deleted income, expenses, and transfers still use the original balance/budget rules", async () => {
  const original = { ...fixture(), accounts: [{ id: "sgd", currency: "SGD", balance: 1000 }, { id: "myr", currency: "MYR", balance: 500 }],
    transactions: [{ id: "income", accountId: "sgd", type: "income", amount: 100, currency: "SGD", date: "2026-10-10", category: "Income" }, { id: "expense", accountId: "myr", type: "expense", amount: 50, currency: "MYR", date: "2026-10-10", category: "Food" }],
    transfers: [{ id: "move", fromAccountId: "sgd", toAccountId: "myr", fromAmount: 100, toAmount: 348, fromCurrency: "SGD", toCurrency: "MYR", rate: 3.48, fee: 2, feeCurrency: "SGD", date: "2026-10-10" }],
    budgets: [{ id: "food", month: "2026-10", category: "Food", currency: "MYR", limit: 200 }, { id: "other-currency", month: "2026-10", category: "Food", currency: "SGD", limit: 200 }],
  };
  const deleted = structuredClone(original);
  deleted.transactions.forEach((item) => { item.deleted = true; });
  deleted.transfers[0].deleted = true;
  const merged = await mergeSnapshots(original, deleted, await fingerprintSnapshot(original));
  assert.equal(getAccountBalance(merged, "sgd"), 1000);
  assert.equal(getAccountBalance(merged, "myr"), 500);
  assert.equal(getBudgetRemaining(merged, merged.budgets[0]), 200);
  assert.equal(totalIncomeInCurrency(merged, "SGD"), 0);
  assert.equal(totalExpensesInCurrency(merged, "MYR"), 0);
  const restored = await mergeSnapshots(merged, original, await fingerprintSnapshot(merged));
  assert.equal(getAccountBalance(restored, "sgd"), 998);
  assert.equal(getAccountBalance(restored, "myr"), 798);
  assert.equal(getBudgetRemaining(restored, restored.budgets[0]), 150);
  assert.equal(getBudgetRemaining(restored, restored.budgets[1]), 200);
  assert.deepEqual(restored.transfers[0], original.transfers[0]);
});

test("two devices editing different records survive a real CAS race", async () => {
  const original = fixture(), server = fakeServer(original);
  const a = await device(server, original), b = await device(server, original);
  a.local.transactions[0].amount = 11;
  b.local.transactions[1].amount = 22;
  await Promise.all([a.session.sync(), b.session.sync()]);
  await Promise.all([a.session.sync(), b.session.sync()]);
  assert.deepEqual(server.row.data.transactions.map((item) => item.amount), [11, 22]);
  assert.deepEqual(a.local, server.row.data);
  assert.deepEqual(b.local, server.row.data);
  assert.equal(server.writes, 2);
});

test("CAS loss on the same record pauses instead of overwriting the winner", async () => {
  const original = fixture(), server = fakeServer(original), a = await device(server, original);
  a.local.transactions[0].amount = 11;
  server.beforeWrite = () => {
    const remote = structuredClone(original);
    remote.transactions[0].amount = 99;
    server.replace(remote);
    server.beforeWrite = null;
  };
  await assert.rejects(a.session.sync(), CloudEditConflictError);
  assert.equal(a.local.transactions[0].amount, 11);
  assert.equal(server.row.data.transactions[0].amount, 99);
  assert.equal(server.writes, 0);
  assert.equal(a.applies, 0);
  assert.equal(a.saves, 0);
});

test("changes made while upload is pending survive ACK and get a follow-up sync", async () => {
  const original = fixture(), server = fakeServer(original), a = await device(server, original);
  a.local.transactions[0].amount = 11;
  server.beforeWrite = () => {
    a.local = structuredClone(a.local);
    a.local.transactions[0].amount = 12;
    server.beforeWrite = null;
  };
  await a.session.sync();
  assert.equal(a.local.transactions[0].amount, 12);
  assert.equal(server.row.data.transactions[0].amount, 12);
  assert.equal(server.writes, 2);
});

test("rapid duplicate sync requests share one serialized operation", async () => {
  const original = fixture(), server = fakeServer(original), a = await device(server, original);
  a.local.transactions[0].amount = 12;
  const first = a.session.sync(), second = a.session.sync(), third = a.session.sync();
  assert.equal(first, second);
  assert.equal(first, third);
  await first;
  assert.equal(server.writes, 1);
});

test("competing first uploads use insert then re-pull, not upsert", async () => {
  const server = fakeServer(null);
  const a = await device(server, { ...base, transactions: [{ id: "new-a" }] }, null);
  const b = await device(server, { ...base, transactions: [{ id: "new-b" }] }, null);
  await Promise.all([a.session.sync(), b.session.sync()]);
  assert.deepEqual(server.row.data.transactions.map((item) => item.id).sort(), ["new-a", "new-b"]);
});

test("persisted hash ancestry survives refresh and recognizes an unsent local edit", async () => {
  const original = fixture(), server = fakeServer(original), a = await device(server, original);
  await a.session.sync();
  const localAfterRefresh = structuredClone(a.local);
  localAfterRefresh.transactions[0].amount = 17;
  let local = localAfterRefresh;
  const refreshed = createCloudSyncSession({
    transport: server.transport,
    baseline: parseSyncBaseline(JSON.stringify(a.baseline)),
    getLocal: () => local,
    async applyLocal(_expected, next) { local = next; return true; },
    saveBaseline() {},
  });
  await refreshed.sync();
  assert.equal(server.row.data.transactions[0].amount, 17);
});

test("corrupt/missing metadata causes conservative conflicts rather than remote wins", async () => {
  const original = fixture(), server = fakeServer(original);
  const local = structuredClone(original); local.accounts[0].name = "Synthetic local edit";
  const a = await device(server, local, null);
  await assert.rejects(a.session.sync(), CloudEditConflictError);
  assert.equal(a.local.accounts[0].name, "Synthetic local edit");
  assert.equal(server.writes, 0);
});

test("network failure preserves both data and the previous baseline", async () => {
  for (const stage of ["failPull", "failWrite"]) {
    const original = fixture(), server = fakeServer(original), a = await device(server, original);
    a.local.transactions[0].amount = 16;
    server[stage] = true;
    const before = structuredClone({ local: a.local, baseline: a.baseline, remote: server.row });
    await assert.rejects(a.session.sync(), /Synthetic network/);
    assert.equal(canonicalJson({ local: a.local, baseline: a.baseline, remote: server.row }), canonicalJson(before));
    assert.equal(a.saves, 0);
  }
});

test("disposed session cannot upload or apply a late pull from an old login", async () => {
  const original = fixture(); let resolvePull;
  const a = createCloudSyncSession({
    transport: { pull: () => new Promise((resolve) => { resolvePull = resolve; }), compareAndSet: () => assert.fail("disposed upload") },
    baseline: null, getLocal: () => original,
    applyLocal: () => assert.fail("disposed apply"), saveBaseline: () => assert.fail("disposed metadata write"),
  });
  const promise = a.sync();
  await Promise.resolve(); // The journal read precedes the first network pull.
  a.dispose();
  resolvePull({ data: fixture(), updatedAt: "0" });
  assert.equal(await promise, false);
});

test("continuous competing updates have a bounded retry limit", async () => {
  const original = fixture(), server = fakeServer(original), a = await device(server, original);
  a.local.transactions[0].amount = 15;
  server.beforeWrite = () => server.replace(server.row.data);
  await assert.rejects(a.session.sync(), /连续修改/);
  assert.equal(server.pulls, 3);
  assert.equal(server.writes, 0);
  assert.equal(a.local.transactions[0].amount, 15);
});

test("React apply rejection rebases again without replacing newer queued edits", async () => {
  const original = fixture(), server = fakeServer(original);
  const remote = structuredClone(original); remote.transactions[1].amount = 24; server.replace(remote);
  let local = structuredClone(original), applyAttempts = 0;
  const session = createCloudSyncSession({
    transport: server.transport, baseline: await fingerprintSnapshot(original), getLocal: () => local,
    async applyLocal(expected, next) {
      if (++applyAttempts === 1) {
        local = structuredClone(local); local.transactions[0].amount = 18;
        return false;
      }
      assert.ok(snapshotsEqual(local, expected)); local = next; return true;
    },
    saveBaseline() {},
  });
  await session.sync();
  assert.deepEqual(local.transactions.map((item) => item.amount), [18, 24]);
  assert.deepEqual(server.row.data.transactions.map((item) => item.amount), [18, 24]);
});

test("failed local persistence cannot upload, apply remote data or advance the common ancestor", async () => {
  const original = fixture(), remote = structuredClone(original), server = fakeServer(original);
  remote.transactions[1].amount = 26; server.replace(remote);
  let local = structuredClone(original), saved = 0;
  const session = createCloudSyncSession({
    transport: server.transport, baseline: await fingerprintSnapshot(original), getLocal: () => local,
    async applyLocal(_expected, next) { local = next; return true; },
    confirmLocalPersistence: async () => false,
    saveBaseline() { saved++; },
  });
  await assert.rejects(session.sync(), /本地保存尚未确认/);
  assert.equal(saved, 0);
  assert.equal(server.writes, 0);
  assert.equal(server.pulls, 0);
  assert.equal(local.transactions[1].amount, original.transactions[1].amount);
});

test("an unsaved edit made during a slow pull cannot pass an earlier persistence check", async () => {
  const original = fixture(), server = fakeServer(original);
  let local = structuredClone(original), durable = structuredClone(original), release;
  const gate = new Promise((resolve) => { release = resolve; });
  let pulling = false;
  const session = createCloudSyncSession({
    transport: { ...server.transport, async pull() { pulling = true; await gate; return server.transport.pull(); } },
    baseline: await fingerprintSnapshot(original), getLocal: () => local,
    confirmLocalPersistence: async (expected) => snapshotsEqual(expected, durable),
    async applyLocal(_expected, next) { local = next; durable = structuredClone(next); return true; },
    saveBaseline() {},
  });
  const pending = session.sync();
  while (!pulling) await new Promise((resolve) => setImmediate(resolve));
  local = structuredClone(local); local.transactions[0].amount = 99;
  release(); await assert.rejects(pending, /本地保存尚未确认/);
  assert.equal(server.writes, 0); assert.equal(local.transactions[0].amount, 99);
  durable = structuredClone(local); await session.sync();
  assert.equal(server.row.data.transactions[0].amount, 99);
});

function supabaseStub(responses) {
  const requests = [];
  const sb = createClient("https://synthetic-project.example", "synthetic-public-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, init) => {
      requests.push({ url: new URL(url), method: init.method, body: init.body && JSON.parse(init.body), headers: new Headers(init.headers) });
      const response = responses.shift();
      assert.ok(response, "Unexpected extra cloud request");
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200, headers: { "Content-Type": "application/json" } });
    } },
  });
  return { transport: createSnapshotTransport(sb, "synthetic-user"), requests };
}

test("actual Supabase SDK sends user and revision predicates for PATCH, never upsert", async () => {
  const data = fixture(), updatedAt = "2026-10-25T00:00:00.000000+00:00";
  const { transport, requests } = supabaseStub([
    { body: [{ data, updated_at: updatedAt }] },
    { body: { data, updated_at: "2026-10-25T00:00:01.000000+00:00" } },
  ]);
  const pulled = await transport.pull();
  await transport.compareAndSet(data, pulled);
  assert.equal(requests[0].url.searchParams.get("user_id"), "eq.synthetic-user");
  assert.equal(requests[1].method, "PATCH");
  assert.equal(requests[1].url.searchParams.get("updated_at"), `eq.${updatedAt}`);
  assert.equal(requests[1].url.searchParams.get("user_id"), "eq.synthetic-user");
  assert.equal(requests[1].url.searchParams.has("on_conflict"), false);
  assert.equal(requests[1].url.searchParams.has("data"), false); // No financial snapshot in URL/logs.
  assert.deepEqual(requests[1].body.data, data);
});

test("SDK lost update and duplicate first insert return retry signals", async () => {
  const data = fixture();
  const { transport, requests } = supabaseStub([
    { body: [] },
    { status: 406, body: { code: "PGRST116", details: "The result contains 0 rows", message: "JSON object requested, multiple (or no) rows returned" } },
    { status: 409, body: { code: "23505", message: "Synthetic duplicate" } },
  ]);
  assert.equal(await transport.compareAndSet(data, { data, updatedAt: "2026-10-25T00:00:00Z" }), null);
  assert.equal(await transport.compareAndSet(data, { data, updatedAt: "2026-10-25T00:00:00Z" }), null);
  assert.equal(await transport.compareAndSet(data, null), null);
  assert.equal(requests[2].method, "POST");
  assert.equal(requests[2].body.user_id, "synthetic-user");
  assert.doesNotMatch(requests[2].headers.get("prefer") ?? "", /resolution=merge-duplicates/);
});

test("provider errors are sanitized and invalid cloud revisions fail closed", async () => {
  const { transport } = supabaseStub([
    { status: 403, body: { message: "Private synthetic bank name", details: "Private synthetic balance" } },
    { body: [{ data: fixture(), updated_at: "invalid" }] },
  ]);
  await assert.rejects(transport.pull(), (error) => !/Private synthetic/.test(error.message));
  await assert.rejects(transport.pull(), /版本资料不完整/);
});

test("unchanged server revision and multiple matching rows are not treated as success", async () => {
  const data = fixture(), updatedAt = "2026-10-25T00:00:00Z";
  const { transport } = supabaseStub([
    { body: [{ data, updated_at: updatedAt }] },
    { body: [{ data, updated_at: updatedAt }, { data, updated_at: updatedAt }] },
  ]);
  await assert.rejects(transport.compareAndSet(data, { data, updatedAt }), /版本标记未更新/);
  await assert.rejects(transport.compareAndSet(data, { data, updatedAt }), (error) => error.retryCode === "safety");
});

test("React controller integration in an isolated Electron profile", { timeout: 60000, skip: process.platform !== "win32" ? "Windows Electron integration test" : false }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const electron = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(electron, ["--disable-gpu", path.join(root, "tests", "fixtures", "cloud-sync-hook.cjs")], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Isolated controller test exceeded time limit")); }, 50000);
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { text += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Isolated controller failed: ${text}`));
      else resolve(text);
    });
  });
  assert.match(output, /CLOUD_SYNC_HOOK_PASS/);
});

test("two isolated persistent devices exercise production React sync and SDK transport", { timeout: 120000, skip: process.platform !== "win32" ? "Windows Electron integration test" : false }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(electron, ["--disable-gpu", path.join(root, "tests", "fixtures", "cloud-sync-devices.cjs")], {
      cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Isolated devices exceeded test time limit")); }, 110000);
    child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Isolated devices failed: ${text.slice(-1200)}`)); else resolve(text);
    });
  });
  const result = output.match(/CLOUD_SYNC_DEVICES_PASS (\{[^\n]+\})/);
  assert.ok(result, "Expected explicit two-device acceptance result");
  const report = JSON.parse(result[1]);
  assert.equal(report.realBackendRequests, 0); assert.equal(report.hostedAuthVerified, false);
  assert.equal(report.hostedRealtimeVerified, false); assert.equal(report.independentPersistentSessions, true);
  assert.equal(report.counters.blockedExternalRequests, 0);
  assert.equal(report.checks.length, 14); assert.ok(report.checks.every((check) => check.pass));
});

function loadAuthModule(file, replacements = {}, browser = {}) {
  const ts = localRequire("typescript");
  const compiled = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  runInNewContext(compiled, { module: mod, exports: mod.exports, URLSearchParams, TextEncoder, atob, setTimeout, clearTimeout, crypto: localRequire("node:crypto").webcrypto, ...browser,
    require(name) { if (Object.hasOwn(replacements, name)) return replacements[name];
      if (name === "../desktop/auth-diagnostic-codes.json") return localRequire(name);
      if (name === "./auth-diagnostics") return { reportAuthDiagnostic() {} }; // No desktop/log side effects in isolated units.
      if (name === "./auth-storage") return loadAuthModule("lib/auth-storage.ts", {}, browser);
      // Incumbent boundary tests retain their original automatic-startup setup.
      // Dedicated auto-login cases below exercise the real preference module.
      if (name === "./auto-login") return { readAutoLoginPreference: () => ({ enabled: true, error: null }) };
      if (name === "./password-recovery") return loadAuthModule("lib/password-recovery.ts", {}, browser);
      throw new Error("Unexpected recovery-test dependency"); } });
  return mod.exports;
}

async function deviceLogoutHarness() {
  const user = { id: "55555555-5555-4555-8555-555555555555", email: "synthetic-signout@example.invalid",
    aud: "authenticated", role: "authenticated", created_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {} };
  const devices = new Map(), access = new Map(), refresh = new Map(), scopes = [];
  const preserved = new Map([["mac-workspace", "synthetic-unchanged"], ["windows-workspace", "synthetic-unchanged"], ["email-memory", "synthetic-unchanged"]]);
  const before = JSON.stringify([...preserved]);
  let logoutFails = false, requests = 0, refreshSerial = 0;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  function sessionFor(device) {
    const token = encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600,
      session_id: `synthetic-${device.name}-${++refreshSerial}` }) + ".synthetic-signature";
    const refreshToken = `synthetic-refresh-${device.name}-${refreshSerial}`;
    access.set(token, device); refresh.set(refreshToken, device);
    return { access_token: token, refresh_token: refreshToken, expires_in: 3600, token_type: "bearer", user };
  }
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  async function fetcher(input, init = {}) {
    requests++;
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.equal(url.origin, "https://synthetic-device-logout.invalid", "No real backend is permitted");
    const caller = access.get(new Headers(init.headers).get("authorization")?.replace(/^Bearer /, ""));
    if (url.pathname === "/auth/v1/user" && init.method === "GET") return reply(user);
    if (url.pathname === "/auth/v1/logout" && init.method === "POST") {
      assert.ok(caller); const scope = url.searchParams.get("scope"); scopes.push(scope);
      if (logoutFails) return reply({ code: "unexpected_failure", msg: "SYNTHETIC_PROVIDER_PRIVATE_DETAIL" }, 500);
      for (const device of devices.values()) if (scope === "global" || scope === "local" && caller === device || scope === "others" && caller !== device) device.valid = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token" && init.method === "POST") {
      const device = refresh.get(JSON.parse(init.body).refresh_token);
      return device?.valid ? reply(sessionFor(device)) : reply({ code: "refresh_token_not_found", msg: "Synthetic revoked session" }, 400);
    }
    throw new Error("Unexpected synthetic endpoint; real network is disabled");
  }
  for (const name of ["mac", "windows"]) {
    const values = new Map(), device = { name, valid: true, values }; devices.set(name, device);
    device.client = createClient("https://synthetic-device-logout.invalid", "synthetic-public-only", {
      auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "synthetic-session-" + name,
        storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } } },
      global: { fetch: fetcher },
    });
    const session = sessionFor(device);
    assert.equal((await device.client.auth.setSession(session)).error, null);
  }
  const mac = devices.get("mac").client, windows = devices.get("windows").client;
  const production = loadAuthModule("lib/cloud-sync.ts", { "./supabase-client": { getSupabaseClient: () => mac },
    "./cloud-transport": {}, "./data-profile": {}, "./password-recovery": {}, "./auth-session": {}, "./auth-storage": {}, "./storage": {} });
  return { mac, windows, production, scopes, failLogout: () => { logoutFails = true; },
    assertPreserved: () => assert.equal(JSON.stringify([...preserved]), before),
    close: async () => { for (const device of devices.values()) await device.client.auth.stopAutoRefresh(); },
    requestCount: () => requests };
}

test("control: the actual SDK's default global logout invalidates another device's refresh session", async () => {
  const test = await deviceLogoutHarness();
  try {
    assert.equal((await test.mac.auth.signOut()).error, null);
    assert.deepEqual(test.scopes, ["global"]);
    assert.ok((await test.windows.auth.refreshSession()).error, "Global sign-out must reproduce the cross-device failure");
    test.assertPreserved();
  } finally { await test.close(); }
});

test("auto-login preference and launch gate preserve accounts, recovery and session isolation", { timeout: 20000 }, async () => {
  const { runAutoLoginReview } = localRequire("./fixtures/auto-login-review.cjs");
  const result = await runAutoLoginReview();
  assert.ok(result.checks >= 12);
  assert.equal(result.realNetworkRequests, 0);
  assert.equal(result.financialDataAccessed, false);
});

test("disabled automatic login still resumes a consumed recovery link after a real browser reload without opening finance", { timeout: 45000, skip: process.platform !== "win32" ? "Windows Electron integration test" : false }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), ["--disable-gpu", path.join(root, "tests/fixtures/password-recovery.cjs"), "--manual-recovery"],
      { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated manual recovery reload timed out")); }, 35000);
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", () => { clearTimeout(timer); reject(new Error("Isolated manual recovery browser could not start")); });
    child.on("exit", code => {
      clearTimeout(timer);
      const match = output.match(/MANUAL_RECOVERY_PASS (\{[^\n]+\})/);
      if (code !== 0 || !match) reject(new Error("Isolated manual recovery failed: " + output.slice(-1000)));
      else resolve(JSON.parse(match[1]));
    });
  });
  for (const field of ["manualRecoveryReloadVerified", "originalFinancialDataUnchanged", "noAccountWorkspaceOpened", "noFinancialRequests", "passwordUpdatedOnlyAfterConfirmation"]) assert.equal(result[field], true);
  assert.equal(result.realNetworkRequests, 0);
});

test("production ordinary logout is local: Mac signs out, Windows can refresh, and workspaces remain unchanged", async () => {
  const test = await deviceLogoutHarness();
  try {
    await test.production.signOut();
    assert.deepEqual(test.scopes, ["local"], "An ordinary logout must never revoke other devices");
    assert.equal((await test.mac.auth.getSession()).data.session, null);
    const refreshed = await test.windows.auth.refreshSession();
    assert.equal(refreshed.error, null); assert.ok(refreshed.data.session);
    assert.equal((await test.windows.auth.getUser()).error, null);
    await test.production.signOut(); assert.deepEqual(test.scopes, ["local"], "Repeated sign-out must not expand scope");
    test.assertPreserved();
  } finally { await test.close(); }
});

test("failed local logout reports an error without revoking the other device or exposing provider details", async () => {
  const test = await deviceLogoutHarness();
  try {
    test.failLogout();
    await assert.rejects(test.production.signOut(), (error) => /登出尚未确认/.test(error.message) && !error.message.includes("PRIVATE_DETAIL"));
    assert.deepEqual(test.scopes, ["local"]);
    // The installed SDK deliberately clears the caller's auth cache even when
    // its logout HTTP request fails. Do not resurrect it or fake success.
    assert.equal((await test.mac.auth.getSession()).data.session, null);
    assert.equal((await test.windows.auth.refreshSession()).error, null);
    test.assertPreserved();
  } finally { await test.close(); }
});

function loginMemoryHarness() {
  const values = new Map([["unrelated", "preserve"]]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const memory = loadAuthModule("lib/login-history.ts", {}, { window: { localStorage: storage } });
  return { memory, storage, values };
}

test("login memory validates/deduplicates/caps only emails and never overwrites unreadable preferences", () => {
  const { memory, storage, values } = loginMemoryHarness();
  assert.equal(memory.readLoginHistory(storage).emails.length, 0);
  assert.equal(memory.rememberLoginEmail(" FIRST@example.invalid ", storage), true);
  assert.equal(memory.rememberLoginEmail("first@example.invalid", storage), true);
  assert.equal(memory.readLoginHistory(storage).emails.length, 1);
  for (let index = 0; index < 10; index++) memory.rememberLoginEmail(`test-${index}@example.invalid`, storage);
  const saved = JSON.parse(values.get(memory.LOGIN_HISTORY_KEY));
  assert.deepEqual(Object.keys(saved).sort(), ["emails", "version"]);
  assert.equal(saved.emails.length, 8); assert.equal(saved.emails[0], "test-9@example.invalid");
  assert.equal(memory.forgetLoginEmail("test-9@example.invalid", storage), true);
  assert.equal(memory.readLoginHistory(storage).emails.length, 7);
  assert.equal(memory.readLoginHistory(storage).emails.includes("test-9@example.invalid"), false);
  assert.equal(values.get("unrelated"), "preserve"); assert.equal(values.size, 2);
  for (const raw of ["{broken", JSON.stringify({ version: 2, emails: [] }), JSON.stringify({ version: 1, emails: [123] }),
    JSON.stringify({ version: 1, emails: ["not-an-email"] }), JSON.stringify({ version: 1, emails: [], password: "synthetic" }), "x".repeat(5000)]) {
    values.set(memory.LOGIN_HISTORY_KEY, raw);
    assert.equal(memory.readLoginHistory(storage).emails.length, 0);
    assert.ok(memory.readLoginHistory(storage).error);
    assert.equal(memory.rememberLoginEmail("test@example.invalid", storage), false);
    assert.equal(memory.forgetLoginEmail("test@example.invalid", storage), false);
    assert.equal(values.get(memory.LOGIN_HISTORY_KEY), raw);
  }
});

test("blocked or failed preference storage is nonfatal, preserves old entries and never includes provider details", () => {
  const { memory, storage, values } = loginMemoryHarness();
  memory.rememberLoginEmail("retained@example.invalid", storage);
  const before = values.get(memory.LOGIN_HISTORY_KEY);
  const failed = { getItem: storage.getItem, setItem() { throw new Error("SYNTHETIC_PRIVATE_DETAIL"); } };
  assert.equal(memory.rememberLoginEmail("new@example.invalid", failed), false);
  assert.equal(memory.forgetLoginEmail("retained@example.invalid", failed), false);
  assert.equal(values.get(memory.LOGIN_HISTORY_KEY), before);
  assert.doesNotMatch(memory.getLoginHistoryNotice(), /SYNTHETIC_PRIVATE_DETAIL/);
  const blocked = loadAuthModule("lib/login-history.ts", {}, { window: { get localStorage() { throw new Error("blocked"); } } });
  assert.ok(blocked.readLoginHistory().error);
  assert.equal(blocked.rememberLoginEmail("test@example.invalid"), false);
});

function rememberedAuthHarness() {
  const preferences = loginMemoryHarness();
  const state = { verified: true, activationFails: false, loginFails: false, gate: null, authCalls: 0,
    profile: { kind: "guest", ownerId: null }, preservedWorkspace: { synthetic: "unchanged" } };
  const canonical = { id: "synthetic-history-owner", email: "canonical@example.invalid" };
  const boundary = loadAuthModule("lib/account-boundary.ts", {
    "./cloud-sync": { async signIn() { state.authCalls++; if (state.gate) await state.gate; if (state.loginFails) throw new Error("synthetic failure"); return { ...canonical, email: "unverified@example.invalid" }; },
      signUp: async () => canonical, signOut: async () => {}, getCurrentUser: async () => state.verified ? canonical : null },
    "./supabase-client": {}, "./cloud-merge": { registerDeletionOwner: () => () => {} },
    "./data-profile": { getDataProfile: () => state.profile, makeDataProfile: (kind, ownerId = null) => ({ kind, ownerId }), publishDataProfile: (profile) => { state.profile = profile; } },
    "./storage": { flushWealthWrites: async () => {}, saveExplicitSignOutState: async () => {}, prepareAccountWorkspace: async (scope) => { if (state.activationFails && scope.kind === "cloud") throw new Error("synthetic storage failure"); } },
    "./desktop": { activateDesktopDataProfile: async () => undefined }, "./login-history": preferences.memory,
  });
  return { ...preferences, state, boundary };
}

test("email memory requires opt-in, canonical server verification AND activated workspace; signup is not opt-in", async () => {
  const { boundary, memory, storage, state } = rememberedAuthHarness();
  await boundary.signInAccount("typed@example.invalid", "synthetic-password");
  assert.equal(memory.readLoginHistory(storage).emails.length, 0);
  await boundary.signUpAccount("signup@example.invalid", "synthetic-password");
  assert.equal(memory.readLoginHistory(storage).emails.length, 0);
  await boundary.signInAccount("typed@example.invalid", "synthetic-password", true);
  assert.equal(memory.readLoginHistory(storage).emails.join(","), "canonical@example.invalid");
  assert.equal(state.profile.kind, "cloud");
  const before = state.authCalls;
  memory.readLoginHistory(storage); memory.forgetLoginEmail("canonical@example.invalid", storage);
  assert.equal(state.authCalls, before); assert.equal(state.profile.kind, "cloud");
  assert.equal(state.preservedWorkspace.synthetic, "unchanged");
});

test("failed/stale login or workspace activation never remembers an address", async () => {
  for (const reason of ["loginFails", "activationFails", "verified"]) {
    const { boundary, memory, storage, state } = rememberedAuthHarness();
    state[reason] = reason !== "verified";
    await boundary.signInAccount("typed@example.invalid", "synthetic-password", true);
    assert.equal(memory.readLoginHistory(storage).emails.length, 0);
    assert.equal(state.preservedWorkspace.synthetic, "unchanged");
  }
  const { boundary, memory, storage, state } = rememberedAuthHarness();
  let release; state.gate = new Promise((resolve) => { release = resolve; });
  const first = boundary.signInAccount("typed@example.invalid", "synthetic-password", true);
  await new Promise((resolve) => setImmediate(resolve));
  const signout = boundary.signOutAccount(); release(); await Promise.all([first, signout]);
  assert.equal(memory.readLoginHistory(storage).emails.length, 0); assert.equal(state.profile.kind, "guest");
});

test("failure to save email preferences never converts a successful verified login to failure", async () => {
  const { boundary, storage, state } = rememberedAuthHarness();
  storage.setItem = () => { throw new Error("synthetic unavailable"); };
  await boundary.signInAccount("typed@example.invalid", "synthetic-password", true);
  assert.equal(state.profile.kind, "cloud"); assert.equal(boundary.isAccountVerified(), true);
  assert.equal(boundary.getAccountError(), null);
});

test("production login form selects only emails, confirms local forgetting and retains history after reload", { timeout: 45000, skip: process.platform !== "win32" ? "Windows Electron integration test" : false }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const report = await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), ["--disable-gpu", path.join(root, "tests/fixtures/login-history.cjs")],
      { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Login history UI regression timed out")); }, 35000);
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", () => { clearTimeout(timeout); reject(new Error("Isolated login form could not start")); });
    child.on("exit", (code) => { clearTimeout(timeout); const match = output.match(/LOGIN_HISTORY_PASS (\{[^\n]+\})/);
      if (code || !match) reject(new Error("Isolated login form failed: " + output.slice(-1200))); else resolve(JSON.parse(match[1])); });
  });
  for (const key of ["emptyState", "selectionIsEmailOnly", "optInDefaultOff", "submitPassesOptIn", "cancelAndEscapeKeepMemory", "confirmedRemovalOnly", "signupAndRecoveryPreserved", "refreshPersistence"]) assert.equal(report[key], true);
  assert.equal(report.realNetworkRequests, 0); assert.equal(report.financialDataAccessed, false);
});

function recoveryHarness() {
  const window = { location: { hash: "#type=recovery&access_token=synthetic-access&refresh_token=synthetic-refresh" } };
  const recovery = loadAuthModule("lib/password-recovery.ts", {}, { window });
  recovery.capturePasswordRecoveryIntent();
  window.location.hash = "";
  return { window, recovery };
}

test("recovery intent survives SDK hash cleanup and remounts, but does not authorize a password change", () => {
  const { recovery } = recoveryHarness();
  assert.equal(recovery.isPasswordRecovery(), true); assert.equal(recovery.getPasswordRecoveryOwner(), null);
  let notifications = 0;
  const unsubscribe = recovery.subscribePasswordRecovery(() => notifications++);
  recovery.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
  assert.equal(recovery.getPasswordRecoveryOwner(), "synthetic-owner"); assert.equal(notifications, 1);
  unsubscribe();
  assert.equal(recovery.isPasswordRecovery(), true);
  assert.equal(recovery.isCurrentPasswordRecovery("synthetic-owner", recovery.getPasswordRecoveryEpoch()), true);
  assert.equal(recovery.isCurrentPasswordRecovery("other-owner", recovery.getPasswordRecoveryEpoch()), false);
});

test("sign-out and a different identity invalidate recovery authorization", () => {
  for (const [event, owner] of [["SIGNED_IN", "other-owner"], ["SIGNED_OUT", null], ["TOKEN_REFRESHED", "other-owner"]]) {
    const { recovery } = recoveryHarness();
    recovery.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
    const epoch = recovery.getPasswordRecoveryEpoch();
    recovery.observePasswordRecovery(event, owner);
    assert.equal(recovery.isPasswordRecovery(), false); assert.equal(recovery.getPasswordRecoveryOwner(), null);
    assert.equal(recovery.isCurrentPasswordRecovery("synthetic-owner", epoch), false);
  }
});

test("same-owner refocus and token refresh do not discard a recovery form", () => {
  const { recovery } = recoveryHarness();
  recovery.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
  const epoch = recovery.getPasswordRecoveryEpoch();
  for (const event of ["SIGNED_IN", "TOKEN_REFRESHED", "INITIAL_SESSION"]) recovery.observePasswordRecovery(event, "synthetic-owner");
  assert.equal(recovery.isPasswordRecovery(), true);
  assert.equal(recovery.isCurrentPasswordRecovery("synthetic-owner", epoch), true);
});

function passwordApiHarness() {
  const { window, recovery } = recoveryHarness();
  const state = { gets: 0, puts: 0, fail: null, owner: "synthetic-owner", getGate: null, verificationError: null, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const sb = { auth: {
    async getSession() {
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      return { data: { session: { user: { id: state.owner }, refresh_token: "synthetic-refresh", access_token:
        encode({ alg: "HS256" }) + "." + encode({ sub: state.owner, exp: state.expiresAt }) + ".synthetic" } }, error: null };
    },
    async signInWithPassword() { return { data: { user: { id: state.owner } }, error: null }; },
    async getUser() { state.gets++; if (state.getGate) await state.getGate; return { data: { user: { id: state.owner } }, error: state.verificationError }; },
    async updateUser(attributes) { state.puts++; assert.deepEqual(Object.keys(attributes), ["password"]);
      return { data: { user: { id: state.owner } }, error: state.fail }; },
  } };
  const cloud = loadAuthModule("lib/cloud-sync.ts", { "./supabase-client": { getSupabaseClient: () => sb },
    "./cloud-transport": {}, "./data-profile": {}, "./password-recovery": recovery,
    "./auth-session": loadAuthModule("lib/auth-session.ts"),
    "./auth-storage": {},
    "./storage": { loadVerifiedAuthReceipt: async () => null, saveVerifiedAuthReceipt: async () => {} } }, { window });
  return { recovery, state, cloud };
}

test("password completion uses the verified recovery session without replaying URL tokens", async () => {
  const { recovery, state, cloud } = passwordApiHarness();
  recovery.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
  await cloud.completePasswordReset("synthetic-new-password");
  assert.equal(state.gets, 1); assert.equal(state.puts, 1); assert.equal(recovery.isPasswordRecovery(), false);
});

test("an explicit successful credential login ends the old recovery intent", async () => {
  const { recovery, state, cloud } = passwordApiHarness();
  recovery.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
  await cloud.signIn("synthetic@example.invalid", "synthetic-password");
  assert.equal(recovery.isPasswordRecovery(), false); assert.equal(state.puts, 0);
});

test("a URL marker or normal logged-in session alone cannot submit a password update", async () => {
  const { recovery, state, cloud } = passwordApiHarness();
  await assert.rejects(cloud.completePasswordReset("synthetic"), /恢复会话/);
  recovery.observePasswordRecovery("SIGNED_IN", "synthetic-owner");
  await assert.rejects(cloud.completePasswordReset("synthetic"), /恢复会话/);
  assert.equal(state.gets, 0); assert.equal(state.puts, 0);
});

test("failed password saves retain recovery for retry and never expose provider text", async () => {
  const { recovery, state, cloud } = passwordApiHarness();
  recovery.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
  state.fail = { code: "unexpected_failure", message: "Synthetic private provider detail" };
  await assert.rejects(cloud.completePasswordReset("synthetic-new-password"), (error) => !/private provider/.test(error.message));
  assert.equal(recovery.isPasswordRecovery(), true);
  state.fail = null;
  await cloud.completePasswordReset("synthetic-new-password");
  assert.equal(state.puts, 2); assert.equal(recovery.isPasswordRecovery(), false);
});

test("a recovery identity change during verification stops the password request", async () => {
  const { recovery, state, cloud } = passwordApiHarness();
  recovery.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
  let release;
  state.getGate = new Promise((resolve) => { release = resolve; });
  const pending = cloud.completePasswordReset("synthetic-new-password");
  recovery.observePasswordRecovery("SIGNED_IN", "other-owner"); release();
  await assert.rejects(pending, /恢复会话/); assert.equal(state.puts, 0);
});

test("expired or unverifiable recovery cannot submit a new password", async () => {
  const { recovery, state, cloud } = passwordApiHarness();
  recovery.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
  state.verificationError = { code: "bad_jwt", message: "Synthetic private verification detail" };
  await assert.rejects(cloud.completePasswordReset("synthetic-new-password"), (error) => /恢复会话/.test(error.message) && !/private/.test(error.message));
  assert.equal(state.puts, 0); assert.equal(recovery.isPasswordRecovery(), true);
});

test("password policy failures keep recovery open with safe actionable messages", async () => {
  for (const [code, pattern] of [["same_password", /不能与旧密码相同/], ["weak_password", /安全要求/]]) {
    const { recovery, state, cloud } = passwordApiHarness();
    recovery.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
    state.fail = { code, message: "Synthetic private password policy detail" };
    await assert.rejects(cloud.completePasswordReset("synthetic-new-password"), (error) => pattern.test(error.message) && !/private/.test(error.message));
    assert.equal(recovery.isPasswordRecovery(), true);
  }
});

test("password reset serialization preserves the workspace on failure and coalesces rapid clicks", async () => {
  let calls = 0, workspaceChanges = 0, fail = true, release;
  let gate = new Promise((resolve) => { release = resolve; });
  const boundary = loadAuthModule("lib/account-boundary.ts", {
    "./cloud-sync": { completePasswordReset: async () => { calls++; await gate; if (fail) throw new Error("Synthetic save failure"); } },
    "./supabase-client": {}, "./data-profile": { publishDataProfile: () => workspaceChanges++ },
    "./storage": {}, "./desktop": {}, "./cloud-merge": {},
    "./login-history": {},
  });
  const a = boundary.resetAccountPassword("synthetic-a"), b = boundary.resetAccountPassword("synthetic-b");
  assert.equal(a, b); await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 1);
  release(); await assert.rejects(a, /Synthetic save failure/); assert.equal(workspaceChanges, 0);
  fail = false; gate = Promise.resolve();
  await boundary.resetAccountPassword("synthetic-a"); assert.equal(calls, 2); assert.equal(workspaceChanges, 0);
});

test("real SDK recovery, React remount, failed save and retry in an isolated browser", { timeout: 90000, skip: process.platform !== "win32" ? "Windows Electron integration test" : false }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), ["--disable-gpu", path.join(root, "tests/fixtures/password-recovery.cjs")],
      { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated password recovery test exceeded its time limit")); }, 80000);
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", () => { clearTimeout(timer); reject(new Error("Isolated recovery browser could not start")); });
    child.on("exit", (code) => { clearTimeout(timer); const match = output.match(/PASSWORD_RECOVERY_PASS (\{[^\n]+\})/);
      if (code !== 0 || !match) reject(new Error("Isolated recovery browser failed: " + output.slice(-1000)));
      else resolve(JSON.parse(match[1])); });
  });
  assert.equal(result.realNetworkRequests, 0); assert.equal(result.financialDataUnchanged, true);
  assert.equal(result.recoveryRemountVerified, true); assert.equal(result.failedSaveRetainsForm, true);
  assert.equal(result.newPasswordLoginVerified, true); assert.equal(result.duplicateClicksCoalesced, true);
});

function authSessionFixture(overrides = {}) {
  const now = Math.floor(Date.now() / 1000), encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = { sub: "synthetic-owner", exp: now + 3600, session_id: "synthetic-session",
    amr: [{ method: "recovery", timestamp: now - 1 }], ...overrides };
  return { user: { id: "synthetic-owner" }, refresh_token: "synthetic-refresh",
    access_token: encode({ alg: "HS256" }) + "." + encode(payload) + ".synthetic-signature" };
}

test("offline session fingerprints are bound to exact credentials and reject expired or changed subjects", async () => {
  const auth = loadAuthModule("lib/auth-session.ts"), session = authSessionFixture();
  const binding = await auth.sessionBinding(session);
  assert.match(binding, /^[a-f0-9]{64}$/);
  assert.equal(binding, await auth.sessionBinding(session));
  assert.notEqual(binding, await auth.sessionBinding({ ...session, refresh_token: "synthetic-other" }));
  assert.equal(await auth.sessionBinding(authSessionFixture({ exp: 1 })), null);
  assert.equal(await auth.sessionBinding(authSessionFixture({ sub: "other-owner" })), null);
  assert.equal(await auth.sessionBinding(null), null);
});

test("expired access tokens only unlock their exact previously verified local workspace within the receipt lifetime", async () => {
  const verifiedAt = Date.now(), session = authSessionFixture();
  const online = loadAuthModule("lib/auth-session.ts");
  const receipt = { version: 1, ownerId: session.user.id, binding: await online.sessionBinding(session), verifiedAt };
  let clock = verifiedAt + 3700000;
  const offline = loadAuthModule("lib/auth-session.ts", {}, { Date: class extends Date { static now() { return clock; } } });
  assert.equal(await offline.sessionBinding(session), null, "An expired token never regains online authorization");
  assert.equal(await offline.offlineSessionBinding(session, receipt), receipt.binding);
  for (const bad of [{ ...receipt, binding: "a".repeat(64) }, { ...receipt, ownerId: "other-owner" },
    { ...receipt, verifiedAt: clock + 1 }, { ...receipt, verifiedAt: clock - 86400001 }]) {
    assert.equal(await offline.offlineSessionBinding(session, bad), null);
  }
  assert.equal(await offline.offlineSessionBinding({ ...session, refresh_token: "different-synthetic" }, receipt), null);
  clock = verifiedAt + 86400001;
  assert.equal(await offline.offlineSessionBinding(session, receipt), null);
});

test("offline auth reads the SDK's original key without refreshing, copying or modifying storage", () => {
  const reader = loadAuthModule("lib/auth-storage.ts", {}, { URL });
  const session = authSessionFixture(), keys = [];
  const storage = { getItem(key) { keys.push(key); return JSON.stringify(session); } };
  const read = reader.readStoredAuthSession("https://synthetic-project.supabase.co", storage);
  assert.equal(read.user.id, session.user.id); assert.equal(read.access_token, session.access_token);
  assert.deepEqual(keys, ["sb-synthetic-project-auth-token"]);
  for (const raw of [null, "{invalid", "{}", "[]", JSON.stringify({ ...session, user: null })]) {
    assert.equal(reader.readStoredAuthSession("https://synthetic-project.supabase.co", { getItem: () => raw }), null);
  }
  assert.equal(reader.readStoredAuthSession("https://synthetic-project.supabase.co", { getItem() { throw new Error("blocked"); } }), null);
});

test("explicit auth storage confirms writes and deletes, sanitizes failures and never rolls back concurrent values", () => {
  const auth = loadAuthModule("lib/auth-storage.ts"), codes = [], values = new Map();
  let failure = "", readsFail = false, concurrent = false, removes = 0;
  const privateText = "synthetic-private-provider key=secret token=secret";
  const storage = {
    getItem(key) { if (readsFail) throw new Error(privateText); return values.get(key) ?? null; },
    setItem(key, value) {
      if (failure === "throw-write") throw new Error(privateText + value);
      if (failure !== "drop-write") values.set(key, concurrent ? "newer-synthetic-session" : value);
      if (failure === "readback") readsFail = true;
    },
    removeItem(key) { removes++; if (failure === "throw-remove") throw new Error(privateText); if (failure !== "drop-remove") values.delete(key); if (concurrent) values.set(key, "newer-synthetic-session"); },
  };
  const adapter = auth.createAuthStorage(storage, code => codes.push(code));
  const safeFailure = (operation, code) => assert.throws(operation, error => {
    assert.equal(error.name, "AuthStorageError"); assert.equal(error.code, code);
    assert.equal(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(privateText), false);
    assert.equal(Object.hasOwn(error, "cause"), false); return true;
  });
  assert.equal(adapter.getItem("synthetic-key"), null);
  adapter.setItem("synthetic-key", "synthetic-value"); assert.equal(adapter.getItem("synthetic-key"), "synthetic-value");
  adapter.removeItem("synthetic-key"); assert.equal(values.has("synthetic-key"), false);
  readsFail = true; safeFailure(() => adapter.getItem("synthetic-key"), "AUTH_STORAGE_READ_FAILED"); readsFail = false;
  values.set("synthetic-key", "preserved-old-session");
  failure = "throw-write"; safeFailure(() => adapter.setItem("synthetic-key", "synthetic-value"), "AUTH_STORAGE_WRITE_FAILED");
  assert.equal(values.get("synthetic-key"), "preserved-old-session");
  failure = "drop-write"; safeFailure(() => adapter.setItem("synthetic-key", "synthetic-value"), "AUTH_STORAGE_WRITE_UNCONFIRMED");
  assert.equal(values.get("synthetic-key"), "preserved-old-session");
  failure = "readback"; safeFailure(() => adapter.setItem("synthetic-key", "synthetic-value"), "AUTH_STORAGE_WRITE_FAILED"); readsFail = false;
  failure = "throw-remove"; safeFailure(() => adapter.removeItem("synthetic-key"), "AUTH_STORAGE_REMOVE_FAILED");
  failure = "drop-remove"; safeFailure(() => adapter.removeItem("synthetic-key"), "AUTH_STORAGE_REMOVE_FAILED");
  assert.equal(values.get("synthetic-key"), "synthetic-value");
  failure = ""; concurrent = true;
  const removesBefore = removes;
  safeFailure(() => adapter.setItem("synthetic-key", "old-synthetic-session"), "AUTH_STORAGE_WRITE_UNCONFIRMED");
  assert.equal(values.get("synthetic-key"), "newer-synthetic-session"); assert.equal(removes, removesBefore);
  safeFailure(() => adapter.removeItem("synthetic-key"), "AUTH_STORAGE_REMOVE_FAILED");
  assert.equal(values.get("synthetic-key"), "newer-synthetic-session"); assert.equal(removes, removesBefore + 1);
  const unavailable = auth.createAuthStorage(undefined, () => { throw new Error(privateText); });
  safeFailure(() => unavailable.getItem("synthetic-key"), "AUTH_STORAGE_READ_FAILED");
  const getterFailure = loadAuthModule("lib/auth-storage.ts", {}, { window: { get localStorage() { throw new Error(privateText); } } }).createAuthStorage();
  safeFailure(() => getterFailure.getItem("synthetic-key"), "AUTH_STORAGE_READ_FAILED");
  safeFailure(() => getterFailure.setItem("synthetic-key", "synthetic-value"), "AUTH_STORAGE_WRITE_FAILED");
  safeFailure(() => getterFailure.removeItem("synthetic-key"), "AUTH_STORAGE_REMOVE_FAILED");
  assert.ok(codes.every(code => Object.hasOwn(localRequire("../desktop/auth-diagnostic-codes.json"), code)));
});

test("auth diagnostics accept fixed codes only, deduplicate and never forward supplied details", async () => {
  const sent = [];
  const diagnostics = loadAuthModule("lib/auth-diagnostics.ts", { "./diagnostics": { reportSafeDiagnostic: async (...args) => { sent.push(args); } } });
  diagnostics.reportAuthDiagnostic("OFFLINE_BINDING_MISMATCH");
  diagnostics.reportAuthDiagnostic("OFFLINE_BINDING_MISMATCH");
  diagnostics.reportAuthDiagnostic("private@example.invalid synthetic-secret MYR 123");
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.deepEqual([...sent[0]], ["auth-recovery", "OFFLINE_BINDING_MISMATCH", "info"]);
  const failing = loadAuthModule("lib/auth-diagnostics.ts", { "./diagnostics": { reportSafeDiagnostic: async () => { throw new Error("Synthetic log failure"); } } });
  failing.reportAuthDiagnostic("OFFLINE_CACHE_MISSING"); await Promise.resolve(); await Promise.resolve();
});

test("storage activity diagnostics are candidate-only, enum-only and bounded without hiding repeated remove cycles", async () => {
  const sent = [], candidate = { isDesktop: true, appVersion: "1.7.5-rc.11" };
  const load = bridge => loadAuthModule("lib/auth-diagnostics.ts", {
    "./diagnostics": { reportSafeDiagnostic: async (...args) => { sent.push(args); } },
  }, { window: { wealthAtlasDesktop: bridge } });
  for (const bridge of [undefined, { isDesktop: false, appVersion: "1.7.5-rc.11" }, { isDesktop: true, appVersion: "1.7.4" }]) {
    load(bridge).reportAuthStorageActivity("AUTH_STORAGE_WRITE_CONFIRMED");
  }
  assert.equal(sent.length, 0);
  const reporter = load(candidate);
  reporter.reportAuthStorageActivity("private-key secret@example.invalid MYR 123");
  assert.equal(sent.length, 0);
  for (let i = 0; i < 35; i++) {
    reporter.reportAuthStorageActivity("AUTH_STORAGE_REMOVE_REQUESTED");
    reporter.reportAuthStorageActivity("AUTH_STORAGE_REMOVE_CONFIRMED");
  }
  await Promise.resolve();
  assert.equal(sent.length, 65);
  assert.ok(sent.slice(0, 64).every((args, i) => args[1] === (i % 2 === 0 ? "AUTH_STORAGE_REMOVE_REQUESTED" : "AUTH_STORAGE_REMOVE_CONFIRMED")));
  assert.equal(sent.at(-1)[1], "AUTH_STORAGE_TRACE_LIMIT_REACHED");
  assert.ok(sent.every(args => args.length === 3 && args[0] === "auth-recovery" && args[2] === "info"));
});

test("storage diagnostic creation and bridge failures cannot break the SDK operation", () => {
  for (const bridge of [{ isDesktop: true, appVersion: "1.7.5-rc.11" }, { get isDesktop() { throw new Error("SYNTH_PRIVATE"); } }]) {
    const reporter = loadAuthModule("lib/auth-diagnostics.ts", {
      "./diagnostics": { reportSafeDiagnostic() { throw new Error("SYNTH_PRIVATE"); } },
    }, { window: { wealthAtlasDesktop: bridge } });
    assert.doesNotThrow(() => reporter.reportAuthStorageActivity("AUTH_STORAGE_WRITE_CONFIRMED"));
  }
  const source = readFileSync(new URL("../lib/supabase-client.ts", import.meta.url), "utf8");
  assert.match(source, /createAuthStorage\(undefined, reportAuthDiagnostic, reportAuthStorageActivity\)/);
});

test("offline failure classifications contain enums only and preserve strict binding rules", async () => {
  const reader = loadAuthModule("lib/auth-storage.ts", {}, { URL }), cacheReasons = [];
  reader.readStoredAuthSession("https://synthetic.supabase.co", { getItem: () => null }, reason => cacheReasons.push(reason));
  reader.readStoredAuthSession("https://synthetic.supabase.co", { getItem: () => "invalid-private" }, reason => cacheReasons.push(reason));
  reader.readStoredAuthSession("https://synthetic.supabase.co", { getItem() { throw new Error("private detail"); } }, reason => cacheReasons.push(reason));
  assert.deepEqual(cacheReasons, ["cache-missing", "cache-invalid", "storage-unavailable"]);
  const auth = loadAuthModule("lib/auth-session.ts"), session = authSessionFixture(), proofReasons = [];
  const receipt = { version: 1, ownerId: session.user.id, verifiedAt: Date.now(), binding: "a".repeat(64) };
  assert.equal(await auth.offlineSessionBinding(session, receipt, reason => proofReasons.push(reason)), null);
  assert.deepEqual(proofReasons, ["binding-mismatch"]);
});

test("automatic auth recovery is bounded and disposal cancels its timer without changing data", async () => {
  const auth = loadAuthModule("lib/auth-session.ts");
  const timers = new Map(), diagnostics = [], preserved = { synthetic: "unchanged" };
  let now = 100000, serial = 0, attempts = 0, profile = { kind: "locked" };
  const fakeWindow = { addEventListener() {}, removeEventListener() {} };
  const boundary = loadAuthModule("lib/account-boundary.ts", {
    "./cloud-sync": { subscribeToAuth: () => () => {}, getCurrentUser: async () => { attempts++; throw new auth.AuthVerificationError("transient"); },
      getOfflineUser: async () => null, isRetryableAuthError: auth.isRetryableAuthError },
    "./supabase-client": { isCloudConfigured: () => true },
    "./data-profile": { getDataProfile: () => profile, makeDataProfile: kind => ({ kind }), publishDataProfile: next => { profile = next; } },
    "./storage": { flushWealthWrites: async () => {}, hasVerifiedWorkspaceHistory: async () => true, wasExplicitlySignedOut: async () => false },
    "./desktop": {}, "./cloud-merge": {}, "./login-history": {},
    "./auth-diagnostics": { reportAuthDiagnostic: code => diagnostics.push(code) },
  }, { window: fakeWindow, navigator: { onLine: true }, Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  await boundary.initializeAccountBoundary();
  for (let count = 0; count < 5; count++) {
    assert.equal(timers.size, 1);
    const [id, task] = [...timers][0]; timers.delete(id); now = task.at; task.callback();
    await boundary.retryAccountVerification();
  }
  assert.equal(attempts, 6); assert.equal(timers.size, 0);
  assert.ok(diagnostics.includes("AUTH_RECOVERY_EXHAUSTED"));
  assert.equal(profile.kind, "locked"); assert.deepEqual(preserved, { synthetic: "unchanged" });
  boundary.disposeAccountBoundary(); assert.equal(timers.size, 0);
});

function coldBoundaryHarness({ rotateAtSdkStart = false, sessionMissingAfterFailure = false, serverRejects = false } = {}) {
  const auth = loadAuthModule("lib/auth-session.ts"), order = [], original = { synthetic: "unchanged" };
  let profile = { kind: "locked", key: "locked" }, cached = true, reads = 0, guestCreations = 0;
  const now = Date.now(), localUser = { id: "synthetic-cold-owner", email: undefined,
    localVerification: { verifiedAt: now, validUntil: now + 86400000 } };
  let clock = now;
  const boundary = loadAuthModule("lib/account-boundary.ts", {
    "./cloud-sync": {
      subscribeToAuth: () => { order.push("sdk-start"); if (rotateAtSdkStart) cached = false; return () => {}; },
      getCurrentUser: async () => { reads++; if (sessionMissingAfterFailure && reads > 1) return null; throw new auth.AuthVerificationError(serverRejects ? "invalid" : "transient"); },
      getOfflineUser: async () => { order.push("offline-proof"); return cached && rotateAtSdkStart ? localUser : null; },
      isRetryableAuthError: auth.isRetryableAuthError,
    },
    "./supabase-client": { isCloudConfigured: () => true },
    "./data-profile": { getDataProfile: () => profile, makeDataProfile: (kind, ownerId = null) => ({ kind, ownerId, key: kind === "cloud" ? "cloud:" + ownerId : kind }), publishDataProfile: next => { profile = next; } },
    "./storage": { flushWealthWrites: async () => {}, hasVerifiedWorkspaceHistory: async () => false,
      wasExplicitlySignedOut: async () => false, saveExplicitSignOutState: async () => {},
      prepareAccountWorkspace: async (scope, allowCreate) => { if (scope.kind === "guest") guestCreations++; else assert.equal(allowCreate, false); } },
    "./desktop": { activateDesktopDataProfile: async () => undefined },
    "./cloud-merge": { registerDeletionOwner: () => () => {} }, "./login-history": {},
  }, { window: { addEventListener() {}, removeEventListener() {} }, navigator: { onLine: true }, setTimeout: () => 1, clearTimeout() {},
    Date: class extends Date { static now() { return clock; } } });
  return { boundary, order, original, localUser, profile: () => profile, guests: () => guestCreations, expire: () => { clock = now + 86400001; } };
}

test("cold startup verifies local proof before SDK startup and retains it across a temporary refresh/cache race", async () => {
  const h = coldBoundaryHarness({ rotateAtSdkStart: true });
  try {
    await h.boundary.initializeAccountBoundary();
    assert.equal(h.order[0], "offline-proof", "The SDK must not mutate auth storage before offline proof is checked");
    assert.equal(h.profile().kind, "cloud");
    assert.equal(h.boundary.getAccountUser().id, h.localUser.id);
    assert.equal(h.boundary.isAccountVerified(), false, "A local proof never authorizes uploads");
    assert.equal(h.guests(), 0); assert.deepEqual(h.original, { synthetic: "unchanged" });
  } finally { h.boundary.disposeAccountBoundary(); }
});

test("a pending offline verification cannot become a blank guest when reconnect returns no session", async () => {
  const h = coldBoundaryHarness({ sessionMissingAfterFailure: true });
  try {
    await h.boundary.initializeAccountBoundary();
    assert.equal(h.profile().kind, "locked");
    await h.boundary.retryAccountVerification();
    assert.equal(h.profile().kind, "locked", "Missing session after a failed restore is not an intentional sign-out");
    assert.ok(h.boundary.getAccountError()); assert.equal(h.guests(), 0);
    assert.deepEqual(h.original, { synthetic: "unchanged" });
  } finally { h.boundary.disposeAccountBoundary(); }
});

test("local continuity cannot survive server rejection or extend the existing 24-hour offline grant", async () => {
  for (const serverRejects of [false, true]) {
    const h = coldBoundaryHarness({ rotateAtSdkStart: true, serverRejects });
    try {
      await h.boundary.initializeAccountBoundary();
      if (!serverRejects) { assert.equal(h.profile().kind, "cloud"); h.expire(); await h.boundary.retryAccountVerification(); }
      assert.equal(h.profile().kind, "locked"); assert.equal(h.boundary.getAccountUser(), null);
      assert.equal(h.boundary.isAccountVerified(), false); assert.equal(h.guests(), 0);
      assert.deepEqual(h.original, { synthetic: "unchanged" });
    } finally { h.boundary.disposeAccountBoundary(); }
  }
});

test("verified recovery proof uses recovery AMR, not editable metadata or an old/password session", async () => {
  const auth = loadAuthModule("lib/auth-session.ts");
  assert.match(await auth.verifiedRecoveryKey(authSessionFixture()), /^[a-f0-9]{64}$/);
  assert.equal(await auth.verifiedRecoveryKey(authSessionFixture({ amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }] })), null);
  assert.equal(await auth.verifiedRecoveryKey(authSessionFixture({ amr: [], user_metadata: { recovery: true } })), null);
  assert.equal(await auth.verifiedRecoveryKey(authSessionFixture({ amr: [{ method: "recovery", timestamp: 1 }] })), null);
  assert.equal(await auth.verifiedRecoveryKey(authSessionFixture({ session_id: null })), null);
});

test("stored recovery intent survives a fresh module but cannot authorize a password change", () => {
  const markers = new Map([["unrelated-preference", "preserve"]]);
  const window = { location: { hash: "" }, sessionStorage: {
    getItem: (key) => markers.get(key) ?? null, setItem: (key, value) => markers.set(key, value), removeItem: (key) => markers.delete(key),
  } };
  const first = loadAuthModule("lib/password-recovery.ts", {}, { window });
  first.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
  const marker = JSON.parse(markers.get("wealth-atlas.password-recovery-intent.v1"));
  assert.deepEqual(Object.keys(marker).sort(), ["expiresAt", "version"]);
  const fresh = loadAuthModule("lib/password-recovery.ts", {}, { window }); fresh.capturePasswordRecoveryIntent();
  assert.equal(fresh.isPasswordRecovery(), true); assert.equal(fresh.getPasswordRecoveryOwner(), null);
  fresh.clearPasswordRecovery(); assert.equal(markers.has("wealth-atlas.password-recovery-intent.v1"), false);
  assert.equal(markers.get("unrelated-preference"), "preserve");
});

test("recovery storage failures do not crash the existing verified in-memory flow", () => {
  const unavailable = () => { throw new Error("Synthetic unavailable browser storage"); };
  const window = { location: { hash: "" }, sessionStorage: { getItem: unavailable, setItem: unavailable, removeItem: unavailable } };
  const recovery = loadAuthModule("lib/password-recovery.ts", {}, { window });
  recovery.capturePasswordRecoveryIntent(); recovery.observePasswordRecovery("PASSWORD_RECOVERY", "synthetic-owner");
  assert.equal(recovery.getPasswordRecoveryOwner(), "synthetic-owner"); recovery.clearPasswordRecovery();
  assert.equal(recovery.isPasswordRecovery(), false);
});

test("only temporary auth failures can consider offline receipts", () => {
  const auth = loadAuthModule("lib/auth-session.ts");
  for (const error of [{ name: "AuthRetryableFetchError" }, { status: 0 }, { status: 503 }]) assert.equal(auth.isRetryableAuthError(auth.authVerificationError(error)), true);
  for (const error of [{ status: 401 }, { status: 403 }, { name: "UnknownError" }]) assert.equal(auth.isRetryableAuthError(auth.authVerificationError(error)), false);
  assert.equal(auth.validAuthReceipt({ version: 1, ownerId: "synthetic", binding: "plain-token", verifiedAt: Date.now() }), false);
});

test("real SDK offline startup and recovery restart regression preserves workspaces and rejects forged sessions", { timeout: 30000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "tests/fixtures/auth-startup-review.cjs")], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated auth boundary regression timed out")); }, 25000);
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", () => { clearTimeout(timer); reject(new Error("Isolated auth boundary regression could not start")); });
    child.on("exit", (code) => { clearTimeout(timer); const match = output.match(/AUTH_STARTUP_REVIEW_RESULT (\{[^\n]+\})/);
      if (code !== 0 || !match) reject(new Error("Isolated auth boundary regression failed; private contents suppressed"));
      else resolve(JSON.parse(match[1])); });
  });
  assert.equal(result.findings.every((finding) => finding.reproduced === false), true);
  assert.equal(result.offlineRestart.offline.activeProfile, "cloud");
  assert.equal(result.offlineRestart.offline.originalWorkspaceUnchanged, true);
  assert.equal(result.offlineRestart.afterNetworkEventAndRepeatedInitialization.authErrorStillShown, false);
  assert.equal(result.initialNullNotification.freshOfflineProfile, "cloud");
  assert.equal(result.initialNullNotification.lateNotificationKeptWorkspace, true);
  assert.equal(result.initialNullNotification.originalWorkspaceUnchanged, true);
  assert.equal(result.initialNullNotification.noEmptyGuestCreated, true);
  assert.equal(result.initialNullNotification.automaticReconnectVerified, true);
  assert.equal(result.initialNullNotification.explicitSignOutStillIsolates, true);
  assert.equal(result.recoveryAfterFreshRuntime.recoveryActive, true);
  assert.equal(result.completedRecoveryDoesNotReopen, true);
  assert.equal(result.concurrentRetryCoalesced, true); assert.equal(result.signOutCancelsLateVerification, true);
  assert.equal(result.physicalOfflineSdkDeferred, true); assert.equal(result.missingSessionDidNotCreateGuest, true);
  assert.equal(result.missedOnlineEventRecovered, true); assert.equal(result.externalSignOutStaysLocked, true);
  assert.equal(result.negativeChecks.length, 7); assert.equal(result.negativeChecks.every((check) => check.pass), true);
  assert.equal(result.unmockedFetchAttempts, 0); assert.equal(result.productionProfileAccessed, false);
});

test("real SDK auth storage fails closed without memory fallback and recovers persistent sessions", { timeout: 15000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "tests/fixtures/auth-storage-sdk-review.cjs")], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated auth storage regression timed out")); }, 12000);
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", () => { clearTimeout(timer); reject(new Error("Isolated auth storage regression could not start")); });
    child.on("exit", code => {
      clearTimeout(timer);
      const match = output.match(/AUTH_STORAGE_SDK_RESULT (\{[^\n]+\})/);
      if (code !== 0 || !match) reject(new Error("Isolated auth storage regression failed; private contents suppressed"));
      else resolve(JSON.parse(match[1]));
    });
  });
  assert.equal(result.oldDefaultProbeFailureReproduced, true);
  assert.equal(result.oldOnlineSuccessWasNotPersistent, true);
  assert.equal(result.explicitStorageNeverFellBack, true);
  assert.equal(result.errorsAndDiagnosticsSafe, true);
  assert.equal(result.originalSdkKeyOnly, true);
  assert.equal(result.checks.length, 4); assert.equal(result.checks.every(check => check.pass && check.retryPersisted && check.freshInstanceReadSucceeded), true);
  assert.equal(result.unmockedFetchAttempts, 0);
  assert.equal(result.realFinancialDataAccessed, false); assert.equal(result.productionProfileAccessed, false);
});
