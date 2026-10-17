import { z } from "zod";

/**
 * ct-pattern-1: original DSL (timeframes 1/3/12, hold <= 390 bars, crypto never force-closed).
 * ct-pattern-2 (2026-10-14): adds 60/240/1440-minute timeframes, holds up to 1,440 bars,
 * noEntryBeforeDayEndMinutes, and a forced exit at the end of the trading day (crypto: UTC
 * 00:00 = KST 09:00). Registered ct-pattern-1 packages keep judging exactly as before.
 * ct-pattern-3 (2026-10-14): a day trader's vocabulary — entryWindows, level features (VWAP,
 * previous-day high/low/close, day open, opening range, day range), ATR features and the `atr`
 * unit, and managed exits (breakeven, trailing stop, time stop, R targets). Everything older
 * keeps judging exactly as before; only ct-pattern-3 specs may use the new fields.
 */
export const CT_ENGINE_V1 = "ct-pattern-1";
export const CT_ENGINE_V2 = "ct-pattern-2";
export const CT_ENGINE = "ct-pattern-3";
export const ctEngineSchema = z.enum([CT_ENGINE_V1, CT_ENGINE_V2, CT_ENGINE]);
export type CTEngineId = z.infer<typeof ctEngineSchema>;
export const ctMarketSchema = z.enum(["stock", "crypto"]);
export type CTMarket = z.infer<typeof ctMarketSchema>;
/** Legacy features: defined on lookback + 1 chained bars of the condition's timeframe. */
export const CT_BASE_FEATURES = [
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
] as const;
/**
 * ct-pattern-3 level features: read the trading day so far (VWAP, previous day, open, opening
 * range, day range). Their lookback/offset/timeframe are fixed by the schema because the
 * quantity has no such parameter — a free parameter that does nothing is only a way to fool oneself.
 * opening_range_position uses `lookback` as the opening range length in minutes.
 */
export const CT_LEVEL_FEATURES = [
  "vwap_distance_pct",
  "prev_day_high_distance_pct",
  "prev_day_low_distance_pct",
  "prev_day_close_distance_pct",
  "day_open_distance_pct",
  "opening_range_position",
  "day_range_position",
] as const;
/** atr_pct: ATR over `lookback` bars as % of close. atr_percentile: rank of the current ATR among the last `lookback` ATRs. */
export const CT_VOLATILITY_FEATURES = ["atr_pct", "atr_percentile"] as const;
export const CT_V3_FEATURES: readonly string[] = [...CT_LEVEL_FEATURES, ...CT_VOLATILITY_FEATURES];
/** Features that are a percent distance/return, so an ATR multiple (unit "atr") is meaningful. */
export const CT_ATR_UNIT_FEATURES: readonly string[] = [
  "return_pct",
  "sma_distance_pct",
  "range_pct",
  "prior_high_distance_pct",
  "prior_low_distance_pct",
  "swing_high_distance_pct",
  "swing_low_distance_pct",
  "vwap_distance_pct",
  "prev_day_high_distance_pct",
  "prev_day_low_distance_pct",
  "prev_day_close_distance_pct",
  "day_open_distance_pct",
];
export const CT_ATR_DEFAULT_LOOKBACK = 14;
export const ctFeatureSchema = z.enum([...CT_BASE_FEATURES, ...CT_LEVEL_FEATURES, ...CT_VOLATILITY_FEATURES]);
const ctTimeframeSchema = z.union([z.literal(1), z.literal(3), z.literal(12), z.literal(60), z.literal(240), z.literal(1440)]);
export const ctConditionSchema = z
  .object({
    feature: ctFeatureSchema,
    lookback: z.number().int().min(2).max(120),
    offset: z.number().int().min(0).max(120),
    timeframe: ctTimeframeSchema,
    op: z.enum(["gte", "lte"]),
    value: z.number().finite().min(-1000).max(1000),
    // ct-pattern-3. unit "atr": compare value as a multiple of the ATR (atrLookback bars, default 14) of
    // atrTimeframe (default: the condition's timeframe), read at the decision time.
    unit: z.enum(["pct", "atr"]).optional(),
    atrLookback: z.number().int().min(2).max(120).optional(),
    atrTimeframe: ctTimeframeSchema.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const level = (CT_LEVEL_FEATURES as readonly string[]).includes(c.feature);
    if (level && c.feature !== "opening_range_position") {
      if (c.lookback !== 2 || c.offset !== 0 || c.timeframe !== 1)
        issue(`${c.feature}은 lookback 2 · offset 0 · timeframe 1 고정(당일 누적 수준이라 다른 값은 의미가 없습니다)`);
    }
    if (c.feature === "opening_range_position") {
      if (c.offset !== 0 || c.timeframe !== 1) issue("opening_range_position은 offset 0 · timeframe 1 고정(lookback = 시가 범위 분 길이)");
      if (c.lookback < 5) issue("opening_range_position의 lookback(시가 범위 길이)은 5분 이상");
    }
    if ((CT_VOLATILITY_FEATURES as readonly string[]).includes(c.feature) && c.unit === "atr") issue(`${c.feature}에는 atr 단위를 쓸 수 없습니다`);
    if (c.unit === "atr" && !CT_ATR_UNIT_FEATURES.includes(c.feature)) issue(`${c.feature}에는 atr 단위를 쓸 수 없습니다(비율·위치 피처)`);
    if (c.atrTimeframe !== undefined && c.unit !== "atr") issue("atrTimeframe은 unit atr에서만 의미가 있습니다");
    if (c.atrLookback !== undefined && c.unit !== "atr" && c.feature !== "atr_percentile") issue("atrLookback은 unit atr 또는 atr_percentile에서만 의미가 있습니다");
  });
