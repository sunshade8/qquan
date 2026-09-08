/**
 * H5. Opening-range breakout, restricted to quiet mornings.
 *
 * The hardest result on file is that high relative volume roughly doubles the
 * whipsaw rate — a session reaching both a long and a short target. That says
 * nothing about direction, but it says a great deal about which mornings a
 * breakout survives. So the rule is not "predict the break", it is "only take
 * the break on days where breaks tend not to fail".
 */

import { loadIntraday, writeOut } from "./_load.ts";
import { buildSessions, minutesOf, type Session } from "./_intraday.ts";
import { summarise, mean, r3, COST, costInR, type Trade } from "./_stats.ts";

const FROM = "2024-09-09";
const TO = "2026-09-04";
const OOS = "2026-03-04"; // last 6 months held out
const SYMBOLS = ["NVDA", "TSLA", "AMD"];
const ANCHOR_END = "09:45";
const SCAN_END = "11:00";
const MIN_RISK_PCT = 0.8; // below this the round trip eats too much of one R

type Setup = { date: string; entryTime: string; entryPrice: number; stopPrice: number; riskPct: number; relativeVolume: number | null };

/** At most one trade per session: the first 5-minute close above the opening range high. */
function scan(session: Session, rewardRisk: number): { setup: Setup | null; trade: Trade | null; skip: string | null } {
  const anchor = session.bars.filter((bar) => bar.time < ANCHOR_END);
  if (anchor.length < 3) return { setup: null, trade: null, skip: "기준 캔들 부족" };
  const referenceHigh = Math.max(...anchor.map((bar) => bar.high));
  const referenceLow = Math.min(...anchor.map((bar) => bar.low));
  if (!(referenceHigh > referenceLow)) return { setup: null, trade: null, skip: "기준선 고저 동일" };

  const scanBars = session.bars.filter((bar) => bar.time >= ANCHOR_END && bar.time < SCAN_END);
  for (let index = 0; index < scanBars.length; index += 1) {
    if (scanBars[index].close <= referenceHigh) continue;
    const position = session.bars.findIndex((bar) => bar.timestamp === scanBars[index].timestamp);
    const entryBar = session.bars[position + 1];
    if (!entryBar) return { setup: null, trade: null, skip: "돌파 다음 봉 없음" };
    const entryPrice = entryBar.open;
    const stopPrice = referenceLow;
    const riskPct = ((entryPrice - stopPrice) / entryPrice) * 100;
    const setup: Setup = { date: session.date, entryTime: entryBar.time, entryPrice, stopPrice, riskPct, relativeVolume: session.relativeVolume };
    if (!(riskPct >= MIN_RISK_PCT)) return { setup, trade: null, skip: `손절폭 ${riskPct.toFixed(2)}% < ${MIN_RISK_PCT}%` };

    const targetPrice = entryPrice + (entryPrice - stopPrice) * rewardRisk;
    let exitPrice = session.bars.at(-1)!.close;
    for (let cursor = position + 1; cursor < session.bars.length; cursor += 1) {
      const bar = session.bars[cursor];
      // Stop wins when one bar covers both: the bar does not say which came first.
      if (bar.low <= stopPrice) { exitPrice = stopPrice; break; }
      if (bar.high >= targetPrice) { exitPrice = targetPrice; break; }
      if (minutesOf(bar.time) >= minutesOf("15:55")) { exitPrice = bar.close; break; }
    }
    const grossPct = (exitPrice / entryPrice - 1) * 100;
    return { setup, trade: { symbol: "", entryDate: session.date, exitDate: session.date, grossPct: r3(grossPct)!, netPct: Number((grossPct - COST).toFixed(4)), stopPct: riskPct, sessions: 0 }, skip: null };
  }
  return { setup: null, trade: null, skip: "11:00까지 돌파 없음" };
}

function report(trades: Trade[], sessions: number) {
  const summary = summarise(trades, sessions);
  return {
    ...summary,
    isAvg: summarise(trades.filter((t) => t.entryDate < OOS), 0).avgNetPct,
    oosAvg: summarise(trades.filter((t) => t.entryDate >= OOS), 0).avgNetPct,
    oosTrades: trades.filter((t) => t.entryDate >= OOS).length,
  };
}

