/** The in-app agent designs batches. It never receives final-period outcomes. */
import { z } from "zod";
import { candidateSchema, EXECUTION_LIMITS, type Candidate } from "./strategy-generation-spec.ts";
import { FAMILIES, makeCandidate, type Family, type SlotResearch, type Trial } from "./slot-research.ts";
import { slotById } from "./trade-slots.ts";
import type { GenerationJob } from "./strategy-generation-types.ts";
import type { SessionBars } from "./relay-engine.ts";

export const designBatchSchema = z.object({
  summary: z.string().min(20).max(1600),
  designs: z.array(z.object({
    family: z.enum(FAMILIES),
    mechanism: z.string().min(20).max(1200),
    change: z.string().min(10).max(1000),
    candidate: candidateSchema,
  }).strict()).length(4),
}).strict();
export type DesignBatch = z.infer<typeof designBatchSchema>;
export type AgentDesign = DesignBatch & {
  inputHash: string;
  outputHash: string;
  basedOnTrialIds: string[];
  createdAt: string;
};
export type ResearchAgent = {
  mode: "agent" | "local";
  maxDesignBatches: number;
  batches: AgentDesign[];
};

// Explicit allowlist: never serialize job/search/manifest wholesale into a design call.
export function designContext(job: GenerationJob, sessions: SessionBars[]) {
  const search = job.search!, manifest = search.manifest!;
  const training = sessions.filter(s => s.date <= manifest.trainingTo);
  const quantile = (a: number[], q: number) => {
    const ordered = a.filter(Number.isFinite).sort((a, b) => a - b);
    return ordered.length ? ordered[Math.floor((ordered.length - 1) * q)] : null;
  };
  return {
    brief: job.brief,
    target: search.target,
    targetDefinition: "Arithmetic mean net return / each valid session's starting slot capital; includes zero-return nontrading sessions, excludes separately reported missing sessions. Never sum slot returns into account performance.",
    capitalUsd: job.capitalUsd,
    symbols: job.universe,
    nativeMinutes: manifest.sourceMinutes,
    costs: manifest.costs,
    limits: EXECUTION_LIMITS,
    searchLimits: search.config,
    selectionWarning: "Development is repeatedly selected; not independent validation. Final data is sealed.",
    trainingTo: manifest.trainingTo,
    developmentTo: manifest.developmentTo,
    slots: search.slots.map(id => {
      const slot = slotById(id)!, coverage = manifest.coverage.find(c => c.slot === id)!;
      return {
        id, from: slot.from, to: slot.to,
        trainingSessions: coverage.validDates.filter(d => d <= manifest.trainingTo).length,
        developmentSessions: coverage.validDates.filter(d => d > manifest.trainingTo && d <= manifest.developmentTo).length,
        excludedDevelopmentSessions: coverage.excluded.filter(d => d.date > manifest.trainingTo && d.date <= manifest.developmentTo).length,
        market: job.universe!.map(symbol => {
          const bars = training.flatMap(d => (d.bars[symbol] ?? []).filter(b => b.time >= slot.from && b.time < slot.to));
          return { symbol, observations: bars.length,
            medianPrice: quantile(bars.map(b => b.close), 0.5),
            lowerDollarVolume: quantile(bars.map(b => b.close * b.volume), 0.1),
            medianRangePct: quantile(bars.map(b => 100 * (b.high - b.low) / b.close), 0.5) };
        }),
        families: FAMILIES.map(family => {
          const trials = search.trials.filter(t => t.slot === id && t.family === family);
          const last = trials.at(-1);
          // Bounded measured diagnostics, no raw candles and no final summaries.
          return { family, attempts: trials.length, currentRule: last && executableRule(last.spec.candidate), trials: trials.slice(-2).map(t => ({
            id: t.id, status: t.status, failure: t.failure,
            reasons: t.reasons.slice(0, 4).map(r => r.slice(0, 160)),
            counters: Object.fromEntries(Object.entries(t.diagnostics ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5)), improvementPct: t.deltaPct,
            train: t.train && { meanDailyPct: t.train.metrics.meanDailyPct, trades: t.train.metrics.totalTrades },
            development: t.development && {
              meanDailyPct: t.development.metrics.meanDailyPct,
              targetGapRangePct: [Math.min(...t.development.targets.map(t => t.gapPct ?? 0)), Math.max(...t.development.targets.map(t => t.gapPct ?? 0))],
              trades: t.development.metrics.totalTrades, fireRatePct: t.development.fireRatePct,
              maxDrawdownPct: t.development.metrics.maxDrawdownPct,
              costUsd: t.development.metrics.costPaidUsd, grossPnlUsd: t.development.grossPnlUsd,
              halves: t.development.halves, topProfitShare: t.development.topProfitShare,
              selectionLowerPct: t.development.selectionLowerPct,
            },
          })) };
        }),
      };
    }),
  };
}

