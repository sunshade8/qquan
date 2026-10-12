import { dataRPC, localStockPoints } from "./local-market-data.ts";
/** Massive.com configuration and local historical compatibility API. */

import { env } from "cloudflare:workers";
import type {
  MassiveInterval,
  MassiveIntradayPoint,
} from "./massive-shapes.ts";

export type MassiveFailure =
  | "not_configured"
  | "auth"
  | "plan_locked"
  | "rate_limit"
  | "not_found"
  | "too_large"
  | "upstream";

export class MassiveError extends Error {
  // Plain fields rather than parameter properties so Node's type stripping can load this in tests.
  readonly kind: MassiveFailure;
  readonly status: number;

  constructor(kind: MassiveFailure, message: string, status = 502) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

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
  return (
    configuredValue("MASSIVE_API_KEY") ?? configuredValue("POLYGON_API_KEY")
  );
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

export function massiveAvailableFrom(
  referenceDate = new Date().toISOString().slice(0, 10),
) {
  return shiftYears(referenceDate, massiveHistoryYears());
}

export async function fetchMassiveIntradayWindow(
  symbol: string,
  from: string,
  to: string,
  interval: MassiveInterval,
  options: {
    session?: "all" | "regular";
    maxBars?: number;
    maxPages?: number;
    adjusted?: boolean;
    allowEmpty?: boolean;
  } = {},
): Promise<MassiveHistory> {
  if (options.adjusted !== false)
    throw new MassiveError(
      "not_found",
      "수정주가 파생 데이터셋이 없습니다. 로컬 원본은 adjusted=false로 명시하세요.",
      409,
    );
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
    plan: massivePlan(),
    availableFrom: from,
    dataRecency: "end_of_day",
  };
}

export type MassiveProbe = {
  configured: boolean;
  status:
    | "connected"
    | "not_configured"
    | "auth_error"
    | "plan_locked"
    | "unavailable";
  detail: string;
  plan: string;
  historyYears: number;
  availableFrom: string;
  dataRecency: MassiveHistory["dataRecency"];
  callsPerMinute: number;
};

export async function probeMassive(): Promise<MassiveProbe> {
  const today = new Date().toISOString().slice(0, 10);
  const base = {
    plan: massivePlan(),
    historyYears: massiveHistoryYears(),
    availableFrom: massiveAvailableFrom(today),
    dataRecency: massiveDataRecency(),
    callsPerMinute: massiveRateLimitPerMinute(),
  };
  if (!massiveConfigured())
    return {
      ...base,
      configured: false,
      status: "not_configured",
      detail: "MASSIVE_API_KEY 미설정",
    };
  try {
    const catalog = await dataRPC<Array<{ dataset: string; rows: number }>>({
      action: "status",
    });
    const stock = catalog.find((d) => d.dataset === "stock");
    return {
      ...base,
      configured: true,
      status: stock?.rows ? "connected" : "unavailable",
      detail: stock?.rows
        ? `로컬 검증 NVDA 원봉 ${stock.rows}개 · 실제 권한은 요청 구간별 다운로드 결과 참조`
        : "키 설정됨 · 설정의 주식 1분봉 다운로드로 실제 구간 권한 확인",
    };
  } catch {
    return {
      ...base,
      configured: true,
      status: "unavailable",
      detail: "npm run data:setup으로 로컬 데이터 런타임 설치 필요",
    };
  }
}
