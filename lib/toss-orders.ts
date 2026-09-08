/**
 * Toss Securities account, asset and order API.
 *
 * The market-data client in `lib/market-data.ts` only ever issues GETs against
 * the quote endpoints, which is why this app used to claim orders were
 * impossible. They are not: the same client-credentials token reaches
 * `/api/v1/accounts`, `/api/v1/holdings`, `/api/v1/buying-power`,
 * `/api/v1/sellable-quantity`, `/api/v1/commissions` and `/api/v1/orders`.
 * Every account, asset and order call additionally needs the
 * `X-Tossinvest-Account` header carrying the `accountSeq` from `/accounts`.
 *
 * Spec: https://openapi.tossinvest.com/openapi-docs/latest/openapi.json
 *
 * Two details from that spec shape everything here:
 *
 * - **All numbers cross the wire as strings.** Quantities and prices are sent
 *   and received as decimal strings, so nothing in this file lets a float's
 *   representation reach an order body.
 * - **`LIMIT` + `timeInForce: "CLS"` is a limit-on-close order**, US only. That
 *   is the order the strategies here actually want: the backtest fills at the
 *   next session's close, so a market order placed mid-session would be filling
 *   at a price the backtest never modelled.
 */

import { env } from "cloudflare:workers";
import { invalidateTossToken, tossAccessToken, TOSS_API_BASE } from "./market-data.ts";
import { buildOrderBody, type TossOrderMode, type TossOrderRequest } from "./toss-order-shapes.ts";
import type { TradingGateway } from "./trading.ts";

function setting(name: string) {
  const bindings = env as unknown as Record<string, string | undefined>;
  const value = bindings[name] ?? process.env[name];
  return value && value.trim() ? value.trim() : null;
}

export class TossOrderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly requestId?: string) {
    super(message);
  }
}

/** Messages worth rewriting; anything else falls through to Toss's own text. */
const ERROR_HINTS: Record<string, string> = {
  "insufficient-buying-power": "매수 가능 금액이 부족합니다. USD 예수금을 확인하세요.",
  "insufficient-sellable-quantity": "매도 가능 수량이 부족합니다. 결제 미완료 수량일 수 있습니다.",
  "order-hours-closed": "지금은 주문을 접수할 수 없는 시간입니다.",
  "order-type-not-allowed": "지금 이 호가 유형(LOC 등)은 접수할 수 없습니다. 시장가로 바꾸거나 정규장에 다시 시도하세요.",
  "opposite-pending-order-exists": "같은 종목에 반대 방향의 미체결 주문이 있습니다.",
  "price-out-of-range": "주문 가격이 상·하한가를 벗어났습니다.",
  "prerequisite-required": "약관 동의·교육 이수 등 사전 요건이 남아 있습니다. 토스증권 앱에서 확인하세요.",
  "account-restricted": "계좌 상태가 이 주문을 허용하지 않습니다.",
  "stock-restricted": "해당 종목이 거래 제한 상태입니다.",
  "idempotency-key-conflict": "같은 주문 식별자로 내용이 다른 주문을 다시 보냈습니다.",
  "forbidden": "이 API를 호출할 권한이 없습니다. 앱 권한 설정을 확인하세요.",
  "edge-blocked": "토스가 이 요청을 차단했습니다. 허용 IP 목록에 서버 IP가 등록돼 있는지 확인하세요.",
};

type Envelope<T> = { result?: T; error?: { requestId?: string; code?: string; message?: string; data?: unknown } };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rate limits are per client × API group and some groups are tight — `ACCOUNT`
 * allows one request per second — so a 429 is an ordinary outcome of two calls
 * landing together, not a failure. One backoff retry turns it back into a
 * result; a second 429 is a real problem and surfaces.
 *
 * A write is never retried on anything but 429: replaying a POST after an
 * ambiguous failure is how one order becomes two. The idempotency key protects
 * against that too, but only for ten minutes and only when it was sent.
 */
async function call<T>(path: string, init: { method?: "GET" | "POST"; accountSeq?: number; query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const url = new URL(path, TOSS_API_BASE);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);

  for (let attempt = 0; ; attempt += 1) {
    const headers: Record<string, string> = { authorization: `Bearer ${await tossAccessToken()}`, accept: "application/json" };
    if (init.accountSeq !== undefined) headers["X-Tossinvest-Account"] = String(init.accountSeq);
    if (init.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(url, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new TossOrderError("network", `토스 API에 연결하지 못했습니다: ${error instanceof Error ? error.message : "알 수 없음"}`, 503);
    }
    const payload = await response.json().catch(() => ({})) as Envelope<T>;
    if (response.status === 401) invalidateTossToken();
    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3_000) : 1_100);
      continue;
    }
    if (!response.ok || payload.result === undefined) {
      const code = payload.error?.code ?? `http-${response.status}`;
      const message = ERROR_HINTS[code] ?? payload.error?.message ?? `토스 API 오류 (HTTP ${response.status})`;
      throw new TossOrderError(code, message, response.status, payload.error?.requestId);
    }
    return payload.result;
  }
}

