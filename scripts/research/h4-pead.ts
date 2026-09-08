/**
 * H4. Post-earnings-announcement drift, positive reactions only.
 *
 * A different question from the rejected "does an earnings day reach 2%" test:
 * conditional on a large positive first-day reaction that closes near its high,
 * does institutional rebalancing keep pushing for another week or two?
 *
 * Reaction dates come from EDGAR item-2.02 8-K filings with their acceptance
 * timestamps, so an after-close release is anchored to the next session — the
 * first session that could actually trade the news.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDailyMany, writeOut, sleep, type Bar } from "./_load.ts";
import { summarise, mean, r3, COST, costInR, type Trade } from "./_stats.ts";
import { universeById } from "../../lib/universe.ts";
import { fetchEarningsHistory } from "../../lib/earnings-dates.ts";

process.env.SEC_USER_AGENT ??= "QQuant Research stevenpark119@gmail.com";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache", "earnings.json");
const FROM = "2021-09-01";
const TO = "2026-09-05";
const OOS = "2025-09-07";
const STOP = 5;

type ReactionAnchor = { symbol: string; reactionDate: string; timing: string };

async function loadEarnings(symbols: string[]): Promise<ReactionAnchor[]> {
  const cached: Record<string, ReactionAnchor[]> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  let changed = false;
  for (const symbol of symbols) {
    if (cached[symbol]) continue;
    try {
      const history = await fetchEarningsHistory(symbol, FROM, TO);
      cached[symbol] = history.releases.map((release) => ({ symbol, reactionDate: release.reactionDate, timing: release.timing }));
      console.error(`  ${symbol}: ${history.releases.length} releases${history.truncated ? " (truncated)" : ""}`);
    } catch (error) {
      cached[symbol] = [];
      console.error(`  ${symbol}: ${(error as Error).message}`);
    }
    changed = true;
    await sleep(160);
  }
  if (changed) writeFileSync(CACHE, JSON.stringify(cached));
  return symbols.flatMap((symbol) => cached[symbol] ?? []);
}

/** First trading session on or after `date` in this symbol's own bars. */
function anchorIndex(bars: Bar[], date: string) {
  const index = bars.findIndex((bar) => bar.date >= date);
  return index;
}

type Event = { symbol: string; index: number; date: string; reactionPct: number; rangePosition: number };

function eventsFor(symbol: string, bars: Bar[], anchors: ReactionAnchor[]): Event[] {
  const events: Event[] = [];
  for (const anchor of anchors) {
    const index = anchorIndex(bars, anchor.reactionDate);
    if (index <= 0 || index >= bars.length - 1) continue;
    const bar = bars[index];
    const span = bar.high - bar.low;
    events.push({
      symbol, index, date: bar.date,
      reactionPct: (bar.close / bars[index - 1].close - 1) * 100,
      rangePosition: span > 0 ? (bar.close - bar.low) / span : 0.5,
    });
  }
  return events;
}

/** Holds from `entryOffset` sessions after the reaction bar, with a stop. */
function tradeFrom(symbol: string, bars: Bar[], event: Event, entryOffset: number, holding: number): Trade | null {
  const entryIndex = event.index + entryOffset;
  if (entryIndex >= bars.length - 1) return null;
  const entryPrice = bars[entryIndex].close;
  const stopPrice = entryPrice * (1 - STOP / 100);
  let exitIndex = entryIndex, exitPrice = entryPrice;
  for (let step = 1; step <= holding; step += 1) {
    const cursor = entryIndex + step;
    if (cursor >= bars.length) break;
    exitIndex = cursor;
    if (bars[cursor].low <= stopPrice) { exitPrice = stopPrice; break; }
    exitPrice = bars[cursor].close;
  }
  if (exitIndex === entryIndex) return null;
  const grossPct = (exitPrice / entryPrice - 1) * 100;
  return { symbol, entryDate: bars[entryIndex].date, exitDate: bars[exitIndex].date, grossPct: r3(grossPct)!, netPct: Number((grossPct - COST).toFixed(4)), stopPct: STOP, sessions: exitIndex - entryIndex };
}

