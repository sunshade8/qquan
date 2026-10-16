/**
 * Training-only measurement tools for the CT designer's research session.
 *
 * Every number comes from the same code the replay and the live runner use: detectCT finds
 * events, ctExit decides stop/target/time exits, ctNetTradePct applies the replay's fill and
 * fee formulas. Nothing here reads past contract.trainingToMs: a query's look-ahead window
 * must also end by then, so events near the boundary are dropped, never truncated.
 */
import { z } from "zod";
import {
  ctDate,
  ctDayEndMs,
  ctEntryBlocked,
  ctExit,
  ctExitStep,
  ctForcedExit,
  ctHigherSets,
  ctHistoryBars,
  ctLevelSets,
  ctNeedsHigher,
  ctImpactPct,
  ctNetTradePct,
  ctOpenPosition,
  ctRoundTripCostPct,
  ctDataAt,
  detectCT,
  validCTBar,
  type CTBar,
  type CTFeatureCache,
  type CTSignal,
} from "./ct-engine.ts";
import { ctStockSession } from "./ct-sessions.ts";
import { dayInfo, dayLastIndex } from "./ct-moves.ts";
import {
  CT_ENGINE_V1,
  ctBarMinutesSchema,
  ctConditionSchema,
  validateCTSpec,
  type CTContract,
  type CTManagedExit,
  type CTSpec,
} from "./ct-spec.ts";

/** Look-ahead horizons (bars) the cost hurdle reports for ct-pattern-1 contracts. */
export const CT_HURDLE_HORIZONS = [5, 15, 60, 240, 390] as const;
/**
 * ct-pattern-2 contracts trade one day at a time, so every horizon is cut at the day's last
 * tradable bar, crypto adds 12 h and 24 h, and 0 stands for "until the day ends" (variable length).
 */
export function ctHurdleHorizons(contract: Pick<CTContract, "engine" | "market">): readonly number[] {
  if (contract.engine === CT_ENGINE_V1) return CT_HURDLE_HORIZONS;
  return contract.market === "crypto" ? [...CT_HURDLE_HORIZONS, 720, 1440, 0] : [...CT_HURDLE_HORIZONS, 0];
}
/** The hurdle samples every Nth training bar as a hypothetical entry; cheap and representative. */
const HURDLE_STRIDE = 5;

/* ------------------------------------------------------------------ shared */

const round = (n: number, digits = 4) => (Number.isFinite(n) ? Number(n.toFixed(digits)) : 0);
function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * q,
    lo = Math.floor(at),
    hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}
const sortNum = (xs: number[]) => [...xs].sort((a, b) => a - b);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0);
function quantiles(xs: number[], qs: readonly number[]) {
  const sorted = sortNum(xs);
  return Object.fromEntries(qs.map((q) => [`p${Math.round(q * 100)}`, round(quantile(sorted, q))]));
}
const share = (n: number, total: number) => round(total ? (n / total) * 100 : 0, 2);

/** Training bars of one symbol plus, for each index, the last index of its contiguous run. */
function trainingRows(data: Record<string, CTBar[]>, symbol: string, contract: CTContract) {
  const rows = (data[symbol] ?? []).filter((b) => b.startMs >= contract.fromMs && b.endMs <= contract.trainingToMs);
  const runEnd = new Array<number>(rows.length);
  for (let i = rows.length - 1; i >= 0; i--)
    runEnd[i] = i + 1 < rows.length && rows[i + 1].startMs === rows[i].endMs && validCTBar(rows[i + 1]) ? runEnd[i + 1] : i;
  return { rows, runEnd };
}

/** Forward window from entry bar e over h bars: gross return to close, MFE and MAE (percent of the open). */
function forward(rows: CTBar[], runEnd: number[], e: number, h: number, dayLast?: number) {
  // ct-pattern-2: the window ends at the day's last tradable bar at the latest (h = 0: exactly there).
  let last = e + h - 1;
  if (dayLast !== undefined) {
    if (dayLast < e) return null;
    last = h === 0 ? dayLast : Math.min(last, dayLast);
  }
  if (last >= rows.length || runEnd[e] < last) return null;
  const open = rows[e].open;
  let high = -Infinity,
    low = Infinity;
  for (let k = e; k <= last; k++) {
    if (rows[k].high > high) high = rows[k].high;
    if (rows[k].low < low) low = rows[k].low;
  }
  return {
    open,
    close: rows[last].close,
    ret: (rows[last].close / open - 1) * 100,
    mfe: (high / open - 1) * 100,
    mae: (low / open - 1) * 100,
  };
}

