/**
 * Which days can even pay a daily return target.
 *
 * A "2% a day" rule has a precondition nobody checks: the session has to move
 * 2% at all. This measures that directly on daily bars — how often a session
 * travelled the target distance from its own open — and splits it by scheduled
 * event day versus every other session in the same window. Daily bars reach back
 * as far as the price history does, so unlike the minute-bar engines this is not
 * capped at ~60 days.
 *
 * Three things it refuses to do:
 *
 * 1. Count both directions as one opportunity. A day whose high is +2% and whose
 *    low is -2% did not offer a 2% trade to anyone holding a stop; it offered a
 *    stop-out. Those sessions are counted separately as `bothSides`, and the
 *    headline conservative number excludes them.
 * 2. Claim intraday order. A daily bar does not say whether the high or the low
 *    printed first, so `reachEither` is reported as an upper bound and the
 *    close-aligned rate is reported next to it as the floor.
 * 3. Report a rate without its sample size and a test against baseline. Twelve
 *    CPI prints will happily produce a 20-point "lift" out of noise, so every
 *    comparison carries an exact test.
 *
 * One call scores several groups against one baseline, so the p-values it
 * returns are a family, not a single test. Ten groups at the 0.05 level produce
 * a false positive half the time by construction, which is precisely how a sweep
 * over tickers manufactures an "edge". Benjamini-Hochberg runs across every
 * comparison in the call and `significant` reflects the corrected verdict.
 *
 * The test is Fisher's exact, not the two-proportion z. Event groups here are
 * small by construction — eight FOMC meetings a year, twelve CPI prints — and the
 * normal approximation is not valid at those counts; it reports z = 6.4 for a
 * single observation against a clean baseline. The z-score is still returned as a
 * descriptive effect size, but `significant` is driven by the exact p-value and
 * additionally requires a usable sample, because a p-value earned from three
 * sessions is a statement about three sessions, not about the next one.
 */

import { mean, median, round, type Bar } from "./quant.ts";

export type SessionProfile = {
  date: string;
  gapPct: number | null;
  openToClosePct: number;
  rangePct: number;
  /** Best favorable excursion from the open for a long, in percent. */
  upExcursionPct: number;
  /** Best favorable excursion from the open for a short, as a positive percent. */
  downExcursionPct: number;
  reachedUp: boolean;
  reachedDown: boolean;
};

export type ProfileStats = {
  label: string;
  sessions: number;
  /** Upper bound: either side travelled the target. Ignores which printed first. */
  reachEitherRatePct: number | null;
  reachUpRatePct: number | null;
  reachDownRatePct: number | null;
  /** Both sides travelled the target — a stop-and-target trader loses these. */
  bothSidesRatePct: number | null;
  /** Either side reached, minus the whipsaws. The number worth planning around. */
  cleanReachRatePct: number | null;
  /** Reached the target on the side the session actually closed on. The floor. */
  closeAlignedRatePct: number | null;
  medianRangePct: number | null;
  meanRangePct: number | null;
  medianAbsMovePct: number | null;
  meanAbsGapPct: number | null;
  upsideBiasPts: number | null;
};

export type ProfileComparison = {
  label: string;
  sessions: number;
  metric: "cleanReach" | "reachEither";
  ratePct: number | null;
  baselineRatePct: number | null;
  liftRatio: number | null;
  differencePts: number | null;
  /** Descriptive effect size only; the verdict comes from the exact p-value. */
  zScore: number | null;
  /** Fisher's exact, two-sided. */
  pValue: number | null;
  /** False when the group is too small for its rate to mean anything next time. */
  sufficientSample: boolean;
  /** Benjamini-Hochberg threshold this comparison had to clear, given the family. */
  correctedThreshold: number | null;
  /** Would have passed on its own p-value, before the family correction. */
  significantUncorrected: boolean;
  significant: boolean;
};

export type EventDayGroup = { label: string; dates: string[] };

