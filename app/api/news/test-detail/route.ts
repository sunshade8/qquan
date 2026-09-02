import { type PriceRow } from "../../../../lib/market-data";
import { loadDailyRows } from "../../../../lib/price-cache";
import { MARKET_EVENT_CALENDAR, MARKET_EVENT_CATEGORY_LABELS, type MarketEvent } from "../../../market-calendar-data";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function shiftDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function percent(from: number, to: number) {
  return Number((((to / from) - 1) * 100).toFixed(3));
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return null;
  const average = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + ((value - average) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function summarize(rows: PriceRow[], start: string, end: string) {
  const selected = rows.filter((row) => row.date >= start && row.date <= end);
  if (!selected.length) return null;
  const returns = selected.slice(1).map((row, index) => percent(selected[index].close, row.close));
  let peak = selected[0].close;
  let maxDrawdownPct = 0;
  for (const row of selected) {
    peak = Math.max(peak, row.close);
    maxDrawdownPct = Math.min(maxDrawdownPct, percent(peak, row.close));
  }
  const volatility = standardDeviation(returns);
  return {
    startDate: selected[0].date,
    endDate: selected.at(-1)?.date ?? selected[0].date,
    startClose: selected[0].close,
    endClose: selected.at(-1)?.close ?? selected[0].close,
    returnPct: percent(selected[0].close, selected.at(-1)?.close ?? selected[0].close),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(3)),
    annualizedVolatilityPct: volatility === null ? null : Number((volatility * Math.sqrt(252)).toFixed(3)),
    upDays: returns.filter((value) => value > 0).length,
    downDays: returns.filter((value) => value < 0).length,
    sessions: selected.length,
  };
}

function pointSeries(rows: PriceRow[], start: string, end: string) {
  return rows.map((row, index) => ({
    date: row.date,
    close: row.close,
    dailyReturnPct: index ? percent(rows[index - 1].close, row.close) : null,
    phase: row.date < start ? "pre" : row.date > end ? "post" : "selected",
  }));
}

function eventReaction(rows: PriceRow[], event: MarketEvent) {
  const sessionIndex = rows.findIndex((row) => row.date >= event.date);
  if (sessionIndex < 0) return null;
  const session = rows[sessionIndex];
  const previous = rows[sessionIndex - 1];
  const next = rows[sessionIndex + 1];
  const third = rows[Math.min(sessionIndex + 3, rows.length - 1)];
  return {
    effectiveDate: session.date,
    eventDayPct: previous ? percent(previous.close, session.close) : null,
    next1DPct: next ? percent(session.close, next.close) : null,
    post3DPct: third && third.date !== session.date ? percent(session.close, third.close) : null,
  };
}

function indexResult(symbol: string, name: string, load: Awaited<ReturnType<typeof loadDailyRows>>, start: string, end: string) {
  return {
    symbol,
    name,
    origin: load.origin,
    reason: load.reason,
    points: pointSeries(load.rows, start, end),
    summary: summarize(load.rows, start, end),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const start = url.searchParams.get("start") ?? "";
  const end = url.searchParams.get("end") ?? "";
  if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end) || start > end) {
    return Response.json({ error: "올바른 Test 날짜 범위가 필요합니다." }, { status: 400 });
  }
  const rangeDays = Math.floor((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  if (rangeDays > 93) return Response.json({ error: "상세 차트는 최대 93일 범위까지 지원합니다." }, { status: 400 });

  const chartStart = shiftDays(start, -7);
  const chartEnd = shiftDays(end, 10);
  const [nasdaqLoad, nyseLoad] = await Promise.all([
    loadDailyRows("^IXIC", chartStart, chartEnd),
    loadDailyRows("^NYA", chartStart, chartEnd),
  ]);
  const events = MARKET_EVENT_CALENDAR
    .filter((event) => event.date >= chartStart && event.date <= chartEnd && event.category !== "market")
    .map((event) => ({
      id: event.id,
      date: event.date,
      timeET: event.time,
      title: event.title,
      note: event.note,
      category: event.category,
      categoryLabel: MARKET_EVENT_CATEGORY_LABELS[event.category],
      importance: event.importance,
      source: event.source,
      sourceUrl: event.sourceUrl,
      reactions: {
        nasdaq: eventReaction(nasdaqLoad.rows, event),
        nyse: eventReaction(nyseLoad.rows, event),
      },
    }));

  return Response.json({
    period: { start, end, chartStart, chartEnd },
    indices: {
      nasdaq: indexResult("^IXIC", "NASDAQ Composite", nasdaqLoad, start, end),
      nyse: indexResult("^NYA", "NYSE Composite", nyseLoad, start, end),
    },
    events,
    methodology: "1D 종가 기준. 선택 기간 앞 7일·뒤 10일을 함께 표시하며, 이벤트 반응은 발표일 또는 그 이후 첫 거래일 종가를 기준으로 계산합니다.",
  });
}
