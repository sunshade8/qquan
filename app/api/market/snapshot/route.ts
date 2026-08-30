import { fetchTossSnapshot } from "../../../../lib/market-data";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "NVDA").trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,15}$/.test(symbol)) return Response.json({ error: "Invalid symbol" }, { status: 400 });
  const snapshot = await fetchTossSnapshot(symbol);
  return Response.json(snapshot, { headers: { "cache-control": "private, max-age=5" } });
}