export type EventDayProfileResult = {
  symbol: string;
  name: string;
  targetPct: number;
  period: { from: string; to: string; sessions: number };
  baseline: ProfileStats;
  groups: ProfileStats[];
  comparisons: ProfileComparison[];
  unmatched: Array<{ label: string; dates: string[] }>;
  notes: string[];
};

/** Smallest event-group size whose rate is allowed to be called a finding. */
export const MIN_TESTABLE_SESSIONS = 10;

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Lanczos log-gamma, so binomial coefficients over a multi-year sample stay finite. */
function logGamma(value: number): number {
  if (value < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * value)) - logGamma(1 - value);
  const x = value - 1;
  let sum = 0.99999999999980993;
  for (let index = 0; index < LANCZOS.length; index += 1) sum += LANCZOS[index] / (x + index + 1);
  const t = x + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

function logChoose(total: number, chosen: number) {
  if (chosen < 0 || chosen > total) return -Infinity;
  return logGamma(total + 1) - logGamma(chosen + 1) - logGamma(total - chosen + 1);
}

/**
 * Two-sided Fisher exact p for the 2x2 table
 * [[groupHits, groupMisses], [baselineHits, baselineMisses]].
 *
 * Enumeration runs over the group's hit count, so the loop is bounded by the
 * group size — a dozen terms for an event calendar, regardless of how many
 * baseline sessions sit on the other row.
 */
export function fisherExactTwoSided(groupHits: number, groupSessions: number, baselineHits: number, baselineSessions: number) {
  const total = groupSessions + baselineSessions;
  const hits = groupHits + baselineHits;
  if (!groupSessions || !baselineSessions || hits === 0 || hits === total) return 1;
  const logDenominator = logChoose(total, hits);
  const probabilityOf = (count: number) => Math.exp(logChoose(groupSessions, count) + logChoose(baselineSessions, hits - count) - logDenominator);
  const observed = probabilityOf(groupHits);
  const lower = Math.max(0, hits - baselineSessions);
  const upper = Math.min(groupSessions, hits);
  let total_ = 0;
  for (let count = lower; count <= upper; count += 1) {
    const probability = probabilityOf(count);
    // The 1e-9 slack keeps ties on the far side of the table from being dropped
    // by floating point, which would understate the p-value.
    if (probability <= observed * (1 + 1e-9)) total_ += probability;
  }
  return Math.min(1, total_);
}

function rate(count: number, total: number) {
  return total ? round((count / total) * 100, 2) : null;
}

export function profileSessions(rows: Bar[], targetPct: number): SessionProfile[] {
  const target = Math.abs(targetPct);
  return rows.map((row, index) => {
    const previous = index > 0 ? rows[index - 1] : null;
    const upExcursionPct = (row.high / row.open - 1) * 100;
    const downExcursionPct = (1 - row.low / row.open) * 100;
    return {
      date: row.date,
      gapPct: previous ? round((row.open / previous.close - 1) * 100, 4) : null,
      openToClosePct: round((row.close / row.open - 1) * 100, 4)!,
      rangePct: round(((row.high - row.low) / row.open) * 100, 4)!,
      upExcursionPct: round(upExcursionPct, 4)!,
      downExcursionPct: round(downExcursionPct, 4)!,
      reachedUp: upExcursionPct >= target,
      reachedDown: downExcursionPct >= target,
    };
  });
}

export function summarizeProfiles(label: string, profiles: SessionProfile[]): ProfileStats {
  const total = profiles.length;
  const up = profiles.filter((profile) => profile.reachedUp);
  const down = profiles.filter((profile) => profile.reachedDown);
  const both = profiles.filter((profile) => profile.reachedUp && profile.reachedDown);
  const either = profiles.filter((profile) => profile.reachedUp || profile.reachedDown);
  const closeAligned = profiles.filter((profile) =>
    (profile.openToClosePct > 0 && profile.reachedUp) || (profile.openToClosePct < 0 && profile.reachedDown));
  const gaps = profiles.flatMap((profile) => profile.gapPct === null ? [] : [Math.abs(profile.gapPct)]);
  return {
    label,
    sessions: total,
    reachEitherRatePct: rate(either.length, total),
    reachUpRatePct: rate(up.length, total),
    reachDownRatePct: rate(down.length, total),
    bothSidesRatePct: rate(both.length, total),
    cleanReachRatePct: rate(either.length - both.length, total),
    closeAlignedRatePct: rate(closeAligned.length, total),
    medianRangePct: round(median(profiles.map((profile) => profile.rangePct)), 3),
    meanRangePct: round(mean(profiles.map((profile) => profile.rangePct)), 3),
    medianAbsMovePct: round(median(profiles.map((profile) => Math.abs(profile.openToClosePct))), 3),
    meanAbsGapPct: round(mean(gaps), 3),
    upsideBiasPts: total ? round(((up.length - down.length) / total) * 100, 2) : null,
  };
}

