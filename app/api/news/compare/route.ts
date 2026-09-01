import { type PriceRow } from "../../../../lib/market-data";
import { loadDailyRows } from "../../../../lib/price-cache";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TESTS = 100;

type ComparisonInput = {
  id: string;
  periodStart: string;
  periodEnd: string;
  anchorDate: string;
  anchorLabel: string;
  overallScore: number;
  overallLabel: string;
  articleCount: number;
};

function shiftDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function percent(from: number, to: number) {
  if (!from) return null;
  return Number((((to / from) - 1) * 100).toFixed(3));
}

function pointAt(rows: PriceRow[], index: number) {
  return index >= 0 && index < rows.length ? rows[index] : null;
}

function marketReaction(rows: PriceRow[], anchorDate: string) {
  const latest = rows.at(-1);
  if (!latest || anchorDate > latest.date) return null;
  let eventIndex = -1;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].date <= anchorDate) eventIndex = index;
  }
  const event = pointAt(rows, eventIndex);
  const previous = pointAt(rows, eventIndex - 1);
  if (!event || !previous) return null;

  const prePrevious = pointAt(rows, eventIndex - 2);
  const next = pointAt(rows, eventIndex + 1);
  const third = pointAt(rows, eventIndex + 3);
  const preDayPct = prePrevious ? percent(prePrevious.close, previous.close) : null;
  const eventDayPct = percent(previous.close, event.close);

  return {
    effectiveDate: event.date,
    previousDate: previous.date,
    preDayPct,
    eventGapPct: percent(previous.close, event.open),
    eventIntradayPct: percent(event.open, event.close),
    eventDayPct,
    changeVsPrePct: preDayPct === null || eventDayPct === null ? null : Number((eventDayPct - preDayPct).toFixed(3)),
    next1DPct: next ? percent(event.close, next.close) : null,
    post3DPct: third ? percent(event.close, third.close) : null,
    normalizedPath: [-3, -2, -1, 0, 1, 2, 3].map((offset) => {
      const point = pointAt(rows, eventIndex + offset);
      return point ? {
        offset,
        date: point.date,
        value: Number(((point.close / previous.close) * 100).toFixed(3)),
      } : null;
    }).filter((point): point is { offset: number; date: string; value: number } => point !== null),
  };
}

function validInput(value: unknown): value is ComparisonInput {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && typeof item.anchorLabel === "string"
    && DATE_PATTERN.test(String(item.periodStart ?? ""))
    && DATE_PATTERN.test(String(item.periodEnd ?? ""))
    && DATE_PATTERN.test(String(item.anchorDate ?? ""))
    && Number.isFinite(Number(item.overallScore));
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as { tests?: unknown[] };
  const tests = (payload.tests ?? []).filter(validInput).slice(0, MAX_TESTS);
  if (tests.length < 2) {
    return Response.json({ error: "비교할 서로 다른 날짜 범위가 2개 이상 필요합니다." }, { status: 400 });
  }

  let from = tests[0].anchorDate;
  let to = tests[0].anchorDate;
  for (const test of tests) {
    if (test.anchorDate < from) from = test.anchorDate;
    if (test.anchorDate > to) to = test.anchorDate;
  }
  const windowStart = shiftDays(from, -14);
  const windowEnd = shiftDays(to, 14);

  // Fetch sequentially because both providers may throttle a shared Worker IP.
  const nasdaqLoad = await loadDailyRows("^IXIC", windowStart, windowEnd);
  const nyseLoad = await loadDailyRows("^NYA", windowStart, windowEnd);

  const results = tests.map((test) => ({
    ...test,
    markets: {
      nasdaq: marketReaction(nasdaqLoad.rows, test.anchorDate),
      nyse: marketReaction(nyseLoad.rows, test.anchorDate),
    },
  }));

  return Response.json({
    results,
    methodology: {
      anchor: "저장된 발표 예정일이 있으면 해당 일자, 없으면 뉴스 범위 종료일을 사용합니다. 비거래일이면 그 이전 마지막 거래일로 맞춥니다.",
      preDay: "이벤트 전 거래일의 종가 대비 일간 수익률(D-2 종가 → D-1 종가)",
      eventDay: "이벤트 당일 총수익률(D-1 종가 → D0 종가)",
      normalization: "모든 경로는 이벤트 전 거래일 종가(D-1)를 100으로 정규화합니다.",
    },
    sources: {
      nasdaq: { origin: nasdaqLoad.origin, reason: nasdaqLoad.reason },
      nyse: { origin: nyseLoad.origin, reason: nyseLoad.reason },
    },
  });
}
