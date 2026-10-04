import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db/ensure";
import type { GenerationJob } from "./strategy-generation-types.ts";
import { researchJournal, selectResearchMemory } from "./research-memory.ts";

const db = () => (env as unknown as { DB: D1Database }).DB;

export async function loadResearchMemory(job: GenerationJob) {
  await ensureSchema();
  const rows = await db().prepare(
    "SELECT payload FROM strategy_generation_runs WHERE owner_id=? AND id<>? AND updated_at<=? ORDER BY created_at DESC,id DESC LIMIT 100",
  ).bind(job.ownerId, job.id, Date.parse(job.createdAt)).all<{ payload: string }>();
  return selectResearchMemory(job, rows.results.map(row => JSON.parse(row.payload)));
}

/** Keyset pagination includes old/paused/failed work, unlike the UI's latest-12 list. */
export async function journalPage(ownerId: string | null, after = "") {
  await ensureSchema();
  const rows = await db().prepare(ownerId === null
    ? "SELECT id,payload FROM strategy_generation_runs WHERE id>? ORDER BY id LIMIT 21"
    : "SELECT id,payload FROM strategy_generation_runs WHERE owner_id=? AND id>? ORDER BY id LIMIT 21",
  ).bind(...(ownerId === null ? [after] : [ownerId, after])).all<{ id: string; payload: string }>();
  const page = rows.results.slice(0, 20);
  return { journals: page.map(r => JSON.parse(r.payload) as GenerationJob).filter(j => j.search).map(researchJournal),
    next: rows.results.length > 20 ? page.at(-1)!.id : null };
}
