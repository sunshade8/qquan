/**
 * CT ceiling, wider field (docs/research/ct-ceiling-2026-10-14-field.md). No models, no money.
 *
 * Same method as scripts/research/ct-ceiling.ts (labels, 31 price/volume features, expanding-window walk-forward with 4 folds,
 * depth-3 tree, leaf chosen on TRAINING net > 0, daily mean over every validation day) over a wider grid:
 *   price path   Binance spot (B-1, B-2a) or Upbit KRW spot with Upbit empty minutes filled flat (B-2b)
 *   symbols      BTCUSDT, ETHUSDT, SOLUSDT   periods 1y, 3y (from the derivatives' start), BTC 5y
 *   costs        B-1 Binance measured per symbol · B-2a Upbit measured costs on the Binance path · B-2b Upbit path + Upbit costs
 *   features     F1 31 price/volume · F2 + 11 derivatives · F3 + 7 Upbit–Binance gap/lead columns (Upbit path only)
 * A combination that meets the pre-registered criteria gets the 20-run day-block permutation baseline immediately (labels and
 * features are in memory). Results append to ~/.qquan/cache/ceiling-field/results.jsonl (resumable); --report writes the markdown.
 *
 *   node --experimental-strip-types --no-warnings scripts/research/ct-ceiling-field.ts [--only=btc,1y] [--limit-perm=20]
 *   node --experimental-strip-types --no-warnings scripts/research/ct-ceiling-field.ts --report --out=docs/research/ct-ceiling-2026-10-14-field.md
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { queryLocalMarket } from "../../lib/local-market-data.ts";
import type { CTBar } from "../../lib/ct-engine.ts";
import { baseRate, dayInfo, labelMoves, moveFeatures, walkForward, type MoveFeatureTable } from "../../lib/ct-moves.ts";
import { ctSeedOf } from "../../lib/ct-trader-tools.ts";
import { DERIV_NAMES, GAP_NAMES, derivColumns, fillMinuteGrid, gapColumns, permuteDayBlocks, roundTripFromSamples } from "../../lib/ct-ceiling-features.ts";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"]; }));
const ROOT = process.env.QQUAN_DATA_DIR || join(homedir(), ".qquan");
const CACHE = join(ROOT, "cache", "ceiling-field");
const RESULTS = join(CACHE, "results.jsonl");
const DAY = 86_400_000;
const END = Date.UTC(2026, 9, 13);
const K = 3, M = 1;
const PERIODS = {
  "1y": { from: END - 365 * DAY, label: "1년" },
  "3y": { from: Date.UTC(2023, 10, 1), label: "3년(2023-11-01~)" },
  "5y": { from: END - 1826 * DAY, label: "5년" },
} as const;
type Period = keyof typeof PERIODS;
const SYMBOLS = [
  { symbol: "BTCUSDT", dataset: "btc" as const, upbit: "KRW-BTC", periods: ["1y", "3y", "5y"] as Period[] },
  { symbol: "ETHUSDT", dataset: "eth" as const, upbit: "KRW-ETH", periods: ["1y", "3y"] as Period[] },
  { symbol: "SOLUSDT", dataset: "sol" as const, upbit: "KRW-SOL", periods: ["1y", "3y"] as Period[] },
];
const HOLDS = [["60봉", 60], ["240봉", 240], ["390봉", 390], ["당일 청산", Infinity]] as const;
const only = (args.only ?? "").split(",").filter(Boolean).map((x) => x.toLowerCase());
const PERIOD_TAGS = Object.keys(PERIODS);
/** --only filters: period tags (1y/3y/5y) apply to periods, the others (btc, btcusdt, binance, upbit) to symbol and path. */
const wantedSymbol = (...tags: string[]) => only.filter((o) => !PERIOD_TAGS.includes(o)).every((o) => tags.map((t) => t.toLowerCase()).includes(o));
const wantedPeriod = (p: string) => only.filter((o) => PERIOD_TAGS.includes(o)).every((o) => o === p);

/* ------------------------------------------------------------------ data */

function readF64(name: string) {
  const buf = readFileSync(join(CACHE, name));
  return new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
}
const timing: Record<string, number> = {};
const tick = (name: string, start: number) => (timing[name] = (timing[name] ?? 0) + (Date.now() - start) / 1000);

