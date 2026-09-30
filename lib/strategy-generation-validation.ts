import {
  runRelay,
  sessionBarsAt,
  type RelayMetrics,
  type RelayResult,
  type SessionBars,
} from "./relay-engine.ts";
import {
  compileStrategy,
  type StrategySpec,
} from "./strategy-generation-spec.ts";

export const VALIDATION_POLICY = {
  minSessions: 150,
  trainFraction: 0.6,
  validationFraction: 0.2,
  minTrainTrades: 20,
  minTestTrades: 10,
  maxDrawdownPct: 12,
  maxWorstDayLossPct: 4,
  minAdherencePct: 95,
  maxMissedSignalPct: 20,
  maxTopDayProfitShare: 0.5,
} as const;
export type EvidenceSlice = {
  from: string;
  to: string;
  metrics: RelayMetrics;
  meanDailyLower95Pct: number | null;
  daily: Array<{ date: string; returnPct: number }>;
  trades: Array<{
    date: string;
    symbol: string | null;
    entryTime: string | null;
    exitTime: string | null;
    pnlUsd: number;
    quantity: number;
    violations: string[];
  }>;
};
export type ValidationEvidence = {
  training: EvidenceSlice;
  validation: EvidenceSlice;
  holdout: EvidenceSlice;
  stress: EvidenceSlice;
  delayed: EvidenceSlice;
  reasons: string[];
  passed: boolean;
  frozenAt: string;
};
/** Newey-West lag-5 standard error accounts for serially correlated daily returns.
 * This is a diagnostic bound, not a guarantee; the independent reviewer also sees every trial. */
