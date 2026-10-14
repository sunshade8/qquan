// Stage 4: contrast_moves control groups (time / vol_matched / losers), lift shapes, ledger identity, training boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { plantedMarket, plantedContract } from "./helpers/ct-trader-fixture.mjs";
import { plantedVolMarket, volContract } from "./helpers/ct-vol-fixture.mjs";
import {
  ctRunLabels, ctLabelMovesReport, ctLabelMovesSchema, ctContrastMoves, ctContrastMovesSchema, ctContrastMovesSchemaStage3,
  ctContrastSignatures, ctFeatureCondition, ctLiftShape, ctLoserEvents, ctControlSets, ctVolatilityColumn, ctVolatilityEdges, ctRng, ctFeatureColumns,
} from "../lib/ct-trader-tools.ts";
import { MOVE_REASON } from "../lib/ct-moves.ts";
import { ctDate } from "../lib/ct-engine.ts";
import { ctConditionSchema } from "../lib/ct-spec.ts";

const sha = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

test("time mode is the stage-3 control byte for byte (golden hashes recorded before the change)", () => {
  const { bars } = plantedMarket();
  const data = { BTCUSDT: bars };
  const contract = plantedContract();
  const params = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30 });
  const runs = ctRunLabels(params, data, contract);
  const request = ctContrastMovesSchemaStage3.parse({ labelId: "label-test-1", features: [{ feature: "range_pct", lookback: 10, timeframe: 1 }, { feature: "return_pct", lookback: 10, timeframe: 1 }] });
  // Without `controls` (a traderTools = 1 request) nothing about the output changed.
  assert.equal(sha(ctLabelMovesReport(params, runs, contract, "label-test-1")), "db8feb4cc16c8538dadfcbbf6e8af1773ee4a1de0ae25d29c9892386ff894a61");
  assert.equal(sha(ctContrastMoves(request, params, runs, contract)), "529a02cc5e6836b2f9d941b5e7a49b5979a4ad357e5b0b686d46cda9f2bc9e27");
  assert.equal(sha(ctContrastMoves({ ...request, tree: false, seed: 5 }, params, runs, contract)), "e5688eb695c31377239bc2852f7e2b57683649320119a3ec8ee8d91196ad3097");
  assert.equal(sha(ctContrastSignatures(request, params, request.features.map(ctFeatureCondition))), "3b6a1d9fb9d01e6400ecca34404489e4926eca87c3fe654957ea00d0da83143a");
  assert.ok(!("controlMode" in ctContrastMoves(request, params, runs, contract)));
  // A stage-4 request with controls "time" computes the same numbers; only the labelling keys are added.
  const v2 = ctContrastMoves(ctContrastMovesSchema.parse({ ...request }), params, runs, contract);
  assert.equal(v2.controlMode, "time");
  assert.equal(v2.droppedEvents, 0);
  const { controlMode, droppedEvents, positiveEvents, controlsPerEvent, shapeRule, ...rest } = v2;
  void controlMode; void droppedEvents; void positiveEvents; void controlsPerEvent; void shapeRule;
  const legacy = ctContrastMoves(request, params, runs, contract);
  assert.deepEqual({ ...rest, features: rest.features.map(({ shape, ...f }) => (void shape, f)) }, legacy);
  assert.ok(v2.features.every((f) => ["monotone_up", "monotone_down", "two_tailed", "flat"].includes(f.shape)));
  // A stage-3 request cannot name a control group.
  assert.throws(() => ctContrastMovesSchemaStage3.parse({ ...request, controls: "losers" }), /Unrecognized|controls/);
});

test("lift shape classification: tails need lift ≥ 1.25 and z ≥ 2 (the rule printed with the result)", () => {
  const bin = (lift, z) => ({ lift, z });
  const flat = bin(1, 0);
  assert.equal(ctLiftShape([bin(1.8, 4), flat, flat, flat, bin(1.7, 3.5)]), "two_tailed");
  assert.equal(ctLiftShape([bin(0.5, -3), flat, flat, bin(1.1, 1), bin(2.1, 5)]), "monotone_up");
  assert.equal(ctLiftShape([bin(2.4, 6), bin(1.2, 1.5), flat, bin(0.8, -1), bin(0.4, -4)]), "monotone_down");
  assert.equal(ctLiftShape([bin(1.2, 3), flat, flat, flat, bin(1.5, 1.4)]), "flat", "lift 1.2 is below the 1.25 bar; z 1.4 below 2");
  assert.equal(ctLiftShape([bin(1.3, 1.9), flat, bin(2, 6), flat, bin(1.2, 1)]), "flat", "a middle-only excess is not a tail shape");
  assert.equal(ctLiftShape([bin(null, 0), flat, flat, flat, bin(null, 0)]), "flat");
});

