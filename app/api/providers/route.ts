import { probeFinnhub } from "@/lib/finnhub";
import { fredConfigured } from "@/lib/fred";
import { probeAlpaca } from "@/lib/alpaca";

export const dynamic = "force-dynamic";

/**
 * Live connection status for every external data provider.
 *
 * The Finnhub section is probed with real calls rather than read from a config
 * flag, because "a key is set" and "the plan returns data" are different facts
 * and only the second one matters to a strategy that depends on it.
 */
export async function GET() {
  try {
    const [alpaca, finnhub] = await Promise.all([probeAlpaca(), probeFinnhub()]);
    return Response.json({
      alpaca,
      finnhub,
      fred: { configured: fredConfigured() },
      checkedAt: new Date().toISOString(),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "연결 상태를 확인하지 못했습니다." }, { status: 502 });
  }
}
