/**
 * CT ceiling: execution (maker limit orders) and direction (shorts on USDⓈ-M perpetuals)
 * (docs/research/ct-ceiling-2026-10-15-execution.md). No models, no money.
 *
 * Same method as scripts/research/ct-ceiling-field.ts (F1 31 price/volume features of the traded path, +3c/−1c labels,
 * holding caps 60/240/390/day end, expanding-window walk-forward 4 folds, depth-3 tree, leaves chosen on TRAINING
 * net > 0, one position at a time, daily mean over every validation day). What changes is the label (lib/ct-execution.ts):
 *   ST-L / UT-L   reference: taker spot long at Binance / Upbit costs (already judged in earlier reports)
 *   SM-L / UM-L   maker spot long at Binance spot / Upbit fees, on the Binance spot path
 *   FT-*  / FM-*  taker / maker on the USDⓈ-M perpetual path, 0.02% / 0.05%, funding; L, S, LS (two trees)
 * Combos that meet criteria ①–④ get the 20-run permutation baseline and the trade-through sensitivity. Every judged
 * combo is also re-run once on day-block-permuted features (the null run: chance passes of this grid).
 * Results append to ~/.qquan/cache/ceiling-execution/results.jsonl (resumable); --report writes the markdown.
 *
 *   node --experimental-strip-types --no-warnings scripts/research/ct-ceiling-execution.ts [--only=btc] [--period=1y]
 *   node --experimental-strip-types --no-warnings scripts/research/ct-ceiling-execution.ts --report
 *   add --touch for the earlier touch-fills definition (sensitivity); QQUAN_ENABLE_UPBIT=true brings back the Upbit scenarios
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { queryLocalMarket } from "../../lib/local-market-data.ts";
import type { CTBar } from "../../lib/ct-engine.ts";
import { dayInfo, moveFeatures, walkForward, type DayInfo, type MoveFeatureTable, type WalkForward } from "../../lib/ct-moves.ts";
import { labelCostPct, labelExecution, markoutBp, type ExecutionLabels, type ExecutionOptions } from "../../lib/ct-execution.ts";
import { ctSeedOf } from "../../lib/ct-trader-tools.ts";
import { permuteDayBlocks, roundTripFromSamples } from "../../lib/ct-ceiling-features.ts";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"]; }));
const ROOT = process.env.QQUAN_DATA_DIR || join(homedir(), ".qquan");
const FIELD = join(ROOT, "cache", "ceiling-field");
const CACHE = join(ROOT, "cache", "ceiling-execution");
const RESULTS = join(CACHE, "results.jsonl");
const BASE_FILE = join(CACHE, "base.jsonl");
const OUT_DOC = "docs/research/ct-ceiling-2026-10-15-execution.md";
const DAY = 86_400_000;
const END = Date.UTC(2026, 9, 13);
const REGIME_FROM = Date.UTC(2023, 2, 1);
/** Impact samples are frozen at this instant (the sampler keeps running). */
const COST_CUTOFF = Date.UTC(2026, 9, 15, 7, 0);
const K = 3, M = 1;
/** Upbit is off (docs/prompts/binance-only-limit-orders.md): its scenarios run only with QQUAN_ENABLE_UPBIT=true. Past rows stay in the report. */
const UPBIT_ENABLED = process.env.QQUAN_ENABLE_UPBIT === "true";
/**
 * Maker scenarios use the limit-only contracts' through-the-price fill rule (a bar must trade >= 1 tick THROUGH the price, a
 * touch is not a fill). The earlier "touch fills" definition (judged in ct-ceiling-2026-10-15-execution.md, fill rate 96–99%) is
 * the sensitivity run with --touch. Spot tick = 0.01 USDT; the perpetual's BTC/ETH/SOL ticks are 0.1/0.01/0.01.
 */
const TOUCH_FILLS = process.argv.includes("--touch");
const TICK: Record<string, { spot: number; perp: number }> = { BTCUSDT: { spot: 0.01, perp: 0.1 }, ETHUSDT: { spot: 0.01, perp: 0.01 }, SOLUSDT: { spot: 0.01, perp: 0.01 } };
const PERIODS = { "1y": { from: END - 365 * DAY, label: "1년" }, "3y": { from: Date.UTC(2023, 10, 1), label: "3년(2023-11-01~)" } } as const;
type Period = keyof typeof PERIODS;
const SYMBOLS = [
  { symbol: "BTCUSDT", dataset: "btc" as const, upbit: "KRW-BTC" },
  { symbol: "ETHUSDT", dataset: "eth" as const, upbit: "KRW-ETH" },
  { symbol: "SOLUSDT", dataset: "sol" as const, upbit: "KRW-SOL" },
];
const HOLDS = [["60봉", 60], ["240봉", 240], ["390봉", 390], ["당일 청산", Infinity]] as const;
type ScenarioId = "ST" | "UT" | "SM" | "UM" | "FT" | "FM";
const SCENARIOS: Record<ScenarioId, { path: "spot" | "perp"; exec: "taker" | "maker"; maker: number; taker: number; impact: "binance" | "upbit"; funding: boolean; dirs: Dir[]; reference: boolean; label: string; takerTwin?: ScenarioId }> = {
  ST: { path: "spot", exec: "taker", maker: 0.1, taker: 0.1, impact: "binance", funding: false, dirs: ["L"], reference: true, label: "현물 테이커(참조)" },
  UT: { path: "spot", exec: "taker", maker: 0.05, taker: 0.05, impact: "upbit", funding: false, dirs: ["L"], reference: true, label: "Upbit 비용 테이커(참조)" },
  SM: { path: "spot", exec: "maker", maker: 0.1, taker: 0.1, impact: "binance", funding: false, dirs: ["L"], reference: false, label: "현물 메이커", takerTwin: "ST" },
  UM: { path: "spot", exec: "maker", maker: 0.05, taker: 0.05, impact: "upbit", funding: false, dirs: ["L"], reference: false, label: "Upbit 메이커", takerTwin: "UT" },
  FT: { path: "perp", exec: "taker", maker: 0.02, taker: 0.05, impact: "binance", funding: true, dirs: ["L", "S", "LS"], reference: false, label: "선물 테이커" },
  FM: { path: "perp", exec: "maker", maker: 0.02, taker: 0.05, impact: "binance", funding: true, dirs: ["L", "S", "LS"], reference: false, label: "선물 메이커", takerTwin: "FT" },
};
type Dir = "L" | "S" | "LS";
const CRITERIA = { minTradesPerDay: 0.27, minPositiveFolds: 3, permutations: 20, maxPermutationHits: 1 };
const only = (args.only ?? "").split(",").filter(Boolean).map((x) => x.toLowerCase());
const periodsWanted = (args.period ?? "1y,3y").split(",") as Period[];
const strideFor = (n: number) => (n > 800_000 ? 6 : n > 300_000 ? 3 : 2);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/* ------------------------------------------------------------------ data */

