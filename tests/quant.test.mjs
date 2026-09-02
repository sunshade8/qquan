import assert from "node:assert/strict";
import test from "node:test";
import { backtestStrategy, bollinger, correlation, eventStudy, macd, maxDrawdown, rsi, sma, summaryStats, trailingReturns } from "../lib/quant.ts";

function bars(closes, start = "2025-01-01") {
  const rows = [];
  const date = new Date(`${start}T00:00:00Z`);
  for (const close of closes) {
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
    rows.push({ date: date.toISOString().slice(0, 10), open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000 });
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return rows;
}

test("sma and bollinger warm up correctly", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const band = bollinger([1, 2, 3, 4, 5, 6], 3, 2);
  assert.equal(band.middle[5], 5);
  assert.ok(band.upper[5] > 5 && band.lower[5] < 5);
});

test("rsi is 100 for a monotonic rise and macd histogram exists once warmed", () => {
  const closes = Array.from({ length: 40 }, (_, index) => 100 + index);
  const values = rsi(closes, 14);
  assert.equal(values[13], null);
  assert.equal(values[39], 100);
  const series = macd(closes);
  assert.equal(series.histogram[10], null);
  assert.ok(typeof series.histogram[39] === "number");
});

test("max drawdown and correlation are computed from closes", () => {
  assert.equal(Number(maxDrawdown([100, 120, 90, 110]).toFixed(2)), -25);
  assert.equal(correlation([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.equal(correlation([1, 2, 3, 4], [4, 3, 2, 1]), -1);
});

test("event study finds condition days and forward returns", () => {
  const rows = bars([100, 95, 96, 97, 98, 99, 100, 90, 92, 94, 96, 98]);
  const study = eventStudy(rows, "return1d", "lt", -4, 3);
  assert.equal(study.occurrences, 2);
  assert.equal(study.events[0].date, rows[7].date);
  assert.equal(study.events[0].forwardReturnPct, Number((((96 / 90) - 1) * 100).toFixed(3)));
});

test("buy and hold backtest matches the benchmark before costs", () => {
  const rows = bars(Array.from({ length: 60 }, (_, index) => 100 * (1 + index * 0.005)));
  const result = backtestStrategy(rows, "buy_and_hold", {}, 0);
  assert.ok(result);
  assert.equal(result.metrics.totalReturnPct, result.metrics.benchmarkReturnPct);
  assert.equal(result.metrics.exposurePct, 100);
});

test("sma cross strategy stays in cash until the fast average crosses the slow one", () => {
  const rows = bars(Array.from({ length: 120 }, (_, index) => index < 60 ? 100 - index * 0.5 : 70 + (index - 60) * 1.2));
  const result = backtestStrategy(rows, "sma_cross", { fast: 5, slow: 20 }, 5);
  assert.ok(result);
  assert.ok(result.metrics.exposurePct < 100);
  assert.ok(result.trades.length >= 1);
  assert.ok(result.equityCurve.at(-1).strategy > 100);
});

test("summary stats and trailing returns are populated", () => {
  const rows = bars(Array.from({ length: 300 }, (_, index) => 50 + Math.sin(index / 9) * 5 + index * 0.1));
  const stats = summaryStats(rows);
  assert.equal(stats.sessions, 300);
  assert.ok(stats.returnPct > 0);
  assert.ok(stats.maxDrawdownPct <= 0);
  const trailing = trailingReturns(rows);
  assert.ok(typeof trailing["1M"] === "number");
  assert.ok(typeof trailing["1Y"] === "number");
});
