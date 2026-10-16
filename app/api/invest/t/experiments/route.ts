import { hostedDataRPC } from "@/lib/local-bridge-store";
import { env } from "cloudflare:workers";
import { researchOwnerFrom, researchOwnerCookie } from "@/lib/research-owner";
import { ctDb } from "@/lib/t-data";
import { CT_BASELINE_VERSIONS } from "@/lib/t-decision-playbooks";
import { ctStoredCapabilities } from "@/lib/t-capability-store";
import {
  createCTExperiment,
  listCTExperiments,
  getCTExperiment,
  ctExperimentDays,
  advanceCTExperiment,
  controlCTExperiment,
  ensureCTExperiments,
} from "@/lib/t-experiment-store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const owner = researchOwnerFrom(request),
    url = new URL(request.url),
    headers = {
      "set-cookie": researchOwnerCookie(owner, request),
      "cache-control": "no-store",
    };
  try {
    if(process.env.QQUAN_RUNTIME === "cloudflare")return Response.json(await hostedDataRPC({action:"t_control",owner,operation:url.searchParams.has("id")?"get":"list",body:Object.fromEntries(url.searchParams)}),{headers});
    const id = url.searchParams.get("id");
    if (id) {
      const experiment = await getCTExperiment(owner, id);
      if (!experiment)
        return Response.json({ error: "비교 없음" }, { status: 404, headers });
      return Response.json(
        { experiment, days: await ctExperimentDays(owner, id) },
        { headers },
      );
    }
    return Response.json(
      {
        experiments: await listCTExperiments(
          owner,
          url.searchParams.get("market") ?? "stock",
        ),
        versions: CT_BASELINE_VERSIONS,
        capabilities: await ctStoredCapabilities(),
      },
      { headers },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400, headers },
    );
  }
}
export async function POST(request: Request) {
  const owner = researchOwnerFrom(request),
    headers = {
      "set-cookie": researchOwnerCookie(owner, request),
      "cache-control": "no-store",
    };
  try {
    const b = (await request.json()) as Record<string, unknown>;
    if(process.env.QQUAN_RUNTIME === "cloudflare"){
      if(!["create","advance","pause","resume","cancel"].includes(String(b.action)))throw new Error("허용되지 않은 CT 제어 동작");
      const {action,...body}=b;return Response.json(await hostedDataRPC({action:"t_control",owner,operation:action,body}),{headers});
    }
    if (b.source === "runner") {
      const secret =
          (env as unknown as Record<string, string>).STRATEGY_RUNNER_SECRET ??
          process.env.STRATEGY_RUNNER_SECRET,
        local = ["localhost", "127.0.0.1", "[::1]"].includes(
          new URL(request.url).hostname,
        );
      if (
        b.action !== "advance" ||
        !secret ||
        request.headers.get("authorization") !== `Bearer ${secret}` ||
        !local
      )
        return Response.json({ error: "로컬 러너 인증 필요" }, { status: 403 });
      await ensureCTExperiments();
      const row = await ctDb()
        .prepare(
          "SELECT id,owner_id FROM t_experiments WHERE status='running' ORDER BY created_at LIMIT 1",
        )
        .first<{ id: string; owner_id: string }>();
      return Response.json({
        experiment: row
          ? await advanceCTExperiment(row.owner_id, row.id)
          : null,
      });
    }
    if (b.action === "create") {
      const { action, ...input } = b;
      void action;
      return Response.json(
        { experiment: await createCTExperiment(owner, input) },
        { status: 202, headers },
      );
    }
    if (typeof b.id !== "string") throw new Error("비교 id 필요");
    if (b.action === "advance")
      return Response.json(
        { experiment: await advanceCTExperiment(owner, b.id) },
        { headers },
      );
    if (b.action === "pause" || b.action === "resume" || b.action === "cancel")
      return Response.json(
        { experiment: await controlCTExperiment(owner, b.id, b.action) },
        { headers },
      );
    throw new Error("알 수 없는 비교 동작");
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400, headers },
    );
  }
}
