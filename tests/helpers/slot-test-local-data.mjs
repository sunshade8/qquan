// State-machine fixture only; real common-query IO is tested in ct-research-data/local-data.
export async function localStockPoints(symbol, from, to, interval) {
  if (symbol !== "NVDA")
    throw Error("Unsupported dataset identity: instrument");
  const result = await globalThis.__strategyTestEnv.DB.prepare(
    "SELECT trading_date,payload,provider FROM intraday_bar_days WHERE symbol=? AND interval=? AND trading_date>=? AND trading_date<=? ORDER BY trading_date",
  )
    .bind(symbol, interval, from, to)
    .all();
  if (result.results.some((r) => r.provider !== "Massive"))
    throw Error("출처 불일치");
  return result.results.flatMap((r) =>
    JSON.parse(r.payload).map(([time, open, high, low, close, volume]) => ({
      date: r.trading_date,
      time,
      open,
      high,
      low,
      close,
      volume,
    })),
  );
}

export async function dataRPC() {
  const rows = await globalThis.__strategyTestEnv.DB.prepare(
    "SELECT symbol instrument,provider,COUNT(*) sessions,SUM(json_array_length(payload)) rows,MIN(trading_date) firstDate,MAX(trading_date) lastDate FROM intraday_bar_days WHERE symbol='NVDA' AND interval='5m' GROUP BY symbol,provider",
  ).all();
  return rows.results.map((r) => ({
    ...r,
    dataset: "stock",
    coverage: [[Date.parse(r.firstDate), Date.parse(r.lastDate) + 86400000]],
  }));
}
