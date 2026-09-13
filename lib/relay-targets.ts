/**
 * What each slot has to earn for the day to hit its target.
 *
 * The question this answers is the one that has to be settled *before* writing
 * rules: a slot target of 0.2% and a slot target of 0.7% are different research
 * problems, and only one of them is worth starting. Three things turn a daily
 * goal into a per-slot number, and leaving any of them out makes the target look
 * easier than it is:
 *
 * 1. **Slots compound.** Eight slots at 0.25% is not 2.0%, it is 2.02%. Small
 *    at this size, but the arithmetic should be the real one.
 * 2. **A slot does not fire every day.** A rule that finds a setup on 60% of
 *    sessions has to earn 1/0.6 as much on the days it does fire.
 * 3. **Every fire pays the round trip.** The gross move captured must cover the
 *    net target *and* the cost, and the cost is per symbol.
 *
 * The output is deliberately expressed two ways: as a percentage move, and as a
 * required win rate at a given reward:risk. The second is what tells you whether
 * a target is reachable — "capture 0.5%" sounds fine until it turns out to mean
 * winning 70% of one-to-one trades.
 */

import { roundTripPctFor } from "./symbol-liquidity.ts";

export type SlotTargetInput = {
  /** Net account return wanted for the whole day, percent. */
  dailyTargetPct: number;
  /** Slots carrying the target. */
  slots: number;
  /** Share of sessions a slot actually finds a setup, 0..1. */
  fireRate: number;
  /** Symbol the cost is charged at. */
  symbol: string;
  /** Target distance divided by stop distance. */
  rewardRisk: number;
};

export type SlotTarget = {
  slots: number;
  fireRate: number;
  /** Net return each slot must add on an average session. */
  perSessionNetPct: number;
  /** Net return required on the sessions the slot actually fires. */
  perFireNetPct: number;
  roundTripPct: number;
  /** Gross move that must be captured, before cost, on a firing session. */
  perFireGrossPct: number;
  /** Expectancy the rule needs, in units of its own stop distance. */
  requiredEdgeR: number;
  /** Win rate that expectancy implies at the given reward:risk. */
  requiredWinRatePct: number;
  /** Stop distance that makes the required edge equal one R of the gross move. */
  impliedStopPct: number;
};

/**
 * Required win rate from expectancy: E = w·R − (1−w)·1, so w = (E + 1) / (R + 1).
 * Expressed in R, which is why the stop distance has to be chosen first.
 */
export function slotTarget(input: SlotTargetInput, stopPct: number): SlotTarget {
  const slots = Math.max(1, Math.round(input.slots));
  const fireRate = Math.min(1, Math.max(0.01, input.fireRate));
  const roundTrip = roundTripPctFor(input.symbol);

  const perSessionNet = ((1 + input.dailyTargetPct / 100) ** (1 / slots) - 1) * 100;
  const perFireNet = perSessionNet / fireRate;
  const perFireGross = perFireNet + roundTrip;
  const requiredEdgeR = perFireGross / Math.max(0.01, stopPct);
  const requiredWinRate = ((requiredEdgeR + 1) / (input.rewardRisk + 1)) * 100;

  const round = (value: number, digits = 3) => Number(value.toFixed(digits));
  return {
    slots, fireRate: round(fireRate, 2),
    perSessionNetPct: round(perSessionNet),
    perFireNetPct: round(perFireNet),
    roundTripPct: round(roundTrip),
    perFireGrossPct: round(perFireGross),
    requiredEdgeR: round(requiredEdgeR),
    requiredWinRatePct: round(requiredWinRate, 1),
    impliedStopPct: round(stopPct, 2),
  };
}

/** The grid to look at before choosing how many slots to build rules for. */
export function slotTargetGrid(options: { symbol: string; stopPct: number; rewardRisk: number; fireRate: number }) {
  return [1, 1.5, 2].flatMap((dailyTargetPct) =>
    [3, 5, 7, 9].map((slots) => ({
      dailyTargetPct,
      ...slotTarget({ dailyTargetPct, slots, fireRate: options.fireRate, symbol: options.symbol, rewardRisk: options.rewardRisk }, options.stopPct),
    })),
  );
}
