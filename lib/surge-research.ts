/**
 * What the designer is allowed to know before it writes a rule.
 *
 * Only the training block is summarised here. The validation and holdout blocks
 * are not even loaded for it: a model that has seen the distribution of the days
 * it will be tested on is not being tested.
 *
 * The summary answers the owner's question directly — once a name is seen
 * surging (or crashing) today, what does it do for the rest of today? — by
 * aligning every event at its observation minute and reporting the forward path
 * from there: returns at fixed horizons, the best and worst excursion, and which
 * of a symmetric up/down move came first, split by when in the day the event
 * happened and by how big it was. It also leads with the two numbers that
 * decide whether any rule can work at all — the modelled round-trip cost, and
 * that cost in units of a candidate stop.
 */

import { minuteEnd, SURGE_OBSERVATION } from "./surge-observation.ts";
import type { SurgeSession } from "./surge-engine.ts";
import { compileSurgeStrategy, targetPctOf, breakEvenWinRatePct, SURGE_EXECUTION, SURGE_EXIT_BY, type SurgeCandidate, type SurgeCandidateSpec } from "./surge-spec.ts";
import type { IntradayBar } from "./relay-engine.ts";
import { surgeCostPerSidePct, surgeRoundTripPct } from "./surge-costs.ts";
import { SURGE_POLICY } from "./surge-validation.ts";

function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const at = (quantile: number) => (sorted.length ? Number(sorted[Math.floor((sorted.length - 1) * quantile)].toFixed(3)) : null);
  return { samples: sorted.length, p10: at(0.1), median: at(0.5), p90: at(0.9) };
}

