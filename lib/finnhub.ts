/**
 * Finnhub client, scoped to what this account's plan actually returns.
 *
 * The plan matters more than the endpoint list. `/stock/candle` — the reason
 * anyone reaches for Finnhub first — is 403 on the free tier for daily bars as
 * well as intraday, so this client does **not** provide price history and Yahoo
 * remains the bar source. Pretending otherwise would put a silent hole in every
 * backtest that trusted it.
 *
 * What the free tier does return is a class of data QQuant had none of:
 * forward-looking earnings dates with before/after-market timing and consensus,
 * analyst recommendation counts, company fundamentals, insider transactions and
 * their aggregated sentiment, a peer list, and an exchange calendar that knows
 * about holidays. The last one closes a real gap — the intraday engines have
 * been assuming a fixed 09:30-16:00 session with no half-days.
 *
 * Every call routes through `request`, which separates the three failures that
 * look alike and are not: no key configured, a key the plan does not entitle
 * (403), and rate limiting (429). A 403 is a permanent answer about the plan and
 * must never be retried or reported as "temporarily unavailable".
 */

import { env } from "cloudflare:workers";
import {
  classifyStatus, FinnhubError, FINNHUB_FAILURE_LABELS,
  mapEarningsCalendar, mapEarningsSurprises, mapFilings, mapInsiderSentiment, mapInsiderTransactions,
  mapIpoCalendar, mapMarketStatus, mapMetrics, mapPeers, mapProfile, mapQuote, mapRecommendations,
} from "./finnhub-shapes.ts";

export {
  FinnhubError, FINNHUB_FAILURE_LABELS,
  type FinnhubFailure, type FinnhubQuote, type FinnhubProfile, type FinnhubMetrics,
  type EarningsCalendarEntry, type IpoCalendarEntry, type EarningsSurprise, type Recommendation,
  type InsiderTransaction, type InsiderSentiment, type FinnhubFiling, type MarketStatus,
} from "./finnhub-shapes.ts";

const BASE = "https://finnhub.io/api/v1";

function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

export function finnhubApiKey() {
  return runtimeEnv().FINNHUB_API_KEY ?? process.env.FINNHUB_API_KEY;
}

export function finnhubConfigured() {
  return Boolean(finnhubApiKey());
}

async function request<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const key = finnhubApiKey();
  if (!key) throw new FinnhubError("not_configured", FINNHUB_FAILURE_LABELS.not_configured);
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(name, String(value));
  query.set("token", key);
  const response = await fetch(`${BASE}/${path}?${query}`, { headers: { accept: "application/json" } });
  const failure = classifyStatus(response.status);
  if (failure) throw new FinnhubError(failure, failure === "upstream" ? `Finnhub ${path} HTTP ${response.status}` : FINNHUB_FAILURE_LABELS[failure], response.status);
  return await response.json() as T;
}

// --- quotes and reference ---------------------------------------------------


// --- typed fetchers ---------------------------------------------------------

export const fetchQuote = async (symbol: string) =>
  mapQuote(symbol, await request("quote", { symbol }));
export const fetchProfile = async (symbol: string) =>
  mapProfile(symbol, await request("stock/profile2", { symbol }));
export const fetchPeers = async (symbol: string) =>
  mapPeers(symbol, await request("stock/peers", { symbol }));
export const fetchMetrics = async (symbol: string) =>
  mapMetrics(symbol, await request("stock/metric", { symbol, metric: "all" }));
export const fetchEarningsCalendar = async (from: string, to: string, symbol?: string) =>
  mapEarningsCalendar(await request("calendar/earnings", { from, to, symbol }));
export const fetchIpoCalendar = async (from: string, to: string) =>
  mapIpoCalendar(await request("calendar/ipo", { from, to }));
export const fetchEarningsSurprises = async (symbol: string) =>
  mapEarningsSurprises(symbol, await request("stock/earnings", { symbol }));
export const fetchRecommendations = async (symbol: string) =>
  mapRecommendations(symbol, await request("stock/recommendation", { symbol }));
export const fetchInsiderTransactions = async (symbol: string, from?: string, to?: string) =>
  mapInsiderTransactions(symbol, await request("stock/insider-transactions", { symbol, from, to }));
export const fetchInsiderSentiment = async (symbol: string, from: string, to: string) =>
  mapInsiderSentiment(symbol, await request("stock/insider-sentiment", { symbol, from, to }));
export const fetchFilings = async (symbol: string, from?: string, to?: string) =>
  mapFilings(symbol, await request("stock/filings", { symbol, from, to }));
export const fetchMarketStatus = async (exchange = "US") =>
  mapMarketStatus(exchange, await request("stock/market-status", { exchange }));

// --- capability probe -------------------------------------------------------

export type FinnhubCapability = {
  id: string;
  label: string;
  description: string;
  /** What QQuant gains that it did not have before. Empty when it duplicates an existing source. */
  fills: string;
  status: "connected" | "plan_locked" | "unavailable" | "not_configured";
  detail: string;
};