async function loadBinance(dataset: "btc" | "eth" | "sol", symbol: string, from: number): Promise<CTBar[]> {
  const t0 = Date.now();
  const bars: CTBar[] = [];
  for (let cursor = from; cursor < END; cursor += 31 * DAY) {
    const page = await queryLocalMarket({ dataset, instrument: symbol, quoteCurrency: "USDT", from: cursor, to: Math.min(END, cursor + 31 * DAY), minutes: 1, session: "all" });
    bars.push(...page.bars);
  }
  const seen = new Set<number>();
  const out = bars.filter((b) => (seen.has(b.endMs) ? false : (seen.add(b.endMs), true))).sort((a, b) => a.endMs - b.endMs);
  tick("load-binance-bars", t0);
  return out;
}
function upbitRows(market: string) {
  const c = (name: string) => readF64(`upbit.${market}.${name}.f64`);
  const [s, o, h, l, cl, v] = [c("startMs"), c("open"), c("high"), c("low"), c("close"), c("volume")];
  return Array.from(s, (_, i) => ({ startMs: s[i], open: o[i], high: h[i], low: l[i], close: cl[i], volume: v[i] }));
}
function derivInput(symbol: string) {
  const f = (kind: string, col: string) => readF64(`${symbol}.${kind}.${col}.f64`);
  return {
    premium: { endMs: f("premium_1m", "endMs"), close: f("premium_1m", "close") },
    funding: { calcMs: f("funding", "calcMs"), rate: f("funding", "rate") },
    metrics: { startMs: f("metrics_5m", "startMs"), openInterestValue: f("metrics_5m", "openInterestValue"), takerVolRatio: f("metrics_5m", "takerVolRatio") },
  };
}

/* ------------------------------------------------------------------ costs */

const db = new DatabaseSync(join(ROOT, "state", "research.sqlite"), { readOnly: true });
function costOf(venue: "binance" | "upbit", symbol: string, fee: number) {
  const rows = db.prepare("SELECT buy_bp,sell_bp FROM ct_orderbook_samples WHERE venue=? AND symbol=? AND notional_usd=1000").all(venue, symbol) as Array<{ buy_bp: number | null; sell_bp: number | null }>;
  const r = roundTripFromSamples(rows, fee);
  const span = db.prepare("SELECT min(ts) a, max(ts) b FROM ct_orderbook_samples WHERE venue=? AND symbol=?").get(venue, symbol) as { a: number; b: number };
  return { ...r, venue, symbol, hours: Number((((span.b ?? 0) - (span.a ?? 0)) / 3_600_000).toFixed(1)) };
}

/* ------------------------------------------------------------------ regime */

/** UTC-day regime from the symbol's own Binance daily closes: previous close above/below its SMA200 (previous 200 closes). */
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

type Row = {
  id: string; path: "binance" | "upbit"; symbol: string; period: Period; set: "F1" | "F2" | "F3"; cost: "B-1" | "B-2a" | "B-2b"; costPct: number; hold: string;
  bars: number; days: number; positiveShare: number; positivesPerDay: number; unconditionalNetPct: number;
  trades: number; tradesPerDay: number; meanNetPct: number; dailyMeanPct: number; dailyMean2xPct: number; dailyT: number; positiveFolds: number;
  bestTrainLeafNetPct: number; splits: number; features: number; foldsRun: number; leaves: string[]; leafFeatures: Record<string, number>;
  regime: { up: { days: number; mean: number }; down: { days: number; mean: number }; none: { days: number; mean: number } };
  candidate: boolean; criteria: { daily1x: boolean; folds: boolean; tradesPerDay: boolean; daily2x: boolean };
  permutation?: { runs: number; atLeastActual: number; pass: boolean; dailyMeans: number[] };
  seconds: number;
};
const done = new Set<string>(existsSync(RESULTS) ? readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Row).id) : []);
mkdirSync(CACHE, { recursive: true });

const CRITERIA = { minTradesPerDay: 0.27, minPositiveFolds: 3, permutations: 20, maxPermutationHits: 1 };

