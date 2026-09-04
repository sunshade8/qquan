/**
 * Alpaca historical stock-bar client for Cloudflare Workers.
 *
 * The official Python SDK is the reference implementation used to verify the
 * request shape, but the deployed Site cannot run Python. This small REST client
 * sends the same authenticated StockBarsRequest parameters from the Worker.
 * Historical SIP data is complete-market data, but a free Basic account may only
 * query it with an end time at least 15 minutes old. We therefore clamp SIP
 * requests to a conservative 16-minute cutoff instead of letting a whole
 * backtest fail during market hours.
 */

import { env } from "cloudflare:workers";
import { ALPACA_TIMEFRAMES, parseAlpacaBars, type AlpacaBar, type AlpacaInterval, type AlpacaIntradayPoint } from "./alpaca-shapes.ts";

const BASE = "https://data.alpaca.markets";
const PAGE_LIMIT = 10_000;
const FREE_SIP_CUTOFF_MINUTES = 16;

export type AlpacaFailure = "not_configured" | "auth" | "plan_locked" | "rate_limit" | "not_found" | "too_large" | "upstream";

export class AlpacaError extends Error {
  constructor(public readonly kind: AlpacaFailure, message: string, public readonly status = 502) {
    super(message);
  }
}

type AlpacaBarsPage = {
  bars?: AlpacaBar[];
  next_page_token?: string | null;
  message?: string;
};

export type AlpacaHistory = {
  points: AlpacaIntradayPoint[];
  provider: "Alpaca";
  feed: "sip" | "iex";
  availableSince: "2016";
  delayedByMinutes: number;
};

function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

export function alpacaCredentials() {
  const bindings = runtimeEnv();
  return {
    keyId: bindings.APCA_API_KEY_ID ?? bindings.ALPACA_API_KEY ?? process.env.APCA_API_KEY_ID ?? process.env.ALPACA_API_KEY,
    secretKey: bindings.APCA_API_SECRET_KEY ?? bindings.ALPACA_SECRET_KEY ?? process.env.APCA_API_SECRET_KEY ?? process.env.ALPACA_SECRET_KEY,
  };
}

export function alpacaConfigured() {
  const credentials = alpacaCredentials();
  return Boolean(credentials.keyId && credentials.secretKey);
}

export function alpacaHistoricalFeed(): "sip" | "iex" {
  const configured = (runtimeEnv().ALPACA_DATA_FEED ?? process.env.ALPACA_DATA_FEED)?.toLowerCase();
  return configured === "iex" ? "iex" : "sip";
}