/** Rows of the condition's own timeframe the feature reads: lookback + 1, more for atr_percentile (lookback ATR values of atrLookback bars). */
export function ctRowsNeeded(c: Pick<CTCondition, "feature" | "lookback" | "atrLookback">) {
  return c.feature === "atr_percentile" ? c.lookback + (c.atrLookback ?? CT_ATR_DEFAULT_LOOKBACK) : c.lookback + 1;
}
export const ctIsLevelFeature = (feature: string) => (CT_LEVEL_FEATURES as readonly string[]).includes(feature);
export const ctIsPrevDayFeature = (feature: string) => feature.startsWith("prev_day_");

const ctStopSchema = z
  .object({
    type: z.enum(["pct", "atr", "pattern_low", "swing_low"]),
    // pct: percent below entry. atr: ATR multiples below entry. pattern_low / swing_low: extra buffer, percent below that level.
    value: z.number().min(0).max(200),
  })
  .strict();
const ctTargetSchema = z.object({ type: z.enum(["pct", "atr", "r"]), value: z.number().positive().max(100) }).strict();
const ctTrailSchema = z
  .object({
    type: z.enum(["atr", "swing_low", "pct"]),
    value: z.number().min(0).max(100),
    activateR: z.number().min(0).max(20),
  })
  .strict();
/** The classic exit: fixed stop and target percentages, time limit, optional invalidation. Valid in every engine. */
const ctLegacyExitSchema = z
  .object({
    stopPct: z.number().min(0.2).max(15),
    targetPct: z.number().min(0.2).max(40),
    // 390 = one regular session; ct-pattern-2 crypto may hold up to a full UTC day (1,440).
    maxHoldBars: z.number().int().min(1).max(1440),
    invalidation: z.enum(["stop", "last_stage_low"]),
  })
  .strict();
/** ct-pattern-3 managed exit: initial stop, optional target, breakeven, trailing stop and time stop. */
const ctManagedExitSchema = z
  .object({
    stop: ctStopSchema,
    target: ctTargetSchema.optional(),
    // At +triggerR the stop moves to the entry price plus offsetPct (cost offset).
    breakeven: z.object({ triggerR: z.number().min(0.25).max(20), offsetPct: z.number().min(0).max(2).optional() }).strict().optional(),
    trail: ctTrailSchema.optional(),
    // After `bars` bars (the entry bar is bar 1), exit if the open profit is below minR.
    timeStop: z.object({ bars: z.number().int().min(2).max(1440), minR: z.number().min(-1).max(10) }).strict().optional(),
    // ATR used by every `atr` type in this exit (default timeframe 1, lookback 14), read at the decision time.
    atr: z.object({ timeframe: ctTimeframeSchema, lookback: z.number().int().min(2).max(120) }).strict().optional(),
    maxHoldBars: z.number().int().min(1).max(1440),
  })
  .strict();
