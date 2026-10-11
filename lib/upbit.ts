import { decimalFloor, upbitLimit } from "./market-precision.ts";
export { decimalFloor, upbitLimit, upbitTick } from "./market-precision.ts";
import { env } from "cloudflare:workers";
import Decimal from "decimal.js";
import type { CTBar } from "./ct-engine.ts";
export const upbitSetting = (key: string) =>
  (env as unknown as Record<string, string | undefined>)[key] ??
  process.env[key];
export const upbitConfigured = () =>
  Boolean(upbitSetting("UPBIT_ACCESS_KEY") && upbitSetting("UPBIT_SECRET_KEY"));
export class UpbitError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(`업비트 ${status}: ${code}`);
    this.status = status;
    this.code = code;
  }
}
const encoder = new TextEncoder();
const base64 = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export async function upbitJwt(
  access: string,
  secret: string,
  query: string,
  nonce = crypto.randomUUID(),
) {
  const payload: Record<string, string> = { access_key: access, nonce };
  if (query) {
    payload.query_hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-512", encoder.encode(query)),
      ),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    payload.query_hash_alg = "SHA512";
  }
  const message = `${base64(encoder.encode(JSON.stringify({ alg: "HS512", typ: "JWT" })))}.${base64(encoder.encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  return `${message}.${base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))))}`;
}
// Each isolate also honours Remaining-Req. A 429/418 halts, never blind POST retries.
let nextRequest = 0;
export async function upbitRequest<T>(
  path: string,
  params: Record<string, string> = {},
  method: "GET" | "POST" | "DELETE" = "GET",
  privateCall = false,
): Promise<T> {
  if (!/^\/v1\//.test(path)) throw new Error("잘못된 Upbit 경로");
  const now = Date.now();
  const slot = Math.max(now, nextRequest);
  nextRequest = slot + 150;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  const encoded = new URLSearchParams(params).toString(),
    query = decodeURIComponent(encoded);
  const headers: Record<string, string> = { accept: "application/json" };
  if (privateCall) {
    const access = upbitSetting("UPBIT_ACCESS_KEY"),
      secret = upbitSetting("UPBIT_SECRET_KEY");
    if (!access || !secret) throw new Error("Upbit 서버 키 미설정");
    headers.authorization = `Bearer ${await upbitJwt(access, secret, query)}`;
  }
  if (method === "POST") headers["content-type"] = "application/json";
  const response = await fetch(
    `https://api.upbit.com${path}${method !== "POST" && encoded ? `?${encoded}` : ""}`,
    {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(params) } : {}),
      signal: AbortSignal.timeout(15000),
    },
  );
  const remaining = response.headers.get("remaining-req");
  if (remaining && /sec=0(?:;|$)/.test(remaining))
    nextRequest = Math.max(nextRequest, Date.now() + 1100);
  if (response.status === 429 || response.status === 418)
    nextRequest =
      Date.now() +
      Math.max(2000, Number(response.headers.get("retry-after") ?? "2") * 1000);
  const data = (await response.json()) as T & { error?: { name?: string } };
  if (!response.ok)
    throw new UpbitError(response.status, data.error?.name ?? "request_failed");
  return data;
}
export async function upbitMarkets() {
  return (
    await upbitRequest<
      Array<{
        market: string;
        korean_name: string;
        market_event?: { warning?: boolean };
      }>
    >("/v1/market/all", { is_details: "true" })
  ).filter((m) => m.market.startsWith("KRW-") && !m.market_event?.warning);
}
export type UpbitCandle = {
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_volume: number;
};
export async function upbitCandles(
  symbol: string,
  minutes: number,
  before: number,
) {
  const rows = await upbitRequest<UpbitCandle[]>(
    `/v1/candles/minutes/${minutes}`,
    { market: symbol, count: "200", to: new Date(before).toISOString() },
  );
  return rows
    .map((r) => {
      const startMs = Date.parse(`${r.candle_date_time_utc}Z`);
      return {
        startMs,
        endMs: startMs + minutes * 60000,
        open: r.opening_price,
        high: r.high_price,
        low: r.low_price,
        close: r.trade_price,
        volume: r.candle_acc_trade_volume,
      } satisfies CTBar;
    })
    .sort((a, b) => a.endMs - b.endMs);
}
export async function upbitQuote(symbol: string) {
  const [tick, books] = await Promise.all([
    upbitRequest<Array<{ trade_price: number; timestamp: number }>>(
      "/v1/ticker",
      { markets: symbol },
    ),
    upbitRequest<
      Array<{
        timestamp: number;
        orderbook_units: Array<{
          ask_price: number;
          bid_price: number;
          ask_size: number;
          bid_size: number;
        }>;
      }>
    >("/v1/orderbook", { markets: symbol }),
  ]);
  if (!tick[0] || !books[0]?.orderbook_units[0])
    throw new Error("Upbit 호가 없음");
  return {
    price: tick[0].trade_price,
    bid: books[0].orderbook_units[0].bid_price,
    ask: books[0].orderbook_units[0].ask_price,
    timestamp: new Date(tick[0].timestamp).toISOString(),
    bookTimestamp: new Date(books[0].timestamp).toISOString(),
  };
}
export type UpbitAccount = {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
};
export const upbitAccounts = () =>
  upbitRequest<UpbitAccount[]>("/v1/accounts", {}, "GET", true);