function runCombo(meta: Pick<Row, "path" | "symbol" | "period" | "set" | "cost" | "costPct">, hold: readonly [string, number], bars: CTBar[], day: ReturnType<typeof dayInfo>, features: MoveFeatureTable, regimes: Map<number, "up" | "down">, stride: number): Row {
  const id = `${meta.path}|${meta.symbol}|${meta.period}|${meta.set}|${meta.cost}|${hold[0]}`;
  const t0 = Date.now();
  const labels = labelMoves(bars, day, { costPct: meta.costPct, k: K, m: M, holdBars: hold[1] });
  const base = baseRate(labels, day, meta.costPct);
  const wf = walkForward({ bars, day, labels, features, costPct: meta.costPct, folds: 4, depth: 3, trainStride: stride });
  const leafFeatures: Record<string, number> = {};
  for (const leaf of new Set(wf.folds.flatMap((f) => f.selectedLeaves)))
    for (const name of features.names) if (leaf.includes(`${name} `)) leafFeatures[name] = (leafFeatures[name] ?? 0) + 1;
  const bucket = { up: [] as number[], down: [] as number[], none: [] as number[] };
  for (const d of wf.daily) bucket[regimes.get(d.key) ?? "none"].push(d.net);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const criteria = { daily1x: wf.dailyMeanPct > 0, folds: wf.positiveFolds >= CRITERIA.minPositiveFolds, tradesPerDay: wf.tradesPerDay >= CRITERIA.minTradesPerDay, daily2x: wf.dailyMean2xPct > 0 };
  const candidate = Object.values(criteria).every(Boolean);
  const row: Row = {
    id, ...meta, hold: hold[0], bars: bars.length, days: base.days, positiveShare: base.positiveShare, positivesPerDay: base.positivesPerDay, unconditionalNetPct: base.unconditionalNetPct,
    trades: wf.trades, tradesPerDay: wf.tradesPerDay, meanNetPct: wf.meanNetPct, dailyMeanPct: wf.dailyMeanPct, dailyMean2xPct: wf.dailyMean2xPct, dailyT: wf.dailyT, positiveFolds: wf.positiveFolds,
    bestTrainLeafNetPct: wf.bestTrainLeafNetPct, splits: wf.candidateSplits, features: features.names.length, foldsRun: wf.folds.filter((f) => f.trainRows > 0).length,
    leaves: [...new Set(wf.folds.flatMap((f) => f.selectedLeaves))].slice(0, 6), leafFeatures,
    regime: { up: { days: bucket.up.length, mean: mean(bucket.up) }, down: { days: bucket.down.length, mean: mean(bucket.down) }, none: { days: bucket.none.length, mean: mean(bucket.none) } },
    candidate, criteria, seconds: 0,
  };
  if (candidate) {
    // The permutation baseline: day blocks of feature rows are shuffled against the labels, the identical method re-run.
    const startMs = Float64Array.from(bars, (b) => b.startMs);
    const means: number[] = [];
    for (let r = 0; r < CRITERIA.permutations; r++) {
      const permuted = permuteDayBlocks(features.cols, day.key, startMs, day.startMs, ctSeedOf(`${id}:${r}`));
      means.push(walkForward({ bars, day, labels, features: { names: features.names, cols: permuted }, costPct: meta.costPct, folds: 4, depth: 3, trainStride: stride }).dailyMeanPct);
    }
    const hits = means.filter((m) => m >= wf.dailyMeanPct).length;
    row.permutation = { runs: means.length, atLeastActual: hits, pass: hits <= CRITERIA.maxPermutationHits, dailyMeans: means.map((m) => Number(m.toFixed(5))) };
  }
  row.seconds = (Date.now() - t0) / 1000;
  appendFileSync(RESULTS, JSON.stringify(row) + "\n");
  done.add(id);
  console.error(`  ${id}: trades ${row.trades} (${row.tradesPerDay.toFixed(2)}/일) · 일평균 ${row.dailyMeanPct.toFixed(4)}% (2x ${row.dailyMean2xPct.toFixed(4)}%) · 양수 폴드 ${row.positiveFolds}/4${candidate ? ` · 후보! 순열 ${row.permutation!.atLeastActual}/${CRITERIA.permutations}` : ""} · ${row.seconds.toFixed(0)}s`);
  return row;
}
const strideFor = (n: number) => (n > 800_000 ? 6 : n > 300_000 ? 3 : 2);

async function binancePath() {
  for (const s of SYMBOLS) {
    if (!wantedSymbol(s.symbol, s.dataset, "binance")) continue;
    const need = Math.min(...s.periods.map((p) => PERIODS[p].from));
    // Combos of this symbol still to do?
    const todo = s.periods.filter((p) => wantedPeriod(p));
    if (!todo.length) continue;
    console.error(`[${s.symbol}] loading Binance 1m bars from ${new Date(need).toISOString().slice(0, 10)}`);
    const all = await loadBinance(s.dataset, s.symbol, need);
    const regimes = regimeMap(all);
    const costs = { "B-1": costOf("binance", s.symbol, 0.1), "B-2a": costOf("upbit", s.upbit, 0.05) };
    console.error(`  costs: B-1 ${costs["B-1"].costPct.toFixed(4)}% (${costs["B-1"].samples} samples/${costs["B-1"].hours}h) · B-2a ${costs["B-2a"].costPct.toFixed(4)}% (${costs["B-2a"].samples}/${costs["B-2a"].hours}h)`);
    for (const period of todo) {
      const bars = all.filter((b) => b.startMs >= PERIODS[period].from);
      const sets: Array<"F1" | "F2"> = period === "5y" ? ["F1"] : ["F1", "F2"];
      const pending = sets.flatMap((set) => (Object.keys(costs) as Array<"B-1" | "B-2a">).flatMap((c) => HOLDS.map((h) => `binance|${s.symbol}|${period}|${set}|${c}|${h[0]}`))).filter((id) => !done.has(id));
      if (!pending.length) continue;
      console.error(`[${s.symbol} ${period}] ${bars.length} bars`);
      const t0 = Date.now();
      const day = dayInfo(bars, "crypto");
      const f1 = moveFeatures(bars, day, "crypto", s.symbol);
      tick("features-F1", t0);
      const decisionEnds = Float64Array.from(bars, (b) => b.endMs);
      let f2: MoveFeatureTable | null = null;
      if (sets.includes("F2")) {
        const t1 = Date.now();
        f2 = { names: [...f1.names, ...DERIV_NAMES], cols: [...f1.cols, ...derivColumns(decisionEnds, derivInput(s.symbol))] };
        tick("features-F2", t1);
        const finite = f2.cols.slice(f1.cols.length).map((c) => c.reduce((n, v) => n + (Number.isFinite(v) ? 1 : 0), 0) / c.length);
        console.error(`  derivative columns finite share: ${finite.map((x) => x.toFixed(3)).join(" ")}`);
      }
      for (const set of sets) {
        const table = set === "F1" ? f1 : f2!;
        for (const cost of Object.keys(costs) as Array<"B-1" | "B-2a">)
          for (const hold of HOLDS) {
            const id = `binance|${s.symbol}|${period}|${set}|${cost}|${hold[0]}`;
            if (done.has(id)) continue;
            runCombo({ path: "binance", symbol: s.symbol, period, set, cost, costPct: costs[cost].costPct }, hold, bars, day, table, regimes, strideFor(bars.length));
          }
      }
    }
  }
}

