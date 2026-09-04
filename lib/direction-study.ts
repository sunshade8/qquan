/**
 * Does anything known before the open predict which way the day resolves?
 *
 * For a high-beta name the 2%-a-day constraint is not opportunity — those names
 * already travel 2% from the open on most sessions — it is side selection. This
 * measures whether the gap and the relative volume, both known before a position
 * can be taken, shift the odds of the day resolving up rather than down.
 *
 * The measurement is built to be immune to the one thing daily bars cannot tell
 * you. A session is *decisive* only when exactly one side reached the target: on
 * those sessions a trader entering that side hits the target and never touches a
 * symmetric stop, whatever order the high and the low printed in. Sessions where
 * both sides reached are counted separately as whipsaws and excluded from the
 * directional rate, because that is the case where bar order would decide the
 * outcome and the bar does not say.
 *
 * The headline test is therefore a clean 2x2: gap-up sessions versus gap-down
 * sessions, over decisive sessions only, asking how often each resolved upward.
 * Everything else in the result is descriptive around that one question.
 *
 * Look-ahead is the other hazard. Full-session volume is not known at the open,
 * so `relativeVolume` must be supplied by the caller from something that was:
 * the prior session's volume against its own trailing median, or the opening
 * window's volume when minute bars are available. This module never derives it
 * from the session it is judging.
 */

import { fisherExactTwoSided, MIN_TESTABLE_SESSIONS } from "./event-day-profile.ts";
import { describeCosts } from "./broker-costs.ts";
import { median, round } from "./quant.ts";

export type DirectionInput = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Known before the open: open / previous close - 1, in percent. */
  gapPct: number | null;
  /** Known before the entry decision. Null when no trustworthy baseline exists. */
  relativeVolume: number | null;
};

export type Resolution = "up" | "down" | "both" | "neither";

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  up: "상방만 도달",
  down: "하방만 도달",
  both: "양방향 도달 (휩쏘)",
  neither: "미도달",
};

export type DirectionRow = DirectionInput & {
  upExcursionPct: number;
  downExcursionPct: number;
  openToClosePct: number;
  resolution: Resolution;
};

export type DirectionBucket = {
  label: string;
  sessions: number;
  /** Sessions where exactly one side reached the target. The only orderable ones. */
  decisive: number;
  upOnly: number;
  downOnly: number;
  bothSides: number;
  neither: number;
  /** Of decisive sessions, the share that resolved upward. 50 means no edge. */
  upShareOfDecisivePct: number | null;
  decisiveRatePct: number | null;
  whipsawRatePct: number | null;
  meanOpenToClosePct: number | null;
  medianGapPct: number | null;
};

export type DirectionTest = {
  label: string;
  metric: "direction" | "whipsaw";
  leftLabel: string;
  rightLabel: string;
  leftDecisive: number;
  rightDecisive: number;
  leftUpSharePct: number | null;
  rightUpSharePct: number | null;
  spreadPts: number | null;
  /** Half-width of the 95% interval on the spread. */
  marginOfErrorPts: number | null;
  /**
   * The smallest true difference this sample could have detected at 80% power.
   * Without it a null result is unreadable: "no effect" from forty sessions and
   * "no effect" from four thousand are different claims, and only the second one
   * rules anything out.
   */
  minimumDetectableEffectPts: number | null;
  pValue: number | null;
  sufficientSample: boolean;
  /** Benjamini-Hochberg threshold across every test this call ran. */
  correctedThreshold: number | null;
  significantUncorrected: boolean;
  significant: boolean;
  verdict: string;
};

export type DirectionStudy = {
  symbol: string;
  targetPct: number;
  gapThresholdPct: number;
  volumeThreshold: number | null;
  period: { from: string; to: string; sessions: number };
  buckets: DirectionBucket[];
  tests: DirectionTest[];
  rows: DirectionRow[];
  notes: string[];
};

