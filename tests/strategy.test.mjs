import assert from "node:assert/strict";
import test from "node:test";
import { describeSpec, normalizeSpec, presetConditions, runStrategyBacktest, signalSeries } from "../lib/strategy.ts";

function bars(closes, start = "2024-01-01") {
  const rows = [];
  const date = new Date(`${start}T00:00:00Z`);
  for (const close of closes) {
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
    rows.push({ date: date.toISOString().slice(0, 10), open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000 });
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return rows;
}

const baseSpec = {
  name: "trend", hypothesis: { thesis: "t", mechanism: "m", prediction: "p", falsification: "f" }, universe: ["AAA"], benchmark: "SPY",
  entry: [{ left: { kind: "close" }, op: ">", right: { kind: "sma", period: 5 } }], exit: [{ left: { kind: "close" }, op: "<", right: { kind: "sma", period: 5 } }],
  holding: {}, sizing: { mode: "equal_weight" }, costBps: 0, period: { from: "2024-01-15", to: "2025-12-31" }, successCriteria: { minTrades: 1 },
};

test("normalizeSpec rejects specs without a top-down hypothesis", () => {
  const { spec, errors } = normalizeSpec({ name: "x", universe: ["AAA"], entry: baseSpec.entry }, "2026-09-03");
  assert.equal(spec, null);
  assert.ok(errors.some((item) => item.includes("thesis")));
  const ok = normalizeSpec({ ...baseSpec, preset: undefined }, "2026-09-03");
  assert.ok(ok.spec);
  assert.equal(ok.spec.period.to, "2025-12-31");
});

test("presets translate into conditions and describe cleanly", () => {
  const preset = presetConditions("rsi_reversal", { period: 14, entry: 30, exit: 55 });
  assert.equal(preset.entry[0].left.kind, "rsi");
  const spec = normalizeSpec({ ...baseSpec, ...preset }, "2026-09-03").spec;
  assert.match(describeSpec(spec).entry, /RSI\(14\) < 30/);
});

test("signals follow the rule and trades execute on the next close", () => {
  const closes = Array.from({ length: 80 }, (_, index) => index < 40 ? 100 - index * 0.5 : 80 + (index - 40) * 1.5);
  const rows = bars(closes);
  const { signals } = signalSeries(rows, baseSpec);
  assert.equal(signals[10], false);
  assert.equal(signals.at(-1), true);
  const result = runStrategyBacktest(baseSpec, { AAA: rows }, null);
  assert.ok(result);
  assert.ok(result.metrics.trades >= 1);
  assert.ok(result.equityCurve.at(-1).strategy > 100);
  assert.equal(result.equityCurve[0].date >= "2024-01-15", true);
  assert.ok(["pass", "fail", "inconclusive"].includes(result.verdict.status));
  assert.equal(result.robustness.perturbations.length, 3);
});

test("stop loss closes a position and records the reason", () => {
  const closes = [...Array.from({ length: 10 }, (_, index) => 100 + index), ...Array.from({ length: 10 }, (_, index) => 109 - index * 3), ...Array.from({ length: 25 }, () => 80)];
  const rows = bars(closes);
  const spec = { ...baseSpec, entry: [{ left: { kind: "close" }, op: ">", right: { kind: "value", value: 0 } }], exit: [], holding: { stopLossPct: 5 }, period: { from: rows[1].date, to: rows.at(-1).date } };
  const result = runStrategyBacktest(spec, { AAA: rows }, null);
  assert.ok(result);
  assert.ok(result.trades.some((trade) => trade.reason === "손절"));
});

test("the stop is measured from the fill price, not the signal close", () => {
  // The signal fires on bar 1 (close 100) but the fill is bar 2's close (110).
  // Bar 3 closes back at 100: that is -9.1% against the fill and only 0% against
  // the signal close, so a 5% stop must fire here.
  const rows = bars([100, 100, 110, 100, 100, 100, 100, 100, 100, 100]);
  const spec = { ...baseSpec, entry: [{ left: { kind: "close" }, op: ">", right: { kind: "value", value: 0 } }], exit: [], holding: { stopLossPct: 5 }, period: { from: rows[1].date, to: rows.at(-1).date } };
  const { reasons } = signalSeries(rows, spec);
  assert.equal(reasons[3], "손절");
});

test("gap and range read the same values the screener tests, so a finding can become a rule", () => {
  const rows = [
    { date: "2024-01-02", open: 100, high: 102, low: 98, close: 100, volume: 1000 },
    { date: "2024-01-03", open: 102, high: 108, low: 100, close: 105, volume: 1000 }, // +2% gap, 7.84% range
    { date: "2024-01-04", open: 105, high: 106, low: 104, close: 106, volume: 1000 },
  ];
  const gapSpec = { ...baseSpec, entry: [{ left: { kind: "gap" }, op: ">", right: { kind: "value", value: 1.5 } }], exit: [], holding: {}, period: { from: "2024-01-02", to: "2024-01-04" } };
  const { signals } = signalSeries(rows, gapSpec);
  assert.equal(signals[0], false); // no previous close to gap against
  assert.equal(signals[1], true); // 102 / 100 - 1 = +2%
  const rangeSpec = { ...gapSpec, entry: [{ left: { kind: "range" }, op: ">", right: { kind: "value", value: 5 } }] };
  assert.equal(signalSeries(rows, rangeSpec).signals[1], true); // (108 - 100) / 102 = 7.8%
  assert.equal(signalSeries(rows, rangeSpec).signals[2], true); // still holding, no exit rule
});

test("normalizeSpec accepts gap and range operands", () => {
  const { spec, errors } = normalizeSpec({ ...baseSpec, entry: [{ left: { kind: "gap" }, op: ">", right: { kind: "value", value: 1 } }], exit: [{ left: { kind: "range" }, op: "<", right: { kind: "value", value: 1 } }] }, "2026-09-03");
  assert.deepEqual(errors, []);
  assert.equal(spec.entry[0].left.kind, "gap");
  assert.match(describeSpec(spec).entry, /당일 시가 갭/);
});
