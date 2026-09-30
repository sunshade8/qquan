#!/usr/bin/env node
/**
 * Keeps the 전략 tab's dashboards trading while no browser has it open.
 *
 * A Worker has no timer of its own, so something has to call the tick endpoint.
 * Run this on a machine whose IP is registered with Toss (WTS > 설정 > Open API >
 * 허용 IP) — the dashboards place orders from wherever the app runs, and the
 * runner's heartbeat is what the dashboard shows as "백그라운드 러너 온라인".
 *
 *   npm run trader                               # http://localhost:3000, every 15s
 *   npm run trader -- --url https://your.site --interval 20
 *   npm run trader -- --generation-only          # advance strategy generation, no trading ticks
 *
 * Stopping this process does not stop trading; it only stops the ticks. Use the
 * dashboard's 정지 button to stop, which cancels buys and sells holdings first.
 */

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const base = option("url", process.env.TRADING_RUNNER_URL ?? "http://localhost:3000").replace(/\/$/, "");
const intervalSeconds = Math.max(5, Number(option("interval", process.env.TRADING_RUNNER_INTERVAL ?? "15")) || 15);
const generationOnly = args.includes("--generation-only");
let stopping = false;

const stamp = () => new Date().toTimeString().slice(0, 8);

async function tick() {
  const started = Date.now();
  try {
    const response = await fetch(`${base}/api/trading`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "tick", source: "runner" }),
      signal: AbortSignal.timeout(170_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) console.error(`[${stamp()}] HTTP ${response.status} ${payload.error ?? ""}`);
    else console.log(`[${stamp()}] live=${payload.results?.live} paper=${payload.results?.paper} (${Date.now() - started}ms)`);
  } catch (error) {
    console.error(`[${stamp()}] ${base} 연결 실패: ${error instanceof Error ? error.message : error}`);
  }
}

process.on("SIGINT", () => { stopping = true; console.log("\n러너 종료 — 대시보드 상태는 그대로 유지됩니다. 거래를 멈추려면 대시보드에서 정지를 누르세요."); process.exit(0); });

// Generation uses a separate loop: a long model call must never delay order monitoring.
// Both generators keep one durable stage per request, so each is simply advanced in turn.
const GENERATORS = [
  { name: "전략", path: "/api/strategy-generation" },
  { name: "급등주", path: "/api/invest/surge" },
];

async function advance(generator) {
  const response = await fetch(`${base}${generator.path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(process.env.STRATEGY_RUNNER_SECRET ? { authorization: `Bearer ${process.env.STRATEGY_RUNNER_SECRET}` } : {}) },
    body: JSON.stringify({ action: "advance", source: "runner" }), signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    console.error(`[${stamp()}] ${generator.name} generation HTTP ${response.status}`);
    return;
  }
  // The advance streams NDJSON progress; the last progress line is what the stage did.
  let last = "";
  for (const line of (await response.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message.type === "progress") last = message.message;
      if (message.type === "error") console.error(`[${stamp()}] ${generator.name}: ${message.message}`);
      if (message.type === "result" && message.job) {
        const job = message.job;
        console.log(`[${stamp()}] ${generator.name} ${job.status} stage=${job.stageIndex} ${last}`);
      }
    } catch { /* a plain JSON body means there was no running job */ }
  }
}

async function generationLoop() {
  while (!stopping) {
    for (const generator of GENERATORS) {
      try { await advance(generator); } catch (error) { console.error(`[${stamp()}] ${generator.name} generation: ${error.message}`); }
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
/** The owner's recorded 급등락 사례 get their session minutes once the session (incl. after-hours) is over. */
async function caseLoop() {
  while (!stopping) {
    try {
      const response = await fetch(`${base}/api/invest/surge/cases`, {
        method: "POST", headers: { "content-type": "application/json", ...(process.env.STRATEGY_RUNNER_SECRET ? { authorization: `Bearer ${process.env.STRATEGY_RUNNER_SECRET}` } : {}) },
        body: JSON.stringify({ action: "collect", source: "runner" }), signal: AbortSignal.timeout(170_000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) console.error(`[${stamp()}] 급등락 사례 수집: ${result.error ?? `HTTP ${response.status}`}`);
      else if (result.collected || result.mismatch || result.failed) console.log(`[${stamp()}] 급등락 사례 수집 ${result.collected} · 확인 필요 ${result.mismatch} · 실패 ${result.failed}`);
    } catch (error) {
      console.error(`[${stamp()}] 급등락 사례 수집 연결 실패: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 600_000));
  }
}
void caseLoop();
void generationLoop();
console.log(`QQuant trading runner → ${base} · ${generationOnly ? "전략 생성만 (거래 틱 없음)" : `${intervalSeconds}s 간격`}`);
while (!stopping && !generationOnly) {
  const started = Date.now();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, intervalSeconds * 1_000 - (Date.now() - started))));
}
