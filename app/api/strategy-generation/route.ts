import { env } from "cloudflare:workers";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import {
  createGeneration,
  advanceGeneration,
  publicJob,
} from "@/lib/strategy-generation";
import { createSlotResearch, getArtifact } from "@/lib/slot-research-store";
import { generationAvailability } from "@/lib/strategy-generation-llm";
import {
  activeGeneration,
  cancelActiveGeneration,
  listGenerationJobs,
  getGenerationJob,
  cancelGenerationJob,
  pauseGenerationJob,
  nextGenerationJob,
  generationInventory,
  resumeGenerationBudget,
  resumeGenerationFailure,
  registerResearchOption,
  registeredSpecs,
} from "@/lib/strategy-generation-store";
import {
  GENERATION_MODELS,
  MODEL_SOURCES,
} from "@/lib/strategy-generation-models";
import { GENERATION_STAGES } from "@/lib/strategy-generation-types";
import { VALIDATION_POLICY } from "@/lib/strategy-generation-validation";
import { journalPage } from "@/lib/research-memory-store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const owner = researchOwnerFrom(request);
  try {
    const url = new URL(request.url);
    if (url.searchParams.has("journal")) {
      // Cross-owner export is reserved for the explicitly authenticated runner.
      const runner = url.searchParams.get("source") === "runner";
      const secret = (env as unknown as Record<string, string | undefined>).STRATEGY_RUNNER_SECRET ?? process.env.STRATEGY_RUNNER_SECRET;
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (runner && !(secret && request.headers.get("authorization") === `Bearer ${secret}`) && !local)
        return Response.json({ error: "기록 내보내기 러너 인증 필요" }, { status: 403 });
      const after = url.searchParams.get("after") ?? "";
      if (after && !/^[a-f0-9-]{36}$/i.test(after))
        return Response.json({ error: "잘못된 기록 커서" }, { status: 400 });
      return Response.json(await journalPage(runner ? null : owner, after), { headers: { "cache-control": "no-store" } });
    }
    if (url.searchParams.has("artifact")) {
      const job = await getGenerationJob(url.searchParams.get("id") ?? "");
      const hash = url.searchParams.get("artifact")!;
      const allowed = job?.ownerId === owner && job.search && [
        ...job.search.trials.map(t => t.artifact), ...Object.values(job.search.final).map(f => f.artifact), job.search.combinedArtifact,
      ].includes(hash);
      if (!allowed) return Response.json({ error: "산출물을 찾지 못했습니다." }, { status: 404 });
      return Response.json(await getArtifact(hash), { headers: { "cache-control": "no-store" } });
    }
    const jobs = (await listGenerationJobs(owner)).filter(job=>!job.ct).map(publicJob);
    // One running job per account, from any screen or device: name the one
    // holding the slot when this device's list does not contain it.
    const active = await activeGeneration(owner);
    return Response.json(
      {
        jobs,
        blocking: active && !jobs.some(job => job.id === active.id) ? active : null,
        availability: generationAvailability(),
        // Expensive candle JSON aggregation is opt-in, never on every status poll.
        inventory: new URL(request.url).searchParams.get("inventory") === "1" ? await generationInventory() : [],
        registeredIds: (await registeredSpecs()).map(spec => spec.id),
        models: GENERATION_MODELS,
        stages: GENERATION_STAGES,
        policy: VALIDATION_POLICY,
        sources: MODEL_SOURCES,
      },
      {
        headers: {
          "set-cookie": researchOwnerCookie(owner, request),
          "cache-control": "no-store",
        },
      },
    );
  } catch {
    return Response.json(
      { error: "전략 생성 상태 저장소에 연결하지 못했습니다." },
      { status: 503 },
    );
  }
}
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return Response.json({ error: "허용되지 않은 요청 출처" }, { status: 403 });
  const owner = researchOwnerFrom(request),
    body = (await request.json().catch(() => null)) as {
      action?: string;
      id?: string;
      slot?: string;
      universe?: string[];
      brief?: string;
      requestId?: string;
      source?: string;
      goal?: string;
      budgetUsd?: number;
      optionId?: string;
      target?: unknown;
      slots?: string[];
      sourceMinutes?: number;
      config?: unknown;
      from?: string;
      to?: string;
      designMode?: string;
      maxDesignBatches?: number;
    } | null;
  if (!body) return Response.json({ error: "JSON 요청 필요" }, { status: 400 });
  try {
    if (body.action === "research") {
      const job = await createSlotResearch(owner, {
        goal: body.goal, brief: body.brief, universe: body.universe, slot: body.slot,
        budgetUsd: body.budgetUsd, requestId: body.requestId,
        target: body.target, slots: body.slots, sourceMinutes: body.sourceMinutes,
        config: body.config, from: body.from, to: body.to,
        designMode: body.designMode, maxDesignBatches: body.maxDesignBatches,
      });
      return Response.json({ job: publicJob(job) }, { headers: { "set-cookie": researchOwnerCookie(owner, request) }, status: 202 });
    }
    if (body.action === "create") {
      const job = await createGeneration(owner, {
        slot: body.slot,
        universe: body.universe,
        brief: body.brief ?? "",
        requestId: body.requestId,
      });
      return Response.json(
        { job: publicJob(job) },
        { headers: { "set-cookie": researchOwnerCookie(owner, request) }, status: 202 },
      );
    }
    if (body.action === "cancel_blocking")
      return Response.json({ ok: true, cancelled: typeof body.id === "string" && (await cancelActiveGeneration(body.id)) });
    const runner = body.source === "runner" && body.action === "advance";
    if (runner) {
      const hostname = new URL(request.url).hostname;
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
      const secret =
        (env as unknown as Record<string, string | undefined>)
          .STRATEGY_RUNNER_SECRET ?? process.env.STRATEGY_RUNNER_SECRET;
      if (
        !local &&
        (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
      )
        return Response.json({ error: "러너 인증 필요" }, { status: 403 });
    }
    // A runner only advances an already authorized run; it cannot create or cancel one.
    const id = runner ? await nextGenerationJob() : body.id;
    if (!id) return Response.json({ job: null });
    const job = await getGenerationJob(id);
    if (!job || (!runner && job.ownerId !== owner))
      return Response.json(
        { error: "작업을 찾지 못했습니다." },
        { status: 404 },
      );
    if (body.action === "resume_budget") {
      await resumeGenerationBudget(job);
      return Response.json({ ok: true });
    }
    if (body.action === "resume") {
      await resumeGenerationFailure(job);
      return Response.json({ ok: true });
    }
    if (body.action === "register") {
      if (!body.optionId) throw new Error("배정할 후보를 선택해 주세요.");
      const strategyId = await registerResearchOption(job, body.optionId);
      return Response.json({ ok: true, strategyId });
    }
    if (body.action === "cancel") {
      await cancelGenerationJob(job);
      return Response.json({ ok: true });
    }
    if (body.action === "pause") {
      await pauseGenerationJob(job);
      return Response.json({ ok: true });
    }
    if (body.action !== "advance")
      return Response.json({ error: "잘못된 작업" }, { status: 400 });
    const encoder = new TextEncoder();
    let connected = true;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (data: unknown) => {
          if (connected)
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
            } catch {
              connected = false;
            }
        };
        const heartbeat = setInterval(() => send({ type: "heartbeat" }), 15000);
        try {
          send({ type: "progress", message: "단계 실행" });
          const result = await advanceGeneration(id, (message) =>
            send({ type: "progress", message }),
            (meter) => send({ type: "usage", meter }),
          );
          send({ type: "result", job: result ? publicJob(result) : null });
        } catch (error) {
          send({
            type: "error",
            message: error instanceof Error ? error.message : "실행 실패",
          });
        } finally {
          clearInterval(heartbeat);
          if (connected) controller.close();
        }
      },
      cancel() {
        connected = false;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "전략 생성 실패" },
      { status: 409 },
    );
  }
}
