/**
 * The network calls behind the 급등주 ranking history.
 *
 * Kept apart from `lib/surge-universe.ts` so the filters and the ranking stay
 * importable by the Node test runner, which cannot load the Workers-only
 * Massive client.
 *
 * Two endpoints, one purpose. The grouped-daily call rebuilds a past session's
 * ranking; the splits call says which of those moves were corporate actions
 * rather than trading, because the ranking reads raw prices.
 */

import { massiveApiKey, massivePlan, MassiveError } from "./massive.ts";
import { toMarketRows, type GroupedRow, type MarketRow } from "./surge-universe.ts";

const BASE = "https://api.massive.com";

export async function fetchGroupedDaily(date: string, keepAllCloses = false): Promise<MarketRow[]> {
  const apiKey = massiveApiKey();
  if (!apiKey) throw new MassiveError("not_configured", "MASSIVE_API_KEY가 연결되지 않았습니다.", 503);
  const url = new URL(`/v2/aggs/grouped/locale/us/market/stocks/${date}`, BASE);
  // Raw, not split-adjusted: see the header of `lib/surge-universe.ts`.
  url.searchParams.set("adjusted", "false");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new MassiveError("upstream", "Massive 전체 시장 일봉에 연결하지 못했습니다.");
  }
  const payload = await response.json().catch(() => ({})) as { results?: GroupedRow[]; error?: string; message?: string };
  if (response.status === 401) throw new MassiveError("auth", "Massive API 키 인증에 실패했습니다.", 401);
  if (response.status === 403) {
    throw new MassiveError("plan_locked", `Massive ${massivePlan()} 은 ${date} 전체 시장 일봉을 제공하지 않습니다 (과거 2년까지).`, 403);
  }
  if (response.status === 429) throw new MassiveError("rate_limit", "Massive 분당 호출 한도를 초과했습니다.", 429);
  if (!response.ok) {
    throw new MassiveError("upstream", `Massive 전체 시장 일봉 조회 실패: ${payload.error ?? payload.message ?? response.status}`);
  }
  return toMarketRows(payload.results ?? [], keepAllCloses);
}

export type SplitEvent = { ticker: string; executionDate: string; from: number; to: number };

/**
 * Every split that executed in a window, newest first.
 *
 * A reverse split is the single most common way a nothing-happened session
 * looks like a +900% surge in raw prices, and these names are exactly the kind
 * a gainer screen surfaces — sub-$1 tickers doing 1:10 to regain a listing
 * requirement. The endpoint pages at 1,000 rows; a year of US splits is a few
 * hundred, so this is two or three calls, once, cached in D1.
 */
export async function fetchSplits(from: string, to: string, onProgress: (message: string) => void = () => undefined) {
  const apiKey = massiveApiKey();
  if (!apiKey) throw new MassiveError("not_configured", "MASSIVE_API_KEY가 연결되지 않았습니다.", 503);
  const events: SplitEvent[] = [];
  let next: URL | null = new URL(
    `/v3/reference/splits?execution_date.gte=${from}&execution_date.lte=${to}&limit=1000&order=asc&sort=execution_date`,
    BASE,
  );
  for (let page = 1; next && page <= 10; page += 1) {
    onProgress(`분할·병합 이력 ${page}페이지 (${from}–${to})`);
    const response = await fetch(next, {
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!response) throw new MassiveError("upstream", "Massive 분할 이력에 연결하지 못했습니다.");
    const payload = await response.json().catch(() => ({})) as {
      results?: Array<{ ticker?: string; execution_date?: string; split_from?: number; split_to?: number }>;
      next_url?: string | null;
    };
    if (response.status === 429) throw new MassiveError("rate_limit", "Massive 분당 호출 한도를 초과했습니다.", 429);
    if (!response.ok) throw new MassiveError("upstream", `Massive 분할 이력 조회 실패 (HTTP ${response.status})`);
    for (const row of payload.results ?? []) {
      if (!row.ticker || !row.execution_date) continue;
      events.push({
        ticker: row.ticker.toUpperCase(),
        executionDate: row.execution_date,
        from: Number(row.split_from) || 1,
        to: Number(row.split_to) || 1,
      });
    }
    if (!payload.next_url) break;
    const url = new URL(payload.next_url);
    if (url.origin !== BASE) throw new MassiveError("upstream", "Massive 페이지 주소가 예상한 호스트와 다릅니다.");
    next = url;
  }
  return events;
}
