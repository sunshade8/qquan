/** Deterministic, bounded development search. No test outcome enters propose(). */
import {
  candidateSchema,
  compileStrategy,
  featureValue,
  EXECUTION_LIMITS,
  type Candidate,
  type StrategySpec,
} from "./strategy-generation-spec.ts";
import {
  runRelay,
  type SessionBars,
  type RelayResult,
  type SlotStrategy,
} from "./relay-engine.ts";
import {
  lowerMean95,
  sliceEvidence,
  evidenceProblems,
  VALIDATION_POLICY,
  type ValidationEvidence,
} from "./strategy-generation-validation.ts";
import { slotTargetGrid, slotTarget } from "./relay-targets.ts";
import { SLOTS, slotById, type SlotId } from "./trade-slots.ts";
import { costPerSidePct } from "./symbol-liquidity.ts";
import { TOSS_US_EQUITY } from "./broker-costs.ts";
import { shiftDate } from "./market-clock.ts";
import type { ResearchAgent } from "./slot-research-agent.ts";

export const SEARCH_VERSION = "slot-search-2/agent-batches-2026-10-02";
export const FAMILIES = [
  "breakout",
  "recovery",
  "reversion",
  "compression",
] as const;
export type Family = (typeof FAMILIES)[number];
export const SEARCH_DEFAULTS = {
  minPerSlot: 8,
  maxPerSlot: 16,
  maxBacktests: 400,
  maxComputeMs: 600_000,
  stagnationTrials: 8,
  improvementPct: 0.005,
  reserveFraction: 0.35,
};
export type SearchConfig = typeof SEARCH_DEFAULTS;
export type TargetSelection = { dailyTargetPct: number; slots: number } | null;
export type Failure =
  | "no_trades"
  | "cost_drag"
  | "regime"
  | "concentration"
  | "execution"
  | "no_edge"
  | "promising";
export type Trial = {
  id: string;
  hash: string;
  slot: SlotId;
  family: Family;
  parentId?: string;
  change: string;
  spec: StrategySpec;
  status: "measured" | "data_error" | "execution_error" | "budget_exhausted";
  reasons: string[];
  failure: Failure;
  train?: Summary;
  development?: Summary;
  diagnostics?: Record<string, number>;
  deltaPct: number | null;
  eligible: boolean;
  artifact: string;
  designHash?: string;
};
export type Summary = {
  from: string;
  to: string;
  metrics: RelayResult["metrics"];
  fireRatePct: number | null;
  conditionalMeanPct: number | null;
  lower95Pct: number | null;
  selectionLowerPct: number | null;
  halves: number[];
  topProfitShare: number | null;
  grossPnlUsd: number;
  meanHoldMinutes: number | null;
  targets: Array<{
    dailyTargetPct: number;
    slots: number;
    targetPct: number;
    gapPct: number | null;
    reached: boolean | null;
  }>;
};
export type Coverage = {
  slot: SlotId;
  validDates: string[];
  excluded: Array<{ date: string; reason: string }>;
  expected: number;
};
export type SearchManifest = {
  from: string;
  to: string;
  trainingTo: string;
  developmentTo: string;
  holdoutFrom: string;
  dataHash: string;
  source: string;
  sourceMinutes: 1 | 5;
  engine: string;
  symbols: string[];
  dates: string[];
  coverage: Coverage[];
  costs: Record<string, number>;
  exposure: "unknown" | "previously_seen";
  exposureRuns: string[];
  provenance: string[];
  acquisitionWarnings?: string[];
  createdAt: string;
};
export type SlotResearch = {
  version: 1;
  phase: "data" | "design" | "reflect" | "search" | "freeze" | "review" | "final" | "done" | "blocked";
  agent?: ResearchAgent;
  evaluation?: "unmeasured" | "partial" | "measured";
  designStopReason?: string;
  slots: SlotId[];
  target: TargetSelection;
  config: SearchConfig;
  manifest?: SearchManifest;
  trials: Trial[];
  backtests: number;
  computeMs: number;
  cacheHits: number;
  selected: Record<string, string>;
  frozenHash?: string;
  frozenAt?: string;
  endReason?: string;
  final: Record<
    string,
    {
      summary: Summary;
      reasons: string[];
      passed: boolean;
      artifact: string;
      evidence?: ValidationEvidence;
    }
  >;
  review?: {
    approved: boolean;
    summary: string;
    blockers: string[];
    cautions: string[];
  };
  finalReview?: {
    approved: boolean;
    summary: string;
    blockers: string[];
    cautions: string[];
  };
  combined?: Summary;
  combinedArtifact?: string;
};
export const minuteOf = (s: string) =>
  Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