function readF64(name: string) {
  const buf = readFileSync(join(FIELD, name));
  return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
}
async function loadSpot(dataset: "btc" | "eth" | "sol", symbol: string, from: number): Promise<CTBar[]> {
  const bars: CTBar[] = [];
  for (let cursor = from; cursor < END; cursor += 31 * DAY) {
    const page = await queryLocalMarket({ dataset, instrument: symbol, quoteCurrency: "USDT", from: cursor, to: Math.min(END, cursor + 31 * DAY), minutes: 1, session: "all" });
    bars.push(...page.bars);
  }
  const seen = new Set<number>();
  return bars.filter((b) => (seen.has(b.endMs) ? false : (seen.add(b.endMs), true))).sort((a, b) => a.endMs - b.endMs);
}
function loadPerp(symbol: string): CTBar[] {
  const c = (n: string) => readF64(`${symbol}.um_1m.${n}.f64`);
  const [s, o, h, l, cl, v] = [c("startMs"), c("open"), c("high"), c("low"), c("close"), c("volume")];
  const out: CTBar[] = [];
  for (let i = 0; i < s.length; i++) if (s[i] < END) out.push({ startMs: s[i], endMs: s[i] + 60_000, open: o[i], high: h[i], low: l[i], close: cl[i], volume: v[i] });
  return out;
}
function fundingOf(symbol: string) {
  const t = readF64(`${symbol}.funding.calcMs.f64`),
    r = readF64(`${symbol}.funding.rate.f64`);
  const order = Array.from(t, (_, i) => i).sort((a, b) => t[a] - t[b]);
  return { times: Float64Array.from(order, (i) => Math.floor(t[i] / 60_000) * 60_000), rates: Float64Array.from(order, (i) => r[i]) };
}

const db = new DatabaseSync(join(ROOT, "state", "research.sqlite"), { readOnly: true });
function impactOf(venue: "binance" | "upbit", symbol: string) {
  const rows = db.prepare("SELECT buy_bp,sell_bp FROM ct_orderbook_samples WHERE venue=? AND symbol=? AND notional_usd=1000 AND ts<=?").all(venue, symbol, COST_CUTOFF) as Array<{ buy_bp: number | null; sell_bp: number | null }>;
  const r = roundTripFromSamples(rows, 0);
  const span = db.prepare("SELECT min(ts) a, max(ts) b FROM ct_orderbook_samples WHERE venue=? AND symbol=? AND notional_usd=1000 AND ts<=?").get(venue, symbol, COST_CUTOFF) as { a: number; b: number };
  return { impactPct: (r.p90bp ?? 0) / 100, p90bp: r.p90bp, samples: r.samples, hours: Number(((span.b - span.a) / 3_600_000).toFixed(1)) };
}

/** UTC-day regime from the symbol's Binance spot daily closes: previous close above/below its SMA200 (previous 200 closes). */
function regimeMap(bars: CTBar[]) {
  const closes = new Map<number, number>();
  for (const b of bars) closes.set(Math.floor(b.startMs / DAY), b.close);
  const keys = [...closes.keys()].sort((a, b) => a - b);
  const out = new Map<number, "up" | "down">();
  keys.forEach((k, i) => {
    if (i < 200 || keys[i - 1] !== k - 1) return;
    const sma = keys.slice(i - 200, i).reduce((s, x) => s + closes.get(x)!, 0) / 200;
    out.set(k, closes.get(k - 1)! > sma ? "up" : "down");
  });
  return out;
}

/* ------------------------------------------------------------------ combos */

type Summary = { trades: number; tradesPerDay: number; dailyMeanPct: number; dailyMean2xPct: number; positiveFolds: number; criteria: { daily1x: boolean; folds: boolean; tradesPerDay: boolean; daily2x: boolean }; pass4: boolean };
type Row = {
  id: string; symbol: string; period: Period; hold: string; scenario: ScenarioId; dir: Dir; reference: boolean; path: "spot" | "perp"; exec: "taker" | "maker";
  labelCostPct: number; makerFeePct: number; takerFeePct: number; impactPct: number; bars: number; features: number; trees: number;
  trades: number; tradesPerDay: number; meanNetPct: number; dailyMeanPct: number; dailyMean2xPct: number; dailyT: number; positiveFolds: number; bestTrainLeafNetPct: number; splits: number;
  longTrades: number; shortTrades: number; fundingMeanPct: number;
  signals: number; fillRate: number | null;
  markout: { h: number; filled: number; unfilled: number; all: number; adverse: number }[] | null;
  takerCounterfactualDailyPct: number | null;
  regime: { up: { days: number; mean: number }; down: { days: number; mean: number }; none: { days: number; mean: number } };
  criteria: Summary["criteria"]; candidate: boolean;
  permutation?: { runs: number; atLeastActual: number; pass: boolean; dailyMeans: number[] };
  strict?: Omit<Summary, "pass4"> & { candidate4: boolean };
  nullRun?: Summary;
  leaves: string[];
  seconds: number;
};
const done = new Set<string>(existsSync(RESULTS) ? readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Row).id) : []);
mkdirSync(CACHE, { recursive: true });

const summarize = (wf: WalkForward): Summary => {
  const criteria = { daily1x: wf.dailyMeanPct > 0, folds: wf.positiveFolds >= CRITERIA.minPositiveFolds, tradesPerDay: wf.tradesPerDay >= CRITERIA.minTradesPerDay, daily2x: wf.dailyMean2xPct > 0 };
  return { trades: wf.trades, tradesPerDay: wf.tradesPerDay, dailyMeanPct: wf.dailyMeanPct, dailyMean2xPct: wf.dailyMean2xPct, positiveFolds: wf.positiveFolds, criteria, pass4: Object.values(criteria).every(Boolean) };
};

