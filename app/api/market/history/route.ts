type YahooChart = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    }>;
    error?: { description?: string } | null;
  };
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "NVDA").trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,15}$/.test(symbol)) {
    return Response.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const sourceUrl = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  sourceUrl.searchParams.set("range", "10y");
  sourceUrl.searchParams.set("interval", "1d");
  sourceUrl.searchParams.set("events", "div,splits");
  sourceUrl.searchParams.set("includeAdjustedClose", "true");

  const response = await fetch(sourceUrl, {
    headers: { "user-agent": "Mozilla/5.0 QQuant personal research" },
  });
  if (!response.ok) {
    return Response.json({ error: "Historical data source is temporarily unavailable." }, { status: 502 });
  }

  const payload = await response.json() as YahooChart;
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
  if (!quote || !timestamps.length) {
    return Response.json({ error: payload.chart?.error?.description ?? "No historical data found." }, { status: 404 });
  }

  const rows = timestamps.flatMap((timestamp, index) => {
    const rawOpen = quote.open?.[index];
    const rawHigh = quote.high?.[index];
    const rawLow = quote.low?.[index];
    const rawClose = quote.close?.[index];
    const volume = quote.volume?.[index];
    if ([rawOpen, rawHigh, rawLow, rawClose, volume].some((value) => value === null || value === undefined)) return [];
    const adjustment = adjusted[index] && rawClose ? adjusted[index]! / rawClose : 1;
    return [{
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      open: Number((rawOpen! * adjustment).toFixed(6)),
      high: Number((rawHigh! * adjustment).toFixed(6)),
      low: Number((rawLow! * adjustment).toFixed(6)),
      close: Number((rawClose! * adjustment).toFixed(6)),
      volume: volume!,
    }];
  });

  return Response.json(
    { symbol, source: "Yahoo Finance (prototype)", adjusted: true, rows },
    { headers: { "cache-control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400" } },
  );
}
