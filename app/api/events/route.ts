import { applyTransform, computeSurprises, eventRootInfo, EVENT_ROOTS, knownEventRoots, SURPRISE_BASIS_LABELS, type SurpriseBasis } from "@/lib/market-events";
import { calendarSeedRows, listMarketEvents, upsertMarketEvents, updateEventValues } from "@/lib/market-events-store";
import { fetchInitialReleases, fetchLatestValues, fredConfigured } from "@/lib/fred";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Reads the event spine. `roots` filters, `from`/`to` bound the window. */
export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const url = new URL(request.url);
  const headers = { "set-cookie": researchOwnerCookie(ownerId) };
  const roots = (url.searchParams.get("roots") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const from = url.searchParams.get("from") ?? "2015-01-01";
  const to = url.searchParams.get("to") ?? today();
  try {
    const events = await listMarketEvents(roots, from, to);
    return Response.json({
      period: { from, to }, count: events.length, events,
      taxonomy: EVENT_ROOTS.map((item) => ({ root: item.root, label: item.label, category: item.category, fredSeries: item.fredSeries, unit: item.unit })),
      surpriseBases: SURPRISE_BASIS_LABELS,
      fredConfigured: fredConfigured(),
    }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "이벤트를 불러오지 못했습니다." }, { status: 503, headers });
  }
}

/**
 * Ingestion. Two independent steps:
 *
 * - `seed` writes the hand-maintained static calendar into the table (schedule only).
 * - `backfill` pulls actuals from FRED for one event root. It stores the value as
 *   *first released* separately from the latest revision, because a backtest that
 *   reads a revised print is reading a number nobody had on the day — which can
 *   flip the sign of the surprise it is supposedly trading.
 *
 * Consensus has no free source (Toss serves session hours only, Yahoo exposes no
 * economic calendar, TradingView is a widget), so it is accepted here as manual
 * input and the surprise falls back to a naive-forecast deviation otherwise.
 */
export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const headers = { "set-cookie": researchOwnerCookie(ownerId) };
  const payload = await request.json().catch(() => ({})) as {
    action?: string; root?: string; from?: string; to?: string;
    consensus?: Array<{ eventDate: string; consensus: number }>;
  };
  const action = payload.action ?? "seed";

  try {
    if (action === "seed") {
      const rows = calendarSeedRows(today());
      const written = await upsertMarketEvents(rows);
      return Response.json({ action, written, roots: [...new Set(rows.map((row) => row.eventRoot))] }, { headers });
    }

    if (action === "backfill") {
      const root = String(payload.root ?? "").trim();
      const info = eventRootInfo(root);
      if (!info) return Response.json({ error: `알 수 없는 이벤트 루트입니다. 사용 가능: ${knownEventRoots().join(", ")}` }, { status: 400, headers });
      if (!info.fredSeries) return Response.json({ error: `${info.label}은 FRED 시리즈가 없어 실제치를 자동으로 받을 수 없습니다. consensus/actual을 수동 입력하세요.` }, { status: 400, headers });
      if (!fredConfigured()) return Response.json({ error: "FRED_API_KEY가 연결되지 않았습니다. https://fred.stlouisfed.org/docs/api/api_key.html 에서 무료로 발급받아 환경변수에 넣으세요." }, { status: 503, headers });

      const from = payload.from ?? "2015-01-01";
      const to = payload.to ?? today();
      const [initial, latest, events] = await Promise.all([
        fetchInitialReleases(info.fredSeries, from, to),
        fetchLatestValues(info.fredSeries, from, to),
        listMarketEvents([root], from, to),
      ]);
      const latestByPeriod = new Map(latest.map((row) => [row.observationDate, row.value]));
      const manualConsensus = new Map((payload.consensus ?? []).map((row) => [row.eventDate, Number(row.consensus)]));

      // Raw series values are turned into the headline the market trades (CPI's
      // month-over-month percent, payrolls' month-over-month change) before any
      // surprise is computed — comparing an index *level* to its own trailing
      // mean measures the trend, not news.
      const transformed = applyTransform(
        initial.map((row) => ({ ...row, latest: latestByPeriod.get(row.observationDate) ?? null })),
        info.transform,
      );
      // A release published on day D reports the *previous* period, so vintages are
      // matched to calendar events by release date, not by observation period.
      const releases = transformed
        .filter((row) => row.headline !== null)
        .sort((left, right) => left.realtimeStart.localeCompare(right.realtimeStart));

      const matched = events.map((event) => {
        const release = releases.find((row) => row.realtimeStart === event.eventDate)
          ?? releases.find((row) => row.realtimeStart > event.eventDate === false && row.realtimeStart >= event.eventDate);
        return { event, release: release ?? null };
      });

      const previousByIndex = new Map<number, number | null>();
      matched.forEach((item, index) => previousByIndex.set(index, index > 0 ? matched[index - 1].release?.headline ?? null : null));

      const surprises = computeSurprises(matched.map((item, index) => ({
        eventDate: item.event.eventDate,
        actualInitial: item.release?.headline ?? null,
        previous: previousByIndex.get(index) ?? null,
        consensus: manualConsensus.get(item.event.eventDate) ?? null,
      })));
      const surpriseByDate = new Map(surprises.map((row) => [row.eventDate, row]));

      let updated = 0;
      for (const [index, item] of matched.entries()) {
        if (!item.release) continue;
        const surprise = surpriseByDate.get(item.event.eventDate);
        await updateEventValues(root, item.event.eventDate, {
          actualInitial: item.release.headline,
          actualRevised: item.release.headlineLatest,
          previous: previousByIndex.get(index) ?? null,
          consensus: manualConsensus.get(item.event.eventDate) ?? null,
          surprise: surprise?.surprise ?? null,
          surpriseZ: surprise?.surpriseZ ?? null,
          surpriseBasis: (surprise?.basis ?? "none") satisfies SurpriseBasis,
        });
        updated += 1;
      }

      const bases = [...new Set(surprises.map((row) => row.basis))];
      return Response.json({
        action, root, series: info.fredSeries, transform: info.transform, period: { from, to },
        calendarEvents: events.length, fredReleases: releases.length, updated,
        surpriseBases: bases.map((basis) => ({ basis, label: SURPRISE_BASIS_LABELS[basis] })),
        caveat: bases.includes("consensus")
          ? "일부 이벤트만 컨센서스 기반입니다. 나머지는 나이브 예측 대비 편차입니다."
          : "컨센서스 데이터가 없어 전부 나이브 예측(직전 평균/직전치) 대비 편차로 계산했습니다. 실제 이코노미스트 서프라이즈보다 약한 신호입니다.",
      }, { headers });
    }

    return Response.json({ error: `알 수 없는 action입니다: ${action}. seed 또는 backfill을 사용하세요.` }, { status: 400, headers });
  } catch (error) {
    console.error("[events] failed", error instanceof Error ? error.message : error);
    return Response.json({ error: error instanceof Error ? error.message : "이벤트 처리에 실패했습니다." }, { status: 500, headers });
  }
}
