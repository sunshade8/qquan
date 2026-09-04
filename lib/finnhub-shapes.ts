/**
 * Finnhub response shapes and mappers, with no runtime imports.
 *
 * Split out from `finnhub.ts` so the part that can be wrong in a quiet way — the
 * field mapping, the zero-quote guard, the status-to-failure classification — is
 * reachable from the test runner. The transport half imports
 * `cloudflare:workers`, which Node cannot resolve, so anything left in that file
 * is untestable by construction.
 */

export type FinnhubFailure = "not_configured" | "forbidden" | "rate_limited" | "upstream" | "empty";

export class FinnhubError extends Error {
  readonly kind: FinnhubFailure;
  readonly status: number;
  constructor(kind: FinnhubFailure, message: string, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export const FINNHUB_FAILURE_LABELS: Record<FinnhubFailure, string> = {
  not_configured: "FINNHUB_API_KEY 미설정",
  forbidden: "현재 요금제로는 접근 불가 (403)",
  rate_limited: "호출 한도 초과 (429) — 무료 티어 분당 60회",
  upstream: "Finnhub 응답 오류",
  empty: "응답은 성공했으나 데이터가 비어 있음",
};

/**
 * HTTP status to failure kind.
 *
 * 403 is the one that matters: it is a permanent statement about the plan, not a
 * transient error, so callers must not retry it or describe it as temporary.
 */
export function classifyStatus(status: number): FinnhubFailure | null {
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status < 200 || status >= 300) return "upstream";
  return null;
}

export type FinnhubQuote = { current: number; change: number; changePct: number; high: number; low: number; open: number; previousClose: number; asOf: string };

export function mapQuote(symbol: string, raw: { c: number; d: number | null; dp: number | null; h: number; l: number; o: number; pc: number; t: number }): FinnhubQuote {
  // A quote for an unknown ticker comes back as zeros with HTTP 200 rather than
  // an error, so an unpriced instrument has to be rejected here.
  if (!raw.c) throw new FinnhubError("empty", `${symbol}의 현재가가 비어 있습니다. 티커를 확인하세요.`);
  return {
    current: raw.c, change: raw.d ?? 0, changePct: raw.dp ?? 0,
    high: raw.h, low: raw.l, open: raw.o, previousClose: raw.pc,
    asOf: new Date(raw.t * 1000).toISOString(),
  };
}

export type FinnhubProfile = {
  ticker: string; name: string; exchange: string; country: string; currency: string;
  industry: string; ipo: string; marketCapUsdMillions: number | null; shareOutstandingMillions: number | null;
  weburl: string; logo: string;
};

export function mapProfile(symbol: string, raw: Record<string, unknown>): FinnhubProfile {
  if (!raw || !raw.ticker) throw new FinnhubError("empty", `${symbol}의 기업 정보가 없습니다.`);
  return {
    ticker: String(raw.ticker), name: String(raw.name ?? ""), exchange: String(raw.exchange ?? ""),
    country: String(raw.country ?? ""), currency: String(raw.currency ?? ""),
    industry: String(raw.finnhubIndustry ?? ""), ipo: String(raw.ipo ?? ""),
    marketCapUsdMillions: typeof raw.marketCapitalization === "number" ? raw.marketCapitalization : null,
    shareOutstandingMillions: typeof raw.shareOutstanding === "number" ? raw.shareOutstanding : null,
    weburl: String(raw.weburl ?? ""), logo: String(raw.logo ?? ""),
  };
}

export function mapPeers(symbol: string, raw: string[]): string[] {
  // Finnhub includes the queried symbol in its own peer list.
  return (Array.isArray(raw) ? raw : []).filter((peer) => peer && peer.toUpperCase() !== symbol.toUpperCase());
}

/** Selected fundamentals. The raw payload carries ~200 fields; these are the ones a rule can use. */
export type FinnhubMetrics = {
  symbol: string;
  beta: number | null;
  peRatio: number | null;
  psRatio: number | null;
  pbRatio: number | null;
  grossMarginTtm: number | null;
  operatingMarginTtm: number | null;
  netMarginTtm: number | null;
  revenueGrowthTtmYoy: number | null;
  epsGrowthTtmYoy: number | null;
  currentRatio: number | null;
  totalDebtToEquity: number | null;
  week52High: number | null;
  week52Low: number | null;
  week52HighDate: string | null;
  averageVolume10Day: number | null;
  volatility90Day: number | null;
  return13WeekPct: number | null;
  return52WeekPct: number | null;
};

const METRIC_KEYS: Array<[keyof FinnhubMetrics, string]> = [
  ["beta", "beta"], ["peRatio", "peTTM"], ["psRatio", "psTTM"], ["pbRatio", "pbQuarterly"],
  ["grossMarginTtm", "grossMarginTTM"], ["operatingMarginTtm", "operatingMarginTTM"], ["netMarginTtm", "netProfitMarginTTM"],
  ["revenueGrowthTtmYoy", "revenueGrowthTTMYoy"], ["epsGrowthTtmYoy", "epsGrowthTTMYoy"],
  ["currentRatio", "currentRatioQuarterly"], ["totalDebtToEquity", "totalDebt/totalEquityQuarterly"],
  ["week52High", "52WeekHigh"], ["week52Low", "52WeekLow"],
  ["averageVolume10Day", "10DayAverageTradingVolume"], ["volatility90Day", "90DayVolatility"],
  ["return13WeekPct", "13WeekPriceReturnDaily"], ["return52WeekPct", "52WeekPriceReturnDaily"],
];

export function mapMetrics(symbol: string, raw: { metric?: Record<string, unknown> }): FinnhubMetrics {
  const metric = raw.metric;
  if (!metric) throw new FinnhubError("empty", `${symbol}의 재무 지표가 없습니다.`);
  const num = (key: string) => { const value = metric[key]; return typeof value === "number" && Number.isFinite(value) ? value : null; };
  const out = { symbol: symbol.toUpperCase(), week52HighDate: typeof metric["52WeekHighDate"] === "string" ? metric["52WeekHighDate"] : null } as FinnhubMetrics;
  for (const [field, key] of METRIC_KEYS) (out as Record<string, unknown>)[field] = num(key);
  return out;
}

// --- forward-looking events -------------------------------------------------

export type EarningsCalendarEntry = {
  symbol: string;
  date: string;
  /** "bmo" before open, "amc" after close, "dmh" during hours, null unknown. */
  hour: string | null;
  quarter: number | null;
  year: number | null;
  epsEstimate: number | null;
  epsActual: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
};

/**
 * Scheduled earnings, past and future, with the session-timing flag.
 *
 * This is the piece EDGAR cannot give: EDGAR only knows about filings that have
 * already happened. The `hour` field decides which session prices the news, and
 * it is the same distinction `earnings-dates.ts` derives from filing timestamps
 * for history — so a rule can use one source for the past and this for what is
 * still to come without changing its definition of a reaction day.
 */
export function mapEarningsCalendar(raw: { earningsCalendar?: Array<Record<string, unknown>> }): EarningsCalendarEntry[] {
  return (raw.earningsCalendar ?? []).map((row) => ({
    symbol: String(row.symbol ?? ""),
    date: String(row.date ?? ""),
    hour: typeof row.hour === "string" && row.hour ? row.hour : null,
    quarter: typeof row.quarter === "number" ? row.quarter : null,
    year: typeof row.year === "number" ? row.year : null,
    epsEstimate: typeof row.epsEstimate === "number" ? row.epsEstimate : null,
    epsActual: typeof row.epsActual === "number" ? row.epsActual : null,
    revenueEstimate: typeof row.revenueEstimate === "number" ? row.revenueEstimate : null,
    revenueActual: typeof row.revenueActual === "number" ? row.revenueActual : null,
  })).filter((row) => row.symbol && row.date);
}

export type IpoCalendarEntry = { symbol: string; name: string; date: string; exchange: string | null; status: string | null; price: string | null; shares: number | null };

export function mapIpoCalendar(raw: { ipoCalendar?: Array<Record<string, unknown>> }): IpoCalendarEntry[] {
  return (raw.ipoCalendar ?? []).map((row) => ({
    symbol: String(row.symbol ?? ""), name: String(row.name ?? ""), date: String(row.date ?? ""),
    exchange: row.exchange ? String(row.exchange) : null, status: row.status ? String(row.status) : null,
    price: row.price ? String(row.price) : null, shares: typeof row.numberOfShares === "number" ? row.numberOfShares : null,
  })).filter((row) => row.date);
}

export type EarningsSurprise = { symbol: string; period: string; estimate: number | null; actual: number | null; surprise: number | null; surprisePercent: number | null };

export function mapEarningsSurprises(symbol: string, raw: Array<Record<string, unknown>>): EarningsSurprise[] {
  return (Array.isArray(raw) ? raw : []).map((row) => ({
    symbol: String(row.symbol ?? symbol), period: String(row.period ?? ""),
    estimate: typeof row.estimate === "number" ? row.estimate : null,
    actual: typeof row.actual === "number" ? row.actual : null,
    surprise: typeof row.surprise === "number" ? row.surprise : null,
    surprisePercent: typeof row.surprisePercent === "number" ? row.surprisePercent : null,
  })).filter((row) => row.period);
}

// --- positioning and sentiment ---------------------------------------------

export type Recommendation = { symbol: string; period: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number; total: number; netBullishPct: number | null };

export function mapRecommendations(symbol: string, raw: Array<Record<string, unknown>>): Recommendation[] {
  return (Array.isArray(raw) ? raw : []).map((row) => {
    const n = (key: string) => typeof row[key] === "number" ? row[key] as number : 0;
    const total = n("strongBuy") + n("buy") + n("hold") + n("sell") + n("strongSell");
    return {
      symbol: String(row.symbol ?? symbol), period: String(row.period ?? ""),
      strongBuy: n("strongBuy"), buy: n("buy"), hold: n("hold"), sell: n("sell"), strongSell: n("strongSell"),
      total,
      // Bulls minus bears over the whole panel: one number that moves when the
      // panel actually shifts, rather than five that each move a little.
      netBullishPct: total ? Number((((n("strongBuy") + n("buy") - n("sell") - n("strongSell")) / total) * 100).toFixed(2)) : null,
    };
  }).filter((row) => row.period);
}

export type InsiderTransaction = { name: string; symbol: string; filingDate: string; transactionDate: string; change: number; share: number; transactionPrice: number | null; transactionCode: string };

export function mapInsiderTransactions(symbol: string, raw: { data?: Array<Record<string, unknown>> }): InsiderTransaction[] {
  return (raw.data ?? []).map((row) => ({
    name: String(row.name ?? ""), symbol: String(row.symbol ?? symbol),
    filingDate: String(row.filingDate ?? ""), transactionDate: String(row.transactionDate ?? ""),
    change: typeof row.change === "number" ? row.change : 0,
    share: typeof row.share === "number" ? row.share : 0,
    transactionPrice: typeof row.transactionPrice === "number" ? row.transactionPrice : null,
    transactionCode: String(row.transactionCode ?? ""),
  })).filter((row) => row.filingDate);
}

/**
 * Monthly insider sentiment. `mspr` runs -100 to 100 and is Finnhub's own
 * aggregate of buying against selling; `change` is the net share count.
 */
export type InsiderSentiment = { symbol: string; year: number; month: number; change: number; mspr: number };

export function mapInsiderSentiment(symbol: string, raw: { data?: Array<Record<string, unknown>> }): InsiderSentiment[] {
  return (raw.data ?? []).map((row) => ({
    symbol: String(row.symbol ?? symbol),
    year: typeof row.year === "number" ? row.year : 0,
    month: typeof row.month === "number" ? row.month : 0,
    change: typeof row.change === "number" ? row.change : 0,
    mspr: typeof row.mspr === "number" ? Number(row.mspr.toFixed(3)) : 0,
  })).filter((row) => row.year);
}

export type FinnhubFiling = { accessNumber: string; symbol: string; cik: string; form: string; filedDate: string; acceptedDate: string; reportUrl: string; filingUrl: string };

export function mapFilings(symbol: string, raw: Array<Record<string, unknown>>): FinnhubFiling[] {
  return (Array.isArray(raw) ? raw : []).map((row) => ({
    accessNumber: String(row.accessNumber ?? ""), symbol: String(row.symbol ?? symbol), cik: String(row.cik ?? ""),
    form: String(row.form ?? ""), filedDate: String(row.filedDate ?? ""), acceptedDate: String(row.acceptedDate ?? ""),
    reportUrl: String(row.reportUrl ?? ""), filingUrl: String(row.filingUrl ?? ""),
  })).filter((row) => row.form);
}

// --- exchange calendar ------------------------------------------------------

export type MarketStatus = { exchange: string; isOpen: boolean; session: string | null; holiday: string | null; timezone: string; asOf: string };

/**
 * Live exchange state, holidays included.
 *
 * The intraday engines assume a 09:30-16:00 session. On the roughly three
 * half-days a year the US market closes at 13:00, a rule holding "to the close"
 * is really holding to a close that already happened, and a session filter keyed
 * on bar counts silently drops the day. This is the source that knows.
 */
export function mapMarketStatus(exchange: string, raw: Record<string, unknown>): MarketStatus {
  return {
    exchange: String(raw.exchange ?? exchange),
    isOpen: Boolean(raw.isOpen),
    session: raw.session ? String(raw.session) : null,
    holiday: raw.holiday ? String(raw.holiday) : null,
    timezone: String(raw.timezone ?? ""),
    asOf: typeof raw.t === "number" ? new Date(raw.t * 1000).toISOString() : new Date().toISOString(),
  };
}