test("the volatility column is the DSL's 60-minute ATR(14) as percent of the last completed hourly close", () => {
  const { bars } = plantedVolMarket({ days: 6 });
  const contract = volContract({ days: 6, trainingDays: 4 });
  const params = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30 });
  const [run] = ctRunLabels(params, { BTCUSDT: bars }, contract);
  const vol = ctVolatilityColumn(run, contract);
  const cond = ctConditionSchema.parse({ feature: "atr_pct", lookback: 14, offset: 0, timeframe: 60, op: "gte", value: 0 });
  // Mid-hour minutes carry the value of the last hourly bar that closed; check a spread of minutes against the DSL feature itself.
  const picks = [];
  for (let i = 2000; i < run.rows.length - 1; i += 777) picks.push(i);
  const direct = ctFeatureColumns([cond], run.rows, picks, contract, run.symbol)[0];
  picks.forEach((i, k) => assert.ok(Math.abs(vol[i] - direct[k]) < 1e-5 || (Number.isNaN(vol[i]) && Number.isNaN(direct[k])), `minute ${i}: ${vol[i]} vs ${direct[k]}`));
  assert.ok(Number.isNaN(vol[10]), "no 15 contiguous hourly bars yet at the start");
  assert.equal(ctVolatilityEdges(run, vol).length, 4);
});

test("vol_matched controls share the event's hour, month and volatility quintile; losers are stop-first events clustered like events", () => {
  const { bars } = plantedVolMarket({ dip: true });
  const contract = volContract();
  const params = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30 });
  const runs = ctRunLabels(params, { BTCUSDT: bars }, contract);
  const [run] = runs;
  const vol = ctVolatilityColumn(run, contract);
  const edges = ctVolatilityEdges(run, vol);
  const quint = (i) => edges.filter((e) => vol[i] > e).length;
  const hour = (i) => Math.floor((run.rows[i].endMs - run.day.startMs[i]) / 3_600_000);
  const month = (i) => ctDate(run.rows[i].endMs, "crypto", "UTC").slice(0, 7);
  for (const mode of ["vol_matched", "losers"]) {
    const [set] = ctControlSets(runs, mode, contract, ctRng(3));
    assert.ok(set.groups.length > 20, `${mode}: ${set.groups.length} kept events`);
    assert.equal(set.events.length + set.dropped, Math.min(run.events.length, 4000));
    for (const g of set.groups) {
      assert.ok(g.controls.length >= 1 && g.controls.length <= 3);
      for (const c of g.controls) {
        assert.equal(hour(c), hour(g.event));
        assert.equal(month(c), month(g.event));
        assert.equal(quint(c), quint(g.event), `${mode}: control ${c} quintile`);
        assert.ok(run.labels.label[c] >= 0, "a valid training moment");
        if (mode === "losers") {
          assert.equal(run.labels.label[c], 0);
          assert.equal(run.labels.reason[c], MOVE_REASON.stop, "stop hit before the target");
        }
      }
      assert.equal(new Set(g.controls).size, g.controls.length, "drawn without replacement");
    }
    if (mode === "vol_matched") assert.ok(set.groups.every((g) => g.controls.length === 3), "three per event or the event is dropped");
  }
  // Loser events: same clustering and representative-moment rule as positives (scan in time order, cluster through the first moment's exit, median moment).
  const losers = ctLoserEvents(run);
  assert.ok(losers.length > 20);
  assert.ok(losers.every((i) => run.labels.label[i] === 0));
  const stops = [];
  for (let i = 0; i < run.rows.length; i++) if (run.labels.label[i] === 0 && run.labels.reason[i] === MOVE_REASON.stop) stops.push(i);
  assert.ok(losers.length < stops.length, "stop moments that run together are one event");
  // Positive event representatives are untouched by the new modes.
  assert.ok(run.events.length > 20);
});

test("synthetic markets: volatility alone looks two-tailed to the time control and flat once volatility is matched; the losers control finds a planted direction", () => {
  const contract = volContract();
  const wide = ctLabelMovesSchema.parse({ k: 3, m: 5, horizon: 30 });
  const tight = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30 });
  const features = [{ feature: "return_pct", lookback: 120, timeframe: 1 }, { feature: "return_pct", lookback: 30, timeframe: 1 }];
  const run = (market, params, controls) =>
    ctContrastMoves(ctContrastMovesSchema.parse({ labelId: "label-abc-123", controls, tree: false, features }), params, ctRunLabels(params, { BTCUSDT: market.bars }, contract), contract);
  // Volatility only: jumps at random times on wild days, nothing in the past price predicts them.
  const volOnly = plantedVolMarket({ dip: false });
  const time = run(volOnly, wide, "time");
  assert.deepEqual(time.features.map((f) => f.shape), ["two_tailed", "two_tailed"], JSON.stringify(time.features.map((f) => f.bins.map((b) => [b.lift, b.z]))));
  const matched = run(volOnly, wide, "vol_matched");
  assert.deepEqual(matched.features.map((f) => f.shape), ["flat", "flat"]);
  const losers = run(volOnly, tight, "losers");
  assert.deepEqual(losers.features.map((f) => f.shape), ["flat", "flat"], "same hour and volatility, up versus down: no direction information");
  // A planted direction (a dip before each up-jump, a rally before each down-jump).
  const dipped = plantedVolMarket({ dip: true });
  const vm = run(dipped, wide, "vol_matched");
  const lo = run(dipped, tight, "losers");
  for (const r of [vm, lo]) assert.ok(r.features.every((f) => f.shape === "monotone_down"), `${r.controlMode}: ${r.features.map((f) => f.shape)}`);
  assert.equal(lo.controlMode, "losers");
  assert.ok(lo.controlsPerEvent >= 1 && lo.controlsPerEvent <= 3);
  assert.ok(lo.droppedEvents >= 0 && lo.positiveEvents + lo.droppedEvents > 0);
  assert.match(lo.controlRule, /손절이 목표보다 먼저/);
  assert.match(vm.controlRule, /변동성 5분위/);
});