async function main() {
  const bySymbol = new Map<string, Session[]>();
  for (const symbol of SYMBOLS) {
    const points = await loadIntraday(symbol, FROM, TO, "5m");
    bySymbol.set(symbol, buildSessions(points, 15, 20));
  }
  for (const [symbol, sessions] of bySymbol) console.error(`${symbol}: ${sessions.length} sessions ${sessions[0]?.date}..${sessions.at(-1)?.date}`);

  const sweep: unknown[] = [];
  const buckets: Array<{ label: string; test: (rv: number | null) => boolean }> = [
    { label: "무필터", test: () => true },
    { label: "상대거래량 ≤ 1.0", test: (rv) => rv !== null && rv <= 1.0 },
    { label: "상대거래량 ≤ 1.2", test: (rv) => rv !== null && rv <= 1.2 },
    { label: "상대거래량 ≤ 1.5", test: (rv) => rv !== null && rv <= 1.5 },
    { label: "상대거래량 ≥ 1.5 (대조군)", test: (rv) => rv !== null && rv >= 1.5 },
  ];

  for (const bucket of buckets) {
    for (const rewardRisk of [1.5, 2, 3]) {
      const trades: Trade[] = [];
      let eligible = 0, skippedThin = 0, noBreak = 0;
      for (const [symbol, sessions] of bySymbol) {
        for (const session of sessions) {
          if (!bucket.test(session.relativeVolume)) continue;
          eligible += 1;
          const result = scan(session, rewardRisk);
          if (result.trade) trades.push({ ...result.trade, symbol });
          else if (result.skip?.startsWith("손절폭")) skippedThin += 1;
          else noBreak += 1;
        }
      }
      trades.sort((a, b) => a.entryDate < b.entryDate ? -1 : 1);
      sweep.push({ filter: bucket.label, rewardRisk, eligibleSessions: eligible, tradedSessions: trades.length, skippedThinStop: skippedThin, noBreakout: noBreak, ...report(trades, eligible) });
    }
  }

  // Whipsaw check on this sample: does the established high-volume result reproduce?
  const whipsaw: unknown[] = [];
  for (const [symbol, sessions] of bySymbol) {
    for (const label of ["low", "high"] as const) {
      const picked = sessions.filter((s) => s.relativeVolume !== null && (label === "low" ? s.relativeVolume <= 1.2 : s.relativeVolume >= 1.5));
      let both = 0;
      for (const session of picked) {
        const anchor = session.bars.filter((bar) => bar.time < ANCHOR_END);
        if (anchor.length < 3) continue;
        const high = Math.max(...anchor.map((b) => b.high)), low = Math.min(...anchor.map((b) => b.low));
        const after = session.bars.filter((bar) => bar.time >= ANCHOR_END);
        if (after.some((b) => b.high > high) && after.some((b) => b.low < low)) both += 1;
      }
      whipsaw.push({ symbol, bucket: label, sessions: picked.length, bothSidesPct: picked.length ? r3((both / picked.length) * 100) : null });
    }
  }

  // Distribution of the opening-range width, which is what sets fee-in-R.
  const widths: number[] = [];
  for (const [, sessions] of bySymbol) {
    for (const session of sessions) {
      const anchor = session.bars.filter((bar) => bar.time < ANCHOR_END);
      if (anchor.length < 3) continue;
      const high = Math.max(...anchor.map((b) => b.high)), low = Math.min(...anchor.map((b) => b.low));
      widths.push(((high - low) / low) * 100);
    }
  }
  widths.sort((a, b) => a - b);

  const meanWidth = mean(widths);
  const out = {
    hypothesis: "H5 opening-range breakout on quiet mornings", period: { from: FROM, to: TO, oosStart: OOS }, costPct: COST,
    openingRangeWidthPct: { mean: r3(meanWidth), median: r3(widths[Math.floor(widths.length / 2)]), p25: r3(widths[Math.floor(widths.length * 0.25)]), p75: r3(widths[Math.floor(widths.length * 0.75)]), belowMinRiskPct: r3((widths.filter((w) => w < MIN_RISK_PCT).length / widths.length) * 100) },
    feeInRAtMeanWidth: r3(costInR(meanWidth)),
    sweep, whipsaw,
  };
  writeOut("h5.json", out);
  console.log(JSON.stringify({ width: out.openingRangeWidthPct, feeInR: out.feeInRAtMeanWidth, whipsaw }, null, 1));
}

await main();