const utcHour = (ms: number) => new Date(ms).getUTCHours();
const nyClock = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
/** Time-of-day bucket of an entry: crypto by UTC quarter of the day, stocks by session third. */
export function ctTimeBucket(ms: number, contract: Pick<CTContract, "market">) {
  if (contract.market === "crypto") {
    const h = utcHour(ms);
    return h < 6 ? "00-06 UTC" : h < 12 ? "06-12 UTC" : h < 18 ? "12-18 UTC" : "18-24 UTC";
  }
  const session = ctStockSession(ctDate(ms, "stock"));
  const now = minutesOf(nyClock.format(new Date(ms)));
  if (!session) return "세션 외";
  if (now < minutesOf(session.open) + 60) return "개장 60분";
  if (now >= minutesOf(session.close) - 60) return "마감 60분";
  return "장 중반";
}
const TIME_BUCKETS = {
  crypto: ["00-06 UTC", "06-12 UTC", "12-18 UTC", "18-24 UTC"],
  stock: ["개장 60분", "장 중반", "마감 60분"],
} as const;

/** Range of the 60 bars before the entry bar (percent), or null without a contiguous history. */
function priorRangePct(rows: CTBar[], runEnd: number[], e: number) {
  const start = e - 60;
  if (start < 0 || runEnd[start] < e - 1) return null;
  let high = -Infinity,
    low = Infinity;
  for (let k = start; k < e; k++) {
    if (rows[k].high > high) high = rows[k].high;
    if (rows[k].low < low) low = rows[k].low;
  }
  return (high / low - 1) * 100;
}

/* ------------------------------------------------------------- cost hurdle */

type HurdleRow = { n: number; mfe: number[]; mae: number[]; ret: number[] };
const emptyRow = (): HurdleRow => ({ n: 0, mfe: [], mae: [], ret: [] });

/**
 * How often the training market moves far enough to pay for a round trip, by holding
 * time, time of day and recent volatility. Entries are every 5th training bar at its
 * open, the way the replay enters (next bar open). Gross moves; costs stated beside them.
 */
