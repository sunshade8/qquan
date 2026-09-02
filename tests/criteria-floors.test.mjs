import assert from "node:assert/strict";
import test from "node:test";
import { applyCriteriaFloors, CRITERIA_FLOORS, normalizeSpec } from "../lib/strategy.ts";

const today = "2026-09-03";

function spec(overrides = {}) {
  return {
    name: "테스트 전략",
    hypothesis: { thesis: "논제", mechanism: "메커니즘", prediction: "예측", falsification: "반증 조건" },
    universe: ["SPY"],
    entry: [{ left: { kind: "close" }, op: ">", right: { kind: "sma", period: 200 } }],
    exit: [{ left: { kind: "close" }, op: "<", right: { kind: "sma", period: 200 } }],
    ...overrides,
  };
}

test("an author cannot set a passing grade below the system floor", () => {
  const { criteria, adjustments } = applyCriteriaFloors({ minSharpe: 0.05, minExcessCagrPct: -20, minTrades: 1 });
  assert.equal(criteria.minSharpe, CRITERIA_FLOORS.minSharpe);
  assert.equal(criteria.minExcessCagrPct, CRITERIA_FLOORS.minExcessCagrPct);
  assert.equal(criteria.minTrades, CRITERIA_FLOORS.minTrades);
  assert.equal(adjustments.length, 3);
  assert.ok(adjustments.every((note) => note.startsWith("통과 기준 조정:")));
});

test("an author can still make the bar harder than the floor", () => {
  const { criteria, adjustments } = applyCriteriaFloors({ minSharpe: 1.5, minTrades: 50, maxDrawdownPct: 15 });
  assert.equal(criteria.minSharpe, 1.5);
  assert.equal(criteria.minTrades, 50);
  assert.equal(criteria.maxDrawdownPct, 15);
  assert.deepEqual(adjustments, []);
});

test("omitting a criterion no longer removes the check", () => {
  const { criteria } = applyCriteriaFloors({});
  assert.equal(criteria.minSharpe, CRITERIA_FLOORS.minSharpe);
  assert.equal(criteria.minExcessCagrPct, CRITERIA_FLOORS.minExcessCagrPct);
  assert.equal(criteria.minTrades, CRITERIA_FLOORS.minTrades);
  // Drawdown used to be checked only when supplied, so leaving it out silently
  // dropped a check and made the failure ratio easier to survive.
  assert.equal(criteria.maxDrawdownPct, CRITERIA_FLOORS.maxDrawdownPct);
});

test("a loose drawdown cap is tightened and a sign convention is normalised", () => {
  const loose = applyCriteriaFloors({ maxDrawdownPct: 90 });
  assert.equal(loose.criteria.maxDrawdownPct, CRITERIA_FLOORS.maxDrawdownPct);
  assert.equal(loose.adjustments.length, 1);
  const negative = applyCriteriaFloors({ maxDrawdownPct: -12 });
  assert.equal(negative.criteria.maxDrawdownPct, 12);
  assert.deepEqual(negative.adjustments, []);
});

test("win rate stays optional so trend-following rules are not rejected by default", () => {
  const { criteria } = applyCriteriaFloors({});
  assert.equal(criteria.minWinRatePct, undefined);
  const supplied = applyCriteriaFloors({ minWinRatePct: 55 });
  assert.equal(supplied.criteria.minWinRatePct, 55);
});

test("normalizeSpec floors the criteria a model proposed and records the clamp in notes", () => {
  const { spec: normalized, errors } = normalizeSpec(spec({ successCriteria: { minSharpe: 0.01, minTrades: 2 } }), today);
  assert.deepEqual(errors, []);
  assert.equal(normalized.successCriteria.minSharpe, CRITERIA_FLOORS.minSharpe);
  assert.equal(normalized.successCriteria.minTrades, CRITERIA_FLOORS.minTrades);
  assert.equal(normalized.successCriteria.maxDrawdownPct, CRITERIA_FLOORS.maxDrawdownPct);
  assert.equal(normalized.notes.filter((note) => note.startsWith("통과 기준 조정:")).length, 2);
});

test("normalizeSpec keeps the check count stable whether or not criteria were supplied", () => {
  const bare = normalizeSpec(spec(), today).spec;
  const gamed = normalizeSpec(spec({ successCriteria: { minSharpe: 0.01 } }), today).spec;
  const keys = (value) => Object.keys(value.successCriteria).sort();
  assert.deepEqual(keys(bare), keys(gamed));
});
