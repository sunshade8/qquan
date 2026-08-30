import { env } from "cloudflare:workers";

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
    public readonly provider: "toss" | "yahoo",
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

export function providerSummary(rows: PriceRow[]) {
  return { bars: rows.length, start: rows[0]?.date ?? null, end: rows.at(-1)?.date ?? null };
}