export function lowerMean95(values: number[]) {
  const n = values.length;
  if (n < 20 || values.some((v) => !Number.isFinite(v))) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n,
    deviations = values.map((v) => v - mean);
  let variance = deviations.reduce((a, b) => a + b * b, 0) / n;
  for (let lag = 1; lag <= Math.min(5, n - 1); lag++) {
    let covariance = 0;
    for (let i = lag; i < n; i++)
      covariance += deviations[i] * deviations[i - lag];
    variance += (2 * (1 - lag / 6) * covariance) / n;
  }
  return mean - 1.96 * Math.sqrt(Math.max(0, variance) / (n - 1));
}
export function sliceEvidence(r: RelayResult): EvidenceSlice {
  return {
    from: r.from,
    to: r.to,
    metrics: r.metrics,
    meanDailyLower95Pct: lowerMean95(r.days.map((d) => d.returnPct)),
    daily: r.days.map((d) => ({ date: d.date, returnPct: d.returnPct })),
    trades: r.days.flatMap((d) =>
      d.slots
        .filter((s) => s.traded)
        .map((s) => ({
          date: d.date,
          symbol: s.symbol,
          entryTime: s.entryTime,
          exitTime: s.exitTime,
          pnlUsd: s.pnlUsd,
          quantity: s.quantity,
          violations: s.violations,
        })),
    ),
  };
}
export function splitSessions(sessions: SessionBars[]) {
  if (sessions.length < VALIDATION_POLICY.minSessions)
    throw new Error(
      `최소 ${VALIDATION_POLICY.minSessions}개 거래 세션 필요 (현재 ${sessions.length})`,
    );
  const a = Math.floor(sessions.length * VALIDATION_POLICY.trainFraction),
    b = a + Math.floor(sessions.length * VALIDATION_POLICY.validationFraction);
  return {
    train: sessions.slice(0, a),
    validation: sessions.slice(a, b),
    holdout: sessions.slice(b),
  };
}
/** Gates are code-owned. An agent cannot alter them or turn a failed metric into approval. */
export function evidenceProblems(
  e: Pick<
    ValidationEvidence,
    "training" | "validation" | "holdout" | "stress" | "delayed"
  >,
): string[] {
  const reasons: string[] = [];
  for (const [label, part, minTrades] of [
    ["학습", e.training, 20],
    ["검증", e.validation, 10],
    ["최종 미사용", e.holdout, 10],
    ["비용 2배", e.stress, 10],
  ] as const) {
    const m = part.metrics;
    if (
      part.trades.some((t) => t.violations.some((v) => v.includes("검증 불가")))
    )
      reasons.push(`${label}: 보유·청산 구간 데이터 누락`);
    if (m.totalTrades < minTrades)
      reasons.push(`${label}: 거래 표본 부족 (${m.totalTrades}/${minTrades})`);
    if (
      !(m.meanDailyPct !== null && m.meanDailyPct > 0) ||
      !(m.totalReturnPct !== null && m.totalReturnPct > 0)
    )
      reasons.push(`${label}: 비용 차감 후 양의 수익 미확인`);
    if (
      m.maxDrawdownPct === null ||
      m.maxDrawdownPct > VALIDATION_POLICY.maxDrawdownPct
    )
      reasons.push(`${label}: 최대 낙폭 한도 초과`);
    if (
      m.worstDayPct === null ||
      m.worstDayPct < -VALIDATION_POLICY.maxWorstDayLossPct
    )
      reasons.push(`${label}: 최악 일손실 한도 초과`);
    if (
      m.adherencePct === null ||
      m.adherencePct < VALIDATION_POLICY.minAdherencePct
    )
      reasons.push(`${label}: 규칙 준수율 미달`);
    if (
      m.signals &&
      (m.missedSignals / m.signals) * 100 > VALIDATION_POLICY.maxMissedSignalPct
    )
      reasons.push(`${label}: 미체결 신호 과다`);
    const gains = part.daily.map((d) => Math.max(0, d.returnPct)),
      sum = gains.reduce((a, b) => a + b, 0);
    if (
      sum > 0 &&
      Math.max(...gains) / sum > VALIDATION_POLICY.maxTopDayProfitShare
    )
      reasons.push(`${label}: 하루 수익에 지나친 의존`);
  }
  if (
    e.delayed.metrics.totalTrades < 5 ||
    (e.delayed.metrics.totalReturnPct ?? -Infinity) <= 0
  )
    reasons.push("전략 봉 1개 지연 스트레스에서 엣지 유지 실패");
  // Fixed two chronological halves prevent one lucky regime masking a losing half.
  for (const part of [e.validation, e.holdout]) {
    const midpoint = Math.floor(part.daily.length / 2);
    for (const half of [
      part.daily.slice(0, midpoint),
      part.daily.slice(midpoint),
    ])
      if (half.reduce((a, b) => a + b.returnPct, 0) <= 0)
        reasons.push(`${part.from}–${part.to}: 순차 하위 구간 수익 미달`);
  }
  if (
    e.holdout.meanDailyLower95Pct === null ||
    e.holdout.meanDailyLower95Pct <= 0
  )
    reasons.push(
      "최종 미사용 구간: 일평균 수익의 자기상관 보정 95% 하한이 0 이하",
    );
  return [...new Set(reasons)];
}
export function validateFrozen(
  spec: StrategySpec,
  sessions: SessionBars[],
  capitalUsd: number,
  training: EvidenceSlice,
  frozenAt: string,
  preparedSplit?: ReturnType<typeof splitSessions>,
): ValidationEvidence {
  const split = preparedSplit ?? splitSessions(sessions),
    strategy = compileStrategy(spec);
  const evidence = {
    training,
    validation: sliceEvidence(
      runRelay([strategy], split.validation, { capitalUsd }),
    ),
    holdout: sliceEvidence(runRelay([strategy], split.holdout, { capitalUsd })),
    stress: sliceEvidence(
      runRelay([strategy], split.holdout, { capitalUsd, costMultiplier: 2 }),
    ),
    delayed: sliceEvidence(
      runRelay([strategy], split.holdout, { capitalUsd, entryDelayBars: 1 }),
    ),
  };
  const reasons = evidenceProblems(evidence);
  return { ...evidence, reasons, passed: !reasons.length, frozenAt };
}

/** Fail closed on malformed prices, duplicated times, thin coverage and missing symbols. */
export function auditDataset(
  sessions: SessionBars[],
  symbols: string[],
  slot: { from: string; to: string },
  step: 1 | 3 | 5 = 5,
) {
  const issues: string[] = [];
  const times = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  const expected = Math.floor((times(slot.to) - times(slot.from)) / step);
  for (const symbol of symbols) {
    let covered = 0;
    for (const day of sessions) {
      const bars = sessionBarsAt(day, step)[symbol] ?? [],
        seen = new Set<string>();
      for (const b of bars) {
        if (
          seen.has(b.time) ||
          b.date !== day.date ||
          times(b.time) % step !== 0 ||
          ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
          b.low <= 0 ||
          b.volume < 0 ||
          b.high < Math.max(b.open, b.close, b.low) ||
          b.low > Math.min(b.open, b.close)
        )
          throw new Error(`${symbol} ${day.date} 데이터 무결성 오류`);
        seen.add(b.time);
      }
      const window = bars.filter(
        (b) => b.time >= slot.from && b.time < slot.to,
      );
      if (window.length >= Math.floor(expected * 0.9)) covered++;
    }
    if (covered < sessions.length * 0.9)
      issues.push(
        `${symbol}: 슬롯 봉 90% 이상 확보한 세션 ${covered}/${sessions.length}`,
      );
  }
  return issues;
}
