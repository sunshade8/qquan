/** Shared trade accounting for the hypothesis scripts. Costs always come from lib/broker-costs.ts. */

import { roundTripPct, costInR } from "../../lib/broker-costs.ts";
import type { Bar } from "./_load.ts";

export const COST = roundTripPct();
export { costInR };

export type Trade = {
  symbol: string;
  entryDate: string;
  exitDate: string;
  grossPct: number;
  netPct: number;
  stopPct?: number;
  sessions?: number;
  tag?: string;
};

export function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
export function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}
export function tStat(values: number[]) {
  const s = stdev(values);
  return s > 0 && values.length > 1 ? mean(values) / (s / Math.sqrt(values.length)) : 0;
}
export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
export const r3 = (v: number) => Number.isFinite(v) ? Number(v.toFixed(3)) : null;

export function sma(values: number[], period: number): Array<number | null> {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    return index >= period - 1 ? sum / period : null;
  });
}

/** Trade-level summary. All percentages are already net of `COST`. */
export function summarise(trades: Trade[], sessionsCovered = 0) {
  const nets = trades.map((t) => t.netPct);
  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  const avgWin = wins.length ? mean(wins.map((t) => t.netPct)) : 0;
  const avgLoss = losses.length ? mean(losses.map((t) => t.netPct)) : 0;
  let streak = 0, worstStreak = 0;
  for (const trade of trades) {
    if (trade.netPct <= 0) { streak += 1; worstStreak = Math.max(worstStreak, streak); } else streak = 0;
  }
  const stops = trades.map((t) => t.stopPct).filter((v): v is number => typeof v === "number" && v > 0);
  return {
    trades: trades.length,
    winRate: trades.length ? r3((wins.length / trades.length) * 100) : null,
    avgNetPct: r3(mean(nets)),
    medianNetPct: r3(median(nets)),
    tStat: r3(tStat(nets)),
    avgWinPct: r3(avgWin),
    avgLossPct: r3(avgLoss),
    payoff: avgLoss < 0 ? r3(avgWin / Math.abs(avgLoss)) : null,
    totalNetPct: r3(nets.reduce((a, b) => a + b, 0)),
    worstLossStreak: worstStreak,
    avgStopPct: stops.length ? r3(mean(stops)) : null,
    feeInR: stops.length ? r3(costInR(mean(stops))) : null,
    activeDayPct: sessionsCovered ? r3((trades.length / sessionsCovered) * 100) : null,
    sessionsCovered: sessionsCovered || null,
  };
}

/** Equity curve statistics for a sequential, single-position rule. */
export function equityStats(trades: Trade[], yearsCovered: number) {
  let equity = 1, peak = 1, maxDrawdown = 0;
  for (const trade of trades) {
    equity *= 1 + trade.netPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  return {
    finalEquity: r3(equity),
    cagrPct: yearsCovered > 0 && equity > 0 ? r3((equity ** (1 / yearsCovered) - 1) * 100) : null,
    maxDrawdownPct: r3(maxDrawdown * 100),
  };
}

export function buyAndHold(bars: Bar[], years: number) {
  if (bars.length < 2) return { cagrPct: null, maxDrawdownPct: null };
  const growth = bars.at(-1)!.close / bars[0].close;
  let peak = -Infinity, maxDrawdown = 0;
  for (const bar of bars) { peak = Math.max(peak, bar.close); maxDrawdown = Math.max(maxDrawdown, (peak - bar.close) / peak); }
  return { cagrPct: r3((growth ** (1 / years) - 1) * 100), maxDrawdownPct: r3(maxDrawdown * 100) };
}

/** Splits a date-sorted list at the in-sample / out-of-sample boundary. */
export function splitIsOos<T extends { entryDate: string }>(items: T[], oosStart: string) {
  return { is: items.filter((i) => i.entryDate < oosStart), oos: items.filter((i) => i.entryDate >= oosStart) };
}