function summary(values: number[]) {
  const finite = values.filter(Number.isFinite);
  return {
    ...distribution(finite),
    meanPct: finite.length ? Number((finite.reduce((a, b) => a + b, 0) / finite.length).toFixed(3)) : null,
    positiveFraction: finite.length ? Number((finite.filter((v) => v > 0).length / finite.length).toFixed(3)) : null,
  };
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

const HORIZONS = [5, 15, 30, 60, 120] as const;
const TIME_BUCKETS = [
  { label: "09:30-10:00", from: "09:30", to: "10:00" },
  { label: "10:00-11:30", from: "10:00", to: "11:30" },
  { label: "11:30-13:30", from: "11:30", to: "13:30" },
  { label: "13:30-15:30", from: "13:30", to: "15:30" },
  { label: "15:30-16:00", from: "15:30", to: "16:00" },
] as const;
const MOVE_BUCKETS = [[10, 20], [20, 40], [40, 100], [100, Infinity]] as const;
const TOUCH_LEVELS = [3, 5, 8] as const;

/** The forward path of one event from its observation price, on the bars after the observation minute. */
function forwardPath(event: SurgeCandidate, bars: IntradayBar[], step: number) {
  const price = event.observedPrice!;
  bars = bars.filter(bar => bar.date === event.rankedOn && minuteEnd(bar.time, step) <= SURGE_EXIT_BY)
    .sort((a, b) => a.time.localeCompare(b.time));
  // Closes after the observation are forward prices; excursions only count bars that began after it.
  const closing = bars.filter((bar) => minutes(minuteEnd(bar.time, step)) > minutes(event.observedAt!));
  const after = bars.filter((bar) => minutes(bar.time) >= minutes(event.observedAt!));
  const closeAt = (clock: string) => {
    // A stale price is not an observed forward return at the requested horizon.
    return closing.find(bar => minuteEnd(bar.time, step) === clock)?.close ?? null;
  };
  // Thin names skip minutes; a bar with a missing minute is dropped, and a signal before it cannot fill.
  const expected = Math.max(1, Math.floor((minutes(SURGE_EXIT_BY) - minutes(event.observedAt!)) / step));
  const forward = Object.fromEntries(HORIZONS.map((horizon) => {
    const clock = minuteEnd(event.observedAt!, horizon);
    const close = minutes(clock) <= minutes(SURGE_EXIT_BY) ? closeAt(clock) : null;
    return [horizon, close === null ? null : (close / price - 1) * 100];
  })) as Record<(typeof HORIZONS)[number], number | null>;
  const toExit = closeAt(SURGE_EXIT_BY);
  const hour = after.filter((bar) => minutes(bar.time) < minutes(event.observedAt!) + 60);
  const fullHour = hour.length === 60 / step && hour.every((bar, index) => minutes(bar.time) === minutes(event.observedAt!) + index * step);
  const firstTouch = Object.fromEntries(TOUCH_LEVELS.map((level) => {
    let result: "up" | "down" | "neither" | "missing" = fullHour ? "neither" : "missing";
    if (!fullHour) return [level, result];
    for (const bar of hour) {
      const down = bar.low <= price * (1 - level / 100);
      const up = bar.high >= price * (1 + level / 100);
      // A bar covering both is read as down first, as the engine reads stop-and-target.
      if (down) { result = "down"; break; }
      if (up) { result = "up"; break; }
    }
    return [level, result];
  })) as Record<(typeof TOUCH_LEVELS)[number], "up" | "down" | "neither" | "missing">;
  return {
    forward,
    toExit: toExit === null ? null : (toExit / price - 1) * 100,
    maxUp60: fullHour ? (Math.max(...hour.map((bar) => bar.high)) / price - 1) * 100 : null,
    maxDown60: fullHour ? (Math.min(...hour.map((bar) => bar.low)) / price - 1) * 100 : null,
    firstTouch,
    completeBarShare: Math.min(1, after.filter((bar) => minutes(bar.time) < minutes(SURGE_EXIT_BY)).length / expected),
  };
}

type Path = ReturnType<typeof forwardPath>;

function pathSummary(paths: Path[]) {
  return {
    events: paths.length,
    forwardReturnPct: Object.fromEntries(HORIZONS.map((horizon) => [`+${horizon}m`, summary(paths.map((path) => path.forward[horizon] ?? Number.NaN))])),
    toFlatAt1555Pct: summary(paths.map((path) => path.toExit ?? Number.NaN)),
    maxFavourable60mPct: distribution(paths.map((path) => path.maxUp60 ?? Number.NaN)),
    maxAdverse60mPct: distribution(paths.map((path) => path.maxDown60 ?? Number.NaN)),
    /** Share of the bars to 15:55 that exist complete; low values mean frequent unfillable signals. */
    completeBarShare: distribution(paths.map((path) => path.completeBarShare)),
    firstTouchWithin60m: Object.fromEntries(TOUCH_LEVELS.map((level) => {
      const touched = paths.map((path) => path.firstTouch[level]);
      return [`±${level}%`, {
        upFirst: touched.filter((value) => value === "up").length,
        downFirst: touched.filter((value) => value === "down").length,
        neither: touched.filter((value) => value === "neither").length,
        missing: touched.filter((value) => value === "missing").length,
      }];
    })),
  };
}

/** A setup is classified with only the first 15m; outcomes start after those 15m. */
function earlyShape(event: SurgeCandidate, bars: IntradayBar[], step: number) {
  const end = minuteEnd(event.observedAt!, 15);
  const early = bars.filter(bar => bar.date === event.rankedOn && bar.time >= event.observedAt! && minuteEnd(bar.time, step) <= end)
    .sort((a, b) => a.time.localeCompare(b.time));
  if (end >= SURGE_EXIT_BY || early.length !== 15 / step || early.some((bar, i) => minutes(bar.time) !== minutes(event.observedAt!) + i * step)) return null;
  const price = early.at(-1)!.close;
  const move = (price / event.observedPrice! - 1) * 100;
  const shape = move >= 1 ? "first15m_up" : move <= -1 ? "first15m_down" : "first15m_flat";
  return { shape, path: forwardPath({ ...event, observedAt: end, observedPrice: price }, bars, step) };
}

/** Measured facts about the training block's same-day events. `step` is the bars' resolution. */
export function createSurgeResearchSummary(capitalUsd: number, step = 1) {
  let sessions = 0;
  let from = "";
  let to = "";
  const perSession: number[] = [];
  const changes: number[] = [];
  const prices: number[] = [];
  const tape: number[] = [];
  const roundTrip: number[] = [];
  const affordable: number[] = [];
  const all: Path[] = [];
  const byTime = new Map<string, Path[]>(TIME_BUCKETS.map((bucket) => [bucket.label, []]));
  const byMove = new Map<string, Path[]>(MOVE_BUCKETS.map(([low, high]) => [`${low}-${high === Infinity ? "" : high}%`, []]));
  const observedCounts = new Map<string, number>(TIME_BUCKETS.map((bucket) => [bucket.label, 0]));
  const shapes = new Map(["first15m_up", "first15m_flat", "first15m_down"].map(shape => [shape, [] as Array<{ date: string; symbol: string; path: Path }> ]));
  let withBars = 0;

  function add(session: SurgeSession) {
    sessions++;
    from = !from || session.date < from ? session.date : from;
    to = session.date > to ? session.date : to;
    perSession.push(session.candidates.filter(event => event.rankedOn === session.date && event.observedAt && event.observedPrice).length);
    for (const event of session.candidates) {
      if (event.rankedOn !== session.date || !event.observedAt || !event.observedPrice) continue;
      const move = Math.abs(event.changePct);
      changes.push(event.changePct);
      prices.push(event.observedPrice);
      tape.push(event.dollarVolume / 1e6);
      const liquidity = event.priorDollarVolume ?? event.dollarVolume;
      roundTrip.push(surgeRoundTripPct(event.symbol, event.observedPrice, liquidity));
      const unit = event.observedPrice * (1 + (surgeCostPerSidePct(event.symbol, event.observedPrice, liquidity) + SURGE_EXECUTION.maxEntryDriftPct) / 100);
      affordable.push(Math.floor((capitalUsd * (1 - SURGE_EXECUTION.reservePct / 100)) / unit));
      // `observedAt` is a minute's close, so an event belongs to the window it closed in: (from, to].
      const timeLabel = (TIME_BUCKETS.find((row) => event.observedAt! > row.from && event.observedAt! <= row.to) ?? TIME_BUCKETS.at(-1)!).label;
      observedCounts.set(timeLabel, (observedCounts.get(timeLabel) ?? 0) + 1);

      const bars = session.bars[event.symbol] ?? [];
      if (bars.length < 2) continue;
      withBars += 1;
      const path = forwardPath(event, bars, step);
      all.push(path);
      const shape = earlyShape(event, bars, step);
      if (shape) shapes.get(shape.shape)!.push({ date: session.date, symbol: event.symbol, path: shape.path });
      byTime.get(timeLabel)!.push(path);
      const moveKey = MOVE_BUCKETS.find(([low, high]) => move >= low && move < high);
      if (moveKey) byMove.get(`${moveKey[0]}-${moveKey[1] === Infinity ? "" : moveKey[1]}%`)!.push(path);
    }
  }

  function result() {
    const medianRoundTrip = distribution(roundTrip).median ?? 0;
    return {
      sessions,
      from,
      to,
      analysisBarInterval: `${step}m`,
      alignment: "당일 급등락 최초 관측가=100, 관측 시각=0분. 각 전방 시점의 정확한 완성 봉이 없으면 결측 처리.",
      eventDefinition: `정규장 완성 1분봉 종가가 전일 종가 대비 ${SURGE_OBSERVATION.changePct}% 이상 움직이고, $${SURGE_OBSERVATION.minPrice}–$${SURGE_OBSERVATION.maxPrice}, 그 분까지 누적 거래대금 ≥ $${SURGE_OBSERVATION.minSessionDollarVolume / 1e6}M인 첫 분`,
      events: changes.length,
      eventsWithBars: withBars,
      eventsPerSessionDistribution: distribution(perSession),
      sessionsWithoutEvents: perSession.filter((count) => count === 0).length,
      eventChangePctDistribution: distribution(changes),
      observationPriceDistribution: distribution(prices),
      sessionDollarVolumeAtObservationMDistribution: distribution(tape),
      observationTimeOfDay: [...observedCounts].map(([window, count]) => ({ window, events: count })),
      wholeSharesAtCapitalDistribution: distribution(affordable),
      modelledRoundTripPctDistribution: distribution(roundTrip),
      /** The core evidence for "surging names move alike later today": aligned at observation. */
      afterObservation: pathSummary(all),
      afterObservationByTimeOfDay: [...byTime].map(([window, paths]) => ({ window, ...pathSummary(paths) })),
      afterObservationByMoveSize: [...byMove].map(([move, paths]) => ({ move, ...pathSummary(paths) })),
      afterSimilarFirst15m: {
        definition: "관측 후 첫 15분 수익률 ≥+1%, ≤−1%, 그 사이로 고정 분류. 이후 수익률은 15분 시점 가격부터 측정하며 분류에 사용하지 않음.",
        decisionAvailableAfterMinutes: 15,
        groups: [...shapes].map(([shape, rows]) => ({
          shape, sessions: new Set(rows.map(row => row.date)).size, symbols: new Set(rows.map(row => row.symbol)).size,
          ...pathSummary(rows.map(row => row.path)),
        })),
      },
      /** The hurdle: what the median round trip costs as a fraction of the stop. */
      roundTripInR: [2, 3, 5, 8, 12].map((stopPct) => ({
        stopPct,
        costInR: Number((medianRoundTrip / stopPct).toFixed(4)),
        breakEvenWinRatePctAt2to1: breakEvenWinRatePct(2, medianRoundTrip / stopPct),
      })),
      limitations: [
        "호가·체결 대기열 증거 없음. 스프레드는 가격(틱)과 거래대금으로 추정한 모형 가정이며 등록 전 2배 재실행을 통과해야 합니다.",
        "사건은 정규장 완성 1분봉에서 처음 관측된 시점부터만 존재합니다. 일봉 고가·저가는 분봉을 받을 종목을 고르는 데만 쓰고 신호로 쓰지 않습니다.",
        "전방 수익률은 관측가 기준 서술 통계입니다. 실제 체결은 결정 봉 다음 봉 시가이며 비용이 빠집니다.",
        "유사 경로는 첫 15분만으로 분류하며 이후 결과는 분류에 쓰지 않습니다. 15분 전에 이 분류로 진입할 수 없습니다. 같은 날 사건은 서로 독립 표본이 아닐 수 있습니다.",
        "전방 시점의 봉이 없으면 수익률은 결측입니다. 60분 전체가 없으면 최대 상승·하락과 선도달 통계에서 제외합니다.",
        "상장폐지·거래정지 종목의 분봉이 비어 있을 수 있고, 그 사건은 빠집니다 — 생존편향을 완전히 제거하지는 못합니다.",
        "롱 전용·현금·정수 주식·1% 준비금. 급하락 사건은 공매도가 아니라 반등 매수로만 거래할 수 있습니다.",
        "실거래 관측은 토스 급상승·급하락 랭킹(상위 100)과 토스 1분봉으로 같은 정의를 재현합니다. 순간 스파이크를 놓치거나 늦게 볼 수 있고, 늦게 본 사건은 늦은 시각부터만 거래합니다.",
        "가격·수량은 원주가입니다. 분할·병합일의 종목은 사건에서 제외했습니다.",
      ],
    };
  }
  return { add, result };
}

export function summarizeSurgeResearch(train: SurgeSession[], capitalUsd: number, step = 1) {
  const summary = createSurgeResearchSummary(capitalUsd, step);
  train.forEach(session => summary.add(session));
  return summary.result();
}

/** Everything checkable about a candidate before a paid reviewer sees it. */
export function surgeCandidateFeasibility(
  runId: string,
  candidates: SurgeCandidateSpec[],
  train: SurgeSession[],
  capitalUsd: number,
  measuredSummary = summarizeSurgeResearch(train, capitalUsd),
) {
  const summaryOfTrain = measuredSummary;
  const issues: string[] = [];
  const medianRoundTrip = summaryOfTrain.modelledRoundTripPctDistribution.median ?? 0;

  if (!summaryOfTrain.eventsWithBars) {
    issues.push("학습 구간에 분봉을 확보한 당일 사건이 없습니다.");
  }

  for (const [index, candidate] of candidates.entries()) {
    let strategy;
    try {
      strategy = compileSurgeStrategy({ version: 2, id: `${runId}-${index}`, candidate, evidence: "pending" });
    } catch (error) {
      issues.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const costR = medianRoundTrip / candidate.stopPct;
    const hurdle = breakEvenWinRatePct(candidate.rewardRisk, costR);
    if (hurdle >= 70) {
      issues.push(
        `${candidate.name}: 손절 ${candidate.stopPct}% · 손익비 ${candidate.rewardRisk}:1 은 비용 ${costR.toFixed(2)}R 반영 시 손익분기 승률 ${hurdle}%가 필요합니다. 손절을 넓히거나 손익비를 올리세요.`,
      );
    }
    const reachable = train.reduce((sum, session) => sum + session.candidates.filter((event) => strategy.eligible(event) &&
      event.observedAt! <= minuteEnd(candidate.entryTo, -candidate.minMinutesSinceEvent)).length, 0);
    if (reachable < SURGE_POLICY.minTrainTrades) {
      issues.push(`${candidate.name}: 학습 구간에서 등락폭·가격·진입 시각 조건에 맞는 사건이 ${reachable}건뿐입니다 (최소 거래 ${SURGE_POLICY.minTrainTrades}건 필요). 조건을 넓히세요.`);
    }
    if (!candidate.barConditions.length && !candidate.dayConditions.length) {
      issues.push(`${candidate.name}: 조건이 하나도 없습니다 — 사건 발생만으로는 가설이 아닙니다.`);
    }
    if (targetPctOf(candidate) >= 40 && candidate.stopPct * candidate.rewardRisk > 40) {
      issues.push(`${candidate.name}: 목표가 40% 상한에 잘려 의도한 손익비가 유지되지 않습니다.`);
    }
  }
  return { summary: summaryOfTrain, issues, minTrainTrades: SURGE_POLICY.minTrainTrades };
}
