/**
 * The trader's tools for the CT designer (stage 3): "what moved, and what came right before it"
 * measured on the TRAINING split only, by the server, with no models.
 *
 *  - ctLabelMoves     which moments were worth trading (target before stop after costs), clustered into
 *                     events, with when they happen (time of day, volatility, weekday, month)
 *  - ctContrastMoves  how the minutes before those events differ from time-matched control minutes,
 *                     feature by feature, plus a shallow tree checked on a later slice of training
 *  - ctDiagnoseTrades why a screened rule loses: by time, volatility, trend, weekday, holding time and
 *                     exit reason; entry problem or exit problem; the same entries under other exits
 *  - ctGradeBlind     the binomial test of the designer's own eye on mixed charts
 *
 * Everything reuses the code the replay and the live runner run (labelMoves, ctFeature, ctExitStep, ...).
 * Nothing here reads past contract.trainingToMs: a look-ahead that would cross it drops the moment.
 */
import { z } from "zod";
import {
  ctDate,
  ctExitStep,
  ctFeature,
  ctForcedExit,
  ctHistoryBars,
  ctImpactPct,
  ctNetTradePct,
  ctOpenPosition,
  ctRoundTripCostPct,
  ctBarsAt,
  ctDataAt,
  ctHigherTimeframes,
  ctNeedsLevels,
  type CTBar,
  type CTFeatureContext,
  type CTResult,
  type CTTrade,
} from "./ct-engine.ts";
import { buildDayLevels } from "./ct-levels.ts";
import { dayInfo, describeLeaf, growTree, labelMoves, leafPath, leaves, MOVE_REASON, type DayInfo, type MoveLabels } from "./ct-moves.ts";
import { buildHigherSeries, higherWindow, type CTHigherSeries } from "./ct-timeframes.ts";
import { ctBarMinutesSchema, ctConditionSchema, ctIsManagedExit, ctTestSignature, type CTCondition, type CTContract, type CTManagedExit, type CTSpec } from "./ct-spec.ts";
import { ctTimeBucket } from "./ct-design-tools.ts";

const DAY_MS = 86_400_000;
const MINUTE = 60_000;
const round = (n: number, digits = 4) => (Number.isFinite(n) ? Number(n.toFixed(digits)) : 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0);
function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * q,
    lo = Math.floor(at),
    hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const pct = (n: number, total: number) => round(total ? (n / total) * 100 : 0, 2);

/** mulberry32: a tiny seeded generator so controls and chart order are reproducible. */
export function ctRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** FNV-1a of a string, for deriving seeds from ids. */
export function ctSeedOf(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Training bars of one symbol: nothing before the research start, nothing closing after the training end. */
export function ctTrainingRows(data: Record<string, CTBar[]>, symbol: string, contract: Pick<CTContract, "fromMs" | "trainingToMs">) {
  return (data[symbol] ?? []).filter((b) => b.startMs >= contract.fromMs && b.endMs <= contract.trainingToMs);
}
const trainingDays = (contract: Pick<CTContract, "fromMs" | "trainingToMs">) => Math.max(1, Math.round((contract.trainingToMs - contract.fromMs) / DAY_MS));

/* ------------------------------------------------------------ binomial test */

function logChoose(n: number, k: number) {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}
/** Exact one-sided P(X ≥ k) for X ~ Binomial(n, p). */
export function ctBinomialUpperP(n: number, k: number, p = 0.5) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let total = 0;
  for (let x = k; x <= n; x++) total += Math.exp(logChoose(n, x) + x * Math.log(p) + (n - x) * Math.log(1 - p));
  return Math.min(1, total);
}

/* -------------------------------------------------------------- label_moves */

/**
 * k × the round-trip cost is the target, m × the round-trip cost is the stop, entry at the next bar's
 * open; horizon is a bar count or the day's last tradable bar (never across the day boundary).
 */
export const ctLabelMovesSchema = z
  .object({
    k: z.number().min(1).max(10).default(3),
    m: z.number().min(0.5).max(5).default(1),
    horizon: z.union([z.literal("day_end"), z.number().int().min(5).max(1440)]).default("day_end"),
    costMultiplier: z.union([z.literal(1), z.literal(2)]).default(1),
  })
  .strict();
/** Free bars (traderTools 4): the same request plus the bar the labels are computed on. */
export const ctLabelMovesSchemaBars = ctLabelMovesSchema.extend({ barMinutes: ctBarMinutesSchema });
export type CTLabelParams = z.infer<typeof ctLabelMovesSchema> & { barMinutes?: 1 | 5 | 15 | 60 };
/** The bar a label (and every contrast on it) runs on: its own choice, else the contract's data bar. */
export const ctLabelBar = (params: Pick<CTLabelParams, "barMinutes">, contract: Pick<CTContract, "minutes">) => params.barMinutes ?? contract.minutes;
export const CT_CLUSTER_RULE =
  "양성 순간(진입 다음 봉 시가에서 목표가 손절보다 먼저 닿는 시점)이 연속되면 한 움직임이다: 종목별로 시간순 스캔해 첫 양성 순간 i0에서 사건을 열고, i0의 거래가 목표에 닿는 봉(i0의 청산 봉)까지 나오는 양성 순간은 같은 사건으로 묶는다. 그 다음 양성 순간부터 새 사건이다. 사건의 대표 시각은 그 사건 안 양성 순간들의 중앙값 순간의 봉 마감(진입 직전 판단 시각)이다: 첫 순간은 아직 원인이 보이기 전일 수 있고 마지막 순간은 이미 움직임 안이라서, 거래할 수 있었던 순간들의 한가운데를 쓴다.";

export type CTLabelRun = {
  symbol: string;
  rows: CTBar[];
  day: DayInfo;
  labels: MoveLabels;
  costPct: number;
  validMoments: number;
  positiveMoments: number;
  /** Representative decision bar of each event: the median positive moment of its cluster. */
  events: number[];
  /** First and last positive moment of each event, aligned with `events`. */
  spans: Array<{ first: number; last: number }>;
};