export function classifyRows(inputs: DirectionInput[], targetPct: number): DirectionRow[] {
  const target = Math.abs(targetPct);
  return inputs.map((input) => {
    const upExcursionPct = (input.high / input.open - 1) * 100;
    const downExcursionPct = (1 - input.low / input.open) * 100;
    const reachedUp = upExcursionPct >= target;
    const reachedDown = downExcursionPct >= target;
    return {
      ...input,
      upExcursionPct: round(upExcursionPct, 4)!,
      downExcursionPct: round(downExcursionPct, 4)!,
      openToClosePct: round((input.close / input.open - 1) * 100, 4)!,
      resolution: reachedUp && reachedDown ? "both" : reachedUp ? "up" : reachedDown ? "down" : "neither",
    };
  });
}

export function summarizeBucket(label: string, rows: DirectionRow[]): DirectionBucket {
  const upOnly = rows.filter((row) => row.resolution === "up").length;
  const downOnly = rows.filter((row) => row.resolution === "down").length;
  const bothSides = rows.filter((row) => row.resolution === "both").length;
  const neither = rows.filter((row) => row.resolution === "neither").length;
  const decisive = upOnly + downOnly;
  const gaps = rows.flatMap((row) => row.gapPct === null ? [] : [row.gapPct]);
  return {
    label,
    sessions: rows.length,
    decisive, upOnly, downOnly, bothSides, neither,
    upShareOfDecisivePct: decisive ? round((upOnly / decisive) * 100, 2) : null,
    decisiveRatePct: rows.length ? round((decisive / rows.length) * 100, 2) : null,
    whipsawRatePct: rows.length ? round((bothSides / rows.length) * 100, 2) : null,
    meanOpenToClosePct: rows.length ? round(rows.reduce((sum, row) => sum + row.openToClosePct, 0) / rows.length, 4) : null,
    medianGapPct: round(median(gaps), 4),
  };
}

/** 1.96 for a two-sided 95% interval; 2.80 is z(0.975) + z(0.80) for 80% power. */
const Z_95 = 1.959964;
const Z_POWER_SUM = 2.801582;

/**
 * Compares two buckets on one binary outcome.
 *
 * `hits` picks what is being counted — upward resolutions among decisive
 * sessions, or whipsaws among all sessions — so the same 2x2 machinery answers
 * "does this predict direction?" and "does this predict chop?" without a second
 * implementation that could disagree with the first.
 */
function testPair(
  label: string,
  metric: "direction" | "whipsaw",
  left: DirectionBucket,
  right: DirectionBucket,
): DirectionTest {
  const total = (bucket: DirectionBucket) => metric === "direction" ? bucket.decisive : bucket.sessions;
  const hits = (bucket: DirectionBucket) => metric === "direction" ? bucket.upOnly : bucket.bothSides;
  const leftTotal = total(left);
  const rightTotal = total(right);
  const leftHits = hits(left);
  const rightHits = hits(right);
  const sufficientSample = leftTotal >= MIN_TESTABLE_SESSIONS && rightTotal >= MIN_TESTABLE_SESSIONS;
  const pValue = sufficientSample ? fisherExactTwoSided(leftHits, leftTotal, rightHits, rightTotal) : null;
  const leftRate = leftTotal ? (leftHits / leftTotal) * 100 : null;
  const rightRate = rightTotal ? (rightHits / rightTotal) * 100 : null;
  const spreadPts = leftRate !== null && rightRate !== null ? leftRate - rightRate : null;

  let marginOfErrorPts: number | null = null;
  let minimumDetectableEffectPts: number | null = null;
  if (leftTotal > 0 && rightTotal > 0 && leftRate !== null && rightRate !== null) {
    const p1 = leftRate / 100;
    const p2 = rightRate / 100;
    marginOfErrorPts = Z_95 * Math.sqrt((p1 * (1 - p1)) / leftTotal + (p2 * (1 - p2)) / rightTotal) * 100;
    // Detectable difference at 80% power, evaluated at the least favourable
    // variance (p = 0.5) so the figure is a promise the sample can keep.
    minimumDetectableEffectPts = Z_POWER_SUM * Math.sqrt(0.25 / leftTotal + 0.25 / rightTotal) * 100;
  }

  const significant = sufficientSample && pValue !== null && pValue < 0.05;

  return {
    label, metric,
    leftLabel: left.label,
    rightLabel: right.label,
    leftDecisive: leftTotal,
    rightDecisive: rightTotal,
    leftUpSharePct: round(leftRate, 2),
    rightUpSharePct: round(rightRate, 2),
    spreadPts: round(spreadPts, 2),
    marginOfErrorPts: round(marginOfErrorPts, 2),
    minimumDetectableEffectPts: round(minimumDetectableEffectPts, 2),
    pValue: round(pValue, 5),
    sufficientSample,
    correctedThreshold: null,
    significantUncorrected: significant,
    significant,
    verdict: "",
  };
}