export function ctCostHurdle(data: Record<string, CTBar[]>, contract: CTContract) {
  const cost = ctRoundTripCostPct(contract),
    cost2 = ctRoundTripCostPct(contract, 2);
  const ranges: number[] = [];
  const H = ctHurdleHorizons(contract);
  const dayBounded = contract.engine !== CT_ENGINE_V1;
  const overall = H.map(() => emptyRow());
  const byTime = new Map<string, HurdleRow[]>();
  const vol: Array<{ range: number; per: Array<ReturnType<typeof forward>> }> = [];
  for (const symbol of contract.symbols) {
    const { rows, runEnd } = trainingRows(data, symbol, contract);
    const dayLast = dayBounded ? dayLastIndex(rows, dayInfo(rows, contract.market)) : null;
    for (const b of rows) ranges.push((b.high / b.low - 1) * 100);
    for (let e = 61; e < rows.length; e += HURDLE_STRIDE) {
      const per = H.map((h) => forward(rows, runEnd, e, h, dayLast ? dayLast[e] : undefined));
      if (!per[0]) continue;
      const bucket = ctTimeBucket(rows[e].startMs, contract);
      if (!byTime.has(bucket)) byTime.set(bucket, H.map(() => emptyRow()));
      per.forEach((f, i) => {
        if (!f) return;
        for (const row of [overall[i], byTime.get(bucket)![i]]) {
          row.n++;
          row.mfe.push(f.mfe);
          row.mae.push(f.mae);
          row.ret.push(f.ret);
        }
      });
      const range = priorRangePct(rows, runEnd, e);
      if (range !== null) vol.push({ range, per });
    }
  }
  const sortedRanges = sortNum(vol.map((v) => v.range));
  const cut = [quantile(sortedRanges, 1 / 3), quantile(sortedRanges, 2 / 3)];
  const regimes = ["저변동", "중변동", "고변동"].map(() => H.map(() => emptyRow()));
  for (const v of vol) {
    const r = v.range <= cut[0] ? 0 : v.range <= cut[1] ? 1 : 2;
    v.per.forEach((f, i) => {
      if (!f) return;
      const row = regimes[r][i];
      row.n++;
      row.mfe.push(f.mfe);
      row.mae.push(f.mae);
      row.ret.push(f.ret);
    });
  }
  const hits = (row: HurdleRow, k: number) => share(row.mfe.filter((m) => m >= cost * k).length, row.n);
  const brief = (row: HurdleRow) => ({
    n: row.n,
    mfeP50: round(quantile(sortNum(row.mfe), 0.5)),
    maeP50: round(quantile(sortNum(row.mae), 0.5)),
    hit1xPct: hits(row, 1),
    hit2xPct: hits(row, 2),
  });
  const horizons = H.map((bars, i) => ({
    bars,
    ...(bars === 0 ? { label: "당일 경계까지(가변)" } : {}),
    n: overall[i].n,
    mfePct: quantiles(overall[i].mfe, [0.1, 0.25, 0.5, 0.75, 0.9]),
    maePct: quantiles(overall[i].mae, [0.1, 0.25, 0.5, 0.75, 0.9]),
    retMeanPct: round(mean(overall[i].ret)),
    hit1xPct: hits(overall[i], 1),
    hit2xPct: hits(overall[i], 2),
    hit3xPct: hits(overall[i], 3),
  }));
  const meanRange = mean(ranges),
    at60 = horizons.find((h) => h.bars === 60)!;
  return {
    roundTripCostPct: round(cost),
    roundTripCost2xPct: round(cost2),
    meanBarRangePct: round(meanRange),
    medianBarRangePct: round(quantile(sortNum(ranges), 0.5)),
    costToMeanBarRange: round(cost / Math.max(meanRange, 1e-9), 2),
    sampledEntries: overall[0].n,
    entryRule: `학습 구간 ${HURDLE_STRIDE}봉마다 다음 봉 시가 진입 가정 · MFE/MAE는 시가 대비 총 이동(비용 전)` + (dayBounded ? " · 보유는 당일 경계(코인 UTC 00:00, 주식 정규장 종료)에서 잘라 계산(bars 0 = 당일 경계까지)" : ""),
    horizons,
    byTime: (TIME_BUCKETS[contract.market] as readonly string[]).flatMap((bucket) =>
      H.map((bars, i) => ({ bucket, bars, ...brief(byTime.get(bucket)?.[i] ?? emptyRow()) })),
    ),
    byVolatility: ["저변동", "중변동", "고변동"].flatMap((regime, r) =>
      H.map((bars, i) => ({ regime, bars, ...brief(regimes[r][i]) })),
    ),
    volatilityCutoffsPct: { prior60BarRangeP33: round(cut[0]), prior60BarRangeP67: round(cut[1]) },
    conclusion:
      `평균 1분 범위 ${round(meanRange, 3)}%, 왕복 비용 ${round(cost, 3)}%(평균 봉의 ${round(cost / Math.max(meanRange, 1e-9), 1)}배) → ` +
      `비용의 2배를 넘는 유리한 움직임(MFE)은 60분 보유 기준 진입의 ${at60.hit2xPct}%에서만 나타남`,
  };
}
export type CTCostHurdle = ReturnType<typeof ctCostHurdle>;

/* --------------------------------------------------- conditional returns */

// Up to a full UTC day for crypto; stock horizons above 390 are refused when the probe spec is validated.
const horizon = z.number().int().min(1).max(1440);
/**
 * Exit-structure comparison grid. For every stop distance and R-multiple target it runs the fixed
 * exit; with breakevenTriggerR / timeStop set it also runs that variant of every fixed row; with
 * trail set it runs a no-target trailing exit per stop. At most 3 stops × (2 targets × 3 modes) + 3 trails = 21 rows.
 */
export const ctExitCompareSchema = z
  .object({
    stopPcts: z.array(z.number().min(0.2).max(15)).min(1).max(3),
    targetRs: z.array(z.number().min(0.5).max(10)).min(1).max(2),
    breakevenTriggerR: z.number().min(0.25).max(10).nullable(),
    trail: z.object({ pct: z.number().min(0.1).max(10), activateR: z.number().min(0).max(10) }).strict().nullable(),
    timeStop: z.object({ bars: z.number().int().min(2).max(1440), minR: z.number().min(-1).max(5) }).strict().nullable(),
  })
  .strict();
