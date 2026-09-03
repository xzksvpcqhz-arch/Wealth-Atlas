import test from "node:test";
import assert from "node:assert/strict";
import { mergeSnapshots, mergeById, keyOf } from "../lib/cloud-merge.ts";

const base = { reportCurrency: "MYR" };

test("keyOf uses id when present, JSON fallback otherwise", () => {
  assert.equal(keyOf({ id: "a1", name: "x" }), "a1");
  assert.equal(keyOf({ assetId: "z" }), JSON.stringify({ assetId: "z" }));
  assert.equal(keyOf("notice"), JSON.stringify("notice"));
});

test("array fields union by id without dropping local-only items", () => {
  const local = { ...base, accounts: [{ id: "a1", name: "本地账户" }] };
  const remote = { ...base, accounts: [{ id: "a2", name: "云端账户" }] };
  const merged = mergeSnapshots(local, remote);
  assert.deepEqual(
    merged.accounts.map((a) => a.id).sort(),
    ["a1", "a2"],
  );
});

test("same id resolves to remote value (remote wins), no duplicate", () => {
  const local = { ...base, accounts: [{ id: "a1", name: "旧名字", balance: 100 }] };
  const remote = { ...base, accounts: [{ id: "a1", name: "新名字", balance: 250 }] };
  const merged = mergeSnapshots(local, remote);
  assert.equal(merged.accounts.length, 1);
  assert.equal(merged.accounts[0].name, "新名字");
  assert.equal(merged.accounts[0].balance, 250);
});

test("empty remote array does not wipe local data", () => {
  const local = { ...base, transactions: [{ id: "t1" }] };
  const remote = { ...base, transactions: [] };
  const merged = mergeSnapshots(local, remote);
  assert.equal(merged.transactions.length, 1);
});

test("scalar fields take remote value", () => {
  const local = { ...base, reportCurrency: "MYR", schemaVersion: 8 };
  const remote = { ...base, reportCurrency: "SGD", schemaVersion: 10 };
  const merged = mergeSnapshots(local, remote);
  assert.equal(merged.reportCurrency, "SGD");
  assert.equal(merged.schemaVersion, 10);
});

test("non-id array (migrationHistory) merges without crashing and dedupes", () => {
  const local = { ...base, migrationHistory: [{ from: 1, to: 2, appliedAt: "2026-01-01" }] };
  const remote = { ...base, migrationHistory: [{ from: 2, to: 3, appliedAt: "2026-02-01" }] };
  const merged = mergeSnapshots(local, remote);
  assert.equal(merged.migrationHistory.length, 2);
});

test("string array (migrationNotices) unions without crashing", () => {
  const local = { ...base, migrationNotices: ["a"] };
  const remote = { ...base, migrationNotices: ["b"] };
  const merged = mergeSnapshots(local, remote);
  assert.deepEqual([...merged.migrationNotices].sort(), ["a", "b"]);
});

test("mergeById keeps original item identity order stable (local first)", () => {
  const out = mergeById(
    [{ id: "x" }, { id: "y" }],
    [{ id: "z" }],
  );
  assert.deepEqual(out.map((i) => i.id), ["x", "y", "z"]);
});