export type CTLegacyExit = z.infer<typeof ctLegacyExitSchema>;
export type CTManagedExit = z.infer<typeof ctManagedExitSchema>;
export const ctIsManagedExit = (exit: CTSpec["exit"]): exit is CTManagedExit => "stop" in exit;

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
    // The bar every count in the spec is measured in. Research chooses 1/5/15/60 (stocks 1/5/15) since 2026-10-16.
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
        // ct-pattern-3: enter only while the minutes elapsed since the day start (stock: the regular-session
        // open, 0–389; crypto: UTC 00:00, 0–1439) at the signal bar's close lie inside a window, both ends included.
        entryWindows: z
          .array(
            z
              .object({ fromMinute: z.number().int().min(0).max(1439), toMinute: z.number().int().min(0).max(1439) })
              .strict()
              .refine((w) => w.fromMinute <= w.toMinute, "fromMinute ≤ toMinute"),
          )
          .max(3)
          .optional(),
      })
      .strict(),
    exit: z.union([ctLegacyExitSchema, ctManagedExitSchema]),
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
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (spec.engine === CT_ENGINE_V1) {
      if (spec.exit.maxHoldBars > 390) issue("ct-pattern-1 최대 보유는 390봉");
      if (spec.entry.noEntryBeforeDayEndMinutes) issue("noEntryBeforeDayEndMinutes는 ct-pattern-2부터");
      if (spec.stages.some((s) => s.conditions.some((c) => c.timeframe > 12))) issue("60/240/1440분 시간대는 ct-pattern-2부터");
    }
    const conditions = spec.stages.flatMap((s) => s.conditions);
    // 5/15/60-minute research bars (2026-10-16): the opening range must be whole bars.
    if (conditions.some((c) => c.feature === "opening_range_position" && c.lookback % spec.minutes))
      issue(`opening_range_position의 lookback(시가 범위 분 길이)은 봉 주기 ${spec.minutes}분의 배수여야 합니다`);
    if (spec.engine !== CT_ENGINE) {
      if (conditions.some((c) => CT_V3_FEATURES.includes(c.feature))) issue("레벨·ATR 피처는 ct-pattern-3부터");
      if (conditions.some((c) => c.unit !== undefined || c.atrLookback !== undefined || c.atrTimeframe !== undefined)) issue("unit·atrLookback·atrTimeframe은 ct-pattern-3부터");
      if (spec.entry.entryWindows?.length) issue("entryWindows는 ct-pattern-3부터");
      if (ctIsManagedExit(spec.exit)) issue("손절·목표·본전·트레일·시간 손절 구조의 exit는 ct-pattern-3부터");
    }
    if (ctIsManagedExit(spec.exit)) {
      const exit = spec.exit;
      const usesAtr = exit.stop.type === "atr" || exit.target?.type === "atr" || exit.trail?.type === "atr";
      if (exit.atr && !usesAtr) issue("exit.atr는 atr 유형의 손절·목표·트레일이 있을 때만 의미가 있습니다");
      if (exit.stop.type === "pct" && (exit.stop.value < 0.2 || exit.stop.value > 15)) issue("pct 손절은 0.2–15%");
      if (exit.stop.type === "atr" && exit.stop.value < 0.5) issue("atr 손절은 0.5 ATR 이상");
      if ((exit.stop.type === "pattern_low" || exit.stop.type === "swing_low") && exit.stop.value > 5) issue("패턴/스윙 저점 손절의 여유폭은 5% 이하");
      if (exit.target?.type === "pct" && (exit.target.value < 0.2 || exit.target.value > 40)) issue("pct 목표는 0.2–40%");
      if (exit.target?.type === "r" && exit.target.value < 0.5) issue("r 목표는 0.5R 이상");
      if (exit.target?.type === "atr" && exit.target.value < 0.5) issue("atr 목표는 0.5 ATR 이상");
      if (exit.trail && exit.trail.type !== "swing_low" && exit.trail.value <= 0) issue("트레일 폭은 0보다 커야 합니다");
      if (exit.trail?.type === "pct" && exit.trail.value < 0.1) issue("pct 트레일은 0.1% 이상");
      if (exit.timeStop && exit.timeStop.bars >= exit.maxHoldBars) issue("timeStop.bars는 maxHoldBars보다 작아야 합니다");
    }
  });
export type CTSpec = z.infer<typeof ctSpecSchema>;
export type CTCondition = z.infer<typeof ctConditionSchema>;
export const CT_POLICY_V6 = Object.freeze({
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
  // 2026-10-14 (stage 3, trader tools): 16 turns, 40 tool calls, up to 32 chart images, 2 blind sets.
  // 2026-10-14 (stage 4): 48 chart images per session so a 24-chart blind set and 16 ordinary charts fit.
  sessionMaxTurns: 16,
  sessionMaxToolCalls: 40,
  sessionMaxScreens: 6,
  maxSessions: 3,
  sessionMaxCharts: 48,
  sessionMaxBlindSets: 2,
  /**
   * 1 = the designer has label_moves / contrast_moves / view_charts / grade_blind / diagnose_trades and the playbook.
   * 2 = stage 4: contrast control modes (time / vol_matched / losers), 16–32-chart blind sets with reserve anchors,
   *     calibration records and "already measured" in the stable block, summarized thinking, and the stage-4 brief.
   * 3 = stage 5 (2026-10-15): family lessons and the coverage map in the stable block, lessonChecks on submit_candidates,
   *     the lesson distillation at the end of a run (its own reserve), and the stage-5 brief.
   * 4 = free bars (2026-10-16): the contract still holds one-minute data, but each candidate chooses the bar it trades on
   *     (spec.minutes 1/5/15/60, stocks 1/5/15) and each measurement tool takes barMinutes; the ledger counts the bar.
   * 5 = bar overview (2026-10-16): the stable block also holds the cost hurdle and the label base rate on every allowed bar
   *     (lib/ct-bar-overview.ts, free: not a test), and the brief says so. Tools are the free-bar tools, byte for byte.
   * 6 = time-free blind sets (2026-10-16): every panel of a blind chart is the last N bars ending at the decision (no clock,
   *     no day boundary, no session VWAP or opening range: format ct-chart-3-blind), label_moves matches controls to the
   *     event's bar slot of the day, and a time inside an ungraded blind set cannot be opened any other way. Run 7a4354f4
   *     matched its own 15-minute event/control times to the length of the "today" panel (docs/ct.md「시간대 없는 블라인드」).
   */
  traderTools: 6,
  /** Stage 5: money withheld from the designer and the reviewers at the start of a run so the lesson distillation can always run (docs/ct.md「연구 교훈」). */
  lessonReserveUsd: 0.05,
  /** Stage 5: the distillation prompt may not exceed this many characters, and its answer this many output tokens. */
  lessonMaxInputChars: 60_000,
  lessonMaxOutputTokens: 8000,
});
/** traderTools 7 (book): components, frozen books, scoped memory. Frozen; new contracts get traderTools 8 below. */
export const CT_POLICY_V7 = Object.freeze({ ...CT_POLICY_V6, traderTools: 7 });
/**
 * traderTools 8 (2026-10-16, cost-lean sessions, docs/ct.md「비용 절감 세션」): the book policy with every gate, measurement and
 * view unchanged, but a refused submission reports every issue at once and is fixed with amend_submission (changed fields only),
 * a session whose components all fail training (or arrive after the books were frozen) counts as empty, earlier sessions'
 * labelIds/contrastIds are listed for reuse, query results come as column tables, measurement turns run at effort medium,
 * and a run reuses a recent run's verified web principles for the same market, symbols and brief.
 */
