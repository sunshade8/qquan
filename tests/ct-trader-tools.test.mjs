// Stage 3 trader tools: label_moves, contrast_moves, diagnose_trades, blind grading.
import test from "node:test";
import assert from "node:assert/strict";
import { plantedMarket, plantedContract, MINUTE } from "./helpers/ct-trader-fixture.mjs";
import {
  ctRunLabels, ctLabelMovesReport, ctLabelMovesSchema, ctContrastMoves, ctContrastMovesSchema,
  ctBinomialUpperP, ctGradeBlind,
} from "../lib/ct-trader-tools.ts";
import { ctRoundTripCostPct } from "../lib/ct-engine.ts";

const { bars, planted } = plantedMarket();
const data = { BTCUSDT: bars };
const contract = plantedContract();
const params = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30 });

test("label_moves finds the planted moves as events, with the documented clustering", () => {
  const runs = ctRunLabels(params, data, contract);
  const report = ctLabelMovesReport(params, runs, contract, "label-test-1");
  const plantedInTraining = planted.filter((t) => t + 85 * MINUTE <= contract.trainingToMs).length;
  assert.ok(Math.abs(report.events - plantedInTraining) <= 3, `events ${report.events} vs planted ${plantedInTraining}`);
  assert.ok(report.positiveMoments > report.events * 5, "each move has several positive moments in a row");
  assert.ok(report.baseRatePct > 0 && report.baseRatePct < 20);
  assert.equal(report.eventsPerDay, Number((report.events / 8).toFixed(3)));
  assert.match(report.clusteringRule, /첫 양성 순간/);
  // The cost is the contract's round trip: ~0.2% → target 0.6%.
  assert.ok(Math.abs(ctRoundTripCostPct(contract) - 0.2) < 0.01);
  assert.match(report.definition, /목표 \+0\.59/);
  // The representative moment is the middle of the cluster: inside the contraction/jump window of its move.
  for (const a of report.anchors) {
    const phase = Math.round((a.at - bars[0].startMs) / MINUTE) % 200;
    assert.ok(phase >= 50 && phase <= 80, `anchor phase ${phase}`);
  }
  assert.ok(report.controlAnchors.length > 0 && report.controlAnchors.every((c) => c.group === "control"));
  // Distributions carry events vs base share for the time of day.
  assert.equal(report.distributions.timeOfDay.length, 4);
});

test("label_moves never reads past the training end, and a larger cost multiplier is a bigger target", () => {
  const poisoned = { BTCUSDT: bars.map((b) => (b.startMs >= contract.trainingToMs ? { ...b, open: 1, high: 1e9, low: 1, close: 1e9 } : b)) };
  const a = ctLabelMovesReport(params, ctRunLabels(params, data, contract), contract, "x");
  const b = ctLabelMovesReport(params, ctRunLabels(params, poisoned, contract), contract, "x");
  assert.deepEqual(a, b);
  const doubled = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30, costMultiplier: 2 });
  const d = ctLabelMovesReport(doubled, ctRunLabels(doubled, data, contract), contract, "y");
  assert.match(d.definition, /목표 \+1\.19/);
  assert.ok(d.positiveMoments <= a.positiveMoments);
  // Moments whose look-ahead would cross the training end are dropped, not shortened.
  const runs = ctRunLabels(params, data, contract);
  const run = runs[0];
  for (let i = run.rows.length - 29; i < run.rows.length; i++) assert.equal(run.labels.label[i], -1, `bar ${i}`);
});

