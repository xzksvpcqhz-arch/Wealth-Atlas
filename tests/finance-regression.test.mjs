import test from "node:test";
import assert from "node:assert/strict";
import { getRate, getRateAtDate } from "../lib/finance.ts";

function rate(id, baseCurrency, quoteCurrency, value, effectiveDate = "2026-08-01", active = true) {
  return {
    id,
    baseCurrency,
    quoteCurrency,
    rate: value,
    effectiveDate,
    enteredAt: effectiveDate + "T00:00:00.000Z",
    source: "Synthetic test",
    active,
  };
}

test("missing FX paths return null instead of recursing", () => {
  assert.equal(getRate([], "SGD", "USD"), null);
  assert.equal(getRateAtDate([], "USD", "MYR", "2026-08-14"), null);
});

test("direct, reverse and chained manual FX paths remain correct", () => {
  const rates = [
    rate("sgd-myr", "SGD", "MYR", 3.48),
    rate("usd-sgd", "USD", "SGD", 1.34),
  ];
  assert.equal(getRate(rates, "SGD", "MYR"), 3.48);
  assert.equal(getRate(rates, "MYR", "SGD"), 1 / 3.48);
  assert.equal(getRate(rates, "USD", "MYR"), 1.34 * 3.48);
});

test("historical rate lookup ignores future records and does not mutate input", () => {
  const rates = [
    rate("old", "SGD", "MYR", 3.4, "2026-07-01"),
    rate("future", "SGD", "MYR", 3.6, "2026-09-01"),
  ];
  const before = structuredClone(rates);
  assert.equal(getRateAtDate(rates, "SGD", "MYR", "2026-08-14"), 3.4);
  assert.deepEqual(rates, before);
});
