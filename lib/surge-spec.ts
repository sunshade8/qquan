/**
 * The 급등주 rule language — same-day events, timed from the event.
 *
 * A rule says: among the names that became a surge (or crash) event earlier
 * TODAY (`lib/surge-observation.ts`), buy the one whose session so far looks
 * like X, some minutes after its event, with a frozen stop and reward:risk; hold
 * at most N minutes; be flat by 15:55 ET. Its clock is the event's, not a fixed
 * slot's — "fifteen minutes after it first crossed +10%" is the same moment in
 * the thesis whether the cross came at 09:41 or at 13:12.
 *
 * Nothing here reads yesterday's ranking. The previous close is only the
 * reference a move is measured from.
 */

import { z } from "zod";
import { observedCandidates, minuteEnd, SURGE_OBSERVATION } from "./surge-observation.ts";
import { FEATURES, featureValue } from "./strategy-generation-spec.ts";
import type { IntradayBar } from "./relay-engine.ts";
import { surgeCostPerSidePct } from "./surge-costs.ts";

/** One same-day event: a name, the move at which it was first seen, and the tape behind it. */
export type SurgeCandidate = {
  symbol: string;
  /** Close of the observation minute, "HH:MM" ET. The event does not exist before it. */
  observedAt?: string;
  /** Live discovery time; a late observation is never backdated. */
  availableAt?: string;
  /** The observation minute's close. */
  observedPrice?: number;
  /** The regular session's 09:30 open. */
  sessionOpen?: number | null;
  /** The previous session's dollar volume — the spread model's liquidity input. */
  priorDollarVolume?: number;
  /** Order among the day's visible events by the move at observation. */
  rank: number;
  /** Observation close ÷ previous close − 1, percent. */
  changePct: number;
  /** The previous regular close — the reference, never a selection. */
  prevClose: number;
  /** Regular-session dollar volume through the observation minute. */
  dollarVolume: number;
  volume: number;
  /** The event's own trading date. */
  rankedOn: string;
};

export const BAR_FEATURES = FEATURES;

/**
 * Session and event facts at the decision bar. Every one is computed from the
 * regular session's completed bars up to the decision (plus, in the backtest, a
 * running total of the bars trimmed before the loaded span — see
 * `SessionPrefix`), so the live runner, which holds the whole session, computes
 * the same number.
 */
export const DAY_FEATURES = [
  "eventChangePct",
  "fromPrevClosePct",
  "fromEventPricePct",
  "minutesSinceEvent",
  "sessionHighDistancePct",
  "sessionVwapDistancePct",
  "sessionRangePct",
  "openGapPct",
  "sessionDollarVolumeM",
] as const;
export type DayFeature = (typeof DAY_FEATURES)[number];

export const SURGE_POOLS = ["gainers", "losers"] as const;
export type SurgePool = (typeof SURGE_POOLS)[number];

/** Rules trade the regular session only and are flat by `SURGE_EXIT_BY`. */
export const SURGE_DAY_FROM = SURGE_OBSERVATION.from;
export const SURGE_DAY_TO = "16:00";
/** Every position is flat by this clock — five minutes before the bell, so the exit is a normal limit sell. */
export const SURGE_EXIT_BY = "15:55";
/** The latest bar an entry may be decided on; later leaves no room for the trade. */
export const SURGE_LAST_ENTRY = "15:40";

/**
 * Bar resolutions a rule may read. Minutes are downloaded once and rolled up,
 * so a finer bar costs no extra calls; live bars are built from Toss minute
 * candles on the same hour-aligned grid.
 */
export const SURGE_INTERVALS = ["1m", "3m", "5m"] as const;
export type SurgeInterval = (typeof SURGE_INTERVALS)[number];
export const intervalMinutes = (interval: SurgeInterval) => Number(interval.replace("m", ""));

/** Bar features read at most this many bars back; the loader keeps that much before an event. */
export const MAX_LOOKBACK_BARS = 24;

