/** Workflow-only fixture. Real Parquet integration is tested by verify-local.mjs. */
export async function readSurgeBars(interval, symbols, dates) {
  const result = [];
  for (const symbol of symbols)
    for (const date of dates) {
      const row = await globalThis.__strategyTestEnv.DB.prepare(
        "SELECT payload FROM intraday_bar_days WHERE symbol=? AND trading_date=? AND interval=?",
      )
        .bind(symbol, date, `${interval}-raw`)
        .first();
      if (row)
        result.push({
          symbol,
          date,
          bars: JSON.parse(row.payload).map(
            ([time, open, high, low, close, volume]) => ({
              date,
              time,
              open,
              high,
              low,
              close,
              volume,
            }),
          ),
        });
    }
  return result;
}
export async function loadSurgeBars() {
  throw Error("No provider expected in workflow fixture");
}