test("contrast_moves: matched controls, reproducible by seed, lift where the contraction is, tree checked on a later slice", () => {
  const runs = ctRunLabels(params, data, contract);
  const request = ctContrastMovesSchema.parse({
    labelId: "label-test-1",
    features: [
      { feature: "range_pct", lookback: 10, timeframe: 1 },
      { feature: "return_pct", lookback: 10, timeframe: 1 },
    ],
  });
  const result = ctContrastMoves(request, params, runs, contract);
  const again = ctContrastMoves(request, params, runs, contract);
  assert.deepEqual(result, again, "seeded: the same request gives the same controls");
  const other = ctContrastMoves({ ...request, seed: 99 }, params, runs, contract);
  assert.notDeepEqual(result.features[0].control, other.features[0].control);
  const range = result.features[0];
  // Before the planted jump the 20-bar range is the lowest in the market: the lowest control quintile holds almost all events.
  assert.ok(range.bins[0].lift > 3, `lift ${range.bins[0].lift}`);
  assert.ok(range.positive.quantiles.p50 < range.control.quantiles.p50);
  assert.equal(range.bestBin.bin, "하위 20%");
  assert.equal(result.testedBins, 10);
  assert.equal(result.controls, result.events * 3);
  // The tree grown on the first 2/3 of training days still finds it on the last 1/3.
  assert.ok(result.tree, "tree present");
  const best = result.tree.leaves.find((l) => l.train.lift > 2);
  assert.ok(best, JSON.stringify(result.tree.leaves.map((l) => [l.rule, l.train.lift, l.holdout.lift])));
  assert.ok(best.holdout.lift > 2 && best.holdout.n >= 20, `holdout ${JSON.stringify(best.holdout)}`);
  assert.ok(result.tree.holdoutRows > 0 && result.tree.trainRows > result.tree.holdoutRows);
});

test("contrast_moves uses no information after the training end", () => {
  const poisoned = { BTCUSDT: bars.map((b) => (b.startMs >= contract.trainingToMs ? { ...b, open: 1, high: 1e9, low: 1, close: 1e9, volume: 1e9 } : b)) };
  const request = ctContrastMovesSchema.parse({ labelId: "label-test-2", features: [{ feature: "volume_ratio", lookback: 20, timeframe: 1 }] });
  const clean = ctContrastMoves(request, params, ctRunLabels(params, data, contract), contract);
  const dirty = ctContrastMoves(request, params, ctRunLabels(params, poisoned, contract), contract);
  assert.deepEqual(clean, dirty);
  // Illegal features are refused with the condition schema's own message.
  assert.throws(() => ctContrastMoves({ ...request, features: [{ feature: "vwap_distance_pct", lookback: 20, offset: 0, timeframe: 1 }] }, params, ctRunLabels(params, data, contract), contract), /lookback 2/);
});

test("blind grading: exact one-sided binomial test, balanced set, no duplicate or foreign charts", () => {
  assert.equal(ctBinomialUpperP(10, 10, 0.5), 1 / 1024);
  assert.ok(Math.abs(ctBinomialUpperP(10, 8, 0.5) - 56 / 1024) < 1e-12);
  assert.equal(ctBinomialUpperP(10, 0, 0.5), 1);
  const order = Array.from({ length: 8 }, (_, i) => ({ chart: i + 1, group: i % 2 ? "control" : "positive" }));
  const set = { blindId: "b1", session: 0, order };
  const perfect = order.map((o) => ({ chart: o.chart, call: o.group }));
  const graded = ctGradeBlind(set, perfect);
  assert.equal(graded.correct, 8);
  assert.equal(graded.pValue, Number((1 / 256).toPrecision(3)));
  assert.match(graded.reading, /우연보다/);
  const flipped = ctGradeBlind(set, order.map((o, k) => ({ chart: o.chart, call: k < 4 ? o.group : o.group === "positive" ? "control" : "positive" })));
  assert.equal(flipped.correct, 4);
  assert.match(flipped.reading, /구분되지 않는다/);
  assert.throws(() => ctGradeBlind(set, perfect.slice(1)), /모든 차트/);
  assert.throws(() => ctGradeBlind(set, [...perfect.slice(0, 7), { chart: 1, call: "control" }]), /중복/);
  assert.throws(() => ctGradeBlind(set, [...perfect.slice(0, 7), { chart: 99, call: "control" }]), /없는 차트/);
});

/* ------------------------------------------------------------------ charts */
import { ctChartData, ctRenderChart } from "../lib/ct-chart-image.ts";
import { ctDiagnoseTrades, ctDiagnoseTradesSchema } from "../lib/ct-trader-tools.ts";
import { replayCT } from "../lib/ct-engine.ts";
import { CT_ENGINE } from "../lib/ct-spec.ts";

