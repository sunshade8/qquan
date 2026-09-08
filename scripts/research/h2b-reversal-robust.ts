/**
 * H2 robustness: date clustering, longer history, and a capacity cap.
 *
 * A market-wide selloff fires the same signal on forty names at once, so the
 * pooled t-statistic counts one event forty times. Averaging inside each entry
 * date and testing across dates is the honest standard error. The same day also
 * cannot be traded forty ways with one account, so a per-day cap of N names
 * (largest drop first) measures what the account could actually have taken.
 */

import { loadDailyMany, writeOut, type Bar } from "./_load.ts";
import { runDailyRule, baselineForward } from "./_daily.ts";
import { summarise, tStat, mean, sma, r3, COST, type Trade } from "./_stats.ts";
import { universeById } from "../../lib/universe.ts";

const OOS = "2025-09-07";
const STOP = 6;

function slice(bars: Bar[], from: string) { return bars.filter((bar) => bar.date >= from); }

function signalFactory(bars: Bar[], dropPct: number, useTrend: boolean) {
  const closes = bars.map((bar) => bar.close);
  const trend = sma(closes, 200);
  return (index: number) => {
    if (index < 200) return false;
    if ((closes[index] / closes[index - 3] - 1) * 100 > -dropPct) return false;
    return !useTrend || (trend[index] !== null && closes[index] > trend[index]!);
  };
}

/** Mean net return per entry date, then a t-test across dates. */
function clustered(trades: Trade[]) {
  const byDate = new Map<string, number[]>();
  for (const trade of trades) {
    const list = byDate.get(trade.entryDate);
    if (list) list.push(trade.netPct); else byDate.set(trade.entryDate, [trade.netPct]);
  }
  const perDay = [...byDate.entries()].map(([date, values]) => ({ date, value: mean(values), count: values.length }));
  return {
    days: perDay.length,
    avgNetPct: r3(mean(perDay.map((d) => d.value))),
    clusteredT: r3(tStat(perDay.map((d) => d.value))),
    medianSignalsPerDay: perDay.length ? perDay.map((d) => d.count).sort((a, b) => a - b)[Math.floor(perDay.length / 2)] : 0,
    maxSignalsPerDay: perDay.length ? Math.max(...perDay.map((d) => d.count)) : 0,
    perDay,
  };
}