/** Labels every training moment of every symbol; a moment whose look-ahead would pass the training end is dropped. */
export function ctRunLabels(params: CTLabelParams, data: Record<string, CTBar[]>, contract: CTContract): CTLabelRun[] {
  const costPct = ctRoundTripCostPct(contract, params.costMultiplier);
  const bar = ctLabelBar(params, contract);
  return contract.symbols.flatMap((symbol) => {
    const rows = ctTrainingRows({ [symbol]: ctBarsAt(data[symbol] ?? [], bar) }, symbol, contract);
    if (rows.length < 100) return [];
    const day = dayInfo(rows, contract.market);
    const hold = params.horizon === "day_end" ? Infinity : params.horizon;
    const labels = labelMoves(rows, day, { costPct, k: params.k, m: params.m, holdBars: hold });
    const n = rows.length;
    // Drop, never shorten: a trade that could still be open at the training end is not a label.
    for (let i = 0; i + 1 < n; i++) {
      if (labels.label[i] < 0) continue;
      const e = i + 1;
      const crosses = hold === Infinity ? day.endMs[e] > contract.trainingToMs : e + hold - 1 > n - 1;
      if (crosses) labels.label[i] = -1;
    }
    let valid = 0,
      positive = 0,
      eventEnd = -1;
    const members: number[][] = [];
    for (let i = 0; i < n; i++) {
      if (labels.label[i] < 0) continue;
      valid++;
      if (labels.label[i] !== 1) continue;
      positive++;
      if (i > eventEnd) {
        members.push([i]);
        eventEnd = labels.exitIndex[i];
      } else members[members.length - 1].push(i);
    }
    const events = members.map((m) => m[Math.floor((m.length - 1) / 2)]);
    const spans = members.map((m) => ({ first: m[0], last: m[m.length - 1] }));
    return [{ symbol, rows, day, labels, costPct, validMoments: valid, positiveMoments: positive, events, spans }];
  });
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const weekdayOf = (ms: number, contract: Pick<CTContract, "market" | "timezone">) =>
  WEEKDAYS[new Date(`${ctDate(ms, contract.market, contract.timezone)}T00:00:00Z`).getUTCDay()];
/** Range of the 60 bars before bar e as percent (null without a contiguous history). */
function priorRange60(rows: CTBar[], e: number) {
  if (e < 60 || rows[e].startMs - rows[e - 60].startMs !== 60 * (rows[e].endMs - rows[e].startMs)) return null;
  let high = -Infinity,
    low = Infinity;
  for (let k = e - 60; k < e; k++) {
    if (rows[k].high > high) high = rows[k].high;
    if (rows[k].low < low) low = rows[k].low;
  }
  return (high / low - 1) * 100;
}

function tally(keys: string[], baseKeys: string[], order?: readonly string[]) {
  const count = new Map<string, number>(),
    base = new Map<string, number>();
  for (const k of keys) count.set(k, (count.get(k) ?? 0) + 1);
  for (const k of baseKeys) base.set(k, (base.get(k) ?? 0) + 1);
  const names = order ? [...order] : [...new Set([...count.keys(), ...base.keys()])].sort();
  return names.map((key) => {
    const eventShare = keys.length ? ((count.get(key) ?? 0) / keys.length) * 100 : 0,
      baseShare = baseKeys.length ? ((base.get(key) ?? 0) / baseKeys.length) * 100 : 0;
    return {
      key,
      events: count.get(key) ?? 0,
      eventSharePct: round(eventShare, 1),
      baseSharePct: round(baseShare, 1),
      lift: baseShare > 0 ? round(eventShare / baseShare, 2) : null,
    };
  });
}

export type CTMoveAnchor = { at: number; time: string; symbol: string; netPct?: number; group: "positive" | "control" };

/**
 * Time-free blind charts (traderTools 6) draw the last 120 one-hour bars. A moment too close to the start of the data draws
 * fewer of them, which would single it out among the times the designer chose; such moments are not issued as chart anchors
 * with `slot: "bar"`. Crypto: five days. Stocks: 120 anchor-aligned hours take up to 24 sessions, about 35 calendar days.
 */
export const ctChartable = (ms: number, contract: Pick<CTContract, "market" | "fromMs">) => ms - contract.fromMs >= (contract.market === "crypto" ? 5 : 35) * DAY_MS;

/**
 * Control moments matched to each positive event: same hour of the day and month, label 0, seeded.
 * `slot: "bar"` (traderTools 6, time-free blind sets) matches the event's bar slot of the day instead of its hour — the same
 * minute after the day start at the label's bar size (a 15-minute label: the same quarter hour) — drawn from every bar, not
 * every third: run 7a4354f4 told a 15-minute event from its same-hour control by how far into the day the chart was.
 */
export function ctMatchedControls(runs: CTLabelRun[], picks: Array<{ symbol: string; index: number }>, contract: CTContract, seed: number, slot: "hour" | "bar" = "hour"): CTMoveAnchor[] {
  const rng = ctRng(seed);
  const pools = new Map<string, Map<string, number[]>>();
  const keyOf = (run: CTLabelRun, i: number) => {
    const ms = run.rows[i].endMs;
    const size = slot === "bar" ? run.rows[i].endMs - run.rows[i].startMs : 60 * MINUTE;
    return `${Math.floor((ms - run.day.startMs[i]) / size)}|${ctDate(ms, contract.market, contract.timezone).slice(0, 7)}`;
  };
  const poolOf = (run: CTLabelRun) => {
    let pool = pools.get(run.symbol);
    if (pool) return pool;
    pool = new Map();
    for (let i = 0; i < run.rows.length; i += slot === "bar" ? 1 : 3) {
      if (run.labels.label[i] !== 0) continue;
      if (slot === "bar" && !ctChartable(run.rows[i].endMs, contract)) continue;
      const key = keyOf(run, i);
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key)!.push(i);
    }
    pools.set(run.symbol, pool);
    return pool;
  };
  const out: CTMoveAnchor[] = [];
  for (const pick of picks) {
    const run = runs.find((r) => r.symbol === pick.symbol);
    if (!run) continue;
    const candidates = poolOf(run).get(keyOf(run, pick.index));
    if (!candidates?.length) continue;
    const i = candidates[Math.floor(rng() * candidates.length)];
    out.push({ at: run.rows[i].endMs, time: new Date(run.rows[i].endMs).toISOString(), symbol: run.symbol, netPct: round(run.labels.grossPct[i] - run.costPct), group: "control" });
  }
  return out;
}

/**
 * The label_moves report: how many moments were worth trading, how many separate events, and when
 * they cluster, each against the same dimension over all valid moments.
 */