const at = bars[3 * 1440 + 9 * 60 + 65].endMs;
test("charts: nothing after the anchor is drawn, axes are percent, no dates", async () => {
  const poisoned = bars.map((b) => (b.startMs >= at ? { ...b, open: 1, high: 1e9, low: 1, close: 1e9, volume: 1e9 } : b));
  const clean = ctChartData(bars, at, contract, "BTCUSDT");
  const dirty = ctChartData(poisoned, at, contract, "BTCUSDT");
  assert.deepEqual(clean, dirty, "bars after the anchor cannot change the picture");
  assert.ok(clean.maxEndMs <= at);
  const image = await ctRenderChart(bars, at, contract, "BTCUSDT", 4);
  assert.equal(image.png[0], 0x89, "PNG signature");
  assert.ok(image.png.length > 10_000 && image.png.length < 200_000, `${image.png.length} bytes`);
  const dirtyImage = await ctRenderChart(poisoned, at, contract, "BTCUSDT", 4);
  assert.deepEqual(image.png, dirtyImage.png, "bit-identical picture");
  // Every label is a percent, a clock time, a day offset or a fixed caption: no price level, no date.
  for (const label of image.labels) {
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(label) && !/\b2025\b/.test(label), `date in ${label}`);
    if (/^[+-]?\d/.test(label) && !/^\d[hm] · /.test(label)) assert.match(label, /^([+-]?\d+(\.\d+)?%|\d\d:\d\d)$/, label);
  }
  assert.ok(image.labels.some((l) => /%$/.test(l)));
  // The anchor must be a bar that closes then, inside training.
  assert.throws(() => ctChartData(bars, at + 30_000, contract, "BTCUSDT"), /마감하는/);
  assert.throws(() => ctChartData(bars, contract.trainingToMs + MINUTE, contract, "BTCUSDT"), /학습 구간/);
});

/* --------------------------------------------------------------- diagnose */
test("diagnose_trades: strata, entry-vs-exit, counterfactual exits equal the replay's own exit function", () => {
  const spec = {
    version: 1, engine: CT_ENGINE, name: "planted", market: "crypto", symbols: ["BTCUSDT"], minutes: 1,
    stages: [{ label: "contraction", maxGapBars: 1, conditions: [{ feature: "range_pct", lookback: 10, offset: 0, timeframe: 1, op: "lte", value: 0.05 }] }],
    entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
    exit: { stopPct: 0.5, targetPct: 1.5, maxHoldBars: 40, invalidation: "stop" },
    sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: 30, participationPct: 1 },
    sourceIds: ["q"], assumptions: ["planted fixture rule"],
  };
  const result = replayCT(spec, data, contract, contract.fromMs, contract.trainingToMs, "h");
  assert.ok(result.trades.length >= 20, `${result.trades.length} trades`);
  const diagnosis = ctDiagnoseTrades(spec, result, data, contract, { exitModes: true });
  assert.equal(diagnosis.trades, result.trades.length);
  assert.equal(diagnosis.strata.timeOfDay.reduce((s, r) => s + r.trades, 0), diagnosis.trades);
  assert.equal(diagnosis.strata.exitReason.reduce((s, r) => s + r.trades, 0), diagnosis.trades);
  const e = diagnosis.entryVsExit;
  assert.equal(e.losers + e.winners <= e.trades, true);
  assert.ok(typeof e.verdict === "string" && e.verdict.length > 5);
  // The "parent" counterfactual is the rule's own exit through ctOpenPosition + ctExitStep: it must match the replay trade by trade.
  const parent = diagnosis.exitCounterfactual.find((m) => m.mode === "parent");
  const wins = result.trades.filter((t) => t.pnl > 0).length;
  assert.equal(parent.trades, result.trades.length);
  assert.ok(Math.abs(parent.winRatePct - (wins / result.trades.length) * 100) < 1.5, `${parent.winRatePct} vs ${(wins / result.trades.length) * 100}`);
  const replayMean = result.trades.reduce((s, t) => s + (t.pnl / (t.entry * t.quantity)) * 100, 0) / result.trades.length;
  assert.ok(Math.abs(parent.meanNetPct - replayMean) < 0.02, `${parent.meanNetPct} vs ${replayMean}`);
  assert.equal(diagnosis.exitCounterfactual.length, 5);
  assert.throws(() => ctDiagnoseTradesSchema.parse({ screenId: "abcdefgh", candidateId: "x" }), /하나만/);
  assert.throws(() => ctDiagnoseTradesSchema.parse({}), /하나만/);
  // Training bars only.
  const poisoned = { BTCUSDT: bars.map((b) => (b.startMs >= contract.trainingToMs ? { ...b, open: 1, high: 1e9, low: 1, close: 1e9 } : b)) };
  assert.deepEqual(ctDiagnoseTrades(spec, result, poisoned, contract, { exitModes: true }), diagnosis);
});