// ------------------------------------------------------------------ account

export type TossAccount = { accountNo: string; accountSeq: number; accountType: string };

/**
 * `/api/v1/accounts` sits in the `ACCOUNT` rate-limit group at one request per
 * second, and the answer changes about as often as the account is opened. It is
 * cached for the isolate so a page that resolves the account three times costs
 * one call, not three 429s.
 */
let accountCache: { value: TossAccount[]; expiresAt: number } | null = null;
let accountRequest: Promise<TossAccount[]> | null = null;

export async function tossAccounts(force = false) {
  if (!force && accountCache && accountCache.expiresAt > Date.now()) return accountCache.value;
  if (!accountRequest) {
    accountRequest = call<TossAccount[]>("/api/v1/accounts")
      .then((accounts) => { accountCache = { value: accounts, expiresAt: Date.now() + 300_000 }; return accounts; })
      .finally(() => { accountRequest = null; });
  }
  return accountRequest;
}

/**
 * The account orders are placed for. `TOSS_ACCOUNT_SEQ` pins one explicitly;
 * otherwise the first BROKERAGE account is used, which is the only type the API
 * currently supports for stock orders.
 */
export async function tossPrimaryAccount(): Promise<TossAccount | null> {
  const accounts = await tossAccounts();
  const pinned = setting("TOSS_ACCOUNT_SEQ");
  if (pinned) return accounts.find((account) => String(account.accountSeq) === pinned) ?? null;
  return accounts.find((account) => account.accountType === "BROKERAGE") ?? accounts[0] ?? null;
}

// -------------------------------------------------------------------- asset

export type TossHolding = {
  symbol: string; name: string; marketCountry: string; currency: string;
  quantity: string; lastPrice: string; averagePurchasePrice: string;
};
type HoldingsResult = { items?: TossHolding[]; marketValue?: { amount?: { usd?: string | null; krw?: string } } };

export async function tossHoldings(accountSeq: number) {
  const result = await call<HoldingsResult>("/api/v1/holdings", { accountSeq });
  return {
    items: result.items ?? [],
    marketValueUsd: Number(result.marketValue?.amount?.usd ?? 0) || 0,
  };
}

export async function tossBuyingPower(accountSeq: number, currency: "USD" | "KRW" = "USD") {
  const result = await call<{ currency: string; cashBuyingPower: string }>("/api/v1/buying-power", { accountSeq, query: { currency } });
  return Number(result.cashBuyingPower) || 0;
}

export async function tossSellableQuantity(accountSeq: number, symbol: string) {
  const result = await call<{ sellableQuantity: string }>("/api/v1/sellable-quantity", { accountSeq, query: { symbol } });
  return Number(result.sellableQuantity) || 0;
}

export type TossCommission = { marketCountry: string; commissionRate: string; startDate: string | null; endDate: string | null };

export async function tossCommissions(accountSeq: number) {
  return call<TossCommission[]>("/api/v1/commissions", { accountSeq });
}

// -------------------------------------------------------------------- order

export type TossOrderStatus = "PENDING" | "PENDING_CANCEL" | "PENDING_REPLACE" | "PARTIAL_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "CANCEL_REJECTED" | "REPLACE_REJECTED" | "REPLACED";
export type TossOrder = {
  orderId: string; symbol: string; side: "BUY" | "SELL"; orderType: "LIMIT" | "MARKET";
  timeInForce: "DAY" | "CLS" | "OPG"; status: TossOrderStatus;
  price: string | null; quantity: string; orderAmount: string | null; currency: string;
  orderedAt: string; canceledAt: string | null;
  execution?: { filledQuantity?: string; averageFilledPrice?: string | null };
};

export async function tossCreateOrder(accountSeq: number, body: TossOrderRequest) {
  return call<{ orderId: string; clientOrderId: string | null }>("/api/v1/orders", { method: "POST", accountSeq, body });
}

export async function tossListOrders(accountSeq: number, status: "OPEN" | "CLOSED" = "OPEN", limit = 50) {
  const result = await call<{ orders?: TossOrder[]; nextCursor?: string | null; hasNext?: boolean }>("/api/v1/orders", { accountSeq, query: { status, limit: String(limit) } });
  return result.orders ?? [];
}