type Ctx = { symbol: string; period: Period; bars: CTBar[]; day: DayInfo; features: MoveFeatureTable; regimes: Map<number, "up" | "down">; stride: number; labelsOf: (sc: ScenarioId, side: 1 | -1, strict?: boolean) => ExecutionLabels; impactPct: (sc: ScenarioId) => number };

function runCombo(ctx: Ctx, sc: ScenarioId, dir: Dir, hold: string) {
  const s = SCENARIOS[sc];
  const id = `${ctx.symbol}|${ctx.period}|${hold}|${sc}-${dir}`;
  if (done.has(id)) return;
  const t0 = Date.now();
  const sideSigns: Array<1 | -1> = dir === "L" ? [1] : dir === "S" ? [-1] : [1, -1];
  const sides = sideSigns.map((x) => ctx.labelsOf(sc, x));
  const wfOf = (features: MoveFeatureTable, labels = sides) =>
    walkForward({ bars: ctx.bars, day: ctx.day, labels: labels[0], sides: labels, sideNames: sideSigns.map((x) => (x === 1 ? "L" : "S")), features, costPct: labels[0].costPct, folds: 4, depth: 3, trainStride: ctx.stride });
  const wf = wfOf(ctx.features);
  const sum = summarize(wf);
  const fills = wf.signals.filter((t) => t.filled);
  // Adverse selection of the selected signals (maker only): markout from the decision close = the fill price.
  let markout: Row["markout"] = null,
    fillRate: number | null = null,
    cf: number | null = null;
  if (s.exec === "maker") {
    fillRate = wf.signals.length ? fills.length / wf.signals.length : null;
    markout = [1, 5, 15].map((h) => {
      const mk = (filled: boolean | null) => mean(wf.signals.filter((t) => filled === null || t.filled === filled).map((t) => markoutBp(ctx.bars, ctx.day, t.row, sideSigns[t.side], h)).filter(Number.isFinite));
      const all = mk(null),
        filled = mk(true);
      return { h, filled, unfilled: mk(false), all, adverse: filled - all };
    });
    // The same selected signals, executed as a taker at the same fee table (its own target/stop), one at a time.
    const twins = sideSigns.map((x) => ctx.labelsOf(s.takerTwin!, x));
    const perDay = new Map<number, number>(wf.daily.map((d) => [d.key, 0]));
    let freeAt = -1;
    for (const t of wf.signals) {
      const lab = twins[t.side];
      if (t.row <= freeAt || lab.label[t.row] < 0) continue;
      perDay.set(t.day, (perDay.get(t.day) ?? 0) + lab.netPct[t.row]);
      freeAt = lab.exitIndex[t.row];
    }
    cf = mean([...perDay.values()]);
  }
  const bucket = { up: [] as number[], down: [] as number[], none: [] as number[] };
  for (const d of wf.daily) bucket[ctx.regimes.get(d.key) ?? "none"].push(d.net);
  const reg = (xs: number[]) => ({ days: xs.length, mean: xs.length ? mean(xs) : 0 });
  const row: Row = {
    id, symbol: ctx.symbol, period: ctx.period, hold, scenario: sc, dir, reference: s.reference, path: s.path, exec: s.exec,
    labelCostPct: sides[0].costPct, makerFeePct: s.maker, takerFeePct: s.taker, impactPct: ctx.impactPct(sc), bars: ctx.bars.length, features: ctx.features.names.length, trees: sides.length,
    trades: wf.trades, tradesPerDay: wf.tradesPerDay, meanNetPct: wf.meanNetPct, dailyMeanPct: wf.dailyMeanPct, dailyMean2xPct: wf.dailyMean2xPct, dailyT: wf.dailyT, positiveFolds: wf.positiveFolds,
    bestTrainLeafNetPct: wf.bestTrainLeafNetPct, splits: wf.candidateSplits,
    longTrades: fills.filter((t) => sideSigns[t.side] === 1).length, shortTrades: fills.filter((t) => sideSigns[t.side] === -1).length,
    fundingMeanPct: fills.length ? mean(fills.map((t) => sides[t.side].fundingPct[t.row])) : 0,
    signals: wf.signals.length, fillRate, markout, takerCounterfactualDailyPct: cf,
    regime: { up: reg(bucket.up), down: reg(bucket.down), none: reg(bucket.none) },
    criteria: sum.criteria, candidate: sum.pass4 && !s.reference,
    leaves: [...new Set(wf.folds.flatMap((f) => f.selectedLeaves))].slice(0, 6),
    seconds: 0,
  };
  const startMs = Float64Array.from(ctx.bars, (b) => b.startMs);
  const permuted = (seed: string): MoveFeatureTable => ({ names: ctx.features.names, cols: permuteDayBlocks(ctx.features.cols, ctx.day.key, startMs, ctx.day.startMs, ctSeedOf(seed)) });
  if (row.candidate) {
    const means: number[] = [];
    for (let r = 0; r < CRITERIA.permutations; r++) means.push(wfOf(permuted(`${id}:${r}`)).dailyMeanPct);
    const hits = means.filter((m) => m >= wf.dailyMeanPct).length;
    row.permutation = { runs: means.length, atLeastActual: hits, pass: hits <= CRITERIA.maxPermutationHits, dailyMeans: means.map((m) => Number(m.toFixed(5))) };
    if (s.exec === "maker") {
      const st = summarize(wfOf(ctx.features, sideSigns.map((x) => ctx.labelsOf(sc, x, true))));
      row.strict = { ...st, candidate4: st.pass4 };
    }
  }
  if (!s.reference) row.nullRun = summarize(wfOf(permuted(`${id}:null`)));
  row.seconds = (Date.now() - t0) / 1000;
  appendFileSync(RESULTS, JSON.stringify(row) + "\n");
  done.add(id);
  console.error(`  ${id}: trades ${row.trades} (${row.tradesPerDay.toFixed(2)}/일) · 일평균 ${row.dailyMeanPct.toFixed(4)}% (2x ${row.dailyMean2xPct.toFixed(4)}%) · 양수 폴드 ${row.positiveFolds}/4${fillRate !== null ? ` · 체결률 ${(fillRate * 100).toFixed(0)}%` : ""}${row.candidate ? ` · 후보! 순열 ${row.permutation!.atLeastActual}/20` : ""}${row.nullRun?.pass4 ? " · 널 통과" : ""} · ${row.seconds.toFixed(0)}s`);
}

