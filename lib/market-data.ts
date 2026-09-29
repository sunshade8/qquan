import { env } from "cloudflare:workers";
import { fetchMassiveIntradayWindow, massiveConfigured } from "./massive.ts";

export type PriceRow = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export class MarketProviderError extends Error {
  constructor(
    public readonly provider: "toss" | "yahoo" | "fred",
    public readonly code: "not_configured" | "ip_allowlist" | "auth" | "rate_limit" | "not_found" | "upstream",
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

type YahooChart = {
  chart?: {
    result?: Array<{
      meta?: { gmtoffset?: number };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    }>;
    error?: { description?: string } | null;
  };
};

export type EventWindow = {
  symbol: string;
  name: string;
  eventDate: string;
  previousSession: { date: string; openToClosePct: number } | null;
  eventSession: { date: string; gapPct: number | null; openToClosePct: number } | null;
  preOpen1H: { startET: "08:30"; endET: "09:30"; returnPct: number; interval: "30m" } | null;
  limitation: string | null;
};

export type IntradayInterval = "1m" | "5m" | "15m" | "60m";
/**
 * One intraday bar. `close` alone answers "where was price at time T", but any
 * rule written on candles — an opening range, a body breakout, a fair value gap,
 * a stop that sits under a wick — needs the full OHLC, so the fetcher carries it.
 */
export type IntradayPoint = { timestamp: number; date: string; time: string; close: number; open: number; high: number; low: number; volume: number };

export type IntradayHistory = {
  points: IntradayPoint[];
  provider: "Massive" | "Yahoo Finance";
  feed: "sip" | "iex" | null;
  availableSince: string | null;
  historicalDelayMinutes: number | null;
  dataRecency: "end_of_day" | "delayed" | "real_time" | null;
  fallbackReason: string | null;
};

type TossToken = { access_token?: string; expires_in?: number; error?: string; error_description?: string };
type TossEnvelope<T> = { result?: T; error?: { code?: string; message?: string } };
type TossCandle = {
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
};
type TossCandlePage = { candles?: TossCandle[]; nextBefore?: string | null };
type TossPrice = { symbol: string; timestamp: string; lastPrice: string; currency: string };
type TossLevel = { price: string; volume: string };
type TossOrderbook = { timestamp: string; currency: string; asks?: TossLevel[]; bids?: TossLevel[] };
type TossTrade = { price: string; volume: string; timestamp: string; currency: string };
type TossSession = { startTime: string; endTime: string } | null;
type TossMarketDay = {
  date: string;
  dayMarket: TossSession;
  preMarket: TossSession;
  regularMarket: TossSession;
  afterMarket: TossSession;
};
type TossCalendar = {
  today?: TossMarketDay;
  previousBusinessDay?: TossMarketDay;
  nextBusinessDay?: TossMarketDay;
};

export type BrokerSnapshot = {
  available: boolean;
  provider: "Toss Securities";
  symbol: string;
  price?: number;
  timestamp?: string;
  currency?: string;
  bid?: number | null;
  ask?: number | null;
  spreadPct?: number | null;
  recentTrades?: Array<{ price: number; volume: number; timestamp: string }>;
  session?: { code: "day" | "pre" | "regular" | "after" | "closed"; label: string; nextOpen?: string };
  reason?: string;
  code?: MarketProviderError["code"];
};

const TOSS_BASE_URL = "https://openapi.tossinvest.com";
let tokenCache: { value: string; expiresAt: number } | null = null;
let tokenRequest: Promise<string> | null = null;

function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

function tossCredentials() {
  const bindings = runtimeEnv();
  return {
    clientId: bindings.TOSS_CLIENT_ID ?? process.env.TOSS_CLIENT_ID,
    clientSecret: bindings.TOSS_CLIENT_SECRET ?? process.env.TOSS_CLIENT_SECRET,
  };
}

async function issueTossToken() {
  const { clientId, clientSecret } = tossCredentials();
  if (!clientId || !clientSecret) {
    throw new MarketProviderError("toss", "not_configured", "토스 API 서버 키가 연결되지 않았습니다.", 503);
  }

  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  const response = await fetch(`${TOSS_BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => ({})) as TossToken;
  if (!response.ok || !payload.access_token) {
    const ipBlocked = response.status === 403 || /IP address not allowed/i.test(payload.error_description ?? "");
    throw new MarketProviderError(
      "toss",
      ipBlocked ? "ip_allowlist" : response.status === 401 ? "auth" : response.status === 429 ? "rate_limit" : "upstream",
      ipBlocked ? "토스 API가 현재 서버 IP를 허용하지 않았습니다." : "토스 API 인증에 실패했습니다.",
      response.status,
    );
  }
  tokenCache = { value: payload.access_token, expiresAt: Date.now() + Math.max(60, (payload.expires_in ?? 86400) - 120) * 1000 };
  return payload.access_token;
}

async function getTossToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.value;
  if (!tokenRequest) tokenRequest = issueTossToken().finally(() => { tokenRequest = null; });
  return tokenRequest;
}

/**
 * The same client-credentials token the price calls use, for the order adapter
 * in `lib/toss-orders.ts`. Exported rather than duplicated so one token cache
 * serves both and a 401 invalidates it once.
 */
export async function tossAccessToken() {
  return getTossToken();
}

export const TOSS_API_BASE = TOSS_BASE_URL;

/** Clears the cached token after an auth failure on a non-price endpoint. */
export function invalidateTossToken() {
  tokenCache = null;
}

async function tossGet<T>(path: string, params: Record<string, string>) {
  const token = await getTossToken();
  const url = new URL(path, TOSS_BASE_URL);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => ({})) as TossEnvelope<T>;
  if (!response.ok || payload.result === undefined) {
    if (response.status === 401) tokenCache = null;
    const code = response.status === 403 ? "ip_allowlist" : response.status === 401 ? "auth" : response.status === 429 ? "rate_limit" : response.status === 404 ? "not_found" : "upstream";
    const message = code === "ip_allowlist" ? "토스 API가 현재 서버 IP를 허용하지 않았습니다." : code === "rate_limit" ? "토스 시세 호출 한도를 잠시 초과했습니다." : code === "not_found" ? "토스에서 이 종목을 찾지 못했습니다." : "토스 시세를 가져오지 못했습니다.";
    throw new MarketProviderError("toss", code, message, response.status);
  }
  return payload.result;
}

function validNumber(value: string | number | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function fetchYahooHistory(symbol: string) {
  const sourceUrl = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  sourceUrl.searchParams.set("range", "10y");
  sourceUrl.searchParams.set("interval", "1d");
  sourceUrl.searchParams.set("events", "div,splits");
  sourceUrl.searchParams.set("includeAdjustedClose", "true");

  const response = await fetch(sourceUrl, { headers: { "user-agent": "Mozilla/5.0 QQuant personal research" } });
  if (!response.ok) throw new MarketProviderError("yahoo", "upstream", "Yahoo Finance 데이터를 가져오지 못했습니다.", response.status);

  const payload = await response.json() as YahooChart;
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
  if (!quote || !timestamps.length) throw new MarketProviderError("yahoo", "not_found", payload.chart?.error?.description ?? "Yahoo Finance에 데이터가 없습니다.", 404);

  return timestamps.flatMap((timestamp, index): PriceRow[] => {
    const rawOpen = quote.open?.[index];
    const rawHigh = quote.high?.[index];
    const rawLow = quote.low?.[index];
    const rawClose = quote.close?.[index];
    const volume = quote.volume?.[index];
    if ([rawOpen, rawHigh, rawLow, rawClose, volume].some((value) => value === null || value === undefined)) return [];
    const adjustment = adjusted[index] && rawClose ? adjusted[index]! / rawClose : 1;
    return [{
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      open: Number((rawOpen! * adjustment).toFixed(6)),
      high: Number((rawHigh! * adjustment).toFixed(6)),
      low: Number((rawLow! * adjustment).toFixed(6)),
      close: Number((rawClose! * adjustment).toFixed(6)),
      volume: volume!,
    }];
  });
}

// Yahoo throttles by egress IP and the deployed Worker shares that IP with
// other traffic, so a 429 there is effectively permanent for the request.
// Keeping each call to the window we actually need — instead of ten years of
// daily bars — is what keeps us under the limit.
const YAHOO_HOSTS = ["query2", "query1"] as const;
const YAHOO_HEADERS = {
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function epochSeconds(date: string, dayOffset = 0) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + dayOffset);
  return Math.floor(value.getTime() / 1000);
}

function rowsFromChart(payload: YahooChart): PriceRow[] {
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
  if (!quote || !timestamps.length) return [];

  return timestamps.flatMap((timestamp, index): PriceRow[] => {
    const rawOpen = quote.open?.[index];
    const rawHigh = quote.high?.[index];
    const rawLow = quote.low?.[index];
    const rawClose = quote.close?.[index];
    const rawVolume = quote.volume?.[index];
    if ([rawOpen, rawHigh, rawLow, rawClose].some((value) => value === null || value === undefined)) return [];
    const adjustment = adjusted[index] && rawClose ? adjusted[index]! / rawClose : 1;
    return [{
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      open: Number((rawOpen! * adjustment).toFixed(6)),
      high: Number((rawHigh! * adjustment).toFixed(6)),
      low: Number((rawLow! * adjustment).toFixed(6)),
      close: Number((rawClose! * adjustment).toFixed(6)),
      // Index symbols report a null volume on some sessions; that must not
      // discard an otherwise complete bar.
      volume: rawVolume ?? 0,
    }];
  });
}

/** Daily bars for one bounded window. Far cheaper than `fetchYahooHistory`. */
export async function fetchYahooWindow(symbol: string, from: string, to: string) {
  let lastError: MarketProviderError | null = null;

  for (const host of YAHOO_HOSTS) {
    const sourceUrl = new URL(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    sourceUrl.searchParams.set("period1", String(epochSeconds(from)));
    sourceUrl.searchParams.set("period2", String(epochSeconds(to, 1)));
    sourceUrl.searchParams.set("interval", "1d");
    sourceUrl.searchParams.set("includeAdjustedClose", "true");

    let response: Response;
    try {
      response = await fetch(sourceUrl, { headers: YAHOO_HEADERS });
    } catch {
      lastError = new MarketProviderError("yahoo", "upstream", "Yahoo Finance에 연결하지 못했습니다.", 502);
      continue;
    }
    if (response.status === 429) {
      lastError = new MarketProviderError("yahoo", "rate_limit", "Yahoo Finance 호출 한도를 초과했습니다.", 429);
      continue;
    }
    if (!response.ok) {
      lastError = new MarketProviderError("yahoo", "upstream", "Yahoo Finance 데이터를 가져오지 못했습니다.", response.status);
      continue;
    }

    const payload = await response.json().catch(() => ({})) as YahooChart;
    const rows = rowsFromChart(payload);
    if (rows.length) return rows;
    lastError = new MarketProviderError("yahoo", "not_found", payload.chart?.error?.description ?? "Yahoo Finance에 해당 구간 데이터가 없습니다.", 404);
  }

  throw lastError ?? new MarketProviderError("yahoo", "upstream", "Yahoo Finance 데이터를 가져오지 못했습니다.");
}

/** Bounded extended-hours bars for event studies. Yahoo limits how far back fine intervals are available. */
export async function fetchYahooIntradayWindow(symbol: string, from: string, to: string, interval: IntradayInterval): Promise<IntradayPoint[]> {
  let lastError: MarketProviderError | null = null;
  for (const host of YAHOO_HOSTS) {
    const sourceUrl = new URL(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    sourceUrl.searchParams.set("period1", String(epochSeconds(from)));
    sourceUrl.searchParams.set("period2", String(epochSeconds(to, 1)));
    sourceUrl.searchParams.set("interval", interval);
    sourceUrl.searchParams.set("includePrePost", "true");
    sourceUrl.searchParams.set("events", "div,splits");
    let response: Response;
    try {
      response = await fetch(sourceUrl, { headers: YAHOO_HEADERS });
    } catch {
      lastError = new MarketProviderError("yahoo", "upstream", "Yahoo Finance 분봉 데이터에 연결하지 못했습니다.", 502);
      continue;
    }
    if (!response.ok) {
      lastError = new MarketProviderError(
        "yahoo",
        response.status === 429 ? "rate_limit" : response.status === 404 ? "not_found" : "upstream",
        response.status === 429 ? "Yahoo Finance 분봉 호출 한도를 초과했습니다." : "Yahoo Finance 분봉 데이터를 가져오지 못했습니다.",
        response.status,
      );
      continue;
    }
    const payload = await response.json().catch(() => ({})) as YahooChart;
    const result = payload.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0];
    const closes = quote?.close ?? [];
    const opens = quote?.open ?? [];
    const highs = quote?.high ?? [];
    const lows = quote?.low ?? [];
    const volumes = quote?.volume ?? [];
    const points = timestamps.flatMap((timestamp, index): IntradayPoint[] => {
      const close = closes[index];
      if (close === null || close === undefined || !Number.isFinite(close)) return [];
      // A bar missing part of its OHLC is dropped rather than patched with the
      // close: a synthetic high/low would invent the very wick a stop reads.
      const open = opens[index];
      const high = highs[index];
      const low = lows[index];
      if (![open, high, low].every((value) => typeof value === "number" && Number.isFinite(value))) return [];
      const eastern = newYorkDateTime(timestamp);
      return [{ timestamp, date: eastern.date, time: eastern.time, close, open: open as number, high: high as number, low: low as number, volume: Number(volumes[index]) || 0 }];
    });
    if (points.length) return points;
    lastError = new MarketProviderError("yahoo", "not_found", "해당 구간의 분봉 데이터가 없습니다.", 404);
  }
  throw lastError ?? new MarketProviderError("yahoo", "upstream", "Yahoo Finance 분봉 데이터를 가져오지 못했습니다.");
}

function calendarDays(from: string, to: string) {
  return Math.ceil((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
}

/**
 * Preferred intraday source. Massive removes Yahoo's 59-day ceiling when a key
 * are configured; recent, bounded requests still degrade to Yahoo so a provider
 * outage does not erase the working research path that existed before it.
 */
export async function fetchIntradayWindow(
  symbol: string,
  from: string,
  to: string,
  interval: IntradayInterval,
  options: { session?: "all" | "regular"; maxBars?: number } = {},
): Promise<IntradayHistory> {
  let fallbackReason: string | null = null;
  if (massiveConfigured()) {
    try {
      const history = await fetchMassiveIntradayWindow(symbol, from, to, interval, options);
      return {
        points: history.points,
        provider: history.provider,
        feed: null,
        availableSince: history.availableFrom,
        historicalDelayMinutes: null,
        dataRecency: history.dataRecency,
        fallbackReason: null,
      };
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : "Massive 분봉 조회 실패";
    }
  }

  const yahooLimitDays = interval === "1m" ? 7 : 59;
  if (calendarDays(from, to) > yahooLimitDays) {
    throw new Error(fallbackReason ?? `Massive API 키가 없어 ${interval} 분봉은 최근 ${yahooLimitDays}일만 조회할 수 있습니다.`);
  }
  const points = await fetchYahooIntradayWindow(symbol, from, to, interval);
  return {
    points: options.session === "regular" ? points.filter((point) => point.time >= "09:30" && point.time < "16:00") : points,
    provider: "Yahoo Finance",
    feed: null,
    availableSince: null,
    historicalDelayMinutes: null,
    dataRecency: null,
    fallbackReason,
  };
}

function percentChange(from: number, to: number) {
  return Number((((to / from) - 1) * 100).toFixed(3));
}

function newYorkDateTime(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp * 1000));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${pick("year")}-${pick("month")}-${pick("day")}`, time: `${pick("hour")}:${pick("minute")}` };
}

async function fetchYahooPreOpen(symbol: string, eventDate: string) {
  const start = new Date(`${eventDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(`${eventDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 2);
  const sourceUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  sourceUrl.searchParams.set("period1", String(Math.floor(start.getTime() / 1000)));
  sourceUrl.searchParams.set("period2", String(Math.floor(end.getTime() / 1000)));
  sourceUrl.searchParams.set("interval", "30m");
  sourceUrl.searchParams.set("includePrePost", "true");
  const response = await fetch(sourceUrl, { headers: { "user-agent": "Mozilla/5.0 QQuant personal research" } });
  if (!response.ok) return null;
  const payload = await response.json() as YahooChart;
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  let at830: number | null = null;
  let at930: number | null = null;
  timestamps.forEach((timestamp, index) => {
    const point = newYorkDateTime(timestamp);
    const close = closes[index];
    if (point.date !== eventDate || close === null || close === undefined) return;
    if (point.time === "08:00") at830 = close;
    if (point.time === "09:00") at930 = close;
  });
  return at830 && at930 ? percentChange(at830, at930) : null;
}

export async function fetchYahooEventWindow(symbol: string, name: string, eventDate: string): Promise<EventWindow> {
  const [dailyResult, preOpenResult] = await Promise.allSettled([
    fetchYahooHistory(symbol),
    fetchYahooPreOpen(symbol, eventDate),
  ]);
  const rows = dailyResult.status === "fulfilled" ? dailyResult.value : [];
  const eventIndex = rows.findIndex((row) => row.date === eventDate);
  const event = eventIndex >= 0 ? rows[eventIndex] : null;
  const previous = eventIndex > 0 ? rows[eventIndex - 1] : null;
  const preOpen = preOpenResult.status === "fulfilled" ? preOpenResult.value : null;
  return {
    symbol, name, eventDate,
    previousSession: previous ? { date: previous.date, openToClosePct: percentChange(previous.open, previous.close) } : null,
    eventSession: event ? { date: event.date, gapPct: previous ? percentChange(previous.close, event.open) : null, openToClosePct: percentChange(event.open, event.close) } : null,
    preOpen1H: preOpen === null ? null : { startET: "08:30", endET: "09:30", returnPct: preOpen, interval: "30m" },
    limitation: event ? (preOpen === null ? "해당 날짜의 확장시간 30분봉이 없어 개장 전 1시간 수익률은 계산하지 못했습니다." : null) : "해당 날짜가 비거래일이거나 일봉 데이터가 아직 없습니다.",
  };
}

export async function fetchTossHistory(symbol: string) {
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 10);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const byDate = new Map<string, PriceRow>();
  let before: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const params: Record<string, string> = { symbol, interval: "1d", count: "200", adjusted: "true" };
    if (before) params.before = before;
    const result = await tossGet<TossCandlePage>("/api/v1/candles", params);
    const candles = result.candles ?? [];
    for (const candle of candles) {
      const date = candle.timestamp.slice(0, 10);
      const open = validNumber(candle.openPrice);
      const high = validNumber(candle.highPrice);
      const low = validNumber(candle.lowPrice);
      const close = validNumber(candle.closePrice);
      const volume = validNumber(candle.volume);
      if (date >= cutoffDate && open !== null && high !== null && low !== null && close !== null && volume !== null) {
        byDate.set(date, { date, open, high, low, close, volume });
      }
    }
    const oldest = candles.at(-1)?.timestamp.slice(0, 10);
    if (!result.nextBefore || !candles.length || (oldest && oldest < cutoffDate)) break;
    before = result.nextBefore;
  }

  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) throw new MarketProviderError("toss", "not_found", "토스에서 일봉 데이터를 찾지 못했습니다.", 404);
  return rows;
}

