import test from "node:test";
import assert from "node:assert/strict";
import { CURRENT_SCHEMA_VERSION, migrateWealthData, needsWealthDataMigration } from "../lib/migrations.ts";

test("migration repairs missing collections without mutating the source", () => {
  const source = { schemaVersion: 7, reportCurrency: "MYR", accounts: [] };
  const before = structuredClone(source);
  const migrated = migrateWealthData(source);
  assert.deepEqual(source, before);
  assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.ok(Array.isArray(migrated.transactions));
  assert.ok(Array.isArray(migrated.budgets));
  assert.ok(Array.isArray(migrated.goals));
  assert.ok(Array.isArray(migrated.assets));
});

test("migration is idempotent after the repaired snapshot reaches the current schema", () => {
  const first = migrateWealthData({ schemaVersion: 7, reportCurrency: "MYR" });
  const second = migrateWealthData(first);
  assert.equal(needsWealthDataMigration(first), false);
  assert.equal(second.schemaVersion, first.schemaVersion);
  assert.equal(second.migrationBackups?.length, first.migrationBackups?.length);
  assert.equal(second.migrationHistory?.length, first.migrationHistory?.length);
});
