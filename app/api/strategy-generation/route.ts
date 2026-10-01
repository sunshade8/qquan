import { env } from "cloudflare:workers";
import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import {
  createGeneration,
  createStrategyResearch,
  advanceGeneration,
  publicJob,
} from "@/lib/strategy-generation";
import { generationAvailability } from "@/lib/strategy-generation-llm";
import {
  listGenerationJobs,
  getGenerationJob,
  cancelGenerationJob,
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
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const owner = researchOwnerFrom(request);
  try {
    return Response.json(
      {
        jobs: (await listGenerationJobs(owner)).map(publicJob),
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
          "set-cookie": researchOwnerCookie(owner),
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
    } | null;
  if (!body) return Response.json({ error: "JSON 요청 필요" }, { status: 400 });
  try {
    if (body.action === "research") {
      const job = await createStrategyResearch(owner, {
        goal: body.goal, brief: body.brief, universe: body.universe, slot: body.slot,
        budgetUsd: body.budgetUsd, requestId: body.requestId,
      });
      return Response.json({ job: publicJob(job) }, { headers: { "set-cookie": researchOwnerCookie(owner) }, status: 202 });
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
        { headers: { "set-cookie": researchOwnerCookie(owner) }, status: 202 },
      );
    }
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
