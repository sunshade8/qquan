/**
 * H2 survivorship re-test. Pre-registration: docs/research/h2-survivorship-2026-10-17.md §0.
 *
 *   node --experimental-strip-types scripts/research/h2-survivorship.ts r11   # reproduce original (Yahoo cache, 11y)
 *   node --experimental-strip-types scripts/research/h2-survivorship.ts pit   # S2 vs P2 on Massive grouped daily
 *
 * PIT inputs come from h2-pit-fetch.mjs (~/.qquan/research/h2-survivorship). Nothing here touches the
 * local Parquet store, so it runs without the data runtime.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runDailyRule } from "./_daily.ts";
import { summarise, mean, tStat, r3, COST, type Trade } from "./_stats.ts";
import { universeById } from "../../lib/universe.ts";

type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };
const DIR = join(homedir(), ".qquan/research/h2-survivorship");
const STOP = 6, DROP = 6, HOLD = 5, CAP = 3;
const STATIC57 = [...new Set([...universeById("megacap")!.symbols, ...universeById("nasdaq_tech")!.symbols])];

/** Net return with an arbitrary round-trip cost (so the 2x-cost row reuses the same trades). */
const netAt = (t: Trade, cost: number) => t.grossPct - cost;
const stat = (trades: Trade[], cost = COST) => {
  const nets = trades.map((t) => netAt(t, cost));
  return { n: trades.length, avg: r3(mean(nets)) };
};

function clustered(trades: Trade[], cost = COST) {
  const byDate = new Map<string, number[]>();
  for (const t of trades) { const l = byDate.get(t.entryDate) ?? []; l.push(netAt(t, cost)); byDate.set(t.entryDate, l); }
  const perDay = [...byDate.values()].map(mean);
  return { days: perDay.length, t: r3(tStat(perDay)) };
}

/** Slot portfolio: 6 slots of 1/6 capital, entries in date order, realised P&L on exit. */
function slotMdd(trades: Trade[], cost = COST) {
  const sorted = [...trades].sort((a, b) => a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0);
  const open: Trade[] = [];
  let equity = 1, peak = 1, mdd = 0;
  const realise = (upTo: string) => {
    for (let i = open.length - 1; i >= 0; i--) if (open[i].exitDate <= upTo) {
      equity *= 1 + (netAt(open[i], cost) / 100) / 6; open.splice(i, 1);
      peak = Math.max(peak, equity); mdd = Math.max(mdd, 1 - equity / peak);
    }
  };
  for (const t of sorted) {
    realise(t.entryDate);
    if (open.length < 6) open.push(t);
  }
  realise("9999-12-31");
  return r3(mdd * 100);
}

function capPerDay(trades: Array<Trade & { depth: number }>, cap = CAP) {
  const byDate = new Map<string, Array<Trade & { depth: number }>>();
  for (const t of trades) { const l = byDate.get(t.entryDate) ?? []; l.push(t); byDate.set(t.entryDate, l); }
  const out: Trade[] = [];
  for (const list of byDate.values()) out.push(...list.sort((a, b) => a.depth - b.depth).slice(0, cap));
  return out.sort((a, b) => a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0);
}

function report(label: string, trades: Trade[], oos: string) {
  const all = summarise(trades, 0);
  const oosT = trades.filter((t) => t.entryDate >= oos);
  const isT = trades.filter((t) => t.entryDate < oos);
  const c = clustered(trades);
  return {
    label, trades: all.trades, winRate: all.winRate, avgNetPct: all.avgNetPct, clusterDays: c.days, clusterT: c.t,
    is: stat(isT).avg, isN: isT.length, oos: stat(oosT).avg, oosN: oosT.length,
    cost2x: stat(trades, COST * 2).avg, cost2xClusterT: clustered(trades, COST * 2).t, mddSlot6: slotMdd(trades),
    payoff: all.payoff, avgWin: all.avgWinPct, avgLoss: all.avgLossPct,
  };
}

function signalFor(bars: Bar[], accept: (i: number) => boolean, warmup = 3) {
  const c = bars.map((b) => b.close);
  return (i: number) => i >= warmup && (c[i] / c[i - 3] - 1) * 100 <= -DROP && accept(i);
}
/** Depth of the 3-day move on the signal bar, keyed by the entry date (next bar). */
function withDepth(symbol: string, bars: Bar[], trades: Trade[]) {
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  return trades.map((t) => {
    const i = idx.get(t.entryDate)! - 1;
    return { ...t, symbol, depth: (bars[i].close / bars[i - 3].close - 1) * 100 };
  });
}

