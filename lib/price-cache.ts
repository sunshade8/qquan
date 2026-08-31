import { env } from "cloudflare:workers";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { dailyPrices } from "@/db/schema";
import { fetchYahooWindow, MarketProviderError, type PriceRow } from "./market-data";

export type PriceLoad = {
  rows: PriceRow[];
  origin: "upstream" | "cache" | "cache-stale";
  reason: string | null;
};

let schemaReady: Promise<void> | undefined;

// The Sites control plane does not reliably apply drizzle migrations, so the
// cache table is created defensively the same way the news tables are.
function ensurePriceSchema() {
  if (schemaReady) return schemaReady;
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) return Promise.reject(new Error("D1 unavailable"));
  schemaReady = binding.batch([
    binding.prepare("CREATE TABLE IF NOT EXISTS daily_prices (id integer PRIMARY KEY AUTOINCREMENT NOT NULL, symbol text NOT NULL, trading_date text NOT NULL, open real NOT NULL, high real NOT NULL, low real NOT NULL, close real NOT NULL, adjusted_close real NOT NULL, volume integer NOT NULL)"),
    binding.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_prices_symbol_date ON daily_prices (symbol, trading_date)"),
    binding.prepare("CREATE INDEX IF NOT EXISTS idx_daily_prices_date ON daily_prices (trading_date)"),
  ]).then(() => undefined).catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  return schemaReady;
}

async function readCache(symbol: string, from: string, to: string) {
  await ensurePriceSchema();
  const rows = await getDb().select().from(dailyPrices)
    .where(and(eq(dailyPrices.symbol, symbol), gte(dailyPrices.tradingDate, from), lte(dailyPrices.tradingDate, to)))
    .orderBy(asc(dailyPrices.tradingDate));
  return rows.map((row): PriceRow => ({
    date: row.tradingDate,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));
}

async function writeCache(symbol: string, rows: PriceRow[]) {
  if (!rows.length) return;
  await ensurePriceSchema();
  const db = getDb();
  // D1 allows at most 100 bound parameters per statement and each row binds
  // eight, so ten rows per insert stays comfortably under the cap.
  for (let index = 0; index < rows.length; index += 10) {
    const chunk = rows.slice(index, index + 10).map((row) => ({
      symbol,
      tradingDate: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      adjustedClose: row.close,
      volume: row.volume,
    }));
    await db.insert(dailyPrices).values(chunk).onConflictDoNothing();
  }
}

// Drizzle embeds the full statement and every bound value in its message;
// keep the log line readable.
function describeError(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

function describe(error: unknown) {
  if (error instanceof MarketProviderError) return error.message;
  return "가격 공급자 연결에 실패했습니다.";
}

/**
 * Daily bars for a window, upstream-first with a durable D1 fallback. Yahoo
 * rate-limits the deployed Worker's shared egress IP, so a throttled call must
 * degrade to previously cached bars instead of erasing the comparison.
 */
export async function loadDailyRows(symbol: string, from: string, to: string): Promise<PriceLoad> {
  let cached: PriceRow[] = [];
  try {
    cached = await readCache(symbol, from, to);
  } catch (error) {
    console.error("[price-cache] read failed", { symbol, error: describeError(error) });
    cached = [];
  }

  // A window this size is fully covered once we hold roughly a bar per weekday.
  const expectedBars = Math.floor(((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 + 1) * 0.6);
  if (cached.length && cached.length >= expectedBars) return { rows: cached, origin: "cache", reason: null };

  try {
    const fresh = await fetchYahooWindow(symbol, from, to);
    try {
      await writeCache(symbol, fresh);
    } catch (error) {
      // A cache write failure must not fail the request that already has data.
      console.error("[price-cache] write failed", { symbol, rows: fresh.length, error: describeError(error) });
    }
    return { rows: fresh, origin: "upstream", reason: null };
  } catch (error) {
    if (cached.length) return { rows: cached, origin: "cache-stale", reason: describe(error) };
    return { rows: [], origin: "upstream", reason: describe(error) };
  }
}
