/** Build first. Starts a fresh real app twice with no Cloudflare/provider credentials. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const root = await mkdtemp(join(tmpdir(), "qquan-runtime-"));
const env = {
  ...process.env,
  QQUAN_DATA_DIR: root,
  QQUAN_SKIP_ENV_FILE: "1",
  HOST: "127.0.0.1",
  PORT: "3001",
};
for (const key of Object.keys(env))
  if (
    /^(CLOUDFLARE_|D1_|TOSS_|UPBIT_|MASSIVE_|POLYGON_|ANTHROPIC_|OPENAI_|VERCEL)/.test(
      key,
    )
  )
    delete env[key];
let child;
async function start() {
  child = spawn(process.execPath, [".output/server/index.mjs"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw Error(errors);
    try {
      const r = await fetch("http://127.0.0.1:3001/api/local-data");
      if (r.ok) return await r.json();
    } catch { /* not ready yet; retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error("Local startup timeout: " + errors);
}
async function stop() {
  if (child?.exitCode === null)
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
}
try {
  await start();
  const ct = await fetch("http://127.0.0.1:3001/api/invest/ct?market=stock");
  assert.equal(ct.status, 200, await ct.text());
  const db = new DatabaseSync(join(root, "state/research.sqlite"));
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO local_data_jobs(id,dataset,status,start,end,total,updated) VALUES (?,'stock','canceled',?,?,1,?)",
  ).run(id, Date.parse("2026-09-28"), Date.parse("2026-09-29"), Date.now());
  db.close();
  await stop();
  const restored = await start();
  assert.equal(restored.find((d) => d.dataset === "stock").job.id, id);
  assert.equal(
    restored.find((d) => d.dataset === "stock").job.status,
    "canceled",
  );
  for (const [origin, body] of [
    ["http://evil.example", { action: "enqueue", dataset: "stock" }],
    [
      "http://127.0.0.1:3001",
      { action: "enqueue", dataset: "stock", url: "https://evil.example" },
    ],
  ]) {
    const r = await fetch("http://127.0.0.1:3001/api/local-data", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400);
  }
  console.log(
    JSON.stringify({
      cloudflareCredentials: false,
      providerCredentials: false,
      ctStatus: ct.status,
      restartPersistence: true,
      invalidOriginAndArbitraryURLRejected: true,
    }),
  );
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
