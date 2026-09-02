import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { normalizeSpec } from "@/lib/strategy";
import { backtestSpec, getStrategy, runAndRecord } from "@/lib/strategy-store";

/**
 * POST { id } runs and records the saved strategy; POST { spec } runs an
 * ad-hoc spec without saving; { id, spec } records a run with an edited spec.
 */
export async function POST(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const payload = await request.json().catch(() => ({})) as { id?: string; spec?: unknown };
  const today = new Date().toISOString().slice(0, 10);
  const headers = { "set-cookie": researchOwnerCookie(ownerId) };
  try {
    if (typeof payload.id === "string") {
      const strategy = await getStrategy(ownerId, payload.id);
      if (!strategy) return Response.json({ error: "전략을 찾지 못했습니다." }, { status: 404, headers });
      let override;
      if (payload.spec !== undefined) {
        const normalized = normalizeSpec(payload.spec, today);
        if (!normalized.spec) return Response.json({ error: `전략 사양이 올바르지 않습니다: ${normalized.errors.join(" ")}` }, { status: 400, headers });
        override = normalized.spec;
      }
      const outcome = await runAndRecord(ownerId, strategy, override);
      if (!outcome.result) return Response.json({ error: `백테스트할 데이터가 부족합니다. ${outcome.missing.map((item) => `${item.symbol}: ${item.reason}`).join(" / ")}`, missing: outcome.missing }, { status: 422, headers });
      return Response.json({ result: outcome.result, strategy: outcome.strategy, missing: outcome.missing }, { headers });
    }
    const { spec, errors } = normalizeSpec(payload.spec, today);
    if (!spec) return Response.json({ error: `전략 사양이 올바르지 않습니다: ${errors.join(" ")}`, errors }, { status: 400, headers });
    const outcome = await backtestSpec(spec);
    if (!outcome.result) return Response.json({ error: `백테스트할 데이터가 부족합니다. ${outcome.missing.map((item) => `${item.symbol}: ${item.reason}`).join(" / ")}`, missing: outcome.missing }, { status: 422, headers });
    return Response.json({ result: outcome.result, missing: outcome.missing }, { headers });
  } catch (error) {
    console.error("[strategies/backtest] failed", error instanceof Error ? error.message : error);
    return Response.json({ error: error instanceof Error ? error.message : "백테스트 실행에 실패했습니다." }, { status: 500, headers });
  }
}