async function main() {
  const symbols = [...new Set([...(universeById("megacap")!.symbols), ...(universeById("nasdaq_tech")!.symbols)])];
  const data = await loadDailyMany(symbols, "11y");
  console.error(`loaded ${data.size} symbols, 11y`);

  const configs = [
    { label: "drop6 trend h5", drop: 6, trend: true, horizon: 5 },
    { label: "drop6 no-trend h5", drop: 6, trend: false, horizon: 5 },
    { label: "drop8 no-trend h5", drop: 8, trend: false, horizon: 5 },
    { label: "drop4 trend h5", drop: 4, trend: true, horizon: 5 },
  ];

  const windows = [
    { label: "2015-2026 (11y)", from: "2015-09-07" },
    { label: "2016-2019 (pre-covid)", from: "2016-01-01", to: "2019-12-31" },
    { label: "2020-2022", from: "2020-01-01", to: "2022-12-31" },
    { label: "2023-2026", from: "2023-01-01" },
    { label: "지시서 창 2022-09~", from: "2022-09-07" },
  ];

  const results: unknown[] = [];
  for (const config of configs) {
    for (const window of windows) {
      const pooled: Trade[] = [];
      const baseline: Trade[] = [];
      for (const [symbol, bars] of data) {
        const s = slice(bars, window.from);
        if (s.length < 300) continue;
        const trades = runDailyRule(symbol, s, { signal: signalFactory(s, config.drop, config.trend), maxSessions: config.horizon, stopLossPct: STOP });
        pooled.push(...trades.filter((t) => !window.to || t.entryDate <= window.to));
        baseline.push(...baselineForward(symbol, s, config.horizon).filter((t) => !window.to || t.entryDate <= window.to));
      }
      const summary = summarise(pooled, 0);
      const cluster = clustered(pooled);
      results.push({
        config: config.label, window: window.label, trades: summary.trades, winRate: summary.winRate,
        avgNetPct: summary.avgNetPct, pooledT: summary.tStat,
        clusterDays: cluster.days, clusteredT: cluster.clusteredT, medianPerDay: cluster.medianSignalsPerDay, maxPerDay: cluster.maxSignalsPerDay,
        baselineNetPct: summarise(baseline, 0).avgNetPct,
        excessPct: r3((summary.avgNetPct ?? 0) - (summarise(baseline, 0).avgNetPct ?? 0)),
      });
    }
  }

  // Capacity: at most `cap` names per entry date, deepest 3-day drop first.
  const capacity: unknown[] = [];
  for (const cap of [1, 3, 5]) {
    const byDate = new Map<string, Array<Trade & { depth: number }>>();
    for (const [symbol, bars] of data) {
      const s = slice(bars, "2015-09-07");
      if (s.length < 300) continue;
      const closes = s.map((b) => b.close);
      const depthAt = new Map<string, number>();
      for (let index = 3; index < s.length; index += 1) depthAt.set(s[index].date, (closes[index] / closes[index - 3] - 1) * 100);
      const trades = runDailyRule(symbol, s, { signal: signalFactory(s, 6, false), maxSessions: 5, stopLossPct: STOP });
      for (const trade of trades) {
        const signalDate = s[s.findIndex((b) => b.date === trade.entryDate) - 1]?.date;
        const list = byDate.get(trade.entryDate) ?? [];
        list.push({ ...trade, depth: depthAt.get(signalDate ?? "") ?? 0 });
        byDate.set(trade.entryDate, list);
      }
    }
    const taken: Trade[] = [];
    for (const [, list] of byDate) taken.push(...list.sort((a, b) => a.depth - b.depth).slice(0, cap));
    taken.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
    const summary = summarise(taken, 0);
    const isTrades = taken.filter((t) => t.entryDate < OOS);
    const oosTrades = taken.filter((t) => t.entryDate >= OOS);
    capacity.push({ cap, trades: summary.trades, winRate: summary.winRate, avgNetPct: summary.avgNetPct, pooledT: summary.tStat, clusteredT: clustered(taken).clusteredT, is: summarise(isTrades, 0).avgNetPct, oos: summarise(oosTrades, 0).avgNetPct, oosTrades: oosTrades.length, activeDays: new Set(taken.map((t) => t.entryDate)).size });
  }

  // Per calendar year, base no-trend cell.
  const yearly: Record<string, unknown> = {};
  const allTrades: Trade[] = [];
  for (const [symbol, bars] of data) {
    const s = slice(bars, "2015-09-07");
    if (s.length < 300) continue;
    allTrades.push(...runDailyRule(symbol, s, { signal: signalFactory(s, 6, false), maxSessions: 5, stopLossPct: STOP }));
  }
  for (const year of ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026"]) {
    const subset = allTrades.filter((t) => t.entryDate.startsWith(year));
    const baseline: Trade[] = [];
    for (const [symbol, bars] of data) baseline.push(...baselineForward(symbol, slice(bars, "2015-09-07"), 5).filter((t) => t.entryDate.startsWith(year)));
    yearly[year] = { trades: subset.length, avgNetPct: summarise(subset, 0).avgNetPct, clusteredT: clustered(subset).clusteredT, baselineNetPct: summarise(baseline, 0).avgNetPct };
  }

  const report = { hypothesis: "H2 robustness", costPct: COST, stopPct: STOP, symbols: data.size, results, capacity, yearly };
  writeOut("h2b.json", report);
  console.log(JSON.stringify({ results, capacity, yearly }, null, 1));
}

await main();
