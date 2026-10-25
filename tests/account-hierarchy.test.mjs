import assert from "node:assert/strict";
import test from "node:test";

import {
  getAccountDescendantIds,
  getAccountRootId,
  getAccountCurrencyGroups,
  getAvailableMainAccounts,
  validateAccountParent,
} from "../lib/account-hierarchy.ts";

const accounts = [
  { id: "sgd-main", name: "SGD Main", type: "bank", currency: "SGD", balance: 100, parentAccountId: null, status: "active" },
  { id: "myr-main", name: "MYR Main", type: "cash", currency: "MYR", balance: 200, status: "active" },
  { id: "usd-main", name: "USD Main", type: "investment", currency: "USD", balance: 300, status: "active" },
  { id: "sgd-child", name: "SGD Child", type: "bank", currency: "SGD", balance: 50, parentAccountId: "sgd-main", status: "active" },
  { id: "nested-child", name: "Nested Child", type: "cash", currency: "MYR", balance: 25, parentAccountId: "sgd-child", status: "active" },
  { id: "inactive-main", name: "Inactive", type: "bank", currency: "MYR", balance: 0, status: "inactive" },
  { id: "deleted-main", name: "Deleted", type: "bank", currency: "MYR", balance: 0, status: "deleted" },
];

test("main account candidates include every active top-level currency and exclude children", () => {
  assert.deepEqual(
    getAvailableMainAccounts(accounts).map((account) => account.id),
    ["sgd-main", "myr-main", "usd-main"],
  );
});

test("editing excludes the account and all descendants from main account candidates", () => {
  const ids = getAvailableMainAccounts(accounts, "sgd-main").map((account) => account.id);
  assert.deepEqual(ids, ["myr-main", "usd-main"]);
  assert.deepEqual([...getAccountDescendantIds(accounts, "sgd-main")].sort(), ["nested-child", "sgd-child"]);
});

test("parent validation prevents self, descendant, inactive and nested parent assignments", () => {
  assert.equal(validateAccountParent(accounts, "sgd-main", "sgd-main").valid, false);
  assert.equal(validateAccountParent(accounts, "sgd-main", "sgd-child").valid, false);
  assert.equal(validateAccountParent(accounts, "myr-main", "inactive-main").valid, false);
  assert.equal(validateAccountParent(accounts, null, "sgd-child").valid, false);
  assert.equal(validateAccountParent(accounts, null, "usd-main").valid, true);
  assert.equal(validateAccountParent(accounts, null, null).valid, true);
});

test("root resolution keeps child organization separate from account balances", () => {
  assert.equal(getAccountRootId(accounts, "nested-child"), "sgd-main");
  assert.equal(accounts.find((account) => account.id === "sgd-main").balance, 100);
  assert.equal(accounts.find((account) => account.id === "sgd-child").balance, 50);
});

test("currency columns render every active account once without mutating financial records", () => {
  const before = structuredClone(accounts);
  const groups = ["MYR", "SGD", "USD"].flatMap((currency) => getAccountCurrencyGroups(accounts, currency));
  const rendered = groups.flatMap(({ root, children }) => [root, ...children]);
  assert.deepEqual(rendered.map(({ id }) => id).sort(), accounts.filter(({ status }) => status === "active").map(({ id }) => id).sort());
  assert.equal(new Set(rendered.map(({ id }) => id)).size, rendered.length);
  for (const { root, children } of groups) assert.ok(children.every((child) => child.currency === root.currency));
  assert.equal(getAccountCurrencyGroups(accounts, "MYR").some(({ root }) => root.id === "nested-child"), true);
  assert.deepEqual(accounts, before);
});

test("cross-currency children, missing parents and legacy cycles remain visible", () => {
  const cases = [
    { id: "usd-parent", currency: "USD", parentAccountId: null },
    { id: "myr-child", currency: "MYR", parentAccountId: "usd-parent" },
    { id: "myr-grandchild", currency: "MYR", parentAccountId: "myr-child" },
    { id: "sgd-orphan", currency: "SGD", parentAccountId: "missing" },
    { id: "cycle-a", currency: "SGD", parentAccountId: "cycle-b" },
    { id: "cycle-b", currency: "SGD", parentAccountId: "cycle-a" },
    { id: "inactive-child", currency: "MYR", parentAccountId: "usd-parent", status: "inactive" },
  ];
  const groups = ["MYR", "SGD", "USD"].flatMap((currency) => getAccountCurrencyGroups(cases, currency));
  assert.deepEqual(groups.flatMap(({ root, children }) => [root.id, ...children.map(({ id }) => id)]).sort(), cases.filter(({ status }) => status !== "inactive").map(({ id }) => id).sort());
  assert.deepEqual(getAccountCurrencyGroups(cases, "MYR")[0].children.map(({ id }) => id), ["myr-grandchild"]);
  assert.deepEqual(getAccountCurrencyGroups([], "USD"), []);
});