export const CT_POLICY = Object.freeze({ ...CT_POLICY_V6, traderTools: 8 });
/**
 * The policy a NEW contract is frozen with. Always CT_POLICY — except for verification: QQUAN_CT_POLICY_VERSION=1 freezes it with the
 * stage-3 policy (tool version 1, 32 images) so the same-board refusal against runs made under that policy can be exercised on real
 * data without paying for anything (docs/ct.md「판 서명」). Not set in normal use.
 */
export function ctPolicyForNewContract(): CTContract["policy"] {
  const override = typeof process !== "undefined" ? process.env?.QQUAN_CT_POLICY_VERSION : undefined;
  // 5 = bar overview, 4 = free bars, 3 = stage 5: each exactly as frozen before the next version: every field of today's policy, only the tool version differs.
  if (override === "7") return CT_POLICY_V7;
  if (override === "6") return CT_POLICY_V6;
  if (override === "3" || override === "4" || override === "5") return { ...CT_POLICY_V6, traderTools: Number(override) };
  if (override === "1" || override === "2") {
    // An earlier-stage contract carries none of the stage-5 fields, exactly as it would have been frozen then.
    const { lessonReserveUsd: _a, lessonMaxInputChars: _b, lessonMaxOutputTokens: _c, ...earlier } = CT_POLICY_V6;
    void _a; void _b; void _c;
    return override === "1" ? { ...earlier, traderTools: 1, sessionMaxCharts: 32 } : { ...earlier, traderTools: 2 };
  }
  return CT_POLICY;
}
/** The policy fields as stored on a contract (numbers: a stage-3 contract carries tool version 1 and 32 images, not today's literals). */
export type CTPolicyShape = { readonly [K in keyof typeof CT_POLICY]: number };
/** Fields added after contracts were first frozen; older contracts lack them. */
type CTPolicyLater =
  | "minMeanDailyReturnPct"
  | "sessionMaxTurns"
  | "sessionMaxToolCalls"
  | "sessionMaxScreens"
  | "maxSessions"
  | "sessionMaxCharts"
  | "sessionMaxBlindSets"
  | "traderTools"
  | "lessonReserveUsd"
  | "lessonMaxInputChars"
  | "lessonMaxOutputTokens";
/**
 * The session limits a contract runs under. A contract frozen before a limit existed gets the value
 * of the stage that introduced it (never today's higher one): sessions that started with 12 turns,
 * 24 tool calls and no trader tools keep exactly that.
 */
