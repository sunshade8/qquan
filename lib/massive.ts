/** Massive.com historical US stock aggregates for Cloudflare Workers. */

import { env } from "cloudflare:workers";
import {
  MASSIVE_AGGREGATE_INTERVALS,
  parseMassiveAggregates,
  type MassiveAggregate,
  type MassiveInterval,
  type MassiveIntradayPoint,
} from "./massive-shapes.ts";

const BASE = "https://api.massive.com";
const PAGE_LIMIT = 50_000;
const DEFAULT_MAX_PAGES = 5;

export type MassiveFailure = "not_configured" | "auth" | "plan_locked" | "rate_limit" | "not_found" | "too_large" | "upstream";

export class MassiveError extends Error {
  constructor(public readonly kind: MassiveFailure, message: string, public readonly status = 502) {
    super(message);
  }
}

type MassiveAggregatesPage = {
  status?: string;
  results?: MassiveAggregate[];
  resultsCount?: number;
  next_url?: string | null;
  error?: string;
  message?: string;
};

export type MassiveHistory = {
  points: MassiveIntradayPoint[];
  provider: "Massive";
  plan: string;
  availableFrom: string;
  dataRecency: "end_of_day" | "delayed" | "real_time";
};

function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

function configuredValue(key: string) {
  return runtimeEnv()[key] ?? process.env[key];
}

export function massiveApiKey() {
  return configuredValue("MASSIVE_API_KEY") ?? configuredValue("POLYGON_API_KEY");
}

export function massiveConfigured() {
  return Boolean(massiveApiKey());
}

export function massivePlan() {
  return configuredValue("MASSIVE_PLAN")?.trim() || "Basic";
}

export function massiveHistoryYears() {
  const parsed = Number(configuredValue("MASSIVE_HISTORY_YEARS") ?? "2");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

export function massiveRateLimitPerMinute() {
  const parsed = Number(configuredValue("MASSIVE_CALLS_PER_MINUTE") ?? "5");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
}

export function massiveDataRecency(): MassiveHistory["dataRecency"] {
  const value = configuredValue("MASSIVE_DATA_RECENCY")?.toLowerCase();
  return value === "real_time" || value === "delayed" ? value : "end_of_day";
}

function shiftYears(date: string, years: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() - years);
  return value.toISOString().slice(0, 10);
}

export function massiveAvailableFrom(referenceDate = new Date().toISOString().slice(0, 10)) {
  return shiftYears(referenceDate, massiveHistoryYears());
}

function messageOf(payload: MassiveAggregatesPage) {
  return payload.error ?? payload.message ?? "";
}

function failureFor(response: Response, payload: MassiveAggregatesPage) {
  const message = messageOf(payload);
  if (response.status === 401) return new MassiveError("auth", "Massive API 키 인증에 실패했습니다.", response.status);
  if (response.status === 403) return new MassiveError("plan_locked", `Massive 요금제가 요청한 분봉 기간을 허용하지 않습니다.${message ? ` ${message}` : ""}`, response.status);
  if (response.status === 429) return new MassiveError("rate_limit", "Massive Basic의 분당 호출 한도를 초과했습니다. 잠시 뒤 기간이나 종목 수를 줄여 다시 시도해주세요.", response.status);
  if (response.status === 404) return new MassiveError("not_found", "Massive에서 이 종목의 분봉 데이터를 찾지 못했습니다.", response.status);
  return new MassiveError("upstream", `Massive 분봉 데이터를 가져오지 못했습니다.${message ? ` ${message}` : ""}`, response.status);
}

function checkedNextUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== BASE) throw new MassiveError("upstream", "Massive 페이지 주소가 예상한 API 호스트와 다릅니다.");
  return url;
}

