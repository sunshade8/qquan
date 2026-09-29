/** Private monthly assets + the same local D1 cache used by the app. */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parseMassiveAggregates } from '../lib/massive-shapes.ts';
import { missingIntradayRange } from '../lib/intraday-coverage.ts';

const root = resolve(import.meta.dirname, '..');
const directory = join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const candidates = existsSync(directory) ? readdirSync(directory).filter(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite') : [];
if (!process.env.MARKET_DATA_DB && candidates.length !== 1) throw new Error('Set MARKET_DATA_DB to the initialized local app D1 SQLite file.');
const db = new DatabaseSync(process.env.MARKET_DATA_DB || join(directory, candidates[0]));
db.exec('PRAGMA busy_timeout=10000');
const assetDir = join(root, 'assets/market-data');
mkdirSync(assetDir, { recursive: true });
const shift = (date, days) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const to = process.argv[3] || shift(today, -1);
const from = process.argv[2] || shift(to, -730);
if (![from, to].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d).toISOString().slice(0, 10) === d) || from > to || to >= today) throw new Error('Usage: node scripts/prefetch-market-data.mjs [YYYY-MM-DD YYYY-MM-DD]; historical dates only.');
const coverage = db.prepare("SELECT * FROM intraday_bar_coverage WHERE symbol=? AND interval='5m' AND month=?");
const days = db.prepare("SELECT * FROM intraday_bar_days WHERE symbol=? AND interval='5m' AND trading_date BETWEEN ? AND ? ORDER BY trading_date");
const saveDay = db.prepare('INSERT INTO intraday_bar_days (id,symbol,interval,trading_date,payload,provider) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,provider=excluded.provider');
const saveCoverage = db.prepare('INSERT INTO intraday_bar_coverage (id,symbol,interval,month,from_date,to_date,complete,fetched_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET from_date=excluded.from_date,to_date=excluded.to_date,complete=excluded.complete,fetched_at=excluded.fetched_at');
function persist(rows, c) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) saveDay.run(r.id, r.symbol, r.interval, r.trading_date, r.payload, r.provider);
    saveCoverage.run(c.id,c.symbol,c.interval,c.month,c.from_date,c.to_date,c.complete,c.fetched_at);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
let lastCall = 0, calls = 0;
async function download(symbol, start, end) {
  const vars = existsSync(join(root, '.dev.vars')) ? readFileSync(join(root, '.dev.vars'), 'utf8') : '';
  const pick = name => process.env[name] || vars.split('\n').find(l => l.startsWith(name + '='))?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  const key = pick('MASSIVE_API_KEY') || pick('POLYGON_API_KEY');
  if (!key) throw new Error('Missing Massive API key.');
  let url = `https://api.massive.com/v2/aggs/ticker/${symbol}/range/5/minute/${start}/${end}?adjusted=true&sort=asc&limit=50000`;
  const points = [];
  for (let page = 0; url; page++) {
    if (page >= 10) throw new Error('Pagination incomplete; coverage not saved.');
    const target = new URL(url);
    if (!['api.massive.com', 'api.polygon.io'].includes(target.hostname) || target.protocol !== 'https:') throw new Error('Unexpected pagination URL');
    target.searchParams.delete('apiKey');
    await new Promise(r => setTimeout(r, Math.max(0, lastCall + 13000 - Date.now())));
    lastCall = Date.now(); calls++;
    const res = await fetch(target, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Massive HTTP ${res.status}; rerun to resume saved months.`);
    const body = await res.json();
    if (body.error || !['OK', 'DELAYED'].includes(body.status)) throw new Error('Massive did not return a successful aggregate response.');
    points.push(...parseMassiveAggregates(body.results || [], start, end, 'all'));
    url = body.next_url;
  }
  const grouped = new Map();
  for (const p of points) {
    if (p.time < '04:00' || p.time >= '20:00') continue;
    const bars = grouped.get(p.date) || new Map();
    bars.set(p.time, [p.time,p.open,p.high,p.low,p.close,p.volume]); grouped.set(p.date,bars);
  }
  return [...grouped].map(([date,bars]) => ({ id:`${symbol}|5m|${date}`, symbol, interval:'5m', trading_date:date, provider:'Massive', payload:JSON.stringify([...bars.values()].sort((a,b)=>a[0].localeCompare(b[0]))) }));
}
const summary = [];
try {
  for (const symbol of ['SPY', 'QQQ']) {
    for (let cursor = from; cursor <= to;) {
      const month = cursor.slice(0,7), monthStart = month + '-01';
      const d = new Date(monthStart + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth()+1);
      const next = d.toISOString().slice(0,10), monthEnd = shift(next,-1), end = monthEnd < to ? monthEnd : to;
      const file = join(assetDir, `${symbol}-5m-${month}.json.gz`);
      let cached = coverage.get(symbol, month);
      if (!cached && existsSync(file)) {
        const asset = JSON.parse(gunzipSync(readFileSync(file)));
        if (asset.version !== 1 || asset.coverage.symbol !== symbol || asset.coverage.month !== month) throw new Error('Invalid market data asset');
        persist(asset.days, asset.coverage); cached = coverage.get(symbol, month);
      }
      const missing = missingIntradayRange(cursor,end,cached && {fromDate:cached.from_date,toDate:cached.to_date});
      if (missing) {
        console.log(`${symbol} ${missing.from}..${missing.to}: downloading missing dates`);
        const rows = await download(symbol,missing.from,missing.to);
        // Re-read after network IO so concurrent app writes are not lost.
        cached = coverage.get(symbol, month);
        const first = cached && cached.from_date < missing.from ? cached.from_date : missing.from;
        const last = cached && cached.to_date > missing.to ? cached.to_date : missing.to;
        persist(rows,{id:`${symbol}|5m|${month}`,symbol,interval:'5m',month,from_date:first,to_date:last,complete:Number(first===monthStart&&last===monthEnd),fetched_at:Date.now()});
      }
      const c = coverage.get(symbol,month), rows = days.all(symbol,c.from_date,c.to_date);
      if (rows.some(r => r.provider !== 'Massive')) throw new Error('Mixed providers in asset');
      writeFileSync(file+'.tmp',gzipSync(JSON.stringify({version:1,coverage:c,days:rows})));
      renameSync(file+'.tmp',file);
      console.log(`${symbol} ${month}: saved ${rows.length} sessions`);
      cursor = next;
    }
    const rows = days.all(symbol,from,to);
    summary.push({symbol,sessions:rows.length,bars:rows.reduce((n,r)=>n+JSON.parse(r.payload).length,0),first:rows[0]?.trading_date,last:rows.at(-1)?.trading_date});
  }
  writeFileSync(join(assetDir,'manifest.json'),JSON.stringify({version:1,provider:'Massive',interval:'5m',session:'04:00–20:00 America/New_York',from,to,summary},null,2)+'\n');
  console.log(JSON.stringify({apiCalls:calls,summary},null,2));
} finally { db.close(); }
