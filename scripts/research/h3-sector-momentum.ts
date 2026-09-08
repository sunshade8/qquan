/**
 * H3. Sector momentum persistence.
 *
 * The lead-lag study failed because the "follower" was really the whole sector
 * moving together. This asks the sector question directly: is a 2-sigma up day
 * in a sector ETF the start of a fund flow that keeps running for a few days?
 */

import { loadDailyMany, writeOut, type Bar } from "./_load.ts";
import { runDailyRule, baselineForward } from "./_daily.ts";
import { summarise, splitIsOos, sma, stdev, mean, tStat, r3, COST, costInR, type Trade } from "./_stats.ts";
import { universeById } from "../../lib/universe.ts";

const FROM = "2021-09-07";
const OOS = "2025-09-07";
const STOP = 3;
const EXTRA = ["SMH", "XBI", "ARKK", "QQQ"];
const LEVERAGED: Array<[string, string]> = [["SMH", "SOXL"], ["XLK", "TQQQ"], ["QQQ", "TQQQ"], ["SPY", "UPRO"]];

function slice(bars: Bar[], from: string) { return bars.filter((bar) => bar.date >= from); }

/** Rolling 60-session standard deviation of daily returns, in percent. */
function rollingSigma(bars: Bar[], window = 60) {
  const returns = bars.map((bar, index) => index ? (bar.close / bars[index - 1].close - 1) * 100 : 0);
  return bars.map((_, index) => index < window ? null : stdev(returns.slice(index - window + 1, index + 1)));
}

function makeSignal(bars: Bar[], multiple: number, direction: 1 | -1, useTrend = true) {
  const closes = bars.map((bar) => bar.close);
  const sigma = rollingSigma(bars);
  const trend = sma(closes, 50);
  return (index: number) => {
    if (index < 60 || sigma[index] === null) return false;
    const change = (closes[index] / closes[index - 1] - 1) * 100;
    if (direction === 1 ? change < multiple * sigma[index]! : change > -multiple * sigma[index]!) return false;
    if (!useTrend) return true;
    return trend[index] !== null && closes[index] > trend[index]!;
  };
}

function clusteredT(trades: Trade[]) {
  const byDate = new Map<string, number[]>();
  for (const trade of trades) { const list = byDate.get(trade.entryDate); if (list) list.push(trade.netPct); else byDate.set(trade.entryDate, [trade.netPct]); }
  const perDay = [...byDate.values()].map((values) => mean(values));
  return { days: perDay.length, t: r3(tStat(perDay)) };
}

async function main() {
  const base = [...universeById("sector_etfs")!.symbols, ...EXTRA];
  const symbols = [...new Set([...base, "SPY", ...LEVERAGED.map(([, l]) => l)])];
  const data = await loadDailyMany(symbols, "6y");
  console.error(`loaded ${data.size}`);

  const sweep: unknown[] = [];
  for (const multiple of [1.5, 2, 2.5]) {
    for (const holding of [2, 3, 5]) {
      const pooled: Trade[] = [];
      for (const symbol of base) {
        const bars = data.get(symbol); if (!bars) continue;
        const s = slice(bars, FROM);
        pooled.push(...runDailyRule(symbol, s, { signal: makeSignal(s, multiple, 1), maxSessions: holding, stopLossPct: STOP }));
      }
      pooled.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
      const split = splitIsOos(pooled, OOS);
      const summary = summarise(pooled, 0);
      const baseline: Trade[] = [];
      for (const symbol of base) { const bars = data.get(symbol); if (bars) baseline.push(...baselineForward(symbol, slice(bars, FROM), holding)); }
      const baselineAvg = summarise(baseline, 0).avgNetPct ?? 0;
      sweep.push({ sigmaMultiple: multiple, holding, trades: summary.trades, winRate: summary.winRate, avgNetPct: summary.avgNetPct, pooledT: summary.tStat, clusteredT: clusteredT(pooled).t, baselineNetPct: r3(baselineAvg), excessPct: r3((summary.avgNetPct ?? 0) - baselineAvg), isAvg: summarise(split.is, 0).avgNetPct, oosAvg: summarise(split.oos, 0).avgNetPct, oosTrades: split.oos.length });
    }
  }

  // Control A: 2-sigma DOWN days, same holding — persistence or reversal?
  const downside: unknown[] = [];
  for (const holding of [2, 3, 5]) {
    const pooled: Trade[] = [];
    for (const symbol of base) {
      const bars = data.get(symbol); if (!bars) continue;
      const s = slice(bars, FROM);
      pooled.push(...runDailyRule(symbol, s, { signal: makeSignal(s, 2, -1, false), maxSessions: holding, stopLossPct: STOP }));
    }
    const summary = summarise(pooled, 0);
    downside.push({ holding, trades: summary.trades, winRate: summary.winRate, avgNetPct: summary.avgNetPct, clusteredT: clusteredT(pooled).t });
  }

  // Control B: trend filter removed on the base cell.
  const noTrend: Trade[] = [];
  for (const symbol of base) {
    const bars = data.get(symbol); if (!bars) continue;
    const s = slice(bars, FROM);
    noTrend.push(...runDailyRule(symbol, s, { signal: makeSignal(s, 2, 1, false), maxSessions: 3, stopLossPct: STOP }));
  }

  // Leveraged expression: signal on the underlying, fill on the 3x fund.
  const leveraged: unknown[] = [];
  for (const [underlying, fund] of LEVERAGED) {
    const signalBars = data.get(underlying), fillBars = data.get(fund);
    if (!signalBars || !fillBars) continue;
    const s = slice(signalBars, FROM), f = slice(fillBars, FROM);
    const plain = runDailyRule(underlying, s, { signal: makeSignal(s, 2, 1), maxSessions: 3, stopLossPct: STOP });
    const geared = runDailyRule(fund, s, { signal: makeSignal(s, 2, 1), maxSessions: 3, stopLossPct: STOP * 3, fillOn: f });
    leveraged.push({
      pair: `${underlying}→${fund}`,
      base: { trades: plain.length, avgNetPct: summarise(plain, 0).avgNetPct, winRate: summarise(plain, 0).winRate },
      geared: { trades: geared.length, avgNetPct: summarise(geared, 0).avgNetPct, winRate: summarise(geared, 0).winRate, stopPct: STOP * 3, feeInR: r3(costInR(STOP * 3)) },
      gearedOverBase: r3((summarise(geared, 0).avgNetPct ?? 0) / Math.max(1e-9, summarise(plain, 0).avgNetPct ?? 0)),
    });
  }

  const report = { hypothesis: "H3 sector momentum persistence", period: { from: FROM, oosStart: OOS }, costPct: COST, stopPct: STOP, feeInR: r3(costInR(STOP)), sweep, downside, noTrendBaseCell: summarise(noTrend, 0), leveraged };
  writeOut("h3.json", report);
  console.log(JSON.stringify(report, null, 1));
}

await main();
