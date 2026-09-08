/**
 * H1. Overnight premium — buy the close, sell the next open.
 *
 * Twenty years of literature says US equity returns accrue mostly between the
 * close and the next open while the regular session is flat. The question here
 * is not whether the pattern exists but whether it is bigger than 0.2308%,
 * which is what a daily round trip costs this account.
 */

import { loadDailyMany, writeOut, type Bar } from "./_load.ts";
import { summarise, mean, tStat, sma, r3, COST, type Trade } from "./_stats.ts";

const FROM = "2015-09-07";
const OOS = "2025-09-07";
const SYMBOLS = ["NVDA", "TSLA", "PLTR", "AMD", "COIN", "MSTR", "TQQQ", "SOXL"];

function slice(bars: Bar[], from: string) { return bars.filter((bar) => bar.date >= from); }

type Filter = { label: string; smaPeriod: number | null; rangePosition: number | null };

function overnightTrades(symbol: string, bars: Bar[], filter: Filter): Trade[] {
  const closes = bars.map((bar) => bar.close);
  const trend = filter.smaPeriod ? sma(closes, filter.smaPeriod) : null;
  const trades: Trade[] = [];
  for (let index = 0; index < bars.length - 1; index += 1) {
    const bar = bars[index];
    if (trend && (trend[index] === null || bar.close <= trend[index]!)) continue;
    if (filter.rangePosition !== null) {
      const span = bar.high - bar.low;
      if (!(span > 0) || (bar.close - bar.low) / span < filter.rangePosition) continue;
    }
    const grossPct = (bars[index + 1].open / bar.close - 1) * 100;
    trades.push({ symbol, entryDate: bar.date, exitDate: bars[index + 1].date, grossPct: r3(grossPct)!, netPct: Number((grossPct - COST).toFixed(4)), sessions: 0, tag: filter.label });
  }
  return trades;
}

function intradayTrades(symbol: string, bars: Bar[]): Trade[] {
  return bars.map((bar) => ({ symbol, entryDate: bar.date, exitDate: bar.date, grossPct: r3((bar.close / bar.open - 1) * 100)!, netPct: Number(((bar.close / bar.open - 1) * 100 - COST).toFixed(4)), sessions: 0, tag: "intraday" }));
}

function clustered(trades: Trade[]) {
  const byDate = new Map<string, number[]>();
  for (const trade of trades) { const list = byDate.get(trade.entryDate); if (list) list.push(trade.netPct); else byDate.set(trade.entryDate, [trade.netPct]); }
  const perDay = [...byDate.values()].map((values) => mean(values));
  return { days: perDay.length, t: r3(tStat(perDay)) };
}

async function main() {
  const data = await loadDailyMany(SYMBOLS, "11y");
  const filters: Filter[] = [
    { label: "(a) 무필터", smaPeriod: null, rangePosition: null },
    { label: "(b) 레인지 상위 30%", smaPeriod: null, rangePosition: 0.7 },
    { label: "(c) 종가>SMA20", smaPeriod: 20, rangePosition: null },
  ];
  for (const smaPeriod of [10, 20, 50]) for (const rangePosition of [0.6, 0.7, 0.8]) filters.push({ label: `SMA${smaPeriod} × 레인지 ${rangePosition}`, smaPeriod, rangePosition });

  const pooledRows: unknown[] = [];
  const perSymbol: Record<string, unknown> = {};

  for (const filter of filters) {
    const pooled: Trade[] = [];
    for (const symbol of SYMBOLS) {
      const bars = slice(data.get(symbol) ?? [], FROM);
      if (bars.length < 250) continue;
      pooled.push(...overnightTrades(symbol, bars, filter));
    }
    pooled.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
    const summary = summarise(pooled, 0);
    const isTrades = pooled.filter((t) => t.entryDate < OOS);
    const oosTrades = pooled.filter((t) => t.entryDate >= OOS);
    const gross = mean(pooled.map((t) => t.grossPct));
    pooledRows.push({
      filter: filter.label, trades: summary.trades, winRate: summary.winRate,
      avgGrossPct: r3(gross), avgNetPct: summary.avgNetPct, pooledT: summary.tStat, clusteredT: clustered(pooled).t,
      isAvg: summarise(isTrades, 0).avgNetPct, oosAvg: summarise(oosTrades, 0).avgNetPct, oosTrades: oosTrades.length,
      costOverAbsMove: r3(COST / mean(pooled.map((t) => Math.abs(t.grossPct)))),
    });
  }

  // Per symbol, unfiltered, plus the intraday control.
  for (const symbol of SYMBOLS) {
    const bars = slice(data.get(symbol) ?? [], FROM);
    if (bars.length < 250) continue;
    const overnight = overnightTrades(symbol, bars, filters[0]);
    const intraday = intradayTrades(symbol, bars);
    perSymbol[symbol] = {
      sessions: bars.length, from: bars[0].date,
      overnightGrossPct: r3(mean(overnight.map((t) => t.grossPct))),
      overnightNetPct: r3(mean(overnight.map((t) => t.netPct))),
      overnightT: r3(tStat(overnight.map((t) => t.grossPct))),
      overnightAbsMovePct: r3(mean(overnight.map((t) => Math.abs(t.grossPct)))),
      intradayGrossPct: r3(mean(intraday.map((t) => t.grossPct))),
      totalDailyGrossPct: r3(mean(overnight.map((t) => t.grossPct)) + mean(intraday.map((t) => t.grossPct))),
      overnightShareOfTotalPct: r3((mean(overnight.map((t) => t.grossPct)) / (mean(overnight.map((t) => t.grossPct)) + mean(intraday.map((t) => t.grossPct)))) * 100),
    };
  }

  const report = { hypothesis: "H1 overnight premium", period: { from: FROM, oosStart: OOS }, costPct: COST, filters: pooledRows, perSymbol };
  writeOut("h1.json", report);
  console.log(JSON.stringify(report, null, 1));
}

await main();