/** Fill rate and adverse selection of a maker order at EVERY valid minute (independent of the tree), per path and side. */
function baseAdverse(ctx: Ctx, path: "spot" | "perp", side: 1 | -1) {
  const lab = ctx.labelsOf(path === "spot" ? "SM" : "FM", side);
  let valid = 0,
    filledN = 0;
  const acc = [1, 5, 15].map(() => ({ f: [0, 0], u: [0, 0], a: [0, 0] }));
  for (let i = 0; i < ctx.bars.length; i++) {
    if (lab.label[i] < 0) continue;
    valid++;
    const f = lab.filled[i] === 1;
    if (f) filledN++;
    [1, 5, 15].forEach((h, k) => {
      const m = markoutBp(ctx.bars, ctx.day, i, side, h);
      if (!Number.isFinite(m)) return;
      const a = acc[k];
      a.a[0] += m; a.a[1]++;
      if (f) { a.f[0] += m; a.f[1]++; } else { a.u[0] += m; a.u[1]++; }
    });
  }
  const rec = {
    id: `${ctx.symbol}|${ctx.period}|${path}|${side}`, symbol: ctx.symbol, period: ctx.period, path, side, valid, fillRate: filledN / Math.max(1, valid),
    markout: [1, 5, 15].map((h, k) => { const a = acc[k]; const fm = a.f[0] / a.f[1], am = a.a[0] / a.a[1]; return { h, filled: fm, unfilled: a.u[0] / a.u[1], all: am, adverse: fm - am }; }),
  };
  appendFileSync(BASE_FILE, JSON.stringify(rec) + "\n");
}

