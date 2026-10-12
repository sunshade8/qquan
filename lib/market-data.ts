import {
  localStockPoints,
  localDailyRows,
  localMinutePage,
} from "./local-market-data.ts";
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
    public readonly provider: "toss" | "yahoo" | "fred",
    public readonly code:
      | "not_configured"
      | "ip_allowlist"
      | "auth"
      | "rate_limit"
      | "not_found"
      | "upstream",
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

export type EventWindow = {
  symbol: string;
  name: string;
  eventDate: string;
  previousSession: { date: string; openToClosePct: number } | null;
  eventSession: {
    date: string;
    gapPct: number | null;
    openToClosePct: number;
  } | null;
  preOpen1H: {
    startET: "08:30";
    endET: "09:30";
    returnPct: number;
    interval: "1m";
  } | null;
  limitation: string | null;
};

export type IntradayInterval = "1m" | "5m" | "15m" | "60m";
/**
 * One intraday bar. `close` alone answers "where was price at time T", but any
 * rule written on candles — an opening range, a body breakout, a fair value gap,
 * a stop that sits under a wick — needs the full OHLC, so the fetcher carries it.
 */
export type IntradayPoint = {
  timestamp: number;
  date: string;
  time: string;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
};

export type IntradayHistory = {
  points: IntradayPoint[];
  provider: "Massive" | "Yahoo Finance";
  feed: "sip" | "iex" | null;
  availableSince: string | null;
  historicalDelayMinutes: number | null;
  dataRecency: "end_of_day" | "delayed" | "real_time" | null;
  fallbackReason: string | null;
};