export function ctSessionPolicy(contract: Pick<CTContract, "policy">) {
  const p = contract.policy;
  return {
    maxTurns: p.sessionMaxTurns ?? 12,
    maxToolCalls: p.sessionMaxToolCalls ?? 24,
    maxScreens: p.sessionMaxScreens ?? 6,
    maxSessions: p.maxSessions ?? 3,
    maxCharts: p.sessionMaxCharts ?? 0,
    maxBlindSets: p.sessionMaxBlindSets ?? 0,
    /** Stage 3+: the trader tools, the playbook and the self-rebuttal exist only on contracts that carry the flag. */
    traderTools: (p.traderTools ?? 0) >= 1,
    /** 0 = stage-2 tools, 1 = stage-3 trader tools (frozen bytes), 2 = stage-4 tools, brief and request options, 3 = stage 5 (lessons, coverage, lessonChecks), 4 = free bars, 5 = bar overview, 6 = time-free blind sets, 7 = book, 8 = cost-lean sessions. */
    toolsVersion: (p.traderTools ?? 0) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
    book: (p.traderTools ?? 0) >= 7,
    /** traderTools 8: cost-lean sessions (all submit issues at once + amend_submission, empty-session rule after training, reuse lists, column tables, per-turn effort, source reuse). */
    lean: (p.traderTools ?? 0) >= 8,
    /** Free bars: a candidate and a measurement choose their own bar over the contract's one-minute data. */
    freeBars: (p.traderTools ?? 0) >= 4,
    /** Bar overview: the stable block holds the cost hurdle and label base rate on every allowed bar (not a test). */
    barOverview: (p.traderTools ?? 0) >= 5,
    /** Time-free blind sets: blind charts carry no time of day (ct-chart-3-blind) and controls share the event's bar slot of the day. */
    timeFreeBlind: (p.traderTools ?? 0) >= 6,
    /** Stage 5: the family lessons exist only on contracts that carry the flag; earlier contracts get 0 / false. */
    lessons: (p.traderTools ?? 0) >= 3,
    lessonReserveUsd: (p.traderTools ?? 0) >= 3 ? (p.lessonReserveUsd ?? 0) : 0,
    lessonMaxInputChars: p.lessonMaxInputChars ?? 60_000,
    lessonMaxOutputTokens: p.lessonMaxOutputTokens ?? 8000,
    /** Blind-set size for toolsVersion 2: min / default / max charts (stage 3 sets are 4–64 charts of any even size, per its own schema). */
    blindSize: (p.traderTools ?? 0) >= 2 ? { min: 16, default: 24, max: 32 } : null,
  };
}
/**
 * Display text for a contract's `selection`. Contracts frozen before 2026-10-14 stored the NVDA/BTC sentence for
 * every default run (so coin runs said "NVDA 단일 종목"); stored contracts are never rewritten, only shown correctly.
 */
