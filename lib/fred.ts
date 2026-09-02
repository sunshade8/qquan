/**
 * FRED / ALFRED client.
 *
 * FRED serves the *current* value of a macro series; ALFRED serves the value as
 * it stood on a given date. That distinction is the whole reason this module
 * exists. Payrolls first printed at +150K and later revised to +95K is the same
 * observation with two values, and a backtest that reads the revised number is
 * reading information nobody had on the release day — which silently flips the
 * sign of the surprise it is supposedly trading.
 *
 * Every read here therefore goes through ALFRED with an explicit real-time
 * window, and the first-released value is stored separately from the latest one.
 *
 * Docs: https://fred.stlouisfed.org/docs/api/fred/series_observations.html
 */

import { env } from "cloudflare:workers";
import { MarketProviderError } from "./market-data.ts";

const FRED_BASE = "https://api.stlouisfed.org/fred";

function runtimeEnv() {
  return env as unknown as Record<string, string | undefined>;
}

export function fredApiKey() {
  const bindings = runtimeEnv();
  return bindings.FRED_API_KEY ?? process.env.FRED_API_KEY;
}

export function fredConfigured() {
  return Boolean(fredApiKey());
}

export type FredVintage = {
  /** The period the number describes (e.g. the month of the payrolls report). */
  observationDate: string;
  /** The day that value became public — the release date, for the first vintage. */
  realtimeStart: string;
  value: number;
};

type FredObservation = { date: string; realtime_start: string; realtime_end: string; value: string };

async function fredGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = fredApiKey();
  if (!key) throw new MarketProviderError("fred", "not_configured", "FRED API 키(FRED_API_KEY)가 연결되지 않았습니다.", 503);
  const url = new URL(`${FRED_BASE}${path}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("file_type", "json");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new MarketProviderError("fred", "upstream", "FRED에 연결하지 못했습니다.", 502);
  }
  if (!response.ok) {
    const code = response.status === 400 ? "not_found" : response.status === 429 ? "rate_limit" : response.status === 403 ? "auth" : "upstream";
    throw new MarketProviderError("fred", code, code === "auth" ? "FRED API 키가 거부되었습니다." : code === "rate_limit" ? "FRED 호출 한도를 초과했습니다." : "FRED 응답을 받지 못했습니다.", response.status);
  }
  return await response.json() as T;
}

/**
 * Every vintage of a series: one row per (observation period, release date), so
 * a revision appears as a second row for the same period with a later
 * `realtimeStart`. `output_type=4` asks ALFRED for initial releases only, which
 * is exactly the point-in-time view a backtest may read.
 */
export async function fetchInitialReleases(seriesId: string, from: string, to: string): Promise<FredVintage[]> {
  const payload = await fredGet<{ observations?: FredObservation[] }>("/series/observations", {
    series_id: seriesId,
    observation_start: from,
    observation_end: to,
    realtime_start: from,
    realtime_end: to,
    output_type: "4", // initial release only
  });
  return (payload.observations ?? []).flatMap((row) => {
    const value = Number(row.value);
    return Number.isFinite(value) ? [{ observationDate: row.date, realtimeStart: row.realtime_start, value }] : [];
  });
}

/** The latest (revised) value per observation period — what FRED shows by default. */
export async function fetchLatestValues(seriesId: string, from: string, to: string): Promise<FredVintage[]> {
  const payload = await fredGet<{ observations?: FredObservation[] }>("/series/observations", {
    series_id: seriesId,
    observation_start: from,
    observation_end: to,
  });
  return (payload.observations ?? []).flatMap((row) => {
    const value = Number(row.value);
    return Number.isFinite(value) ? [{ observationDate: row.date, realtimeStart: row.realtime_start, value }] : [];
  });
}

/** Scheduled and historical release dates for a series, used to anchor events to calendar days. */
export async function fetchReleaseDates(seriesId: string, from: string, to: string): Promise<string[]> {
  const payload = await fredGet<{ release_dates?: Array<{ date: string }> }>("/series/release_dates", {
    series_id: seriesId,
    realtime_start: from,
    realtime_end: to,
    include_release_dates_with_no_data: "false",
  });
  return (payload.release_dates ?? []).map((row) => row.date).sort();
}
