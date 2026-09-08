/**
 * H9b. The pre-FOMC window measured on 5-minute bars.
 *
 * The daily version cannot separate the drift from the reaction, because the
 * statement lands at 14:00 ET and the daily bar closes at 16:00. These windows
 * end at 13:55, before the announcement, which is the window Lucca–Moench
 * actually measured.
 */

import { loadIntraday, writeOut } from "./_load.ts";
import { buildSessions, type Session } from "./_intraday.ts";
import { summarise, mean, r3, COST, type Trade } from "./_stats.ts";
import { fomcDates, cpiDates } from "./_events.ts";

const FROM = "2024-09-09";
const TO = "2026-09-04";
const SYMBOLS = ["SPY", "QQQ", "TQQQ"];

function priceAt(session: Session, time: string) {
  const bar = session.bars.find((candidate) => candidate.time >= time);
  return bar ? bar.open : null;
}

function closeAt(session: Session, time: string) {
  const bars = session.bars.filter((candidate) => candidate.time <= time);
  return bars.length ? bars.at(-1)!.close : null;
}

async function main() {
  const bySymbol = new Map<string, Session[]>();
  for (const symbol of SYMBOLS) bySymbol.set(symbol, buildSessions(await loadIntraday(symbol, FROM, TO, "5m"), 15, 20));
  const fomc = (await fomcDates()).filter((date) => date >= FROM && date <= TO);
  const cpi = (await cpiDates()).filter((date) => date >= FROM && date <= TO);
  console.error(`fomc in window: ${fomc.length}, cpi: ${cpi.length}`);

  const rows: unknown[] = [];
  for (const [eventName, dates] of [["FOMC", fomc], ["CPI", cpi]] as const) {
    for (const [symbol, sessions] of bySymbol) {
      const byDate = new Map(sessions.map((session) => [session.date, session]));
      const ordered = sessions.map((session) => session.date);
      for (const window of [
        { label: "T−1 14:00 → T 13:55 (24시간 창)", entryTime: "14:00", entryDay: -1, exitTime: "13:55" },
        { label: "T−1 15:55 종가 → T 13:55", entryTime: "15:55", entryDay: -1, exitTime: "13:55" },
        { label: "T 09:30 → T 13:55 (당일 오전만)", entryTime: "09:30", entryDay: 0, exitTime: "13:55" },
      ]) {
        const trades: Trade[] = [];
        for (const date of dates) {
          const index = ordered.indexOf(date);
          if (index < 1) continue;
          const entrySession = byDate.get(ordered[index + window.entryDay]);
          const exitSession = byDate.get(date);
          if (!entrySession || !exitSession) continue;
          const entryPrice = window.entryDay === 0 ? priceAt(entrySession, window.entryTime) : (window.entryTime === "15:55" ? closeAt(entrySession, "15:55") : priceAt(entrySession, window.entryTime));
          const exitPrice = closeAt(exitSession, window.exitTime);
          if (!entryPrice || !exitPrice) continue;
          const grossPct = (exitPrice / entryPrice - 1) * 100;
          trades.push({ symbol, entryDate: entrySession.date, exitDate: date, grossPct: r3(grossPct)!, netPct: Number((grossPct - COST).toFixed(4)), sessions: 0 });
        }
        const summary = summarise(trades, 0);
        rows.push({ event: eventName, symbol, window: window.label, trades: summary.trades, winRate: summary.winRate, avgGrossPct: r3(mean(trades.map((t) => t.grossPct))), avgNetPct: summary.avgNetPct, t: summary.tStat });
      }
    }
  }

  // Control: every non-event session, same clock windows.
  const eventSet = new Set([...fomc, ...cpi]);
  const controls: unknown[] = [];
  for (const [symbol, sessions] of bySymbol) {
    const ordered = sessions.map((session) => session.date);
    for (const window of [
      { label: "T−1 14:00 → T 13:55 (24시간 창)", entryTime: "14:00", entryDay: -1 },
      { label: "T−1 15:55 종가 → T 13:55", entryTime: "15:55", entryDay: -1 },
      { label: "T 09:30 → T 13:55 (당일 오전만)", entryTime: "09:30", entryDay: 0 },
    ]) {
      const trades: Trade[] = [];
      for (let index = 1; index < sessions.length; index += 1) {
        if (eventSet.has(ordered[index])) continue;
        const entrySession = sessions[index + window.entryDay];
        const entryPrice = window.entryDay === 0 ? priceAt(entrySession, window.entryTime) : (window.entryTime === "15:55" ? closeAt(entrySession, "15:55") : priceAt(entrySession, window.entryTime));
        const exitPrice = closeAt(sessions[index], "13:55");
        if (!entryPrice || !exitPrice) continue;
        const grossPct = (exitPrice / entryPrice - 1) * 100;
        trades.push({ symbol, entryDate: entrySession.date, exitDate: ordered[index], grossPct: r3(grossPct)!, netPct: Number((grossPct - COST).toFixed(4)), sessions: 0 });
      }
      const summary = summarise(trades, 0);
      controls.push({ symbol, window: window.label, trades: summary.trades, winRate: summary.winRate, avgGrossPct: r3(mean(trades.map((t) => t.grossPct))), avgNetPct: summary.avgNetPct, t: summary.tStat });
    }
  }

  const out = { hypothesis: "H9b pre-FOMC drift (5-minute)", period: { from: FROM, to: TO }, costPct: COST, eventCounts: { fomc: fomc.length, cpi: cpi.length }, rows, controls };
  writeOut("h9b.json", out);
  console.log(JSON.stringify(out, null, 1));
}

await main();