export async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function boundaries(from: string, to: string) {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  return {
    from,
    to,
    trainingTo: shiftDate(from, Math.floor(n * 0.6) - 1),
    developmentTo: shiftDate(from, Math.floor(n * 0.8) - 1),
    holdoutFrom: shiftDate(from, Math.floor(n * 0.8)),
  };
}
/** No interpolation. Every expected bar, including the liquidation bar, must exist.
 * Missing observations are reported, never converted into zero-return sessions. */
export function coverageFor(
  sessions: SessionBars[],
  symbols: string[],
  slotId: SlotId,
  step: 1 | 5,
  dates: string[],
): Coverage {
  const slot = slotById(slotId)!;
  const byDate = new Map(sessions.map((day) => [day.date, day]));
  const validDates: string[] = [],
    excluded: Coverage["excluded"] = [];
  for (const date of dates) {
    const day = byDate.get(date);
    let reason = "";
    for (const symbol of symbols) {
      const bars = day?.bars[symbol] ?? [];
      const window = bars.filter(
        (b) => b.time >= slot.from && b.time < slot.to,
      );
      if (window.some((b, i) => i > 0 && b.time <= window[i - 1].time)) {
        reason = `${symbol}: 원본 봉 순서/중복 오류`;
        break;
      }
      const unique = new Map(window.map((b) => [b.time, b]));
      if (unique.size !== window.length) {
        reason = `${symbol}: 중복 봉`;
        break;
      }
      for (let m = minuteOf(slot.from); m < minuteOf(slot.to); m += step) {
        const time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        const b = unique.get(time);
        if (
          !b ||
          b.date !== date ||
          ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
          b.volume <= 0 ||
          b.low <= 0 ||
          b.high < Math.max(b.open, b.close, b.low) ||
          b.low > Math.min(b.open, b.close)
        ) {
          reason = `${symbol}: ${time} 누락/품질 불명 (휴장·단축장·무체결 구분 불명)`;
          break;
        }
      }
      if (reason) break;
    }
    if (reason) excluded.push({ date, reason });
    else validDates.push(date);
  }
  return { slot: slotId, validDates, excluded, expected: dates.length };
}
export function targetsFor(mean: number | null, target: TargetSelection) {
  const options = target
    ? [
        {
          ...target,
          perSessionNetPct: slotTarget(
            { ...target, symbol: "SPY", fireRate: 1, rewardRisk: 1 },
            1,
          ).perSessionNetPct,
        },
      ]
    : slotTargetGrid({ symbol: "SPY", stopPct: 1, rewardRisk: 1, fireRate: 1 });
  return options.map((t) => ({
    dailyTargetPct: t.dailyTargetPct,
    slots: t.slots,
    targetPct: t.perSessionNetPct,
    gapPct: mean === null ? null : mean - t.perSessionNetPct,
    reached: mean === null ? null : mean >= t.perSessionNetPct,
  }));
}
export function summarize(
  result: RelayResult,
  target: TargetSelection,
  maxTrials: number,
): Summary {
  const daily = result.days.map((day) => day.returnPct),
    m = result.metrics;
  const lower = lowerMean95(daily),
    mean = m.meanDailyPct;
  // Conservative Bonferroni + sub-Gaussian critical value on the existing HAC SE.
  // Diagnostic only, not a claim of formal independence under adaptive selection.
  const se = lower === null || mean === null ? null : (mean - lower) / 1.96;
  const positive = daily.map((n) => Math.max(0, n)),
    gains = positive.reduce((a, b) => a + b, 0);
  const trades = result.days.flatMap((d) => d.slots.filter((s) => s.traded));
  return {
    from: result.from,
    to: result.to,
    metrics: m,
    fireRatePct: m.sessions ? (m.tradingDays / m.sessions) * 100 : null,
    conditionalMeanPct: m.tradingDays
      ? result.days
          .filter((d) => d.traded)
          .reduce((n, d) => n + d.returnPct, 0) / m.tradingDays
      : null,
    lower95Pct: lower,
    selectionLowerPct:
      se === null || mean === null
        ? null
        : mean - Math.sqrt(2 * Math.log(Math.max(1, maxTrials) / 0.05)) * se,
    halves: [
      daily.slice(0, Math.floor(daily.length / 2)),
      daily.slice(Math.floor(daily.length / 2)),
    ].map((a) => (a.length ? a.reduce((n, v) => n + v, 0) / a.length : 0)),
    topProfitShare: gains ? Math.max(...positive) / gains : null,
    grossPnlUsd: trades.reduce((n, t) => n + t.pnlUsd + t.costUsd, 0),
    meanHoldMinutes: trades.length
      ? trades.reduce(
          (n, t) => n + minuteOf(t.exitTime!) - minuteOf(t.entryTime!),
          0,
        ) / trades.length
      : null,
    targets: targetsFor(mean, target),
  };
}
export function diagnose(train: Summary, dev: Summary): Failure {
  if (train.metrics.totalTrades < 20 || dev.metrics.totalTrades < 10)
    return "no_trades";
  if (
    (dev.metrics.adherencePct ?? 0) < 95 ||
    dev.metrics.missedSignals / Math.max(1, dev.metrics.signals) > 0.2
  )
    return "execution";
  if (dev.grossPnlUsd > 0 && (dev.metrics.meanDailyPct ?? 0) <= 0)
    return "cost_drag";
  if ((dev.topProfitShare ?? 0) > 0.5) return "concentration";
  if (dev.halves.some((n) => n <= 0) && (dev.metrics.meanDailyPct ?? 0) > 0)
    return "regime";
  if (
    (train.metrics.meanDailyPct ?? 0) <= 0 ||
    (dev.metrics.meanDailyPct ?? 0) <= 0
  )
    return "no_edge";
  return "promising";
}
export function developmentProblems(train: Summary, dev: Summary) {
  const reasons: string[] = [];
  for (const [label, s, min] of [
    ["학습", train, 20],
    ["개발", dev, 10],
  ] as const) {
    if (s.metrics.totalTrades < min)
      reasons.push(`${label}: 표본 ${s.metrics.totalTrades}/${min}`);
    if ((s.metrics.meanDailyPct ?? -Infinity) <= 0)
      reasons.push(`${label}: 비용 후 수익 미달`);
    if (
      (s.metrics.maxDrawdownPct ?? Infinity) > 12 ||
      (s.metrics.worstDayPct ?? -Infinity) < -4
    )
      reasons.push(`${label}: 낙폭/손실 한도`);
    if (
      (s.metrics.adherencePct ?? 0) < 95 ||
      s.metrics.missedSignals / Math.max(1, s.metrics.signals) > 0.2
    )
      reasons.push(`${label}: 체결·준수 기준`);
    if ((s.topProfitShare ?? 0) > 0.5) reasons.push(`${label}: 수익 집중`);
  }
  if (dev.halves.some((n) => n <= 0))
    reasons.push("개발: 순차 하위 기간 재현 실패");
  if ((dev.selectionLowerPct ?? -Infinity) <= 0)
    reasons.push("개발: 다중 시도 보정 하한 미달");
  return reasons;
}
const names: Record<Family, string> = {
  breakout: "돌파 지속",
  recovery: "하락 후 회복",
  reversion: "평균회귀",
  compression: "범위 압축 후 상승",
};
export function makeCandidate(
  family: Family,
  round: number,
  parent?: Trial,
  seed?: Candidate,
): { candidate: Candidate; change: string } {
  const c: Candidate = {
    name: `${names[family]} ${round + 1}`,
    hypothesis: `${names[family]} 계열의 완성 OHLCV 조건을 이용한 매수 후 슬롯 종료 청산 가설. 수익성은 검증되지 않았습니다.`,
    barInterval: "5m",
    conditions: [],
    rankBy: "returnPct",
    rankDirection: "desc",
    rankLookback: 3,
    stopPct: 1,
    targetPct: 1.5,
    minMinutesAfterOpen: 5,
    maxSpreadPct: 0.2,
    minBarDollarVolume: 100000,
    cautions: [
      "OHLCV는 호가·체결 가능성의 증거가 아닙니다.",
      "수정주가와 현재 유니버스의 과거 조회: 생존편향 및 과거 노출 독립성 미확인.",
    ],
  };
  const condition = (
    feature: Candidate["conditions"][number]["feature"],
    lookback: number,
    operator: "gte" | "lte",
    value: number,
  ) => ({ feature, lookback, operator, value });
  if (family === "breakout")
    c.conditions = [
      condition("breakoutPct", 3, "gte", 0),
      condition("relativeVolume", 3, "gte", 1.1),
    ];
  if (family === "recovery")
    c.conditions = [
      condition("returnPct", 6, "lte", -0.15),
      condition("returnPct", 2, "gte", 0.05),
    ];
  if (family === "reversion") {
    c.conditions = [
      condition("vwapDistancePct", 6, "lte", -0.15),
      condition("rangePosition", 6, "lte", 0.3),
    ];
    c.rankDirection = "asc";
  }
  if (family === "compression")
    c.conditions = [
      condition("rangePct", 6, "lte", 0.5),
      condition("returnPct", 2, "gte", 0.05),
    ];
  // Revisions must modify the actual tested parent, including an agent-authored
  // seed, rather than silently resetting it to the built-in template.
  if (seed || parent?.spec?.candidate)
    Object.assign(c, structuredClone(parent?.spec?.candidate ?? seed));
  c.name = `${names[family]} ${round + 1}`;
  let change = "사전 정의한 계열의 기준 규칙";
  if (round > 0) {
    if (parent?.failure === "no_trades") {
      c.conditions = c.conditions.map((x) => ({
        ...x,
        lookback: Math.max(2, x.lookback - 2),
        value:
          // Lower a >= floor, raise a <= ceiling. Multiplying every threshold
          // by 0.5 accidentally tightened positive range caps and volume caps.
          Math.max(x.feature === "rangePosition" ? 0 : -100,
            Math.min(x.feature === "rangePosition" ? 1 : 100,
              x.value + (x.operator === "gte" ? -1 : 1) * Math.max(Math.abs(x.value) * 0.5, 0.02))),
      }));
      change =
        "신호 부족: 연속 봉 준비 길이 축소와 조건 완화 (진단 카운터 비교)";
    } else if (parent?.failure === "cost_drag") {
      c.targetPct = null;
      c.conditions = [...c.conditions.slice(0, 5), condition("rangePct", 6, "gte", 0.4)];
      change = "비용 잠식: 작은 익절 제거, 비용 대비 충분한 변동폭에서만 진입";
    } else if (
      parent?.failure === "regime" ||
      parent?.failure === "concentration"
    ) {
      c.conditions = [...c.conditions.slice(0, 5), condition("relativeVolume", 3, "gte", 1)];
      c.rankBy = "relativeVolume";
      change = "기간/거래 집중: 거래량 확인 조건 추가 및 거래량으로 종목 선택";
    } else {
      c.conditions = [...c.conditions.slice(0, 5), condition("vwapDistancePct", 3, "gte", -0.1)];
      c.targetPct = null;
      change = "순수익 미달: 단기 VWAP 회복 확인 후 슬롯 종료까지 보유";
    }
    if (round >= 2) {
      c.stopPct = 1.5;
      c.rankLookback = 6;
      c.minMinutesAfterOpen = 10;
      change += "; 진입 지연·넓은 손절의 주변 조건 안정성 시험";
    }
    if (round >= 3) {
      c.conditions = c.conditions.map((x) => ({
        ...x,
        lookback: Math.min(12, x.lookback + 2),
      }));
      c.rankDirection = "asc";
      change += "; 느린 관측·후행 종목 비교";
    }
  }
  return { candidate: candidateSchema.parse(c), change };
}
/** Round-robin guarantees four distinct families and one diagnosis-driven revision
 * per slot before discretionary work. Repeated failures lose further allocation. */
