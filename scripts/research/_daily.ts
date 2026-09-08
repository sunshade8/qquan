/**
 * One daily-bar rule engine shared by the daily hypotheses.
 *
 * Execution convention matches `lib/strategy.ts`: a signal read from bar `i`'s
 * close is filled at bar `i+1`'s close, so nothing trades on information the
 * bar did not have. Stops and targets are checked intrabar from `i+2` onward
 * and the stop is assumed to fill first when both are touched in one bar.
 */

import type { Bar } from "./_load.ts";
import { COST, type Trade } from "./_stats.ts";

export type RuleOptions = {
  /** True when bar `index` closes a valid signal. */
  signal: (index: number, bars: Bar[]) => boolean;
  /** Optional close-based exit, checked from the first bar after entry. */
  exitSignal?: (index: number, bars: Bar[], entryPrice: number, entryIndex: number) => boolean;
  maxSessions: number;
  stopLossPct?: number | null;
  takeProfitPct?: number | null;
  /** Blocks a new entry while an earlier trade is still open. */
  singlePosition?: boolean;
  /** Prices the trade on a different instrument than the one carrying the signal. */
  fillOn?: Bar[];
  tag?: string;
};

function alignedIndex(target: Bar[], date: string) {
  // Signal and fill series can differ (QQQ signal, SQQQ fill); match by date.
  const found = target.findIndex((bar) => bar.date === date);
  return found;
}

export function runDailyRule(symbol: string, bars: Bar[], options: RuleOptions): Trade[] {
  const fill = options.fillOn ?? bars;
  const sameSeries = fill === bars;
  const trades: Trade[] = [];
  let blockedUntil = -1;
  for (let index = 0; index < bars.length - 2; index += 1) {
    if (options.singlePosition && index <= blockedUntil) continue;
    if (!options.signal(index, bars)) continue;
    const entryDate = bars[index + 1].date;
    const entryFillIndex = sameSeries ? index + 1 : alignedIndex(fill, entryDate);
    if (entryFillIndex < 0 || entryFillIndex >= fill.length - 1) continue;
    const entryPrice = fill[entryFillIndex].close;
    if (!(entryPrice > 0)) continue;
    const stopPrice = options.stopLossPct ? entryPrice * (1 - options.stopLossPct / 100) : null;
    const targetPrice = options.takeProfitPct ? entryPrice * (1 + options.takeProfitPct / 100) : null;

    let exitIndex = -1;
    let exitPrice = 0;
    let reason = "time";
    for (let step = 1; step <= options.maxSessions; step += 1) {
      const cursor = entryFillIndex + step;
      if (cursor >= fill.length) break;
      exitIndex = cursor;
      if (stopPrice !== null && fill[cursor].low <= stopPrice) { exitPrice = stopPrice; reason = "stop"; break; }
      if (targetPrice !== null && fill[cursor].high >= targetPrice) { exitPrice = targetPrice; reason = "target"; break; }
      exitPrice = fill[cursor].close;
      const signalCursor = sameSeries ? cursor : alignedIndex(bars, fill[cursor].date);
      if (options.exitSignal && signalCursor >= 0 && options.exitSignal(signalCursor, bars, entryPrice, index + 1)) { reason = "signal"; break; }
      reason = "time";
    }
    if (exitIndex < 0 || !(exitPrice > 0)) continue;
    const grossPct = (exitPrice / entryPrice - 1) * 100;
    trades.push({
      symbol,
      entryDate,
      exitDate: fill[exitIndex].date,
      grossPct: Number(grossPct.toFixed(4)),
      netPct: Number((grossPct - COST).toFixed(4)),
      stopPct: options.stopLossPct ?? undefined,
      sessions: exitIndex - entryFillIndex,
      tag: options.tag ?? reason,
    });
    blockedUntil = index + (exitIndex - entryFillIndex);
  }
  return trades;
}

/** Forward net return over a fixed horizon from every bar — the unconditional baseline. */
export function baselineForward(symbol: string, bars: Bar[], horizon: number, from = "0000", to = "9999"): Trade[] {
  const trades: Trade[] = [];
  for (let index = 0; index + 1 + horizon < bars.length; index += 1) {
    const entryDate = bars[index + 1].date;
    if (entryDate < from || entryDate > to) continue;
    const grossPct = (bars[index + 1 + horizon].close / bars[index + 1].close - 1) * 100;
    trades.push({ symbol, entryDate, exitDate: bars[index + 1 + horizon].date, grossPct: Number(grossPct.toFixed(4)), netPct: Number((grossPct - COST).toFixed(4)), sessions: horizon, tag: "baseline" });
  }
  return trades;
}