export type CTExitCompare = z.infer<typeof ctExitCompareSchema>;
/** What the designer sends. Stages use the rule DSL's own condition schema. */
export const ctQuerySchema = z
  .object({
    stages: z
      .array(
        z
          .object({
            maxGapBars: z.number().int().min(1).max(48),
            conditions: z.array(ctConditionSchema).min(1).max(6),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    horizons: z.array(horizon).min(1).max(5),
    grid: z
      .object({
        stopPcts: z.array(z.number().min(0.2).max(15)).min(1).max(4),
        targetPcts: z.array(z.number().min(0.2).max(40)).min(1).max(4),
      })
      .strict()
      .nullable(),
    cooldownBars: z.number().int().min(1).max(390),
    // ct-pattern-3: only events whose signal bar closes inside a window (minutes since the day start, both ends included).
    entryWindows: z
      .array(
        z
          .object({ fromMinute: z.number().int().min(0).max(1439), toMinute: z.number().int().min(0).max(1439) })
          .strict()
          .refine((w) => w.fromMinute <= w.toMinute, "fromMinute ≤ toMinute"),
      )
      .max(3)
      .optional(),
    // ct-pattern-3: the same events under different exit structures, side by side (training only, size-capped).
    exitCompare: ctExitCompareSchema.nullable().optional(),
  })
  .strict();
/** Free bars (traderTools 4): the same query plus the bar it runs on. */
export const ctQuerySchemaBars = ctQuerySchema.extend({ barMinutes: ctBarMinutesSchema });
export type CTQuery = z.infer<typeof ctQuerySchema> & { barMinutes?: 1 | 5 | 15 | 60 };
/**
 * A query on its own bar: the data rebuilt at that bar and a contract view whose `minutes` is that bar, so the probe
 * spec, every bar count and every horizon are in those bars. The server checks the bar is allowed (ctBarAllowed) first.
 */
function atBar<T extends { barMinutes?: number }>(request: T, data: Record<string, CTBar[]>, contract: CTContract): [Record<string, CTBar[]>, CTContract] {
  const bar = request.barMinutes ?? contract.minutes;
  return bar === contract.minutes ? [data, contract] : [ctDataAt(data, bar), { ...contract, minutes: bar as CTContract["minutes"] }];
}

/** The probe spec a query runs through detectCT and ctExit. Never registered or traded. */
export function ctQuerySpec(
  query: CTQuery,
  contract: CTContract,
  exit: { stopPct: number; targetPct: number } | CTManagedExit = { stopPct: 15, targetPct: 40 },
): CTSpec {
  return validateCTSpec(
    {
      version: 1,
      engine: contract.engine,
      name: "conditional return probe",
      market: contract.market,
      symbols: contract.symbols,
      minutes: contract.minutes,
      stages: query.stages.map((s, i) => ({ label: `stage ${i + 1}`, ...s })),
      entry: {
        order: "marketable_limit",
        validBars: 1,
        maxSpreadPct: 1,
        maxDeviationPct: 2,
        ...(query.entryWindows?.length ? { entryWindows: query.entryWindows } : {}),
      },
      exit: "stop" in exit ? exit : { ...exit, maxHoldBars: Math.max(...query.horizons), invalidation: "stop" },
      sizing: { riskPct: 1, allocationPct: 25, maxPositions: 1, cooldownBars: query.cooldownBars, participationPct: 1 },
      sourceIds: ["query"],
      assumptions: ["Conditional return probe; not a strategy."],
    },
    contract,
    ["query"],
  );
}

type CTEvent = { symbol: string; at: number; entryStart: number; e: number; signal: CTSignal };
/**
 * Every bar whose close completes the pattern, exactly as replayCT asks detectCT (same
 * purged history window, same feature cache), minus the position/cash gates a replay adds.
 */
export function ctQueryEvents(
  query: CTQuery,
  data: Record<string, CTBar[]>,
  contract: CTContract,
  options: { deadline?: number } = {},
) {
  [data, contract] = atBar(query, data, contract);
  const spec = ctQuerySpec(query, contract),
    history = ctHistoryBars(spec),
    maxH = Math.max(...query.horizons);
  const events: CTEvent[] = [];
  const dayBounded = spec.engine !== CT_ENGINE_V1;
  let truncated = 0,
    gaps = 0;
  for (const symbol of contract.symbols) {
    const rows = data[symbol] ?? [];
    const first = rows.findIndex((b) => b.startMs >= contract.fromMs);
    if (first < 0) continue;
    const cache: CTFeatureCache = new Map();
    // Completed 60/240/1440-minute bars of the training range only (same as the replay builds).
    const trainingRows = rows.filter((b) => b.startMs >= contract.fromMs && b.endMs <= contract.trainingToMs);
    const higher = ctNeedsHigher(spec) ? ctHigherSets(spec, trainingRows, symbol) : undefined;
    const levels = ctLevelSets(spec, trainingRows);
    let last = -Infinity;
    for (let i = first; i < rows.length && rows[i].endMs <= contract.trainingToMs; i++) {
      if (options.deadline && (i & 1023) === 0 && Date.now() > options.deadline) throw new Error("CT 계산 시간 상한");
      if (i - last < query.cooldownBars) continue;
      // ct-pattern-2: the replay never enters on the day's last bar or inside noEntryBeforeDayEndMinutes.
      if (dayBounded && ctEntryBlocked(spec, contract.market, rows[i].endMs)) continue;
      const signal = detectCT(spec, symbol, rows.slice(Math.max(0, i - history, first), i + 1), rows[i].endMs, cache, higher, levels);
      if (!signal) continue;
      last = i;
      const e = i + 1;
      // Look-ahead must also end inside training: drop the event rather than shorten it.
      // A day-bounded trade ends no later than its day, so only that part has to fit.
      const dayEnd = dayBounded ? ctDayEndMs(contract.market, rows[i].endMs) : null;
      const end = Math.min(rows[i].endMs + maxH * contract.minutes * 60_000, dayEnd ?? Infinity);
      if (end > contract.trainingToMs) {
        truncated++;
        continue;
      }
      if (e >= rows.length || rows[e].startMs !== rows[i].endMs) {
        gaps++;
        continue;
      }
      events.push({ symbol, at: rows[i].endMs, entryStart: rows[e].startMs, e, signal });
    }
  }
  return { spec, events, truncated, gaps };
}

/**
 * Forward returns, MFE/MAE and a stop/target grid for the events of a condition sequence,
 * with the unconditional baseline of the same time-of-day mix and month-by-month stability.
 */
export function ctQueryReturns(
  query: CTQuery,
  data: Record<string, CTBar[]>,
  contract: CTContract,
  options: { deadline?: number } = {},
) {
  [data, contract] = atBar(query, data, contract);
  const { events, truncated, gaps } = ctQueryEvents(query, data, contract, options);
  const dayBounded = contract.engine !== CT_ENGINE_V1;
  // ct-pattern-2: every look-ahead stops at the day's last tradable bar, like the replay's forced exit.
  const dayLasts = dayBounded
    ? Object.fromEntries(contract.symbols.map((s) => [s, dayLastIndex(data[s] ?? [], dayInfo(data[s] ?? [], contract.market))]))
    : null;
  const runs = Object.fromEntries(contract.symbols.map((s) => {
    const rows = data[s] ?? [];
    const runEnd = new Array<number>(rows.length);
    for (let i = rows.length - 1; i >= 0; i--)
      runEnd[i] = i + 1 < rows.length && rows[i + 1].startMs === rows[i].endMs && validCTBar(rows[i + 1]) ? runEnd[i + 1] : i;
    return [s, runEnd];
  }));
  const usable = events
    .map((ev) => ({ ev, per: query.horizons.map((h) => forward(data[ev.symbol], runs[ev.symbol], ev.e, h, dayLasts?.[ev.symbol][ev.e])) }))
    .filter((x) => x.per.every(Boolean)) as Array<{ ev: CTEvent; per: Array<NonNullable<ReturnType<typeof forward>>> }>;
  const n = usable.length;
  const net = (f: { open: number; close: number }, multiplier = 1) => ctNetTradePct(contract, f.open, f.close, multiplier);
  const cost = ctRoundTripCostPct(contract);

  // Unconditional baseline per time bucket, every training entry (no stride: O(1) per bar).
  const base = new Map<string, Array<{ n: number; sum: number }>>();
  for (const symbol of contract.symbols) {
    const { rows, runEnd } = trainingRows(data, symbol, contract);
    const dl = dayBounded ? dayLastIndex(rows, dayInfo(rows, contract.market)) : null;
    for (let e = 1; e < rows.length; e++) {
      const bucket = ctTimeBucket(rows[e].startMs, contract);
      if (!base.has(bucket)) base.set(bucket, query.horizons.map(() => ({ n: 0, sum: 0 })));
      query.horizons.forEach((h, i) => {
        if (dl && dl[e] < e) return;
        const last = dl ? Math.min(e + h - 1, dl[e]) : e + h - 1;
        if (last >= rows.length || runEnd[e] < last) return;
        const cell = base.get(bucket)![i];
        cell.n++;
        cell.sum += ctNetTradePct(contract, rows[e].open, rows[last].close);
      });
    }
  }
  const mix = new Map<string, number>();
  for (const { ev } of usable) {
    const b = ctTimeBucket(ev.entryStart, contract);
    mix.set(b, (mix.get(b) ?? 0) + 1);
  }

  const horizons = query.horizons.map((bars, i) => {
    const nets = usable.map((x) => net(x.per[i]));
    const baseline = [...mix].reduce((s, [bucket, count]) => {
      const cell = base.get(bucket)?.[i];
      return s + (cell?.n ? (cell.sum / cell.n) * (count / n) : 0);
    }, 0);
    return {
      bars,
      grossRetPct: { mean: round(mean(usable.map((x) => x.per[i].ret))), ...quantiles(usable.map((x) => x.per[i].ret), [0.1, 0.25, 0.5, 0.75, 0.9]) },
      netMeanPct: round(mean(nets)),
      netMedianPct: round(quantile(sortNum(nets), 0.5)),
      netMean2xCostPct: round(mean(usable.map((x) => net(x.per[i], 2)))),
      netPositivePct: share(nets.filter((v) => v > 0).length, n),
      mfePct: quantiles(usable.map((x) => x.per[i].mfe), [0.25, 0.5, 0.75, 0.9]),
      maePct: quantiles(usable.map((x) => x.per[i].mae), [0.1, 0.25, 0.5, 0.75]),
      mfeOver2xCostPct: share(usable.filter((x) => x.per[i].mfe >= 2 * cost).length, n),
      baselineNetMeanPct: round(baseline),
      vsBaselinePct: round(mean(nets) - baseline),
    };
  });

  // Stop/target grid with the engine's own exit rule (stop first on an ambiguous bar).
  const grid = query.grid
    ? query.grid.stopPcts.flatMap((stopPct) =>
        query.grid!.targetPcts.map((targetPct) => {
          const spec = ctQuerySpec(query, contract, { stopPct, targetPct });
          const outcomes = usable.map(({ ev }) => {
            const rows = data[ev.symbol];
            const fill = rows[ev.e].open * (1 + ctImpactPct(contract) / 100);
            for (let k = ev.e; k < rows.length; k++) {
              const exit =
                ctExit(spec, ev.signal, fill, rows[ev.e].startMs, rows[k]) ??
                (dayBounded ? ctForcedExit(spec, contract.market, rows[k]) : null);
              if (exit)
                return {
                  reason: exit.reason,
                  net: ctNetTradePct(contract, rows[ev.e].open, exit.price),
                  net2: ctNetTradePct(contract, rows[ev.e].open, exit.price, 2),
                };
            }
            return null;
          }).filter(Boolean) as Array<{ reason: string; net: number; net2: number }>;
          const m = outcomes.length;
          return {
            stopPct,
            targetPct,
            targetFirstPct: share(outcomes.filter((o) => o.reason === "target").length, m),
            stopFirstPct: share(outcomes.filter((o) => o.reason === "stop").length, m),
            timeExitPct: share(outcomes.filter((o) => o.reason === "time").length, m),
            netMeanPct: round(mean(outcomes.map((o) => o.net))),
            netMean2xCostPct: round(mean(outcomes.map((o) => o.net2))),
          };
        }),
      )
    : [];

  const exitCompare = query.exitCompare ? ctExitCompareRows(query, query.exitCompare, usable, data, contract, dayBounded) : null;

  const months = new Map<string, number[]>();
  for (const x of usable) {
    const month = ctDate(x.ev.at, contract.market, contract.timezone).slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), net(x.per[0])]);
  }
  const days = new Set(usable.map((x) => ctDate(x.ev.at, contract.market, contract.timezone)));
  // Representative events the designer may then read bar by bar with read_bars.
  const ranked = [...usable].sort((a, b) => net(a.per[0]) - net(b.per[0]));
  const picks = [ranked[0], ranked.at(-1), usable[0], usable.at(-1), ranked[Math.floor(n / 2)]].filter(Boolean) as typeof usable;
  const anchors = [...new Map(picks.map((x) => [x.ev.at, x])).values()].map((x) => ({
    at: x.ev.at,
    time: new Date(x.ev.at).toISOString(),
    symbol: x.ev.symbol,
    netPct: round(net(x.per[0])),
  }));
  return {
    events: n,
    uniqueDays: days.size,
    eventsPerDay: round(n / Math.max(1, Math.round((contract.trainingToMs - contract.fromMs) / 86_400_000)), 3),
    droppedAtBoundary: truncated,
    droppedDataGap: gaps,
    roundTripCostPct: round(cost),
    horizons,
    grid,
    ...(exitCompare ? { exitCompare } : {}),
    monthly: [...months].map(([month, xs]) => ({
      month,
      events: xs.length,
      netMeanPct: round(mean(xs)),
      netPositivePct: share(xs.filter((v) => v > 0).length, xs.length),
    })),
    anchors,
    note: "진입 = 신호 봉 다음 봉 시가 · 수익은 계약 비용(수수료·스프레드·슬리피지) 차감 · 학습 구간만",
  };
}

