/**
 * Stage 4 check on the REAL research DB (read-only, zero cost): start a research on the default BTCUSDT board as an
 * earlier policy would (QQUAN_CT_POLICY_VERSION=1) and show that it is refused before any model call, naming the earlier runs.
 *
 *   QQUAN_CT_POLICY_VERSION=1 node --experimental-strip-types --no-warnings scripts/research/ct-board-check.mjs [symbol...]
 *
 * The DB is opened read-only: a refusal writes nothing, and if the board were free the script stops before creating a job.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
register("../../tests/helpers/slot-test-loader.mjs", import.meta.url);
const file = join(process.env.QQUAN_DATA_DIR || join(homedir(), ".qquan"), "state", "research.sqlite");
const sqlite = new DatabaseSync(file, { readOnly: true });
class Statement {
  constructor(sql, values = []) { this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sql, values); }
  // ensureSchema re-runs "CREATE ... IF NOT EXISTS" (no-ops here: they all exist) and re-adds columns (answered "duplicate column"); nothing else may write.
  async run() {
    if (/^\s*CREATE .*IF NOT EXISTS/is.test(this.sql)) return { meta: { changes: 0 } };
    throw new Error(/^\s*ALTER/i.test(this.sql) ? "duplicate column (read-only check)" : "read-only check: no writes");
  }
  async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
  async raw() { return (await this.all()).results.map(Object.values); }
}
globalThis.__strategyTestEnv = { OPENAI_API_KEY: "check", ANTHROPIC_API_KEY: "check", DB: { prepare: (s) => new Statement(s), batch: async (statements) => statements.map(() => ({})) /* CREATE TABLE IF NOT EXISTS only: the tables already exist, nothing is written */ } };
let outbound = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { outbound++; return realFetch(...args); };
const research = await import("../../lib/ct-research-store.ts");
const { CTBoardRepeatError } = await import("../../lib/ct-board.ts");
const owner = sqlite.prepare("SELECT owner_id FROM strategy_generation_runs WHERE json_extract(payload,'$.ct.version')=1 ORDER BY created_at DESC LIMIT 1").get().owner_id;
const symbols = process.argv.slice(2);
const input = { requestId: crypto.randomUUID(), market: "crypto", ...(symbols.length ? { symbols } : {}) };
const contract = await research.prepareCTContract(input);
console.log(`policy traderTools=${contract.policy.traderTools} · symbols ${contract.symbols} · board ${contract.boardSignature.slice(0, 16)}…`);
try {
  const ok = await research.assertBoardFree(owner, contract);
  console.log("BOARD FREE (no earlier run on this board)", ok.repeat ?? "");
} catch (error) {
  if (!(error instanceof CTBoardRepeatError)) throw error;
  console.log(`HTTP ${error.status} · ${error.message}`);
  console.log(JSON.stringify(error.detail.previous.map((p) => ({ id: p.id.slice(0, 8), at: p.at.slice(0, 10), status: p.status, endReason: p.endReason }))));
}
console.log(`outbound network calls: ${outbound} (model calls 0)`);
