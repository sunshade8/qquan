import { env, waitUntil } from "cloudflare:workers";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import {
  advanceSurgeGeneration,
  createSurgeGeneration,
  publicSurgeJob,
  surgeStrategySummary,
} from "@/lib/surge-generation";
import { generationAvailability } from "@/lib/strategy-generation-llm";
import {
  cancelSurgeJob,
  getSurgeJob,
  listSurgeJobs,
  nextSurgeJob,
  registeredSurgeSpecs,
  resumeSurgeGeneration,
  surgeMarketInventory,
  surgeSplitInventory,
} from "@/lib/surge-store";
import { surgeBarInventory } from "@/lib/surge-bars";
import { GENERATION_MODELS, MODEL_SOURCES } from "@/lib/strategy-generation-models";
import { SURGE_STAGES, SURGE_WINDOW } from "@/lib/surge-types";
import { SURGE_POLICY } from "@/lib/surge-validation";
import { surgeHistoryFloor } from "@/lib/surge-universe";
import { SURGE_DAY_FROM, SURGE_EXIT_BY, SURGE_INTERVALS } from "@/lib/surge-spec";
import { SURGE_OBSERVATION } from "@/lib/surge-observation";
import { RANKING_LIMITS } from "@/lib/surge-live";
import { massiveRateLimitPerMinute } from "@/lib/massive";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = researchOwnerFrom(request);
  try {
    const registered = await registeredSurgeSpecs();
    return Response.json({
      jobs: (await listSurgeJobs(owner)).map(publicSurgeJob),
      availability: generationAvailability(),
      strategies: registered.map((row) => ({ runId: row.runId, ...surgeStrategySummary(row.spec) })),
      market: await surgeMarketInventory(),
      splits: await surgeSplitInventory(),
      bars: await surgeBarInventory(),
      stages: SURGE_STAGES,
      models: GENERATION_MODELS,
      policy: SURGE_POLICY,
      window: SURGE_WINDOW,
      filters: {
        eventChangePct: SURGE_OBSERVATION.changePct,
        minPriceUsd: SURGE_OBSERVATION.minPrice,
        maxPriceUsd: SURGE_OBSERVATION.maxPrice,
        minSessionDollarVolumeUsd: SURGE_OBSERVATION.minSessionDollarVolume,
        historyFloor: surgeHistoryFloor(),
        tradableWindow: { from: SURGE_DAY_FROM, to: SURGE_EXIT_BY },
        intervals: SURGE_INTERVALS,
        massiveCallsPerMinute: massiveRateLimitPerMinute(),
      },
      rankingLimits: RANKING_LIMITS,
      sources: MODEL_SOURCES,
    }, {
      headers: { "set-cookie": researchOwnerCookie(owner), "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "급등주 상태 저장소에 연결하지 못했습니다." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "허용되지 않은 요청 출처" }, { status: 403 });
  }
  const owner = researchOwnerFrom(request);
  const body = (await request.json().catch(() => null)) as {
    action?: string; id?: string; pool?: string; brief?: string; requestId?: string; source?: string;
  } | null;
  if (!body) return Response.json({ error: "JSON 요청 필요" }, { status: 400 });

  try {
    if (body.action === "create") {
      const job = await createSurgeGeneration(owner, {
        pool: body.pool,
        brief: body.brief ?? "",
        requestId: body.requestId,
      });
      return Response.json({ job: publicSurgeJob(job) }, {
        headers: { "set-cookie": researchOwnerCookie(owner) },
        status: 202,
      });
    }

    const runner = body.source === "runner" && body.action === "advance";
    if (runner) {
      const hostname = new URL(request.url).hostname;
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
      const secret = (env as unknown as Record<string, string | undefined>).STRATEGY_RUNNER_SECRET
        ?? process.env.STRATEGY_RUNNER_SECRET;
      if (!local && (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)) {
        return Response.json({ error: "러너 인증 필요" }, { status: 403 });
      }
    }
    // A runner only advances an already authorized run; it cannot create or cancel one.
    const id = runner ? await nextSurgeJob() : body.id;
    if (!id) return Response.json({ job: null });
    const job = await getSurgeJob(id);
    if (!job || (!runner && job.ownerId !== owner)) {
      return Response.json({ error: "작업을 찾지 못했습니다." }, { status: 404 });
    }
    if (body.action === "resume" || body.action === "resume_budget") {
      await resumeSurgeGeneration(job);
      return Response.json({ ok: true });
    }
    if (body.action === "cancel") {
      await cancelSurgeJob(job);
      return Response.json({ ok: true });
    }
    if (body.action !== "advance") return Response.json({ error: "잘못된 작업" }, { status: 400 });

    const encoder = new TextEncoder();
    let connected = true;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      // Runs synchronously inside the constructor, so `controller` is set before any send.
      start(streamController) { controller = streamController; },
      cancel() { connected = false; },
    });
    const send = (data: unknown) => {
      if (!connected || !controller) return;
      try {
        controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
      } catch {
        connected = false;
      }
    };
    /**
     * The stage runs independently of this response. A Worker cancels a
     * request's pending work when its client goes away — a reload, a closed tab,
     * Vite reconnecting after a dev-server restart — and a stage killed that way
     * keeps its lease for minutes and leaves a dangling `started` event.
     * `waitUntil` lets the stage finish and save; the stream only reports on it.
     */
    const work = (async () => {
      const heartbeat = setInterval(() => send({ type: "heartbeat" }), 15000);
      try {
        const result = await advanceSurgeGeneration(id, (message, activity) => send({ type: "progress", message, activity }));
        send({ type: "result", job: result ? publicSurgeJob(result) : null });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : "실행 실패" });
      } finally {
        clearInterval(heartbeat);
        if (connected) {
          connected = false;
          try { (controller as ReadableStreamDefaultController<Uint8Array> | undefined)?.close(); } catch { /* the client already went away */ }
        }
      }
    })();
    waitUntil(work);
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "급등주 전략 생성 실패" },
      { status: 409 },
    );
  }
}
