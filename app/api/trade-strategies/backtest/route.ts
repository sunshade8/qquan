import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { tradeStrategyById } from "@/lib/trade-strategies";
import { backtestRecent } from "@/lib/trade-strategy-runner";
import { backtestFilename, renderBacktestMarkdown } from "@/lib/trade-strategy-report";
import { ensureInstance, saveReport, updateInstance } from "@/lib/trade-strategy-store";

const DEFAULT_SESSIONS = 60;

export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json().catch(() => ({})) as { strategyKey?: string; capitalUsd?: number; sessions?: number };
  const strategy = tradeStrategyById(String(payload.strategyKey ?? ""));
  if (!strategy) return Response.json({ error: "등록되지 않은 전략입니다." }, { status: 400 });

  // The settings row is created here rather than being a precondition, so the
  // first backtest on a fresh deployment works without any setup step.
  const capitalUsd = Number(payload.capitalUsd);
  const instance = await ensureInstance(ownerId, {
    strategyKey: strategy.id, name: strategy.name,
    capitalUsd: Number.isFinite(capitalUsd) && capitalUsd >= 100 ? capitalUsd : 10_000,
    gateway: "dry_run",
  }).catch(() => null);
  if (!instance) return Response.json({ error: "전략 저장소에 연결하지 못했습니다." }, { status: 503 });

  const requested = Number(payload.sessions);
  const sessions = Number.isFinite(requested) ? Math.min(500, Math.max(10, Math.round(requested))) : DEFAULT_SESSIONS;

  try {
    const result = await backtestRecent(strategy, { sessions, capitalUsd: instance.capitalUsd });
    const createdAt = new Date().toISOString();
    const markdown = renderBacktestMarkdown(strategy, result, createdAt);
    const filename = backtestFilename(strategy, result, createdAt);
    const title = `백테스트 · ${strategy.name} · ${result.from}~${result.to}`;
    const summary = {
      from: result.from, to: result.to, sessions: result.sessions,
      trades: result.metrics.trades, winRatePct: result.metrics.winRatePct,
      avgNetPct: result.metrics.avgNetPct, totalReturnPct: result.metrics.totalReturnPct,
      benchmarkReturnPct: result.metrics.benchmarkReturnPct, maxDrawdownPct: result.metrics.maxDrawdownPct,
    };
    const saved = await saveReport(ownerId, { instanceId: instance.id, strategyKey: strategy.id, kind: "backtest", title, filename, markdown, summary })
      .catch((error) => { console.error("[trade-backtest] report save failed", error instanceof Error ? error.message : error); return null; });
    if (saved) await updateInstance(ownerId, instance.id, { lastBacktestAt: new Date(createdAt) }).catch(() => undefined);

    return Response.json({
      result, markdown, filename, title, createdAt,
      reportId: saved?.id ?? null,
      reportSaved: Boolean(saved),
      missing: result.missing,
    }, { headers: { "set-cookie": researchOwnerCookie(ownerId) } });
  } catch (error) {
    console.error("[trade-backtest] failed", error instanceof Error ? error.message : error);
    return Response.json({ error: error instanceof Error ? error.message : "백테스트에 실패했습니다." }, { status: 503 });
  }
}
