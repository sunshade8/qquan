/**
 * Pure, dependency-free statistics over saved news sentiment Test rows. Shared by
 * the News agents, the Lab tools, and the unit tests.
 */

type Benchmark = { returnPct?: number } | { unavailable?: string } | null;
export type ResearchTest = {
  id: string;
  periodStart: string;
  periodEnd: string;
  overallScore: number;
  techScore: number;
  valueScore: number;
  nasdaq: Benchmark;
  nyse: Benchmark;
  forecastEvents?: Array<{ indicator?: string; scheduledReleaseDate?: string | null; scheduledTimeET?: string | null }>;
};

function valueOf(value: Benchmark) {
  return value && "returnPct" in value && typeof value.returnPct === "number" ? value.returnPct : null;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pearson(left: number[], right: number[]) {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    covariance += (left[index] - leftMean) * (right[index] - rightMean);
    leftVariance += (left[index] - leftMean) ** 2;
    rightVariance += (right[index] - rightMean) ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator ? covariance / denominator : null;
}

function eventRootOf(test: Pick<ResearchTest, "forecastEvents">) {
  const indicator = test.forecastEvents?.[0]?.indicator ?? "";
  if (/cpi|소비자\s*물가/i.test(indicator)) return "CPI";
  if (/pce|개인\s*소비/i.test(indicator)) return "PCE";
  if (/ppi|생산자\s*물가/i.test(indicator)) return "PPI";
  if (/nfp|고용\s*보고서|payroll|jobs/i.test(indicator)) return "NFP";
  if (/fomc|금리\s*결정/i.test(indicator)) return "FOMC";
  if (/gdp/i.test(indicator)) return "GDP";
  if (/ism/i.test(indicator)) return "ISM";
  return indicator ? "기타" : "범위";
}

export function deterministicTestSummary(tests: ResearchTest[]) {
  const usable = tests.flatMap((test) => {
    const nasdaq = valueOf(test.nasdaq);
    const nyse = valueOf(test.nyse);
    return nasdaq === null && nyse === null ? [] : [{ ...test, nasdaq, nyse }];
  });
  const nasdaq = usable.flatMap((test) => test.nasdaq === null ? [] : [test.nasdaq]);
  const nyse = usable.flatMap((test) => test.nyse === null ? [] : [test.nyse]);
  const sentimentComparable = usable.filter((test) => test.nasdaq !== null && Math.sign(test.overallScore) !== 0);
  const aligned = sentimentComparable.filter((test) => Math.sign(test.overallScore) === Math.sign(test.nasdaq!)).length;
  const strong = sentimentComparable.filter((test) => Math.abs(test.overallScore) >= 25);
  const strongAligned = strong.filter((test) => Math.sign(test.overallScore) === Math.sign(test.nasdaq!)).length;
  const nasdaqPairs = usable.filter((test) => test.nasdaq !== null);
  const nysePairs = usable.filter((test) => test.nyse !== null);
  const spreadPairs = usable.filter((test) => test.nasdaq !== null && test.nyse !== null);
  const byEvent = new Map<string, Array<typeof usable[number]>>();
  for (const test of usable) { const key = eventRootOf(test); (byEvent.get(key) ?? byEvent.set(key, []).get(key)!).push(test); }
  return {
    analysisAsOfDate: new Date().toISOString().slice(0, 10),
    totalTests: tests.length,
    usableTests: usable.length,
    averageSentiment: average(usable.map((test) => test.overallScore)),
    medianSentiment: median(usable.map((test) => test.overallScore)),
    averageNasdaqReturnPct: average(nasdaq),
    medianNasdaqReturnPct: median(nasdaq),
    averageNyseReturnPct: average(nyse),
    signAlignmentRatePct: sentimentComparable.length ? (aligned / sentimentComparable.length) * 100 : null,
    signAlignmentSampleSize: sentimentComparable.length,
    strongSignalAlignmentRatePct: strong.length ? (strongAligned / strong.length) * 100 : null,
    strongSignalSampleSize: strong.length,
    sentimentReturnCorrelation: pearson(nasdaqPairs.map((test) => test.overallScore), nasdaqPairs.map((test) => test.nasdaq!)),
    sentimentNyseCorrelation: pearson(nysePairs.map((test) => test.overallScore), nysePairs.map((test) => test.nyse!)),
    techValueSpreadVsIndexSpreadCorrelation: pearson(spreadPairs.map((test) => test.techScore - test.valueScore), spreadPairs.map((test) => test.nasdaq! - test.nyse!)),
    averageTechMinusValue: average(usable.map((test) => test.techScore - test.valueScore)),
    byEvent: [...byEvent.entries()].map(([event, tests]) => {
      const pairs = tests.filter((test) => test.nasdaq !== null && Math.sign(test.overallScore) !== 0);
      return {
        event, tests: tests.length, averageSentiment: average(tests.map((test) => test.overallScore)),
        averageNasdaqReturnPct: average(tests.flatMap((test) => test.nasdaq === null ? [] : [test.nasdaq])),
        signAlignmentRatePct: pairs.length ? (pairs.filter((test) => Math.sign(test.overallScore) === Math.sign(test.nasdaq!)).length / pairs.length) * 100 : null,
      };
    }),
    rows: usable.map((test) => ({
      id: test.id, range: `${test.periodStart}→${test.periodEnd}`,
      event: test.forecastEvents?.[0]?.indicator ?? null, eventRoot: eventRootOf(test),
      eventDate: test.forecastEvents?.[0]?.scheduledReleaseDate ?? test.periodEnd,
      sentiment: test.overallScore, techMinusValue: test.techScore - test.valueScore,
      nasdaqReturnPct: test.nasdaq, nyseReturnPct: test.nyse,
    })),
  };
}