export async function tossCancelOrder(accountSeq: number, orderId: string) {
  return call<{ orderId: string }>(`/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST", accountSeq });
}

// ------------------------------------------------------------------ gateway

/**
 * How far the limit sits from the reference price on a limit-on-close order.
 * The order fills at the closing auction price, not at this limit — the band
 * only caps how far the close may run against us before the order simply does
 * not fill. Too tight and the rule silently stops trading; too wide and a
 * gapping close fills at a price the backtest never saw.
 */
function locBandPct() {
  const parsed = Number(setting("TOSS_LOC_LIMIT_BAND_PCT") ?? "3");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

export function tossOrderMode(): TossOrderMode {
  return setting("TOSS_ORDER_MODE") === "market" ? "market" : "loc";
}

export type TossTradingStatus = {
  ready: boolean;
  reason: string | null;
  account: TossAccount | null;
  buyingPowerUsd: number | null;
  usCommissionRate: number | null;
  usCommissionEndDate: string | null;
  orderMode: TossOrderMode;
};

/** Everything the UI needs to say whether a real order can be placed right now. */
export async function tossTradingStatus(): Promise<TossTradingStatus> {
  const base = { account: null, buyingPowerUsd: null, usCommissionRate: null, usCommissionEndDate: null, orderMode: tossOrderMode() };
  if (setting("TOSS_TRADING_DISABLED") === "true") return { ...base, ready: false, reason: "TOSS_TRADING_DISABLED=true 로 실주문이 잠겨 있습니다." };
  if (!setting("TOSS_CLIENT_ID") || !setting("TOSS_CLIENT_SECRET")) return { ...base, ready: false, reason: "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 가 없습니다." };
  try {
    const account = await tossPrimaryAccount();
    if (!account) return { ...base, ready: false, reason: "주문 가능한 계좌를 찾지 못했습니다." };
    const [buyingPowerUsd, commissions] = await Promise.all([
      tossBuyingPower(account.accountSeq, "USD").catch(() => null),
      tossCommissions(account.accountSeq).catch(() => [] as TossCommission[]),
    ]);
    const us = commissions.find((row) => row.marketCountry === "US");
    return {
      ready: true, reason: null, account, buyingPowerUsd,
      usCommissionRate: us ? Number(us.commissionRate) : null,
      usCommissionEndDate: us?.endDate ?? null,
      orderMode: tossOrderMode(),
    };
  } catch (error) {
    return { ...base, ready: false, reason: error instanceof Error ? error.message : "토스 계좌 상태를 확인하지 못했습니다." };
  }
}

export const tossOrderGateway: TradingGateway = {
  id: "toss",
  label: "토스증권 실주문",
  async submit(intent) {
    if (setting("TOSS_TRADING_DISABLED") === "true") {
      return { accepted: false, message: "TOSS_TRADING_DISABLED=true 로 실주문이 잠겨 있습니다." };
    }
    try {
      const account = await tossPrimaryAccount();
      if (!account) return { accepted: false, message: "주문 가능한 계좌를 찾지 못했습니다." };

      // A sell is clamped to what the account can actually deliver: unsettled or
      // partially sold quantity would otherwise come back as a 422 after the
      // ledger already recorded the intent.
      let quantity = intent.quantity;
      if (intent.side === "sell") {
        const sellable = await tossSellableQuantity(account.accountSeq, intent.symbol).catch(() => null);
        if (sellable !== null) {
          quantity = Math.min(quantity, Math.floor(sellable));
          if (quantity < 1) return { accepted: false, message: `${intent.symbol} 매도 가능 수량이 0입니다 (보유 ${sellable}).` };
        }
      }

      const mode = tossOrderMode();
      const body = buildOrderBody(intent, quantity, mode, locBandPct());
      const result = await tossCreateOrder(account.accountSeq, body);
      const shape = mode === "loc" ? `LOC 지정가 ${body.price}` : "시장가";
      return {
        accepted: true,
        message: `${intent.side === "buy" ? "매수" : "매도"} ${quantity} ${intent.symbol} ${shape} 주문을 토스에 접수했습니다. 주문번호 ${result.orderId}`,
        brokerOrderId: result.orderId,
      };
    } catch (error) {
      if (error instanceof TossOrderError) {
        return { accepted: false, message: `토스가 주문을 거부했습니다 [${error.code}] ${error.message}${error.requestId ? ` (requestId ${error.requestId})` : ""}` };
      }
      return { accepted: false, message: `주문 전송 실패: ${error instanceof Error ? error.message : "알 수 없음"}` };
    }
  },
};