type TossToken = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};
type TossEnvelope<T> = {
  result?: T;
  error?: { code?: string; message?: string };
};
type TossCandle = {
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
};
type TossCandlePage = { candles?: TossCandle[]; nextBefore?: string | null };
type TossPrice = {
  symbol: string;
  timestamp: string;
  lastPrice: string;
  currency: string;
};
type TossLevel = { price: string; volume: string };
type TossOrderbook = {
  timestamp: string;
  currency: string;
  asks?: TossLevel[];
  bids?: TossLevel[];
};
type TossTrade = {
  price: string;
  volume: string;
  timestamp: string;
  currency: string;
};
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
  session?: {
    code: "day" | "pre" | "regular" | "after" | "closed";
    label: string;
    nextOpen?: string;
  };
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
    throw new MarketProviderError(
      "toss",
      "not_configured",
      "토스 API 서버 키가 연결되지 않았습니다.",
      503,
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetch(`${TOSS_BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as TossToken;
  if (!response.ok || !payload.access_token) {
    const ipBlocked =
      response.status === 403 ||
      /IP address not allowed/i.test(payload.error_description ?? "");
    throw new MarketProviderError(
      "toss",
      ipBlocked
        ? "ip_allowlist"
        : response.status === 401
          ? "auth"
          : response.status === 429
            ? "rate_limit"
            : "upstream",
      ipBlocked
        ? "토스 API가 현재 서버 IP를 허용하지 않았습니다."
        : "토스 API 인증에 실패했습니다.",
      response.status,
    );
  }
  tokenCache = {
    value: payload.access_token,
    expiresAt:
      Date.now() + Math.max(60, (payload.expires_in ?? 86400) - 120) * 1000,
  };
  return payload.access_token;
}

async function getTossToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.value;
  if (!tokenRequest)
    tokenRequest = issueTossToken().finally(() => {
      tokenRequest = null;
    });
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
  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value),
  );
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = (await response.json().catch(() => ({}))) as TossEnvelope<T>;
  if (!response.ok || payload.result === undefined) {
    if (response.status === 401) tokenCache = null;
    const code =
      response.status === 403
        ? "ip_allowlist"
        : response.status === 401
          ? "auth"
          : response.status === 429
            ? "rate_limit"
            : response.status === 404
              ? "not_found"
              : "upstream";
    const message =
      code === "ip_allowlist"
        ? "토스 API가 현재 서버 IP를 허용하지 않았습니다."
        : code === "rate_limit"
          ? "토스 시세 호출 한도를 잠시 초과했습니다."
          : code === "not_found"
            ? "토스에서 이 종목을 찾지 못했습니다."
            : "토스 시세를 가져오지 못했습니다.";
    throw new MarketProviderError("toss", code, message, response.status);
  }
  return payload.result;
}

function validNumber(value: string | number | undefined) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function fetchYahooHistory(symbol: string) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const from = new Date(end);
  from.setUTCFullYear(from.getUTCFullYear() - 5);
  return localDailyRows(
    symbol,
    from.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10),
  );
}

/** Daily bars for one bounded window. Far cheaper than `fetchYahooHistory`. */
export async function fetchYahooWindow(
  symbol: string,
  from: string,
  to: string,
) {
  return localDailyRows(symbol, from, to);
}

/** Bounded extended-hours bars for event studies. Yahoo limits how far back fine intervals are available. */
export async function fetchYahooIntradayWindow(
  symbol: string,
  from: string,
  to: string,
  interval: IntradayInterval,
): Promise<IntradayPoint[]> {
  return localStockPoints(symbol, from, to, interval);
}

/** Local-only historical OHLCV; explicit downloads own provider access. */
export async function fetchIntradayWindow(
  symbol: string,
  from: string,
  to: string,
  interval: IntradayInterval,
  options: { session?: "all" | "regular"; maxBars?: number } = {},
): Promise<IntradayHistory> {
  const points = await localStockPoints(
    symbol,
    from,
    to,
    interval,
    options.session ?? "all",
  );
  return {
    points,
    provider: "Massive",
    feed: null,
    availableSince: from,
    historicalDelayMinutes: null,
    dataRecency: "end_of_day",
    fallbackReason: null,
  };
}

function percentChange(from: number, to: number) {
  return Number(((to / from - 1) * 100).toFixed(3));
}

async function fetchYahooPreOpen(symbol: string, eventDate: string) {
  const points = await localStockPoints(
    symbol,
    eventDate,
    eventDate,
    "1m",
    "all",
  );
  const at830 = points.find(
    (p) => p.date === eventDate && p.time === "08:29",
  )?.close;
  const at930 = points.find(
    (p) => p.date === eventDate && p.time === "09:29",
  )?.close;
  return at830 && at930 ? percentChange(at830, at930) : null;
}

export async function fetchYahooEventWindow(
  symbol: string,
  name: string,
  eventDate: string,
): Promise<EventWindow> {
  const [dailyResult, preOpenResult] = await Promise.allSettled([
    localDailyRows(
      symbol,
      new Date(Date.parse(eventDate) - 30 * 86400000)
        .toISOString()
        .slice(0, 10),
      new Date(Date.parse(eventDate) + 30 * 86400000)
        .toISOString()
        .slice(0, 10),
    ),
    fetchYahooPreOpen(symbol, eventDate),
  ]);
  const rows = dailyResult.status === "fulfilled" ? dailyResult.value : [];
  const eventIndex = rows.findIndex((row) => row.date === eventDate);
  const event = eventIndex >= 0 ? rows[eventIndex] : null;
  const previous = eventIndex > 0 ? rows[eventIndex - 1] : null;
  const preOpen =
    preOpenResult.status === "fulfilled" ? preOpenResult.value : null;
  return {
    symbol,
    name,
    eventDate,
    previousSession: previous
      ? {
          date: previous.date,
          openToClosePct: percentChange(previous.open, previous.close),
        }
      : null,
    eventSession: event
      ? {
          date: event.date,
          gapPct: previous ? percentChange(previous.close, event.open) : null,
          openToClosePct: percentChange(event.open, event.close),
        }
      : null,
    preOpen1H:
      preOpen === null
        ? null
        : {
            startET: "08:30",
            endET: "09:30",
            returnPct: preOpen,
            interval: "1m",
          },
    limitation: event
      ? preOpen === null
        ? "해당 날짜의 확장시간 1분봉이 없어 개장 전 1시간 수익률은 계산하지 못했습니다."
        : null
      : "해당 날짜가 비거래일이거나 일봉 데이터가 아직 없습니다.",
  };
}

export async function fetchTossHistory(symbol: string) {
  return fetchYahooHistory(symbol);
}

function easternDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts();
  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
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
  const days = [calendar.today, calendar.previousBusinessDay].filter(
    Boolean,
  ) as TossMarketDay[];
  for (const day of days) {
    for (const [key, code, label] of labels) {
      const session = day[key];
      if (
        session &&
        new Date(session.startTime).getTime() <= now &&
        now < new Date(session.endTime).getTime()
      )
        return { code, label };
    }
  }
  const nextSessions = [calendar.today, calendar.nextBusinessDay]
    .filter(Boolean)
    .flatMap(
      (day) =>
        labels.map(([key]) => day![key]).filter(Boolean) as Exclude<
          TossSession,
          null
        >[],
    )
    .filter((session) => new Date(session.startTime).getTime() > now)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  return {
    code: "closed" as const,
    label: "장 마감",
    nextOpen: nextSessions[0]?.startTime,
  };
}

export async function fetchTossSnapshot(
  symbol: string,
): Promise<BrokerSnapshot> {
  try {
    const [prices, orderbook, trades, calendar] = await Promise.all([
      tossGet<TossPrice[]>("/api/v1/prices", { symbols: symbol }),
      tossGet<TossOrderbook>("/api/v1/orderbook", { symbol }),
      tossGet<TossTrade[]>("/api/v1/trades", { symbol, count: "5" }),
      tossGet<TossCalendar>("/api/v1/market-calendar/US", {
        date: easternDate(),
      }),
    ]);
    const quote = prices[0];
    if (!quote)
      throw new MarketProviderError(
        "toss",
        "not_found",
        "토스에서 현재가를 찾지 못했습니다.",
        404,
      );
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
      recentTrades: trades.map((trade) => ({
        price: Number(trade.price),
        volume: Number(trade.volume),
        timestamp: trade.timestamp,
      })),
      session: resolveSession(calendar),
    };
  } catch (error) {
    const providerError =
      error instanceof MarketProviderError
        ? error
        : new MarketProviderError(
            "toss",
            "upstream",
            "토스 시세를 가져오지 못했습니다.",
          );
    return {
      available: false,
      provider: "Toss Securities",
      symbol,
      reason: providerError.message,
      code: providerError.code,
    };
  }
}

/**
 * The newest Toss 1-minute candles (up to 200 a call), newest first as Toss
 * returns them. `before` pages back; each candle's timestamp is its *end*.
 * Used by the live trading runner to build the same 5-minute bars the backtest
 * decides on.
 */
export async function fetchTossMinuteCandles(
  symbol: string,
  options: { count?: number; before?: string | null; adjusted?: boolean } = {},
) {
  if (options.before && Date.parse(options.before) < Date.now() - 86400000) {
    const bars = await localMinutePage(
      symbol,
      Date.parse(options.before),
      options.count,
    );
    return {
      candles: bars.map((b) => ({
        timestamp: new Date(b.endMs).toISOString(),
        openPrice: String(b.open),
        highPrice: String(b.high),
        lowPrice: String(b.low),
        closePrice: String(b.close),
        volume: String(b.volume),
      })),
      nextBefore: bars.length
        ? new Date(bars.at(-1)!.startMs).toISOString()
        : null,
    };
  }
  const params: Record<string, string> = {
    symbol,
    interval: "1m",
    count: String(Math.max(1, Math.min(200, options.count ?? 200))),
  };
  if (options.before) params.before = options.before;
  // Toss defaults to split-adjusted; a past session's history needs the prices that actually traded.
  if (options.adjusted !== undefined)
    params.adjusted = String(options.adjusted);
  const result = await tossGet<TossCandlePage>("/api/v1/candles", params);
  return {
    candles: result.candles ?? [],
    nextBefore: result.nextBefore ?? null,
  };
}

/** Last price, plus the top of book when an order is about to be priced off it. */
export async function fetchTossQuote(
  symbol: string,
  options: { withBook?: boolean } = {},
) {
  const [prices, book] = await Promise.all([
    tossGet<TossPrice[]>("/api/v1/prices", { symbols: symbol }),
    options.withBook
      ? tossGet<TossOrderbook>("/api/v1/orderbook", { symbol })
      : Promise.resolve(null),
  ]);
  const price = validNumber(prices[0]?.lastPrice);
  if (price === null || price <= 0)
    throw new MarketProviderError(
      "toss",
      "not_found",
      `토스에서 ${symbol} 현재가를 찾지 못했습니다.`,
      404,
    );
  return {
    price,
    bid: validNumber(book?.bids?.[0]?.price),
    ask: validNumber(book?.asks?.[0]?.price),
    timestamp: prices[0]?.timestamp ?? null,
    bookTimestamp: book?.timestamp ?? null,
  };
}

export function providerSummary(rows: PriceRow[]) {
  return {
    bars: rows.length,
    start: rows[0]?.date ?? null,
    end: rows.at(-1)?.date ?? null,
  };
}

/** Broker calendar is authoritative for holidays, early closes and session boundaries. */
export async function fetchTossTradingDay(date: string) {
  const calendar = await tossGet<TossCalendar>("/api/v1/market-calendar/US", {
    date,
  });
  return (
    [
      calendar.today,
      calendar.previousBusinessDay,
      calendar.nextBusinessDay,
    ].find((day) => day?.date === date) ?? null
  );
}