function compare(stats: ProfileStats, baseline: ProfileStats, metric: "cleanReach" | "reachEither"): ProfileComparison {
  const key = metric === "cleanReach" ? "cleanReachRatePct" : "reachEitherRatePct";
  const ratePct = stats[key];
  const baselineRatePct = baseline[key];
  if (ratePct === null || baselineRatePct === null || !stats.sessions || !baseline.sessions) {
    return { label: stats.label, sessions: stats.sessions, metric, ratePct, baselineRatePct, liftRatio: null, differencePts: null, zScore: null, pValue: null, sufficientSample: false, correctedThreshold: null, significantUncorrected: false, significant: false };
  }
  const p1 = ratePct / 100;
  const p2 = baselineRatePct / 100;
  const pooled = (p1 * stats.sessions + p2 * baseline.sessions) / (stats.sessions + baseline.sessions);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / stats.sessions + 1 / baseline.sessions));
  const zScore = standardError > 0 ? (p1 - p2) / standardError : null;
  const pValue = fisherExactTwoSided(Math.round(p1 * stats.sessions), stats.sessions, Math.round(p2 * baseline.sessions), baseline.sessions);
  const sufficientSample = stats.sessions >= MIN_TESTABLE_SESSIONS;
  return {
    label: stats.label,
    sessions: stats.sessions,
    metric,
    ratePct,
    baselineRatePct,
    liftRatio: baselineRatePct > 0 ? round(ratePct / baselineRatePct, 3) : null,
    differencePts: round(ratePct - baselineRatePct, 2),
    zScore: round(zScore, 3),
    pValue: round(pValue, 5),
    sufficientSample,
    correctedThreshold: null,
    significantUncorrected: sufficientSample && pValue < 0.05,
    significant: sufficientSample && pValue < 0.05,
  };
}

/**
 * Benjamini-Hochberg over one call's comparisons, controlling the false
 * discovery rate at `alpha`. Comparisons too small to test are excluded from the
 * family rather than counted in it — an untestable group should not make the
 * threshold stricter for the ones that can be tested.
 *
 * Mutates in place and returns the same array; the corrected verdict is the one
 * `significant` carries afterwards.
 */
export function applyBenjaminiHochberg(comparisons: ProfileComparison[], alpha = 0.05) {
  const testable = comparisons.filter((item) => item.sufficientSample && item.pValue !== null);
  const ranked = [...testable].sort((left, right) => left.pValue! - right.pValue!);
  let largestPassingRank = 0;
  ranked.forEach((item, index) => {
    const rank = index + 1;
    if (item.pValue! <= (alpha * rank) / ranked.length) largestPassingRank = rank;
  });
  ranked.forEach((item, index) => {
    const rank = index + 1;
    item.correctedThreshold = round((alpha * rank) / ranked.length, 5);
    item.significant = rank <= largestPassingRank;
  });
  for (const item of comparisons) {
    if (!testable.includes(item)) { item.correctedThreshold = null; item.significant = false; }
  }
  return comparisons;
}

/**
 * `dates` are calendar dates; each anchors to the first session on or after it,
 * so a release on a holiday lands on the next day that actually traded. Dates
 * outside the loaded price window are returned in `unmatched` rather than
 * silently dropped, because a group that matched 3 of 12 prints is not a
 * 3-sample result, it is a data problem.
 */
