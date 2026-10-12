import { localDailyRows } from "@/lib/local-market-data";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "NVDA")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9.^-]{1,15}$/.test(symbol))
    return Response.json({ error: "Invalid symbol" }, { status: 400 });
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 180);
  try {
    const rows = await localDailyRows(
      symbol,
      url.searchParams.get("from") ?? start.toISOString().slice(0, 10),
      url.searchParams.get("to") ?? end.toISOString().slice(0, 10),
    );
    return Response.json(
      {
        symbol,
        source: "Local Parquet · Massive NVDA unadjusted",
        adjusted: false,
        rows,
        providers: {
          primary: "local",
          toss: { status: "not_requested", reason: "로컬 과거 조회" },
          yahoo: { status: "not_requested", reason: "로컬 과거 조회" },
          validation: null,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return Response.json(
      {
        error: e instanceof Error ? e.message : "데이터 준비 필요",
        settings: "#local-market-data",
      },
      { status: 409 },
    );
  }
}
