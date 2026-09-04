import assert from "node:assert/strict";
import test from "node:test";
import { binomialPmf, binomialTail, computeTargetMath } from "../lib/daily-target.ts";

test("binomial pmf and tail agree with hand arithmetic", () => {
  // 4 trades at 50%: P(exactly 2) = 6/16, P(at least 3) = 5/16.
  assert.ok(Math.abs(binomialPmf(4, 2, 0.5) - 0.375) < 1e-9);
  assert.ok(Math.abs(binomialTail(4, 3, 0.5) - 0.3125) < 1e-9);
  const total = Array.from({ length: 5 }, (_, wins) => binomialPmf(4, wins, 0.5)).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("required win rate solves the frictionless case exactly", () => {
  // 2% a day at 0.5% risk over 4 trades = 1R per trade. At 1:2 with no friction,
  // p*2 - (1-p) = 1 -> p = 2/3.
  const result = computeTargetMath({ targetDailyPct: 2, riskPerTradePct: 0.5, rewardRisk: 2, tradesPerDay: 4, costPerTradeR: 0 });
  assert.equal(result.targetDailyR, 4);
  assert.equal(result.requiredRPerTrade, 1);
  assert.ok(Math.abs(result.requiredWinRatePct - 66.67) < 0.01);
  assert.ok(Math.abs(result.breakevenWinRatePct - 33.33) < 0.01);
  assert.equal(result.verdict, "demanding");
});

test("friction raises both the breakeven and the required win rate", () => {
  const clean = computeTargetMath({ costPerTradeR: 0 });
  const dirty = computeTargetMath({ costPerTradeR: 0.15 });
  assert.ok(dirty.breakevenWinRatePct > clean.breakevenWinRatePct);
  assert.ok(dirty.requiredWinRatePct > clean.requiredWinRatePct);
  assert.ok(dirty.netWinR < clean.netWinR && dirty.netLossR > clean.netLossR);
});

test("a target beyond reach is reported as impossible rather than as a high bar", () => {
  // 5% a day on 0.2% risk with one 1:1 trade needs 25R from a bet that pays 1R.
  const result = computeTargetMath({ targetDailyPct: 5, riskPerTradePct: 0.2, rewardRisk: 1, tradesPerDay: 1 });
  assert.ok(result.requiredWinRatePct > 100);
  assert.equal(result.verdict, "impossible");
  assert.ok(result.notes.some((note) => note.includes("100%")));
});

test("a lottery payoff clears the target on average while the median day loses", () => {
  // One 1:20 trade a day hit 25% of the time averages 4.25R = 2.125% against a
  // 2% goal, but three days in four are a flat loss. Reporting only the mean is
  // how a strategy nobody could sit through gets described as meeting target.
  const { evaluation } = computeTargetMath({ targetDailyPct: 2, riskPerTradePct: 0.5, rewardRisk: 20, tradesPerDay: 1, winRatePct: 25, costPerTradeR: 0 });
  assert.ok(evaluation.expectedDailyPct > 2);
  assert.equal(evaluation.hitTargetRatePct, 25);
  assert.equal(evaluation.medianDailyPct, -0.5);
  assert.equal(evaluation.losingDayRatePct, 75);
  const probabilities = evaluation.dayOutcomes.reduce((sum, outcome) => sum + outcome.probabilityPct, 0);
  assert.ok(Math.abs(probabilities - 100) < 0.01);
});

test("bet sizing is scored against Kelly in both directions, and runs reproduce", () => {
  // p=40% at 1:2 has a thin edge, so Kelly is a ~7.7% stake: 15% is over it.
  const settings = { rewardRisk: 2, tradesPerDay: 4, winRatePct: 40, simulationRuns: 400, simulationDays: 60 };
  const aggressive = computeTargetMath({ ...settings, riskPerTradePct: 15 });
  assert.equal(aggressive.evaluation.riskVsKelly, "over");
  assert.ok(aggressive.evaluation.kellyRiskPerTradePct < 15);
  assert.ok(aggressive.simulation.medianMaxDrawdownPct > 0);
  assert.equal(computeTargetMath({ ...settings, riskPerTradePct: 0.5 }).evaluation.riskVsKelly, "under");

  const repeat = computeTargetMath({ ...settings, riskPerTradePct: 15 });
  assert.equal(repeat.simulation.medianTerminalMultiple, aggressive.simulation.medianTerminalMultiple);
});

test("a negative-edge configuration reports no Kelly stake and a losing note", () => {
  const result = computeTargetMath({ rewardRisk: 2, tradesPerDay: 4, winRatePct: 20, costPerTradeR: 0.05 });
  assert.ok(result.evaluation.expectedRPerTrade < 0);
  assert.equal(result.evaluation.kellyRiskPerTradePct, null);
  assert.equal(result.evaluation.riskVsKelly, "no_edge");
});

// --- fees and the multi-tactic book ----------------------------------------

import { combineTactics, feeFloor } from "../lib/daily-target.ts";

test("a percentage commission becomes a fraction of risk, and tight stops make it worse", () => {
  // 0.1% per side plus 0.03% slippage = 0.23% round trip.
  const wide = feeFloor({ feePerSidePct: 0.1, slippagePct: 0.03, stopDistancePct: 1 }, 2);
  assert.equal(wide.roundTripCostPct, 0.23);
  assert.equal(wide.costPerTradeR, 0.23);

  // Same schedule, a quarter of the stop: four times the cost in R.
  const tight = feeFloor({ feePerSidePct: 0.1, slippagePct: 0.03, stopDistancePct: 0.25 }, 2);
  assert.equal(tight.costPerTradeR, 0.92);
  assert.ok(tight.breakevenWinRatePct > wide.breakevenWinRatePct);
  assert.equal(wide.frictionlessWinRatePct, 33.33);
  assert.ok(wide.winRatePenaltyPts > 0);
});

test("a cost that swallows the whole target is called out rather than priced in", () => {
  const crushed = feeFloor({ feePerSidePct: 0.5, slippagePct: 0.1, stopDistancePct: 0.5 }, 2);
  assert.ok(crushed.costPerTradeR >= 2);
  assert.equal(crushed.breakevenWinRatePct, 100);
  assert.ok(crushed.notes.some((note) => note.includes("통째로")));
});

test("tactics that beat the fee are kept and the rest are dropped", () => {
  const fee = feeFloor({ feePerSidePct: 0.1, slippagePct: 0.03, stopDistancePct: 1 }, 2);
  const book = combineTactics([
    { name: "돌파", tradesPerDay: 2, winRatePct: 55, rewardRisk: 2, riskPerTradePct: 0.5, activeDayRatePct: 100 },
    { name: "회귀", tradesPerDay: 1, winRatePct: 60, rewardRisk: 1.5, riskPerTradePct: 0.5, activeDayRatePct: 50 },
    { name: "약한 규칙", tradesPerDay: 3, winRatePct: 35, rewardRisk: 2, riskPerTradePct: 0.5, activeDayRatePct: 100 },
    { name: "안 터지는 규칙", tradesPerDay: 2, winRatePct: 80, rewardRisk: 3, riskPerTradePct: 0.5, activeDayRatePct: 0 },
  ], 2, fee);

  assert.equal(book.kept, 2);
  assert.deepEqual(book.tactics.filter((item) => !item.keep).map((item) => item.name), ["약한 규칙", "안 터지는 규칙"]);
  // The half-time tactic is discounted to half a trade a day, not a whole one.
  assert.equal(book.tactics.find((item) => item.name === "회귀").effectiveTradesPerDay, 0.5);
  assert.equal(book.totalTradesPerDay, 2.5);
  assert.ok(book.combinedExpectedDailyPct > 0 && book.combinedExpectedDailyPct < 2);
  assert.ok(book.shortfallPct > 0);
  assert.ok(book.additionalTacticsNeeded > 0);
});

test("the book's expected return is the sum of what it keeps", () => {
  const fee = feeFloor({ feePerSidePct: 0, slippagePct: 0, stopDistancePct: 1 }, 2);
  // Frictionless 60% at 1:2 is 0.8R per trade; one trade a day at 0.5% risk is 0.4%.
  const one = { name: "A", tradesPerDay: 1, winRatePct: 60, rewardRisk: 2, riskPerTradePct: 0.5, activeDayRatePct: 100 };
  const single = combineTactics([one], 2, fee);
  assert.equal(single.combinedExpectedDailyPct, 0.4);
  const five = combineTactics([1, 2, 3, 4, 5].map((n) => ({ ...one, name: `A${n}` })), 2, fee);
  assert.equal(five.combinedExpectedDailyPct, 2);
  assert.equal(five.shortfallPct, 0);
  assert.equal(five.additionalTacticsNeeded, 0);
  assert.ok(five.notes.some((note) => note.includes("상한")));
});