function easternDate() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts();
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function resolveSession(calendar: TossCalendar) {
  const now = Date.now();
  const labels = [
    ["dayMarket", "day", "데이마켓"],
    ["preMarket", "pre", "프리마켓"],
    ["regularMarket", "regular", "정규장"],
    ["afterMarket", "after", "애프터마켓"],
  ] as const;
  const days = [calendar.today, calendar.previousBusinessDay].filter(Boolean) as TossMarketDay[];
  for (const day of days) {
    for (const [key, code, label] of labels) {
      const session = day[key];
      if (session && new Date(session.startTime).getTime() <= now && now < new Date(session.endTime).getTime()) return { code, label };
    }
  }
  const nextSessions = [calendar.today, calendar.nextBusinessDay]
    .filter(Boolean)
    .flatMap((day) => labels.map(([key]) => day![key]).filter(Boolean) as Exclude<TossSession, null>[])
    .filter((session) => new Date(session.startTime).getTime() > now)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  return { code: "closed" as const, label: "장 마감", nextOpen: nextSessions[0]?.startTime };
}

export async function fetchTossSnapshot(symbol: string): Promise<BrokerSnapshot> {
  try {
    const [prices, orderbook, trades, calendar] = await Promise.all([
      tossGet<TossPrice[]>("/api/v1/prices", { symbols: symbol }),
      tossGet<TossOrderbook>("/api/v1/orderbook", { symbol }),
      tossGet<TossTrade[]>("/api/v1/trades", { symbol, count: "5" }),
      tossGet<TossCalendar>("/api/v1/market-calendar/US", { date: easternDate() }),
    ]);
    const quote = prices[0];
    if (!quote) throw new MarketProviderError("toss", "not_found", "토스에서 현재가를 찾지 못했습니다.", 404);
    const price = validNumber(quote.lastPrice);
    const ask = validNumber(orderbook.asks?.[0]?.price);
    const bid = validNumber(orderbook.bids?.[0]?.price);
    const midpoint = ask !== null && bid !== null ? (ask + bid) / 2 : null;
    return {
      available: true,
      provider: "Toss Securities",
      symbol,
      price: price ?? undefined,
      timestamp: quote.timestamp,
      currency: quote.currency,
      ask,
      bid,
      spreadPct: midpoint ? ((ask! - bid!) / midpoint) * 100 : null,
      recentTrades: trades.map((trade) => ({ price: Number(trade.price), volume: Number(trade.volume), timestamp: trade.timestamp })),
      session: resolveSession(calendar),
    };
  } catch (error) {
    const providerError = error instanceof MarketProviderError ? error : new MarketProviderError("toss", "upstream", "토스 시세를 가져오지 못했습니다.");
    return { available: false, provider: "Toss Securities", symbol, reason: providerError.message, code: providerError.code };
  }
}