const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const clock = (total: number) => `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const barConditionSchema = z.object({
  feature: z.enum(BAR_FEATURES),
  lookback: z.number().int().min(2).max(MAX_LOOKBACK_BARS),
  operator: z.enum(["gte", "lte"]),
  value: z.number().min(-100).max(1000),
}).strict();
const dayConditionSchema = z.object({
  feature: z.enum(DAY_FEATURES),
  operator: z.enum(["gte", "lte"]),
  value: z.number().min(-100).max(100_000),
}).strict();

export const surgeCandidateSchema = z.object({
  name: z.string().min(3).max(100),
  hypothesis: z.string().min(20).max(1600),
  /** Which side's events. Both are traded long: a crash is a bounce thesis, never a short. */
  pool: z.enum(SURGE_POOLS),
  /** Size of the move at observation, in absolute percent: a +25% event and a −25% event are both 25. */
  minEventMovePct: z.number().min(SURGE_OBSERVATION.changePct).max(500),
  maxEventMovePct: z.number().min(SURGE_OBSERVATION.changePct).max(5000),
  minPrice: z.number().min(SURGE_OBSERVATION.minPrice).max(200),
  maxPrice: z.number().min(2).max(SURGE_OBSERVATION.maxPrice),
  /** Entries are decided only on bars that close inside this clock window, ET. */
  entryFrom: clockSchema,
  entryTo: clockSchema,
  /** Minutes since the event the decision bar must close within. */
  minMinutesSinceEvent: z.number().int().min(0).max(240),
  maxMinutesSinceEvent: z.number().int().min(1).max(390),
  /** Time exit from the fill; every position is also flat by 15:55 ET. */
  maxHoldMinutes: z.number().int().min(3).max(385),
  /** Sequential trades a day, one position at a time, never the same name twice. */
  maxTradesPerDay: z.number().int().min(1).max(3),
  barInterval: z.enum(SURGE_INTERVALS),
  barConditions: z.array(barConditionSchema).max(4),
  dayConditions: z.array(dayConditionSchema).max(4),
  rankBy: z.enum([...BAR_FEATURES, ...DAY_FEATURES]),
  rankDirection: z.enum(["asc", "desc"]),
  rankLookback: z.number().int().min(2).max(MAX_LOOKBACK_BARS),
  /** Stop distance from the fill, percent. Surge names move; a 0.3% stop is noise. */
  stopPct: z.number().min(1).max(15),
  /** Target ÷ stop. This is the 손익비 the whole feature is about; it is frozen with the rule. */
  rewardRisk: z.number().min(1).max(5),
  minBarDollarVolume: z.number().min(10_000).max(100_000_000),
  /** Live guard: a quoted spread wider than this refuses the entry outright. */
  maxSpreadPct: z.number().min(0.05).max(2),
  cautions: z.array(z.string().max(500)).min(2).max(8),
}).strict();

export const surgeCandidatesSchema = z.object({
  candidates: z.array(surgeCandidateSchema).min(1).max(3),
}).strict();

export const surgePlanSchema = z.object({
  thesis: z.string().min(20).max(2400),
  pool: z.enum(SURGE_POOLS),
  hypotheses: z.array(z.string().max(1000)).min(1).max(3),
  failureModes: z.array(z.string().max(500)).min(5).max(16),
}).strict();

export type SurgeCandidateSpec = z.infer<typeof surgeCandidateSchema>;
export type SurgePlan = z.infer<typeof surgePlanSchema>;

export type SurgeSpec = {
  version: 2;
  id: string;
  candidate: SurgeCandidateSpec;
  evidence: string;
};

export const SURGE_EXECUTION = {
  /** Share of the signal bar's volume the fill may take. */
  participationPct: 1,
  /** Cash left untouched so a rounding error cannot overdraw the account. */
  reservePct: 1,
  /** The account stops opening new surge positions after this much is lost in a day. */
  maxDailyLossPct: 5,
  /** A fill further than this from the signal bar's close is not the fill the rule assumed. */
  maxEntryDriftPct: 1.5,
} as const;

export function targetPctOf(candidate: SurgeCandidateSpec) {
  return Number(Math.min(40, candidate.stopPct * candidate.rewardRisk).toFixed(4));
}

/**
 * The break-even win rate this reward:risk implies before costs, and the one it
 * implies after them. The gap between the two is the entire reason a $1 stock
 * with a 1.2:1 payoff is not a strategy.
 */
export function breakEvenWinRatePct(rewardRisk: number, costInR = 0) {
  return Number((((1 + costInR) / (rewardRisk + 1)) * 100).toFixed(2));
}

/** Round-trip cost expressed in units of the stop — the number that moves the hurdle. */
export function costInR(symbol: string, price: number, dollarVolume: number, stopPct: number) {
  const roundTrip = surgeCostPerSidePct(symbol, price, dollarVolume) * 2;
  return Number((roundTrip / stopPct).toFixed(4));
}

/**
 * The rule's clock. Decisions are asked on bars inside the regular session and
 * only acted on when the decision bar closes in [entryFrom, entryTo]; the last
 * bar a position can be held on starts `step` minutes before 15:55.
 */
export function surgeWindow(candidate: SurgeCandidateSpec) {
  const step = intervalMinutes(candidate.barInterval);
  return {
    step,
    entryFrom: candidate.entryFrom,
    entryTo: candidate.entryTo,
    exitBy: SURGE_EXIT_BY,
    lastBar: clock(Math.floor(minute(SURGE_EXIT_BY) / step) * step - step),
  };
}

export function parseSurgeSpec(value: unknown): SurgeSpec {
  const spec = z.object({
    version: z.literal(2),
    id: z.string().min(1).max(100),
    candidate: surgeCandidateSchema,
    evidence: z.string().max(5000),
  }).strict().parse(value);
  const c = spec.candidate;
  if (c.minPrice >= c.maxPrice) throw new Error("가격 하한이 상한 이상입니다.");
  if (c.minEventMovePct >= c.maxEventMovePct) throw new Error("사건 등락폭 하한이 상한 이상입니다.");
  if (c.minMinutesSinceEvent >= c.maxMinutesSinceEvent) throw new Error("사건 이후 진입 시간 하한이 상한 이상입니다.");
  const step = intervalMinutes(c.barInterval);
  if (minute(c.entryFrom) < minute(SURGE_DAY_FROM) + step) throw new Error(`첫 ${c.barInterval}봉이 끝나는 ${clock(minute(SURGE_DAY_FROM) + step)} ET 이전에는 결정할 수 없습니다.`);
  if (minute(c.entryTo) > minute(SURGE_LAST_ENTRY)) throw new Error(`진입 결정은 ${SURGE_LAST_ENTRY} ET까지입니다 (${SURGE_EXIT_BY} 전량 청산).`);
  if (minute(c.entryTo) - minute(c.entryFrom) < 15) throw new Error("진입 창이 15분 미만입니다.");
  if (c.maxHoldMinutes < 2 * step) throw new Error("최대 보유 시간이 봉 두 개보다 짧습니다.");
  return spec;
}

/**
 * Running totals of the regular-session bars before the first bar in a row.
 * The backtest trims each event's bars to the span a rule can use and carries
 * what it trimmed here; the live runner holds the whole session and passes none.
 */
export type SessionPrefix = { high: number; low: number; pv: number; volume: number; dollarVolume: number; open: number | null };

export function sessionPrefix(bars: IntradayBar[]): SessionPrefix | undefined {
  if (!bars.length) return undefined;
  return {
    high: Math.max(...bars.map((bar) => bar.high)),
    low: Math.min(...bars.map((bar) => bar.low)),
    pv: bars.reduce((sum, bar) => sum + ((bar.high + bar.low + bar.close) / 3) * bar.volume, 0),
    volume: bars.reduce((sum, bar) => sum + bar.volume, 0),
    dollarVolume: bars.reduce((sum, bar) => sum + bar.close * bar.volume, 0),
    open: bars[0].open,
  };
}

/** Session and event facts at the decision bar (the last of `bars`, closing at `decidedAt`). */
export function dayFeatureValue(
  feature: DayFeature,
  bars: IntradayBar[],
  candidate: SurgeCandidate,
  decidedAt: string,
  prefix?: SessionPrefix,
): number | null {
  if (feature === "eventChangePct") return candidate.changePct;
  if (feature === "minutesSinceEvent") return candidate.observedAt ? minute(decidedAt) - minute(candidate.observedAt) : null;
  if (!bars.length || !(candidate.prevClose > 0)) return null;
  const last = bars.at(-1)!;
  const high = Math.max(prefix?.high ?? -Infinity, ...bars.map((b) => b.high));
  const low = Math.min(prefix?.low ?? Infinity, ...bars.map((b) => b.low));
  switch (feature) {
    case "fromPrevClosePct":
      return (last.close / candidate.prevClose - 1) * 100;
    case "fromEventPricePct":
      return candidate.observedPrice ? (last.close / candidate.observedPrice - 1) * 100 : null;
    case "sessionHighDistancePct":
      return high > 0 ? (last.close / high - 1) * 100 : null;
    case "sessionVwapDistancePct": {
      const pv = (prefix?.pv ?? 0) + bars.reduce((sum, b) => sum + ((b.high + b.low + b.close) / 3) * b.volume, 0);
      const volume = (prefix?.volume ?? 0) + bars.reduce((sum, b) => sum + b.volume, 0);
      return volume > 0 && pv > 0 ? (last.close / (pv / volume) - 1) * 100 : null;
    }
    case "sessionRangePct":
      return ((high - low) / candidate.prevClose) * 100;
    case "openGapPct": {
      const open = candidate.sessionOpen ?? prefix?.open ?? (bars[0].time === SURGE_DAY_FROM ? bars[0].open : null);
      return open ? (open / candidate.prevClose - 1) * 100 : null;
    }
    case "sessionDollarVolumeM":
      return ((prefix?.dollarVolume ?? 0) + bars.reduce((sum, b) => sum + b.close * b.volume, 0)) / 1_000_000;
  }
}

export type SurgeOrder = {
  symbol: string;
  stopPct: number;
  targetPct: number;
  reason: string;
};

export type SurgeScanRow = { candidate: SurgeCandidate; bars: IntradayBar[]; prefix?: SessionPrefix };
export type SurgeScanContext = {
  date: string;
  /** Start time of the most recent completed bar. Nothing visible postdates its close. */
  asOf: string;
  rows: SurgeScanRow[];
  equityUsd: number;
};

export type SurgeStrategy = {
  version: 2;
  id: string;
  name: string;
  summary: string;
  pool: SurgePool;
  interval: SurgeInterval;
  /** Minutes per bar — the gap check and the fill both use it. */
  step: number;
  entryFrom: string;
  entryTo: string;
  minMinutesSinceEvent: number;
  maxMinutesSinceEvent: number;
  maxHoldMinutes: number;
  maxTradesPerDay: number;
  exitBy: string;
  /** Start of the last bar a position can be held on. */
  lastBar: string;
  stopPct: number;
  rewardRisk: number;
  targetPct: number;
  maxSpreadPct: number;
  rules: string[];
  cautions: string[];
  execution: typeof SURGE_EXECUTION;
  /** Can this event be traded by the rule at all, before any bar is read? */
  eligible(candidate: SurgeCandidate): boolean;
  scan(context: SurgeScanContext): SurgeOrder | null;
};

/** A bar sequence that cannot be trusted to represent the decision point. */
export function usableBars(bars: IntradayBar[], date: string, asOf: string) {
  if (bars.at(-1)?.time !== asOf) return false;
  return !bars.some((bar, index) =>
    bar.date !== date ||
    bar.time > asOf ||
    ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
    bar.low <= 0 ||
    bar.volume < 0 ||
    bar.high < Math.max(bar.open, bar.close, bar.low) ||
    bar.low > Math.min(bar.open, bar.close) ||
    (index > 0 && bar.time <= bars[index - 1].time));
}

const FEATURE_LABEL: Record<DayFeature, string> = {
  eventChangePct: "관측 시 등락률",
  fromPrevClosePct: "전일 종가 대비",
  fromEventPricePct: "관측가 대비",
  minutesSinceEvent: "관측 후 경과(분)",
  sessionHighDistancePct: "당일 고가 대비",
  sessionVwapDistancePct: "당일 VWAP 대비",
  sessionRangePct: "당일 변동폭",
  openGapPct: "시가 갭",
  sessionDollarVolumeM: "당일 거래대금($M)",
};

export function compileSurgeStrategy(value: unknown): SurgeStrategy {
  const spec = parseSurgeSpec(value);
  const c = spec.candidate;
  const targetPct = targetPctOf(c);
  const window = surgeWindow(c);
  const barLookbacks = [...c.barConditions.map((x) => x.lookback), ...(BAR_FEATURES as readonly string[]).includes(c.rankBy) ? [c.rankLookback] : []];
  const needed = barLookbacks.length ? Math.max(...barLookbacks) + 1 : 1;
  const side = c.pool === "gainers" ? "급상승" : "급하락";

  return {
    version: 2,
    id: spec.id,
    name: c.name,
    summary: c.hypothesis,
    pool: c.pool,
    interval: c.barInterval,
    step: window.step,
    entryFrom: c.entryFrom,
    entryTo: c.entryTo,
    minMinutesSinceEvent: c.minMinutesSinceEvent,
    maxMinutesSinceEvent: c.maxMinutesSinceEvent,
    maxHoldMinutes: c.maxHoldMinutes,
    maxTradesPerDay: c.maxTradesPerDay,
    exitBy: window.exitBy,
    lastBar: window.lastBar,
    stopPct: c.stopPct,
    rewardRisk: c.rewardRisk,
    targetPct,
    maxSpreadPct: c.maxSpreadPct,
    rules: [
      `오늘 ${side} 사건: 정규장 1분봉 종가가 전일 종가 대비 ${c.pool === "gainers" ? "+" : "−"}${c.minEventMovePct}%–${c.maxEventMovePct}% · 누적 거래대금 ≥ $${SURGE_OBSERVATION.minSessionDollarVolume / 1e6}M에서 관측`,
      `관측가 $${c.minPrice}–$${c.maxPrice}`,
      `관측 후 ${c.minMinutesSinceEvent}–${c.maxMinutesSinceEvent}분, ${c.entryFrom}–${c.entryTo} ET에 완성된 ${c.barInterval}봉으로 결정`,
      ...c.dayConditions.map((x) => `${FEATURE_LABEL[x.feature]} ${x.operator === "gte" ? "≥" : "≤"} ${x.value}`),
      ...c.barConditions.map((x) => `${x.feature}(${x.lookback}봉) ${x.operator === "gte" ? "≥" : "≤"} ${x.value}`),
      `손절 ${c.stopPct}% · 목표 ${targetPct}% (손익비 ${c.rewardRisk}:1) · 최대 보유 ${c.maxHoldMinutes}분 · ${SURGE_EXIT_BY} ET 전량 청산`,
      `하루 최대 ${c.maxTradesPerDay}회 순차 진입 · 같은 종목 재진입 없음`,
    ],
    cautions: c.cautions,
    execution: SURGE_EXECUTION,

    eligible(candidate) {
      const move = Math.abs(candidate.changePct);
      const price = candidate.observedPrice ?? candidate.prevClose;
      return !!candidate.observedAt &&
        (c.pool === "gainers" ? candidate.changePct > 0 : candidate.changePct < 0) &&
        move >= c.minEventMovePct && move <= c.maxEventMovePct &&
        price >= c.minPrice && price <= c.maxPrice;
    },

    scan(context) {
      const decidedAt = minuteEnd(context.asOf, window.step);
      if (minute(decidedAt) < minute(c.entryFrom) || minute(decidedAt) > minute(c.entryTo)) return null;
      if (!(context.equityUsd > 0)) return null;

      const visible = new Map(observedCandidates(context.rows.map(row => row.candidate), context.date, decidedAt, c.pool).map(row => [row.symbol, row]));
      const ranked: Array<{ symbol: string; rank: number }> = [];
      for (const source of context.rows) {
        const candidate = visible.get(source.candidate.symbol);
        if (!candidate || !this.eligible(candidate)) continue;
        const since = minute(decidedAt) - minute(candidate.observedAt!);
        if (since < c.minMinutesSinceEvent || since > c.maxMinutesSinceEvent) continue;
        const bars = source.bars;
        if (bars.length < needed || !usableBars(bars, context.date, context.asOf)) continue;
        const recent = bars.slice(-needed);
        if (recent.some((bar, i, all) => i > 0 && minute(bar.time) - minute(all[i - 1].time) !== window.step)) continue;

        const last = bars.at(-1)!;
        if (last.close * last.volume < c.minBarDollarVolume) continue;
        if ((last.volume * SURGE_EXECUTION.participationPct) / 100 < 1) continue;
        const sideCost = surgeCostPerSidePct(candidate.symbol, last.close, candidate.priorDollarVolume ?? candidate.dollarVolume);
        const unitCost = last.close * (1 + (sideCost + SURGE_EXECUTION.maxEntryDriftPct) / 100);
        if (unitCost > context.equityUsd * (1 - SURGE_EXECUTION.reservePct / 100)) continue;

        const passes = c.dayConditions.every((rule) => {
          const n = dayFeatureValue(rule.feature, bars, candidate, decidedAt, source.prefix);
          return n !== null && Number.isFinite(n) && (rule.operator === "gte" ? n >= rule.value : n <= rule.value);
        }) && c.barConditions.every((rule) => {
          const n = featureValue(bars, rule.feature, rule.lookback);
          return n !== null && Number.isFinite(n) && (rule.operator === "gte" ? n >= rule.value : n <= rule.value);
        });
        if (!passes) continue;

        const score = (DAY_FEATURES as readonly string[]).includes(c.rankBy)
          ? dayFeatureValue(c.rankBy as DayFeature, bars, candidate, decidedAt, source.prefix)
          : featureValue(bars, c.rankBy as (typeof BAR_FEATURES)[number], c.rankLookback);
        if (score !== null && Number.isFinite(score)) ranked.push({ symbol: candidate.symbol, rank: score });
      }

      ranked.sort((a, b) =>
        (c.rankDirection === "asc" ? a.rank - b.rank : b.rank - a.rank) || a.symbol.localeCompare(b.symbol));
      return ranked[0]
        ? { symbol: ranked[0].symbol, stopPct: c.stopPct, targetPct, reason: c.name }
        : null;
    },
  };
}

/**
 * The span of one event's bars a rule can ever read: `MAX_LOOKBACK_BARS` before
 * the event, through the latest bar its last possible trade could hold. The
 * backtest loads only this, with the trimmed head carried in `SessionPrefix`.
 */
export function surgeReach(candidate: Pick<SurgeCandidateSpec, "barInterval" | "maxMinutesSinceEvent" | "maxHoldMinutes"> | null, observedAt: string) {
  const step = candidate ? intervalMinutes(candidate.barInterval) : 5;
  const from = Math.max(minute(SURGE_DAY_FROM), minute(observedAt) - (MAX_LOOKBACK_BARS + 1) * step);
  const to = candidate ? Math.min(minute(SURGE_EXIT_BY), minute(observedAt) + candidate.maxMinutesSinceEvent + candidate.maxHoldMinutes + 2 * step) : minute(SURGE_EXIT_BY);
  return { from: clock(from - (from % step)), to: clock(to) };
}

export async function surgeSpecHash(spec: SurgeSpec) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(spec)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