function runUniverse(series: Map<string, Bar[]>, accept: (symbol: string, date: string) => boolean, from: string, warmup = 3) {
  const out: Array<Trade & { depth: number }> = [];
  for (const [symbol, bars] of series) {
    const s = bars.filter((b) => b.date >= from);
    if (s.length < 10) continue;
    const trades = runDailyRule(symbol, s, { signal: signalFor(s, (i) => accept(symbol, s[i].date), warmup), maxSessions: HOLD, stopLossPct: STOP });
    out.push(...withDepth(symbol, s, trades));
  }
  return out;
}

async function r11() {
  const series = new Map<string, Bar[]>();
  const missing: string[] = [];
  for (const symbol of STATIC57) {
    const f = join("scripts/research/cache", `daily-${symbol}-11y.json`);
    if (!existsSync(f)) { missing.push(symbol); continue; }
    const bars = (JSON.parse(readFileSync(f, "utf8")) as Bar[]).filter((b) => b.date >= "2015-09-07");
    if (bars.length >= 300) series.set(symbol, bars);
  }
  // original h2b (signalFactory) returns false for index < 200 even with no trend filter, hence warmup 200 here only.
  // original h2b: signal needs no trend filter; singlePosition not set; cap 3/day deepest first
  const taken = capPerDay(runUniverse(series, () => true, "2015-09-07", 200));
  const res = report("R11 original (Yahoo cache, 2015-09~2026-09)", taken, "2025-09-07");
  console.log(JSON.stringify({ symbols: series.size, missing, ...res }, null, 1));
  writeFileSync(join(DIR, "r11.json"), JSON.stringify({ symbols: series.size, missing, res }, null, 1));
}

