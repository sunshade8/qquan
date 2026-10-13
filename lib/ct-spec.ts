import { z } from "zod";

export const CT_ENGINE = "ct-pattern-1";
export const ctMarketSchema = z.enum(["stock", "crypto"]);
export type CTMarket = z.infer<typeof ctMarketSchema>;
export const ctFeatureSchema = z.enum([
  "return_pct",
  "sma_distance_pct",
  "range_pct",
  "volume_ratio",
  "contraction_ratio",
  "prior_high_distance_pct",
  "prior_low_distance_pct",
  "range_position",
  "swing_high_distance_pct",
  "swing_low_distance_pct",
]);
export const ctConditionSchema = z
  .object({
    feature: ctFeatureSchema,
    lookback: z.number().int().min(2).max(120),
    offset: z.number().int().min(0).max(120),
    timeframe: z.union([z.literal(1), z.literal(3), z.literal(12)]),
    op: z.enum(["gte", "lte"]),
    value: z.number().finite().min(-1000).max(1000),
  })
  .strict();
export const ctSpecSchema = z
  .object({
    version: z.literal(1),
    engine: z.literal(CT_ENGINE),
    name: z.string().min(2).max(100),
    market: ctMarketSchema,
    symbols: z
      .array(z.string().regex(/^(?:[A-Z][A-Z0-9.-]{0,11}|KRW-[A-Z0-9]{2,12})$/))
      .min(1)
      .max(4),
    // New research is fixed to 1-minute bars; 5/15/60 stay valid for registered packages.
    minutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(60)]),
    // Stages are ordered observations. Each must occur after the previous one.
    stages: z
      .array(
        z
          .object({
            label: z.string().min(2).max(120),
            maxGapBars: z.number().int().min(1).max(48),
            conditions: z.array(ctConditionSchema).min(1).max(6),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    entry: z
      .object({
        order: z.literal("marketable_limit"),
        validBars: z.literal(1),
        maxSpreadPct: z.number().positive().max(1),
        maxDeviationPct: z.number().positive().max(2),
      })
      .strict(),
    exit: z
      .object({
        stopPct: z.number().min(0.2).max(15),
        targetPct: z.number().min(0.2).max(40),
        // Up to one 390-minute regular session on 1-minute bars.
        maxHoldBars: z.number().int().min(1).max(390),
        invalidation: z.enum(["stop", "last_stage_low"]),
      })
      .strict(),
    sizing: z
      .object({
        riskPct: z.number().min(0.1).max(1),
        allocationPct: z.number().min(1).max(25),
        maxPositions: z.literal(1),
        cooldownBars: z.number().int().min(1).max(120),
        participationPct: z.number().positive().max(1),
      })
      .strict(),
    sourceIds: z.array(z.string()).min(1).max(6),
    assumptions: z.array(z.string().min(5).max(400)).min(1).max(12),
  })
  .strict();
export type CTSpec = z.infer<typeof ctSpecSchema>;
export type CTCondition = z.infer<typeof ctConditionSchema>;
export const CT_POLICY = Object.freeze({
  minTrades: 20,
  maxDrawdownPct: 15,
  minNetReturnPct: 0,
  /** Mean daily net return after costs must exceed this (percent per evaluated day). */
  minMeanDailyReturnPct: 0,
  minCompliancePct: 100,
  maxSymbolConcentrationPct: 80,
  maxExperiments: 12,
  maxCandidates: 6,
  // 1-minute replays: about 260k crypto bars per 180-day run.
  maxComputeMs: 600_000,
  // Research sessions add many short Opus turns; 30 minutes held about 15 one-shot design calls.
  maxActiveMs: 3_600_000,
  stagnation: 3,
  reserveFraction: 0.35,
  // Designer research session (2026-10-13): one Opus tool loop per design/reflect step.
  sessionMaxTurns: 12,
  sessionMaxToolCalls: 24,
  sessionMaxScreens: 6,
  maxSessions: 3,
});
/** Fields added after contracts were first frozen; older contracts lack them. */
type CTPolicyLater = "minMeanDailyReturnPct" | "sessionMaxTurns" | "sessionMaxToolCalls" | "sessionMaxScreens" | "maxSessions";
/** The session limits a contract runs under; contracts frozen before they existed get today's. */
export function ctSessionPolicy(contract: Pick<CTContract, "policy">) {
  const p = contract.policy;
  return {
    maxTurns: p.sessionMaxTurns ?? CT_POLICY.sessionMaxTurns,
    maxToolCalls: p.sessionMaxToolCalls ?? CT_POLICY.sessionMaxToolCalls,
    maxScreens: p.sessionMaxScreens ?? CT_POLICY.sessionMaxScreens,
    maxSessions: p.maxSessions ?? CT_POLICY.maxSessions,
  };
}
export type CTContract = {
  market: CTMarket;
  symbols: string[];
  minutes: 1 | 5 | 15 | 60;
  fromMs: number;
  trainingToMs: number;
  developmentToMs: number;
  toMs: number;
  currency: "USD" | "KRW" | "USDT";
  dataSnapshot?: string;
  dataVersion?: string;
  dataProvenance?: Record<string,string>;
  timezone: "America/New_York" | "Asia/Seoul" | "UTC";
  capital: number;
  costs: {
    feePct: number;
    sellTaxPct: number;
    spreadPct: number;
    slippagePct: number;
    minimumOrder: number;
    quantityDecimals: number;
  };
  // Contracts frozen before a policy field existed simply lack it.
  policy: Omit<typeof CT_POLICY, CTPolicyLater> & Partial<Pick<typeof CT_POLICY, CTPolicyLater>>;
  engine: typeof CT_ENGINE;
  createdAt: string;
  selection: string;
  calendarVersion?: string;
};
export async function ctHash(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
export function executableCT(spec: CTSpec) {
  const { name, sourceIds, assumptions, ...rules } = ctSpecSchema.parse(spec);
  void name;
  void sourceIds;
  void assumptions;
  return {
    ...rules,
    symbols: [...rules.symbols].sort(),
    stages: rules.stages.map(({ label, ...stage }) => {
      void label;
      return {
        ...stage,
        conditions: [...stage.conditions].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      };
    }),
  };
}
export function validateCTSpec(
  value: unknown,
  contract: CTContract,
  sourceIds: string[],
) {
  const spec = ctSpecSchema.parse(value);
  if (
    spec.market !== contract.market ||
    spec.minutes !== contract.minutes ||
    spec.symbols.some((s) => !contract.symbols.includes(s))
  )
    throw new Error("CT 명세가 동결 시장·종목·주기를 벗어났습니다.");
  const maxHistory =
    contract.market === "stock" ? Math.floor(390 / spec.minutes) : 1500;
  if (
    spec.stages.some((stage) =>
      stage.conditions.some(
        (c) => (c.lookback + c.offset + 1) * c.timeframe > maxHistory,
      ),
    )
  )
    throw new Error("운용에서 확보 가능한 연속 완성봉 구간 초과");
  if (spec.sourceIds.some((id) => !sourceIds.includes(id)))
    throw new Error("확인되지 않은 출처");
  // Crypto is Upbit KRW-* (legacy) or Binance *USDT research; stocks are neither.
  const cryptoSymbol = (s: string) => s.startsWith("KRW-") || /^[A-Z0-9]+USDT$/.test(s);
  if (spec.symbols.some((s) => (contract.market === "crypto") !== cryptoSymbol(s)))
    throw new Error("시장과 종목 형식 불일치");
  return spec;
}
export function ctRuleText(spec: CTSpec) {
  return (
    spec.stages
      .map(
        (stage, i) =>
          `${i + 1}. ${stage.label}: ${stage.conditions.map((c) => `${c.feature}(${c.lookback}, 지연 ${c.offset}, ${c.timeframe}배 완성봉) ${c.op === "gte" ? "≥" : "≤"} ${c.value}`).join(" AND ")}; 이전 단계 후 ${stage.maxGapBars}봉 이내`,
      )
      .join("\n") +
    `\n다음 봉 진입 · 손절 ${spec.exit.stopPct}% · 목표 ${spec.exit.targetPct}% · ${spec.exit.maxHoldBars}봉 시간 청산 · 무효화 ${spec.exit.invalidation}`
  );
}