/**
 * Same events, different exit structures. Each row replays every event through ctOpenPosition +
 * ctExitStep — the functions the replay and the live runner use — and reports the after-cost
 * result. "dailyNetPct" is the sum of event nets divided by the training days (overlapping holds
 * are not netted), so it is an upper-bound feel for the daily mean, not the replay's number.
 */
function ctExitCompareRows(
  query: CTQuery,
  compare: CTExitCompare,
  usable: Array<{ ev: CTEvent }>,
  data: Record<string, CTBar[]>,
  contract: CTContract,
  dayBounded: boolean,
) {
  const maxH = Math.max(...query.horizons);
  if (compare.timeStop && compare.timeStop.bars >= maxH) throw new Error("exitCompare.timeStop.bars는 horizons의 최댓값보다 작아야 합니다");
  const days = Math.max(1, Math.round((contract.trainingToMs - contract.fromMs) / 86_400_000));
  type Config = { mode: string; label: string; exit: CTManagedExit };
  const configs: Config[] = [];
  for (const stopPct of compare.stopPcts) {
    const base = { stop: { type: "pct" as const, value: stopPct }, maxHoldBars: maxH };
    for (const r of compare.targetRs) {
      const target = { type: "r" as const, value: r };
      configs.push({ mode: "fixed", label: `손절 ${stopPct}% · 목표 ${r}R`, exit: { ...base, target } });
      if (compare.breakevenTriggerR !== null)
        configs.push({ mode: "breakeven", label: `손절 ${stopPct}% · 목표 ${r}R · +${compare.breakevenTriggerR}R에서 본전`, exit: { ...base, target, breakeven: { triggerR: compare.breakevenTriggerR } } });
      if (compare.timeStop)
        configs.push({ mode: "time_stop", label: `손절 ${stopPct}% · 목표 ${r}R · ${compare.timeStop.bars}봉 ${compare.timeStop.minR}R 미만 정리`, exit: { ...base, target, timeStop: compare.timeStop } });
    }
    if (compare.trail)
      configs.push({ mode: "trail", label: `손절 ${stopPct}% · 목표 없음 · +${compare.trail.activateR}R부터 ${compare.trail.pct}% 트레일`, exit: { ...base, trail: { type: "pct", value: compare.trail.pct, activateR: compare.trail.activateR } } });
  }
  return configs.map((cfg) => {
    const spec = ctQuerySpec(query, contract, cfg.exit);
    const out: Array<{ net: number; net2: number; r: number; reason: string }> = [];
    for (const { ev } of usable) {
      const rows = data[ev.symbol];
      const fill = rows[ev.e].open * (1 + ctImpactPct(contract) / 100);
      let position = ctOpenPosition(spec, ev.signal, fill, rows[ev.e].startMs);
      if (!position) continue;
      for (let k = ev.e; k < rows.length; k++) {
        const step = ctExitStep(spec, ev.signal, position, rows[k], dayBounded ? ctForcedExit(spec, contract.market, rows[k]) : null);
        position = step.position;
        if (step.exit) {
          out.push({
            reason: step.exit.reason,
            net: ctNetTradePct(contract, rows[ev.e].open, step.exit.price),
            net2: ctNetTradePct(contract, rows[ev.e].open, step.exit.price, 2),
            r: (step.exit.price - fill) / position.initialRisk,
          });
          break;
        }
      }
    }
    const n = out.length,
      reasons: Record<string, number> = {};
    for (const o of out) reasons[o.reason] = (reasons[o.reason] ?? 0) + 1;
    return {
      mode: cfg.mode,
      label: cfg.label,
      events: n,
      winRatePct: share(out.filter((o) => o.net > 0).length, n),
      avgR: round(mean(out.map((o) => o.r)), 3),
      netMeanPct: round(mean(out.map((o) => o.net))),
      netMean2xCostPct: round(mean(out.map((o) => o.net2))),
      dailyNetPct: round(out.reduce((sum, o) => sum + o.net, 0) / days, 4),
      exits: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, share(v, n)])),
    };
  });
}
export type CTQueryResult = ReturnType<typeof ctQueryReturns>;