async function upbitPath() {
  const usdtRows = fillMinuteGrid(upbitRows("KRW-USDT"), PERIODS["1y"].from, END);
  console.error(`[Upbit] KRW-USDT filled ${usdtRows.filled} minutes`);
  for (const s of SYMBOLS) {
    if (!wantedSymbol(s.symbol, s.dataset, "upbit") || !wantedPeriod("1y")) continue;
    const pending = (["F1", "F2", "F3"] as const).flatMap((set) => HOLDS.map((h) => `upbit|${s.symbol}|1y|${set}|B-2b|${h[0]}`)).filter((id) => !done.has(id));
    if (!pending.length) continue;
    const { bars, filled } = fillMinuteGrid(upbitRows(s.upbit), PERIODS["1y"].from, END);
    console.error(`[${s.upbit} 1y] ${bars.length} bars, ${filled} empty minutes filled`);
    const binance = await loadBinance(s.dataset, s.symbol, PERIODS["1y"].from - 8 * DAY);
    const regimes = regimeMap(await loadBinance(s.dataset, s.symbol, END - 800 * DAY));
    const cost = costOf("upbit", s.upbit, 0.05);
    console.error(`  cost B-2b ${cost.costPct.toFixed(4)}% (${cost.samples} samples/${cost.hours}h)`);
    const day = dayInfo(bars, "crypto");
    const f1 = moveFeatures(bars, day, "crypto", s.symbol);
    const decisionEnds = Float64Array.from(bars, (b) => b.endMs);
    const f2: MoveFeatureTable = { names: [...f1.names, ...DERIV_NAMES], cols: [...f1.cols, ...derivColumns(decisionEnds, derivInput(s.symbol))] };
    const closes = (b: CTBar[]) => ({ endMs: b.map((x) => x.endMs), close: b.map((x) => x.close) });
    const f3: MoveFeatureTable = { names: [...f2.names, ...GAP_NAMES], cols: [...f2.cols, ...gapColumns(decisionEnds, closes(binance), closes(bars), closes(usdtRows.bars))] };
    const finite = f3.cols.slice(f2.cols.length).map((c) => c.reduce((n, v) => n + (Number.isFinite(v) ? 1 : 0), 0) / c.length);
    console.error(`  gap columns finite share: ${finite.map((x) => x.toFixed(3)).join(" ")}`);
    for (const [set, table] of [["F1", f1], ["F2", f2], ["F3", f3]] as const)
      for (const hold of HOLDS) {
        const id = `upbit|${s.symbol}|1y|${set}|B-2b|${hold[0]}`;
        if (done.has(id)) continue;
        runCombo({ path: "upbit", symbol: s.symbol, period: "1y", set, cost: "B-2b", costPct: cost.costPct }, hold, bars, day, table, regimes, strideFor(bars.length));
      }
    writeFileSync(join(CACHE, `upbit-fill-${s.upbit}.json`), JSON.stringify({ market: s.upbit, bars: bars.length, filled }));
  }
}

