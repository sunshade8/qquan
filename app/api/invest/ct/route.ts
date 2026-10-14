import { getCTTradeEvidence } from "@/lib/ct-trade-evidence";
import { env } from "cloudflare:workers";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { advanceGeneration, publicJob } from "@/lib/strategy-generation";
import {
  activeGeneration,
  attachLiveMeters,
  cancelActiveGeneration,
  cancelGenerationJob,
  getGenerationJob,
  pauseGenerationJob,
  resumeGenerationFailure,
} from "@/lib/strategy-generation-store";
import {
  createCTResearch,
  prepareCTContract,
  assertFinalWindowFree,
  ctPackages,
  ensureCTSchema,
  registerCT,
} from "@/lib/ct-research-store";
import { ctDb, loadCTData, ctDataPage, aggregateCT } from "@/lib/ct-data";
import { ctRunnerOnline } from "@/lib/ct-trading";
import { generationAvailability } from "@/lib/strategy-generation-llm";
import { ctCostPreview } from "@/lib/ct-costs";
import { ctPlaybookList } from "@/lib/ct-playbook";
export const dynamic = "force-dynamic";
const headers = (owner: string, request: Request) => ({
  "set-cookie": researchOwnerCookie(owner, request),
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
        ? Response.json(packet, { headers: headers(owner, request) })
        : Response.json(
            {
              error:
                "저장된 운용 차트 없음 · 해당 거래의 수집 상태를 확인하세요.",
            },
            { status: 404 },
          );
    }
    if (url.searchParams.has("playbook")) {
      // Read-only list of what earlier runs on this market tried; windows reaching today count as overlapping, so no run's numbers leak.
      return Response.json(await ctPlaybookList(owner, market), { headers: headers(owner, request) });
    }
    if (url.searchParams.has("chartImage")) {
      // A chart the designer was shown (stored PNG). Owner-only, like every other research artifact.
      const job = await getGenerationJob(url.searchParams.get("id") ?? "");
      const chartId = url.searchParams.get("chartImage") ?? "";
      if (!job?.ct || job.ownerId !== owner || !/^[a-f0-9]{16}$/.test(chartId))
        return Response.json({ error: "차트 없음" }, { status: 404 });
      const row = await ctDb().prepare("SELECT png FROM ct_chart_images WHERE run_id=? AND chart_id=?").bind(job.id, chartId).first<{ png: string }>();
      if (!row) return Response.json({ error: "차트 없음" }, { status: 404 });
      const bytes = Uint8Array.from(atob(row.png), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable" } });
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
        { headers: headers(owner, request) },
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
        { headers: headers(owner, request) },
      );
    }
    const rows = await ctDb()
      .prepare(
        "SELECT payload FROM strategy_generation_runs WHERE owner_id=? AND json_extract(payload,'$.ct.contract.market')=? ORDER BY created_at DESC LIMIT 30",
      )
      .bind(owner, market)
      .all<{ payload: string }>();
    // Running jobs carry the ~2s usage snapshot so the screen can show the model call in flight.
    const jobs = await attachLiveMeters(rows.results.map((r) => publicJob(JSON.parse(r.payload))));
    // The account runs one job at a time. If the one holding it is not in this
    // device's list, say so instead of leaving a disabled button unexplained.
    const active = await activeGeneration(owner);
    return Response.json(
      {
        jobs,
        blocking: active && !jobs.some((j) => j.id === active.id) ? active : null,
        registered: await ctPackages(market),
        availability: generationAvailability(),
        runnerOnline: await ctRunnerOnline(),
        costPreview: ctCostPreview(market),
      },
      { headers: headers(owner, request) },
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
    if (body.action === "preflight") {
      const { action, id, ...input } = body;
      void action;
      void id;
      const contract = await prepareCTContract(input);
      // Same refusal a real start gives, shown before anything is paid for.
      await assertFinalWindowFree(contract);
      const sample = await ctDataPage(contract, contract.symbols[0], contract.toMs);
      const aggregated = aggregateCT(sample, contract.minutes, contract.market, contract.toMs);
      return Response.json({contract, sampleBars: sample.length, aggregatedBars: aggregated.length}, {headers:headers(owner, request)});
    }
    if (body.action === "research") {
      // The client sends the run it is showing as `id`; a new research request has none.
      const { action, id, ...input } = body;
      void action;
      void id;
      const job = await createCTResearch(owner, input);
      return Response.json(
        { job: publicJob(job) },
        { status: 202, headers: headers(owner, request) },
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
    if (body.action === "cancel_blocking") {
      const cancelled =
        typeof body.id === "string" && (await cancelActiveGeneration(body.id));
      return Response.json({ ok: true, cancelled }, { headers: headers(owner, request) });
    }
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
        { headers: headers(owner, request) },
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
    return Response.json({ ok: true }, { headers: headers(owner, request) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "CT 실패" },
      { status: 409 },
    );
  }
}
