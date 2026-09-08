/**
 * H2. Three-day plunge, short-term reversal.
 *
 * A 3-day drop in a large cap that is still above its 200-day average is more
 * often liquidity and rebalancing pressure than news, and part of it comes back
 * within a week. A 5-session hold makes the 0.23% round trip small relative to
 * the move being harvested.
 */

import { loadDailyMany, writeOut, type Bar } from "./_load.ts";
import { runDailyRule, baselineForward } from "./_daily.ts";
import { summarise, splitIsOos, sma, r3, COST, costInR, type Trade } from "./_stats.ts";
import { universeById } from "../../lib/universe.ts";

const FROM = "2022-09-07";
const OOS = "2025-09-07";
const STOP = 6;

function slice(bars: Bar[], from: string) { return bars.filter((bar) => bar.date >= from); }

function signalFactory(bars: Bar[], dropPct: number, useTrend: boolean) {
  const closes = bars.map((bar) => bar.close);
  const trend = sma(closes, 200);
  return (index: number) => {
    if (index < 200) return false;
    const change = (closes[index] / closes[index - 3] - 1) * 100;
    if (change > -dropPct) return false;
    return !useTrend || (trend[index] !== null && closes[index] > trend[index]!);
  };
}

async function main() {
  const symbols = [...new Set([...(universeById("megacap")!.symbols), ...(universeById("nasdaq_tech")!.symbols)])];
  console.error(`loading ${symbols.length} symbols…`);
  const data = await loadDailyMany(symbols, "6y");
  console.error(`loaded ${data.size}`);

  const sweep: unknown[] = [];
  const detail: Record<string, unknown> = {};

  for (const useTrend of [true, false]) {
    for (const drop of [4, 6, 8]) {
      for (const horizon of [3, 5, 10]) {
        const pooled: Trade[] = [];
        for (const [symbol, bars] of data) {
          const s = slice(bars, FROM);
          if (s.length < 250) continue;
          pooled.push(...runDailyRule(symbol, s, { signal: signalFactory(s, drop, useTrend), maxSessions: horizon, stopLossPct: STOP }));
        }
        pooled.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
        const split = splitIsOos(pooled, OOS);
        const all = summarise(pooled, 0);
        const row = { trendFilter: useTrend, dropPct: drop, horizon, trades: all.trades, winRate: all.winRate, avgNetPct: all.avgNetPct, t: all.tStat, isAvg: summarise(split.is, 0).avgNetPct, oosAvg: summarise(split.oos, 0).avgNetPct, oosTrades: split.oos.length };
        sweep.push(row);
        if (useTrend && drop === 6 && horizon === 5) detail.base = { all, is: summarise(split.is, 0), oos: summarise(split.oos, 0) };
      }
    }
  }

  // Baseline: unconditional forward hold over the same horizons and window.
  const baselines: Record<string, unknown> = {};
  for (const horizon of [3, 5, 10]) {
    const pooled: Trade[] = [];
    for (const [symbol, bars] of data) pooled.push(...baselineForward(symbol, slice(bars, FROM), horizon));
    pooled.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
    const split = splitIsOos(pooled, OOS);
    baselines[`h${horizon}`] = { all: summarise(pooled, 0).avgNetPct, is: summarise(split.is, 0).avgNetPct, oos: summarise(split.oos, 0).avgNetPct, trades: pooled.length };
  }

  // Take-profit variants on the base cell.
  const tpVariants: unknown[] = [];
  for (const takeProfit of [3, 4, 6]) {
    const pooled: Trade[] = [];
    for (const [symbol, bars] of data) {
      const s = slice(bars, FROM);
      if (s.length < 250) continue;
      pooled.push(...runDailyRule(symbol, s, { signal: signalFactory(s, 6, true), maxSessions: 5, stopLossPct: STOP, takeProfitPct: takeProfit }));
    }
    const summary = summarise(pooled, 0);
    tpVariants.push({ takeProfitPct: takeProfit, trades: summary.trades, winRate: summary.winRate, avgNetPct: summary.avgNetPct, t: summary.tStat });
  }

  const report = { hypothesis: "H2 three-day plunge reversal", period: { from: FROM, oosStart: OOS }, costPct: COST, stopPct: STOP, feeInR: r3(costInR(STOP)), symbols: data.size, sweep, baselines, tpVariants, detail };
  writeOut("h2.json", report);
  console.log(JSON.stringify({ sweep, baselines, tpVariants, detail }, null, 1));
}

await main();
