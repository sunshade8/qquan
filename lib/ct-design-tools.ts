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
  ctExit,
  ctHistoryBars,
  ctImpactPct,
  ctNetTradePct,
  ctRoundTripCostPct,
  detectCT,
  validCTBar,
  type CTBar,
  type CTFeatureCache,
  type CTSignal,
} from "./ct-engine.ts";
import { ctStockSession } from "./ct-sessions.ts";
import {
  CT_ENGINE,
  ctConditionSchema,
  validateCTSpec,
  type CTContract,
  type CTSpec,
} from "./ct-spec.ts";

/** Look-ahead horizons (bars) the cost hurdle reports. */
export const CT_HURDLE_HORIZONS = [5, 15, 60, 240, 390] as const;
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
function forward(rows: CTBar[], runEnd: number[], e: number, h: number) {
  if (e + h - 1 >= rows.length || runEnd[e] < e + h - 1) return null;
  const open = rows[e].open;
  let high = -Infinity,
    low = Infinity;
  for (let k = e; k < e + h; k++) {
    if (rows[k].high > high) high = rows[k].high;
    if (rows[k].low < low) low = rows[k].low;
  }
  return {
    open,
    close: rows[e + h - 1].close,
    ret: (rows[e + h - 1].close / open - 1) * 100,
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
  const overall = CT_HURDLE_HORIZONS.map(() => emptyRow());
  const byTime = new Map<string, HurdleRow[]>();
  const vol: Array<{ range: number; per: Array<ReturnType<typeof forward>> }> = [];
  for (const symbol of contract.symbols) {
    const { rows, runEnd } = trainingRows(data, symbol, contract);
    for (const b of rows) ranges.push((b.high / b.low - 1) * 100);
    for (let e = 61; e < rows.length; e += HURDLE_STRIDE) {
      const per = CT_HURDLE_HORIZONS.map((h) => forward(rows, runEnd, e, h));
      if (!per[0]) continue;
      const bucket = ctTimeBucket(rows[e].startMs, contract);
      if (!byTime.has(bucket)) byTime.set(bucket, CT_HURDLE_HORIZONS.map(() => emptyRow()));
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
  const regimes = ["저변동", "중변동", "고변동"].map(() => CT_HURDLE_HORIZONS.map(() => emptyRow()));
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
  const horizons = CT_HURDLE_HORIZONS.map((bars, i) => ({
    bars,
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
    entryRule: `학습 구간 ${HURDLE_STRIDE}봉마다 다음 봉 시가 진입 가정 · MFE/MAE는 시가 대비 총 이동(비용 전)`,
    horizons,
    byTime: (TIME_BUCKETS[contract.market] as readonly string[]).flatMap((bucket) =>
      CT_HURDLE_HORIZONS.map((bars, i) => ({ bucket, bars, ...brief(byTime.get(bucket)?.[i] ?? emptyRow()) })),
    ),
    byVolatility: ["저변동", "중변동", "고변동"].flatMap((regime, r) =>
      CT_HURDLE_HORIZONS.map((bars, i) => ({ regime, bars, ...brief(regimes[r][i]) })),
    ),
    volatilityCutoffsPct: { prior60BarRangeP33: round(cut[0]), prior60BarRangeP67: round(cut[1]) },
    conclusion:
      `평균 1분 범위 ${round(meanRange, 3)}%, 왕복 비용 ${round(cost, 3)}%(평균 봉의 ${round(cost / Math.max(meanRange, 1e-9), 1)}배) → ` +
      `비용의 2배를 넘는 유리한 움직임(MFE)은 60분 보유 기준 진입의 ${at60.hit2xPct}%에서만 나타남`,
  };
}
export type CTCostHurdle = ReturnType<typeof ctCostHurdle>;

/* --------------------------------------------------- conditional returns */

const horizon = z.number().int().min(1).max(390);
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
  })
  .strict();
export type CTQuery = z.infer<typeof ctQuerySchema>;

/** The probe spec a query runs through detectCT and ctExit. Never registered or traded. */
export function ctQuerySpec(query: CTQuery, contract: CTContract, exit = { stopPct: 15, targetPct: 40 }): CTSpec {
  return validateCTSpec(
    {
      version: 1,
      engine: CT_ENGINE,
      name: "conditional return probe",
      market: contract.market,
      symbols: contract.symbols,
      minutes: contract.minutes,
      stages: query.stages.map((s, i) => ({ label: `stage ${i + 1}`, ...s })),
      entry: { order: "marketable_limit", validBars: 1, maxSpreadPct: 1, maxDeviationPct: 2 },
      exit: { ...exit, maxHoldBars: Math.max(...query.horizons), invalidation: "stop" },
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
  const spec = ctQuerySpec(query, contract),
    history = ctHistoryBars(spec),
    maxH = Math.max(...query.horizons);
  const events: CTEvent[] = [];
  let truncated = 0,
    gaps = 0;
  for (const symbol of contract.symbols) {
    const rows = data[symbol] ?? [];
    const first = rows.findIndex((b) => b.startMs >= contract.fromMs);
    if (first < 0) continue;
    const cache: CTFeatureCache = new Map();
    let last = -Infinity;
    for (let i = first; i < rows.length && rows[i].endMs <= contract.trainingToMs; i++) {
      if (options.deadline && (i & 1023) === 0 && Date.now() > options.deadline) throw new Error("CT 계산 시간 상한");
      if (i - last < query.cooldownBars) continue;
      const signal = detectCT(spec, symbol, rows.slice(Math.max(0, i - history, first), i + 1), rows[i].endMs, cache);
      if (!signal) continue;
      last = i;
      const e = i + 1;
      // Look-ahead must also end inside training: drop the event rather than shorten it.
      const end = rows[i].endMs + maxH * contract.minutes * 60_000;
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
  const { events, truncated, gaps } = ctQueryEvents(query, data, contract, options);
  const runs = Object.fromEntries(contract.symbols.map((s) => {
    const rows = data[s] ?? [];
    const runEnd = new Array<number>(rows.length);
    for (let i = rows.length - 1; i >= 0; i--)
      runEnd[i] = i + 1 < rows.length && rows[i + 1].startMs === rows[i].endMs && validCTBar(rows[i + 1]) ? runEnd[i + 1] : i;
    return [s, runEnd];
  }));
  const usable = events
    .map((ev) => ({ ev, per: query.horizons.map((h) => forward(data[ev.symbol], runs[ev.symbol], ev.e, h)) }))
    .filter((x) => x.per.every(Boolean)) as Array<{ ev: CTEvent; per: Array<NonNullable<ReturnType<typeof forward>>> }>;
  const n = usable.length;
  const net = (f: { open: number; close: number }, multiplier = 1) => ctNetTradePct(contract, f.open, f.close, multiplier);
  const cost = ctRoundTripCostPct(contract);

  // Unconditional baseline per time bucket, every training entry (no stride: O(1) per bar).
  const base = new Map<string, Array<{ n: number; sum: number }>>();
  for (const symbol of contract.symbols) {
    const { rows, runEnd } = trainingRows(data, symbol, contract);
    for (let e = 1; e < rows.length; e++) {
      const bucket = ctTimeBucket(rows[e].startMs, contract);
      if (!base.has(bucket)) base.set(bucket, query.horizons.map(() => ({ n: 0, sum: 0 })));
      query.horizons.forEach((h, i) => {
        if (e + h - 1 >= rows.length || runEnd[e] < e + h - 1) return;
        const cell = base.get(bucket)![i];
        cell.n++;
        cell.sum += ctNetTradePct(contract, rows[e].open, rows[e + h - 1].close);
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
              const exit = ctExit(spec, ev.signal, fill, rows[ev.e].startMs, rows[k]);
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
export type CTQueryResult = ReturnType<typeof ctQueryReturns>;

/* -------------------------------------------------------------- read bars */

export const ctReadBarsSchema = z
  .object({
    anchors: z.array(z.number().int().nonnegative()).min(1).max(4),
    before: z.number().int().min(0).max(240),
    after: z.number().int().min(0).max(240),
  })
  .strict()
  .refine((v) => v.before + v.after <= 240, "before + after ≤ 240");
export type CTReadBars = z.infer<typeof ctReadBarsSchema>;

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
  return input.anchors.map((at) => {
    const symbol = contract.symbols.find((s) => anchorIndex(data[s] ?? [], at) >= 0);
    if (!symbol) throw new Error("기준 시각의 학습 봉 없음");
    const rows = data[symbol];
    const i = anchorIndex(rows, at);
    const from = Math.max(0, i - input.before),
      to = Math.min(rows.length - 1, i + input.after);
    const bars = rows.slice(from, to + 1);
    if (bars[0].startMs < contract.fromMs || bars.at(-1)!.endMs > contract.trainingToMs)
      throw new Error("CT 1분봉 열람은 학습 구간만 허용");
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
