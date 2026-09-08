/**
 * H7. Leveraged-ETF pullback inside an uptrend.
 *
 * Cost is charged on notional while the move is 3x, so the same signal costs a
 * third as much in "fee per unit of move" on a 3x fund as on its underlying.
 * The rule buys the 5-day low close while price is above its 50-day average and
 * exits on a 5-day high close, a 5-session timer, or a -7% stop.
 */

import { loadDailyMany, writeOut, type Bar } from "./_load.ts";
import { runDailyRule } from "./_daily.ts";
import { summarise, equityStats, buyAndHold, splitIsOos, sma, r3, COST, costInR, type Trade } from "./_stats.ts";
import { baselineForward } from "./_daily.ts";

const FROM = "2021-09-07";
const OOS = "2025-09-07";
const PAIRS: Array<[string, string]> = [["TQQQ", "QQQ"], ["SOXL", "SOXX"], ["UPRO", "SPY"], ["TNA", "IWM"]];
const STOP = 7;

function slice(bars: Bar[], from: string) { return bars.filter((bar) => bar.date >= from); }

function makeRule(bars: Bar[], lowest: number, smaPeriod: number) {
  const closes = bars.map((bar) => bar.close);
  const trend = sma(closes, smaPeriod);
  return {
    signal: (index: number) => {
      if (index < Math.max(lowest, smaPeriod)) return false;
      const window = closes.slice(index - lowest + 1, index + 1);
      return closes[index] <= Math.min(...window) && trend[index] !== null && closes[index] > trend[index]!;
    },
    exitSignal: (index: number) => {
      if (index < lowest) return false;
      return closes[index] > Math.max(...closes.slice(index - lowest, index));
    },
  };
}

type Cell = { lowest: number; smaPeriod: number; signalSource: "self" | "underlying"; all: ReturnType<typeof summarise>; is: ReturnType<typeof summarise>; oos: ReturnType<typeof summarise>; equity: Record<string, unknown> };

async function main() {
  const symbols = [...new Set(PAIRS.flat())];
  console.error("loading daily bars…");
  const data = await loadDailyMany(symbols, "6y");
  const cells: Cell[] = [];
  const detail: Record<string, unknown> = {};

  for (const signalSource of ["self", "underlying"] as const) {
    for (const lowest of [3, 5, 10]) {
      for (const smaPeriod of [20, 50, 100]) {
        const pooled: Trade[] = [];
        const perSymbol: Record<string, unknown> = {};
        for (const [leveraged, underlying] of PAIRS) {
          const fillBars = data.get(leveraged);
          const signalBars = signalSource === "self" ? fillBars : data.get(underlying);
          if (!fillBars || !signalBars) continue;
          const signalSlice = slice(signalBars, FROM);
          const fillSlice = slice(fillBars, FROM);
          const rule = makeRule(signalSlice, lowest, smaPeriod);
          const trades = runDailyRule(leveraged, signalSlice, {
            signal: rule.signal, exitSignal: rule.exitSignal, maxSessions: 5, stopLossPct: STOP,
            singlePosition: true, fillOn: signalSource === "self" ? undefined : fillSlice,
          });
          pooled.push(...trades);
          const years = fillSlice.length / 252;
          perSymbol[leveraged] = { ...summarise(trades, fillSlice.length), ...equityStats(trades, years), buyHold: buyAndHold(fillSlice, years) };
        }
        pooled.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
        const sessions = slice(data.get("TQQQ") ?? [], FROM).length;
        const split = splitIsOos(pooled, OOS);
        const years = sessions / 252;
        const cell: Cell = {
          lowest, smaPeriod, signalSource,
          all: summarise(pooled, sessions * PAIRS.length),
          is: summarise(split.is, 0),
          oos: summarise(split.oos, 0),
          equity: { perSymbol },
        };
        cells.push(cell);
        if (lowest === 5 && smaPeriod === 50) detail[`${signalSource}-base`] = { perSymbol, trades: pooled.length, years: r3(years) };
      }
    }
  }

  // Control: same rule with the trend filter removed.
  const noTrend: Trade[] = [];
  for (const [leveraged] of PAIRS) {
    const bars = data.get(leveraged);
    if (!bars) continue;
    const s = slice(bars, FROM);
    const closes = s.map((b) => b.close);
    noTrend.push(...runDailyRule(leveraged, s, {
      signal: (i) => i >= 5 && closes[i] <= Math.min(...closes.slice(i - 4, i + 1)),
      exitSignal: (i) => i >= 5 && closes[i] > Math.max(...closes.slice(i - 5, i)),
      maxSessions: 5, stopLossPct: STOP, singlePosition: true,
    }));
  }
  // Control: unconditional 5-session hold on the same instruments.
  const unconditional: Trade[] = [];
  for (const [leveraged] of PAIRS) {
    const bars = data.get(leveraged);
    if (bars) unconditional.push(...baselineForward(leveraged, slice(bars, FROM), 5));
  }

  const report = {
    hypothesis: "H7 leveraged-ETF pullback in trend",
    period: { from: FROM, oosStart: OOS },
    costPct: COST, stopPct: STOP, feeInR: r3(costInR(STOP)),
    cells: cells.map((c) => ({ signalSource: c.signalSource, lowest: c.lowest, sma: c.smaPeriod, trades: c.all.trades, avgNetPct: c.all.avgNetPct, winRate: c.all.winRate, t: c.all.tStat, oosTrades: c.oos.trades, oosAvgNetPct: c.oos.avgNetPct })),
    detail,
    controls: {
      noTrendFilter: summarise(noTrend, 0),
      unconditional5Session: summarise(unconditional, 0),
    },
  };
  writeOut("h7.json", report);
  console.log(JSON.stringify(report.cells, null, 1));
  console.log("controls", JSON.stringify(report.controls, null, 1));
  console.log("base detail", JSON.stringify(detail, null, 1));
}

await main();
