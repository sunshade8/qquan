/**
 * The gates a 급등주 rule has to clear before it is allowed to exist.
 *
 * These thresholds are code, not prompt. A model may argue with them in its
 * review text and it changes nothing: `surgeEvidenceProblems` is the only
 * function the publisher consults, and a non-empty list is a refusal.
 *
 * Two of them are specific to this feature and are the reason it exists:
 *
 * - **Expectancy in R must be positive on every measured block**, including the
 *   block replayed at twice the modelled cost. Percentage return can be carried
 *   by one lucky day; mean R cannot, and it is stated in the same unit the
 *   rule's 손익비 is set in.
 * - **The holdout's autocorrelation-corrected 95% lower bound on mean R must
 *   also be positive.** "Profitable on the sample" and "edge established" are
 *   different claims and only the second is worth trading.
 */

import type { SurgeDay, SurgeExpectancy, SurgeOutcome, SurgeResult, SurgeSession } from "./surge-engine.ts";
import { runSurge } from "./surge-engine.ts";
import { compileSurgeStrategy, type SurgeSpec } from "./surge-spec.ts";
import type { RelayMetrics } from "./relay-engine.ts";
import { lowerMean95 } from "./strategy-generation-validation.ts";

export const SURGE_POLICY = {
  minSessions: 120,
  trainFraction: 0.6,
  validationFraction: 0.2,
  minTrainTrades: 25,
  minTestTrades: 12,
  maxDrawdownPct: 25,
  maxWorstDayLossPct: 8,
  minAdherencePct: 95,
  /** Surge names cap out on the 1% participation limit far more often than large caps. */
  maxMissedSignalPct: 40,
  maxTopDayProfitShare: 0.4,
  /** Mean R per trade. 0.05R is a thin but real edge; anything at or below zero is not one. */
  minExpectancyR: 0.05,
  capitalUsd: 1000,
} as const;

export type SurgeEvidenceSlice = {
  from: string;
  to: string;
  metrics: RelayMetrics;
  expectancy: SurgeExpectancy;
  meanDailyLower95Pct: number | null;
  daily: Array<{ date: string; returnPct: number }>;
  trades: Array<{
    date: string;
    symbol: string | null;
    rank: number | null;
    eventChangePct: number | null;
    observedAt: string | null;
    entryTime: string | null;
    exitTime: string | null;
    exit: SurgeOutcome["exit"];
    rMultiple: number | null;
    pnlUsd: number;
    quantity: number;
    violations: string[];
  }>;
};

export type SurgeEvidence = {
  training: SurgeEvidenceSlice;
  validation: SurgeEvidenceSlice;
  holdout: SurgeEvidenceSlice;
  stress: SurgeEvidenceSlice;
  delayed: SurgeEvidenceSlice;
  reasons: string[];
  passed: boolean;
  frozenAt: string;
};

export function surgeSlice(result: SurgeResult): SurgeEvidenceSlice {
  return {
    from: result.from,
    to: result.to,
    metrics: result.metrics,
    expectancy: result.expectancy,
    meanDailyLower95Pct: lowerMean95(result.days.map((day) => day.returnPct)),
    daily: result.days.map((day) => ({ date: day.date, returnPct: day.returnPct })),
    trades: result.days.flatMap((day: SurgeDay) =>
      day.slots.filter((slot) => slot.traded).map((slot) => ({
        date: day.date,
        symbol: slot.symbol,
        rank: slot.rank,
        eventChangePct: slot.eventChangePct,
        observedAt: slot.observedAt,
        entryTime: slot.entryTime,
        exitTime: slot.exitTime,
        exit: slot.exit,
        rMultiple: slot.rMultiple,
        pnlUsd: slot.pnlUsd,
        quantity: slot.quantity,
        violations: slot.violations,
      }))),
  };
}

/**
 * Chronological 60/20/20 split. It works on dates as well as sessions, so the
 * pipeline can load only the block a stage needs — the designer's survey never
 * loads validation or holdout days at all.
 */
export function splitSurgeSessions<T>(sessions: T[]) {
  if (sessions.length < SURGE_POLICY.minSessions) {
    throw new Error(`최소 ${SURGE_POLICY.minSessions}개 거래 세션 필요 (현재 ${sessions.length})`);
  }
  const trainEnd = Math.floor(sessions.length * SURGE_POLICY.trainFraction);
  const validationEnd = trainEnd + Math.floor(sessions.length * SURGE_POLICY.validationFraction);
  return {
    train: sessions.slice(0, trainEnd),
    validation: sessions.slice(trainEnd, validationEnd),
    holdout: sessions.slice(validationEnd),
  };
}

