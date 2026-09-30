import { env } from "cloudflare:workers";
import { collectSurgeCases, listSurgeCases, recordSurgeCases } from "@/lib/surge-cases-store";

export const dynamic = "force-dynamic";

/** The owner's recorded cases and the agent's stage readiness. */
export async function GET() {
  try {
    return Response.json(await listSurgeCases(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "급등락 사례 저장소에 연결하지 못했습니다." }, { status: 503 });
  }
}

/**
 * `record` — store a 날짜/종목/등락폭 list, then collect whatever is already collectable.
 * `collect` — fetch minutes for pending cases whose session is over (the runner calls this).
 */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "허용되지 않은 요청 출처" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { action?: string; text?: string; source?: string } | null;
  if (!body) return Response.json({ error: "JSON 요청 필요" }, { status: 400 });
  if (body.source === "runner") {
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname);
    const secret = (env as unknown as Record<string, string | undefined>).STRATEGY_RUNNER_SECRET ?? process.env.STRATEGY_RUNNER_SECRET;
    if (!local && (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)) return Response.json({ error: "러너 인증 필요" }, { status: 403 });
  }
  try {
    if (body.action === "record") {
      if (!body.text?.trim()) return Response.json({ error: "목록이 비어 있습니다" }, { status: 400 });
      const recorded = await recordSurgeCases(body.text.slice(0, 20_000));
      const collected = await collectSurgeCases();
      return Response.json({ recorded, collected });
    }
    if (body.action === "collect") return Response.json(await collectSurgeCases());
    return Response.json({ error: "잘못된 작업" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