/**
 * Benjamini-Hochberg across one study's tests, then a plain-language verdict.
 *
 * A study runs six tests off one dataset, so the uncorrected verdicts are a
 * family. The verdict string is written last, after the correction, so it can
 * never claim more than the corrected result supports — and a null verdict
 * always carries the effect size the sample could actually have detected,
 * because "no difference" from forty sessions rules nothing out.
 */
function finalizeTests(tests: DirectionTest[], alpha = 0.05) {
  const testable = tests.filter((test) => test.sufficientSample && test.pValue !== null);
  const ranked = [...testable].sort((left, right) => left.pValue! - right.pValue!);
  let largestPassingRank = 0;
  ranked.forEach((test, index) => {
    if (test.pValue! <= (alpha * (index + 1)) / ranked.length) largestPassingRank = index + 1;
  });
  ranked.forEach((test, index) => {
    test.correctedThreshold = round((alpha * (index + 1)) / ranked.length, 5);
    test.significant = index + 1 <= largestPassingRank;
  });
  for (const test of tests) {
    if (!testable.includes(test)) { test.correctedThreshold = null; test.significant = false; }
    test.verdict = !test.sufficientSample ? "표본 부족 — 검정하지 않음"
      : test.significant ? "차이 있음"
        : test.significantUncorrected ? `보정 전에는 유의했으나 ${testable.length}개 검정을 감안하면 우연으로 설명된다`
          : test.minimumDetectableEffectPts === null ? "판정 불가"
            : `차이 없음 — 이 표본은 ${round(test.minimumDetectableEffectPts, 1)}%p 이상의 진짜 차이라면 잡아냈을 크기`;
  }
  return tests;
}

export type DirectionOptions = {
  targetPct: number;
  gapThresholdPct: number;
  /** Sessions at or above this relative volume are "heavy". Null skips the split. */
  volumeThreshold: number | null;
};