export type UpbitChance = {
  bid_fee: string;
  ask_fee: string;
  market: {
    state: string;
    bid: { min_total: string };
    ask: { min_total: string };
  };
  bid_account: { balance: string };
  ask_account: { balance: string };
};
export const upbitChance = (symbol: string) =>
  upbitRequest<UpbitChance>(
    "/v1/orders/chance",
    { market: symbol },
    "GET",
    true,
  );
export type UpbitOrder = {
  uuid: string;
  identifier?: string;
  state: string;
  volume: string;
  executed_volume: string;
  paid_fee: string;
  trades?: Array<{ price: string; volume: string; funds: string }>;
};
export const upbitOrder = (identifier: string) =>
  upbitRequest<UpbitOrder>("/v1/order", { identifier }, "GET", true);
export const upbitCancel = (uuid: string) =>
  upbitRequest<UpbitOrder>("/v1/order", { uuid }, "DELETE", true);
export const upbitOpenOrders = () =>
  upbitRequest<UpbitOrder[]>("/v1/orders/open", {}, "GET", true);
export async function upbitSubmit(input: {
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
  price: string;
  identifier: string;
}) {
  if (upbitSetting("UPBIT_TRADING_DISABLED") !== "false")
    throw new Error("UPBIT_TRADING_DISABLED: 실주문 잠금");
  const chance = await upbitChance(input.symbol);
  if (
    chance.market.state !== "active" ||
    new Decimal(input.price)
      .mul(input.quantity)
      .lt(
        input.side === "buy"
          ? chance.market.bid.min_total
          : chance.market.ask.min_total,
      )
  )
    throw new Error("Upbit 시장 상태·최소 주문 금액 미달");
  // Runtime tick policy is authoritative; static table is only used in paper/replay.
  const instruments = await upbitRequest<
    Array<{ market: string; tick_size: string }>
  >("/v1/orderbook/instruments", { markets: input.symbol });
  if (!instruments[0]?.tick_size) throw new Error("Upbit 호가 정책 확인 불가");
  const volume = decimalFloor(input.quantity, 8);
  const price = upbitLimit(
    input.price,
    input.side,
    new Decimal(instruments[0].tick_size),
  );
  if (
    new Decimal(volume).lte(0) ||
    new Decimal(price)
      .mul(volume)
      .lt(
        input.side === "buy"
          ? chance.market.bid.min_total
          : chance.market.ask.min_total,
      )
  )
    throw new Error("Upbit 정밀도 반영 후 최소 주문 금액 미달");
  return upbitRequest<UpbitOrder>(
    "/v1/orders",
    {
      market: input.symbol,
      side: input.side === "buy" ? "bid" : "ask",
      ord_type: "limit",
      volume,
      price,
      identifier: input.identifier,
    },
    "POST",
    true,
  );
}

/** Public executed trades; no account key or exchange sandbox is assumed. */
export const upbitTrades = (symbol: string) =>
  upbitRequest<
    Array<{
      market: string;
      trade_price: number;
      trade_volume: number;
      timestamp: number;
      sequential_id: number;
      ask_bid: "ASK" | "BID";
    }>
  >("/v1/trades/ticks", { market: symbol, count: "200" });
