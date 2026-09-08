import { researchOwnerCookie, researchOwnerFrom } from "@/lib/research-owner";
import { getReport, listReports } from "@/lib/trade-strategy-store";

export async function GET(request: Request) {
  const ownerId = researchOwnerFrom(request);
  const params = new URL(request.url).searchParams;
  const headers = { "set-cookie": researchOwnerCookie(ownerId) };
  const id = params.get("id");
  const instanceId = params.get("instanceId");
  try {
    if (id) {
      const report = await getReport(ownerId, id);
      if (!report) return Response.json({ error: "기록을 찾지 못했습니다." }, { status: 404, headers });
      // `?download=1` hands back the actual .md file rather than JSON.
      if (params.get("download")) {
        return new Response(report.markdown, {
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": `attachment; filename="${encodeURIComponent(report.filename)}"`,
          },
        });
      }
      return Response.json({ report }, { headers });
    }
    if (!instanceId) return Response.json({ error: "id 또는 instanceId가 필요합니다." }, { status: 400, headers });
    return Response.json({ reports: await listReports(ownerId, instanceId, 50) }, { headers });
  } catch (error) {
    console.error("[trade-strategies/reports] read failed", error instanceof Error ? error.message : error);
    return Response.json({ reports: [], persistence: "unavailable" }, { headers });
  }
}
