import { registeredRelayStrategies } from "@/lib/strategy-generation-store";
import { barMinutesOf, runRelay } from "@/lib/relay-engine";
import { buildRelayReport } from "@/lib/relay-report";
import { lastCompleteDate, loadRelaySessions, mergeSessionSteps } from "@/lib/relay-data";

export const dynamic = "force-dynamic";

/** The fixed starting balance both dashboards trade. */
const CAPITAL_USD = 1_000;
const MAX_SPAN_DAYS = 740;

type Line = { type: "progress"; message: string } | { type: "result"; report: ReturnType<typeof buildRelayReport> } | { type: "error"; message: string };

/**
 * Runs every registered slot strategy over a date range and streams NDJSON:
 * progress lines while bars load (an uncached month waits on Massive's five
 * calls a minute), then one `result` line with the full report.
 */
export async function POST(request: Request) {
  const RELAY_STRATEGIES = await registeredRelayStrategies();
  const body = await request.json().catch(() => ({})) as { from?: string; to?: string; dashboard?: string };
  const from = String(body.from ?? "");
  const to = String(body.to ?? "");
  const dashboard = body.dashboard === "live" || body.dashboard === "paper" ? body.dashboard : null;
  const valid = /^\d{4}-\d{2}-\d{2}$/;
  if (!valid.test(from) || !valid.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return Response.json({ error: "시작일과 종료일을 YYYY-MM-DD 형식으로 입력하세요." }, { status: 400 });
  }
  if (from > to) return Response.json({ error: "시작일이 종료일보다 늦습니다." }, { status: 400 });
  const latest = lastCompleteDate();
  if (from > latest) return Response.json({ error: `분봉은 ${latest}까지(전 거래일)만 있습니다. 시작일을 앞당기세요.` }, { status: 400 });
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_SPAN_DAYS) {
    return Response.json({ error: "기간은 최대 2년입니다 (Massive Basic 제공 범위)." }, { status: 400 });
  }
  if (!RELAY_STRATEGIES.length) {
    return Response.json({ error: "등록된 전략이 없습니다. 전략 탭에서 새 전략 생성을 완료하세요." }, { status: 422 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: Line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      try {
        const warmup = Math.max(0, ...RELAY_STRATEGIES.map((strategy) => strategy.warmupSessions));
        // Each rule is replayed on the bar it reads — the same bar the live runner builds for it.
        const steps = [...new Set(RELAY_STRATEGIES.map(barMinutesOf))].sort((a, b) => b - a);
        const loads = [];
        for (const step of steps) {
          const symbols = [...new Set(RELAY_STRATEGIES.filter((strategy) => barMinutesOf(strategy) === step).flatMap((strategy) => strategy.universe))];
          send({ type: "progress", message: `전략 ${RELAY_STRATEGIES.length}개 · 종목 ${symbols.join(", ")} ${step}분봉 준비` });
          loads.push({ step, ...await loadRelaySessions(symbols, from, to < latest ? to : latest, warmup, (message) => send({ type: "progress", message }), step) });
        }
        const loaded = {
          sessions: mergeSessionSteps(loads),
          warmup: Math.min(...loads.map((load) => load.warmup)),
          sources: loads.flatMap((load) => load.sources),
          warnings: loads.flatMap((load) => load.warnings),
        };
        const evaluated = loaded.sessions.length - loaded.warmup;
        if (evaluated <= 0) throw new Error("기간 안에 거래 세션이 없습니다.");
        send({ type: "progress", message: `${evaluated}개 세션에서 전략 실행` });
        // The engine skips the rule's full warm-up; when fewer prior sessions exist it
        // starts evaluating late, which loadRelaySessions has already warned about.
        const result = runRelay(RELAY_STRATEGIES, loaded.sessions, { capitalUsd: CAPITAL_USD });
        const warnings = [...loaded.warnings];
        if (to > latest) warnings.push(`${latest} 이후는 아직 분봉이 없어 제외했습니다.`);
        send({ type: "result", report: buildRelayReport({ result, strategies: RELAY_STRATEGIES, from, to: to < latest ? to : latest, sources: loaded.sources, warnings, dashboard }) });
      } catch (error) {
        console.error("[relay/backtest]", error instanceof Error ? error.message : error);
        send({ type: "error", message: error instanceof Error ? error.message : "백테스트에 실패했습니다." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
