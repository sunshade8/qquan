/**
 * H9. Pre-FOMC drift.
 *
 * Lucca–Moench (2015) found the S&P gaining ~0.3-0.5% in the 24 hours before an
 * FOMC announcement, with later work reporting the effect faded after 2015.
 * Since the announcement lands at 14:00 ET, the daily version (T-1 close to T
 * close) also carries the reaction; the honest pre-announcement window needs
 * intraday bars and is measured separately in h9b.
 */

import { loadDailyMany, writeOut, type Bar } from "./_load.ts";
import { summarise, mean, r3, COST, type Trade } from "./_stats.ts";
import { fomcDates, cpiDates, nfpDates } from "./_events.ts";

const FROM = "2015-09-07";
const OOS = "2021-09-07";
const SYMBOLS = ["SPY", "QQQ", "TQQQ"];

function slice(bars: Bar[], from: string) { return bars.filter((bar) => bar.date >= from); }

/** Index of the first session on or after `date`; -1 when the date is past the data. */
function sessionIndex(bars: Bar[], date: string) {
  const index = bars.findIndex((bar) => bar.date >= date);
  return index;
}

type Window = { label: string; entryOffset: number; exitOffset: number };
const WINDOWS: Window[] = [
  { label: "T−1 종가 → T 종가 (발표 포함)", entryOffset: -1, exitOffset: 0 },
  { label: "T−2 종가 → T−1 종가 (발표 전날만)", entryOffset: -2, exitOffset: -1 },
  { label: "T−2 종가 → T 종가", entryOffset: -2, exitOffset: 0 },
  { label: "T 종가 → T+1 종가 (발표 후)", entryOffset: 0, exitOffset: 1 },
];

function eventTrades(symbol: string, bars: Bar[], dates: string[], window: Window): Trade[] {
  const trades: Trade[] = [];
  for (const date of dates) {
    const anchor = sessionIndex(bars, date);
    if (anchor <= 2 || anchor >= bars.length - 2) continue;
    if (bars[anchor].date !== date) continue; // event fell on a holiday
    const entry = anchor + window.entryOffset, exit = anchor + window.exitOffset;
    if (entry < 0 || exit >= bars.length || exit <= entry) continue;
    const grossPct = (bars[exit].close / bars[entry].close - 1) * 100;
    trades.push({ symbol, entryDate: bars[entry].date, exitDate: bars[exit].date, grossPct: r3(grossPct)!, netPct: Number((grossPct - COST).toFixed(4)), sessions: exit - entry, tag: window.label });
  }
  return trades;
}

async function main() {
  const data = await loadDailyMany(SYMBOLS, "11y");
  const fomc = (await fomcDates()).filter((date) => date >= FROM && date <= "2026-09-03");
  const cpi = (await cpiDates()).filter((date) => date >= FROM && date <= "2026-09-03");
  const nfp = (await nfpDates()).filter((date) => date >= FROM && date <= "2026-09-03");
  console.error(`fomc ${fomc.length} cpi ${cpi.length} nfp ${nfp.length}`);

  const rows: unknown[] = [];
  for (const [eventName, dates] of [["FOMC", fomc], ["CPI", cpi], ["NFP", nfp]] as const) {
    for (const window of WINDOWS) {
      for (const symbol of SYMBOLS) {
        const bars = slice(data.get(symbol) ?? [], FROM);
        const trades = eventTrades(symbol, bars, dates as string[], window);
        const summary = summarise(trades, 0);
        rows.push({
          event: eventName, window: window.label, symbol, trades: summary.trades, winRate: summary.winRate,
          avgGrossPct: r3(mean(trades.map((t) => t.grossPct))), avgNetPct: summary.avgNetPct, t: summary.tStat,
          isAvg: summarise(trades.filter((t) => t.entryDate < OOS), 0).avgNetPct,
          oosAvg: summarise(trades.filter((t) => t.entryDate >= OOS), 0).avgNetPct,
          oosTrades: trades.filter((t) => t.entryDate >= OOS).length,
        });
      }
    }
  }

  // Control: Wednesdays with no FOMC announcement, same window shape.
  const fomcSet = new Set(fomc);
  const controls: unknown[] = [];
  for (const symbol of SYMBOLS) {
    const bars = slice(data.get(symbol) ?? [], FROM);
    const wednesdays = bars.filter((bar) => new Date(`${bar.date}T12:00:00Z`).getUTCDay() === 3 && !fomcSet.has(bar.date)).map((bar) => bar.date);
    for (const window of WINDOWS.slice(0, 2)) {
      const trades = eventTrades(symbol, bars, wednesdays, window);
      const summary = summarise(trades, 0);
      controls.push({ symbol, window: window.label, trades: summary.trades, winRate: summary.winRate, avgGrossPct: r3(mean(trades.map((t) => t.grossPct))), avgNetPct: summary.avgNetPct, t: summary.tStat });
    }
  }

  const report = { hypothesis: "H9 pre-FOMC drift (daily)", period: { from: FROM, oosStart: OOS }, costPct: COST, eventCounts: { fomc: fomc.length, cpi: cpi.length, nfp: nfp.length }, rows, controls };
  writeOut("h9.json", report);
  console.log(JSON.stringify(report.eventCounts));
}

await main();