async function main() {
  const doneBase = new Set<string>(existsSync(BASE_FILE) ? readFileSync(BASE_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
  for (const sym of SYMBOLS) {
    if (only.length && !only.some((o) => o === sym.dataset || o === sym.symbol.toLowerCase())) continue;
    const t0 = Date.now();
    console.error(`[${sym.symbol}] loading spot from ${new Date(REGIME_FROM).toISOString().slice(0, 10)} and perp`);
    const spotAll = await loadSpot(sym.dataset, sym.symbol, REGIME_FROM);
    const regimes = regimeMap(spotAll);
    const perpAll = loadPerp(sym.symbol);
    const funding = fundingOf(sym.symbol);
    const impact = { binance: impactOf("binance", sym.symbol), upbit: impactOf("upbit", sym.upbit) };
    console.error(`  impact p90: binance ${impact.binance.p90bp}bp (${impact.binance.samples}/${impact.binance.hours}h) · upbit ${impact.upbit.p90bp}bp (${impact.upbit.samples}/${impact.upbit.hours}h) · loaded ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    writeFileSync(join(CACHE, `costs-${sym.symbol}.json`), JSON.stringify({ symbol: sym.symbol, upbit: sym.upbit, cutoff: new Date(COST_CUTOFF).toISOString(), impact }));
    for (const period of periodsWanted) {
      const from = PERIODS[period].from;
      for (const path of ["spot", "perp"] as const) {
        const bars = (path === "spot" ? spotAll : perpAll).filter((b) => b.startMs >= from && b.startMs < END);
        const day = dayInfo(bars, "crypto");
        const features = moveFeatures(bars, day, "crypto", sym.symbol);
        console.error(`[${sym.symbol} ${period} ${path}] ${bars.length} bars`);
        for (const [hold, holdBars] of HOLDS) {
          const cache = new Map<string, ExecutionLabels>();
          const labelsOf = (sc: ScenarioId, side: 1 | -1, strict = false) => {
            const key = `${sc}|${side}|${strict}`;
            if (!cache.has(key)) {
              const s = SCENARIOS[sc];
              const o: ExecutionOptions = { side, exec: s.exec, makerFeePct: s.maker, takerFeePct: s.taker, impactPct: impact[s.impact].impactPct, k: K, m: M, holdBars, funding: s.funding ? funding : undefined, strict: strict || (s.exec === "maker" && !TOUCH_FILLS), ...(s.exec === "maker" && !TOUCH_FILLS ? { tickSize: TICK[sym.symbol][path], penetrationTicks: 1 } : {}) };
              cache.set(key, labelExecution(bars, day, o));
            }
            return cache.get(key)!;
          };
          const ctx: Ctx = { symbol: sym.symbol, period, bars, day, features, regimes, stride: strideFor(bars.length), labelsOf, impactPct: (sc) => impact[SCENARIOS[sc].impact].impactPct };
          if (hold === "60봉")
            for (const side of path === "spot" ? ([1] as const) : ([1, -1] as const)) {
              const bid = `${sym.symbol}|${period}|${path}|${side}`;
              if (!doneBase.has(bid)) { baseAdverse(ctx, path, side); doneBase.add(bid); }
            }
          for (const sc of Object.keys(SCENARIOS) as ScenarioId[]) {
            if (SCENARIOS[sc].path !== path) continue;
            if (SCENARIOS[sc].impact === "upbit" && !UPBIT_ENABLED) continue;
            for (const dir of SCENARIOS[sc].dirs) runCombo(ctx, sc, dir, hold);
          }
        }
      }
    }
    console.error(`[${sym.symbol}] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}

if (!args.report) {
  const t0 = Date.now();
  await main();
  console.error(`all done in ${((Date.now() - t0) / 1000).toFixed(0)}s · combos ${done.size}`);
}

/* ------------------------------------------------------------------ report */

if (args.report) {
  const rows = readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
  const base = existsSync(BASE_FILE) ? readFileSync(BASE_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const judged = rows.filter((r) => !r.reference);
  const refs = rows.filter((r) => r.reference);
  const f = (n: number | null | undefined, d = 3) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(d));
  const label = (r: Row) => `${r.symbol} · ${PERIODS[r.period].label} · ${r.hold} · ${r.scenario}-${r.dir}`;
  const crit = (c: Row["criteria"]) => `${c.daily1x ? "●" : "○"}${c.folds ? "●" : "○"}${c.tradesPerDay ? "●" : "○"}${c.daily2x ? "●" : "○"}`;
  const candidates = judged.filter((r) => r.candidate);
  const passed = candidates.filter((r) => r.permutation?.pass);
  const meet = (rs: Row[], fn: (r: Row) => boolean) => rs.filter(fn).length;
  const nullPass = judged.filter((r) => r.nullRun?.pass4).length;
  const find = (r: Row, sc: ScenarioId, dir: Dir) => rows.find((x) => x.symbol === r.symbol && x.period === r.period && x.hold === r.hold && x.scenario === sc && x.dir === dir);
  const lines: string[] = [];
  const L = (s = "") => lines.push(s);
  const holdOrder = HOLDS.map((h) => h[0] as string);
  const groupKeys = [...new Set(rows.map((r) => `${r.symbol}|${r.period}`))].sort();

  L("## 1. 결론");
  L();
  if (passed.length)
    L(`**유료 연구 후보 있음: 조합 ${passed.map(label).join(", ")}** (사전 등록 기준 5개 통과, 순열 ${passed.map((r) => `${r.permutation!.atLeastActual}/20`).join(", ")}). DSL·설계 도구·계약은 바꾸지 않았다. 지정가·선물·숏을 계약에 넣을지는 소유자가 정한다.`);
  else
    L(`**후보 없음.** 판정 대상 ${judged.length}개 조합 중 사전 등록 기준 ①~④(비용 1배 일평균 > 0, 양수 폴드 ≥ 3/4, 선택 거래 ≥ 0.27건/일, 비용 2배 일평균 > 0)를 모두 만족한 조합은 ${candidates.length}개${candidates.length ? `(${candidates.map((r) => `${label(r)} → 순열 20회 중 ${r.permutation!.atLeastActual}회`).join(" · ")})` : ""}이고, 순열 기준선까지 통과한 조합은 0개다.`);
  L();
  L(`기준별 통과 조합 수(판정 대상 ${judged.length}개): ① ${meet(judged, (r) => r.criteria.daily1x)}개 · ② ${meet(judged, (r) => r.criteria.folds)}개 · ③ ${meet(judged, (r) => r.criteria.tradesPerDay)}개 · ④ ${meet(judged, (r) => r.criteria.daily2x)}개. 거래가 선택되지 않은 조합 ${meet(judged, (r) => r.trades === 0)}개, 선택됐지만 일평균 음수 ${meet(judged, (r) => r.trades > 0 && r.dailyMeanPct < 0)}개, 일평균 양수 ${meet(judged, (r) => r.dailyMeanPct > 0)}개.`);
  L(`**우연 통과 기댓값(널 실행):** 같은 ${judged.length}개 조합을 일 단위 블록 순열 피처로 한 번씩 다시 돌렸을 때 기준 ①~④를 통과한 조합 ${nullPass}개 → 신호가 없는 판에서도 이 격자에서 ①~④ 통과가 약 ${nullPass}개 나온다고 본다. 순열 기준선(20회 중 ≤1회)까지 우연히 통과할 기댓값은 ${nullPass} × 2/21 ≈ ${(nullPass * 2 / 21).toFixed(2)}개 이하.`);
  L(`(널 통과 0/${judged.length}이면 조합당 널 통과율의 95% 상한은 약 3/${judged.length}, 즉 우연 통과 기댓값 상한 약 3개다.)`);
  L();

  // Scenario-level summaries for the reading.
  const byScen = (sc: ScenarioId, dir: Dir) => rows.filter((r) => r.scenario === sc && r.dir === dir);
  const avg = (rs: Row[], fn: (r: Row) => number) => mean(rs.map(fn).filter(Number.isFinite));
  const pairDiff = (sc: ScenarioId, vs: ScenarioId, dir: Dir = "L") => {
    const pairs = rows.filter((r) => r.scenario === sc && r.dir === dir).flatMap((r) => { const o = find(r, vs, dir); return o ? [{ r, o, d: r.dailyMeanPct - o.dailyMeanPct }] : []; });
    const ds = pairs.map((p) => p.d);
    const up = pairs.filter((p) => p.d > 1e-9);
    // Of the improvements: how many came with fewer trades per day (less exposure), how many with a better mean net per trade.
    return { mean: mean(ds), better: up.length, worse: ds.filter((x) => x < -1e-9).length, n: ds.length, fewer: up.filter((p) => p.r.tradesPerDay < p.o.tradesPerDay).length, perTrade: up.filter((p) => p.r.tradesPerDay >= p.o.tradesPerDay && p.r.meanNetPct > p.o.meanNetPct + 1e-3).length, bestPerTrade: up.filter((p) => p.r.tradesPerDay >= p.o.tradesPerDay).sort((x, y) => y.d - x.d)[0] };
  };
  const dSM = pairDiff("SM", "ST"), dUM = pairDiff("UM", "UT"), dFM = pairDiff("FM", "FT"), dFT = pairDiff("FT", "ST");
  const makers = judged.filter((r) => r.exec === "maker" && r.signals > 0);
  const lsDiff = (sc: ScenarioId) => pairDiff(sc, sc, "LS");
  void lsDiff;
  const baseAdv = base.map((b: { markout: { adverse: number }[] }) => b.markout[1].adverse);
  const baseFill = base.map((b: { fillRate: number }) => b.fillRate * 100);
  const missed = base.map((b: { markout: { unfilled: number }[] }) => b.markout[1].unfilled);
  L("**읽는 법(해석).**");
  L();
  L(`- **지정가로 바꿔도 우위가 생기지 않는다.** 같은 수수료표에서 메이커 − 테이커 일평균 차이(같은 종목·기간·보유): 현물 SM−ST 평균 ${f(dSM.mean, 4)}%p(나아짐 ${dSM.better}/${dSM.n}, 나빠짐 ${dSM.worse}/${dSM.n}), Upbit UM−UT ${f(dUM.mean, 4)}%p(${dUM.better}/${dUM.n} · ${dUM.worse}/${dUM.n}), 선물 FM−FT(롱) ${f(dFM.mean, 4)}%p(${dFM.better}/${dFM.n} · ${dFM.worse}/${dFM.n}). 선물 수수료로 바꾸면(FT−ST) ${f(dFT.mean, 4)}%p(${dFT.better}/${dFT.n} · ${dFT.worse}/${dFT.n}). SM−ST는 같은 거래를 거의 같은 값에 산 것이라 차이가 0에 가깝다. 나아진 조합 중 거래가 덜 골라져서(노출 감소) 나아진 것: UM ${dUM.fewer}/${dUM.better}, FT ${dFT.fewer}/${dFT.better}, FM ${dFM.fewer}/${dFM.better}. 거래 수가 같거나 늘면서 거래당 순수익이 나아진 것은 FM ${dFM.perTrade}개${dFM.bestPerTrade ? `(가장 큰 예 ${dFM.bestPerTrade.r.symbol} ${PERIODS[dFM.bestPerTrade.r.period].label} ${dFM.bestPerTrade.r.hold}: 거래당 ${f(dFM.bestPerTrade.o.meanNetPct, 3)}% → ${f(dFM.bestPerTrade.r.meanNetPct, 3)}%)` : ""}·FT ${dFT.perTrade}개인데 **여전히 음수**다. 일평균이 양수가 된 메이커 조합은 ${meet(judged, (r) => r.exec === "maker" && r.dailyMeanPct > 0)}개다.`);
  L(`- **체결 모델은 관대하다.** 결정 봉 종가에 낸 지정가가 다음 봉에 '닿기만 하면' 체결로 쳤더니 기저 체결률이 ${f(Math.min(...baseFill), 1)}~${f(Math.max(...baseFill), 1)}%다(선택된 신호 ${makers.length}개 조합 평균 ${f(mean(makers.map((r) => (r.fillRate ?? NaN) * 100)), 0)}%). 그래서 메이커 실행은 사실상 '스프레드 없이 직전 종가에 산 테이커 + 메이커 수수료'가 되고, 큐 위치·체결 우선순위를 무시한 **상한**이다. 이 상한에서도 후보가 없다.`);
  L(`- **역선택은 작지만 항상 불리하다.** 기저 5분 역선택(체결 − 전체 마크아웃)은 ${f(Math.min(...baseAdv), 2)}~${f(Math.max(...baseAdv), 2)}bp로 18개 (종목·기간·경로·방향) 모두 음수다. 놓친 ${f(100 - Math.max(...baseFill), 1)}~${f(100 - Math.min(...baseFill), 1)}%의 신호는 5분 뒤 평균 +${f(Math.min(...missed), 1)}~+${f(Math.max(...missed), 1)}bp 유리하게 달아난 경우다 — 체결은 가격이 신호 반대로 갈 때 몰린다. 체결률이 높아 평균에 미치는 크기는 0.1~0.35bp뿐이라 결론을 바꾸지 않지만, 관통 체결이나 실제 큐에서는 체결률이 낮아지고 이 비대칭은 커진다.`);
  L("- **라벨이 비용에 비례해 줄어든다.** 이 방법은 목표 +3c·손절 −1c를 비용 c에 맞춘다. 선물 메이커 c ≈ 0.07%면 손절이 BTC 7bp로 1분 잡음 안에 들어가, 학습 구간에서도 비용 후 양수 잎이 드물고(거래 0 조합 증가) 골라진 잎은 표본 밖에서 음수다. 비용을 낮추는 것만으로는 '차트 모양에서 비용을 넘는 움직임을 미리 고르는' 문제가 풀리지 않는다는 뜻이다.");

  L("| 시나리오 | 조합 | 일평균 > 0 | 거래 0 | 평균 일평균(%) | 평균 거래/일 | 양수 폴드 최대 | 평균 체결률 | 선택 신호 5분 역선택(bp) | 같은 신호 테이커 반사실 평균 일평균(%) |");
  L("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const sc of Object.keys(SCENARIOS) as ScenarioId[])
    for (const dir of SCENARIOS[sc].dirs) {
      const rs = byScen(sc, dir);
      if (!rs.length) continue;
      L(`| ${sc}-${dir} ${SCENARIOS[sc].label} | ${rs.length} | ${meet(rs, (r) => r.dailyMeanPct > 0)} | ${meet(rs, (r) => r.trades === 0)} | ${f(avg(rs, (r) => r.dailyMeanPct), 4)} | ${f(avg(rs, (r) => r.tradesPerDay), 2)} | ${Math.max(...rs.map((r) => r.positiveFolds))}/4 | ${SCENARIOS[sc].exec === "maker" ? f(avg(rs, (r) => (r.fillRate ?? NaN) * 100), 0) + "%" : "—"} | ${SCENARIOS[sc].exec === "maker" ? f(avg(rs, (r) => r.markout?.[1].adverse ?? NaN), 2) : "—"} | ${SCENARIOS[sc].exec === "maker" ? f(avg(rs, (r) => r.takerCounterfactualDailyPct ?? NaN), 4) : "—"} |`);
    }
  L();
  const best = judged.filter((r) => r.trades > 0).sort((a, b) => b.dailyMeanPct - a.dailyMeanPct).slice(0, 10);
  L("거래가 한 건이라도 선택된 판정 대상 조합 중 일평균(비용 1배)이 가장 높은 10개:");
  L();
  L("| 조합 | 거래 | 거래/일 | 일평균(%) | 비용 2배(%) | 양수 폴드 | 기준 ①②③④ | 널 실행 일평균(%) |");
  L("| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |");
  for (const r of best) L(`| ${label(r)} | ${r.trades} | ${f(r.tradesPerDay, 2)} | ${f(r.dailyMeanPct, 4)} | ${f(r.dailyMean2xPct, 4)} | ${r.positiveFolds}/4 | ${crit(r.criteria)} | ${f(r.nullRun?.dailyMeanPct, 4)} |`);
  L();

  L("## 2. 비용(이번 실행에 쓴 값)");
  L();
  L(`충격 = \`ct_orderbook_samples\` $1,000 편도 충격 p90, ${new Date(COST_CUTOFF).toISOString().replace(".000Z", "Z")}까지의 표본(잠정). 라벨 비용 c: 테이커 2×(테이커+충격), 메이커 = 메이커+테이커+충격.`);
  L();
  L("| 종목 | Binance 충격 p90(bp, 표본/시간) | Upbit 충격 p90(bp, 표본/시간) | c: ST | c: UT | c: SM | c: UM | c: FT | c: FM |");
  L("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const s of SYMBOLS) {
    const file = join(CACHE, `costs-${s.symbol}.json`);
    if (!existsSync(file)) continue;
    const c = JSON.parse(readFileSync(file, "utf8"));
    const cOf = (sc: ScenarioId) => labelCostPct({ exec: SCENARIOS[sc].exec, makerFeePct: SCENARIOS[sc].maker, takerFeePct: SCENARIOS[sc].taker, impactPct: c.impact[SCENARIOS[sc].impact].impactPct });
    L(`| ${s.symbol} | ${f(c.impact.binance.p90bp, 3)} (${c.impact.binance.samples}/${c.impact.binance.hours}h) | ${f(c.impact.upbit.p90bp, 3)} (${c.impact.upbit.samples}/${c.impact.upbit.hours}h) | ${(["ST", "UT", "SM", "UM", "FT", "FM"] as ScenarioId[]).map((sc) => f(cOf(sc), 4) + "%").join(" | ")} |`);
  }
  L();

  L("## 3. 실행 방식: 같은 차트 신호를 지정가로");
  L();
  L("읽는 법: 일평균(%) / 거래/일 / 양수 폴드. 메이커 열의 `체결` = 선택된 신호 중 체결 비율, `역선택5` = 체결된 신호의 5분 마크아웃 − 선택된 모든 신호의 5분 마크아웃(bp, 음수 = 체결이 불리한 쪽으로 몰림), `반사실` = 같은 신호를 테이커로 쳤다면의 일평균(%). ST·UT는 참조(기존 측정에서 판정).");
  L();
  for (const g of groupKeys) {
    const [symbol, period] = g.split("|") as [string, Period];
    L(`### ${symbol} · ${PERIODS[period].label}`);
    L();
    L("| 보유 | ST-L 참조 | SM-L | SM 체결 · 역선택5 · 반사실 | UT-L 참조 | UM-L | UM 체결 · 역선택5 · 반사실 | FT-L | FM-L | FM-L 체결 · 역선택5 · 반사실 |");
    L("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const hold of holdOrder) {
      const cell = (sc: ScenarioId, dir: Dir) => { const r = rows.find((x) => x.symbol === symbol && x.period === period && x.hold === hold && x.scenario === sc && x.dir === dir); return r ? `${f(r.dailyMeanPct, 4)} / ${f(r.tradesPerDay, 2)} / ${r.positiveFolds}/4` : "—"; };
      const mk = (sc: ScenarioId, dir: Dir) => { const r = rows.find((x) => x.symbol === symbol && x.period === period && x.hold === hold && x.scenario === sc && x.dir === dir); return r && r.signals ? `${f((r.fillRate ?? NaN) * 100, 0)}% · ${f(r.markout?.[1].adverse, 1)} · ${f(r.takerCounterfactualDailyPct, 4)}` : r ? "신호 없음" : "—"; };
      L(`| ${hold} | ${cell("ST", "L")} | ${cell("SM", "L")} | ${mk("SM", "L")} | ${cell("UT", "L")} | ${cell("UM", "L")} | ${mk("UM", "L")} | ${cell("FT", "L")} | ${cell("FM", "L")} | ${mk("FM", "L")} |`);
    }
    L();
  }
  L("### 기저 체결률·역선택 (트리 선택과 무관, 모든 유효 분)");
  L();
  L("지정가 P = 결정 봉 종가, 다음 봉 하나 동안 유효. 마크아웃 = 방향 × (봉 i+h 종가 / P − 1), bp. 역선택 = 체결 − 전체.");
  L();
  L("| 종목 | 기간 | 경로 | 방향 | 유효 분 | 체결률 | 1분: 체결 / 미체결 / 역선택 | 5분: 체결 / 미체결 / 역선택 | 15분: 체결 / 미체결 / 역선택 |");
  L("| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |");
  for (const b of base.sort((a: { id: string }, c: { id: string }) => a.id.localeCompare(c.id)))
    L(`| ${b.symbol} | ${PERIODS[b.period as Period].label} | ${b.path === "spot" ? "현물" : "선물"} | ${b.side === 1 ? "롱" : "숏"} | ${b.valid.toLocaleString("en-US")} | ${f(b.fillRate * 100, 1)}% | ${b.markout.map((m: { filled: number; unfilled: number; adverse: number }) => `${f(m.filled, 2)} / ${f(m.unfilled, 2)} / **${f(m.adverse, 2)}**`).join(" | ")} |`);
  L();

  L("## 4. 방향: 숏 허용(선물)");
  L();
  L("읽는 법: 같은 종목·기간·보유·실행에서 롱만(L), 숏만(S), 둘 다(LS)의 일평균(%)과 LS − L. 국면 = 일봉 SMA200 위 / 아래 날짜의 일평균(%) (판정에 쓰지 않음). LS의 `롱/숏` = 체결된 거래 수.");
  L();
  L("| 종목 | 기간 | 보유 | 실행 | L | S | LS | LS − L | LS 롱/숏 | L 국면 위 / 아래 | S 국면 위 / 아래 | LS 국면 위 / 아래 | 평균 펀딩(%/거래, LS) |");
  L("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: |");
  const lsRows = rows.filter((r) => r.dir === "LS").sort((a, b) => a.symbol.localeCompare(b.symbol) || a.period.localeCompare(b.period) || holdOrder.indexOf(a.hold) - holdOrder.indexOf(b.hold) || a.scenario.localeCompare(b.scenario));
  const diffs: Array<{ exec: string; diff: number }> = [];
  for (const r of lsRows) {
    const l = find(r, r.scenario, "L"),
      s = find(r, r.scenario, "S");
    const reg = (x?: Row) => (x ? `${f(x.regime.up.mean, 4)} / ${f(x.regime.down.mean, 4)}` : "—");
    if (l) diffs.push({ exec: r.scenario, diff: r.dailyMeanPct - l.dailyMeanPct });
    L(`| ${r.symbol} | ${PERIODS[r.period].label} | ${r.hold} | ${r.scenario === "FM" ? "메이커" : "테이커"} | ${f(l?.dailyMeanPct, 4)} | ${f(s?.dailyMeanPct, 4)} | ${f(r.dailyMeanPct, 4)} | ${l ? f(r.dailyMeanPct - l.dailyMeanPct, 4) : "—"} | ${r.longTrades}/${r.shortTrades} | ${reg(l)} | ${reg(s)} | ${reg(r)} | ${f(r.fundingMeanPct, 4)} |`);
  }
  L();
  for (const sc of ["FT", "FM"]) {
    const ds = diffs.filter((d) => d.exec === sc).map((d) => d.diff);
    if (ds.length) L(`- ${sc === "FT" ? "선물 테이커" : "선물 메이커"}: LS − L 평균 ${f(mean(ds), 4)}%p (양수 ${ds.filter((x) => x > 0).length}/${ds.length}, 음수 ${ds.filter((x) => x < 0).length}/${ds.length}).`);
  }
  const sPos = rows.filter((r) => r.dir === "S" && r.dailyMeanPct > 0);
  L(`- 숏만(S) 일평균이 양수인 조합 ${sPos.length}개${sPos.length ? `(${sPos.map((r) => `${label(r)}: 거래 ${r.trades}건, 양수 폴드 ${r.positiveFolds}/4, 비용 2배 ${f(r.dailyMean2xPct, 4)}%`).join("; ")})` : ""} — 거래 수가 기준(0.27건/일)의 한참 아래이고 비용 2배에서 음수라 우위로 읽을 수 없다. 숏을 더하면(LS) 롱만(L)보다 일평균이 나아진 조합은 거의 없고, 대부분 같거나(숏 잎이 안 골라짐) 나빠진다(숏 잎이 골라졌지만 표본 밖 음수).`);
  const regCount = (dir: Dir, which: "up" | "down") => rows.filter((r) => !r.reference && r.dir === dir && r.regime[which].mean > 0).length;
  L(`- 국면별 일평균이 양수인 판정 대상 조합 수: L 위 ${regCount("L", "up")} · 아래 ${regCount("L", "down")} / S 위 ${regCount("S", "up")} · 아래 ${regCount("S", "down")} / LS 위 ${regCount("LS", "up")} · 아래 ${regCount("LS", "down")}.`);
  L();

  L("## 5. 순열 기준선·관통 체결 민감도");
  L();
  if (!candidates.length) L("기준 ①~④를 모두 만족한 판정 대상 조합이 없어 순열 기준선과 관통 체결 민감도를 돌릴 대상이 없었다(둘 다 후보에만 적용한다).");
  else {
    L("| 조합 | 실제 일평균(%) | 순열 20회 중 실제 이상 | 통과 | 관통 체결 일평균(%) / 기준 ①②③④ |");
    L("| --- | ---: | ---: | --- | --- |");
    for (const r of candidates) L(`| ${label(r)} | ${f(r.dailyMeanPct, 4)} | ${r.permutation!.atLeastActual} | ${r.permutation!.pass ? "통과" : "미통과"} (${r.permutation!.dailyMeans.map((x) => x.toFixed(3)).join(" ")}) | ${r.strict ? `${f(r.strict.dailyMeanPct, 4)} / ${crit(r.strict.criteria)}` : "—(테이커)"} |`);
  }
  L();

  L("## 6. 반복 검정 수와 우연 통과 기댓값");
  L();
  const tests = judged.reduce((s, r) => s + 4 * r.features * r.trees, 0);
  const splits = judged.reduce((s, r) => s + r.splits, 0);
  const refSplits = refs.reduce((s, r) => s + r.splits, 0);
  L(`판정 대상 ${judged.length}개 조합 × 폴드 4 × 피처 31 × 트리 수(LS 2) = **${tests.toLocaleString("en-US")}건**의 (조합, 폴드, 피처, 트리) 후보 분할, 트리가 실제로 평가한 후보 분할 임계값 합계 ${splits.toLocaleString("en-US")}개(참조 ${refs.length}줄 추가 ${refSplits.toLocaleString("en-US")}개). 순열 기준선 ${candidates.length} × 20회, 널 실행 ${judged.filter((r) => r.nullRun).length}회.`);
  L();
  L(`널 실행(피처를 일 단위 블록으로 섞어 라벨과의 연결을 끊은 같은 격자)에서 기준 ①~④ 통과 ${nullPass}개, 실제 ${candidates.length}개. 기준별 널 통과: ① ${judged.filter((r) => r.nullRun?.criteria.daily1x).length} · ② ${judged.filter((r) => r.nullRun?.criteria.folds).length} · ③ ${judged.filter((r) => r.nullRun?.criteria.tradesPerDay).length} · ④ ${judged.filter((r) => r.nullRun?.criteria.daily2x).length} (실제: ① ${meet(judged, (r) => r.criteria.daily1x)} · ② ${meet(judged, (r) => r.criteria.folds)} · ③ ${meet(judged, (r) => r.criteria.tradesPerDay)} · ④ ${meet(judged, (r) => r.criteria.daily2x)}). 조합끼리 독립이 아니라(같은 가격 경로·라벨) 널 실행 1회의 통과 수는 기댓값의 거친 추정이다.`);
  L();
  L("## 7. 소요 시간·데이터");
  L();
  const secs = rows.reduce((s, r) => s + r.seconds, 0);
  L(`- 조합 ${rows.length}줄(판정 ${judged.length} + 참조 ${refs.length})의 트리·워크포워드·널 실행 합계 ${secs.toFixed(0)}초.`);
  L("- 선물 1분봉: `data.binance.vision` `futures/um` BTCUSDT·ETHUSDT·SOLUSDT 2023-11-01~2026-10-12 각 1,550,880봉, 빈 분 0, 체크섬 확인(`scripts/data/download-binance-um-klines.py`, 3종목 약 80초). 펀딩: 기존 `-field` 캐시(아카이브 + REST).");
  L();
  const doc = readFileSync(OUT_DOC, "utf8");
  const marker = doc.includes("\n## 1. 결론") ? "\n## 1. 결론" : "(이하 측정 후 채움)";
  const head = doc.slice(0, doc.indexOf(marker)).replace(/\n+(---\n*)?$/, "") + "\n\n---\n\n";
  writeFileSync(OUT_DOC, head + lines.join("\n") + "\n");
  console.error(`report written: ${OUT_DOC} (${rows.length} rows)`);
}
export {};