export function ctLabelMovesReport(params: CTLabelParams, runs: CTLabelRun[], contract: CTContract, labelId: string, options: { blindReserve?: boolean; controlSlot?: "hour" | "bar" } = {}) {
  const slot = options.controlSlot ?? "hour";
  const days = trainingDays(contract);
  const costPct = ctRoundTripCostPct(contract, params.costMultiplier);
  const eventKeys = { time: [] as string[], vol: [] as string[], weekday: [] as string[], month: [] as string[] };
  const baseKeys = { time: [] as string[], vol: [] as string[], weekday: [] as string[], month: [] as string[] };
  // Volatility terciles over every third valid moment (the population the labels were drawn from).
  const population: number[] = [];
  for (const run of runs)
    for (let i = 0; i < run.rows.length; i += 3) {
      if (run.labels.label[i] < 0) continue;
      const r = priorRange60(run.rows, i + 1);
      if (r !== null) population.push(r);
    }
  const ps = sorted(population),
    cut = [quantile(ps, 1 / 3), quantile(ps, 2 / 3)];
  const regime = (r: number | null) => (r === null ? null : r <= cut[0] ? "저변동" : r <= cut[1] ? "중변동" : "고변동");
  let sumNet = 0,
    nNet = 0;
  for (const run of runs) {
    for (let i = 0; i < run.rows.length; i += 3) {
      if (run.labels.label[i] < 0) continue;
      sumNet += run.labels.grossPct[i] - run.costPct;
      nNet++;
      baseKeys.time.push(ctTimeBucket(run.rows[i].endMs, contract));
      const v = regime(priorRange60(run.rows, i + 1));
      if (v) baseKeys.vol.push(v);
      baseKeys.weekday.push(weekdayOf(run.rows[i].endMs, contract));
      baseKeys.month.push(ctDate(run.rows[i].endMs, contract.market, contract.timezone).slice(0, 7));
    }
    for (const i of run.events) {
      eventKeys.time.push(ctTimeBucket(run.rows[i].endMs, contract));
      const v = regime(priorRange60(run.rows, i + 1));
      if (v) eventKeys.vol.push(v);
      eventKeys.weekday.push(weekdayOf(run.rows[i].endMs, contract));
      eventKeys.month.push(ctDate(run.rows[i].endMs, contract.market, contract.timezone).slice(0, 7));
    }
  }
  const events = runs.reduce((s, r) => s + r.events.length, 0),
    positive = runs.reduce((s, r) => s + r.positiveMoments, 0),
    valid = runs.reduce((s, r) => s + r.validMoments, 0);
  const timeOrder = contract.market === "crypto" ? ["00-06 UTC", "06-12 UTC", "12-18 UTC", "18-24 UTC"] : ["개장 60분", "장 중반", "마감 60분"];
  // Representative events: evenly spread over the training time line, up to 12.
  // Time-free blind sets: only moments with a full chart history behind them become anchors (the counts above use every event).
  const all = runs
    .flatMap((run) => run.events.map((i) => ({ run, i })))
    .filter(({ run, i }) => slot !== "bar" || ctChartable(run.rows[i].endMs, contract))
    .sort((a, b) => a.run.rows[a.i].endMs - b.run.rows[b.i].endMs);
  const take = Math.min(12, all.length);
  const picked = Array.from({ length: take }, (_, k) => all[Math.min(all.length - 1, Math.floor(((k + 0.5) * all.length) / take))]);
  const anchors: CTMoveAnchor[] = picked.map(({ run, i }) => ({
    at: run.rows[i].endMs,
    time: new Date(run.rows[i].endMs).toISOString(),
    symbol: run.symbol,
    netPct: round(run.labels.grossPct[i] - run.costPct),
    group: "positive",
  }));
  const seed = ctSeedOf(labelId);
  const controls = ctMatchedControls(runs, picked.map(({ run, i }) => ({ symbol: run.symbol, index: i })), contract, seed, slot);
  // Stage 4: reserve anchors for blind sets (16–32 charts need up to 16 events and 16 controls beyond the 12 + 12 above).
  // Same representative-time rule; events are spread over the remaining timeline; controls are matched with another seed
  // and never repeat a displayed control or one another.
  let blindReserve: { anchors: CTMoveAnchor[]; controlAnchors: CTMoveAnchor[]; note: string } | undefined;
  if (options.blindReserve) {
    const rest = all.filter((e) => !picked.includes(e));
    const takeReserve = Math.min(16, rest.length);
    const reservePicks = Array.from({ length: takeReserve }, (_, k) => rest[Math.min(rest.length - 1, Math.floor(((k + 0.5) * rest.length) / takeReserve))]);
    const seen = new Set(controls.map((c) => `${c.symbol}:${c.at}`));
    const reserveControls = ctMatchedControls(runs, reservePicks.map(({ run, i }) => ({ symbol: run.symbol, index: i })), contract, ctSeedOf(`${labelId}:blind`), slot).filter((c) => {
      const key = `${c.symbol}:${c.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    blindReserve = {
      anchors: reservePicks.map(({ run, i }) => ({ at: run.rows[i].endMs, time: new Date(run.rows[i].endMs).toISOString(), symbol: run.symbol, netPct: round(run.labels.grossPct[i] - run.costPct), group: "positive" as const })),
      controlAnchors: reserveControls,
      note: "블라인드 세트(16–32장)용 예비 이벤트·대조군 시각. 위 anchors·controlAnchors와 합치면 이벤트와 대조군을 같은 수로 최대 32장까지 만들 수 있다. 일반 보기(blind 아님)로 이미 본 시각은 블라인드 세트에 쓸 수 없다.",
    };
  }
  return {
    labelId,
    params,
    definition: `진입 = 다음 봉 시가 · 목표 +${round(params.k * costPct, 3)}% (= ${params.k} × 왕복 비용 ${round(costPct, 3)}%${params.costMultiplier === 2 ? ", 비용 2배 기준" : ""}) · 손절 −${round(params.m * costPct, 3)}% · 보유 ${params.horizon === "day_end" ? "당일 마지막 거래 봉까지" : `${params.horizon}봉`} · 목표가 손절보다 먼저 닿으면 양성`,
    clusteringRule: CT_CLUSTER_RULE,
    symbols: runs.map((r) => ({ symbol: r.symbol, validMoments: r.validMoments, positiveMoments: r.positiveMoments, events: r.events.length })),
    trainingDays: days,
    validMoments: valid,
    positiveMoments: positive,
    baseRatePct: pct(positive, valid),
    events,
    eventsPerDay: round(events / days, 3),
    positiveMomentsPerDay: round(positive / days, 2),
    unconditionalNetMeanPct: round(nNet ? sumNet / nNet : 0),
    distributions: {
      timeOfDay: tally(eventKeys.time, baseKeys.time, timeOrder),
      volatility: tally(eventKeys.vol, baseKeys.vol, ["저변동", "중변동", "고변동"]),
      weekday: tally(eventKeys.weekday, baseKeys.weekday, WEEKDAYS),
      month: tally(eventKeys.month, baseKeys.month),
    },
    volatilityCutoffsPct: { prior60BarRangeP33: round(cut[0]), prior60BarRangeP67: round(cut[1]) },
    anchors,
    controlAnchors: controls,
    ...(blindReserve ? { blindReserve } : {}),
    ...(slot === "bar" ? { controlMatching: `대조군 = 이벤트와 같은 달 · 하루 시작 후 같은 봉 자리(라벨 봉 단위, 15분 라벨이면 같은 15분) · 라벨 0. 블라인드 차트는 시각·시간대를 보이지 않는다(모든 패널이 결정 시각에서 끝나는 최근 N봉). 차트 이력(1시간봉 120개)이 모자라는 데이터 시작 ${contract.market === "crypto" ? "5일" : "35일"} 안의 순간은 시각으로 발급하지 않는다.` } : {}),
    note: "lift = 사건 비율 ÷ 전체 유효 순간 비율(기저 분포는 3분마다 표본). lift는 어디를 볼지의 단서일 뿐 성과 근거가 아니다. 학습 구간만.",
  };
}
export type CTLabelReport = ReturnType<typeof ctLabelMovesReport>;

/* ------------------------------------------------------------ contrast_moves */

export const ctFeatureSpecSchema = z
  .object({
    feature: ctConditionSchema.shape.feature,
    lookback: z.number().int().min(2).max(120),
    offset: z.number().int().min(0).max(120).default(0),
    timeframe: z.union([z.literal(1), z.literal(3), z.literal(12), z.literal(60), z.literal(240), z.literal(1440)]),
    unit: z.enum(["pct", "atr"]).optional(),
    atrLookback: z.number().int().min(2).max(120).optional(),
    atrTimeframe: z.union([z.literal(1), z.literal(3), z.literal(12), z.literal(60), z.literal(240), z.literal(1440)]).optional(),
  })
  .strict();
/** Stage 3 request (frozen: the tool definition's JSON schema is part of every cached prefix of a traderTools = 1 run). */
export const ctContrastMovesSchemaStage3 = z
  .object({
    labelId: z.string().min(8).max(40),
    features: z.array(ctFeatureSpecSchema).min(1).max(12),
    tree: z.boolean().default(true),
    seed: z.number().int().min(0).max(1_000_000).default(1),
  })
  .strict();
/**
 * Control groups (stage 4, docs/ct.md「대조군 모드」): "time" = same hour of the day and month (the stage-3 control, byte
 * for byte); "vol_matched" = also the same 60-minute-ATR quintile; "losers" = the label's own stop-first events matched on hour, month and volatility.
 */
export const CT_CONTROL_MODES = ["time", "vol_matched", "losers"] as const;
export type CTControlMode = (typeof CT_CONTROL_MODES)[number];
export const ctContrastMovesSchema = z
  .object({
    labelId: z.string().min(8).max(40),
    features: z.array(ctFeatureSpecSchema).min(1).max(12),
    controls: z.enum(CT_CONTROL_MODES).default("time"),
    tree: z.boolean().default(true),
    seed: z.number().int().min(0).max(1_000_000).default(1),
  })
  .strict();
/** `controls` is absent on a stage-3 request; the result then keeps the stage-3 shape exactly. */
export type CTContrastRequest = Omit<z.infer<typeof ctContrastMovesSchema>, "controls"> & { controls?: CTControlMode };

/** The neutral condition (no threshold) a feature spec stands for. Throws the condition schema's message when the spec is not a legal feature. */
export function ctFeatureCondition(spec: z.infer<typeof ctFeatureSpecSchema>): CTCondition {
  return ctConditionSchema.parse({ ...spec, op: "gte", value: 0 });
}
export const ctFeatureName = (c: Pick<CTCondition, "feature" | "lookback" | "offset" | "timeframe" | "unit">) =>
  `${c.feature}(${c.lookback}${c.offset ? `,지연${c.offset}` : ""}, ${c.timeframe}m${c.unit === "atr" ? ",ATR" : ""})`;

/** Higher-timeframe series and day levels the given conditions read, built once per symbol. */
function featureContext(conditions: CTCondition[], rows: CTBar[], contract: Pick<CTContract, "market">, symbol: string) {
  const probe = probeSpec(conditions, contract.market);
  const higher = new Map<number, CTHigherSeries>();
  for (const tf of ctHigherTimeframes(probe)) higher.set(tf, buildHigherSeries(rows, tf, contract.market, symbol));
  const ctx: CTFeatureContext = { higher, levels: ctNeedsLevels(probe) ? buildDayLevels(rows, contract.market) : undefined, market: contract.market, symbol };
  return { ctx, history: ctHistoryBars(probe), probe };
}
/** An unvalidated spec shell: just enough for the engine's window/context helpers. */
function probeSpec(conditions: CTCondition[], market: CTContract["market"]): CTSpec {
  return {
    version: 1,
    engine: "ct-pattern-3",
    name: "probe",
    market,
    symbols: ["PROBE"],
    minutes: 1,
    stages: [{ label: "probe", maxGapBars: 1, conditions }],
    entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
    exit: { stopPct: 1, targetPct: 1, maxHoldBars: 1, invalidation: "stop" },
    sizing: { riskPct: 1, allocationPct: 1, maxPositions: 1, cooldownBars: 1, participationPct: 1 },
    sourceIds: ["probe"],
    assumptions: ["probe shell"],
  } as CTSpec;
}
/** Feature values (NaN = unavailable) at the given decision bars of one symbol. */
export function ctFeatureColumns(conditions: CTCondition[], rows: CTBar[], indexes: number[], contract: Pick<CTContract, "market">, symbol: string): Float32Array[] {
  const { ctx, history } = featureContext(conditions, rows, contract, symbol);
  const cols = conditions.map(() => new Float32Array(indexes.length).fill(NaN));
  indexes.forEach((i, r) => {
    const input = rows.slice(Math.max(0, i - history + 1), i + 1);
    conditions.forEach((c, f) => {
      const v = ctFeature(c, input, rows[i].endMs, ctx);
      if (v !== null && Number.isFinite(v)) cols[f][r] = v;
    });
  });
  return cols;
}

/** Share of the control quintile bins; edges are the control distribution's 20/40/60/80th percentiles. */
const BIN_LABELS = ["하위 20%", "20–40%", "40–60%", "60–80%", "상위 20%"] as const;
function binIndex(edges: number[], v: number) {
  let b = 0;
  while (b < edges.length && v > edges[b]) b++;
  return b;
}


/* ---------------------------------------------------- stage 4: control modes */

/**
 * 60-minute ATR(14) as percent of the last completed hourly bar's close — the DSL's atr_pct(14, 60m) — per base bar
 * (NaN until 15 contiguous hourly bars exist). The value only changes when an hourly bar completes, so the feature is
 * evaluated once per completed hourly bar and carried forward over the minutes that follow it.
 */
export function ctVolatilityColumn(run: Pick<CTLabelRun, "rows" | "symbol">, contract: Pick<CTContract, "market">): Float32Array {
  const n = run.rows.length,
    col = new Float32Array(n).fill(NaN);
  const series = buildHigherSeries(run.rows, 60, contract.market, run.symbol);
  const update: number[] = [];
  let c = 0;
  for (let i = 0; i < n; i++) {
    const before = c;
    while (c < series.bars.length && series.bars[c].endMs <= run.rows[i].endMs) c++;
    if (c !== before) update.push(i);
  }
  const cond = ctConditionSchema.parse({ feature: "atr_pct", lookback: 14, offset: 0, timeframe: 60, op: "gte", value: 0 });
  const values = ctFeatureColumns([cond], run.rows, update, contract, run.symbol)[0];
  update.forEach((u, k) => {
    const end = k + 1 < update.length ? update[k + 1] : n;
    if (Number.isFinite(values[k])) col.fill(values[k], u, end);
  });
  return col;
}
const QUINTILES = [0.2, 0.4, 0.6, 0.8] as const;
/** Quintile edges of the volatility column over every valid training moment of one symbol. */
export function ctVolatilityEdges(run: Pick<CTLabelRun, "rows" | "labels">, vol: Float32Array) {
  const xs: number[] = [];
  for (let i = 0; i < run.rows.length; i++) if (run.labels.label[i] >= 0 && Number.isFinite(vol[i])) xs.push(vol[i]);
  const s = sorted(xs);
  return QUINTILES.map((q) => quantile(s, q));
}
/** Losing events of a label: stop hit before the target, clustered and represented exactly like positive events. */
export function ctLoserEvents(run: Pick<CTLabelRun, "rows" | "labels">) {
  const { label, reason, exitIndex } = run.labels;
  const members: number[][] = [];
  let eventEnd = -1;
  for (let i = 0; i < run.rows.length; i++) {
    if (label[i] !== 0 || reason[i] !== MOVE_REASON.stop) continue;
    if (i > eventEnd) {
      members.push([i]);
      eventEnd = exitIndex[i];
    } else members[members.length - 1].push(i);
  }
  return members.map((m) => m[Math.floor((m.length - 1) / 2)]);
}

/**
 * How a feature's lift is shaped across the control quintiles (stage 4). A quintile is "elevated" when its lift is at
 * least 1.25 and its z at least 2 (the event share is clearly above the control share). Lower tail = bins[0], upper
 * tail = bins[4].
 *   two_tailed   both tails elevated (events sit at the extremes of either sign: a volatility-type effect)
 *   monotone_up  upper tail elevated, lower tail not, and the upper lift above the lower lift
 *   monotone_down lower tail elevated, upper tail not, and the lower lift above the upper lift
 *   flat         otherwise (no tail is clearly elevated)
 * Pure rule on the printed bins; the thresholds are a reading aid, not a significance test (no multiplicity correction).
 */
export type CTLiftShape = "monotone_up" | "monotone_down" | "two_tailed" | "flat";
export const CT_SHAPE_RULE = "모양 분류: 양 끝 5분위 중 lift ≥ 1.25 이고 z ≥ 2 이면 '높음'. 양 끝 모두 높음 = two_tailed(부호와 무관한 극단 = 변동성형), 위쪽만 높음 = monotone_up, 아래쪽만 높음 = monotone_down, 그 밖 = flat.";
export function ctLiftShape(bins: Array<{ lift: number | null; z: number }>): CTLiftShape {
  const high = (b: { lift: number | null; z: number } | undefined) => Boolean(b && b.lift !== null && b.lift >= 1.25 && b.z >= 2);
  const lo = bins[0],
    hi = bins[bins.length - 1];
  const up = high(hi),
    down = high(lo);
  if (up && down) return "two_tailed";
  if (up && (lo?.lift ?? 0) < (hi.lift ?? 0)) return "monotone_up";
  if (down && (hi?.lift ?? 0) < (lo.lift ?? 0)) return "monotone_down";
  return "flat";
}
const CONTROL_RULES: Record<CTControlMode, string> = {
  time: "대조군 = 같은 시간대(하루 시작 후 같은 시)와 같은 달의 유효 순간에서 사건당 3개를 시드 고정 무작위로 추출(라벨 무관 기저 모집단). lift = 구간 안 양성 비율 ÷ 구간 안 대조군 비율. bin은 대조군 분위로 자른 5구간, z는 대조군 비율 대비 양성 개수의 정규근사 편차(다중 비교 미보정).",
  vol_matched:
    "대조군 = 같은 시간대·같은 달·같은 변동성 5분위(결정 시점에 완성된 60분봉 ATR(14) ÷ 그 60분봉 종가, 5분위 경계 = 학습 구간 유효 순간 전체)의 유효 순간에서 사건당 3개를 비복원·시드 고정 무작위로 추출(라벨 무관). 같은 칸에 후보가 3개 미만이거나 변동성을 못 구한 사건은 버린다(droppedEvents). 변동성을 맞췄으므로 여기서도 남는 lift는 변동성 효과가 아니다. lift·bin·z는 time과 같다.",
  losers:
    "대조군 = 같은 라벨에서 손절이 목표보다 먼저 닿은 순간을 양성 사건과 같은 규칙으로 묶은 음성 사건(대표 시각 = 묶음 안 중앙값 순간). 양성 사건과 같은 시간대·같은 달·같은 변동성 5분위 칸에서 사건당 최대 3개(최소 1개)를 비복원·시드 고정으로 뽑고, 칸에 음성 사건이 없으면 그 양성 사건은 버린다(droppedEvents). lift = '같은 시각·같은 변동성에서 위로 갔는가 아래로 갔는가'의 차이.",
};
/** One symbol's kept events with the controls drawn for each (`groups`), the dropped-event count and the volatility quintile edges used. */
export type MatchedSymbol = { run: CTLabelRun; events: number[]; controls: number[]; groups: Array<{ event: number; controls: number[] }>; dropped: number; edges: number[] };
export function ctControlSets(runs: CTLabelRun[], mode: "vol_matched" | "losers", contract: CTContract, rng: () => number): MatchedSymbol[] {
  return runs.map((run) => {
    const vol = ctVolatilityColumn(run, contract),
      edges = ctVolatilityEdges(run, vol);
    const month = (i: number) => ctDate(run.rows[i].endMs, contract.market, contract.timezone).slice(0, 7);
    const key = (i: number) => `${Math.floor((run.rows[i].endMs - run.day.startMs[i]) / (60 * MINUTE))}|${month(i)}|${binIndex(edges, vol[i])}`;
    const pool = new Map<string, number[]>();
    const add = (i: number) => {
      const k = key(i);
      (pool.get(k) ?? pool.set(k, []).get(k)!).push(i);
    };
    if (mode === "vol_matched") {
      for (let i = 0; i < run.rows.length; i += 2) if (run.labels.label[i] >= 0 && Number.isFinite(vol[i])) add(i);
    } else for (const i of ctLoserEvents(run)) if (Number.isFinite(vol[i])) add(i);
    const need = mode === "vol_matched" ? 3 : 1;
    const events: number[] = [],
      controls: number[] = [],
      groups: MatchedSymbol["groups"] = [];
    let dropped = 0;
    for (const i of run.events.slice(0, 4000)) {
      const candidates = Number.isFinite(vol[i]) ? pool.get(key(i)) : undefined;
      if (!candidates || candidates.length < need) {
        dropped++;
        continue;
      }
      // Without replacement: partial Fisher–Yates on a copy.
      const copy = candidates.slice();
      const take = Math.min(3, copy.length),
        mine: number[] = [];
      for (let r = 0; r < take; r++) {
        const j = r + Math.floor(rng() * (copy.length - r));
        [copy[r], copy[j]] = [copy[j], copy[r]];
        controls.push(copy[r]);
        mine.push(copy[r]);
      }
      events.push(i);
      groups.push({ event: i, controls: mine });
    }
    return { run, events, controls, groups, dropped, edges };
  });
}

export type CTContrastResult = ReturnType<typeof ctContrastMoves>;
/**
 * For each feature: the distribution just before the events against matched control minutes, lift per
 * control quintile, and — optionally — a depth-3 tree grown on the first 2/3 of training days and
 * re-measured on the last 1/3. Look-ahead never leaves the training split.
 */
export function ctContrastMoves(
  request: CTContrastRequest,
  params: CTLabelParams,
  runs: CTLabelRun[],
  contract: CTContract,
  options: { deadline?: number } = {},
) {
  const conditions = request.features.map(ctFeatureCondition);
  const names = conditions.map(ctFeatureName);
  const rng = ctRng(ctSeedOf(`${request.labelId}:${request.seed}`));
  const check = () => {
    if (options.deadline && Date.now() > options.deadline) throw new Error("CT 계산 시간 상한");
  };
  // Positive events and time-matched controls (same hour of the day and month, any label: the base population).
  const mode = request.controls;
  const matched = mode === "vol_matched" || mode === "losers" ? ctControlSets(runs, mode, contract, rng) : null;
  const perSymbol: Array<{ run: CTLabelRun; events: number[]; controls: number[] }> = matched ?? runs.map((run) => {
    const pool = new Map<string, number[]>(),
      hourPool = new Map<number, number[]>();
    for (let i = 0; i < run.rows.length; i += 2) {
      if (run.labels.label[i] < 0) continue;
      const hour = Math.floor((run.rows[i].endMs - run.day.startMs[i]) / (60 * MINUTE));
      const key = `${hour}|${ctDate(run.rows[i].endMs, contract.market, contract.timezone).slice(0, 7)}`;
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key)!.push(i);
      if (!hourPool.has(hour)) hourPool.set(hour, []);
      hourPool.get(hour)!.push(i);
    }
    const ratio = 3,
      cap = 4000;
    const events = run.events.slice(0, cap);
    const controls: number[] = [];
    for (const i of events) {
      const hour = Math.floor((run.rows[i].endMs - run.day.startMs[i]) / (60 * MINUTE));
      const key = `${hour}|${ctDate(run.rows[i].endMs, contract.market, contract.timezone).slice(0, 7)}`;
      const candidates = pool.get(key) ?? hourPool.get(hour);
      if (!candidates?.length) continue;
      for (let r = 0; r < ratio; r++) controls.push(candidates[Math.floor(rng() * candidates.length)]);
    }
    return { run, events, controls };
  });
  const features: Array<{
    feature: string;
    positive: { n: number; missing: number; mean: number; quantiles: Record<string, number> };
    control: { n: number; missing: number; mean: number; quantiles: Record<string, number> };
    bins: Array<{ bin: string; upTo?: number; positive: number; control: number; lift: number | null; z: number }>;
    bestBin: { bin: string; lift: number | null } | null;
    shape?: CTLiftShape;
  }> = [];
  const pos: number[][] = conditions.map(() => []),
    ctl: number[][] = conditions.map(() => []);
  const posMissing = conditions.map(() => 0),
    ctlMissing = conditions.map(() => 0);
  for (const { run, events, controls } of perSymbol) {
    check();
    const pcols = ctFeatureColumns(conditions, run.rows, events, contract, run.symbol);
    const ccols = ctFeatureColumns(conditions, run.rows, controls, contract, run.symbol);
    conditions.forEach((_, f) => {
      for (const v of pcols[f]) {
        if (Number.isFinite(v)) pos[f].push(v);
        else posMissing[f]++;
      }
      for (const v of ccols[f]) {
        if (Number.isFinite(v)) ctl[f].push(v);
        else ctlMissing[f]++;
      }
    });
  }
  const qs = [0.1, 0.25, 0.5, 0.75, 0.9] as const;
  const quant = (xs: number[]) => {
    const s = sorted(xs);
    return Object.fromEntries(qs.map((q) => [`p${Math.round(q * 100)}`, round(quantile(s, q))]));
  };
  conditions.forEach((_, f) => {
    const cs = sorted(ctl[f]);
    const edges = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(cs, q));
    const pc = new Array(5).fill(0),
      cc = new Array(5).fill(0);
    for (const v of pos[f]) pc[binIndex(edges, v)]++;
    for (const v of ctl[f]) cc[binIndex(edges, v)]++;
    const bins = BIN_LABELS.map((bin, b) => {
      const ps = pos[f].length ? pc[b] / pos[f].length : 0,
        cs2 = ctl[f].length ? cc[b] / ctl[f].length : 0;
      // Normal approximation of the positive count against the control share.
      const sd = Math.sqrt(Math.max(1e-12, pos[f].length * cs2 * (1 - cs2)));
      const z = pos[f].length && cs2 > 0 ? (pc[b] - pos[f].length * cs2) / sd : 0;
      return { bin, edge: b < 4 ? round(edges[b]) : null, positive: pc[b], control: cc[b], lift: cs2 > 0 ? round(ps / cs2, 2) : null, z: round(z, 2) };
    });
    const enough = pos[f].length >= 20;
    const best = enough ? [...bins].filter((x) => x.lift !== null).sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0] : undefined;
    features.push({
      feature: names[f],
      positive: { n: pos[f].length, missing: posMissing[f], mean: round(mean(pos[f])), quantiles: quant(pos[f]) },
      control: { n: ctl[f].length, missing: ctlMissing[f], mean: round(mean(ctl[f])), quantiles: quant(ctl[f]) },
      bins: bins.map(({ edge, ...rest }) => ({ ...rest, ...(edge !== null ? { upTo: edge } : {}) })),
      bestBin: best ? { bin: best.bin, lift: best.lift } : null,
      ...(mode ? { shape: ctLiftShape(bins) } : {}),
    });
  });
  const tree = request.tree ? contrastTree(conditions, names, runs, contract, params, options, matched ? perSymbol : undefined) : null;
  const eventCount = perSymbol.reduce((s, x) => s + x.events.length, 0);
  const controlCount = perSymbol.reduce((s, x) => s + x.controls.length, 0);
  return {
    labelId: request.labelId,
    events: eventCount,
    controls: controlCount,
    controlRule: CONTROL_RULES.time,
    // Stage 4 only (a request with `controls`): the mode, what it dropped, and how to read the shapes.
    ...(mode
      ? {
          controlMode: mode,
          controlRule: CONTROL_RULES[mode],
          droppedEvents: matched ? matched.reduce((s, x) => s + x.dropped, 0) : 0,
          positiveEvents: eventCount,
          controlsPerEvent: eventCount ? round(controlCount / eventCount, 2) : 0,
          ...(matched ? { volatilityQuintileEdgesPct: matched.map((m) => ({ symbol: m.run.symbol, edges: m.edges.map((e) => round(e)) })) } : {}),
          shapeRule: CT_SHAPE_RULE,
        }
      : {}),
    features,
    tree,
    testedBins: conditions.length * 5,
    treeSplitsEvaluated: tree?.candidateSplits ?? 0,
    note: "lift는 어디를 볼지의 단서일 뿐 성과 근거가 아니다. 최종 확인은 query_conditional_returns와 screen_rule로 한다. 학습 구간만.",
  };
}

function contrastTree(conditions: CTCondition[], names: string[], runs: CTLabelRun[], contract: CTContract, params: CTLabelParams, options: { deadline?: number }, matched?: Array<{ run: CTLabelRun; events: number[]; controls: number[] }>) {
  // Sampled moments: every Nth valid moment so the table stays near 15,000 rows.
  const totalValid = runs.reduce((s, r) => s + r.validMoments, 0);
  const stride = Math.max(3, Math.ceil(totalValid / 15_000));
  type Row = { run: CTLabelRun; i: number; key: number; cls?: 0 | 1 };
  const sample: Row[] = [];
  // Stage 4 (vol_matched / losers): the tree separates the kept events (class 1) from the chosen controls (class 0).
  if (matched) {
    for (const m of matched) {
      for (const i of m.events) sample.push({ run: m.run, i, key: m.run.day.key[i], cls: 1 });
      for (const i of m.controls) sample.push({ run: m.run, i, key: m.run.day.key[i], cls: 0 });
    }
  } else for (const run of runs) for (let i = 0; i < run.rows.length; i += stride) if (run.labels.label[i] >= 0) sample.push({ run, i, key: run.day.key[i] });
  if (sample.length < (matched ? 150 : 400)) return null;
  const dayKeys = [...new Set(sample.map((r) => r.key))].sort((a, b) => a - b);
  if (dayKeys.length < 6) return null;
  const cutKey = dayKeys[Math.floor((dayKeys.length * 2) / 3)];
  // The first holdout bar of each symbol: training moments whose trade is still open then are purged.
  const holdoutStart = new Map<string, number>();
  for (const { run, i, key } of sample) if (key >= cutKey && !holdoutStart.has(run.symbol)) holdoutStart.set(run.symbol, run.rows[i].startMs);
  const bySymbol = new Map<string, Row[]>();
  for (const r of sample) (bySymbol.get(r.run.symbol) ?? bySymbol.set(r.run.symbol, []).get(r.run.symbol)!).push(r);
  // Feature table aligned with `table`.
  const table: Row[] = [];
  const cols: number[][] = conditions.map(() => []);
  for (const run of runs) {
    if (options.deadline && Date.now() > options.deadline) throw new Error("CT 계산 시간 상한");
    const mine = bySymbol.get(run.symbol) ?? [];
    const values = ctFeatureColumns(conditions, run.rows, mine.map((r) => r.i), contract, run.symbol);
    mine.forEach((r, k) => {
      if (conditions.some((c, f) => !Number.isFinite(values[f][k]) && !c.feature.startsWith("swing_"))) return;
      table.push(r);
      conditions.forEach((_, f) => cols[f].push(values[f][k]));
    });
  }
  const train: number[] = [],
    hold: number[] = [];
  table.forEach((r, t) => {
    if (r.key >= cutKey) hold.push(t);
    else {
      const exit = r.run.rows[r.run.labels.exitIndex[r.i]];
      const hs = holdoutStart.get(r.run.symbol);
      if (hs === undefined || (exit && exit.endMs <= hs)) train.push(t);
    }
  });
  const trainDays = new Set(train.map((t) => table[t].key)).size;
  const minLeaf = Math.max(40, trainDays);
  if (train.length < minLeaf * 4 || hold.length < 20) return null;
  const label = new Int8Array(table.length),
    net = new Float32Array(table.length);
  table.forEach((r, t) => {
    label[t] = r.cls ?? (r.run.labels.label[r.i] === 1 ? 1 : 0);
    net[t] = r.run.labels.grossPct[r.i] - r.run.costPct;
  });
  const arrays = cols.map((c) => Float32Array.from(c));
  const grown = growTree(arrays, Int32Array.from(train), label, net, { depth: 3, minLeaf });
  const baseTrain = train.reduce((s, t) => s + label[t], 0) / train.length,
    baseHold = hold.reduce((s, t) => s + label[t], 0) / hold.length;
  const stat = (rows: number[], path: string) => {
    const mine = rows.filter((t) => leafPath(grown.root, arrays, t) === path);
    const n = mine.length,
      positives = mine.reduce((s, t) => s + label[t], 0),
      nets = mine.map((t) => net[t]);
    // net2x: one more round trip of cost taken off every trade.
    return { n, positiveRatePct: pct(positives, n), net: round(mean(nets)), net2x: round(mean(mine.map((t) => net[t] - table[t].run.costPct))), days: new Set(mine.map((t) => table[t].key)).size };
  };
  const found = leaves(grown.root).map((leaf) => {
    const trained = stat(train, leaf.path),
      held = stat(hold, leaf.path);
    return {
      rule: describeLeaf(grown.root, leaf.path, names),
      train: { ...trained, lift: baseTrain > 0 ? round(trained.positiveRatePct / 100 / baseTrain, 2) : null },
      holdout: { ...held, lift: baseHold > 0 ? round(held.positiveRatePct / 100 / baseHold, 2) : null },
    };
  });
  found.sort((a, b) => b.train.net - a.train.net);
  return {
    sampledMoments: table.length,
    stride,
    trainRows: train.length,
    holdoutRows: hold.length,
    trainDays,
    minLeaf,
    baseRateTrainPct: round(baseTrain * 100, 2),
    baseRateHoldoutPct: round(baseHold * 100, 2),
    exitAssumption: `잎마다 라벨과 같은 청산 구조 하나를 가정한다: 목표 +${params.k}×비용 · 손절 −${params.m}×비용 · ${params.horizon === "day_end" ? "당일 마지막 봉" : `${params.horizon}봉`} 보유. net = 비용 차감 후 평균(%), net2x = 비용을 한 번 더 뺀 값.`,
    split: "앞 2/3 학습 일수로 분할을 찾고(청산이 뒤 1/3 시작 후인 순간은 제외) 뒤 1/3 일수에서 같은 잎을 다시 쟀다. holdout.lift가 train.lift와 같은 방향이 아니면 그 분할은 이 학습 구간 안에서도 불안정하다.",
    leaves: found.slice(0, 8),
    candidateSplits: grown.candidateSplits,
  };
}

/* ----------------------------------------------------------- diagnose_trades */

export const ctDiagnoseTradesSchema = z
  .object({
    screenId: z.string().min(8).max(40).optional(),
    candidateId: z.string().min(1).max(120).optional(),
    exitModes: z.boolean().default(true),
  })
  .strict()
  .refine((v) => Boolean(v.screenId) !== Boolean(v.candidateId), "screenId와 candidateId 중 하나만 지정하세요");
export type CTDiagnoseRequest = z.infer<typeof ctDiagnoseTradesSchema>;

type Stratum = { trades: number; meanNetPct: number; winRatePct: number; sumNetPct: number };
function strata(items: Array<{ key: string; net: number }>, order?: readonly string[]): Array<Stratum & { bucket: string }> {
  const groups = new Map<string, number[]>();
  for (const { key, net } of items) (groups.get(key) ?? groups.set(key, []).get(key)!).push(net);
  const names = order ? [...order] : [...groups.keys()].sort();
  return names.map((bucket) => {
    const xs = groups.get(bucket) ?? [];
    return { bucket, trades: xs.length, meanNetPct: round(mean(xs)), winRatePct: pct(xs.filter((x) => x > 0).length, xs.length), sumNetPct: round(xs.reduce((s, x) => s + x, 0)) };
  });
}
/** The stop distance of a trade as percent of its entry: classic stopPct, managed initial risk. */
function riskPctOf(spec: CTSpec, trade: CTTrade) {
  if (trade.management) return (trade.management.initialRisk / trade.entry) * 100;
  return ctIsManagedExit(spec.exit) ? 1 : spec.exit.stopPct;
}
const indexAt = (rows: CTBar[], ms: number, field: "startMs" | "endMs") => {
  let lo = 0,
    hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][field] === ms) return mid;
    if (rows[mid][field] < ms) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
};

export const CT_DIAGNOSIS_FEATURES = [
  { feature: "range_pct", timeframe: 1 },
  { feature: "sma_distance_pct", timeframe: 60 },
] as const;

/**
 * Takes the TRAINING trades of one replayed rule and answers why it loses: by stratum, by whether
 * the losers ever went in the money (exit problem) or never did (entry problem), and what the same
 * entries earn under other exit structures — each through ctOpenPosition + ctExitStep, the replay's own functions.
 */
export function ctDiagnoseTrades(spec: CTSpec, result: Pick<CTResult, "trades">, data: Record<string, CTBar[]>, contract: CTContract, options: { exitModes: boolean; deadline?: number }) {
  // Free bars: the trades were made on the rule's own bar; re-run their exits on the same bars.
  data = ctDataAt(data, spec.minutes);
  const cost = ctRoundTripCostPct(contract);
  const trades = result.trades;
  const rowsOf = new Map<string, CTBar[]>(),
    hourly = new Map<string, CTHigherSeries>();
  for (const s of contract.symbols) {
    const rows = ctTrainingRows(data, s, contract);
    rowsOf.set(s, rows);
    hourly.set(s, buildHigherSeries(rows, 60, contract.market, s));
  }
  // Volatility terciles of the training population (every 5th bar), the same regimes as the cost hurdle.
  const population: number[] = [];
  for (const rows of rowsOf.values())
    for (let e = 61; e < rows.length; e += 5) {
      const r = priorRange60(rows, e);
      if (r !== null) population.push(r);
    }
  const ps = sorted(population),
    cut = [quantile(ps, 1 / 3), quantile(ps, 2 / 3)];
  const regime = (r: number | null) => (r === null ? "정보 없음" : r <= cut[0] ? "저변동" : r <= cut[1] ? "중변동" : "고변동");
  type Row = { trade: CTTrade; net: number; riskPct: number; mfePct: number; maePct: number; holdMin: number; e: number; x: number; rows: CTBar[] };
  const rowsInfo: Row[] = [];
  for (const trade of trades) {
    const rows = rowsOf.get(trade.symbol);
    if (!rows) continue;
    const e = indexAt(rows, trade.entryAt, "startMs");
    let x = indexAt(rows, trade.exitAt, "endMs");
    if (x < 0) x = indexAt(rows, trade.exitAt, "startMs");
    if (e < 0 || x < e) continue;
    let high = -Infinity,
      low = Infinity;
    for (let k = e; k <= x; k++) {
      if (rows[k].high > high) high = rows[k].high;
      if (rows[k].low < low) low = rows[k].low;
    }
    rowsInfo.push({
      trade,
      net: (trade.pnl / (trade.entry * trade.quantity)) * 100,
      riskPct: riskPctOf(spec, trade),
      mfePct: (high / trade.entry - 1) * 100,
      maePct: (low / trade.entry - 1) * 100,
      holdMin: (trade.exitAt - trade.entryAt) / MINUTE,
      e,
      x,
      rows,
    });
  }
  const n = rowsInfo.length;
  const dims = {
    timeOfDay: [] as Array<{ key: string; net: number }>,
    volatility: [] as Array<{ key: string; net: number }>,
    trend1h: [] as Array<{ key: string; net: number }>,
    weekday: [] as Array<{ key: string; net: number }>,
    holding: [] as Array<{ key: string; net: number }>,
    exitReason: [] as Array<{ key: string; net: number }>,
  };
  for (const r of rowsInfo) {
    const at = r.trade.entryAt;
    dims.timeOfDay.push({ key: ctTimeBucket(at, contract), net: r.net });
    dims.volatility.push({ key: regime(priorRange60(r.rows, r.e)), net: r.net });
    const window = higherWindow(hourly.get(r.trade.symbol)!, at, 19, 0);
    dims.trend1h.push({
      key: !window ? "정보 없음" : window.at(-1)!.close >= mean(window.map((b) => b.close)) ? "1시간 SMA20 위" : "1시간 SMA20 아래",
      net: r.net,
    });
    dims.weekday.push({ key: weekdayOf(at, contract), net: r.net });
    dims.holding.push({ key: r.holdMin <= 15 ? "15분 이하" : r.holdMin <= 60 ? "15–60분" : r.holdMin <= 240 ? "1–4시간" : "4시간 초과", net: r.net });
    dims.exitReason.push({ key: r.trade.reason, net: r.net });
  }
  const timeOrder = contract.market === "crypto" ? ["00-06 UTC", "06-12 UTC", "12-18 UTC", "18-24 UTC"] : ["개장 60분", "장 중반", "마감 60분"];
  const stratified = {
    timeOfDay: strata(dims.timeOfDay, timeOrder),
    volatility: strata(dims.volatility, ["저변동", "중변동", "고변동", "정보 없음"]),
    trend1h: strata(dims.trend1h, ["1시간 SMA20 위", "1시간 SMA20 아래", "정보 없음"]),
    weekday: strata(dims.weekday, WEEKDAYS),
    holding: strata(dims.holding, ["15분 이하", "15–60분", "1–4시간", "4시간 초과"]),
    exitReason: strata(dims.exitReason),
  };
  // Entry problem or exit problem.
  const losers = rowsInfo.filter((r) => r.net < 0),
    winners = rowsInfo.filter((r) => r.net > 0);
  const touched1R = losers.filter((r) => r.mfePct >= r.riskPct).length,
    touched2Cost = losers.filter((r) => r.mfePct >= 2 * cost).length,
    neverProfit = losers.filter((r) => r.mfePct < cost).length;
  const captures = winners.filter((r) => r.mfePct > 0).map((r) => Math.min(1.5, ((r.trade.exit / r.trade.entry - 1) * 100) / r.mfePct));
  const lossTouched = pct(touched1R, losers.length),
    lossNever = pct(neverProfit, losers.length);
  const verdict = !losers.length
    ? "손실 거래 없음"
    : lossTouched >= 40 && lossTouched >= lossNever
      ? `청산 문제 의심: 손실 거래의 ${lossTouched}%가 한 번 +1R에 닿았다가 손실로 끝났다`
      : lossNever >= 60
        ? `진입 문제 의심: 손실 거래의 ${lossNever}%가 한 번도 왕복 비용(${round(cost, 3)}%)만큼도 오르지 못했다`
        : "진입·청산이 섞여 있다(한쪽이 지배적이지 않음)";
  const entryExit = {
    trades: n,
    losers: losers.length,
    winners: winners.length,
    losersTouched1RPct: lossTouched,
    losersTouched2xCostPct: pct(touched2Cost, losers.length),
    losersNeverProfitablePct: lossNever,
    winnersCaptureOfMfePct: round(mean(captures) * 100, 1),
    medianLoserMfePct: round(quantile(sorted(losers.map((r) => r.mfePct)), 0.5)),
    medianWinnerMfePct: round(quantile(sorted(winners.map((r) => r.mfePct)), 0.5)),
    verdict,
    definitions: `+1R = 거래의 초기 손절 거리만큼 유리한 이동 · 수익권 = 진입가 대비 왕복 비용 ${round(cost, 3)}% 이상 · 놓친 수익 = 이익 거래의 실현 이동 ÷ 보유 중 최대 유리 이동(MFE)`,
  };
  // The same entries under other exits (ctOpenPosition + ctExitStep, training bars only).
  let counterfactual: Array<Record<string, unknown>> | null = null;
  if (options.exitModes && n) {
    const maxHold = spec.exit.maxHoldBars;
    const modes: Array<{ id: string; label: string; exit: (riskPct: number) => CTManagedExit | null }> = [
      { id: "parent", label: "원래 청산(후보의 규칙 그대로)", exit: () => null },
      { id: "fixed_2R", label: "고정 손절 · 목표 2R", exit: (r) => ({ stop: { type: "pct", value: r }, target: { type: "r", value: 2 }, maxHoldBars: maxHold }) },
      { id: "breakeven_1R", label: "고정 손절 · 목표 2R · +1R에서 본전", exit: (r) => ({ stop: { type: "pct", value: r }, target: { type: "r", value: 2 }, breakeven: { triggerR: 1 }, maxHoldBars: maxHold }) },
      { id: "trail_1R", label: "목표 없음 · +1R부터 손절 거리만큼 트레일", exit: (r) => ({ stop: { type: "pct", value: r }, trail: { type: "pct", value: Math.max(0.1, r), activateR: 1 }, maxHoldBars: maxHold }) },
      { id: "time_stop", label: "고정 손절 · 목표 2R · 보유의 1/3(최소 5봉) 안에 0R 미만이면 정리", exit: (r) => ({ stop: { type: "pct", value: r }, target: { type: "r", value: 2 }, timeStop: { bars: Math.max(5, Math.min(maxHold - 1, Math.round(maxHold / 3))), minR: 0 }, maxHoldBars: maxHold }) },
    ];
    counterfactual = modes.map((mode) => {
      const nets: number[] = [],
        nets2: number[] = [],
        reasons: Record<string, number> = {};
      let skipped = 0;
      for (const r of rowsInfo) {
        if (options.deadline && Date.now() > options.deadline) throw new Error("CT 계산 시간 상한");
        const risk = Math.max(0.2, Math.min(15, r.riskPct));
        const exit = mode.exit(risk);
        const alt = exit ? ({ ...spec, exit } as CTSpec) : spec;
        const rows = r.rows,
          fill = rows[r.e].open * (1 + ctImpactPct(contract) / 100);
        let position = ctOpenPosition(alt, r.trade.signal, fill, rows[r.e].startMs);
        if (!position) {
          skipped++;
          continue;
        }
        let done = false;
        for (let k = r.e; k < rows.length; k++) {
          const step = ctExitStep(alt, r.trade.signal, position, rows[k], ctForcedExit(alt, contract.market, rows[k]));
          position = step.position;
          if (step.exit) {
            nets.push(ctNetTradePct(contract, rows[r.e].open, step.exit.price));
            nets2.push(ctNetTradePct(contract, rows[r.e].open, step.exit.price, 2));
            reasons[step.exit.reason] = (reasons[step.exit.reason] ?? 0) + 1;
            done = true;
            break;
          }
        }
        if (!done) skipped++;
      }
      return {
        mode: mode.id,
        label: mode.label,
        trades: nets.length,
        skipped,
        winRatePct: pct(nets.filter((x) => x > 0).length, nets.length),
        meanNetPct: round(mean(nets)),
        meanNet2xCostPct: round(mean(nets2)),
        totalNetPct: round(nets.reduce((s, x) => s + x, 0)),
        exits: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, pct(v, nets.length)])),
      };
    });
  }
  // Filter hints: strata with enough trades whose mean is clearly below the rest.
  const overall = mean(rowsInfo.map((r) => r.net));
  const suggestions: Array<{ dimension: string; bucket: string; trades: number; meanNetPct: number; restMeanNetPct: number; restTrades: number }> = [];
  for (const [dimension, rows] of Object.entries(stratified))
    for (const s of rows) {
      if (s.trades < 10 || s.bucket === "정보 없음" || s.meanNetPct >= overall - 0.05) continue;
      const rest = rowsInfo.length - s.trades;
      if (rest < 10) continue;
      const restSum = rowsInfo.reduce((a, r) => a + r.net, 0) - s.sumNetPct;
      suggestions.push({ dimension, bucket: s.bucket, trades: s.trades, meanNetPct: s.meanNetPct, restMeanNetPct: round(restSum / rest), restTrades: rest });
    }
  suggestions.sort((a, b) => a.meanNetPct - b.meanNetPct);
  return {
    trades: n,
    meanNetPct: round(overall),
    roundTripCostPct: round(cost),
    volatilityCutoffsPct: { prior60BarRangeP33: round(cut[0]), prior60BarRangeP67: round(cut[1]) },
    strata: stratified,
    entryVsExit: entryExit,
    exitCounterfactual: counterfactual,
    filterHints: suggestions.slice(0, 4),
    cells: Object.values(stratified).reduce((s, rows) => s + rows.filter((x) => x.trades > 0).length, 0),
    note: "학습 구간 거래만. 필터 힌트는 진단일 뿐 검증이 아니다: 필터를 넣은 후보는 부모 대비 변경으로 기록하고 query_conditional_returns·screen_rule로 다시 확인한다. 확인한 칸 수는 다중 검정 장부에 합산된다.",
  };
}
export type CTDiagnosis = ReturnType<typeof ctDiagnoseTrades>;
/** Ledger signatures of a diagnosis: one per examined stratum, keyed by the rule's feature combination. */
export function ctDiagnosisSignatures(spec: CTSpec, diagnosis: Pick<CTDiagnosis, "strata">) {
  const rule = ctTestSignature(spec.stages, !!spec.entry.entryWindows?.length, spec.minutes);
  return Object.entries(diagnosis.strata).flatMap(([dimension, rows]) => rows.filter((r) => r.trades > 0).map((r) => `diagnose|${rule}|${dimension}|${r.bucket}`));
}
/** Ledger signatures of a contrast run: one per feature × control quintile (and the tree's feature set). */
export function ctContrastSignatures(request: CTContrastRequest, params: CTLabelParams, conditions: CTCondition[]) {
  const label = `k${params.k}m${params.m}h${params.horizon}c${params.costMultiplier}${params.barMinutes && params.barMinutes > 1 ? `b${params.barMinutes}` : ""}`;
  // Stage 4: the same feature and quintile against a different control group is a different hypothesis. "time" is the
  // stage-3 control, so it keeps the stage-3 signature (and stays comparable with earlier runs' ledgers).
  const mode = request.controls && request.controls !== "time" ? `|${request.controls}` : "";
  return conditions.flatMap((c) => BIN_LABELS.map((_, b) => `contrast|${c.feature}|${c.timeframe}|${c.unit ?? "pct"}|q${b}|${label}${mode}`));
}

/* ------------------------------------------------------------------ view_charts */

/** Stage 3 request (frozen for traderTools = 1 contracts): up to 8 anchors whether blind or not. */
export const ctViewChartsSchemaStage3 = z
  .object({
    // Times the server issued (event and control times from label_moves, query anchors, screen_rule trade times).
    anchors: z.array(z.number().int().nonnegative()).min(1).max(8),
    // Mix events and controls in random order and hide the group: grade it afterwards with grade_blind.
    blind: z.boolean().default(false),
  })
  .strict();
/** Blind-set size of a stage-4 contract (policy.blindSize): a blind set is 16–32 charts, half events and half controls. */
export const CT_BLIND_MIN = 16,
  CT_BLIND_MAX = 32,
  CT_BLIND_DEFAULT = 24;
/**
 * Stage 4: an ordinary view is up to 8 charts, a blind set 16–32 (equal numbers of event and control times, checked by the
 * server). The size limit sits in the refinement (not in the JSON schema), so the tool definition stays one shape.
 */
export const ctViewChartsSchema = z
  .object({
    anchors: z.array(z.number().int().nonnegative()).min(1).max(CT_BLIND_MAX),
    blind: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.blind && v.anchors.length > 8) ctx.addIssue({ code: "custom", path: ["anchors"], message: "일반 보기는 호출당 8장 이하입니다(블라인드 세트만 16–32장)" });
    if (v.blind && (v.anchors.length < CT_BLIND_MIN || v.anchors.length % 2 !== 0))
      ctx.addIssue({ code: "custom", path: ["anchors"], message: `블라인드 세트는 이벤트와 대조군을 같은 수로 ${CT_BLIND_MIN}–${CT_BLIND_MAX}장(짝수)이어야 합니다(기본 ${CT_BLIND_DEFAULT}장)` });
  });
export type CTViewChartsRequest = z.infer<typeof ctViewChartsSchema>;

/* ----------------------------------------------------------------- blind grading */

/** Stage 3 request (frozen): up to 64 predictions. */
export const ctGradeBlindSchemaStage3 = z
  .object({
    blindId: z.string().min(4).max(40),
    predictions: z.array(z.object({ chart: z.number().int().min(1).max(64), call: z.enum(["positive", "control"]) }).strict()).min(4).max(64),
  })
  .strict();
/** Stage 4: one prediction per chart of a 16–32-chart set. */
export const ctGradeBlindSchema = z
  .object({
    blindId: z.string().min(4).max(40),
    predictions: z.array(z.object({ chart: z.number().int().min(1).max(CT_BLIND_MAX), call: z.enum(["positive", "control"]) }).strict()).min(CT_BLIND_MIN).max(CT_BLIND_MAX),
  })
  .strict();
export type CTBlindSet = { blindId: string; session: number; order: Array<{ chart: number; group: "positive" | "control" }>; graded?: { correct: number; total: number; accuracyPct: number; pValue: number; verdict?: "skill" | "no_skill" | "inconclusive" } };

/** Smallest hit count k with P(X ≥ k | n, 0.5) < 0.05: what a set of n charts needs to show skill. */
export function ctBlindNeededHits(n: number, alpha = 0.05) {
  for (let k = 0; k <= n; k++) if (ctBinomialUpperP(n, k, 0.5) < alpha) return k;
  return n + 1;
}
/** Power of the one-sided 5% test of a set of n charts if the eye is really right with probability `accuracy`. */
export function ctBlindPower(n: number, accuracy: number) {
  const k = ctBlindNeededHits(n);
  return k > n ? 0 : ctBinomialUpperP(n, k, accuracy);
}
/** Power the verdict needs before "no skill" may be said at all, and the accuracy it is judged against. */
export const CT_CALIBRATION_POWER_TARGET = 0.8,
  CT_CALIBRATION_REFERENCE_ACCURACY = 0.7;
export type CTCalibrationVerdict = "skill" | "no_skill" | "inconclusive";
/**
 * skill        p < 0.05
 * no_skill     p ≥ 0.05 AND the set was large enough to catch a real 70% eye with power ≥ 0.8
 * inconclusive anything else (a small set with a high p says nothing: it is absence of evidence)
 */
export function ctCalibrationVerdict(n: number, k: number): CTCalibrationVerdict {
  const p = ctBinomialUpperP(n, k, 0.5);
  if (p < 0.05) return "skill";
  return ctBlindPower(n, CT_CALIBRATION_REFERENCE_ACCURACY) >= CT_CALIBRATION_POWER_TARGET ? "no_skill" : "inconclusive";
}
export const CT_VERDICT_TEXT: Record<CTCalibrationVerdict, string> = {
  skill: "눈에 신호가 있다(p < 0.05)",
  no_skill: "눈에 신호가 없다(표본이 충분했다)",
  inconclusive: "표본이 작아 판정 불가(증거 없음 ≠ 판별력 없음)",
};
/** The calibration facts of a set of n charts with k hits (stage 4 grade_blind result and the calibration record). */
export function ctCalibrationFacts(n: number, k: number) {
  const needed = ctBlindNeededHits(n);
  const verdict = ctCalibrationVerdict(n, k);
  return {
    verdict,
    verdictText: CT_VERDICT_TEXT[verdict],
    neededHitsForSignificance: needed,
    powerIfEyeIs70Pct: round(ctBlindPower(n, 0.7), 2),
    powerIfEyeIs75Pct: round(ctBlindPower(n, 0.75), 2),
  };
}

const legacyReading = (pValue: number) =>
  pValue < 0.05
    ? `우연보다 잘 맞혔다(p=${pValue.toPrecision(2)}): 이 시장·이 차트 구성에서 눈에 신호가 있을 가능성이 있다. 그래도 한 세트의 결과이고 이 검정도 장부에 합산된다.`
    : `우연과 구분되지 않는다(p=${pValue.toPrecision(2)}): 이 구성에서는 눈으로 양성과 대조군을 가르지 못했다. 차트로 본 패턴은 가설일 뿐, 숫자 조회로 확인되기 전에는 근거가 아니다.`;
function calibrationReading(n: number, k: number, pValue: number) {
  const f = ctCalibrationFacts(n, k);
  const head = `${n}장 중 ${k}장 적중(p=${pValue.toPrecision(2)}) · 이 크기의 세트가 5%에서 유의하려면 ${f.neededHitsForSignificance}장 이상 맞혀야 하고, 눈의 실제 정확도가 70%/75%일 때 그것을 잡아낼 확률은 ${Math.round(f.powerIfEyeIs70Pct * 100)}%/${Math.round(f.powerIfEyeIs75Pct * 100)}%다. 판정: ${f.verdictText}.`;
  if (f.verdict === "skill") return `${head} 한 세트의 결과이고 이 검정도 장부에 합산된다. 숫자 조회로 확인되기 전에는 차트에서 본 패턴이 근거가 아니다.`;
  if (f.verdict === "no_skill") return `${head} 이 구성에서는 눈으로 양성과 대조군을 가르지 못했다. 차트의 패턴은 가설일 뿐이다.`;
  return `${head} 이 결과는 \u201C판별력 없음\u201D이 아니라 \u201C이 표본으로는 알 수 없음\u201D이다. 이 측정은 거래 메커니즘의 기각 가설이 아니라 도구 보정 기록이다(rejectedHypotheses에 넣지 않는다).`;
}

/** Exact one-sided binomial test against 50%: the set is balanced, so a coin flip is the null. */
export function ctGradeBlind(set: CTBlindSet, predictions: Array<{ chart: number; call: "positive" | "control" }>, options: { calibration?: boolean } = {}) {
  const truth = new Map(set.order.map((o) => [o.chart, o.group]));
  const seen = new Set<number>();
  for (const p of predictions) {
    if (!truth.has(p.chart)) throw new Error(`이 세트에 없는 차트 번호: ${p.chart}`);
    if (seen.has(p.chart)) throw new Error(`차트 ${p.chart}의 예측이 중복되었습니다`);
    seen.add(p.chart);
  }
  if (seen.size !== set.order.length) throw new Error(`모든 차트(${set.order.length}장)에 예측을 제출해야 합니다`);
  const correct = predictions.filter((p) => truth.get(p.chart) === p.call).length;
  const total = predictions.length;
  const pValue = ctBinomialUpperP(total, correct, 0.5);
  return {
    correct,
    total,
    accuracyPct: pct(correct, total),
    pValue: Number(pValue.toPrecision(3)),
    ...(options.calibration ? ctCalibrationFacts(total, correct) : {}),
    answers: set.order.map((o) => ({ chart: o.chart, group: o.group })),
    reading: options.calibration ? calibrationReading(total, correct, pValue) : legacyReading(pValue),
  };
}
