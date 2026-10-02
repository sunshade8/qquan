/** Read-only inventory. Does not download data, issue tokens or inspect credentials. */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { coverageFor } from "../../lib/slot-research.ts";
import { SLOTS } from "../../lib/trade-slots.ts";
const dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const paths = readdirSync(dir).filter(
  (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite",
);
if (paths.length !== 1 && !process.env.MARKET_DATA_DB)
  throw new Error("Set MARKET_DATA_DB for ambiguous SQLite path");
const db = new DatabaseSync(
  process.env.MARKET_DATA_DB ?? `${dir}/${paths[0]}`,
  { readOnly: true },
);
const out = process.argv[2] ?? "outputs/slot-research";
mkdirSync(out, { recursive: true });
const inventory = db
  .prepare(
    "SELECT symbol,interval,provider,COUNT(*) sessions,MIN(trading_date) firstDate,MAX(trading_date) lastDate,SUM(json_array_length(payload)) bars FROM intraday_bar_days GROUP BY 1,2,3",
  )
  .all();
const assets = readdirSync("assets/market-data")
  .filter((f) => f.endsWith(".json.gz"))
  .map((f) => {
    const bytes = readFileSync(`assets/market-data/${f}`),
      a = JSON.parse(gunzipSync(bytes));
    return {
      file: f,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      coverage: a.coverage,
      sessions: a.days.length,
      bars: a.days.reduce((n, d) => n + JSON.parse(d.payload).length, 0),
      dbExact: a.days.every(
        (d) =>
          db
            .prepare(
              "SELECT payload,provider FROM intraday_bar_days WHERE id=?",
            )
            .get(d.id)?.payload === d.payload,
      ),
    };
  });
const files = readdirSync("scripts/research/cache")
  .filter((f) => f.startsWith("intraday-"))
  .map((f) => {
    const bytes = readFileSync(`scripts/research/cache/${f}`),
      bars = JSON.parse(bytes),
      symbol = f.split("-")[1];
    const byDate = new Map();
    for (const b of bars) {
      const day = byDate.get(b.date) ?? {
        date: b.date,
        bars: { [symbol]: [] },
      };
      day.bars[symbol].push(b);
      byDate.set(b.date, day);
    }
    const days = [...byDate.values()],
      dates = days.map((d) => d.date).sort();
    return {
      file: f,
      symbol,
      source:
        "Massive adjusted=true, producer scripts/research/_load.ts (no embedded provider attestation)",
      minutes: 5,
      excludedLeveraged: symbol === "TQQQ",
      firstDate: dates[0],
      lastDate: dates.at(-1),
      sessions: dates.length,
      bars: bars.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      coverage: SLOTS.map((s) => {
        const c = coverageFor(days, [symbol], s.id, 5, dates);
        return {
          slot: s.id,
          valid: c.validDates.length,
          excluded: c.excluded.length,
        };
      }),
    };
  });
const research = db
  .prepare(
    "SELECT run_id,COUNT(*) parts,SUM(LENGTH(payload)) bytes FROM strategy_generation_data GROUP BY run_id",
  )
  .all();
const report = {
  database: process.env.MARKET_DATA_DB ?? `${dir}/${paths[0]}`,
  inventory,
  assets,
  files,
  research,
  notes: [
    "Event-selected 1m-raw is not an unconditional session denominator.",
    "Assets and old caches are not relabeled minute bars.",
    "Legacy file studies imply unknown historical exposure, not unused data.",
  ],
};
writeFileSync(`${out}/inventory.json`, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    series: inventory.length,
    assets: assets.length,
    assetDbExact: assets.every((a) => a.dbExact),
    files: files.length,
    researchSnapshots: research.length,
  }),
);