export function propose(
  search: SlotResearch,
): { slot: SlotId; family: Family; round: number; parent?: Trial } | null {
  const latestDesign = search.agent?.mode === "agent" && search.agent.batches.length > 1
    ? search.agent.batches.at(-1)!.outputHash : null;
  const newDesignOpportunity = (trials: Trial[]) => !!latestDesign &&
    (!trials.some(t => t.designHash === latestDesign) ||
      FAMILIES.some(f => trials.filter(t => t.family === f).length === 3 &&
        trials.filter(t => t.family === f).at(-1)?.designHash === latestDesign));
  const familyHasWork = (familyTrials: Trial[], trials: Trial[]) =>
    familyTrials.length < 4 && (
      trials.length < search.config.minPerSlot || familyTrials.length < 2 ||
      (!!latestDesign && ((familyTrials.length === 2 && !trials.some(t => t.designHash === latestDesign)) ||
        (familyTrials.length === 3 && familyTrials.at(-1)?.designHash === latestDesign))) ||
      (familyTrials.at(-1)?.deltaPct ?? 0) > search.config.improvementPct);
  const counts = search.slots
    .map((slot) => ({
      slot,
      trials: search.trials.filter((t) => t.slot === slot),
    }))
    .filter(
      (x) =>
        !x.trials.some(
          (t) => t.status === "data_error" || t.status === "execution_error",
        ),
    );
  const hasWork = (trials: Trial[]) =>
    FAMILIES.some((family) => {
      const familyTrials = trials.filter((t) => t.family === family);
      return familyHasWork(familyTrials, trials);
    });
  const needy = counts
    .filter((x) => x.trials.length < search.config.minPerSlot)
    .sort((a, b) => a.trials.length - b.trials.length);
  let bucket = needy[0];
  if (!bucket) {
    const improving = counts.filter(
      (x) =>
        x.trials.length < search.config.maxPerSlot &&
        (!stagnant(x.trials, search.config) || newDesignOpportunity(x.trials)) &&
        hasWork(x.trials),
    );
    improving.sort(
      (a, b) =>
        Number(newDesignOpportunity(b.trials)) - Number(newDesignOpportunity(a.trials)) || a.trials.length - b.trials.length || Math.max(
          ...b.trials.map(
            (t) => t.development?.metrics.meanDailyPct ?? -Infinity,
          ),
        ) -
          Math.max(
            ...a.trials.map(
              (t) => t.development?.metrics.meanDailyPct ?? -Infinity,
            ),
          ) || search.slots.indexOf(a.slot) - search.slots.indexOf(b.slot),
    );
    bucket = improving[0];
  }
  if (!bucket) return null;
  const options = FAMILIES.map((family) => ({
    family,
    trials: bucket.trials.filter((t) => t.family === family),
  }));
  const active = options.filter(x => familyHasWork(x.trials, bucket.trials));
  active.sort(
    (a, b) =>
      a.trials.length - b.trials.length ||
      FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family),
  );
  const next = active[0];
  if (!next) return null;
  return {
    slot: bucket.slot,
    family: next.family,
    round: next.trials.length,
    parent: next.trials.at(-1),
  };
}
export function stagnant(trials: Trial[], config: SearchConfig) {
  if (trials.length < config.minPerSlot) return false;
  const tail = trials.slice(-config.stagnationTrials);
  return (
    tail.length >= config.stagnationTrials &&
    tail.every((t) => (t.deltaPct ?? 0) <= config.improvementPct)
  );
}
/** Instrument the very scan that the relay executes; counters explain blocked signals.
 * Features cached by bar identity for a fixed, audited source snapshot. */
