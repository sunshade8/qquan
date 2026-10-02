/** Versioned, bounded strategy language. Model output is data, never executable code. */
import { z } from "zod";
import { slotById, type SlotId } from "./trade-slots.ts";
import type {
  IntradayBar,
  SlotSessionContext,
  SlotStrategy,
} from "./relay-engine.ts";
import { costPerSidePct } from "./symbol-liquidity.ts";

// User-selected ticker scope; never let a model expand it.
export const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.-]{0,14}$/, "올바른 종목코드를 입력하세요.");
export const universeSchema = z
  .array(symbolSchema)
  .min(1)
  .max(10)
  .refine((v) => new Set(v).size === v.length, "중복 종목코드");
export const SLOT_IDS = [
  "premarket_early",
  "premarket_late",
  "open",
  "trend",
  "midday",
  "afternoon",
  "close",
  "after_early",
  "after_late",
] as const;
export const FEATURES = [
  "returnPct",
  "vwapDistancePct",
  "rangePosition",
  "relativeVolume",
  "breakoutPct",
  "rangePct",
] as const;
export const STRATEGY_INTERVALS = ["1m", "3m", "5m"] as const;
export const strategyBarMinutes = (candidate: { barInterval?: (typeof STRATEGY_INTERVALS)[number] }): 1 | 3 | 5 =>
  candidate.barInterval === "1m" ? 1 : candidate.barInterval === "3m" ? 3 : 5;
const conditionSchema = z
  .object({
    feature: z.enum(FEATURES),
    lookback: z.number().int().min(2).max(24),
    operator: z.enum(["gte", "lte"]),
    value: z.number().min(-100).max(100),
  })
  .strict();
export const candidateSchema = z
  .object({
    name: z.string().min(3).max(100),
    hypothesis: z.string().min(20).max(1600),
    barInterval: z.enum(STRATEGY_INTERVALS),
    conditions: z.array(conditionSchema).min(2).max(6),
    rankBy: z.enum(FEATURES),
    rankDirection: z.enum(["asc", "desc"]),
    rankLookback: z.number().int().min(2).max(24),
    stopPct: z.number().min(0.25).max(3),
    targetPct: z.number().min(0.3).max(8).nullable(),
    minMinutesAfterOpen: z.number().int().min(5).max(120),
    maxSpreadPct: z.number().min(0.02).max(0.5),
    minBarDollarVolume: z.number().min(100_000).max(100_000_000),
    cautions: z.array(z.string().max(500)).min(2).max(8),
  })
  .strict();
export const candidatesSchema = z
  .object({ candidates: z.array(candidateSchema).min(1).max(3) })
  .strict();
export const planSchema = z
  .object({
    thesis: z.string().min(20).max(2400),
    universe: universeSchema,
    hypotheses: z.array(z.string().max(1000)).min(1).max(3),
    failureModes: z.array(z.string().max(500)).min(5).max(16),
  })
  .strict();
export const reviewSchema = z
  .object({
    approved: z.boolean(),
    summary: z.string().min(10).max(2400),
    blockers: z.array(z.string().max(800)).max(16),
    cautions: z.array(z.string().max(800)).max(16),
  })
  .strict();
export const noteSchema = z
  .object({
    summary: z.string().min(10).max(2400),
    issues: z.array(z.string().max(600)).max(16),
  })
  .strict();
export type Candidate = z.infer<typeof candidateSchema>;
export type GenerationPlan = z.infer<typeof planSchema>;
export type GenerationReview = z.infer<typeof reviewSchema>;
export type StrategySpec = {
  version: 1;
  id: string;
  slot: SlotId;
  universe: string[];
  candidate: Candidate;
  evidence: string;
};
export const EXECUTION_LIMITS = {
  participationPct: 1,
  reservePct: 1,
  maxDailyLossPct: 3,
  maxEntryDriftPct: 0.5,
} as const;
const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

