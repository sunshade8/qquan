/**
 * Toss Securities' live ranking screen — the 급등주 feature's discovery feed.
 * `lib/surge-intraday-live.ts` reads `TOP_GAINERS`/`TOP_LOSERS` here during the
 * session and confirms each listed name against its own one-minute candles.
 *
 * `GET /api/v1/rankings` (spec: https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)
 * is a **snapshot with no as-of parameter**. It answers "who is up the most
 * right now", carries a `rankedAt` timestamp, and cannot be asked about a past
 * date. That single fact is why the research half of this feature rebuilds its
 * history from Massive instead (see `lib/surge-universe.ts`) and why this module
 * is only ever used forward, at the moment of trading.
 *
 * What the endpoint actually allows, verified against a live token on
 * 2026-09-22:
 *
 * - `type`: `MARKET_TRADING_AMOUNT`, `MARKET_TRADING_VOLUME`, `TOP_GAINERS`,
 *   `TOP_LOSERS`, `TOSS_SECURITIES_TRADING_AMOUNT`, `TOSS_SECURITIES_TRADING_VOLUME`.
 * - `marketCountry`: `US` or `KR`.
 * - `duration`: `realtime`, `1d`, `1w`, `1mo`, `3mo`, `6mo`, `1y` — but
 *   `TOP_GAINERS`/`TOP_LOSERS` reject `realtime` with 400
 *   `unsupported-ranking-duration`, so the fastest surge list available is `1d`.
 * - `count`: 1–100. One hundred names is the hard ceiling; there is no paging.
 * - For `TOP_GAINERS`/`TOP_LOSERS`, `basePrice` is the price at the start of
 *   `duration` and `changeRate` is the period return. For every other type both
 *   are measured against the previous close regardless of `duration`.
 * - `tradingAmount` on US names comes back converted to KRW, not USD.
 * - An uncomputed combination returns an empty array with `rankedAt: null`
 *   rather than an error.
 */

import { invalidateTossToken, tossAccessToken, TOSS_API_BASE } from "./market-data.ts";

export const RANKING_TYPES = [
  "MARKET_TRADING_AMOUNT",
  "MARKET_TRADING_VOLUME",
  "TOP_GAINERS",
  "TOP_LOSERS",
  "TOSS_SECURITIES_TRADING_AMOUNT",
  "TOSS_SECURITIES_TRADING_VOLUME",
] as const;
export type RankingType = (typeof RANKING_TYPES)[number];

export const RANKING_DURATIONS = ["realtime", "1d", "1w", "1mo", "3mo", "6mo", "1y"] as const;
export type RankingDuration = (typeof RANKING_DURATIONS)[number];

/**
 * Screens the board shows, in the order they are read. All six ranking types
 * the endpoint offers are here: the two surge lists a rule trades from, and the
 * four volume/turnover boards that say whether a surge has real participation
 * behind it or is two hundred shares of premarket tape.
 */
export const RANKING_BOARDS = [
  { id: "TOP_GAINERS", label: "급상승", note: "등락률 상위. duration 시작 시점 대비 기간 등락률." },
  { id: "TOP_LOSERS", label: "급하락", note: "등락률 하위. 롱 전용이므로 반등 매수 가설로만 씁니다." },
  { id: "MARKET_TRADING_AMOUNT", label: "거래대금", note: "시장 전체 거래대금 상위. 등락률은 전일 종가 대비." },
  { id: "MARKET_TRADING_VOLUME", label: "거래량", note: "시장 전체 거래량 상위." },
  { id: "TOSS_SECURITIES_TRADING_AMOUNT", label: "토스 거래대금", note: "토스증권 체결 기준 거래대금 상위 — 한국 투자자 쏠림." },
  { id: "TOSS_SECURITIES_TRADING_VOLUME", label: "토스 거래량", note: "토스증권 체결 기준 거래량 상위." },
] as const satisfies ReadonlyArray<{ id: RankingType; label: string; note: string }>;

export const RANKING_LIMITS = {
  maxCount: 100,
  /** `TOP_GAINERS` and `TOP_LOSERS` are the two that refuse `realtime`. */
  noRealtime: ["TOP_GAINERS", "TOP_LOSERS"] as const,
  markets: ["US", "KR"] as const,
  historical: false,
  note: "as-of 파라미터가 없어 과거 시점 랭킹은 조회할 수 없습니다. 과거 급등 이력은 Massive의 전 종목 일별 시세로 재구성합니다.",
} as const;

export type RankingRow = {
  rank: number;
  symbol: string;
  currency: string;
  lastPrice: number | null;
  basePrice: number | null;
  /** Period return as a fraction, e.g. 0.9359 = +93.59%. */
  changeRate: number | null;
  tradingVolume: number | null;
  /** KRW for US names — the API converts. Not a USD notional. */
  tradingAmountKrw: number | null;
};

