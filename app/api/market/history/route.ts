import { fetchTossHistory, fetchYahooHistory, MarketProviderError, PriceRow, providerSummary } from "../../../../lib/market-data";

function providerFailure(error: unknown) {
  if (error instanceof MarketProviderError) return { status: error.code === "not_configured" ? "not_configured" : "unavailable", reason: error.message };
  return { status: "unavailable", reason: "데이터 공급자 연결에 실패했습니다." };
}

function validate(tossRows: PriceRow[], yahooRows: PriceRow[]) {
  const yahooByDate = new Map(yahooRows.map((row) => [row.date, row]));
  const common = tossRows.filter((row) => yahooByDate.has(row.date));
  const latest = common.at(-1);
  const yahoo = latest ? yahooByDate.get(latest.date) : undefined;
  return {
    overlap: common.length,
    latestDate: latest?.date ?? null,
    latestCloseDeltaPct: latest && yahoo?.close ? Number((Math.abs(latest.close - yahoo.close) / yahoo.close * 100).toFixed(4)) : null,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "NVDA").trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,15}$/.test(symbol)) return Response.json({ error: "Invalid symbol" }, { status: 400 });

  const [tossResult, yahooResult] = await Promise.allSettled([fetchTossHistory(symbol), fetchYahooHistory(symbol)]);
  const tossRows = tossResult.status === "fulfilled" ? tossResult.value : [];
  const yahooRows = yahooResult.status === "fulfilled" ? yahooResult.value : [];
  const primary = tossRows.length >= 500 ? "toss" : "yahoo";
  const rows = primary === "toss" ? tossRows : yahooRows;

  if (!rows.length) {
    return Response.json({ error: "토스와 Yahoo에서 가격 데이터를 가져오지 못했습니다.", providers: { toss: tossResult.status === "rejected" ? providerFailure(tossResult.reason) : null, yahoo: yahooResult.status === "rejected" ? providerFailure(yahooResult.reason) : null } }, { status: 502 });
  }

  const providers = {
    primary,
    toss: tossResult.status === "fulfilled" ? { status: "connected", ...providerSummary(tossRows) } : providerFailure(tossResult.reason),
    yahoo: yahooResult.status === "fulfilled" ? { status: "connected", ...providerSummary(yahooRows) } : providerFailure(yahooResult.reason),
    validation: tossRows.length && yahooRows.length ? validate(tossRows, yahooRows) : null,
  };
  const source = primary === "toss" ? (yahooRows.length ? "Toss · Yahoo verified" : "Toss Securities") : (tossRows.length ? "Yahoo · Toss insufficient" : "Yahoo · Toss fallback");

  return Response.json(
    { symbol, source, adjusted: true, rows, providers },
    { headers: { "cache-control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400" } },
  );
}