export function ctSelectionLabel(contract: Pick<CTContract, "market" | "selection">) {
  if (contract.market === "crypto" && /NVDA/.test(contract.selection))
    return "Binance BTCUSDT(또는 선택 종목) 연구 · 다른 종목에 일반화 검증되지 않음";
  if (contract.market === "stock" && /Binance/.test(contract.selection)) return "NVDA 단일 종목 연구 · 다른 종목에 일반화 검증되지 않음";
  return contract.selection;
}
export type CTContract = {
  tradeSettings?: import("zod").infer<typeof import("./ct-capabilities.ts").ctTradeSettingsSchema>;
  semantics?: { schema: "ct-contract-2"; engine: "ct-decision-1"; accounting: "ct-accounting-1"; router: "ct-router-1"; productVersion: "v0.0" };
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
  /**
   * Limit-order-only execution (lib/ct-limit-execution.ts), frozen with the contract. Absent = the earlier model
   * (fill at the next bar's open ± impact, taker fee) and the contract replays exactly as it always did.
   */
  execution?: import("./ct-limit-execution.ts").CTExecutionPolicy;
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
  policy: Omit<CTPolicyShape, CTPolicyLater> & Partial<Pick<CTPolicyShape, CTPolicyLater>>;
  engine: CTEngineId;
  createdAt: string;
  selection: string;
  calendarVersion?: string;
  /** Stage 4: identity of the board (docs/ct.md「판 서명」); absent on contracts frozen before it. */
  boardSignature?: string;
  /** Stage 4: set when a same-board rerun was started on purpose (repeatReason). */
  repeat?: { n: number; reason: string; previousRuns: string[] };
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
/** Defaults spelled out and absent are the same rule (one hash): unit "pct", atrLookback 14, atrTimeframe = the condition's own. */
function ctNormalizedCondition(c: CTCondition): CTCondition {
  const { unit, atrLookback, atrTimeframe, ...rest } = c;
  return {
    ...rest,
    ...(unit === "atr" ? { unit } : {}),
    ...(atrLookback !== undefined && atrLookback !== CT_ATR_DEFAULT_LOOKBACK ? { atrLookback } : {}),
    ...(unit === "atr" && atrTimeframe !== undefined && atrTimeframe !== c.timeframe ? { atrTimeframe } : {}),
  };
}
export function executableCT(spec: CTSpec) {
  const { name, sourceIds, assumptions, ...rules } = ctSpecSchema.parse(spec);
  void name;
  void sourceIds;
  void assumptions;
  // 0 and absent are the same rule: one hash, so a duplicate cannot hide behind an explicit 0.
  const { noEntryBeforeDayEndMinutes, entryWindows, ...entry } = rules.entry;
  const windows = [...(entryWindows ?? [])].sort((a, b) => a.fromMinute - b.fromMinute || a.toMinute - b.toMinute);
  return {
    ...rules,
    entry: {
      ...entry,
      ...(noEntryBeforeDayEndMinutes ? { noEntryBeforeDayEndMinutes } : {}),
      ...(windows.length ? { entryWindows: windows } : {}),
    },
    symbols: [...rules.symbols].sort(),
    stages: rules.stages.map(({ label, ...stage }) => {
      void label;
      return {
        ...stage,
        conditions: stage.conditions.map(ctNormalizedCondition).sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      };
    }),
  };
}
/** Longest look-back a higher-timeframe condition may have, days (sessions for stocks). */
export const CT_MAX_LOOKBACK_DAYS = 30;
/** How many days (sessions for stocks) `bars` bars of `timeframe` minutes span. */
function ctBarsDays(bars: number, timeframe: number, market: CTMarket) {
  return market === "stock" ? bars / Math.ceil(390 / Math.min(timeframe, 390)) : (bars * timeframe) / 1440;
}
/** How many days (sessions for stocks) a condition's window (rows needed + offset bars) spans. */
export function ctObservationDays(c: Pick<CTCondition, "lookback" | "offset" | "timeframe"> & Partial<Pick<CTCondition, "feature" | "atrLookback">>, market: CTMarket) {
  const bars = (c.feature ? ctRowsNeeded({ feature: c.feature, lookback: c.lookback, atrLookback: c.atrLookback }) : c.lookback + 1) + c.offset;
  return ctBarsDays(bars, c.timeframe, market);
}
/** Timeframe and bar count of the ATR window a unit-"atr" condition reads (offset 0, the decision time). */
export function ctAtrWindow(c: Pick<CTCondition, "timeframe" | "atrLookback" | "atrTimeframe">) {
  return { timeframe: c.atrTimeframe ?? c.timeframe, rows: (c.atrLookback ?? CT_ATR_DEFAULT_LOOKBACK) + 1 };
}
/** The exit's ATR settings (managed exits only): defaults to 1-minute ATR(14). */
export function ctExitAtrConfig(exit: CTSpec["exit"]) {
  return ctIsManagedExit(exit) ? (exit.atr ?? { timeframe: 1 as const, lookback: CT_ATR_DEFAULT_LOOKBACK }) : null;
}
export const ctExitUsesAtr = (exit: CTSpec["exit"]) =>
  ctIsManagedExit(exit) && (exit.stop.type === "atr" || exit.target?.type === "atr" || exit.trail?.type === "atr");
/** The most holding bars any exit allows, whichever shape. */
export const ctMaxHoldBars = (exit: CTSpec["exit"]) => exit.maxHoldBars;
/** Free bars: the bar a measurement runs on (minutes; default the contract's one-minute data). Checked against ctBarChoices by the server. */
export const ctBarMinutesSchema = z
  .union([z.literal(1), z.literal(5), z.literal(15), z.literal(60)])
  .optional()
  .describe("Bar size in minutes this measurement runs on (default 1). Every bar count in the request counts these bars. Stocks: 1/5/15.");
/** Bars a free-bar candidate or measurement may choose (built from complete minutes on the epoch grid). Stock 60-minute bars would straddle the 09:30 open. */
export const ctBarChoices = (market: CTMarket): readonly number[] => (market === "stock" ? [1, 5, 15] : [1, 5, 15, 60]);
/** Whether a spec (or a measurement) may run on `minutes` bars under this contract: its own bar, or any free-bar choice over one-minute data. */
export function ctBarAllowed(contract: Pick<CTContract, "market" | "minutes" | "policy">, minutes: number) {
  if (minutes === contract.minutes) return true;
  return ctSessionPolicy(contract).freeBars && contract.minutes === 1 && ctBarChoices(contract.market).includes(minutes);
}
export function validateCTSpec(
  value: unknown,
  contract: CTContract,
  sourceIds: string[],
) {
  const spec = ctSpecSchema.parse(value);
  if (
    spec.market !== contract.market ||
    spec.symbols.some((s) => !contract.symbols.includes(s))
  )
    throw new Error("CT 명세가 동결 시장·종목·주기를 벗어났습니다.");
  if (!ctBarAllowed(contract, spec.minutes))
    throw new Error(
      ctSessionPolicy(contract).freeBars
        ? `봉 주기는 ${ctBarChoices(contract.market).join("/")}분 중에서 고릅니다.`
        : "CT 명세가 동결 시장·종목·주기를 벗어났습니다.",
    );
  // 1/3/12-minute conditions read the contiguous recent bars (a session for stocks, 1,500 bars
  // for crypto); 60/240/1440-minute conditions may look back at most 30 days (sessions for stocks).
  const maxHistory =
    contract.market === "stock" ? Math.floor(390 / spec.minutes) : 1500;
  const conditions = spec.stages.flatMap((stage) => stage.conditions);
  if (
    conditions.some(
      (c) => c.timeframe <= 12 && (ctRowsNeeded(c) + c.offset) * c.timeframe > maxHistory,
    )
  )
    throw new Error("운용에서 확보 가능한 연속 완성봉 구간 초과");
  if (conditions.some((c) => c.timeframe > 12 && ctObservationDays(c, contract.market) > CT_MAX_LOOKBACK_DAYS))
    throw new Error(`상위 시간대 관찰 구간은 최대 ${CT_MAX_LOOKBACK_DAYS}일`);
  // ATR normalisers read their own window: the same limits apply to it.
  for (const c of conditions.filter((x) => x.unit === "atr")) {
    const w = ctAtrWindow(c);
    if (w.timeframe <= 12 ? w.rows * w.timeframe > maxHistory : ctBarsDays(w.rows, w.timeframe, contract.market) > CT_MAX_LOOKBACK_DAYS)
      throw new Error("ATR 관찰 구간이 한도를 넘습니다(1/3/12분은 연속 봉 한도, 상위 시간대는 30일)");
  }
  const exitAtr = ctExitAtrConfig(spec.exit);
  if (exitAtr && ctExitUsesAtr(spec.exit)) {
    const rows = exitAtr.lookback + 1;
    if (exitAtr.timeframe <= 12 ? rows * exitAtr.timeframe > maxHistory : ctBarsDays(rows, exitAtr.timeframe, contract.market) > CT_MAX_LOOKBACK_DAYS)
      throw new Error("청산 ATR 관찰 구간이 한도를 넘습니다");
  }
  if (spec.engine !== contract.engine) throw new Error("CT 명세 엔진이 동결 계약과 다릅니다.");
  // Stock bars sit on the epoch grid; 60-minute ones would straddle the 09:30 open. ct-pattern-1 packages keep theirs.
  if (contract.market === "stock" && spec.engine !== CT_ENGINE_V1 && spec.minutes === 60)
    throw new Error("주식 연구 봉 주기는 1/5/15분(60분봉은 09:30 개장 격자와 맞지 않음)");
  if (contract.market === "stock" && spec.exit.maxHoldBars > 390)
    throw new Error("주식 최대 보유는 390봉(한 세션)");
  if (contract.market === "stock" && spec.entry.entryWindows?.some((w) => w.toMinute > 389))
    throw new Error("주식 entryWindows는 개장 후 0–389분");
  if (spec.sourceIds.some((id) => !sourceIds.includes(id)))
    throw new Error("확인되지 않은 출처");
  // Crypto is Upbit KRW-* (legacy) or Binance *USDT research; stocks are neither.
  const cryptoSymbol = (s: string) => s.startsWith("KRW-") || /^[A-Z0-9]+USDT$/.test(s);
  if (spec.symbols.some((s) => (contract.market === "crypto") !== cryptoSymbol(s)))
    throw new Error("시장과 종목 형식 불일치");
  return spec;
}
const CT_FEATURE_TEXT: Record<string, string> = {
  vwap_distance_pct: "VWAP 대비 거리%",
  prev_day_high_distance_pct: "전일 고가 대비%",
  prev_day_low_distance_pct: "전일 저가 대비%",
  prev_day_close_distance_pct: "전일 종가 대비%",
  day_open_distance_pct: "당일 시가 대비%",
  opening_range_position: "시가 범위 내 위치",
  day_range_position: "당일 고저 내 위치",
};
function ctConditionText(c: CTCondition) {
  const cmp = `${c.op === "gte" ? "≥" : "≤"} ${c.value}`;
  if (CT_V3_FEATURES.includes(c.feature) || c.unit === "atr") {
    const unit = c.unit === "atr" ? ` ATR배(${c.atrTimeframe ?? c.timeframe}분 ${c.atrLookback ?? CT_ATR_DEFAULT_LOOKBACK}봉)` : "";
    if (c.feature === "opening_range_position") return `시가 범위(첫 ${c.lookback}분) 내 위치 ${cmp}`;
    if (ctIsLevelFeature(c.feature)) return `${CT_FEATURE_TEXT[c.feature]}${unit} ${cmp}`;
    if (c.feature === "atr_pct") return `ATR%(${c.lookback}, ${c.timeframe}분 완성봉) ${cmp}`;
    if (c.feature === "atr_percentile") return `ATR 분위(최근 ${c.lookback}개, ATR ${c.atrLookback ?? CT_ATR_DEFAULT_LOOKBACK}봉, ${c.timeframe}분 완성봉) ${cmp}`;
    return `${c.feature}(${c.lookback}, 지연 ${c.offset}, ${c.timeframe > 12 ? `${c.timeframe}분` : `${c.timeframe}배`} 완성봉)${unit} ${cmp}`;
  }
  return `${c.feature}(${c.lookback}, 지연 ${c.offset}, ${c.timeframe > 12 ? `${c.timeframe}분` : `${c.timeframe}배`} 완성봉) ${cmp}`;
}
function ctExitText(exit: CTSpec["exit"]) {
  if (!ctIsManagedExit(exit)) return `손절 ${exit.stopPct}% · 목표 ${exit.targetPct}% · ${exit.maxHoldBars}봉 시간 청산 · 무효화 ${exit.invalidation}`;
  const stop = { pct: `${exit.stop.value}%`, atr: `${exit.stop.value} ATR`, pattern_low: `패턴 저점 −${exit.stop.value}%`, swing_low: `스윙 저점 −${exit.stop.value}%` }[exit.stop.type];
  const target = exit.target ? { pct: `${exit.target.value}%`, atr: `${exit.target.value} ATR`, r: `${exit.target.value}R` }[exit.target.type] : "없음";
  const atr = ctExitUsesAtr(exit) ? ` · ATR=${ctExitAtrConfig(exit)!.timeframe}분 ${ctExitAtrConfig(exit)!.lookback}봉` : "";
  return (
    `손절 ${stop} · 목표 ${target}` +
    (exit.breakeven ? ` · +${exit.breakeven.triggerR}R에서 손절을 본전(진입가${exit.breakeven.offsetPct ? `+${exit.breakeven.offsetPct}%` : ""})으로` : "") +
    (exit.trail ? ` · +${exit.trail.activateR}R부터 ${{ atr: `${exit.trail.value} ATR`, pct: `${exit.trail.value}%`, swing_low: `직전 확정 스윙 저점 −${exit.trail.value}%` }[exit.trail.type]} 트레일` : "") +
    (exit.timeStop ? ` · ${exit.timeStop.bars}봉 안에 ${exit.timeStop.minR}R 미만이면 정리` : "") +
    ` · 최대 ${exit.maxHoldBars}봉` +
    atr
  );
}
export function ctRuleText(spec: CTSpec) {
  const windows = spec.entry.entryWindows?.length
    ? ` · 진입 시간 창(${spec.market === "stock" ? "개장" : "UTC 00:00"} 후 분) ${spec.entry.entryWindows.map((w) => `${w.fromMinute}–${w.toMinute}`).join(", ")}`
    : "";
  // Free bars: a rule on coarser bars says so first (ct-pattern-1 packages on 5/15/60-minute data keep their text).
  const bar = spec.engine !== CT_ENGINE_V1 && spec.minutes > 1 ? `[${spec.minutes}분봉 규칙 · 모든 봉 수는 ${spec.minutes}분봉 기준]\n` : "";
  return (
    bar +
    spec.stages
      .map(
        (stage, i) =>
          `${i + 1}. ${stage.label}: ${stage.conditions.map(ctConditionText).join(" AND ")}; 이전 단계 후 ${stage.maxGapBars}봉 이내`,
      )
      .join("\n") +
    `\n다음 봉 진입 · ${ctExitText(spec.exit)}` +
    (spec.engine === CT_ENGINE_V1 ? "" : ` · 당일 경계(${spec.market === "stock" ? "정규장 종료" : "UTC 00:00"}) 강제 청산${spec.entry.noEntryBeforeDayEndMinutes ? ` · 경계 ${spec.entry.noEntryBeforeDayEndMinutes}분 전부터 신규 진입 없음` : ""}`) +
    windows
  );
}
/**
 * How many things a candidate tunes: conditions plus every number in the exit, the entry windows
 * and the ATR settings. Information for the designer and reviewers (a rule with many free numbers
 * fits noise more easily); no gate reads it.
 */
export function ctFreedom(spec: CTSpec) {
  const conditions = spec.stages.reduce((n, s) => n + s.conditions.length, 0);
  let exit: number;
  if (!ctIsManagedExit(spec.exit)) exit = 3 + (spec.exit.invalidation === "last_stage_low" ? 1 : 0);
  else {
    const e = spec.exit;
    exit =
      1 +
      (e.target ? 1 : 0) +
      (e.breakeven ? 1 + (e.breakeven.offsetPct ? 1 : 0) : 0) +
      (e.trail ? (e.trail.type === "swing_low" ? 1 : 2) : 0) +
      (e.timeStop ? 2 : 0) +
      (e.atr && (e.atr.timeframe !== 1 || e.atr.lookback !== CT_ATR_DEFAULT_LOOKBACK) ? 1 : 0) +
      1;
  }
  const other =
    (spec.entry.entryWindows?.length ?? 0) * 2 +
    (spec.entry.noEntryBeforeDayEndMinutes ? 1 : 0) +
    spec.stages.reduce((n, s) => n + s.conditions.reduce((m, c) => m + (c.unit === "atr" ? 1 : 0) + (c.atrLookback !== undefined && c.atrLookback !== CT_ATR_DEFAULT_LOOKBACK ? 1 : 0) + (c.atrTimeframe !== undefined && c.atrTimeframe !== c.timeframe ? 1 : 0), 0), 0);
  return { conditions, exit, other, total: conditions + exit + other };
}
/**
 * The identity of a hypothesis test for the multiple-testing ledger: which features, timeframes,
 * directions and units the stages combine, and whether an entry-time window is used. Thresholds,
 * lookbacks, offsets, gaps and exit numbers are tuning of the same hypothesis and share one signature.
 */
/** The ledger key of a condition structure. A bar other than one minute is a different test (prefix "b15:"); one-minute keys are unchanged. */
export function ctTestSignature(stages: Array<{ conditions: CTCondition[] }>, hasWindows = false, minutes = 1) {
  return (
    (minutes > 1 ? `b${minutes}:` : "") +
    stages
      .map((s) => [...new Set(s.conditions.map((c) => `${c.feature}|${c.timeframe}|${c.op}|${c.unit ?? "pct"}`))].sort().join("&"))
      .join(">") + (hasWindows ? "|W" : "")
  );
}