export function featureValue(
  bars: IntradayBar[],
  feature: (typeof FEATURES)[number],
  lookback: number,
): number | null {
  if (bars.length < lookback + 1) return null;
  const sample = bars.slice(-lookback - 1),
    last = sample.at(-1)!;
  const prior = sample.slice(0, -1);
  const volume = sample.reduce((s, b) => s + b.volume, 0);
  const high = Math.max(...sample.map((b) => b.high)),
    low = Math.min(...sample.map((b) => b.low));
  if (!(last.close > 0) || volume <= 0) return null;
  switch (feature) {
    case "returnPct":
      return (last.close / sample[0].close - 1) * 100;
    case "vwapDistancePct":
      return (
        (last.close /
          (sample.reduce(
            (s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume,
            0,
          ) /
            volume) -
          1) *
        100
      );
    case "rangePosition":
      return high > low ? (last.close - low) / (high - low) : 0.5;
    case "relativeVolume": {
      const mean = prior.reduce((s, b) => s + b.volume, 0) / prior.length;
      return mean > 0 ? last.volume / mean : null;
    }
    case "breakoutPct":
      return (last.close / Math.max(...prior.map((b) => b.high)) - 1) * 100;
    case "rangePct":
      return ((high - low) / last.close) * 100;
  }
}

export function parseSpec(value: unknown): StrategySpec {
  const schema = z
    .object({
      version: z.literal(1),
      id: z.string().min(1).max(100),
      slot: z.enum(SLOT_IDS),
      universe: universeSchema,
      // Already frozen rules without a resolution retain their original 5m meaning.
      candidate: candidateSchema.extend({ barInterval: z.enum(STRATEGY_INTERVALS).default("5m") }),
      evidence: z.string().max(5000),
    })
    .strict();
  const spec = schema.parse(value);
  if (new Set(spec.universe).size !== spec.universe.length)
    throw new Error("중복 유니버스");
  const slot = slotById(spec.slot)!;
  if (
    spec.candidate.minMinutesAfterOpen >=
    minute(slot.to) - minute(slot.from) - strategyBarMinutes(spec.candidate)
  )
    throw new Error("슬롯 안에 진입·청산 시간이 남지 않는 규칙");
  return spec;
}

function usableBars(context: SlotSessionContext, symbol: string) {
  const bars = [
    ...(context.earlier[symbol] ?? []),
    ...(context.window[symbol] ?? []),
  ];
  // A missing/stale candle never borrows another symbol's newer decision time.
  if (bars.at(-1)?.time !== context.asOf) return [];
  if (
    bars.some(
      (b, i) =>
        b.date !== context.date ||
        b.time > context.asOf ||
        ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
        b.low <= 0 ||
        b.volume <= 0 ||
        b.high < Math.max(b.open, b.close, b.low) ||
        b.low > Math.min(b.open, b.close) ||
        (i > 0 && b.time <= bars[i - 1].time),
    )
  )
    return [];
  return bars;
}

export function compileStrategy(value: unknown, resolveFeature: typeof featureValue = featureValue): SlotStrategy {
  const spec = parseSpec(value),
    c = spec.candidate;
  const step = strategyBarMinutes(c);
  return {
    barMinutes: step,
    id: spec.id,
    name: c.name,
    slot: spec.slot,
    universe: [...spec.universe],
    summary: c.hypothesis,
    rules: [`${step}분봉 완성 후 판단 · 다음 ${step}분봉 진입`, ...c.conditions.map(
      (x) =>
        `${x.feature}(${x.lookback}) ${x.operator === "gte" ? "≥" : "≤"} ${x.value}`,
    )],
    evidence: spec.evidence,
    cautions: c.cautions,
    warmupSessions: 0,
    execution: { ...EXECUTION_LIMITS, maxSpreadPct: c.maxSpreadPct },
    scan(context) {
      const time = minute(context.asOf),
        slotStart = minute(context.slot.from),
        end = minute(context.slot.to);
      if (
        time % step !== 0 ||
        time + step < slotStart + c.minMinutesAfterOpen ||
        time + 2 * step >= end ||
        !(context.equityUsd > 0)
      )
        return null;
      const ranked: Array<{ symbol: string; rank: number }> = [];
      const needed =
        Math.max(c.rankLookback, ...c.conditions.map((x) => x.lookback)) + 1;
      for (const symbol of spec.universe) {
        const bars = usableBars(context, symbol),
          last = bars.at(-1);
        if (
          !last ||
          bars.length < needed ||
          bars
            .slice(-needed)
            .some(
              (b, i, a) =>
                i > 0 && minute(b.time) - minute(a[i - 1].time) !== step,
            )
        )
          continue;
        if (
          last.volume * last.close < c.minBarDollarVolume ||
          (last.volume * EXECUTION_LIMITS.participationPct) / 100 < 1
        )
          continue;
        const unit =
          last.close *
          (1 +
            (costPerSidePct(symbol) + EXECUTION_LIMITS.maxEntryDriftPct) / 100);
        if (unit > context.equityUsd * (1 - EXECUTION_LIMITS.reservePct / 100))
          continue;
        if (
          !c.conditions.every((rule) => {
            const n = resolveFeature(bars, rule.feature, rule.lookback);
            return (
              n !== null &&
              Number.isFinite(n) &&
              (rule.operator === "gte" ? n >= rule.value : n <= rule.value)
            );
          })
        )
          continue;
        const rank = resolveFeature(bars, c.rankBy, c.rankLookback);
        if (rank !== null && Number.isFinite(rank))
          ranked.push({ symbol, rank });
      }
      ranked.sort(
        (a, b) =>
          (c.rankDirection === "asc" ? a.rank - b.rank : b.rank - a.rank) ||
          a.symbol.localeCompare(b.symbol),
      );
      return ranked[0]
        ? {
            symbol: ranked[0].symbol,
            stopPct: c.stopPct,
            targetPct: c.targetPct,
            reason: c.name,
          }
        : null;
    },
  };
}

/** Identifies the exact rule frozen before any validation/holdout replay. */
export async function strategySpecHash(spec: StrategySpec) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(spec)),
  );
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
