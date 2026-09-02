import assert from "node:assert/strict";
import test from "node:test";
import { metricValue, pooledConditionalStudy, screenUniverse, sweepConditions } from "../lib/screener.ts";
import { resolveUniverse, universeById } from "../lib/universe.ts";

function bars(closes, { volume = 1_000_000, start = "2026-01-01" } = {}) {
  const day = new Date(`${start}T00:00:00Z`);
  return closes.map((close, index) => {
    const date = new Date(day.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    return { date, open: close, high: close * 1.01, low: close * 0.99, close, volume };
  });
}

function ramp(count, from, step) {
  return Array.from({ length: count }, (_, index) => from + index * step);
}

test("metricValue reads the lookback return at the latest bar", () => {
  const rows = bars([100, 101, 102, 103, 110]);
  assert.equal(metricValue(rows, "return", 4), 10);
  assert.equal(metricValue(rows, "close"), 110);
});

test("metricValue returns null instead of guessing when history is shorter than the period", () => {
  const rows = bars([100, 101, 102]);
  assert.equal(metricValue(rows, "return", 60), null);
  assert.equal(metricValue(rows, "volatility", 60), null);
  assert.equal(metricValue(rows, "sma_distance", 200), null);
});

test("metricValue computes distance from the moving average", () => {
  const rows = bars([10, 10, 10, 10, 20]);
  // SMA(5) over the last five closes is 12; 20 is +66.667% above it.
  assert.equal(metricValue(rows, "sma_distance", 5), 66.667);
});

test("screenUniverse ranks by the requested metric and honours direction", () => {
  const candidates = [
    { symbol: "AAA", name: "AAA", rows: bars(ramp(30, 100, 1)) },
    { symbol: "BBB", name: "BBB", rows: bars(ramp(30, 100, 3)) },
    { symbol: "CCC", name: "CCC", rows: bars(ramp(30, 100, 2)) },
  ];
  const desc = screenUniverse(candidates, { metric: "return", period: 20, direction: "desc" }, [], 10);
  assert.deepEqual(desc.rows.map((row) => row.symbol), ["BBB", "CCC", "AAA"]);
  const asc = screenUniverse(candidates, { metric: "return", period: 20, direction: "asc" }, [], 10);
  assert.deepEqual(asc.rows.map((row) => row.symbol), ["AAA", "CCC", "BBB"]);
});

test("screenUniverse excludes short histories with a reason rather than ranking them last", () => {
  const candidates = [
    { symbol: "LONG", name: "LONG", rows: bars(ramp(40, 100, 1)) },
    { symbol: "SHORT", name: "SHORT", rows: bars(ramp(10, 100, 1)) },
  ];
  const result = screenUniverse(candidates, { metric: "return", period: 30, direction: "desc" }, [], 10);
  assert.deepEqual(result.rows.map((row) => row.symbol), ["LONG"]);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0].symbol, "SHORT");
  assert.match(result.excluded[0].reason, /거래일이 부족/);
});

test("screenUniverse drops candidates that fail a filter and reports which one", () => {
  const candidates = [
    { symbol: "FAST", name: "FAST", rows: bars(ramp(40, 100, 4)) },
    { symbol: "SLOW", name: "SLOW", rows: bars(ramp(40, 100, 0.1)) },
  ];
  const result = screenUniverse(candidates, { metric: "return", period: 30, direction: "desc" }, [{ metric: "return", period: 30, op: "gt", value: 50 }], 10);
  assert.deepEqual(result.rows.map((row) => row.symbol), ["FAST"]);
  assert.match(result.excluded[0].reason, /필터 미충족/);
});

test("pooledConditionalStudy pools samples across symbols and compares to the baseline", () => {
  // Every symbol drops hard then rebounds, so a deep-drawdown day is followed by strength.
  const shape = [...ramp(30, 100, 1), ...ramp(10, 129, -4), ...ramp(20, 89, 2)];
  const candidates = ["AAA", "BBB", "CCC"].map((symbol) => ({ symbol, name: symbol, rows: bars(shape) }));
  const study = pooledConditionalStudy(candidates, { metric: "drawdown", op: "lt", value: -15 }, 5, "낙폭 < -15%");
  assert.equal(study.symbolsScanned, 3);
  assert.equal(study.symbolsWithSamples, 3);
  assert.ok(study.conditional.samples > 0);
  assert.ok(study.baseline.samples > study.conditional.samples);
  assert.ok(study.conditional.averagePct > study.baseline.averagePct);
  assert.equal(study.edge.averageDiffPct, Number((study.conditional.averagePct - study.baseline.averagePct).toFixed(3)));
});

