import { readFile } from "node:fs/promises";
import { researchJournal } from "../../lib/research-memory.ts";
import { syncJournals, writeJournal, loadResearchCookie, DEFAULT_JOURNAL_DIR } from "./journal.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const directory = option("--out", DEFAULT_JOURNAL_DIR);
if (args.includes("--import")) {
  // Offline archival only: never inserts local unverified data into the server's evidence.
  const data = JSON.parse(await readFile(option("--import"), "utf8"));
  const journal = data.search ? researchJournal(data) : data;
  console.log(await writeJournal(journal, directory));
} else {
  const base = option("--url", process.env.RESEARCH_URL ?? "http://localhost:3000");
  console.log(await syncJournals(base, {
    cookie: process.env.RESEARCH_COOKIE ?? await loadResearchCookie(base), secret: process.env.STRATEGY_RUNNER_SECRET ?? "",
    runner: args.includes("--runner"), directory,
  }));
}
