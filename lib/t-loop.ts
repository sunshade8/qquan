import { ctDb } from "./t-data.ts";
import { getGenerationJob, resumeGenerationFailure } from "./t-generation-store.ts";
import { createCTResearch } from "./t-research-store.ts";
import { CT_CRYPTO_SYMBOLS } from "./t-symbols.ts";
import { researchFailure } from "./research-recovery.ts";

/**
 * T continuous research (docs/t.md「연속 연구」). T runs on the free router's quota, so nothing in the project
 * limits it: when a chained run ends, the runner starts the next one with the same request, and an interrupted
 * run (rate limit, router down) is resumed after a rest. The chain stops only when the owner stops it
 * (연속 연구 중지, 취소, 일시정지). The next run is the same board, so its orchestrator reads the playbook and lessons the
 * earlier runs wrote and picks a direction they did not take (ctResolveBoard) — nobody has to give a repeat reason.
 *
 * The same final window cannot be opened twice (t_exposure), so when the chain's symbols are spent the next
 * run moves to another symbol of the same market.
 */
const REST_MS = 60_000; // between a finished run and the next
const RESUME_MS = 10 * 60_000; // before resuming an interrupted run (free quota recovers by the minute/day)
const QUICK_RUN_MS = 3 * 60_000; // a run this short probably failed on setup …
const QUICK_RUN_REST_MS = 15 * 60_000; // … so wait longer before the next
const RETRY_MS = 10 * 60_000; // after no next run could be created
const USER_PAUSE = "사용자가 일시정지";
const STOCK_ROTATION = ["NVDA", "TSLA", "AMD", "AAPL", "MSFT", "META", "AMZN", "GOOGL", "SPY", "QQQ"];

async function ensureLoopSchema() {
  await ctDb()
    .prepare("CREATE TABLE IF NOT EXISTS t_loop (run_id TEXT PRIMARY KEY,stopped INTEGER NOT NULL DEFAULT 0,retry_at INTEGER,note TEXT,updated_at INTEGER NOT NULL)")
    .run();
}
async function loopRow(runId: string) {
  return ctDb().prepare("SELECT stopped,retry_at,note FROM t_loop WHERE run_id=?").bind(runId).first<{ stopped: number; retry_at: number | null; note: string | null }>();
}
async function writeLoop(runId: string, fields: { stopped?: boolean; retryAt?: number | null; note?: string | null }) {
  await ctDb()
    .prepare(
      "INSERT INTO t_loop (run_id,stopped,retry_at,note,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET stopped=MAX(stopped,excluded.stopped),retry_at=excluded.retry_at,note=excluded.note,updated_at=excluded.updated_at",
    )
    .bind(runId, fields.stopped ? 1 : 0, fields.retryAt ?? null, fields.note ?? null, Date.now())
    .run();
}

/** The owner's 연속 연구 중지: the run in progress finishes, no next run starts. */
export async function stopTLoop(runId: string) {
  await ensureLoopSchema();
  await writeLoop(runId, { stopped: true, note: "사용자가 연속 연구를 중지했습니다." });
}

/** What the screen shows about the chain of the newest continuous run. */
export async function tLoopStatus(ownerId: string, market: string) {
  await ensureLoopSchema();
  const row = await ctDb()
    .prepare(
      "SELECT id,status FROM t_generation_runs WHERE owner_id=? AND json_extract(payload,'$.tLoop') IS NOT NULL AND json_extract(payload,'$.ct.contract.market')=? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(ownerId, market)
    .first<{ id: string; status: string }>();
  if (!row) return null;
  const loop = await loopRow(row.id);
  const stopped = Boolean(loop?.stopped) || row.status === "cancelled";
  return { runId: row.id, status: row.status, stopped, note: loop?.note ?? null, retryAt: loop?.retry_at ? new Date(loop.retry_at).toISOString() : null };
}

/**
 * Called by the runner whenever no T run is running. Returns what it did (for the log), or null when nothing was due.
 */
export async function continueTLoop(): Promise<string | null> {
  await ensureLoopSchema();
  const row = await ctDb()
    .prepare(
      "SELECT id,status,created_at,updated_at FROM t_generation_runs WHERE json_extract(payload,'$.tLoop') IS NOT NULL AND json_extract(payload,'$.ct.version')=1 ORDER BY created_at DESC LIMIT 1",
    )
    .first<{ id: string; status: string; created_at: number; updated_at: number }>();
  if (!row || row.status === "running" || row.status === "cancelled" || row.status === "rejected") return null;
  const loop = await loopRow(row.id);
  if (loop?.stopped) return null;
  if (loop?.retry_at && loop.retry_at > Date.now()) return null;
  const job = await getGenerationJob(row.id);
  if (!job?.ct || !job.tLoop) return null;
  const quiet = Date.now() - Number(row.updated_at);

  // Interrupted (rate limit, router or data hiccup): resume the same run from its saved stage after a rest.
  const recoverable =
    (job.status === "paused" && job.pauseReason === "interrupted" && !String(job.error ?? "").startsWith(USER_PAUSE)) ||
    (job.status === "failed" && researchFailure(new Error(job.error ?? "")).recoverable);
  if (recoverable) {
    if (quiet < RESUME_MS) return null;
    await resumeGenerationFailure(job);
    return `T 연속 연구: ${job.id.slice(0, 8)} 중단 지점에서 자동 재개`;
  }
  if (job.status === "paused") return null; // the owner's pause, or a pause the owner must resolve (data)

  // Finished (completed, or failed beyond recovery): start the next run of the chain.
  const ran = Number(row.updated_at) - Number(row.created_at);
  if (quiet < (ran < QUICK_RUN_MS ? QUICK_RUN_REST_MS : REST_MS)) return null;
  const request = job.tLoop.request;
  const market = request.market === "crypto" ? "crypto" : "stock";
  const own = (job.ct.contract.symbols ?? []) as string[];
  const rotation = market === "crypto" ? (CT_CRYPTO_SYMBOLS as string[]) : STOCK_ROTATION;
  const choices = [own, ...rotation.filter((s) => !own.includes(s)).map((s) => [s])];
  const n = job.tLoop.n + 1;
  const errors: string[] = [];
  for (const symbols of choices) {
    try {
      const next = await createCTResearch(job.ownerId, {
        ...request,
        symbols,
        requestId: crypto.randomUUID(),
        continuous: true,
        loopN: n,
      });
      await writeLoop(job.id, { note: `다음 연구 ${next.id.slice(0, 8)} 시작 (${symbols.join(", ")})` });
      return `T 연속 연구 ${n}번째 시작 ${next.id.slice(0, 8)} · ${symbols.join(", ")}`;
    } catch (error) {
      errors.push(`${symbols.join(",")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const note = `다음 연구를 만들지 못했습니다 · ${Math.round(RETRY_MS / 60000)}분 후 재시도 · ${errors.slice(0, 3).join(" / ").slice(0, 600)}`;
  await writeLoop(job.id, { retryAt: Date.now() + RETRY_MS, note });
  return note;
}
