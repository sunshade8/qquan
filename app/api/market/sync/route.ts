import { env } from "cloudflare:workers";

export async function POST(request: Request) {
  const runtimeEnv = env as unknown as Record<string, string | undefined>;
  const expectedSecret = runtimeEnv.SYNC_SECRET ?? process.env.SYNC_SECRET;
  const suppliedSecret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (expectedSecret && suppliedSecret !== expectedSecret) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const provider = runtimeEnv.MARKET_DATA_PROVIDER ?? process.env.MARKET_DATA_PROVIDER ?? "unconfigured";
  const apiKey = runtimeEnv.MARKET_DATA_API_KEY ?? process.env.MARKET_DATA_API_KEY;
  if (provider === "unconfigured" || !apiKey) {
    return Response.json({ status: "demo", message: "시세 공급자를 연결하면 이 엔드포인트를 24시간마다 호출해 증분 동기화합니다.", nextRun: new Date(Date.now() + 86_400_000).toISOString() });
  }
  return Response.json({ status: "adapter_required", provider, message: "Provider credentials are present. Implement the licensed provider adapter before enabling writes." }, { status: 501 });
}