async function main() {
  const symbols = [...new Set([...universeById("nasdaq_tech")!.symbols, ...universeById("semis")!.symbols, ...universeById("software")!.symbols])];
  console.error(`loading earnings for ${symbols.length} symbols…`);
  const anchors = await loadEarnings(symbols);
  const data = await loadDailyMany(symbols, "6y");
  console.error(`bars for ${data.size}, ${anchors.length} anchors`);

  const byS = new Map<string, ReactionAnchor[]>();
  for (const anchor of anchors) { const list = byS.get(anchor.symbol); if (list) list.push(anchor); else byS.set(anchor.symbol, [anchor]); }

  const allEvents: Event[] = [];
  for (const [symbol, bars] of data) allEvents.push(...eventsFor(symbol, bars.filter((b) => b.date >= FROM), byS.get(symbol) ?? []));

  const sweep: unknown[] = [];
  for (const direction of [1, -1] as const) {
    for (const threshold of [3, 5, 8]) {
      for (const holding of [5, 10, 20]) {
        for (const entryOffset of [0, 1]) {
          const picked = allEvents.filter((event) => direction === 1
            ? event.reactionPct >= threshold && event.rangePosition >= 0.75
            : event.reactionPct <= -threshold && event.rangePosition <= 0.25);
          const trades: Trade[] = [];
          for (const event of picked) {
            const bars = (data.get(event.symbol) ?? []).filter((b) => b.date >= FROM);
            const trade = tradeFrom(event.symbol, bars, event, entryOffset, holding);
            if (trade) trades.push(trade);
          }
          trades.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
          const summary = summarise(trades, 0);
          sweep.push({
            direction: direction === 1 ? "positive" : "negative", thresholdPct: threshold, holding, entry: entryOffset === 0 ? "반응일 종가" : "다음 종가",
            trades: summary.trades, winRate: summary.winRate, avgNetPct: summary.avgNetPct, t: summary.tStat, payoff: summary.payoff,
            isAvg: summarise(trades.filter((t) => t.entryDate < OOS), 0).avgNetPct,
            oosAvg: summarise(trades.filter((t) => t.entryDate >= OOS), 0).avgNetPct,
            oosTrades: trades.filter((t) => t.entryDate >= OOS).length,
          });
        }
      }
    }
  }

  // Control: non-earnings +5% days closing in the top quarter of their range.
  const earningsDates = new Set(allEvents.map((event) => `${event.symbol}|${event.date}`));
  const controls: unknown[] = [];
  for (const holding of [5, 10, 20]) {
    const trades: Trade[] = [];
    for (const [symbol, raw] of data) {
      const bars = raw.filter((b) => b.date >= FROM);
      for (let index = 1; index < bars.length - 1; index += 1) {
        if (earningsDates.has(`${symbol}|${bars[index].date}`)) continue;
        const bar = bars[index];
        const span = bar.high - bar.low;
        if ((bar.close / bars[index - 1].close - 1) * 100 < 5) continue;
        if (!(span > 0) || (bar.close - bar.low) / span < 0.75) continue;
        const trade = tradeFrom(symbol, bars, { symbol, index, date: bar.date, reactionPct: 0, rangePosition: 1 }, 0, holding);
        if (trade) trades.push(trade);
      }
    }
    const summary = summarise(trades, 0);
    controls.push({ holding, trades: summary.trades, winRate: summary.winRate, avgNetPct: summary.avgNetPct, t: summary.tStat });
  }

  // Unconditional forward hold on the same universe and window.
  const unconditional: unknown[] = [];
  for (const holding of [5, 10, 20]) {
    const values: number[] = [];
    for (const [, raw] of data) {
      const bars = raw.filter((b) => b.date >= FROM);
      for (let index = 0; index + holding < bars.length; index += 1) values.push((bars[index + holding].close / bars[index].close - 1) * 100 - COST);
    }
    unconditional.push({ holding, n: values.length, avgNetPct: r3(mean(values)) });
  }

  const report = {
    hypothesis: "H4 PEAD positive reaction", period: { from: FROM, to: TO, oosStart: OOS }, costPct: COST, stopPct: STOP, feeInR: r3(costInR(STOP)),
    symbolsWithEarnings: [...byS.entries()].filter(([, v]) => v.length).length, totalReactions: allEvents.length,
    symbolsWithoutEarnings: symbols.filter((s) => !(byS.get(s) ?? []).length),
    sweep, controls, unconditional,
  };
  writeOut("h4.json", report);
  console.log(JSON.stringify({ symbolsWithEarnings: report.symbolsWithEarnings, totalReactions: report.totalReactions, missing: report.symbolsWithoutEarnings, controls, unconditional }, null, 1));
}

await main();
