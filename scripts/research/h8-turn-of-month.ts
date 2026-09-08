/**
 * H8. Turn-of-month effect, amplified with 3x funds.
 *
 * Payroll and pension inflows land on the last session of the month and the
 * first few of the next, and the effect has been reported since 1926. The index
 * version is too small to clear a 0.23% round trip, so the question is whether
 * the 3x version clears it with room to spare.
 */

import { loadDailyMany, writeOut, type Bar } from "./_load.ts";
import { summarise, mean, r3, COST, type Trade } from "./_stats.ts";
import { seasonality } from "../../lib/quant.ts";

const FROM = "2015-09-01";
const OOS = "2021-09-07"; // last 5 years held out
const SYMBOLS = ["SPY", "QQQ", "TQQQ", "UPRO"];
const WINDOWS: Array<{ label: string; enterOffsetFromLast: number; exitNthOfNextMonth: number }> = [
  { label: "(-1,+3)", enterOffsetFromLast: -1, exitNthOfNextMonth: 3 },
  { label: "(-2,+2)", enterOffsetFromLast: -2, exitNthOfNextMonth: 2 },
  { label: "(0,+3)", enterOffsetFromLast: 0, exitNthOfNextMonth: 3 },
];

function slice(bars: Bar[], from: string) { return bars.filter((bar) => bar.date >= from); }

/** Index of the last trading day of each calendar month. */
function monthEnds(bars: Bar[]) {
  const ends: number[] = [];
  for (let index = 0; index < bars.length - 1; index += 1) {
    if (bars[index].date.slice(0, 7) !== bars[index + 1].date.slice(0, 7)) ends.push(index);
  }
  return ends;
}

function windowTrades(symbol: string, bars: Bar[], window: typeof WINDOWS[number]): Trade[] {
  const trades: Trade[] = [];
  for (const end of monthEnds(bars)) {
    const entry = end + window.enterOffsetFromLast;
    const exit = end + window.exitNthOfNextMonth;
    if (entry < 0 || exit >= bars.length || exit <= entry) continue;
    const grossPct = (bars[exit].close / bars[entry].close - 1) * 100;
    trades.push({ symbol, entryDate: bars[entry].date, exitDate: bars[exit].date, grossPct: r3(grossPct)!, netPct: Number((grossPct - COST).toFixed(4)), sessions: exit - entry, tag: window.label });
  }
  return trades;
}

/** Every possible fixed-length window in the sample, as the null distribution. */
function randomWindowDistribution(bars: Bar[], length: number) {
  const values: number[] = [];
  for (let index = 0; index + length < bars.length; index += 1) values.push((bars[index + length].close / bars[index].close - 1) * 100 - COST);
  values.sort((a, b) => a - b);
  return values;
}

function percentileOf(sorted: number[], value: number) {
  let low = 0, high = sorted.length;
  while (low < high) { const mid = (low + high) >> 1; if (sorted[mid] < value) low = mid + 1; else high = mid; }
  return r3((low / sorted.length) * 100);
}

/** 1,000 bootstrap draws of `count` windows of the same length, mean of each draw. */
function bootstrapMeans(pool: number[], count: number, draws = 1000) {
  const means: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    let sum = 0;
    for (let pick = 0; pick < count; pick += 1) sum += pool[Math.floor(Math.random() * pool.length)];
    means.push(sum / count);
  }
  means.sort((a, b) => a - b);
  return means;
}

async function main() {
  const data = await loadDailyMany(SYMBOLS, "11y");
  const results: unknown[] = [];
  const bootstrap: unknown[] = [];

  for (const symbol of SYMBOLS) {
    const bars = slice(data.get(symbol) ?? [], FROM);
    if (bars.length < 500) { console.error(`skip ${symbol}`); continue; }
    for (const window of WINDOWS) {
      const trades = windowTrades(symbol, bars, window);
      const summary = summarise(trades, 0);
      const isTrades = trades.filter((t) => t.entryDate < OOS);
      const oosTrades = trades.filter((t) => t.entryDate >= OOS);
      const length = trades.length ? Math.round(mean(trades.map((t) => t.sessions ?? 0))) : 4;
      const pool = randomWindowDistribution(bars, length);
      const draws = bootstrapMeans(pool, trades.length);
      results.push({
        symbol, window: window.label, sessions: length, trades: summary.trades, winRate: summary.winRate,
        avgNetPct: summary.avgNetPct, t: summary.tStat,
        isAvg: summarise(isTrades, 0).avgNetPct, oosAvg: summarise(oosTrades, 0).avgNetPct, oosTrades: oosTrades.length,
        poolAvgNetPct: r3(mean(pool)),
        percentileOfSingleWindows: percentileOf(pool, summary.avgNetPct ?? 0),
        bootstrapPercentile: percentileOf(draws, summary.avgNetPct ?? 0),
      });
      if (window.label === "(-1,+3)") bootstrap.push({ symbol, bootstrapP5: r3(draws[Math.floor(draws.length * 0.05)]), bootstrapP50: r3(draws[Math.floor(draws.length * 0.5)]), bootstrapP90: r3(draws[Math.floor(draws.length * 0.9)]), actual: summary.avgNetPct });
    }
  }

  const spySeasonality = seasonality(slice(data.get("SPY") ?? [], FROM));
  const report = { hypothesis: "H8 turn of month", period: { from: FROM, oosStart: OOS }, costPct: COST, results, bootstrap, seasonality: { monthly: spySeasonality.monthly, weekday: spySeasonality.weekday } };
  writeOut("h8.json", report);
  console.log(JSON.stringify({ results, bootstrap }, null, 1));
}

await main();