const featureCache = new WeakMap<
  object,
  Map<string, { bars: object[]; value: number | null }>
>();
const cachedFeature: typeof featureValue = (bars, feature, lookback) => {
  const last = bars.at(-1);
  if (!last) return null;
  const sample = bars.slice(-lookback - 1),
    key = `${feature}:${lookback}`;
  let cache = featureCache.get(last);
  if (!cache) {
    cache = new Map();
    featureCache.set(last, cache);
  }
  const prior = cache.get(key);
  if (
    prior &&
    prior.bars.length === sample.length &&
    sample.every((bar, i) => prior.bars[i] === bar)
  )
    return prior.value;
  const value = featureValue(bars, feature, lookback);
  cache.set(key, { bars: sample, value });
  return value;
};
function measuredStrategy(
  spec: StrategySpec,
  counters: Record<string, number>,
): SlotStrategy {
  const strategy = compileStrategy(spec, cachedFeature),
    scan = strategy.scan;
  const bump = (key: string) => {
    counters[key] = (counters[key] ?? 0) + 1;
  };
  return {
    ...strategy,
    scan(context) {
      for (const symbol of spec.universe) {
        const bars = [
          ...(context.earlier[symbol] ?? []),
          ...(context.window[symbol] ?? []),
        ];
        const last = bars.at(-1),
          needed =
            Math.max(
              spec.candidate.rankLookback,
              ...spec.candidate.conditions.map((c) => c.lookback),
            ) + 1;
        bump("symbolDecisions");
        if (
          !last ||
          bars.length < needed ||
          bars
            .slice(-needed)
            .some(
              (b, i, a) =>
                i > 0 &&
                minuteOf(b.time) - minuteOf(a[i - 1].time) !==
                  strategy.barMinutes,
            )
        ) {
          bump("warmupOrGap");
          continue;
        }
        if (last.close * last.volume < spec.candidate.minBarDollarVolume)
          bump("liquidity");
        if (
          last.close *
            (1 +
              (costPerSidePct(symbol) + EXECUTION_LIMITS.maxEntryDriftPct) /
                100) >
          context.equityUsd * 0.99
        )
          bump("affordability");
        for (const [i, c] of spec.candidate.conditions.entries()) {
          const value = cachedFeature(bars, c.feature, c.lookback);
          if (
            value === null ||
            (c.operator === "gte" ? value < c.value : value > c.value)
          )
            bump(`condition${i}:${c.feature}`);
        }
      }
      const signal = scan(context);
      if (signal) bump("signals");
      return signal;
    },
  };
}
export function replayDevelopment(
  spec: StrategySpec,
  sessions: SessionBars[],
  manifest: SearchManifest,
  target: TargetSelection,
  config: SearchConfig,
  capitalUsd: number,
  budget?: { deadlineAt: number; onBacktest: () => void },
) {
  const coverage = manifest.coverage.find((c) => c.slot === spec.slot)!;
  const valid = new Set(coverage.validDates);
  // The function has no path capable of executing final-period bars.
  const train = sessions.filter(
    (s) => valid.has(s.date) && s.date <= manifest.trainingTo,
  );
  const dev = sessions.filter(
    (s) =>
      valid.has(s.date) &&
      s.date > manifest.trainingTo &&
      s.date <= manifest.developmentTo,
  );
  const counters: Record<string, number> = {};
  if (train.length < 90 || dev.length < 20)
    return {
      error: `정상 세션 부족: 학습 ${train.length}/90 · 개발 ${dev.length}/20`,
      counters,
    };
  const strategy = measuredStrategy(spec, counters);
  budget?.onBacktest();
  const training = runRelay([strategy], train, {
    capitalUsd,
    deadlineAt: budget?.deadlineAt,
  });
  budget?.onBacktest();
  const development = runRelay([strategy], dev, {
    capitalUsd,
    deadlineAt: budget?.deadlineAt,
  });
  const maxTrials = config.maxPerSlot * manifest.coverage.length;
  const a = summarize(training, target, maxTrials),
    b = summarize(development, target, maxTrials);
  return {
    training,
    development,
    train: a,
    dev: b,
    counters,
    reasons: developmentProblems(a, b),
    failure: diagnose(a, b),
  };
}
export function finalEvidence(
  training: RelayResult,
  development: RelayResult,
  result: RelayResult,
  stress: RelayResult,
  delayed: RelayResult,
  frozenAt: string,
): ValidationEvidence {
  const evidence = {
    training: sliceEvidence(training),
    validation: sliceEvidence(development),
    holdout: sliceEvidence(result),
    stress: sliceEvidence(stress),
    delayed: sliceEvidence(delayed),
  };
  const reasons = evidenceProblems(evidence);
  return { ...evidence, reasons, passed: !reasons.length, frozenAt };
}
export function costSnapshot(symbols: string[]) {
  return Object.fromEntries([
    ...symbols.map((s) => [`${s}:perSidePct`, costPerSidePct(s)]),
    ["secSellFeePct", TOSS_US_EQUITY.secSellFeePct],
  ]);
}
export function configProblems(config: SearchConfig, slots: SlotId[]) {
  if (
    config.minPerSlot < 8 ||
    config.maxPerSlot < config.minPerSlot ||
    config.maxPerSlot > 16
  )
    return "슬롯당 최소 8개·최대 16개 후보 필요";
  if (config.maxBacktests < slots.length * config.minPerSlot * 2)
    return "모든 슬롯의 최소 탐색을 위한 백테스트 한도가 부족합니다.";
  return null;
}
export { SLOTS, VALIDATION_POLICY };