/**
 * The newest Toss 1-minute candles (up to 200 a call), newest first as Toss
 * returns them. `before` pages back; each candle's timestamp is its *end*.
 * Used by the live trading runner to build the same 5-minute bars the backtest
 * decides on.
 */
export async function fetchTossMinuteCandles(symbol: string, options: { count?: number; before?: string | null } = {}) {
  const params: Record<string, string> = { symbol, interval: "1m", count: String(Math.max(1, Math.min(200, options.count ?? 200))) };
  if (options.before) params.before = options.before;
  const result = await tossGet<TossCandlePage>("/api/v1/candles", params);
  return { candles: result.candles ?? [], nextBefore: result.nextBefore ?? null };
}

/** Last price, plus the top of book when an order is about to be priced off it. */
export async function fetchTossQuote(symbol: string, options: { withBook?: boolean } = {}) {
  const [prices, book] = await Promise.all([
    tossGet<TossPrice[]>("/api/v1/prices", { symbols: symbol }),
    options.withBook ? tossGet<TossOrderbook>("/api/v1/orderbook", { symbol }) : Promise.resolve(null),
  ]);
  const price = validNumber(prices[0]?.lastPrice);
  if (price === null || price <= 0) throw new MarketProviderError("toss", "not_found", `토스에서 ${symbol} 현재가를 찾지 못했습니다.`, 404);
  return {
    price,
    bid: validNumber(book?.bids?.[0]?.price),
    ask: validNumber(book?.asks?.[0]?.price),
    timestamp: prices[0]?.timestamp ?? null,
    bookTimestamp: book?.timestamp ?? null,
  };
}

export function providerSummary(rows: PriceRow[]) {
  return { bars: rows.length, start: rows[0]?.date ?? null, end: rows.at(-1)?.date ?? null };
}

/** Broker calendar is authoritative for holidays, early closes and session boundaries. */
export async function fetchTossTradingDay(date: string) {
  const calendar = await tossGet<TossCalendar>("/api/v1/market-calendar/US", { date });
  return [calendar.today, calendar.previousBusinessDay, calendar.nextBusinessDay].find(day => day?.date === date) ?? null;
}
