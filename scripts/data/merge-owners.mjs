// Moves every research/strategy/ledger row from per-browser owner ids to QQUAN_OWNER_ID.
// Usage: node --env-file=.dev.vars scripts/data/merge-owners.mjs [--dry-run]
// Takes a consistent backup (VACUUM INTO) before writing. Safe to re-run.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const target = process.env.QQUAN_OWNER_ID?.trim();
if (!target || !/^[a-f0-9-]{36}$/i.test(target)) throw new Error("QQUAN_OWNER_ID (UUID) is required");
const dryRun = process.argv.includes("--dry-run");
const dir = resolve(process.env.QQUAN_DATA_DIR || join(homedir(), ".qquan"));
const db = new DatabaseSync(join(dir, "state", "research.sqlite"));
db.exec("PRAGMA busy_timeout=30000;");

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
const columns = (table) => db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((r) => r.name);
const owned = tables.filter((t) => columns(t).includes("owner_id"));
// Generation jobs repeat the owner inside the payload and the API compares it.
const payloads = owned.filter((t) => columns(t).includes("payload"));

const plan = owned.map((t) => ({
  table: t,
  rows: db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t)} WHERE owner_id <> ?`).get(target).n,
  owners: db.prepare(`SELECT COUNT(DISTINCT owner_id) AS n FROM ${quote(t)} WHERE owner_id <> ?`).get(target).n,
})).filter((p) => p.rows);
console.table(plan);
if (dryRun || !plan.length) {
  console.log(plan.length ? "dry run: nothing written" : "already merged");
  process.exit(0);
}

mkdirSync(join(dir, "backups"), { recursive: true });
const backup = join(dir, "backups", `research-before-owner-merge-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
console.log(`backup: ${backup}`);

db.exec("BEGIN IMMEDIATE");
try {
  for (const t of payloads)
    db.prepare(`UPDATE ${quote(t)} SET payload = json_set(payload, '$.ownerId', ?) WHERE json_valid(payload) AND json_extract(payload, '$.ownerId') IS NOT NULL AND json_extract(payload, '$.ownerId') <> ?`).run(target, target);
  // Plain UPDATE: a unique-index collision aborts the whole merge instead of leaving rows behind.
  for (const { table } of plan) db.prepare(`UPDATE ${quote(table)} SET owner_id = ? WHERE owner_id <> ?`).run(target, target);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
console.log(`merged ${plan.reduce((n, p) => n + p.rows, 0)} rows into ${target}`);
