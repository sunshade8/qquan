/** Replays the actual app workflow through its API. No fixtures and no trading API. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const args = process.argv.slice(2),
  arg = (k) => args[args.indexOf(k) + 1];
const base = process.env.RESEARCH_URL ?? "http://127.0.0.1:3010";
const out =
  arg("--out") !== args[0] && args.includes("--out")
    ? arg("--out")
    : "outputs/slot-research";
mkdirSync(out, { recursive: true });
let cookie = process.env.RESEARCH_COOKIE ?? "";
const post = async (body) => {
  const response = await fetch(`${base}/api/strategy-generation`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
  if (!response.ok) throw new Error(await response.text());
  const text = await response.text();
  if (body.action === "advance") {
    const messages = text
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    const error = messages.find((m) => m.type === "error");
    if (error) throw new Error(error.message);
    return messages.find((m) => m.type === "result");
  }
  return JSON.parse(text);
};
let job;
if (args.includes("--replay")) {
  const prior = JSON.parse(readFileSync(arg("--replay"), "utf8"));
  const request = {
    action: "research",
    requestId: crypto.randomUUID(),
    universe: prior.universe,
    slots: prior.search.slots,
    target: prior.search.target,
    config: Object.fromEntries(
      Object.entries(prior.search.config).filter(
        ([k]) => k !== "reserveFraction",
      ),
    ),
    sourceMinutes: prior.sourceBarMinutes,
    designMode: prior.search.agent?.mode ?? "local",
    maxDesignBatches: prior.search.agent?.maxDesignBatches ?? 2,
    brief: prior.brief,
    from: prior.from,
    to: prior.to,
    budgetUsd: prior.budgetUsd,
  };
  job = (await post(request)).job;
} else if (args.includes("--id")) {
  const response = await fetch(`${base}/api/strategy-generation`, {
    headers: { cookie },
  });
  const state = await response.json();
  job = state.jobs.find((j) => j.id === arg("--id"));
  if (!job) throw new Error("Run not accessible to RESEARCH_COOKIE");
} else {
  job = (
    await post({
      action: "research",
      requestId: crypto.randomUUID(),
      universe: ["QQQ", "SPY"],
      budgetUsd: 8,
      target: null,
      sourceMinutes: 5,
      designMode: args.includes("--local") ? "local" : "agent",
    })
  ).job;
}
writeFileSync(`${out}/request.json`, JSON.stringify(job, null, 2));
for (let n = 0; job.status === "running" && n < 250; n++) {
  job = (await post({ action: "advance", id: job.id })).job;
  writeFileSync(`${out}/run.json`, JSON.stringify(job, null, 2));
  console.log(
    JSON.stringify({
      id: job.id,
      status: job.status,
      phase: job.search.phase,
      trials: job.search.trials.length,
      backtests: job.search.backtests,
      error: job.error,
    }),
  );
}
for (const trial of job.search.trials) {
  const response = await fetch(
    `${base}/api/strategy-generation?id=${job.id}&artifact=${trial.artifact}`,
    { headers: { cookie } },
  );
  if (!response.ok) throw new Error("artifact export failed");
  writeFileSync(`${out}/${trial.id}.json`, await response.text());
}
console.log(
  JSON.stringify({
    status: job.status,
    cost: job.costUsd,
    reason: job.search.endReason,
  }),
);
if (job.status !== "completed") process.exitCode = 1;