export function buildDirectionStudy(inputs: DirectionInput[], symbol: string, options: DirectionOptions): DirectionStudy {
  const { targetPct, gapThresholdPct, volumeThreshold } = options;
  const rows = classifyRows(inputs, targetPct);
  const gapUp = rows.filter((row) => row.gapPct !== null && row.gapPct >= gapThresholdPct);
  const gapDown = rows.filter((row) => row.gapPct !== null && row.gapPct <= -gapThresholdPct);
  const gapFlat = rows.filter((row) => row.gapPct !== null && Math.abs(row.gapPct) < gapThresholdPct);

  const all = summarizeBucket("전체", rows);
  const upBucket = summarizeBucket(`갭 상승 ≥ ${gapThresholdPct}%`, gapUp);
  const downBucket = summarizeBucket(`갭 하락 ≤ -${gapThresholdPct}%`, gapDown);
  const buckets = [all, upBucket, downBucket, summarizeBucket(`갭 |${gapThresholdPct}%| 미만`, gapFlat)];
  const tests: DirectionTest[] = [testPair("갭 방향 → 방향", "direction", upBucket, downBucket)];

  if (volumeThreshold !== null) {
    const heavy = (list: DirectionRow[]) => list.filter((row) => row.relativeVolume !== null && row.relativeVolume >= volumeThreshold);
    const light = (list: DirectionRow[]) => list.filter((row) => row.relativeVolume !== null && row.relativeVolume < volumeThreshold);
    const heavyUp = summarizeBucket(`갭 상승 + 거래량 ≥ ${volumeThreshold}x`, heavy(gapUp));
    const heavyDown = summarizeBucket(`갭 하락 + 거래량 ≥ ${volumeThreshold}x`, heavy(gapDown));
    const lightUp = summarizeBucket(`갭 상승 + 거래량 < ${volumeThreshold}x`, light(gapUp));
    const lightDown = summarizeBucket(`갭 하락 + 거래량 < ${volumeThreshold}x`, light(gapDown));
    buckets.push(heavyUp, lightUp, heavyDown, lightDown);
    tests.push(testPair("갭 방향 → 방향 · 거래량 많은 날만", "direction", heavyUp, heavyDown));
    tests.push(testPair("갭 방향 → 방향 · 거래량 적은 날만", "direction", lightUp, lightDown));
    // Does volume add anything *beyond* the gap? Only a same-direction split can
    // answer that; comparing heavy-up against light-down would confound the two.
    tests.push(testPair("갭 상승일 내 거래량 효과", "direction", heavyUp, lightUp));
    tests.push(testPair("갭 하락일 내 거래량 효과", "direction", heavyDown, lightDown));
    // Volume may say nothing about which way the day goes and still say plenty
    // about whether it goes one way at all. A rule that trades a stop cares
    // about both, and the second question is answered on the same sessions.
    const heavyAll = summarizeBucket(`거래량 ≥ ${volumeThreshold}x`, heavy(rows));
    const lightAll = summarizeBucket(`거래량 < ${volumeThreshold}x`, light(rows));
    buckets.push(heavyAll, lightAll);
    tests.push(testPair("거래량 → 휩쏘 비율", "whipsaw", heavyAll, lightAll));
  }

  const notes: string[] = [];
  notes.push(`"방향이 결정된 날"은 한쪽만 ${targetPct}%에 도달한 날이다. 이 날들은 봉의 선후와 무관하게 결과가 정해지므로 일봉으로도 정직하게 셀 수 있다.`);
  notes.push(`양방향 모두 도달한 휩쏘는 방향 판정에서 제외한다. 그 날의 승패는 고가와 저가 중 무엇이 먼저 찍혔는지에 달렸고 일봉은 그것을 말해주지 않는다. 전체 대비 휩쏘 비율은 ${all.whipsawRatePct}%다.`);
  notes.push("상방 비중 50%는 우위가 없다는 뜻이다. 갭 상승일과 갭 하락일의 상방 비중 차이가 이 검정의 대상이다.");
  notes.push("relativeVolume은 호출자가 진입 전에 알 수 있는 값으로 채워야 한다. 당일 전체 거래량은 장 마감 후에야 알 수 있으므로 절대 쓰지 않는다.");
  if (tests.some((test) => !test.sufficientSample)) notes.push(`방향 결정 세션이 ${MIN_TESTABLE_SESSIONS}개 미만인 조합은 검정하지 않는다.`);

  finalizeTests(tests);
  notes.push(`한 번의 호출에서 ${tests.filter((test) => test.sufficientSample).length}개 검정을 같은 데이터로 돌렸으므로 Benjamini-Hochberg 보정을 적용했다.`);
  notes.push(`비용 기준: ${describeCosts()}`);

  return {
    symbol, targetPct, gapThresholdPct, volumeThreshold,
    period: { from: rows[0]?.date ?? "", to: rows.at(-1)?.date ?? "", sessions: rows.length },
    buckets, tests, rows, notes,
  };
}

/** Prior-session volume against its own trailing median — a pre-open volume signal. */
export function priorRelativeVolume(volumes: number[], index: number, lookback = 20) {
  if (index < 2) return null;
  const window = volumes.slice(Math.max(0, index - 1 - lookback), index - 1).filter((value) => value > 0);
  if (window.length < 5) return null;
  const baseline = median(window);
  if (!baseline) return null;
  return round(volumes[index - 1] / baseline, 3);
}
