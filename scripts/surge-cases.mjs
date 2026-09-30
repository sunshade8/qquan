#!/usr/bin/env node
/**
 * Records the owner's nightly Toss TOP_GAINERS / TOP_LOSERS list.
 *
 *   node scripts/surge-cases.mjs record < list.txt
 *   node scripts/surge-cases.mjs record "2026-09-30/ABCD/+45.2%"
 *   node scripts/surge-cases.mjs collect        # fetch minutes for cases whose session is over
 *   node scripts/surge-cases.mjs status
 *
 * One case per line, 날짜/종목/등락폭. Needs the app running (npm run dev) — it writes through the app's D1.
 */
const [action = "status", ...rest] = process.argv.slice(2);
const base = (process.env.QQUANT_URL ?? "http://localhost:3000").replace(/\/$/, "");
const url = `${base}/api/invest/surge/cases`;

async function stdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

let response;
if (action === "status") response = await fetch(url);
else if (action === "record") {
  const text = rest.join("\n") || await stdin();
  response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "record", text, source: "runner" }) });
} else if (action === "collect") {
  response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "collect", source: "runner" }) });
} else {
  console.error(`알 수 없는 작업: ${action} (record | collect | status)`);
  process.exit(1);
}
const payload = await response.json().catch(() => ({}));
if (!response.ok) { console.error(payload.error ?? `HTTP ${response.status}`); process.exit(1); }
if (action === "status") {
  console.log(`사례 ${payload.counts.recorded}건 · ${payload.counts.nights}일 · 수집 ${payload.counts.collected} · 대기 ${payload.counts.pending} · 확인 필요 ${payload.counts.failed}`);
  for (const stage of payload.agent) console.log(`  [${stage.state}] ${stage.label} — ${stage.detail}`);
} else console.log(JSON.stringify(payload, null, 2));
