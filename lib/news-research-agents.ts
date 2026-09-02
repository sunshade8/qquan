import { loadDailyRows } from "@/lib/price-cache";

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
    averageTechMinusValue: average(usable.map((test) => test.techScore - test.valueScore)),
    rows: usable.map((test) => ({
      id: test.id, range: `${test.periodStart}→${test.periodEnd}`,
      event: test.forecastEvents?.[0]?.indicator ?? null,
      eventDate: test.forecastEvents?.[0]?.scheduledReleaseDate ?? test.periodEnd,
      sentiment: test.overallScore, techMinusValue: test.techScore - test.valueScore,
      nasdaqReturnPct: test.nasdaq, nyseReturnPct: test.nyse,
    })),
  };
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function runDeterministicEventBacktest(tests: ResearchTest[], holdingSessions = 3) {
  const dated = tests.flatMap((test) => {
    const eventDate = test.forecastEvents?.[0]?.scheduledReleaseDate ?? test.periodEnd;
    return /^\d{4}-\d{2}-\d{2}$/.test(eventDate ?? "") ? [{ test, eventDate: eventDate! }] : [];
  });
  if (!dated.length) return { trades: [], metrics: null, methodology: "발표일이 연결된 Test가 없습니다." };
  const from = shiftDate(dated.reduce((min, row) => row.eventDate < min ? row.eventDate : min, dated[0].eventDate), -7);
  const to = shiftDate(dated.reduce((max, row) => row.eventDate > max ? row.eventDate : max, dated[0].eventDate), 14);
  const load = await loadDailyRows("QQQ", from, to);
  const trades = dated.flatMap(({ test, eventDate }) => {
    const anchor = load.rows.findIndex((row) => row.date >= eventDate);
    const exit = anchor >= 0 ? Math.min(load.rows.length - 1, anchor + holdingSessions) : -1;
    if (anchor < 0 || exit <= anchor) return [];
    const direction = test.overallScore > 15 ? 1 : test.overallScore < -15 ? -1 : 0;
    const marketReturnPct = ((load.rows[exit].close / load.rows[anchor].close) - 1) * 100;
    return [{
      testId: test.id, eventDate, entryDate: load.rows[anchor].date, exitDate: load.rows[exit].date,
      sentiment: test.overallScore, direction: direction > 0 ? "LONG" : direction < 0 ? "SHORT" : "CASH",
      marketReturnPct, strategyReturnPct: marketReturnPct * direction,
    }];
  });
  const active = trades.filter((trade) => trade.direction !== "CASH");
  let equity = 1;
  let peak = 1;
  let maxDrawdownPct = 0;
  for (const trade of active) {
    equity *= 1 + trade.strategyReturnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.min(maxDrawdownPct, ((equity / peak) - 1) * 100);
  }
  const returns = active.map((trade) => trade.strategyReturnPct);
  return {
    trades,
    metrics: {
      availableEvents: trades.length, activeTrades: active.length, holdingSessions,
      winRatePct: active.length ? (active.filter((trade) => trade.strategyReturnPct > 0).length / active.length) * 100 : null,
      averageReturnPct: average(returns), medianReturnPct: median(returns),
      compoundedReturnPct: (equity - 1) * 100, maxDrawdownPct,
    },
    methodology: "발표일 다음 유효 QQQ 종가를 진입 기준으로 삼고, 감성 점수 > +15는 LONG, < -15는 SHORT, 나머지는 CASH로 분류한 이벤트 단위 검증입니다. 거래비용·슬리피지·중첩 포지션은 아직 반영하지 않습니다.",
  };
}