export async function fetchMassiveIntradayWindow(
  symbol: string,
  from: string,
  to: string,
  interval: MassiveInterval,
  options: { session?: "all" | "regular"; maxBars?: number; maxPages?: number } = {},
): Promise<MassiveHistory> {
  const apiKey = massiveApiKey();
  if (!apiKey) throw new MassiveError("not_configured", "MASSIVE_API_KEY가 연결되지 않았습니다.", 503);

  const availableFrom = massiveAvailableFrom();
  if (from < availableFrom) {
    throw new MassiveError("plan_locked", `Massive ${massivePlan()}은 최근 ${massiveHistoryYears()}년만 제공합니다. 시작일을 ${availableFrom} 이후로 줄여주세요.`, 403);
  }

  const aggregate = MASSIVE_AGGREGATE_INTERVALS[interval];
  const first = new URL(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${aggregate.multiplier}/${aggregate.timespan}/${from}/${to}`, BASE);
  first.searchParams.set("adjusted", "true");
  first.searchParams.set("sort", "asc");
  first.searchParams.set("limit", String(PAGE_LIMIT));

  const maxBars = Math.max(1_000, options.maxBars ?? 160_000);
  const maxPages = Math.max(1, Math.min(DEFAULT_MAX_PAGES, options.maxPages ?? DEFAULT_MAX_PAGES));
  const byTimestamp = new Map<number, MassiveIntradayPoint>();
  let next: URL | null = first;
  let pages = 0;

  while (next) {
    pages += 1;
    let response: Response;
    try {
      response = await fetch(next, {
        headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new MassiveError("upstream", "Massive 분봉 데이터에 연결하지 못했습니다.");
    }
    const payload = await response.json().catch(() => ({})) as MassiveAggregatesPage;
    if (!response.ok) throw failureFor(response, payload);
    const page = parseMassiveAggregates(payload.results ?? [], from, to, options.session ?? "all");
    page.forEach((point) => byTimestamp.set(point.timestamp, point));
    if (byTimestamp.size > maxBars) {
      throw new MassiveError("too_large", `요청 구간이 안전 한도 ${maxBars.toLocaleString()}개 분봉을 넘습니다. 기간이나 종목 수를 줄여주세요.`, 413);
    }
    if (payload.next_url && pages >= maxPages) {
      throw new MassiveError("too_large", `Massive ${massivePlan()} 호출 한도에 맞추려면 조회 기간이나 종목 수를 줄여주세요.`, 413);
    }
    next = payload.next_url ? checkedNextUrl(payload.next_url) : null;
  }

  const points = [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
  if (!points.length) throw new MassiveError("not_found", "Massive에서 해당 구간의 분봉 데이터가 없습니다.", 404);
  return { points, provider: "Massive", plan: massivePlan(), availableFrom, dataRecency: massiveDataRecency() };
}

export type MassiveProbe = {
  configured: boolean;
  status: "connected" | "not_configured" | "auth_error" | "plan_locked" | "unavailable";
  detail: string;
  plan: string;
  historyYears: number;
  availableFrom: string;
  dataRecency: MassiveHistory["dataRecency"];
  callsPerMinute: number;
};

function shiftDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export async function probeMassive(): Promise<MassiveProbe> {
  const today = new Date().toISOString().slice(0, 10);
  const base = {
    plan: massivePlan(),
    historyYears: massiveHistoryYears(),
    availableFrom: massiveAvailableFrom(today),
    dataRecency: massiveDataRecency(),
    callsPerMinute: massiveRateLimitPerMinute(),
  };
  if (!massiveConfigured()) return { ...base, configured: false, status: "not_configured", detail: "MASSIVE_API_KEY 미설정" };
  const end = shiftDays(today, -1);
  const start = shiftDays(end, -7);
  try {
    const history = await fetchMassiveIntradayWindow("AAPL", start, end, "5m", { session: "regular", maxBars: PAGE_LIMIT, maxPages: 1 });
    return { ...base, configured: true, status: "connected", detail: `AAPL 5분봉 ${history.points.length.toLocaleString()}개 · ${massivePlan()}` };
  } catch (error) {
    const kind = error instanceof MassiveError ? error.kind : "upstream";
    const status = kind === "auth" ? "auth_error" : kind === "plan_locked" ? "plan_locked" : "unavailable";
    return { ...base, configured: true, status, detail: error instanceof Error ? error.message : "Massive 확인 실패" };
  }
}
