/** Times the per-bar overview (lib/ct-bar-overview.ts) on a frozen free-bar contract's local data. No model, no orders, no writes. */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
register("../../tests/helpers/slot-test-loader.mjs", import.meta.url);
globalThis.__strategyTestEnv = {};
process.env.QQUAN_DENY_MARKET_NETWORK = "1";
const { loadCTData } = await import("../../lib/ct-data.ts");
const { ctCostHurdle } = await import("../../lib/ct-design-tools.ts");
const { ctBarOverview } = await import("../../lib/ct-bar-overview.ts");
const db = new DatabaseSync(`${process.env.QQUAN_DATA_DIR ?? homedir() + "/.qquan"}/state/research.sqlite`, { readOnly: true });
const id = process.argv[2] ?? "7a4354f4-ae1e-49ba-9f1b-9d5e33734498";
const contract = JSON.parse(db.prepare("SELECT json_extract(payload,'$.ct.contract') c FROM strategy_generation_runs WHERE id=?").get(id).c);
let t = Date.now();
const data = await loadCTData(id, contract);
console.log("load", Date.now() - t, "ms", Object.values(data)[0].length, "one-minute bars", contract.symbols.join(","));
t = Date.now();
const hurdle = ctCostHurdle(data, contract);
console.log("cost_hurdle", Date.now() - t, "ms", JSON.stringify(hurdle).length, "chars");
// Cold: a fresh copy of the arrays so the ctBarsAt cache is empty.
const cold = Object.fromEntries(Object.entries(data).map(([s, b]) => [s, [...b]]));
t = Date.now();
const overview = ctBarOverview(cold, contract);
console.log("bar overview (cold)", Date.now() - t, "ms", JSON.stringify(overview).length, "chars");
t = Date.now();
ctBarOverview(cold, contract);
console.log("bar overview (warm bars)", Date.now() - t, "ms");
for (const b of overview.bars) {
  console.log(`\n${b.barMinutes}m · bars ${b.trainingBars} · entries ${b.sampledEntries} · cost/meanBar ${b.costToMeanBarRange} · labels ${JSON.stringify(b.labels)}`);
  for (const h of b.horizons) console.log("  " + JSON.stringify(Object.fromEntries(overview.columns.horizons.map((c, i) => [c, h[i]]))));
}
// The stable block this run would have had under tool version 5 (same state, overview added), and its size against version 4.
const { ctSessionContext } = await import("../../lib/ct-research.ts");
const { CT_POLICY } = await import("../../lib/ct-spec.ts");
const ct = JSON.parse(db.prepare("SELECT json_extract(payload,'$.ct') c FROM strategy_generation_runs WHERE id=?").get(id).c);
const session = { index: 0, kind: "design", status: "open", startedAt: "", turns: 0, toolCalls: 0, screens: 0, messages: 0 };
const v4 = ctSessionContext(ct, "", hurdle, session).stable;
const v5 = ctSessionContext({ ...ct, contract: { ...ct.contract, policy: { ...ct.contract.policy, traderTools: CT_POLICY.traderTools } } }, "", hurdle, session, overview).stable;
console.log(`\nstable block: v4 ${v4.length} chars · v5 ${v5.length} chars (+${v5.length - v4.length})`);
process.exit(0);
