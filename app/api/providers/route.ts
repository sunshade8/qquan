import { fredConfigured } from "@/lib/fred";
import { probeMassive } from "@/lib/massive";

export const dynamic = "force-dynamic";

/**
 * Live connection status for every external data provider.
 *
 * Massive is probed with a real bar request rather than read from a config
 * flag, because "a key is set" and "the plan returns data" are different facts
 * and only the second one matters to a strategy that depends on it.
 */
export async function GET() {
  try {
    const massive = await probeMassive();
    return Response.json({
      massive,
      fred: { configured: fredConfigured() },
      checkedAt: new Date().toISOString(),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "연결 상태를 확인하지 못했습니다." }, { status: 502 });
  }
}
