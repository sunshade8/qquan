/**
 * H6. First-hour flush, then a VWAP reclaim.
 *
 * When a high-beta name is pushed 1.5% below its open inside the first hour and
 * then closes a bar back above VWAP, the morning's forced selling — stops, hedge
 * unwinds — is arguably done. The stop goes under the session low, which is wide
 * enough (over 1%) that the 0.2308% round trip is a fifth of one R rather than a
 * half.
 */

import { loadIntraday, writeOut } from "./_load.ts";
import { buildSessions, vwapSeries, minutesOf, type Session } from "./_intraday.ts";
import { summarise, mean, r3, COST, type Trade } from "./_stats.ts";

const FROM = "2024-09-09";
const TO = "2026-09-04";
const OOS = "2026-03-04";
const SYMBOLS = ["NVDA", "TSLA", "AMD", "COIN", "PLTR"];
const FLUSH_DEADLINE = "10:30";
const EXIT_TIME = "15:55";

type Outcome = { trade: Trade | null; skip: string; stopPct: number | null };

/**
 * One trade per session. Everything the entry uses — the flush, the running low,
 * VWAP — is known at the close of the signal bar; the fill is the next bar's open.
 */
function scan(session: Session, dropPct: number, recoveryEnd: string, requireVwap: boolean): Outcome {
  const bars = session.bars;
  const vwap = vwapSeries(bars);
  const trigger = session.open * (1 - dropPct / 100);

  let flushIndex = -1;
  for (let index = 0; index < bars.length; index += 1) {
    if (bars[index].time >= FLUSH_DEADLINE) break;
    if (bars[index].low <= trigger) { flushIndex = index; break; }
  }
  if (flushIndex < 0) return { trade: null, skip: "10:30 이전 급락 없음", stopPct: null };

  let runningLow = Math.min(...bars.slice(0, flushIndex + 1).map((bar) => bar.low));
  for (let index = flushIndex + 1; index < bars.length; index += 1) {
    const bar = bars[index];
    runningLow = Math.min(runningLow, bar.low);
    if (bar.time < FLUSH_DEADLINE) continue;
    if (bar.time >= recoveryEnd) break;
    if (requireVwap && !(bar.close > vwap[index])) continue;

    const entryBar = bars[index + 1];
    if (!entryBar) break;
    const entryPrice = entryBar.open;
    const stopPrice = runningLow * 0.999;
    if (!(entryPrice > stopPrice)) continue;
    const riskPct = ((entryPrice - stopPrice) / entryPrice) * 100;
    // Target is whichever comes first: the session open, or two units of risk.
    const targetPrice = Math.min(session.open, entryPrice + (entryPrice - stopPrice) * 2);
    if (!(targetPrice > entryPrice)) return { trade: null, skip: "진입가가 이미 목표 위", stopPct: riskPct };

    let exitPrice = bars.at(-1)!.close;
    for (let cursor = index + 1; cursor < bars.length; cursor += 1) {
      const candidate = bars[cursor];
      if (candidate.low <= stopPrice) { exitPrice = stopPrice; break; }
      if (candidate.high >= targetPrice) { exitPrice = targetPrice; break; }
      if (minutesOf(candidate.time) >= minutesOf(EXIT_TIME)) { exitPrice = candidate.close; break; }
    }
    const grossPct = (exitPrice / entryPrice - 1) * 100;
    return { trade: { symbol: "", entryDate: session.date, exitDate: session.date, grossPct: r3(grossPct)!, netPct: Number((grossPct - COST).toFixed(4)), stopPct: riskPct, sessions: 0 }, skip: "", stopPct: riskPct };
  }
  return { trade: null, skip: "회복 조건 미충족", stopPct: null };
}

function report(trades: Trade[], sessions: number) {
  const summary = summarise(trades, sessions);
  const wins = trades.filter((t) => t.netPct > 0), losses = trades.filter((t) => t.netPct <= 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const payoff = losses.length && mean(losses.map((t) => t.netPct)) < 0 ? mean(wins.map((t) => t.netPct)) / Math.abs(mean(losses.map((t) => t.netPct))) : 0;
  return {
    ...summary,
    expectancyR: r3(winRate * payoff - (1 - winRate)),
    isAvg: summarise(trades.filter((t) => t.entryDate < OOS), 0).avgNetPct,
    oosAvg: summarise(trades.filter((t) => t.entryDate >= OOS), 0).avgNetPct,
    oosTrades: trades.filter((t) => t.entryDate >= OOS).length,
  };
}

async function main() {
  const bySymbol = new Map<string, Session[]>();
  for (const symbol of SYMBOLS) bySymbol.set(symbol, buildSessions(await loadIntraday(symbol, FROM, TO, "5m"), 15, 20));
  for (const [symbol, sessions] of bySymbol) console.error(`${symbol}: ${sessions.length} sessions`);
  const totalSessions = [...bySymbol.values()].reduce((sum, list) => sum + list.length, 0);

  const sweep: unknown[] = [];
  for (const dropPct of [1, 1.5, 2]) {
    for (const recoveryEnd of ["11:00", "12:00", "13:00"]) {
      for (const requireVwap of [true, false]) {
        const trades: Trade[] = [];
        let flushDays = 0;
        for (const [symbol, sessions] of bySymbol) {
          for (const session of sessions) {
            const result = scan(session, dropPct, recoveryEnd, requireVwap);
            if (result.skip !== "10:30 이전 급락 없음") flushDays += 1;
            if (result.trade) trades.push({ ...result.trade, symbol });
          }
        }
        trades.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
        sweep.push({ dropPct, recoveryEnd, vwapRequired: requireVwap, flushSessions: flushDays, ...report(trades, totalSessions) });
      }
    }
  }

  // Per symbol at the base cell, to see whether one name carries the result.
  const perSymbol: Record<string, unknown> = {};
  for (const [symbol, sessions] of bySymbol) {
    const trades: Trade[] = [];
    for (const session of sessions) { const result = scan(session, 1.5, "13:00", true); if (result.trade) trades.push({ ...result.trade, symbol }); }
    perSymbol[symbol] = report(trades, sessions.length);
  }

  const out = { hypothesis: "H6 first-hour flush and VWAP reclaim", period: { from: FROM, to: TO, oosStart: OOS }, costPct: COST, totalSessions, sweep, perSymbol };
  writeOut("h6.json", out);
  console.log(JSON.stringify({ totalSessions, perSymbol }, null, 1));
}

await main();