function dayAfter(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function requestRange(from: string, to: string, feed: "sip" | "iex") {
  const start = new Date(`${from}T00:00:00Z`);
  // Two UTC midnights beyond the Eastern date safely include the winter
  // after-hours session. Parsed points are filtered back to the requested dates.
  const requestedEnd = dayAfter(to, 2);
  const cutoff = new Date(Date.now() - FREE_SIP_CUTOFF_MINUTES * 60_000);
  const end = feed === "sip" && requestedEnd > cutoff ? cutoff : requestedEnd;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new AlpacaError("not_found", "Alpaca에서 조회할 수 있는 과거 분봉 구간이 아닙니다.", 404);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

function failureFor(response: Response, message: string) {
  if (response.status === 401) return new AlpacaError("auth", "Alpaca API 키 인증에 실패했습니다.", response.status);
  if (response.status === 403 || (response.status === 422 && /subscription|feed|permit/i.test(message))) {
    return new AlpacaError("plan_locked", `Alpaca 요금제가 요청한 데이터 피드를 허용하지 않습니다.${message ? ` ${message}` : ""}`, response.status);
  }
  if (response.status === 429) return new AlpacaError("rate_limit", "Alpaca 분당 호출 한도를 초과했습니다.", response.status);
  if (response.status === 404) return new AlpacaError("not_found", "Alpaca에서 이 종목의 분봉 데이터를 찾지 못했습니다.", response.status);
  return new AlpacaError("upstream", `Alpaca 분봉 데이터를 가져오지 못했습니다.${message ? ` ${message}` : ""}`, response.status);
}

export async function fetchAlpacaIntradayWindow(
  symbol: string,
  from: string,
  to: string,
  interval: AlpacaInterval,
  options: { session?: "all" | "regular"; maxBars?: number } = {},
): Promise<AlpacaHistory> {
  const { keyId, secretKey } = alpacaCredentials();
  if (!keyId || !secretKey) throw new AlpacaError("not_configured", "Alpaca API 키가 연결되지 않았습니다.", 503);

  const feed = alpacaHistoricalFeed();
  const range = requestRange(from, to, feed);
  const maxBars = Math.max(PAGE_LIMIT, options.maxBars ?? 160_000);
  const byTimestamp = new Map<number, AlpacaIntradayPoint>();
  let pageToken: string | null = null;

  do {
    const url = new URL(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, BASE);
    url.searchParams.set("timeframe", ALPACA_TIMEFRAMES[interval]);
    url.searchParams.set("start", range.start);
    url.searchParams.set("end", range.end);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("adjustment", "split");
    url.searchParams.set("feed", feed);
    url.searchParams.set("sort", "asc");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json", "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AlpacaError("upstream", "Alpaca 분봉 데이터에 연결하지 못했습니다.");
    }
    const payload = await response.json().catch(() => ({})) as AlpacaBarsPage;
    if (!response.ok) throw failureFor(response, payload.message ?? "");
    const page = parseAlpacaBars(payload.bars ?? [], from, to, options.session ?? "all");
    page.forEach((point) => byTimestamp.set(point.timestamp, point));
    if (byTimestamp.size > maxBars) {
      throw new AlpacaError("too_large", `요청 구간이 안전 한도 ${maxBars.toLocaleString()}개 분봉을 넘습니다. 기간이나 종목 수를 줄여주세요.`, 413);
    }
    pageToken = payload.next_page_token ?? null;
  } while (pageToken);

  const points = [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
  if (!points.length) throw new AlpacaError("not_found", "Alpaca에서 해당 구간의 분봉 데이터가 없습니다.", 404);
  return { points, provider: "Alpaca", feed, availableSince: "2016", delayedByMinutes: feed === "sip" ? 15 : 0 };
}

export type AlpacaProbe = {
  configured: boolean;
  status: "connected" | "not_configured" | "auth_error" | "plan_locked" | "unavailable";
  detail: string;
  feed: "sip" | "iex";
  availableSince: "2016";
  historicalDelayMinutes: number;
};

export async function probeAlpaca(): Promise<AlpacaProbe> {
  const feed = alpacaHistoricalFeed();
  const base = { feed, availableSince: "2016" as const, historicalDelayMinutes: feed === "sip" ? 15 : 0 };
  if (!alpacaConfigured()) return { ...base, configured: false, status: "not_configured", detail: "APCA_API_KEY_ID / APCA_API_SECRET_KEY 미설정" };
  const today = new Date().toISOString().slice(0, 10);
  const start = dayAfter(today, -7).toISOString().slice(0, 10);
  try {
    const history = await fetchAlpacaIntradayWindow("AAPL", start, today, "5m", { session: "regular", maxBars: PAGE_LIMIT });
    return { ...base, configured: true, status: "connected", detail: `AAPL 5분봉 ${history.points.length.toLocaleString()}개 · ${feed.toUpperCase()}` };
  } catch (error) {
    const kind = error instanceof AlpacaError ? error.kind : "upstream";
    const status = kind === "auth" ? "auth_error" : kind === "plan_locked" ? "plan_locked" : "unavailable";
    return { ...base, configured: true, status, detail: error instanceof Error ? error.message : "Alpaca 확인 실패" };
  }
}