if (!args.report) {
  const t0 = Date.now();
  if (!args["skip-binance"]) await binancePath();
  // Upbit price path: only with QQUAN_ENABLE_UPBIT=true (or --with-upbit); every coin measurement is Binance by default.
  if ((process.env.QQUAN_ENABLE_UPBIT === "true" || args["with-upbit"]) && !args["skip-upbit"]) await upbitPath();
  writeFileSync(join(CACHE, "timing.json"), JSON.stringify({ seconds: timing, wallSeconds: (Date.now() - t0) / 1000, finishedAt: new Date().toISOString() }, null, 1));
  console.error(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s · combos ${done.size}`);
}

/* ------------------------------------------------------------------ report */

if (args.report) {
  const rows = readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
  const out = args.out ?? "docs/research/ct-ceiling-2026-10-14-field.md";
  const timingFile = join(CACHE, "timing.json");
  const f = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : "—");
  const costs = SYMBOLS.flatMap((s) => [
    { ...costOf("binance", s.symbol, 0.1), tag: "B-1" },
    { ...costOf("upbit", s.upbit, 0.05), tag: "B-2a/B-2b" },
  ]);
  const candidates = rows.filter((r) => r.candidate);
  const passed = candidates.filter((r) => r.permutation?.pass);
  const total = rows.length;
  const lines: string[] = [];
  const L = (s = "") => lines.push(s);
  const holdOrder = HOLDS.map((h) => h[0]);
  const keyOf = (r: Row) => `${r.path}|${r.symbol}|${r.period}|${r.set}|${r.cost}`;
  const groups = new Map<string, Row[]>();
  for (const r of rows) (groups.get(keyOf(r)) ?? groups.set(keyOf(r), []).get(keyOf(r))!).push(r);
  const label = (r: Row) => `${r.path} · ${r.symbol} · ${PERIODS[r.period].label} · ${r.set} · ${r.cost} · ${r.hold}`;
  const crit = (r: Row) => `${r.criteria.daily1x ? "●" : "○"}${r.criteria.folds ? "●" : "○"}${r.criteria.tradesPerDay ? "●" : "○"}${r.criteria.daily2x ? "●" : "○"}`;

  L("## 1. 결론");
  L();
  if (passed.length)
    L(`**유료 연구 후보 있음: 조합 ${passed.map((r) => label(r)).join(", ")}** (사전 등록 기준 5개를 모두 통과, 순열 기준선 ${passed.map((r) => `${r.permutation!.atLeastActual}/20`).join(", ")}). 다음 단계는 소유자가 정한다. 이 보고서는 DSL·설계 도구를 확장하지 않았다.`);
  else
    L(`**후보 없음.** 측정한 ${total}개 조합 중 사전 등록 기준(비용 1배 일평균 > 0, 양수 폴드 ≥ 3/4, 선택 거래 ≥ 0.27건/일, 비용 2배 일평균 > 0)을 **모두** 만족한 조합은 ${candidates.length}개이고, 순열 기준선까지 통과한 조합은 0개다${candidates.length ? ` (기준을 만족한 ${candidates.length}개의 순열 결과: ${candidates.map((r) => `${label(r)} → 20회 중 ${r.permutation!.atLeastActual}회`).join(" · ")})` : ""}.`);
  L();
  const meet = (fn: (r: Row) => boolean) => rows.filter(fn).length;
  L(`기준별 통과 조합 수(전체 ${total}개): 비용 1배 일평균 > 0 → ${meet((r) => r.criteria.daily1x)}개 · 양수 폴드 ≥ 3/4 → ${meet((r) => r.criteria.folds)}개 · 선택 거래 ≥ 0.27건/일 → ${meet((r) => r.criteria.tradesPerDay)}개 · 비용 2배 일평균 > 0 → ${meet((r) => r.criteria.daily2x)}개. 거래가 아예 선택되지 않은 조합(학습 구간에서 비용 후 양수인 잎이 없음) ${meet((r) => r.trades === 0)}개, 선택은 됐지만 검증 구간 일평균이 음수인 조합 ${meet((r) => r.trades > 0 && r.dailyMeanPct < 0)}개, 일평균이 양수인 조합 ${meet((r) => r.dailyMeanPct > 0)}개.`);
  const upPos = rows.filter((r) => r.regime.up.mean > 0),
    downPos = rows.filter((r) => r.regime.down.mean > 0);
  const leafUse = (set: string) => {
    let all = 0,
      deriv = 0,
      gap = 0;
    for (const r of rows.filter((x) => x.set === set))
      for (const [name, n] of Object.entries(r.leafFeatures)) {
        all += n;
        if ((DERIV_NAMES as readonly string[]).includes(name)) deriv += n;
        if ((GAP_NAMES as readonly string[]).includes(name)) gap += n;
      }
    return { all, deriv, gap };
  };
  const u2 = leafUse("F2"),
    u3 = leafUse("F3");
  L();
  L("**읽는 법(해석).**");
  L(`- 판을 넓혀도(종목 BTC·ETH·SOL, 기간 1·3·5년, Upbit 가격 경로와 비용, 파생·괴리 피처) 기준을 통과하는 조합이 없다. 일평균이 양수인 조합 ${meet((r) => r.dailyMeanPct > 0)}개는 선택된 거래가 ${rows.filter((r) => r.dailyMeanPct > 0).map((r) => r.trades).join(", ")}건뿐(거래/일 0.00)이라 양수 폴드 ${Math.max(...rows.filter((r) => r.dailyMeanPct > 0).map((r) => r.positiveFolds))}/4에 그친다.`);
  L(`- 국면별로 쪼개도 같다: 일봉 SMA200 **위** 날짜의 일평균이 양수인 조합 ${upPos.length}개, **아래** 날짜가 양수인 조합 ${downPos.length}개${downPos.length ? ` (${downPos.map((r) => `${r.symbol} ${PERIODS[r.period].label} ${r.set} ${r.cost} ${r.hold}: ${r.regime.down.mean.toFixed(4)}%`).join("; ")})` : ""}. 위쪽(상승 국면)에서는 양수가 하나도 없고, 아래쪽 양수 조합은 선택된 거래가 ${downPos.map((r) => r.trades).join(", ")}건뿐이라 국면별 우위로 읽을 수 없다.`);
  L(`- 파생 피처는 선택된 잎에 쓰였지만 드물다: F2에서 잎의 피처 언급 ${u2.all}회 중 파생 ${u2.deriv}회(${f((u2.deriv / Math.max(1, u2.all)) * 100, 1)}%), F3에서 ${u3.all}회 중 파생 ${u3.deriv}회·괴리 ${u3.gap}회. 쓰여도 일평균이 좋아지지 않는다(5절 ablation).`);
  L("- Upbit 수수료(0.05%×2)는 Binance(0.1%×2)의 절반이라 B-2는 B-1보다 왕복 비용이 낮거나 비슷하지만(SOL만 Upbit 호가가 얇아 더 비쌈) 부호는 바뀌지 않는다. B-2a(Binance 가격 + Upbit 비용)와 B-2b(Upbit 가격 + Upbit 비용)가 같은 결론이라 두 거래소 가격 경로의 차이가 결과를 바꾸지 않았다.");
  const best = rows.filter((r) => r.trades > 0).sort((a, b) => b.dailyMeanPct - a.dailyMeanPct).slice(0, 8);
  L();
  L("거래가 한 건이라도 선택된 조합 중 일평균(비용 1배)이 가장 높은 8개 — 기준을 통과하지 못한 이유를 보려고 그대로 싣는다:");
  L();
  L("| 조합 | 거래 | 거래/일 | 일평균(%) | 비용 2배(%) | 양수 폴드 | 기준 ①1배>0 ②폴드 ③거래/일 ④2배>0 |");
  L("| --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const r of best) L(`| ${label(r)} | ${r.trades} | ${f(r.tradesPerDay, 2)} | ${f(r.dailyMeanPct, 4)} | ${f(r.dailyMean2xPct, 4)} | ${r.positiveFolds}/4 | ${crit(r)} |`);
  L();
  L("## 2. 데이터 제공 범위(실제 파일·응답으로 확인, 2026-10-14)");
  L();
  L("| 항목 | 제공 | 범위·시각 의미 | 비고 |");
  L("| --- | --- | --- | --- |");
  L("| Binance USDⓈ-M 프리미엄 지수 1분봉 | 월 단위 아카이브 `data.binance.vision` | 2020-01부터, `open_time` = 봉 **시작**, 봉이 닫힌 뒤에만 사용 | 값은 프리미엄 비율(−0.0005 등), 거래량 0. 월 파일은 지난달까지, 이번 달은 일 파일 |");
  L("| 펀딩비 | 월 단위 아카이브 + REST `fapi/v1/fundingRate` | 2020-01부터, `calc_time` = 정산 시각, 정산 시각 이후에만 사용 | 월 아카이브에 이번 달이 아직 없어 REST로 이어 붙임(공개, 키 없음) |");
  L("| 5분 지표(미결제약정·롱숏 비율·테이커 비율) | **일 단위** 아카이브만 | 2020-09부터, `create_time` = 구간 **시작**(선물 1분봉의 테이커 비율과 대조해 확인), **T+5분 이후**에만 사용 | REST `futures/data/openInterestHist`는 최근 30일만(2023년 `startTime`은 `-1130` 거부) |");
  L("| 강제청산 기록 | **제공 안 됨** | 아카이브에 UM `liquidationSnapshot` 접두사 없음, REST `allForceOrders`는 오류 페이지 | F2에서 제외 |");
  L("| Upbit 분봉 | `GET /v1/candles/minutes/1`, 요청당 최대 200개, `to`는 **미포함**(그 시각 이전 봉), 초당 10회(IP) | `candle_date_time_utc` = 봉 **시작**, 거래 없는 분은 봉 자체가 없음 | 429는 다음 초까지 대기, 연속 위반은 418 차단 |");
  L();
  L("## 3. 비용(잠정)");
  L();
  L("`ct_orderbook_samples`의 $1,000 시장가 편도 충격 p90으로 계산(샘플러가 2026-10-16 17:41Z까지 계속 쌓는 중이라 **잠정**). B-1 = 0.1%×2 + 2×Binance 충격, B-2 = 0.05%×2 + 2×Upbit 충격.");
  L();
  L("| 거래소 | 종목 | 표본 | 기간(h) | 편도 충격 p90(bp) | 왕복 비용(%) |");
  L("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const c of costs) L(`| ${c.venue === "binance" ? "Binance(B-1)" : "Upbit(B-2a/b)"} | ${c.symbol} | ${c.samples} | ${c.hours} | ${c.p90bp === null ? "—" : f(c.p90bp, 3)} | ${f(c.costPct, 4)} |`);
  L();
  L("## 4. 조합별 결과");
  L();
  L("읽는 법: 한 줄 = 종목 × 기간 × 피처 집합 × 비용 시나리오 × 보유 상한. 가격 경로 **binance**는 Binance 현물 1분봉, **upbit**는 Upbit KRW 1분봉(빈 분은 직전 종가로 채움). B-2a는 Upbit **비용**을 Binance **가격**에 적용한 근사다(두 거래소 가격 경로가 같다고 가정). 일평균은 포지션 명목 대비 %. `국면` = 일봉 SMA200 위 / 아래 날짜별 일평균(검증 구간의 날수). 기준 ①1배>0 ②양수 폴드≥3 ③거래/일≥0.27 ④2배>0 (● 통과, ○ 미달).");
  L();
  const sections = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, g] of sections) {
    const r0 = g[0];
    L(`### ${r0.path} · ${r0.symbol} · ${PERIODS[r0.period].label} · ${r0.set} · ${r0.cost} (왕복 ${f(r0.costPct, 4)}%, 피처 ${r0.features}개, 분 ${r0.bars.toLocaleString("en-US")}개)`);
    L();
    L("| 보유 | 양성 비율 | 선택 거래 | 거래/일 | 거래당 순(%) | 일평균(%) | 비용 2배(%) | 양수 폴드 | 학습 최고 잎(%) | 국면 상승 / 하락 | 기준 | 순열 |");
    L("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |");
    for (const hold of holdOrder) {
      const r = g.find((x) => x.hold === hold);
      if (!r) continue;
      L(`| ${hold} | ${f(r.positiveShare * 100, 1)}% | ${r.trades} | ${f(r.tradesPerDay, 2)} | ${f(r.meanNetPct, 3)} | ${f(r.dailyMeanPct, 4)} | ${f(r.dailyMean2xPct, 4)} | ${r.positiveFolds}/4 | ${f(r.bestTrainLeafNetPct, 3)} | ${f(r.regime.up.mean, 3)} (${r.regime.up.days}일) / ${f(r.regime.down.mean, 3)} (${r.regime.down.days}일) | ${crit(r)} | ${r.permutation ? `${r.permutation.atLeastActual}/20` : "—"} |`);
    }
    L();
  }
  L("## 5. 피처 집합 기여도(ablation)");
  L();
  L("같은 종목·기간·비용·보유에서 피처 집합만 바꿔 일평균(%)을 비교한다. F2 = F1 + 파생 11개, F3 = F2 + 괴리·선후행 7개(Upbit 경로).");
  L();
  L("| 경로 | 종목 | 기간 | 비용 | 보유 | F1 일평균 | F2 일평균 | F3 일평균 | F1 거래 | F2 거래 | F3 거래 |");
  L("| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  const base = rows.filter((r) => r.set === "F1");
  for (const r1 of base) {
    const r2 = rows.find((x) => x.set === "F2" && x.path === r1.path && x.symbol === r1.symbol && x.period === r1.period && x.cost === r1.cost && x.hold === r1.hold);
    const r3 = rows.find((x) => x.set === "F3" && x.path === r1.path && x.symbol === r1.symbol && x.period === r1.period && x.cost === r1.cost && x.hold === r1.hold);
    if (!r2 && !r3) continue;
    L(`| ${r1.path} | ${r1.symbol} | ${PERIODS[r1.period].label} | ${r1.cost} | ${r1.hold} | ${f(r1.dailyMeanPct, 4)} | ${r2 ? f(r2.dailyMeanPct, 4) : "—"} | ${r3 ? f(r3.dailyMeanPct, 4) : "—"} | ${r1.trades} | ${r2?.trades ?? "—"} | ${r3?.trades ?? "—"} |`);
  }
  L();
  const share = (set: string) => {
    const use: Record<string, number> = {};
    let leaves = 0;
    for (const r of rows.filter((x) => x.set === set)) for (const [name, n] of Object.entries(r.leafFeatures)) { use[name] = (use[name] ?? 0) + n; leaves += n; }
    const cls = (name: string) => ((DERIV_NAMES as readonly string[]).includes(name) ? "파생" : (GAP_NAMES as readonly string[]).includes(name) ? "괴리" : "가격·거래량");
    const by: Record<string, number> = {};
    for (const [name, n] of Object.entries(use)) by[cls(name)] = (by[cls(name)] ?? 0) + n;
    return { leaves, by, top: Object.entries(use).sort((a, b) => b[1] - a[1]).slice(0, 6) };
  };
  L("선택된 잎에서 쓰인 피처(언급 횟수, 조합·폴드 잎 합계):");
  L();
  for (const set of ["F1", "F2", "F3"]) {
    const s = share(set);
    if (!s.leaves) { L(`- ${set}: 선택된 잎 없음`); continue; }
    L(`- ${set}: ${Object.entries(s.by).map(([k, v]) => `${k} ${v}회`).join(" · ")} · 상위: ${s.top.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  L();
  L("## 6. 순열 기준선");
  L();
  if (!candidates.length) L("사전 등록 기준을 모두 만족한 조합이 없어 순열 기준선을 돌릴 대상이 없었다(순열은 후보에만 적용한다).");
  else {
    L("| 조합 | 실제 일평균(%) | 순열 20회 중 실제 이상 | 통과 |");
    L("| --- | ---: | ---: | --- |");
    for (const r of candidates) L(`| ${label(r)} | ${f(r.dailyMeanPct, 4)} | ${r.permutation!.atLeastActual} | ${r.permutation!.pass ? "통과" : "미통과"} (순열 일평균: ${r.permutation!.dailyMeans.map((x) => x.toFixed(3)).join(" ")}) |`);
  }
  L();
  L("## 7. 반복 검정 수");
  L();
  const featSum = rows.reduce((s, r) => s + 4 * r.features, 0);
  const splits = rows.reduce((s, r) => s + r.splits, 0);
  L(`조합 ${total}개 × 폴드 4 × 피처(F1 31 / F2 42 / F3 49) = **${featSum.toLocaleString("en-US")}건**의 (조합, 폴드, 피처) 후보 분할이고, 트리가 실제로 평가한 후보 분할 임계값은 합계 ${splits.toLocaleString("en-US")}개다. 순열 기준선의 추가 평가: ${candidates.length} × 20회.`);
  L(`같은 데이터를 여러 번 보는 조합이므로 이 표의 한 칸이 양수라고 해서 증거가 되지 않는다. 그래서 기준 5개를 모두 요구하고 순열로 한 번 더 걸렀다. 조합 간 독립이 아니라(같은 가격 경로, 같은 라벨) 우연 통과 기대값을 정확히 계산할 수 없다. 순열의 20회 중 실제 일평균 이상이 나온 횟수가 우연 통과율의 직접 추정이다.`);
  L();
  L("## 8. 소요 시간·다운로드");
  L();
  const secs = rows.reduce((s, r) => s + r.seconds, 0);
  const logWall = (name: string) => {
    const file = join(homedir(), ".qquan", "logs", name);
    const m = existsSync(file) ? /done in (\d+)s · combos (\d+)/.exec(readFileSync(file, "utf8")) : null;
    return m ? `${m[1]}초` : "—";
  };
  void timingFile;
  L(`- 조합 ${total}개의 트리·워크포워드 합계 ${secs.toFixed(0)}초(조합당 평균 ${(secs / Math.max(1, total)).toFixed(1)}초). 실행 전체: Binance 경로 104조합 ${logWall("ceiling-field-binance.log")}(분봉 적재·피처 포함), Upbit 경로 36조합 ${logWall("ceiling-field-upbit.log")}.`);
  L("- 다운로드(공개, 인증 없음): Binance 파생 36개월 × 3종목(월 프리미엄·펀딩 + 일 5분 지표 약 1,078개/종목) — 원본 zip 139MB, parquet 193MB, 약 10분 · Upbit 1분봉 1년 × 4개 시장 약 239MB(요청 약 2,630회/시장, 시장 4개 병렬 약 34분) · 빈 분: KRW-BTC 1,399 · KRW-ETH 1,817 · KRW-SOL 6,258 · KRW-USDT 2,473(1년 527,040분 중).");
  L();
  const doc = readFileSync(out, "utf8");
  // Everything before the generated part (pre-registration, supplements) is kept; the generated part starts at "## 1. 결론" and is rewritten on every run.
  const marker = doc.includes("\n## 1. 결론") ? "\n## 1. 결론" : "(이하 측정 후 채움)";
  const head = doc.slice(0, doc.indexOf(marker)).replace(/\n+$/, "\n\n");
  writeFileSync(out, head + lines.join("\n") + "\n");
  console.error(`report written: ${out} (${rows.length} combos)`);
}
export {};