/* -------------------------------------------------------------- read bars */

const readBarsShape = {
  anchors: z.array(z.number().int().nonnegative()).min(1).max(4),
  before: z.number().int().min(0).max(240),
  after: z.number().int().min(0).max(240),
};
export const ctReadBarsSchema = z
  .object(readBarsShape)
  .strict()
  .refine((v) => v.before + v.after <= 240, "before + after ≤ 240");
/** Free bars (traderTools 4): the same request on a chosen bar; an anchor must be a close or an open of that bar. */
export const ctReadBarsSchemaBars = z
  .object({ ...readBarsShape, barMinutes: ctBarMinutesSchema })
  .strict()
  .refine((v) => v.before + v.after <= 240, "before + after ≤ 240");
export type CTReadBars = z.infer<typeof ctReadBarsSchema> & { barMinutes?: 1 | 5 | 15 | 60 };

const clocks = new Map<string, Intl.DateTimeFormat>();
const clock = (timezone: string) => {
  if (!clocks.has(timezone))
    clocks.set(timezone, new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
  return clocks.get(timezone)!;
};
/** The anchor's bar: the one closing at it (a signal) or opening at it (a trade entry). */
function anchorIndex(rows: CTBar[], at: number) {
  const close = rows.findIndex((b) => b.endMs === at);
  return close >= 0 ? close : rows.findIndex((b) => b.startMs === at);
}
/**
 * Bars around server-provided training anchors in a compact form: o/h/l/c as integer basis
 * points from the window's first open, volume as a multiple of the window median, the
 * clock on the first row and every 30th. The anchor row is starred. No raw prices.
 */
export function ctReadBars(input: CTReadBars, data: Record<string, CTBar[]>, contract: CTContract) {
  [data, contract] = atBar(input, data, contract);
  return input.anchors.map((at) => {
    const symbol = contract.symbols.find((s) => anchorIndex(data[s] ?? [], at) >= 0);
    if (!symbol) throw new Error(contract.minutes > 1 ? `기준 시각이 ${contract.minutes}분봉의 시작·마감이 아닙니다` : "기준 시각의 학습 봉 없음");
    const rows = data[symbol];
    const i = anchorIndex(rows, at);
    const from = Math.max(0, i - input.before),
      to = Math.min(rows.length - 1, i + input.after);
    const bars = rows.slice(from, to + 1);
    if (bars[0].startMs < contract.fromMs || bars.at(-1)!.endMs > contract.trainingToMs)
      throw new Error(contract.minutes > 1 ? `CT ${contract.minutes}분봉 열람은 학습 구간만 허용` : "CT 1분봉 열람은 학습 구간만 허용");
    const base = bars[0].open;
    const median = quantile(sortNum(bars.map((b) => b.volume)), 0.5) || 1;
    const bp = (x: number) => Math.round((x / base - 1) * 10_000);
    const time = clock(contract.timezone);
    const lines = bars.map((b, k) =>
      [
        (k % 30 === 0 ? time.format(new Date(b.startMs)) : "") + (from + k === i ? "*" : ""),
        bp(b.open),
        bp(b.high),
        bp(b.low),
        bp(b.close),
        (b.volume / median).toFixed(2),
      ].join(","),
    );
    return {
      symbol,
      anchor: new Date(at).toISOString(),
      date: ctDate(bars[0].startMs, contract.market, contract.timezone),
      timezone: contract.timezone,
      bars: bars.length,
      gaps: bars.filter((b, k) => k && b.startMs !== bars[k - 1].endMs).length,
      format: `t,o,h,l,c,v · o/h/l/c = 첫 시가 대비 bp 정수 · v = 구간 중앙값 대비 배수 · 시각은 첫 줄과 30봉마다(${contract.timezone}) · * = 기준 봉`,
      text: lines.join("\n"),
    };
  });
}
