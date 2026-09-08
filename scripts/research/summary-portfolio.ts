/**
 * Final aggregation: the adopted tactics scored as one book against the 2%/day
 * target, using `lib/daily-target.ts` so the arithmetic is the same one the Lab
 * quotes. Only H2 survived, so this is a one-tactic book — the number it
 * produces is a floor on how far short the current research stands, not a plan.
 */

import { writeOut } from "./_load.ts";
import { feeFloor, combineTactics, type Tactic } from "../../lib/daily-target.ts";
import { feePerSidePct, assumedSlippagePct, roundTripPct, describeCosts } from "../../lib/broker-costs.ts";

const TARGET_DAILY_PCT = 2;

// Measured on 11 years, day-clustered, capped at 3 names per session.
const H2 = { winRatePct: 49.46, payoff: 1.39, stopPct: 6, tradesPerActiveDay: 2.10, activeDayRatePct: 54.1, measuredNetPerTradePct: 0.852 };

function book(slotFraction: number): Tactic[] {
  return [{
    name: `H2 3일 급락 반전 (슬롯당 자본 ${Math.round(1 / slotFraction)}분의 1)`,
    tradesPerDay: H2.tradesPerActiveDay,
    winRatePct: H2.winRatePct,
    rewardRisk: H2.payoff,
    riskPerTradePct: slotFraction * H2.stopPct,
    activeDayRatePct: H2.activeDayRatePct,
  }];
}

const fee = feeFloor({ feePerSidePct: feePerSidePct(), slippagePct: assumedSlippagePct(), stopDistancePct: H2.stopPct }, H2.payoff);
const results = [1 / 6, 1 / 12].map((fraction) => ({
  slotFraction: Number(fraction.toFixed(4)),
  capitalAtRiskPerTradePct: Number((fraction * H2.stopPct).toFixed(3)),
  ...combineTactics(book(fraction), TARGET_DAILY_PCT, fee),
}));

const report = {
  costs: describeCosts(),
  roundTripPct: roundTripPct(),
  feeFloor: fee,
  targetDailyPct: TARGET_DAILY_PCT,
  results,
  caveat: "상관은 더하지 않았다. 채택 전술이 1개뿐이라 분산 효과가 없고, 이 수치는 같은 규칙을 하루 여러 종목에 나눠 실행했을 때의 기대값일 뿐이다.",
};
writeOut("summary.json", report);
console.log(describeCosts());
console.log("\nfee floor:", JSON.stringify({ costPerTradeR: fee.costPerTradeR, breakevenWinRatePct: fee.breakevenWinRatePct, frictionlessWinRatePct: fee.frictionlessWinRatePct }, null, 1));
for (const result of results) {
  console.log(`\n--- 슬롯 자본 1/${Math.round(1 / result.slotFraction)} (거래당 자본위험 ${result.capitalAtRiskPerTradePct}%) ---`);
  console.log(JSON.stringify({ tactics: result.tactics, combinedExpectedDailyPct: result.combinedExpectedDailyPct, targetDailyPct: result.targetDailyPct, shortfallPct: result.shortfallPct, additionalTacticsNeeded: result.additionalTacticsNeeded, notes: result.notes }, null, 1));
}