export type RankingSnapshot = {
  type: RankingType;
  marketCountry: "US" | "KR";
  duration: RankingDuration;
  rankedAt: string | null;
  rows: RankingRow[];
  /** How many rows the US-listing filter dropped before anything was rendered. */
  filtered: number;
};

type Envelope = {
  result?: { rankedAt?: string | null; rankings?: Array<Record<string, unknown>> };
  error?: { code?: string; message?: string; requestId?: string };
};

/**
 * Whether a ranking row is a US-listed stock.
 *
 * `marketCountry=US` is supposed to settle this, but the board is user-facing
 * and a KRX code slipping through would put 동국생명과학 in a list a US-only
 * rule trades from. So it is checked in code, here, before anything renders:
 * KRX tickers are six digits (`005930`) or five digits plus a letter
 * (`0200G0`), and every US equity is letters. A row that is not quoted in USD
 * is not ours either.
 */
export function isUsListing(symbol: string, currency: string) {
  if (currency && currency.toUpperCase() !== "USD") return false;
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) return false;
  if (/\d/.test(symbol.slice(0, 1))) return false;
  // KOSPI/KOSDAQ codes are numeric, sometimes with a trailing letter class.
  if (/^\d{5,6}[A-Z0-9]?$/.test(symbol)) return false;
  return true;
}

const number = (value: unknown) => {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/** The RANKING rate-limit group is its own bucket; a short cache keeps a busy page inside it. */
const cache = new Map<string, { value: RankingSnapshot; expiresAt: number }>();
const CACHE_MS = 20_000;

export class RankingError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

export async function fetchRanking(
  type: RankingType,
  marketCountry: "US" | "KR" = "US",
  duration: RankingDuration = "1d",
  count = RANKING_LIMITS.maxCount,
): Promise<RankingSnapshot> {
  if ((RANKING_LIMITS.noRealtime as readonly string[]).includes(type) && duration === "realtime") {
    throw new RankingError("unsupported-ranking-duration", `${type} 은 realtime 기간을 지원하지 않습니다. 1d 이상을 사용하세요.`, 400);
  }
  const bounded = Math.max(1, Math.min(RANKING_LIMITS.maxCount, Math.floor(count)));
  const key = `${type}|${marketCountry}|${duration}|${bounded}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const url = new URL("/api/v1/rankings", TOSS_API_BASE);
  url.searchParams.set("type", type);
  url.searchParams.set("marketCountry", marketCountry);
  url.searchParams.set("duration", duration);
  url.searchParams.set("count", String(bounded));
  url.searchParams.set("excludeInvestmentCaution", "true");

  // The RANKING group is its own rate-limit bucket and it is tight enough that
  // reading all six boards trips it. A 429 is an ordinary outcome of two reads
  // landing together, not a failure, so it is backed off once before surfacing.
  let response: Response;
  let payload: Envelope;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${await tossAccessToken()}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new RankingError("network", `토스 랭킹 API에 연결하지 못했습니다: ${error instanceof Error ? error.message : "알 수 없음"}`, 503);
    }
    payload = await response.json().catch(() => ({})) as Envelope;
    // Issuing a token revokes the previous one, so another process can invalidate ours at any time.
    if (response.status === 401 && attempt < 1) {
      invalidateTossToken();
      continue;
    }
    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3_000) : 1_200));
      continue;
    }
    break;
  }
  if (!response.ok || !payload.result) {
    throw new RankingError(
      payload.error?.code ?? `http-${response.status}`,
      payload.error?.message ?? `토스 랭킹 조회 실패 (HTTP ${response.status})`,
      response.status,
    );
  }

  const parsed = (payload.result.rankings ?? []).map((row) => {
    const price = (row.price ?? {}) as Record<string, unknown>;
    return {
      rank: number(row.rank) ?? 0,
      symbol: String(row.symbol ?? "").toUpperCase(),
      currency: String(row.currency ?? ""),
      lastPrice: number(price.lastPrice),
      basePrice: number(price.basePrice),
      changeRate: number(price.changeRate),
      tradingVolume: number(row.tradingVolume),
      tradingAmountKrw: number(row.tradingAmount),
    };
  });
  const rows = marketCountry === "US"
    ? parsed.filter((row) => isUsListing(row.symbol, row.currency))
    : parsed;
  const snapshot: RankingSnapshot = {
    type, marketCountry, duration,
    rankedAt: payload.result.rankedAt ?? null,
    rows,
    /** Rows the US filter removed. Zero is the expected answer; anything else is worth seeing. */
    filtered: parsed.length - rows.length,
  };
  cache.set(key, { value: snapshot, expiresAt: Date.now() + CACHE_MS });
  return snapshot;
}
