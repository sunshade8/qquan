/**
 * H10. Fading a bounce inside a downtrend, expressed as an inverse-ETF buy.
 *
 * A long-only account can do nothing on a down day. If a two-day bounce while
 * QQQ sits below its 50-day average is short covering rather than a turn, that
 * window is buyable as SQQQ. Signal is read on the unlevered index, P&L is
 * priced on the actual inverse fund so its decay is inside the result.
 */

import { loadDailyMany, writeOut, type Bar } from "./_load.ts";
import { runDailyRule, baselineForward } from "./_daily.ts";
import { summarise, splitIsOos, sma, r3, COST, costInR, type Trade } from "./_stats.ts";

const FROM = "2021-09-07";
const OOS = "2025-09-07";
const STOP = 4;
const TAKE_PROFIT = 4;
const PAIRS: Array<[string, string]> = [["QQQ", "SQQQ"], ["SOXX", "SOXS"], ["SPY", "SPXS"]];

function slice(bars: Bar[], from: string) { return bars.filter((bar) => bar.date >= from); }

function makeSignal(bars: Bar[], bouncePct: number, regime: "below" | "above" | "any") {
  const closes = bars.map((bar) => bar.close);
  const trend = sma(closes, 50);
  return (index: number) => {
    if (index < 50 || trend[index] === null) return false;
    if (regime === "below" && closes[index] >= trend[index]!) return false;
    if (regime === "above" && closes[index] <= trend[index]!) return false;
    return (closes[index] / closes[index - 2] - 1) * 100 >= bouncePct;
  };
}

async function main() {
  const data = await loadDailyMany([...new Set(PAIRS.flat())], "6y");
  console.error(`loaded ${data.size}`);

  const sweep: unknown[] = [];
  for (const bounce of [1.5, 2, 3]) {
    for (const holding of [2, 3, 5]) {
      const pooled: Trade[] = [];
      const perPair: Record<string, unknown> = {};
      for (const [index, fund] of PAIRS) {
        const signalBars = data.get(index), fillBars = data.get(fund);
        if (!signalBars || !fillBars) continue;
        const s = slice(signalBars, FROM), f = slice(fillBars, FROM);
        const trades = runDailyRule(fund, s, { signal: makeSignal(s, bounce, "below"), maxSessions: holding, stopLossPct: STOP, takeProfitPct: TAKE_PROFIT, fillOn: f, singlePosition: true });
        pooled.push(...trades);
        perPair[fund] = summarise(trades, 0);
      }
      pooled.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
      const split = splitIsOos(pooled, OOS);
      const summary = summarise(pooled, 0);
      sweep.push({ bouncePct: bounce, holding, trades: summary.trades, winRate: summary.winRate, avgNetPct: summary.avgNetPct, t: summary.tStat, payoff: summary.payoff, isAvg: summarise(split.is, 0).avgNetPct, oosAvg: summarise(split.oos, 0).avgNetPct, oosTrades: split.oos.length, perPair: bounce === 2 && holding === 3 ? perPair : undefined });
    }
  }

  // Control: identical rule in the up regime (QQQ above SMA50).
  const upRegime: unknown[] = [];
  for (const holding of [2, 3, 5]) {
    const pooled: Trade[] = [];
    for (const [index, fund] of PAIRS) {
      const signalBars = data.get(index), fillBars = data.get(fund);
      if (!signalBars || !fillBars) continue;
      const s = slice(signalBars, FROM), f = slice(fillBars, FROM);
      pooled.push(...runDailyRule(fund, s, { signal: makeSignal(s, 2, "above"), maxSessions: holding, stopLossPct: STOP, takeProfitPct: TAKE_PROFIT, fillOn: f, singlePosition: true }));
    }
    const summary = summarise(pooled, 0);
    upRegime.push({ holding, trades: summary.trades, winRate: summary.winRate, avgNetPct: summary.avgNetPct, t: summary.tStat });
  }

  // Control: unconditional 3-session hold of the inverse funds over the same window.
  const unconditional: Trade[] = [];
  for (const [, fund] of PAIRS) { const bars = data.get(fund); if (bars) unconditional.push(...baselineForward(fund, slice(bars, FROM), 3)); }

  // How much of any result is just the inverse fund's own drift?
  const drift: Record<string, unknown> = {};
  for (const [, fund] of PAIRS) {
    const bars = slice(data.get(fund) ?? [], FROM);
    if (bars.length > 2) drift[fund] = { totalPct: r3((bars.at(-1)!.close / bars[0].close - 1) * 100), sessions: bars.length };
  }

  const report = { hypothesis: "H10 downtrend bounce fade via inverse ETF", period: { from: FROM, oosStart: OOS }, costPct: COST, stopPct: STOP, takeProfitPct: TAKE_PROFIT, feeInR: r3(costInR(STOP)), sweep, upRegime, unconditional3Session: summarise(unconditional, 0), inverseFundDrift: drift };
  writeOut("h10.json", report);
  console.log(JSON.stringify(report, null, 1));
}

await main();