test("the tree separates events from the chosen controls and is re-measured on the later third", () => {
  const contract = volContract();
  const params = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30 });
  const market = plantedVolMarket({ dip: true });
  const runs = ctRunLabels(params, { BTCUSDT: market.bars }, contract);
  const request = ctContrastMovesSchema.parse({ labelId: "label-abc-123", controls: "losers", features: [{ feature: "return_pct", lookback: 30, timeframe: 1 }, { feature: "range_pct", lookback: 120, timeframe: 1 }] });
  const out = ctContrastMoves(request, params, runs, contract);
  assert.ok(out.tree, "tree present");
  const best = out.tree.leaves.find((l) => l.train.lift > 1.5);
  assert.ok(best, JSON.stringify(out.tree.leaves.map((l) => [l.rule, l.train.lift, l.holdout.lift])));
  assert.ok(best.holdout.lift > 1.2, `holdout ${JSON.stringify(best.holdout)}`);
  assert.ok(out.tree.holdoutRows > 0 && out.tree.trainRows > out.tree.holdoutRows);
  assert.equal(JSON.stringify(out), JSON.stringify(ctContrastMoves(request, params, runs, contract)), "seeded");
});

test("each mode is its own hypothesis: contrastId inputs and ledger signatures differ, time keeps the stage-3 signature", () => {
  const params = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30 });
  const base = { labelId: "label-abc-123", features: [{ feature: "return_pct", lookback: 30, timeframe: 1 }] };
  const conditions = ctContrastMovesSchema.parse(base).features.map(ctFeatureCondition);
  const sig = (controls) => ctContrastSignatures(ctContrastMovesSchema.parse({ ...base, controls }), params, conditions);
  const [t, v, l] = [sig("time"), sig("vol_matched"), sig("losers")];
  assert.equal(new Set([...t, ...v, ...l]).size, 15, "5 quintiles × 3 modes, all distinct");
  assert.deepEqual(t, ctContrastSignatures(ctContrastMovesSchemaStage3.parse(base), params, conditions), "time = the stage-3 signature");
  assert.ok(v.every((s) => s.endsWith("|vol_matched")) && l.every((s) => s.endsWith("|losers")));
  // The request that is hashed into contrastId carries the mode.
  assert.notDeepEqual(ctContrastMovesSchema.parse({ ...base, controls: "time" }), ctContrastMovesSchema.parse({ ...base, controls: "losers" }));
  assert.equal(ctContrastMovesSchema.parse(base).controls, "time", "default is the stage-3 behaviour");
});

test("nothing past the training end leaks into any control group", () => {
  const contract = volContract();
  const params = ctLabelMovesSchema.parse({ k: 3, m: 1, horizon: 30 });
  const { bars } = plantedVolMarket({ dip: true });
  const poisoned = bars.map((b) => (b.startMs >= contract.trainingToMs ? { ...b, open: 1, high: 1e9, low: 1, close: 1e9 } : b));
  for (const controls of ["time", "vol_matched", "losers"]) {
    const request = ctContrastMovesSchema.parse({ labelId: "label-abc-123", controls, features: [{ feature: "return_pct", lookback: 30, timeframe: 1 }, { feature: "range_pct", lookback: 120, timeframe: 1 }] });
    const a = ctContrastMoves(request, params, ctRunLabels(params, { BTCUSDT: bars }, contract), contract);
    const b = ctContrastMoves(request, params, ctRunLabels(params, { BTCUSDT: poisoned }, contract), contract);
    assert.deepEqual(a, b, controls);
  }
  // Moments whose look-ahead would cross the training end are not labels, so neither controls nor losers can be one.
  const [run] = ctRunLabels(params, { BTCUSDT: bars }, contract);
  for (let i = run.rows.length - 29; i < run.rows.length; i++) assert.equal(run.labels.label[i], -1);
  for (const i of ctLoserEvents(run)) assert.ok(run.rows[run.labels.exitIndex[i]].endMs <= contract.trainingToMs);
});
