import { z } from "zod";

/**
 * ct-pattern-1: original DSL (timeframes 1/3/12, hold <= 390 bars, crypto never force-closed).
 * ct-pattern-2 (2026-10-14): adds 60/240/1440-minute timeframes, holds up to 1,440 bars,
 * noEntryBeforeDayEndMinutes, and a forced exit at the end of the trading day (crypto: UTC
 * 00:00 = KST 09:00). Registered ct-pattern-1 packages keep judging exactly as before.
 */
export const CT_ENGINE_V1 = "ct-pattern-1";
export const CT_ENGINE = "ct-pattern-2";
export const ctEngineSchema = z.enum([CT_ENGINE_V1, CT_ENGINE]);
export type CTEngineId = z.infer<typeof ctEngineSchema>;
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
    timeframe: z.union([z.literal(1), z.literal(3), z.literal(12), z.literal(60), z.literal(240), z.literal(1440)]),
    op: z.enum(["gte", "lte"]),
    value: z.number().finite().min(-1000).max(1000),
  })
  .strict();
export const ctSpecSchema = z
  .object({
    version: z.literal(1),
    engine: ctEngineSchema,
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
        // ct-pattern-2: no new entry this many minutes before the day ends (stock close / crypto UTC 00:00).
        noEntryBeforeDayEndMinutes: z.number().int().min(0).max(240).optional(),
      })
      .strict(),
    exit: z
      .object({
        stopPct: z.number().min(0.2).max(15),
        targetPct: z.number().min(0.2).max(40),
        // 390 = one regular session; ct-pattern-2 crypto may hold up to a full UTC day (1,440).
        maxHoldBars: z.number().int().min(1).max(1440),
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
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.engine !== CT_ENGINE_V1) return;
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (spec.exit.maxHoldBars > 390) issue("ct-pattern-1 최대 보유는 390봉");
    if (spec.entry.noEntryBeforeDayEndMinutes) issue("noEntryBeforeDayEndMinutes는 ct-pattern-2부터");
    if (spec.stages.some((s) => s.conditions.some((c) => c.timeframe > 12))) issue("60/240/1440분 시간대는 ct-pattern-2부터");
  });
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
  // Raised from 600,000 for contracts created from 2026-10-14: 1-3 year one-minute replays and
  // higher-timeframe caches (measured in docs/ct.md「데이터 범위」). Older contracts keep their own.
  maxComputeMs: 1_200_000,
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
  /** Per-symbol snapshots when several datasets (BTC/ETH/SOL) are studied together; dataSnapshot is the first. */
  dataSnapshots?: Record<string, string>;
  dataVersion?: string;
  dataProvenance?: Record<string,string>;
  /** Cost profile the `costs` below came from (absent on contracts frozen before profiles). */
  costProfile?: { id: string; version: number };
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
  engine: CTEngineId;
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
  // 0 and absent are the same rule: one hash, so a duplicate cannot hide behind an explicit 0.
  const { noEntryBeforeDayEndMinutes, ...entry } = rules.entry;
  return {
    ...rules,
    entry: noEntryBeforeDayEndMinutes ? { ...entry, noEntryBeforeDayEndMinutes } : entry,
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
/** Longest look-back a higher-timeframe condition may have, days (sessions for stocks). */
export const CT_MAX_LOOKBACK_DAYS = 30;
/** How many days (sessions for stocks) a condition's window (lookback + offset + 1 bars) spans. */
export function ctObservationDays(c: Pick<CTCondition, "lookback" | "offset" | "timeframe">, market: CTMarket) {
  const bars = c.lookback + c.offset + 1;
  return market === "stock" ? bars / Math.ceil(390 / Math.min(c.timeframe, 390)) : (bars * c.timeframe) / 1440;
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
  // 1/3/12-minute conditions read the contiguous recent bars (a session for stocks, 1,500 bars
  // for crypto); 60/240/1440-minute conditions may look back at most 30 days (sessions for stocks).
  const maxHistory =
    contract.market === "stock" ? Math.floor(390 / spec.minutes) : 1500;
  const conditions = spec.stages.flatMap((stage) => stage.conditions);
  if (
    conditions.some(
      (c) => c.timeframe <= 12 && (c.lookback + c.offset + 1) * c.timeframe > maxHistory,
    )
  )
    throw new Error("운용에서 확보 가능한 연속 완성봉 구간 초과");
  if (conditions.some((c) => c.timeframe > 12 && ctObservationDays(c, contract.market) > CT_MAX_LOOKBACK_DAYS))
    throw new Error(`상위 시간대 관찰 구간은 최대 ${CT_MAX_LOOKBACK_DAYS}일`);
  if (spec.engine !== contract.engine) throw new Error("CT 명세 엔진이 동결 계약과 다릅니다.");
  if (contract.market === "stock" && spec.exit.maxHoldBars > 390)
    throw new Error("주식 최대 보유는 390봉(한 세션)");
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
          `${i + 1}. ${stage.label}: ${stage.conditions.map((c) => `${c.feature}(${c.lookback}, 지연 ${c.offset}, ${c.timeframe > 12 ? `${c.timeframe}분` : `${c.timeframe}배`} 완성봉) ${c.op === "gte" ? "≥" : "≤"} ${c.value}`).join(" AND ")}; 이전 단계 후 ${stage.maxGapBars}봉 이내`,
      )
      .join("\n") +
    `\n다음 봉 진입 · 손절 ${spec.exit.stopPct}% · 목표 ${spec.exit.targetPct}% · ${spec.exit.maxHoldBars}봉 시간 청산 · 무효화 ${spec.exit.invalidation}` +
    (spec.engine === CT_ENGINE_V1 ? "" : ` · 당일 경계(${spec.market === "stock" ? "정규장 종료" : "UTC 00:00"}) 강제 청산${spec.entry.noEntryBeforeDayEndMinutes ? ` · 경계 ${spec.entry.noEntryBeforeDayEndMinutes}분 전부터 신규 진입 없음` : ""}`)
  );
}