export function surgeEvidenceProblems(
  evidence: Pick<SurgeEvidence, "training" | "validation" | "holdout" | "stress" | "delayed">,
): string[] {
  const reasons: string[] = [];
  const blocks = [
    ["학습", evidence.training, SURGE_POLICY.minTrainTrades],
    ["검증", evidence.validation, SURGE_POLICY.minTestTrades],
    ["최종 미사용", evidence.holdout, SURGE_POLICY.minTestTrades],
    ["비용 2배", evidence.stress, SURGE_POLICY.minTestTrades],
  ] as const;

  for (const [label, part, minTrades] of blocks) {
    const metrics = part.metrics;
    if (part.trades.some((trade) => trade.violations.some((violation) => violation.includes("검증 불가")))) {
      reasons.push(`${label}: 보유·청산 구간 데이터 누락`);
    }
    if (metrics.totalTrades < minTrades) {
      reasons.push(`${label}: 거래 표본 부족 (${metrics.totalTrades}/${minTrades})`);
    }
    if (!(part.expectancy.expectancyR !== null && part.expectancy.expectancyR >= SURGE_POLICY.minExpectancyR)) {
      reasons.push(`${label}: 비용 차감 후 기대값 ${part.expectancy.expectancyR ?? "—"}R — ${SURGE_POLICY.minExpectancyR}R 미만`);
    }
    if (!(metrics.meanDailyPct !== null && metrics.meanDailyPct > 0) ||
        !(metrics.totalReturnPct !== null && metrics.totalReturnPct > 0)) {
      reasons.push(`${label}: 비용 차감 후 양의 수익 미확인`);
    }
    if (metrics.maxDrawdownPct === null || metrics.maxDrawdownPct > SURGE_POLICY.maxDrawdownPct) {
      reasons.push(`${label}: 최대 낙폭 한도(${SURGE_POLICY.maxDrawdownPct}%) 초과`);
    }
    if (metrics.worstDayPct === null || metrics.worstDayPct < -SURGE_POLICY.maxWorstDayLossPct) {
      reasons.push(`${label}: 최악 일손실 한도(${SURGE_POLICY.maxWorstDayLossPct}%) 초과`);
    }
    if (metrics.adherencePct === null || metrics.adherencePct < SURGE_POLICY.minAdherencePct) {
      reasons.push(`${label}: 규칙 준수율 미달`);
    }
    if (metrics.signals && (metrics.missedSignals / metrics.signals) * 100 > SURGE_POLICY.maxMissedSignalPct) {
      reasons.push(`${label}: 미체결 신호 과다 (${metrics.missedSignals}/${metrics.signals})`);
    }
    const gains = part.daily.map((day) => Math.max(0, day.returnPct));
    const sum = gains.reduce((a, b) => a + b, 0);
    if (sum > 0 && Math.max(...gains) / sum > SURGE_POLICY.maxTopDayProfitShare) {
      reasons.push(`${label}: 하루 수익에 지나친 의존`);
    }
  }

  if (evidence.delayed.metrics.totalTrades < 5 ||
      (evidence.delayed.expectancy.expectancyR ?? -Infinity) <= 0) {
    reasons.push("전략 1봉 지연 스트레스에서 기대값이 0R 이하");
  }
  for (const part of [evidence.validation, evidence.holdout]) {
    const midpoint = Math.floor(part.daily.length / 2);
    for (const half of [part.daily.slice(0, midpoint), part.daily.slice(midpoint)]) {
      if (half.reduce((sum, day) => sum + day.returnPct, 0) <= 0) {
        reasons.push(`${part.from}–${part.to}: 순차 하위 구간 수익 미달`);
      }
    }
  }
  if (evidence.holdout.expectancy.expectancyLower95R === null ||
      evidence.holdout.expectancy.expectancyLower95R <= 0) {
    reasons.push("최종 미사용 구간: 기대값 R의 자기상관 보정 95% 하한이 0 이하 — 엣지 미확립");
  }
  if (evidence.holdout.meanDailyLower95Pct === null || evidence.holdout.meanDailyLower95Pct <= 0) {
    reasons.push("최종 미사용 구간: 일평균 수익의 95% 하한이 0 이하");
  }
  return [...new Set(reasons)];
}

export function validateFrozenSurge(
  spec: SurgeSpec,
  split: { validation: SurgeSession[]; holdout: SurgeSession[] },
  capitalUsd: number,
  training: SurgeEvidenceSlice,
  frozenAt: string,
  onProgress: (message: string) => void = () => undefined,
): SurgeEvidence {
  const strategy = compileSurgeStrategy(spec);
  const replay = (label: string, sessions: SurgeSession[], options: { costMultiplier?: number; entryDelayBars?: number } = {}) => {
    onProgress(`${label} · ${sessions.length}개 세션 백테스트 시작`);
    const result = surgeSlice(runSurge(strategy, sessions, { capitalUsd, ...options }));
    onProgress(`${label} 계산 완료 · 거래 ${result.metrics.totalTrades}건`);
    return result;
  };
  const evidence = {
    training,
    validation: replay("검증 구간", split.validation),
    holdout: replay("최종 미사용 구간", split.holdout),
    stress: replay("거래비용 2배", split.holdout, { costMultiplier: 2 }),
    delayed: replay("진입 1봉 지연", split.holdout, { entryDelayBars: 1 }),
  };
  const reasons = surgeEvidenceProblems(evidence);
  return { ...evidence, reasons, passed: !reasons.length, frozenAt };
}

/** Fail closed on malformed bars and on days whose pool has no usable data at all. */
export function auditSurgeSessions(sessions: SurgeSession[]) {
  const issues: string[] = [];
  let covered = 0;
  const eventSessions = sessions.filter(session => session.candidates.length > 0);
  for (const session of eventSessions) {
    let usable = 0;
    for (const candidate of session.candidates) {
      const bars = session.bars[candidate.symbol] ?? [];
      const seen = new Set<string>();
      for (const bar of bars) {
        if (seen.has(bar.time) ||
            bar.date !== session.date ||
            ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
            bar.low <= 0 || bar.volume < 0 ||
            bar.high < Math.max(bar.open, bar.close, bar.low) ||
            bar.low > Math.min(bar.open, bar.close)) {
          throw new Error(`${candidate.symbol} ${session.date} 데이터 무결성 오류`);
        }
        seen.add(bar.time);
      }
      if (bars.length >= 2) usable += 1;
    }
    if (usable >= 1) covered += 1;
  }
  if (covered < eventSessions.length * 0.8) {
    issues.push(`분봉을 확보한 세션 ${covered}/${eventSessions.length} — 80% 미만`);
  }
  return issues;
}