const PROBES: Array<{ id: string; label: string; description: string; fills: string; run: () => Promise<string> }> = [
  { id: "quote", label: "실시간 시세", description: "현재가·당일 고저·전일 종가", fills: "", run: async () => { const q = await fetchQuote("AAPL"); return `AAPL $${q.current}`; } },
  { id: "market_status", label: "거래소 상태·휴장일", description: "장 개폐 여부, 세션 구분, 휴장일", fills: "인트라데이 엔진의 반휴장일 처리", run: async () => { const s = await fetchMarketStatus("US"); return s.isOpen ? "장중" : `장외 · ${s.session ?? "-"}`; } },
  { id: "earnings_calendar", label: "실적 캘린더 (예정)", description: "향후 실적 발표일 + 장전/장후 + 컨센서스 EPS", fills: "EDGAR가 못 주는 미래 발표일과 컨센서스", run: async () => { const rows = await fetchEarningsCalendar(todayIso(), addDaysIso(30)); return `향후 30일 ${rows.length}건`; } },
  { id: "earnings_surprise", label: "실적 서프라이즈 이력", description: "분기별 예상치 대비 실제치", fills: "종목 단위 서프라이즈 (기존 이벤트 스파인은 매크로 지표만)", run: async () => { const rows = await fetchEarningsSurprises("AAPL"); return `AAPL ${rows.length}분기`; } },
  { id: "peers", label: "유사 기업", description: "동종 업계 비교 종목", fills: "페어·리드랙 분석용 후보군 자동 생성", run: async () => `AAPL ${(await fetchPeers("AAPL")).length}개` },
  { id: "profile", label: "기업 프로필", description: "거래소, 업종, 시총, 상장일", fills: "상장일과 시총", run: async () => { const p = await fetchProfile("AAPL"); return `${p.industry} · $${Math.round(p.marketCapUsdMillions ?? 0).toLocaleString()}M`; } },
  { id: "metrics", label: "재무 지표", description: "베타, 밸류에이션, 마진, 성장률, 52주 고저", fills: "펀더멘털 전체 (기존에 없음)", run: async () => { const m = await fetchMetrics("AAPL"); return `베타 ${m.beta ?? "—"} · PER ${m.peRatio ?? "—"}`; } },
  { id: "recommendations", label: "애널리스트 컨센서스", description: "매수/보유/매도 분포와 추이", fills: "애널리스트 포지셔닝 (기존에 없음)", run: async () => { const rows = await fetchRecommendations("AAPL"); return `${rows.length}개월 · 최근 순매수 ${rows[0]?.netBullishPct ?? "—"}%`; } },
  { id: "insider_transactions", label: "내부자 거래", description: "임원·이사의 Form 4 매매 내역", fills: "내부자 거래 (기존에 없음)", run: async () => `AAPL ${(await fetchInsiderTransactions("AAPL")).length}건` },
  { id: "insider_sentiment", label: "내부자 심리 (MSPR)", description: "월별 내부자 순매수 지수", fills: "내부자 심리 시계열 (기존에 없음)", run: async () => { const rows = await fetchInsiderSentiment("AAPL", "2026-01-01", todayIso()); return `${rows.length}개월`; } },
  { id: "filings", label: "SEC 공시 목록", description: "10-K, 10-Q, 8-K 등 제출 이력", fills: "", run: async () => `AAPL ${(await fetchFilings("AAPL")).length}건` },
  { id: "ipo_calendar", label: "IPO 캘린더", description: "신규 상장 일정과 공모가", fills: "신규 상장 추적 (기존에 없음)", run: async () => `최근 90일 ${(await fetchIpoCalendar(addDaysIso(-90), todayIso())).length}건` },
  { id: "candles", label: "가격 캔들 (일봉·분봉)", description: "OHLCV 시계열", fills: "", run: async () => { await request("stock/candle", { symbol: "AAPL", resolution: "D", from: Math.floor(Date.now() / 1000) - 86400 * 7, to: Math.floor(Date.now() / 1000) }); return "사용 가능"; } },
];

function todayIso() { return new Date().toISOString().slice(0, 10); }
function addDaysIso(days: number) { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

/**
 * Calls one cheap request per capability and reports what the plan allows.
 *
 * The probe is real traffic, not a guess from a documentation table: plans
 * change, and a settings page that claims a connection it does not have is worse
 * than one that says nothing. Runs sequentially to stay inside the free tier's
 * 60-per-minute limit.
 */
export async function probeFinnhub(): Promise<{ configured: boolean; capabilities: FinnhubCapability[] }> {
  if (!finnhubConfigured()) {
    return {
      configured: false,
      capabilities: PROBES.map((probe) => ({ id: probe.id, label: probe.label, description: probe.description, fills: probe.fills, status: "not_configured" as const, detail: FINNHUB_FAILURE_LABELS.not_configured })),
    };
  }
  const capabilities: FinnhubCapability[] = [];
  for (const probe of PROBES) {
    try {
      capabilities.push({ id: probe.id, label: probe.label, description: probe.description, fills: probe.fills, status: "connected", detail: await probe.run() });
    } catch (error) {
      const kind = error instanceof FinnhubError ? error.kind : "upstream";
      capabilities.push({
        id: probe.id, label: probe.label, description: probe.description, fills: probe.fills,
        status: kind === "forbidden" ? "plan_locked" : kind === "not_configured" ? "not_configured" : "unavailable",
        detail: error instanceof Error ? error.message : "확인 실패",
      });
    }
  }
  return { configured: true, capabilities };
}
