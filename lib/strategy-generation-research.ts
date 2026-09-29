import {
  compileStrategy,
  EXECUTION_LIMITS,
  type Candidate,
} from "./strategy-generation-spec.ts";
import { costPerSidePct, roundTripPctFor } from "./symbol-liquidity.ts";
import type { SessionBars } from "./relay-engine.ts";
import type { GenerationJob } from "./strategy-generation-types.ts";
import {
  splitSessions,
  VALIDATION_POLICY,
} from "./strategy-generation-validation.ts";
import { slotById } from "./trade-slots.ts";

/** Predetermined chronological test blocks. A consumed block is never called unseen again. */
export function researchSplit(
  sessions: SessionBars[],
  window = 0,
  initialSessions = sessions.length,
) {
  const initial = sessions.slice(0, initialSessions);
  const base = splitSessions(initial);
  const remaining = initial.length - base.train.length;
  const initialWindows = Math.max(1, Math.min(3, Math.floor(remaining / 40)));
  const windows =
    initialWindows + Math.floor((sessions.length - initialSessions) / 40);
  if (window >= windows)
    throw new Error("새로운 미사용 검증 데이터가 필요합니다.");
  const size = Math.floor(remaining / initialWindows);
  const start =
    window < initialWindows
      ? base.train.length + size * window
      : initialSessions + (window - initialWindows) * 40;
  const end =
    window < initialWindows
      ? window === initialWindows - 1
        ? initialSessions
        : start + size
      : start + 40;
  const middle = start + Math.floor((end - start) / 2);
  return {
    train: sessions.slice(0, start),
    validation: sessions.slice(start, middle),
    holdout: sessions.slice(middle, end),
    windows,
  };
}

function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (q: number) =>
    sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null;
  return {
    samples: sorted.length,
    p10: at(0.1),
    median: at(0.5),
    p90: at(0.9),
  };
}

export function summarizeResearch(job: GenerationJob, sessions: SessionBars[]) {
  const slot = slotById(job.slot)!;
  const split = researchSplit(
    sessions,
    job.validationWindow ?? 0,
    job.researchSessions,
  );
  return {
    sessions: sessions.length,
    training: {
      from: split.train[0].date,
      to: split.train.at(-1)!.date,
      sessions: split.train.length,
    },
    validationSessions: split.validation.length,
    holdoutSessions: split.holdout.length,
    windows: split.windows,
    symbols: (job.universe ?? job.plan!.universe).map((symbol) => {
      const bars = split.train.flatMap((s) =>
        (s.bars[symbol] ?? []).filter(
          (b) => b.time >= slot.from && b.time < slot.to,
        ),
      );
      const prices = bars.map((b) => b.close);
      const days = split.train
        .map((s) =>
          (s.bars[symbol] ?? []).filter(
            (b) => b.time >= slot.from && b.time < slot.to,
          ),
        )
        .filter((b) => b.length >= 2);
      const slotReturns = days.map(
        (b) => (b.at(-1)!.close / b[0].open - 1) * 100,
      );
      const slotRanges = days.map(
        (b) =>
          ((Math.max(...b.map((x) => x.high)) -
            Math.min(...b.map((x) => x.low))) /
            b[0].open) *
          100,
      );
      const quantities = prices.map((p) =>
        Math.floor(
          (job.capitalUsd * (1 - EXECUTION_LIMITS.reservePct / 100)) /
            (p *
              (1 +
                (costPerSidePct(symbol) + EXECUTION_LIMITS.maxEntryDriftPct) /
                  100)),
        ),
      );
      return {
        symbol,
        bars: bars.length,
        minPrice: prices.reduce((a, b) => Math.min(a, b), Infinity),
        maxPrice: prices.reduce((a, b) => Math.max(a, b), 0),
        minWholeShares: quantities.reduce((a, b) => Math.min(a, b), Infinity),
        maxWholeShares: quantities.reduce((a, b) => Math.max(a, b), 0),
        affordableBars: quantities.filter((q) => q >= 1).length,
        meanDollarVolume:
          bars.reduce((n, b) => n + b.close * b.volume, 0) / bars.length,
        liquidBarsAtMinimum: bars.filter(
          (b, i) =>
            quantities[i] >= 1 &&
            b.close * b.volume >= 100000 &&
            (b.volume * EXECUTION_LIMITS.participationPct) / 100 >= 1,
        ).length,
        dollarVolumeDistribution: distribution(
          bars.map((b) => b.close * b.volume),
        ),
        slotReturnPctDistribution: distribution(slotReturns),
        slotRangePctDistribution: distribution(slotRanges),
        assumedCostPerSidePct: costPerSidePct(symbol),
        assumedRoundTripPct: roundTripPctFor(symbol),
      };
    }),
    limitations: [
      "OHLCV는 실시간 호가·체결 대기열 증거가 아님. 비용은 엔진의 명시적 가정.",
      "정수 주식·현금·1% 준비금. 후보 언어에는 별도 거래당 0.5% 위험 예산이나 크기 조정 기능이 없음.",
      "현재 선정 종목의 과거 데이터이며 생존편향·모델의 과거 지식 노출을 배제하지 못함.",
    ],
  };
}

/** Compute executable training diagnostics before spending on a reviewer. */
export function candidateFeasibility(
  job: GenerationJob,
  candidates: Candidate[],
  sessions: SessionBars[],
) {
  const slot = slotById(job.slot)!;
  const summary = summarizeResearch(job, sessions);
  const issues: string[] = [];
  if (!summary.symbols.some((s) => s.affordableBars && s.liquidBarsAtMinimum))
    issues.push(
      "선택 종목은 학습 구간에서 자본·최소 거래량 조건을 함께 충족하지 못합니다.",
    );
  for (const [i, candidate] of candidates.entries()) {
    try {
      compileStrategy({
        version: 1,
        id: `${job.id}-${i}`,
        slot: job.slot,
        universe: job.universe ?? job.plan!.universe,
        candidate,
        evidence: "pending",
      });
    } catch (e) {
      issues.push(
        `${candidate.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (
      slot.from === "04:00" &&
      Math.max(
        candidate.rankLookback,
        ...candidate.conditions.map((c) => c.lookback),
      ) *
        5 >=
        Number(slot.to.slice(0, 2)) * 60 + Number(slot.to.slice(3)) - 240 - 10
    )
      issues.push(
        `${candidate.name}: 당일 연속 봉 준비 이후 슬롯 내 진입 시간이 없습니다.`,
      );
  }
  return { summary, issues, minTrainTrades: VALIDATION_POLICY.minTrainTrades };
}
