/**
 * Order-book sampler for the CT cost profile (docs/ct.md「비용 프로필」).
 *
 * Polls PUBLIC, unauthenticated endpoints once a minute — Binance Spot `depth` and Upbit
 * `orderbook` — and stores, per snapshot, the spread and the per-side price impact of a
 * market order sized like the contract capital ($1,000) and ten times that ($10,000).
 * No keys, no account, no orders. Rows go to SQLite table `ct_orderbook_samples`.
 *
 *   node --experimental-strip-types scripts/data/measure-orderbook.mjs            # run until stopped
 *   node --experimental-strip-types scripts/data/measure-orderbook.mjs --once     # one sweep, print it
 *   node --experimental-strip-types scripts/data/measure-orderbook.mjs --summary  # p50/p90/p99 so far
 *   node --experimental-strip-types scripts/data/measure-orderbook.mjs --profile    # p90 table for lib/ct-costs.ts (JSON)
 *   node --experimental-strip-types scripts/data/measure-orderbook.mjs --check      # fail if lib/ct-costs.ts is below the measurement
 *   --hours=72   stop after N hours (default: run until SIGINT/SIGTERM)
 *   --interval=60   seconds between sweeps
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bookImpact, quantile } from "../../lib/ct-orderbook.ts";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const dir = process.env.QQUAN_DATA_DIR || join(homedir(), ".qquan");
mkdirSync(join(dir, "state"), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(dir, "state", "research.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;");
db.exec(`CREATE TABLE IF NOT EXISTS ct_orderbook_samples (
  ts INTEGER NOT NULL, venue TEXT NOT NULL, symbol TEXT NOT NULL, notional_usd REAL NOT NULL,
  mid REAL NOT NULL, spread_bp REAL NOT NULL, buy_bp REAL, sell_bp REAL,
  PRIMARY KEY(ts, venue, symbol, notional_usd))`);

const NOTIONALS_USD = [1000, 10000];
const BINANCE = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const UPBIT = ["KRW-BTC", "KRW-ETH", "KRW-SOL"];
const BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}
const levels = (rows) => rows.map(([price, size]) => ({ price: Number(price), size: Number(size) }));

const insert = db.prepare(
  "INSERT OR IGNORE INTO ct_orderbook_samples(ts,venue,symbol,notional_usd,mid,spread_bp,buy_bp,sell_bp) VALUES(?,?,?,?,?,?,?,?)",
);
function store(ts, venue, symbol, book, usdToQuote) {
  const rows = [];
  for (const usd of NOTIONALS_USD) {
    const impact = bookImpact(book, usd * usdToQuote);
    if (!impact) continue;
    insert.run(ts, venue, symbol, usd, impact.mid, impact.spreadBp, impact.buyBp, impact.sellBp);
    rows.push({ venue, symbol, usd, ...impact });
  }
  return rows;
}

async function sweep() {
  const ts = Math.floor(Date.now() / 60000) * 60000;
  const out = [],
    errors = [];
  for (const symbol of BINANCE) {
    let done = false;
    for (const host of BINANCE_HOSTS) {
      try {
        const d = await getJson(`${host}/api/v3/depth?symbol=${symbol}&limit=500`);
        out.push(...store(ts, "binance", symbol, { bids: levels(d.bids), asks: levels(d.asks) }, 1));
        done = true;
        break;
      } catch (e) {
        errors.push(String(e.message));
      }
    }
    if (!done) errors.push(`binance ${symbol} unavailable`);
  }
  try {
    // KRW per USD proxy: the KRW-USDT ticker (USDT ≈ 1 USD). Upbit sizes are in KRW.
    const [{ trade_price: krwPerUsd }] = await getJson("https://api.upbit.com/v1/ticker?markets=KRW-USDT");
    const books = await getJson(`https://api.upbit.com/v1/orderbook?markets=${UPBIT.join(",")}&count=30`);
    for (const b of books) {
      const units = b.orderbook_units;
      out.push(
        ...store(
          ts,
          "upbit",
          b.market,
          {
            bids: units.map((u) => ({ price: u.bid_price, size: u.bid_size })),
            asks: units.map((u) => ({ price: u.ask_price, size: u.ask_size })),
          },
          krwPerUsd,
        ),
      );
    }
  } catch (e) {
    errors.push(String(e.message));
  }
  return { ts, rows: out, errors };
}

function summary() {
  const rows = db
    .prepare("SELECT venue,symbol,notional_usd,spread_bp,buy_bp,sell_bp,ts FROM ct_orderbook_samples")
    .all();
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.venue} ${r.symbol} $${r.notional_usd}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const f = (n) => (Number.isFinite(n) ? n.toFixed(3) : "—");
  const out = [];
  for (const [k, xs] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const side = xs.flatMap((r) => [r.buy_bp, r.sell_bp]).filter((n) => n !== null);
    const hours = (Math.max(...xs.map((r) => r.ts)) - Math.min(...xs.map((r) => r.ts))) / 3600000;
    out.push({
      key: k,
      samples: xs.length,
      hours: Number(hours.toFixed(1)),
      spreadBp: [0.5, 0.9, 0.99].map((q) => quantile(xs.map((r) => r.spread_bp), q)),
      sideImpactBp: [0.5, 0.9, 0.99].map((q) => quantile(side, q)),
      thinBook: xs.filter((r) => r.buy_bp === null || r.sell_bp === null).length,
    });
  }
  for (const r of out)
    console.log(
      `${r.key.padEnd(24)} n=${String(r.samples).padStart(5)} ${String(r.hours).padStart(5)}h  spread p50/p90/p99 bp ${r.spreadBp.map(f).join(" / ")}  side-impact p50/p90/p99 bp ${r.sideImpactBp.map(f).join(" / ")}  thin=${r.thinBook}`,
    );
  return out;
}

/** p90 of the spread and of the per-side impact, in percent, per venue/symbol/order size. */
function profileTable() {
  const out = {};
  const rows = db.prepare("SELECT venue,symbol,notional_usd,ts,spread_bp,buy_bp,sell_bp FROM ct_orderbook_samples").all();
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.venue}|${r.symbol}|${r.notional_usd}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, xs] of groups) {
    const [venue, symbol, usd] = k.split("|");
    const side = xs.flatMap((r) => [r.buy_bp, r.sell_bp]).filter((n) => n !== null);
    const ts = xs.map((r) => r.ts);
    (out[`${venue}:${symbol}`] ??= {})[usd] = {
      samples: xs.length,
      from: new Date(Math.min(...ts)).toISOString(),
      to: new Date(Math.max(...ts)).toISOString(),
      hours: Number(((Math.max(...ts) - Math.min(...ts)) / 3600000).toFixed(1)),
      spreadPctP90: Number((quantile(xs.map((r) => r.spread_bp), 0.9) / 100).toFixed(6)),
      sideImpactPctP90: Number((quantile(side, 0.9) / 100).toFixed(6)),
      thinBookShare: Number((xs.filter((r) => r.buy_bp === null || r.sell_bp === null).length / xs.length).toFixed(4)),
    };
  }
  return out;
}
if (args.profile) {
  const table = profileTable();
  if (args["write-lib"]) {
    // Keep only the venues the profiles use, rounded UP so the file is never below the measurement.
    const up = (x) => Math.ceil(x * 1e6) / 1e6;
    for (const per of Object.values(table))
      for (const v of Object.values(per)) {
        v.spreadPctP90 = up(v.spreadPctP90);
        v.sideImpactPctP90 = up(v.sideImpactPctP90);
      }
    const { readFileSync, writeFileSync } = await import("node:fs");
    const file = new URL("../../lib/ct-cost-measurements.ts", import.meta.url);
    const head = readFileSync(file, "utf8").split("export const CT_MEASURED_IMPACT")[0];
    writeFileSync(file, `${head}export const CT_MEASURED_IMPACT: Record<string, Record<string, CTMeasuredImpact>> = ${JSON.stringify(table, null, 2)};\n`);
    console.log("wrote lib/ct-cost-measurements.ts");
  } else console.log(JSON.stringify(table, null, 2));
  process.exit(0);
}
if (args.check) {
  const { CT_COST_PROFILES } = await import("../../lib/ct-costs.ts");
  const table = profileTable();
  let bad = 0;
  for (const profile of Object.values(CT_COST_PROFILES)) {
    for (const [symbol, per] of Object.entries(profile.symbols ?? {})) {
      for (const [usd, v] of Object.entries(per)) {
        const m = table[`${profile.venue}:${symbol}`]?.[usd];
        if (!m) continue;
        const side = v.spreadPct / 2 + v.slippagePct;
        const ok = v.spreadPct + 1e-9 >= m.spreadPctP90 && side + 1e-9 >= m.sideImpactPctP90;
        if (!ok) bad++;
        console.log(`${ok ? "ok " : "LOW"} ${profile.id} ${symbol} $${usd}: profile spread ${v.spreadPct} side ${side.toFixed(6)} | measured p90 spread ${m.spreadPctP90} side ${m.sideImpactPctP90} (${m.hours}h, ${m.samples} samples)`);
      }
    }
  }
  process.exit(bad ? 1 : 0);
}
if (args.summary) {
  summary();
  process.exit(0);
}
if (args.once) {
  const r = await sweep();
  for (const x of r.rows) console.log(x.venue, x.symbol, `$${x.usd}`, "mid", x.mid, "spread", x.spreadBp.toFixed(3), "buy", x.buyBp?.toFixed(3), "sell", x.sellBp?.toFixed(3));
  if (r.errors.length) console.error("errors:", r.errors);
  process.exit(0);
}

const interval = Number(args.interval ?? 60) * 1000;
const stopAt = args.hours ? Date.now() + Number(args.hours) * 3600000 : Infinity;
let stopping = false;
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => (stopping = true));
console.log(`[${new Date().toISOString()}] sampler start · interval ${interval / 1000}s · until ${stopAt === Infinity ? "stopped" : new Date(stopAt).toISOString()}`);
let sweeps = 0;
while (!stopping && Date.now() < stopAt) {
  const started = Date.now();
  try {
    const r = await sweep();
    sweeps++;
    if (r.errors.length) console.error(`[${new Date().toISOString()}] ${r.errors.length} error(s): ${r.errors.slice(0, 3).join(" | ")}`);
    if (sweeps % 30 === 1) console.log(`[${new Date().toISOString()}] sweep ${sweeps} · ${r.rows.length} rows`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] sweep failed: ${e.message}`);
  }
  const wait = interval - (Date.now() - started);
  for (let t = 0; t < wait && !stopping; t += 1000) await new Promise((r) => setTimeout(r, Math.min(1000, wait - t)));
}
console.log(`[${new Date().toISOString()}] sampler stop after ${sweeps} sweeps`);
summary();
