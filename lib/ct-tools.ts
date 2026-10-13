import { z } from "zod";
import { ctCandidateSchema, ctSubmissionSchema, type CTResearch } from "./ct-research.ts";
import { ctQuerySchema, ctReadBarsSchema } from "./ct-design-tools.ts";
import { ctEngineSchema, ctSpecSchema } from "./ct-spec.ts";
const time = z.number().int().nonnegative();
export const ctBarSchema = z.object({
  startMs: time,
  endMs: time,
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  volume: z.number().nonnegative(),
});
const resultSchema = z
  .object({
    engine: ctEngineSchema,
    status: z.enum(["measured", "no_trades", "data_error"]),
    bars: z.number().int().nonnegative(),
    tradeCount: z.number().int().nonnegative().optional(),
    trades: z.array(
      z
        .object({
          symbol: z.string(),
          entryAt: time,
          exitAt: time,
          entry: z.number().positive(),
          exit: z.number().positive(),
          quantity: z.number().positive(),
          pnl: z.number().finite(),
          fees: z.number().nonnegative(),
          specHash: z.string(),
          signal: z
            .object({
              decidedAt: time,
              validUntil: time,
              stages: z.array(
                z
                  .object({ at: time, values: z.array(z.number().finite()) })
                  .passthrough(),
              ),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
    netReturnPct: z.number().finite(),
    maxDrawdownPct: z.number().finite(),
    compliancePct: z.number().min(0).max(100),
  })
  .passthrough();
export const CT_TOOLS = {
  inspect_data: {
    phases: ["data"],
    input: z.object({ contractHash: z.string() }).strict(),
    output: z.object({
      dataHash: z.string(),
      inventory: z.record(
        z.string(),
        z.object({
          bars: z.number(),
          invalid: z.number(),
          duplicate: z.number(),
          gaps: z.number(),
          fromMs: time.nullable(),
          toMs: time.nullable(),
        }),
      ),
    }),
  },
  analyze_training: {
    phases: ["design", "reflect"],
    input: z.object({ from: time, to: time, dataHash: z.string() }).strict(),
    output: z.record(
      z.string(),
      z.object({
        quality: z.object({
          bars: z.number(),
          invalid: z.number(),
          duplicate: z.number(),
          gaps: z.number(),
          fromMs: time.nullable(),
          toMs: time.nullable(),
        }),
        meanRangePct: z.number().finite(),
        meanVolume: z.number().finite(),
        first: z.number().optional(),
        last: z.number().optional(),
      }),
    ),
  },
  // Designer research session tools: training split only, server computed, free.
  cost_hurdle: {
    phases: ["design", "reflect"],
    input: z.object({ from: time, to: time, dataHash: z.string() }).strict(),
    output: z
      .object({
        roundTripCostPct: z.number().finite(),
        meanBarRangePct: z.number().finite(),
        horizons: z.array(z.object({ bars: z.number().int() }).passthrough()),
        conclusion: z.string(),
      })
      .passthrough(),
  },
  query_conditional_returns: {
    phases: ["design", "reflect"],
    input: z.object({ query: ctQuerySchema, from: time, to: time, dataHash: z.string() }).strict(),
    output: z
      .object({
        queryId: z.string(),
        events: z.number().int().nonnegative(),
        uniqueDays: z.number().int().nonnegative(),
        anchors: z.array(z.object({ at: time }).passthrough()),
      })
      .passthrough(),
  },
  read_bars: {
    phases: ["design", "reflect"],
    input: z.object({ request: ctReadBarsSchema, dataHash: z.string() }).strict(),
    output: z.array(
      z.object({ symbol: z.string(), anchor: z.string(), bars: z.number().int().positive().max(481), text: z.string() }).passthrough(),
    ),
  },
  screen_rule: {
    phases: ["design", "reflect"],
    input: z.object({ spec: ctSpecSchema, from: time, to: time, dataHash: z.string() }).strict(),
    output: z
      .object({
        gateReasons: z.array(z.string()),
        passesTrainingGate: z.boolean(),
        training: z.object({ netReturnPct: z.number().finite() }).passthrough(),
      })
      .passthrough(),
  },
  submit_candidates: {
    phases: ["design", "reflect"],
    input: z.object({ session: z.number().int().nonnegative(), submission: ctSubmissionSchema }).strict(),
    output: z.object({
      accepted: z.array(z.string()),
      duplicates: z.number().int().nonnegative(),
      noEdgeReason: z.string().nullable(),
    }),
  },
  collect_market_data: {
    phases: ["data"],
    input: z
      .object({
        market: z.enum(["stock", "crypto"]),
        symbol: z.string(),
        before: time,
        from: time,
        to: time,
      })
      .strict(),
    output: z.array(ctBarSchema),
  },
  allowed_research_memory: {
    phases: ["data"],
    input: z
      .object({
        market: z.enum(["stock", "crypto"]),
        developmentToMs: time,
        ownerScope: z.literal(true),
      })
      .strict(),
    output: z.array(
      z.object({
        id: z.string(),
        market: z.string(),
        dataHash: z.string(),
        developmentToMs: time,
        rules: ctCandidateSchema.shape.spec,
        diagnostics: z.array(z.string()),
        netReturnPct: z.number().finite(),
      }),
    ),
  },
  search_public_approaches: {
    phases: ["sources"],
    input: z
      .object({ queries: z.array(z.string()).max(3), callId: z.string() })
      .strict(),
    output: z.object({
      urls: z.array(z.string().url()).max(6),
      evidence: z.array(z.object({ url: z.string().url(), title: z.string() })),
    }),
  },
  read_public_source: {
    phases: ["read"],
    input: z.object({ url: z.string().url() }).strict(),
    output: z.object({
      id: z.string(),
      url: z.string().url(),
      title: z.string(),
      fetchedAt: z.string(),
      hash: z.string(),
      text: z.string().min(300).max(24000),
      publishedAt: z.string().nullable(),
    }),
  },
  compile_strategy: {
    phases: ["design", "reflect"],
    input: z
      .object({ candidate: ctCandidateSchema, contractHash: z.string() })
      .strict(),
    output: ctCandidateSchema,
  },
  backtest: {
    // design/reflect: training replays from screen_rule only (checked below).
    phases: ["design", "reflect", "experiment", "final"],
    input: z
      .object({
        hash: z.string(),
        kind: z.enum([
          "training",
          "development",
          "development_stress",
          "development_delay",
          "sensitivity_0.9",
          "sensitivity_1.1",
          "final",
          "final_stress",
          "final_delay",
        ]),
        from: time,
        to: time,
        dataHash: z.string(),
        options: z
          .object({
            costMultiplier: z.number().min(1).max(2).optional(),
            delayBars: z.number().int().min(0).max(1).optional(),
            stopScale: z.number().min(0.5).max(2).optional(),
          })
          .strict(),
      })
      .strict(),
    output: resultSchema,
  },
  failure_diagnosis: {
    phases: ["experiment"],
    input: z.object({ trialId: z.string() }).strict(),
    output: z.object({
      reasons: z.array(z.string()),
      blocked: z.record(z.string(), z.number()),
      sensitivity: z.array(
        z.object({
          change: z.string(),
          result: z.object({ netReturnPct: z.number().finite() }).passthrough(),
        }),
      ),
      changes: z.array(z.string()),
      ruleText: z.string(),
    }),
  },
} as const;
export function assertCTTool(name: string, input: unknown, ct: CTResearch) {
  const tool = CT_TOOLS[name as keyof typeof CT_TOOLS];
  if (!tool || !(tool.phases as readonly string[]).includes(ct.phase))
    throw new Error("CT 도구 단계/권한 거부");
  const value = tool.input.parse(input);
  if (name === "backtest") {
    const data = value as z.infer<typeof CT_TOOLS.backtest.input>;
    const final = data.kind.startsWith("final");
    if (
      final !== (ct.phase === "final") ||
      data.to > ct.contract.toMs ||
      data.from < ct.contract.fromMs ||
      data.to <= data.from ||
      (!final && data.to > ct.contract.developmentToMs) ||
      (final &&
        (!ct.finalConsumed || data.from !== ct.contract.developmentToMs))
    )
      throw new Error("CT 최종 데이터 권한 거부");
  }
  if (name === "analyze_training") {
    const data = value as z.infer<typeof CT_TOOLS.analyze_training.input>;
    if (
      data.from !== ct.contract.fromMs ||
      data.to !== ct.contract.trainingToMs ||
      data.dataHash !== ct.dataHash
    )
      throw new Error("CT 분석 학습 범위 거부");
  }
  const training = (from: number, to: number) =>
    from >= ct.contract.fromMs && to <= ct.contract.trainingToMs && to > from;
  if (name === "backtest" && (ct.phase === "design" || ct.phase === "reflect")) {
    const data = value as z.infer<typeof CT_TOOLS.backtest.input>;
    if (data.kind !== "training" || data.from !== ct.contract.fromMs || data.to !== ct.contract.trainingToMs)
      throw new Error("설계 단계 백테스트는 학습 구간만 허용");
  }
  if (name === "cost_hurdle" || name === "query_conditional_returns" || name === "screen_rule") {
    const data = value as { from: number; to: number; dataHash: string };
    if (data.dataHash !== ct.dataHash || !training(data.from, data.to))
      throw new Error("CT 설계 도구는 학습 구간만 허용");
  }
  if (name === "read_bars") {
    const data = value as z.infer<typeof CT_TOOLS.read_bars.input>;
    const bar = ct.contract.minutes * 60_000;
    if (
      data.dataHash !== ct.dataHash ||
      data.request.anchors.some(
        (at) =>
          !(ct.anchors ?? []).includes(at) ||
          !training(at - (data.request.before + 1) * bar, at + (data.request.after + 1) * bar),
      )
    )
      throw new Error("CT 1분봉 열람은 서버가 제공한 학습 구간 시각만 허용");
  }
  if (name === "collect_market_data") {
    const data = value as z.infer<typeof CT_TOOLS.collect_market_data.input>;
    if (
      data.market !== ct.contract.market ||
      !ct.contract.symbols.includes(data.symbol) ||
      data.from !== ct.contract.fromMs ||
      data.to !== ct.contract.toMs ||
      data.before > data.to ||
      data.before < data.from
    )
      throw new Error("CT 수집 계약 범위 거부");
  }
  return tool;
}
