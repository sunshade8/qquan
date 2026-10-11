import { getCTTradeEvidence } from "@/lib/ct-trade-evidence";
import { env } from "cloudflare:workers";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { advanceGeneration, publicJob } from "@/lib/strategy-generation";
import {
  cancelGenerationJob,
  getGenerationJob,
  pauseGenerationJob,
  resumeGenerationFailure,
} from "@/lib/strategy-generation-store";
import {
  createCTResearch,
  ctPackages,
  ensureCTSchema,
  registerCT,
} from "@/lib/ct-research-store";
import { ctDb, loadCTData } from "@/lib/ct-data";
import { ctRunnerOnline } from "@/lib/ct-trading";
import { generationAvailability } from "@/lib/strategy-generation-llm";
export const dynamic = "force-dynamic";
const headers = (owner: string) => ({
  "set-cookie": researchOwnerCookie(owner),
  "cache-control": "no-store",
});
function runnerAuthorized(request: Request) {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(request.url).hostname,
  );
  const secret =
    (env as unknown as Record<string, string | undefined>)
      .STRATEGY_RUNNER_SECRET ?? process.env.STRATEGY_RUNNER_SECRET;
  return (
    local ||
    Boolean(
      secret && request.headers.get("authorization") === `Bearer ${secret}`,
    )
  );
}
export async function GET(request: Request) {
  const owner = researchOwnerFrom(request),
    url = new URL(request.url),
    market = url.searchParams.get("market") === "crypto" ? "crypto" : "stock";
  try {
    await ensureCTSchema();
    if (url.searchParams.has("tradeChart")) {
      const id = url.searchParams.get("tradeChart") ?? "",
        mode = url.searchParams.get("mode");
      if (
        !/^[a-zA-Z0-9-]{1,100}$/.test(id) ||
        (mode !== "live" && mode !== "paper")
      )
        return Response.json({ error: "거래 차트 입력 오류" }, { status: 400 });
      const packet = await getCTTradeEvidence(
        market === "crypto" ? "ct-crypto" : "ct-stock",
        mode,
        id,
      );
      return packet
        ? Response.json(packet, { headers: headers(owner) })
        : Response.json(
            {
              error:
                "저장된 운용 차트 없음 · 해당 거래의 수집 상태를 확인하세요.",
            },
            { status: 404 },
          );
    }
    if (url.searchParams.has("artifact")) {
      const job = await getGenerationJob(url.searchParams.get("id") ?? "");
      if (!job?.ct || job.ownerId !== owner)
        return Response.json({ error: "연구 없음" }, { status: 404 });
      const id = url.searchParams.get("artifact");
      const row = await ctDb()
        .prepare(
          "SELECT name,input_payload,output_payload FROM ct_tools WHERE id=? AND run_id=?",
        )
        .bind(id, job.id)
        .first<{
          name: string;
          input_payload: string;
          output_payload: string;
        }>();
      if (!row)
        return Response.json(
          { error: "완료된 도구 결과 없음" },
          { status: 404 },
        );
      const pages = await ctDb()
        .prepare(
          "SELECT payload FROM ct_replay_pages WHERE artifact_id=? ORDER BY page",
        )
        .bind(id)
        .all<{ payload: string }>();
      return Response.json(
        {
          name: row.name,
          input: JSON.parse(row.input_payload),
          output: JSON.parse(row.output_payload),
          executions: pages.results.flatMap((p) => JSON.parse(p.payload)),
        },
        { headers: headers(owner) },
      );
    }
    if (url.searchParams.has("chart")) {
      const job = await getGenerationJob(url.searchParams.get("id") ?? "");
      if (!job?.ct || job.ownerId !== owner)
        return Response.json({ error: "연구 없음" }, { status: 404 });
      const data = await loadCTData(job.id, job.ct.contract);
      const symbol =
        url.searchParams.get("symbol") ?? job.ct.contract.symbols[0];
      const at = Number(url.searchParams.get("at"));
      if (
        !job.ct.contract.symbols.includes(symbol) ||
        !Number.isFinite(at) ||
        at > job.ct.contract.toMs
      )
        return Response.json({ error: "잘못된 차트 범위" }, { status: 400 });
      return Response.json(
        { bars: data[symbol].filter((b) => b.endMs <= at).slice(-160) },
        { headers: headers(owner) },
      );
    }
    const rows = await ctDb()
      .prepare(
        "SELECT payload FROM strategy_generation_runs WHERE owner_id=? AND json_extract(payload,'$.ct.contract.market')=? ORDER BY created_at DESC LIMIT 30",
      )
      .bind(owner, market)
      .all<{ payload: string }>();
    return Response.json(
      {
        jobs: rows.results.map((r) => publicJob(JSON.parse(r.payload))),
        registered: await ctPackages(market),
        availability: generationAvailability(),
        runnerOnline: await ctRunnerOnline(),
      },
      { headers: headers(owner) },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "CT 저장소 연결 실패" },
      { status: 503 },
    );
  }
}
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return Response.json({ error: "요청 출처 거부" }, { status: 403 });
  const owner = researchOwnerFrom(request),
    body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
  if (!body) return Response.json({ error: "JSON 필요" }, { status: 400 });
  try {
    if (body.action === "research") {
      const { action, ...input } = body;
      void action;
      const job = await createCTResearch(owner, input);
      return Response.json(
        { job: publicJob(job) },
        { status: 202, headers: headers(owner) },
      );
    }
    await ensureCTSchema();
    const runner = body.source === "runner" && body.action === "advance";
    if (runner && !runnerAuthorized(request))
      return Response.json({ error: "러너 인증 필요" }, { status: 403 });
    if (runner)
      await ctDb()
        .prepare(
          "INSERT INTO ct_runtime VALUES ('research-runner',?) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at",
        )
        .bind(Date.now())
        .run();
    let id = typeof body.id === "string" ? body.id : null;
    if (runner) {
      const row = await ctDb()
        .prepare(
          "SELECT id FROM strategy_generation_runs WHERE status='running' AND json_extract(payload,'$.ct.version')=1 ORDER BY created_at LIMIT 1",
        )
        .first<{ id: string }>();
      id = row?.id ?? null;
    }
    if (!id) return Response.json({ job: null });
    const job = await getGenerationJob(id);
    if (!job?.ct || (!runner && job.ownerId !== owner))
      return Response.json({ error: "연구 없음" }, { status: 404 });
    if (body.action === "register")
      return Response.json(
        { strategyId: await registerCT(job) },
        { headers: headers(owner) },
      );
    if (body.action === "cancel") await cancelGenerationJob(job);
    else if (body.action === "pause") await pauseGenerationJob(job);
    else if (body.action === "resume") await resumeGenerationFailure(job);
    else if (body.action === "advance") {
      const encoder = new TextEncoder();
      let connected = true;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (x: unknown) => {
              if (connected)
                try {
                  controller.enqueue(encoder.encode(`${JSON.stringify(x)}\n`));
                } catch {
                  connected = false;
                }
            };
            const timer = setInterval(() => send({ type: "heartbeat" }), 15000);
            try {
              const result = await advanceGeneration(
                id!,
                (message) => send({ type: "progress", message }),
                (meter) => send({ type: "usage", meter }),
              );
              send({ type: "result", job: result ? publicJob(result) : null });
            } catch (error) {
              send({
                type: "error",
                message:
                  error instanceof Error ? error.message : "CT 도구 실행 실패",
              });
            } finally {
              clearInterval(timer);
              if (connected) controller.close();
            }
          },
          cancel() {
            connected = false;
          },
        }),
        {
          headers: {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store, no-transform",
          },
        },
      );
    } else return Response.json({ error: "잘못된 CT 동작" }, { status: 400 });
    return Response.json({ ok: true }, { headers: headers(owner) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "CT 실패" },
      { status: 409 },
    );
  }
}
