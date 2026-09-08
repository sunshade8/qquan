import { fetchIntradayWindow, type IntradayInterval, type IntradayPoint } from "../../../../lib/market-data";
import { massiveAvailableFrom, massiveConfigured } from "../../../../lib/massive";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const intervals = new Set<IntradayInterval>(["1m", "5m", "15m", "60m"]);

type Input = { id: string; anchorDate: string; anchorTime: string };

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
  return Math.floor((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
}

function timeMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function percent(from: number, to: number) {
  return Number((((to / from) - 1) * 100).toFixed(3));
}

function atOrBefore(points: IntradayPoint[], minute: number) {
  let match: IntradayPoint | null = null;
  for (const point of points) if (timeMinutes(point.time) <= minute) match = point;
  return match;
}

function reaction(points: IntradayPoint[], anchorDate: string, anchorTime: string) {
  const session = points.filter((point) => point.date === anchorDate).sort((a, b) => a.timestamp - b.timestamp);
  const anchorMinute = timeMinutes(anchorTime);
  const base = atOrBefore(session, anchorMinute);
  if (!base || Math.abs(timeMinutes(base.time) - anchorMinute) > 65) return null;
  const pre = atOrBefore(session, anchorMinute - 60);
  const post = atOrBefore(session, anchorMinute + 60);
  const close = atOrBefore(session.filter((point) => timeMinutes(point.time) >= 570), 960);
  return {
    baseTime: base.time,
    pre60Pct: pre ? percent(pre.close, base.close) : null,
    post60Pct: post && post.timestamp > base.timestamp ? percent(base.close, post.close) : null,
    toRegularClosePct: close && close.timestamp > base.timestamp ? percent(base.close, close.close) : null,
    normalizedPath: session.flatMap((point) => {
      const offsetMinutes = timeMinutes(point.time) - anchorMinute;
      if (offsetMinutes < -120 || offsetMinutes > 450) return [];
      return [{ offsetMinutes, time: point.time, value: Number(((point.close / base.close) * 100).toFixed(3)) }];
    }),
  };
}

function validInput(value: unknown): value is Input {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && DATE_PATTERN.test(String(item.anchorDate ?? "")) && TIME_PATTERN.test(String(item.anchorTime ?? ""));
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({})) as { tests?: unknown[]; market?: string; interval?: string };
  const tests = (payload.tests ?? []).filter(validInput).slice(0, 30);
  const interval = payload.interval as IntradayInterval;
  const market = payload.market === "nyse" ? "nyse" : "nasdaq";
  if (!intervals.has(interval) || !tests.length) return Response.json({ error: "분봉 주기와 비교 날짜가 필요합니다." }, { status: 400 });
  const symbol = market === "nasdaq" ? "QQQ" : "SPY";
  const today = new Date().toISOString().slice(0, 10);
  const hasMassive = massiveConfigured();
  const massiveFloor = massiveAvailableFrom(today);
  const availabilityDays = interval === "1m" ? 7 : interval === "60m" ? 729 : 59;
  const results = [];
  const providers = new Set<string>();
  const massiveEligibleIndexes = new Set(tests.flatMap((test, index) => {
    const age = daysBetween(test.anchorDate, today);
    return age >= 0 && test.anchorDate >= massiveFloor ? [index] : [];
  }).slice(-4));

  for (const [testIndex, test] of tests.entries()) {
    const age = daysBetween(test.anchorDate, today);
    if (age < 0) {
      results.push({ ...test, reaction: null, unavailable: "발표일이 아직 지나지 않았습니다." });
      continue;
    }
    if (hasMassive && test.anchorDate < massiveFloor) {
      results.push({ ...test, reaction: null, unavailable: `Massive Basic 제공 범위(${massiveFloor} 이후)를 벗어났습니다.` });
      continue;
    }
    if (!hasMassive && age > availabilityDays) {
      const yahooRange = interval === "1m" ? "최근 7일" : interval === "60m" ? "약 2년" : "최근 약 60일";
      results.push({ ...test, reaction: null, unavailable: `${interval} Yahoo 제공 범위(${yahooRange})를 벗어났습니다. Massive 키를 연결하면 최근 2년을 조회할 수 있습니다.` });
      continue;
    }
    if (hasMassive && !massiveEligibleIndexes.has(testIndex)) {
      results.push({ ...test, reaction: null, unavailable: "Massive Basic 5회/분 제한으로 이번 실행은 최근 4개 발표만 조회했습니다." });
      continue;
    }
    try {
      const history = await fetchIntradayWindow(symbol, shiftDate(test.anchorDate, -1), shiftDate(test.anchorDate, 1), interval, { maxBars: 20_000 });
      const provider = `${history.provider}${history.feed ? ` ${history.feed.toUpperCase()}` : ""}`;
      providers.add(provider);
      const resolved = reaction(history.points, test.anchorDate, test.anchorTime);
      results.push({ ...test, reaction: resolved, provider, unavailable: resolved ? null : "발표 시각 주변의 확장시간 분봉이 없습니다." });
    } catch (error) {
      results.push({ ...test, reaction: null, unavailable: error instanceof Error ? error.message : "분봉 데이터를 가져오지 못했습니다." });
    }
  }

  return Response.json({
    market,
    symbol,
    interval,
    providers: [...providers],
    results,
    methodology: `QQQ·SPY 확장시간 가격을 사용하며, 발표 시각 직전 이용 가능한 봉을 100으로 정규화합니다. ${hasMassive ? `Massive Basic으로 ${massiveFloor} 이후 이벤트를 조회하며 데이터는 거래일 종가 확정 후 제공됩니다.` : "Massive 미연결 상태라 Yahoo의 제한된 최근 구간만 계산합니다."}`,
  });
}