test("pooledConditionalStudy reports zero samples instead of inventing an edge", () => {
  const candidates = [{ symbol: "AAA", name: "AAA", rows: bars(ramp(60, 100, 1)) }];
  const study = pooledConditionalStudy(candidates, { metric: "drawdown", op: "lt", value: -50 }, 5, "낙폭 < -50%");
  assert.equal(study.conditional.samples, 0);
  assert.equal(study.conditional.averagePct, null);
  assert.equal(study.edge.tStat, null);
});

test("resolveUniverse prefers explicit symbols and caps the fan-out", () => {
  const explicit = resolveUniverse({ symbols: ["aapl", "msft", "aapl"] }, 40);
  assert.deepEqual(explicit.symbols, ["AAPL", "MSFT"]);
  const capped = resolveUniverse({ universe: "nasdaq_tech" }, 5);
  assert.equal(capped.symbols.length, 5);
  assert.match(capped.note, /상위 5개/);
});

test("resolveUniverse falls back to a default and says so when the id is unknown", () => {
  const fallback = resolveUniverse({ universe: "does_not_exist" }, 40);
  assert.equal(fallback.symbols.length, universeById("megacap").symbols.length);
  assert.match(fallback.note, /인식하지 못해/);
});

test("sweepConditions fills every threshold x horizon cell and reuses one baseline per horizon", () => {
  const shape = [...ramp(40, 100, 1), ...ramp(12, 139, -3), ...ramp(40, 103, 1.5)];
  const candidates = ["AAA", "BBB"].map((symbol) => ({ symbol, name: symbol, rows: bars(shape) }));
  const sweep = sweepConditions(candidates, "drawdown", "lt", [-5, -10, -15], [1, 5, 10]);
  assert.equal(sweep.cells.length, 9);
  assert.deepEqual(sweep.thresholds, [-15, -10, -5]);
  assert.deepEqual(sweep.horizons, [1, 5, 10]);
  // Every cell at one horizon compares against the same unconditional baseline.
  const atFive = sweep.cells.filter((cell) => cell.horizon === 5);
  assert.equal(new Set(atFive.map((cell) => cell.baselineAvgPct)).size, 1);
  assert.equal(sweep.symbolsScanned, 2);
});

test("sweepConditions widens the sample as the threshold gets less extreme", () => {
  const shape = [...ramp(40, 100, 1), ...ramp(12, 139, -3), ...ramp(40, 103, 1.5)];
  const candidates = [{ symbol: "AAA", name: "AAA", rows: bars(shape) }];
  const sweep = sweepConditions(candidates, "drawdown", "lt", [-5, -15], [5]);
  const loose = sweep.cells.find((cell) => cell.threshold === -5);
  const tight = sweep.cells.find((cell) => cell.threshold === -15);
  assert.ok(loose.samples >= tight.samples);
});

test("sweepConditions reports sign consistency and leaves empty cells at zero samples", () => {
  const candidates = [{ symbol: "AAA", name: "AAA", rows: bars(ramp(80, 100, 1)) }];
  const sweep = sweepConditions(candidates, "drawdown", "lt", [-40, -50], [5]);
  assert.equal(sweep.cells.every((cell) => cell.samples === 0), true);
  assert.equal(sweep.robustness.cellsWithSamples, 0);
  assert.equal(sweep.robustness.medianEdgePct, null);
  assert.equal(sweep.robustness.signConsistent, false);
});

test("sweepConditions cannot judge monotonicity from fewer than three thresholds", () => {
  const shape = [...ramp(40, 100, 1), ...ramp(12, 139, -3), ...ramp(40, 103, 1.5)];
  const candidates = [{ symbol: "AAA", name: "AAA", rows: bars(shape) }];
  assert.equal(sweepConditions(candidates, "drawdown", "lt", [-5, -10], [5]).robustness.strengthensWithExtremity, null);
});
