import { dataRPC } from "@/lib/local-market-data";
import { startDataWorker } from "../../../lib/local-data-worker.ts";
export const dynamic = "force-dynamic";
function guard(request: Request, write = false) {
  const url = new URL(request.url);
  const hosted = process.env.QQUAN_RUNTIME === "cloudflare";
  if (hosted && !request.headers.get("oai-authenticated-user-id"))
    throw new Error("로그인 후 로컬 저장소를 확인하세요.");
  if (!hosted && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Loopback 전용 API");
  if (write && request.headers.get("origin") !== url.origin)
    throw new Error("동일 origin 브라우저 요청 필요");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new Error("Cross-site 요청 거부");
}
export async function GET(request: Request) {
  try {
    guard(request);
    return Response.json(await dataRPC({ action: "status" }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
export async function POST(request: Request) {
  try {
    guard(request, true);
    const input = (await request.json()) as Record<string, unknown>;
    if (!input || typeof input !== "object") throw Error("Invalid input");
    let body: object;
    if (
      input.action === "enqueue" &&
      (input.dataset === "stock" || input.dataset === "btc") &&
      Object.keys(input).every((k) => ["action", "dataset"].includes(k))
    )
      body = { action: "enqueue", dataset: input.dataset };
    else if (
      (input.action === "cancel" || input.action === "resume") &&
      typeof input.id === "string" &&
      /^[a-f0-9-]{36}$/.test(input.id) &&
      Object.keys(input).every((k) => ["action", "id"].includes(k))
    )
      body = { action: input.action, id: input.id };
    else throw Error("허용되지 않은 작업 입력");
    const result = await dataRPC(body);
    startDataWorker();
    return Response.json(result, { status: 202 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
