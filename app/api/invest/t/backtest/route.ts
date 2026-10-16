import { ctPackages } from "@/lib/t-research-store";
import { loadCTData } from "@/lib/t-data";
import { ctHash, executableCT } from "@/lib/t-spec";
import { replayCT } from "@/lib/t-engine";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const market =
      new URL(request.url).searchParams.get("market") === "crypto"
        ? "crypto"
        : "stock";
    const packet = (await ctPackages(market)).at(-1);
    if (!packet)
      return Response.json({ error: "등록된 CT 전략 없음" }, { status: 422 });
    const data = await loadCTData(packet.runId, packet.contract);
    if (
      (await ctHash(data)) !== packet.dataHash ||
      (await ctHash(executableCT(packet.spec))) !== packet.hash
    )
      throw new Error("데이터/규칙 해시 불일치");
    const result = replayCT(
      packet.spec,
      data,
      packet.contract,
      packet.contract.fromMs,
      packet.contract.toMs,
      packet.hash,
      { deadline: Date.now() + 120000 },
    );
    return Response.json(
      { package: packet, result },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "CT 백테스트 실패" },
      { status: 409 },
    );
  }
}
