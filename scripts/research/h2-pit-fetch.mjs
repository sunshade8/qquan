// Fetches Massive grouped-daily (all US stocks per day, adjusted) + ticker reference into
// ~/.qquan/research/h2-survivorship/. Resumable. Key read from .dev.vars, never printed.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const DIR = join(homedir(), ".qquan/research/h2-survivorship");
mkdirSync(join(DIR, "grouped"), { recursive: true });
const key = /MASSIVE_API_KEY=(.+)/.exec(readFileSync(".dev.vars", "utf8"))[1].trim().replace(/^["']|["']$/g, "");
const B = "https://api.massive.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gap = Number(process.env.GAP_MS ?? 2000);
async function get(url) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let res;
    try { res = await fetch(url + (url.includes("?") ? "&" : "?") + "apiKey=" + key); }
    catch (e) { console.error("network error, retry", e.cause?.code ?? e.message); await sleep(20000); continue; }
    if (res.status === 429) { console.error("429 backoff, gap", gap); gap = Math.min(gap * 1.5 + 500, 13000); await sleep(15000); continue; }
    const body = await res.json();
    await sleep(gap);
    return { status: res.status, body };
  }
  throw new Error("too many 429");
}
// 1) ticker reference: CS + ADRC, active and inactive
for (const active of ["true", "false"]) {
  for (const type of ["CS", "ADRC"]) {
    const file = join(DIR, `tickers-${type}-${active}.json`);
    if (existsSync(file)) continue;
    let url = `${B}/v3/reference/tickers?market=stocks&type=${type}&active=${active}&limit=1000`;
    const all = [];
    while (url) {
      const { status, body } = await get(url);
      if (status !== 200) throw new Error("ref " + status + " " + body.message);
      all.push(...body.results.map((r) => ({ t: r.ticker, name: r.name, type: r.type, active: r.active, delisted: r.delisted_utc ?? null, exch: r.primary_exchange ?? null })));
      url = body.next_url ?? null;
    }
    writeFileSync(file, JSON.stringify(all));
    console.error("ref", type, active, all.length);
  }
}
// 2) grouped daily for every weekday
const start = new Date("2024-10-17T00:00:00Z"), end = new Date(process.env.END ?? "2026-10-16T00:00:00Z");
for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
  const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
  const day = d.toISOString().slice(0, 10);
  const file = join(DIR, "grouped", day + ".json");
  if (existsSync(file)) continue;
  const { status, body } = await get(`${B}/v2/aggs/grouped/locale/us/market/stocks/${day}?adjusted=true&include_otc=false`);
  if (status !== 200) { console.error("fail", day, status, body.message); continue; }
  writeFileSync(file, JSON.stringify((body.results ?? []).map((r) => [r.T, r.o, r.h, r.l, r.c, r.v, r.vw ?? null])));
  console.error(day, body.resultsCount ?? 0);
}
console.error("DONE");
