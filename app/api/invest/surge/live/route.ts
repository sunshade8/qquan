/**
 * Today's same-day events, and what the published rules can do with them.
 *
 * - **`events`** — names that became a surge or crash event TODAY, with the
 *   minute each was first observed and the move it was observed at. These come
 *   from the live observer (`lib/surge-intraday-live.ts`), which replays Toss's
 *   one-minute candles through the backtest's own event definition. It runs
 *   while a 급등주 dashboard is running.
 * - **`rules`** — every published rule, the events it could still enter now,
 *   and why it is withheld when it cannot run.
 * - **`boards`** — all six of Toss's live ranking screens, for watching. During
 *   the session `TOP_GAINERS`/`TOP_LOSERS` at `1d` are the observer's discovery
 *   feed; a listed name only becomes an event once its minutes meet the whole
 *   definition. Every row is filtered to US listings in code.
 *
 * No model is called anywhere in this file. That is the point of the design.
 */

import { fetchRanking, RankingError, RANKING_BOARDS, RANKING_LIMITS } from "@/lib/surge-live";
import { readIntradaySurgePool } from "@/lib/surge-intraday-live";
import { todaysSurgeRules } from "@/lib/surge-slot-strategies";
import { SURGE_POOLS, type SurgePool } from "@/lib/surge-spec";
import { SURGE_OBSERVATION } from "@/lib/surge-observation";
import { surgeRoundTripPct } from "@/lib/surge-costs";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("pool");
  const pool: SurgePool = (SURGE_POOLS as readonly string[]).includes(requested ?? "")
    ? (requested as SurgePool)
    : "gainers";

  const observation = await readIntradaySurgePool().catch((error) => ({
    date: "", checkedAt: null, note: null, candidates: { gainers: [], losers: [] },
    error: error instanceof Error ? error.message : "당일 관측 기록을 읽지 못했습니다.",
  }));
  const rules = (await todaysSurgeRules().catch(() => [])).filter((rule) => rule.pool === pool);

  const body = {
    pool,
    definition: SURGE_OBSERVATION,
    observation: {
      date: observation.date,
      checkedAt: observation.checkedAt,
      error: observation.error,
      note: observation.note,
      events: observation.candidates[pool].map((event) => ({
        symbol: event.symbol,
        rank: event.rank,
        observedAt: event.observedAt ?? null,
        availableAt: event.availableAt ?? null,
        changePct: event.changePct,
        observedPrice: event.observedPrice ?? null,
        prevClose: event.prevClose,
        sessionDollarVolume: event.dollarVolume,
        modelledRoundTripPct: Number(surgeRoundTripPct(event.symbol, event.observedPrice ?? event.prevClose, event.priorDollarVolume ?? event.dollarVolume).toFixed(3)),
      })),
    },
    rules,
    limits: RANKING_LIMITS,
  };

  /**
   * All six screens the endpoint offers, not just the two surge lists: the
   * turnover boards are how you tell a real move from two hundred shares of
   * premarket tape. They are read one at a time because the RANKING rate-limit
   * group refuses six at once, and each answer is cached for twenty seconds.
   */
  const boards = [];
  for (const board of RANKING_BOARDS) {
    const period = board.id === "TOP_GAINERS" || board.id === "TOP_LOSERS" ? "1d" : "realtime";
    try {
      const snapshot = await fetchRanking(board.id, "US", period);
      boards.push({
        ...board,
        rankedAt: snapshot.rankedAt,
        duration: snapshot.duration,
        filtered: snapshot.filtered,
        rows: snapshot.rows,
        error: null as string | null,
      });
    } catch (error) {
      boards.push({
        ...board, rankedAt: null, duration: null, filtered: 0, rows: [] as typeof boards[number]["rows"],
        error: error instanceof RankingError ? error.message : error instanceof Error ? error.message : "토스 랭킹 조회 실패",
      });
    }
  }

  return Response.json({
    ...body,
    fetchedAt: new Date().toISOString(),
    boards,
    error: boards.every((board) => board.error) ? boards[0].error : null,
  }, { headers: { "cache-control": "no-store" } });
}
