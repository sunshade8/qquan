/**
 * H5 cross-check through the Lab's own engine.
 *
 * `runFvgBacktest` scores the FVG-pullback rule and its information-matched
 * control (breakout close, no gap requirement) side by side, and now accepts the
 * `maxRelativeVolume` filter this hypothesis needed. Running the same question
 * through a second, independently written implementation is the cheapest guard
 * against a bug in either one.
 */

import { loadIntraday, writeOut } from "./_load.ts";
import { runFvgBacktest, type FvgOptions } from "../../lib/intraday-fvg.ts";
import { costBps } from "../../lib/broker-costs.ts";

const SYMBOLS = ["NVDA", "TSLA", "AMD"];

async function main() {
  const base: FvgOptions = { intervalMinutes: 5, anchorMinutes: 15, windowMinutes: 90, rewardRisk: 2, costBps: costBps(), holdUntil: "session_close" };
  const rows: unknown[] = [];
  for (const symbol of SYMBOLS) {
    const points = await loadIntraday(symbol, "2024-09-09", "2026-09-04", "5m");
    for (const filter of [
      { label: "무필터", options: {} },
      { label: "상대거래량 ≤ 1.2", options: { maxRelativeVolume: 1.2 } },
      { label: "상대거래량 ≥ 1.5", options: { minRelativeVolume: 1.5 } },
    ]) {
      const result = runFvgBacktest(symbol, symbol, points as never, { ...base, ...filter.options });
      for (const summary of result.summaries) {
        rows.push({
          symbol, filter: filter.label, variant: summary.variant,
          sessionsPassed: result.filter.sessionsPassed || result.sessions,
          trades: summary.trades, winRatePct: summary.winRatePct, averageReturnPct: summary.averageReturnPct,
          averageR: summary.averageR, totalR: summary.totalR, breakevenWinRatePct: summary.breakevenWinRatePct,
        });
      }
    }
  }
  writeOut("h5b.json", { hypothesis: "H5 cross-check via lib/intraday-fvg", costBps: costBps(), rows });
  console.log(JSON.stringify(rows, null, 1));
}

await main();
