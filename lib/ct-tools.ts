import { z } from "zod";
import { ctCandidateSchema, ctSubmissionSchema, type CTResearch } from "./ct-research.ts";
import { ctQuerySchema, ctReadBarsSchema } from "./ct-design-tools.ts";
import {
  ctContrastMovesSchema,
  ctDiagnoseTradesSchema,
  ctGradeBlindSchema,
  ctGradeBlindSchemaStage3,
  ctLabelMovesSchema,
  ctViewChartsSchema,
  ctViewChartsSchemaStage3,
} from "./ct-trader-tools.ts";
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
        netReturnPct: z.number().finite().nullable(),
        overlaps: z.boolean().optional(),
      }),
    ),
  },
  // Stage 3 trader tools: training split only, server computed, free. Images never travel in a tool
  // output (they are stored in ct_chart_images); outputs stay small and cacheable.
  label_moves: {
    phases: ["design", "reflect"],
    input: z.object({ params: ctLabelMovesSchema, from: time, to: time, dataHash: z.string() }).strict(),
    output: z.object({ labelId: z.string(), events: z.number().int().nonnegative(), positiveMoments: z.number().int().nonnegative() }).passthrough(),
  },
  contrast_moves: {
    phases: ["design", "reflect"],
    input: z.object({ request: ctContrastMovesSchema, params: ctLabelMovesSchema, from: time, to: time, dataHash: z.string() }).strict(),
    output: z.object({ contrastId: z.string(), labelId: z.string(), events: z.number().int().nonnegative() }).passthrough(),
  },
  view_charts: {
    phases: ["design", "reflect"],
    // Stage 4 sizes (blind 16–32) or the stage-3 request (up to 8, also blind): the contract decides which the session accepts.
    input: z.object({ request: z.union([ctViewChartsSchema, ctViewChartsSchemaStage3]), from: time, to: time, dataHash: z.string() }).strict(),
    output: z
      .object({
        charts: z.array(z.object({ n: z.number().int().positive(), chartId: z.string(), symbol: z.string(), at: time, group: z.enum(["positive", "control", "other"]) }).passthrough()),
        blindId: z.string().nullable(),
      })
      .passthrough(),
  },
  grade_blind: {
    phases: ["design", "reflect"],
    input: z.object({ request: z.union([ctGradeBlindSchema, ctGradeBlindSchemaStage3]), from: time, to: time, dataHash: z.string() }).strict(),
    output: z.object({ correct: z.number().int(), total: z.number().int(), accuracyPct: z.number(), pValue: z.number() }).passthrough(),
  },
  diagnose_trades: {
    phases: ["design", "reflect"],
    input: z.object({ request: ctDiagnoseTradesSchema, from: time, to: time, dataHash: z.string() }).strict(),
    output: z.object({ diagnosisId: z.string(), trades: z.number().int().nonnegative() }).passthrough(),
  },
  // Stage 4: frozen at the start of a run (like playbook_summary) so a resume sees the same stable block.
  calibration_summary: {
    phases: ["data"],
    input: z.object({ market: z.enum(["stock", "crypto"]), trainingToMs: time, toMs: time, ownerScope: z.literal(true) }).strict(),
    output: z.object({ note: z.string(), records: z.array(z.unknown()), pooled: z.unknown() }).passthrough(),
  },
  measured_summary: {
    phases: ["data"],
    input: z.object({ market: z.enum(["stock", "crypto"]), symbols: z.array(z.string()), fromMs: time, trainingToMs: time, dataHash: z.string(), ownerScope: z.literal(true) }).strict(),
    output: z.object({ note: z.string(), runs: z.array(z.unknown()) }).passthrough(),
  },
  playbook_summary: {
    phases: ["data"],
    input: z.object({ market: z.enum(["stock", "crypto"]), symbols: z.array(z.string()), trainingToMs: time, toMs: time, ownerScope: z.literal(true) }).strict(),
    output: z.object({ entries: z.array(z.unknown()), cumulativeTests: z.number().int().nonnegative(), priorRuns: z.number().int().nonnegative(), omitted: z.number().int().nonnegative() }).passthrough(),
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
  if (
    name === "label_moves" ||
    name === "contrast_moves" ||
    name === "view_charts" ||
    name === "grade_blind" ||
    name === "diagnose_trades"
  ) {
    const data = value as { from: number; to: number; dataHash: string };
    if (data.dataHash !== ct.dataHash || !training(data.from, data.to))
      throw new Error("CT 설계 도구는 학습 구간만 허용");
  }
  if (name === "contrast_moves") {
    const data = value as z.infer<typeof CT_TOOLS.contrast_moves.input>;
    if (!ct.labels?.[data.request.labelId]) throw new Error("알 수 없는 labelId: label_moves를 먼저 호출하세요");
  }
  if (name === "view_charts") {
    const data = value as z.infer<typeof CT_TOOLS.view_charts.input>;
    const issued = new Set([...(ct.anchors ?? []), ...Object.values(ct.chartAnchors ?? {}).map((a) => a.at)]);
    if (data.request.anchors.some((at) => !issued.has(at) || at > ct.contract.trainingToMs))
      throw new Error("CT 차트는 서버가 제공한 학습 구간 시각만 허용");
  }
  if (name === "grade_blind") {
    const data = value as z.infer<typeof CT_TOOLS.grade_blind.input>;
    if (!ct.blinds?.[data.request.blindId]) throw new Error("알 수 없는 blindId");
  }
  if (name === "diagnose_trades") {
    const data = value as z.infer<typeof CT_TOOLS.diagnose_trades.input>;
    const { screenId, candidateId } = data.request;
    if (screenId && !ct.screens?.[screenId]) throw new Error("알 수 없는 screenId: screen_rule 결과의 screenId를 쓰세요");
    if (candidateId && ![...ct.trials.map((t) => t.id), ...(ct.screened ?? []).map((t) => t.id)].includes(candidateId))
      throw new Error("알 수 없는 후보 id");
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
