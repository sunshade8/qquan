import { env, waitUntil } from "cloudflare:workers";
import { refreshSurgeObservationsIfRunning, startTrading, stopTrading, tickDashboards, tradingDashboards, TradingUserError, type TradingBook } from "@/lib/trading-runner";

export const dynamic = "force-dynamic";

/**
 * Which book a request addresses. The two are separate accounts with separate
 * strategy lists, so this is never inferred — an unrecognised value is the 전략
 * book, never a surge order.
 */
const bookOf = (value: string | null | undefined): TradingBook => (value === "ct-stock" || value === "ct-crypto" || value === "surge" ? value : "relay");

/** One book's two dashboards: state, readiness, and whether the runner is alive. */
export async function GET(request: Request) {
  try {
    const book = bookOf(new URL(request.url).searchParams.get("book"));
    return Response.json(await tradingDashboards(book), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[trading] load failed", error instanceof Error ? error.message : error);
    return Response.json({ error: error instanceof Error ? error.message : "대시보드를 불러오지 못했습니다." }, { status: 503 });
  }
}

/**
 * `{ action: "start" | "stop", mode, book }` controls one dashboard;
 * `{ action: "tick" }` advances all four (both books × live/paper) — the 투자 tab
 * sends it while open, `npm run trader` sends it with `source: "runner"` so the
 * dashboards can show the runner is alive.
 */
export async function POST(request: Request) {
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"요청 출처 거부"},{status:403});
  const body = await request.json().catch(() => ({})) as { action?: string; mode?: string; confirm?: string; source?: string; book?: string };
  if(body.source==="runner" && !["localhost","127.0.0.1","[::1]"].includes(new URL(request.url).hostname)){
    const secret=(env as unknown as Record<string,string|undefined>).STRATEGY_RUNNER_SECRET ?? process.env.STRATEGY_RUNNER_SECRET;
    if(!secret||request.headers.get("authorization")!==`Bearer ${secret}`)return Response.json({error:"러너 인증 필요"},{status:403});
  }
  const mode = body.mode === "live" || body.mode === "paper" ? body.mode : null;
  const book = bookOf(body.book);
  try {
    if (body.action === "tick") {
      waitUntil(refreshSurgeObservationsIfRunning().catch(error => console.error("surge observation", error)));
      const results = await tickDashboards(body.source === "runner" ? "runner" : "page");
      if (body.source === "runner") return Response.json({ ok: true, results });
    } else if (body.action === "start" && mode) {
      await startTrading(book, mode, body.confirm,Array.isArray((body as unknown as {strategyIds?:unknown}).strategyIds)?((body as unknown as {strategyIds:unknown[]}).strategyIds.map(id=>String(id))):undefined);
    } else if (body.action === "stop" && mode) {
      await stopTrading(book, mode);
    } else {
      return Response.json({ error: "action(start|stop|tick)과 mode(live|paper)를 확인하세요." }, { status: 400 });
    }
    return Response.json(await tradingDashboards(book), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
    if (!(error instanceof TradingUserError)) console.error("[trading]", book, body.action, mode, message);
    return Response.json({ error: message }, { status: error instanceof TradingUserError || /실행 중|정지 절차/.test(message) ? 409 : 503 });
  }
}