// ---------- PIT ----------
type Row = [string, number, number, number, number, number, number | null];
function loadGrouped() {
  const dir = join(DIR, "grouped");
  const days: string[] = [];
  const byDay = new Map<string, Row[]>();
  for (const f of readdirSync(dir).sort()) {
    const rows = JSON.parse(readFileSync(join(dir, f), "utf8")) as Row[];
    if (rows.length < 1000) continue; // holiday / empty
    const d = f.slice(0, 10); days.push(d); byDay.set(d, rows);
  }
  return { days, byDay };
}
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function pit() {
  const types = new Set<string>();
  for (const type of ["CS", "ADRC"]) for (const active of ["true", "false"]) {
    const f = join(DIR, `tickers-${type}-${active}.json`);
    if (existsSync(f)) for (const r of JSON.parse(readFileSync(f, "utf8"))) types.add(r.t);
  }
  const { days, byDay } = loadGrouped();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  // per-ticker bars + per-day dollar volume
  const series = new Map<string, Bar[]>();
  const dollar = new Map<string, Map<number, number>>(); // ticker -> dayIndex -> $vol
  const closeAt = new Map<string, Map<number, number>>();
  for (const d of days) for (const [t, o, h, l, c, v] of byDay.get(d)!) {
    if (!types.has(t) || !(c > 0)) continue;
    let s = series.get(t); if (!s) { s = []; series.set(t, s); }
    s.push({ date: d, open: o, high: h, low: l, close: c, volume: v });
    let m = dollar.get(t); if (!m) { m = new Map(); dollar.set(t, m); } m.set(dayIdx.get(d)!, c * v);
    let k = closeAt.get(t); if (!k) { k = new Map(); closeAt.set(t, k); } k.set(dayIdx.get(d)!, c);
  }
  // quarterly rebalance dates (first market day of Jan/Apr/Jul/Oct) with >= 60 prior market days
  const rebal: number[] = [];
  days.forEach((d, i) => { const m = d.slice(5, 7); if (["01", "04", "07", "10"].includes(m) && (i === 0 || days[i - 1].slice(0, 7) !== d.slice(0, 7)) && i >= 60) rebal.push(i); });
  const build = (N: number) => {
    const members = new Map<number, Set<string>>(); // rebalance day idx -> set
    for (const r of rebal) {
      const scored: Array<[string, number]> = [];
      for (const [t, m] of dollar) {
        const vals: number[] = [];
        for (let i = r - 60; i < r; i++) { const v = m.get(i); if (v !== undefined) vals.push(v); }
        const px = closeAt.get(t)!.get(r - 1);
        if (vals.length < 40 || px === undefined || px < 5) continue;
        scored.push([t, median(vals)]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      members.set(r, new Set(scored.slice(0, N).map((x) => x[0])));
    }
    return members;
  };
  const memberOf = (members: Map<number, Set<string>>) => (symbol: string, date: string) => {
    const i = dayIdx.get(date)!; let r = -1;
    for (const x of rebal) if (x <= i) r = x; else break;
    return r >= 0 && members.get(r)!.has(symbol);
  };
  const first = rebal[0];
  const FROM = days[first];
  const OOS = "2025-10-17";
  const lastDay = days[days.length - 1];

  // data-end truncation guard: drop trades entered in the final HOLD market days
  const endGuard = days[days.length - 1 - HOLD];
  const sanitize = (trades: Array<Trade & { depth: number }>) => {
    const kept = trades.filter((t) => t.entryDate <= endGuard);
    const delisted = kept.filter((t) => (t.sessions ?? HOLD) < HOLD && t.tag === "time" && t.exitDate < endGuard);
    return { kept, delisted };
  };

  const static57 = new Set(STATIC57.map((s) => s.replace("-", ".")));
  const staticAccept = (symbol: string) => static57.has(symbol);
  const presentStatic = [...static57].filter((s) => series.has(s));

  const out: Record<string, unknown> = { window: { from: FROM, to: lastDay, days: days.length, rebalances: rebal.map((i) => days[i]) }, staticPresent: presentStatic.length, staticMissing: [...static57].filter((s) => !series.has(s)) };
  const variants: Array<[string, (symbol: string, date: string) => boolean]> = [
    ["S2 static57", (s) => staticAccept(s)],
    ["P2 point-in-time top57", memberOf(build(57))],
    ["P2b point-in-time top150 (supplement)", memberOf(build(150))],
  ];
  const rows: unknown[] = [];
  const extra: Record<string, unknown> = {};
  for (const [label, accept] of variants) {
    const raw = runUniverse(series, accept, FROM);
    const { kept, delisted } = sanitize(raw);
    const taken = capPerDay(kept);
    rows.push(report(label, taken, OOS));
    if (label.startsWith("P2 ")) {
      // post-hoc, exploratory (not in the pre-registration): P2 trades split by whether the name is on the static list
      const inS = taken.filter((t) => static57.has(t.symbol)), outS = taken.filter((t) => !static57.has(t.symbol));
      extra["P2 split (post-hoc)"] = { inStatic: { n: inS.length, avg: stat(inS).avg, clusterT: clustered(inS).t }, outsideStatic: { n: outS.length, avg: stat(outS).avg, clusterT: clustered(outS).t, stopRate: r3(outS.filter((t) => t.tag === "stop").length / Math.max(1, outS.length) * 100) } };
    }
    const del = taken.filter((t) => delisted.includes(t as never));
    extra[label] = { signalTradesBeforeCap: kept.length, delistTruncatedTaken: del.length, delistTruncatedAvgNet: del.length ? r3(mean(del.map((t) => netAt(t, COST)))) : null, uniqueSymbolsTraded: new Set(taken.map((t) => t.symbol)).size, stopRate: r3(taken.filter((t) => t.tag === "stop").length / Math.max(1, taken.length) * 100) };
  }
  // overlap of P2 (top57) with static57 per rebalance
  const m57 = build(57);
  out.overlapWithStatic = rebal.map((r) => ({ date: days[r], overlap: [...m57.get(r)!].filter((t) => static57.has(t)).length, outsideStatic: [...m57.get(r)!].filter((t) => !static57.has(t)).slice(0, 12) }));
  out.rows = rows; out.extra = extra;
  console.log(JSON.stringify(out, null, 1));
  writeFileSync(join(DIR, "pit.json"), JSON.stringify(out, null, 1));
}

const mode = process.argv[2];
if (mode === "r11") await r11(); else if (mode === "pit") await pit(); else throw new Error("mode: r11 | pit");