export function buildEventDayProfile(
  rows: Bar[],
  symbol: string,
  name: string,
  groups: EventDayGroup[],
  targetPct: number,
): EventDayProfileResult {
  const profiles = profileSessions(rows, targetPct);
  const indexByDate = new Map(profiles.map((profile, index) => [profile.date, index]));
  const dates = profiles.map((profile) => profile.date);
  const claimed = new Set<number>();
  const unmatched: Array<{ label: string; dates: string[] }> = [];

  const resolved = groups.map((group) => {
    const missing: string[] = [];
    const indices = new Set<number>();
    for (const date of group.dates) {
      const exact = indexByDate.get(date);
      const anchor = exact ?? dates.findIndex((candidate) => candidate >= date);
      if (anchor === undefined || anchor === -1) { missing.push(date); continue; }
      indices.add(anchor);
      claimed.add(anchor);
    }
    if (missing.length) unmatched.push({ label: group.label, dates: missing });
    return { label: group.label, indices: [...indices].sort((left, right) => left - right) };
  });

  // Baseline excludes every session claimed by any group, so an event day is
  // never compared against a population that contains it.
  const baseline = summarizeProfiles("이벤트 없는 날 (기준선)", profiles.filter((_, index) => !claimed.has(index)));
  const groupStats = resolved.map((group) => summarizeProfiles(group.label, group.indices.map((index) => profiles[index])));
  // Only the cleanReach family is corrected against itself; reachEither is the
  // same sessions measured a second way, so pooling both would double-count the
  // family and punish every group for a metric it did not choose.
  const cleanComparisons = applyBenjaminiHochberg(groupStats.map((stats) => compare(stats, baseline, "cleanReach")));
  const eitherComparisons = applyBenjaminiHochberg(groupStats.map((stats) => compare(stats, baseline, "reachEither")));
  const comparisons = groupStats.flatMap((_, index) => [cleanComparisons[index], eitherComparisons[index]]);

  const notes: string[] = [];
  notes.push(`목표 ${targetPct}%는 그날 시가 기준 최대 유리 이동(MFE)으로 판정한다. 종가 수익률이 아니라 "그 폭이 장중에 있었는가"를 본다.`);
  notes.push("reachEither는 상한선이다. 일봉은 고가와 저가 중 무엇이 먼저 찍혔는지 말해주지 않으므로, 양방향 모두 목표를 찍은 날(bothSides)은 손절 사용자에게는 기회가 아니라 손실일 가능성이 높다. cleanReach가 계획의 근거로 쓸 숫자다.");
  if (groupStats.some((stats) => stats.sessions > 0 && stats.sessions < MIN_TESTABLE_SESSIONS)) notes.push(`표본 ${MIN_TESTABLE_SESSIONS}개 미만인 그룹은 p값이 작게 나와도 유의 판정을 주지 않는다. 세 번의 관측에서 나온 p값은 그 세 번에 대한 진술이지 다음번에 대한 진술이 아니다.`);
  if (groupStats.length > 1) notes.push(`한 번의 호출에서 ${groupStats.length}개 그룹을 같은 기준선에 검정했으므로 Benjamini-Hochberg로 다중검정을 보정했다. 보정 전 p<0.05였는데 significant가 false인 항목은, 그 그룹 수만큼 검정하면 우연히 나올 수 있는 수준이라는 뜻이다.`);
  notes.push("검정은 피셔 정확검정(양측)이다. 이벤트 그룹은 연 8~12회 수준이라 정규근사(z검정)가 성립하지 않으며, z값은 효과 크기 참고용으로만 반환한다.");
  if (unmatched.length) notes.push(`가격 구간 밖이라 매칭되지 않은 이벤트 날짜가 ${unmatched.reduce((sum, item) => sum + item.dates.length, 0)}개 있다. 조회 기간을 늘리면 표본이 늘어난다.`);

  return {
    symbol, name, targetPct,
    period: { from: dates[0] ?? "", to: dates.at(-1) ?? "", sessions: profiles.length },
    baseline, groups: groupStats, comparisons, unmatched, notes,
  };
}