export function designPrompt(context: ReturnType<typeof designContext>, revision: boolean) {
  return `SLOT_AGENT_BATCH: ${revision ? "Revise executable families from the measured development failures" : "Design four executable strategy families from training-only market diagnostics and the user's brief"}.
Return exactly one seed for each family: breakout (continuation), recovery (failed move recovery), reversion (mean reversion), compression (range contraction then expansion). State the distinct causal mechanism; parameter tweaks are variants, not new hypotheses. One batch will generate many deterministic experiments across the requested slots.
Respect the user's brief; state unsupported requests instead of claiming to implement them. Each seed must use the exact nativeMinutes bar interval. No invented data, profit, lower cost, relaxed validation, new dates, universe expansion, short sales or live orders.
All conditions AND. Feature lookback uses last lookback+1 consecutive completed same-day bars, including earlier slots. returnPct compares first and last close; relativeVolume compares latest with prior mean; breakoutPct compares latest close with prior highs; rangePosition is 0..1; rangePct is high-low/close percent; VWAP uses typical price weighted volume. minMinutesAfterOpen is after SLOT start. Leave at least two bars before the shortest slot ends. Ranking selects one eligible symbol. Entry is next bar open; stop-first if stop/target touch together; mandatory slot-end exit. Integer sizing is fixed by cash 99%, fees and 1% participation. Do not invent sizing controls.
On revision use measured blocked conditions for low activity, turnover/holding/volatility versus cost for cost drag, chronological halves for regime dependence, concentration and neighboring conditions for fragile gains. Do not tune on final results. Preserve safety gates. State actual rule changes and which observed failures motivated them. These hypotheses may fail; reaching the target and passing validation are separate.
Context: ${JSON.stringify(context)}`;
}

export function validateDesignBatch(value: unknown, minutes: number, slots: SlotResearch["slots"]): DesignBatch {
  const batch = designBatchSchema.parse(value);
  if (new Set(batch.designs.map(d => d.family)).size !== FAMILIES.length)
    throw new Error("설계 배치에 서로 다른 네 계열이 필요합니다.");
  const shortest = Math.min(...slots.map(id => {
    const slot = slotById(id)!;
    const m = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
    return m(slot.to) - m(slot.from);
  }));
  for (const design of batch.designs) {
    if (design.candidate.barInterval !== `${minutes}m`)
      throw new Error("설계 봉 주기와 동결 원본 주기가 다릅니다.");
    if (design.candidate.minMinutesAfterOpen + 2 * minutes >= shortest)
      throw new Error("설계 진입 시각이 대상 슬롯에서 실행 불가능합니다.");
  }
  return batch;
}

/** Agent rounds 0/2/... are new batch seeds; 1/3/... are measured local revisions. */
export function agentCandidate(search: SlotResearch, family: Family, round: number, parent?: Trial) {
  const batchIndex = Math.floor(round / 2);
  const batch = search.agent?.mode === "agent" ? search.agent.batches[batchIndex] : undefined;
  if (!batch) return makeCandidate(family, round, parent);
  const design = batch.designs.find(d => d.family === family)!;
  if (round % 2 === 0) return {
    candidate: structuredClone(design.candidate),
    change: `에이전트 배치 ${batchIndex + 1}: ${design.change}`,
    designHash: batch.outputHash,
  };
  const result = makeCandidate(family, round, parent, design.candidate);
  return { ...result, designHash: batch.outputHash };
}

export function executableRule(candidate: Candidate) {
  return Object.fromEntries(Object.entries(candidate).filter(([key]) => !["name", "hypothesis", "cautions"].includes(key)));
}
