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
