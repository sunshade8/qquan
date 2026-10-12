/** Local mirror of the durable research store; no account or order calls. */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_JOURNAL_DIR = join(
  process.env.QQUAN_DATA_DIR || join(homedir(), ".qquan"),
  "research/journals",
);
const safeId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function atomic(path, body) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, body, { mode: 0o600 });
  await rename(temp, path);
}

export async function writeJournal(journal, directory = DEFAULT_JOURNAL_DIR) {
  if (
    journal.version !== 1 ||
    !safeId(journal.id) ||
    !Array.isArray(journal.experiments)
  )
    throw new Error("Invalid research journal");
  const root = join(resolve(directory), journal.id);
  await mkdir(join(root, "snapshots"), { recursive: true, mode: 0o700 });
  // Content-addressed snapshots survive interruption, concurrent runners and repeated exports.
  const body = JSON.stringify(journal, null, 2) + "\n";
  const snapshot = join(root, "snapshots", `${hash(journal)}.json`);
  // Publish only complete files; interrupted writes leave a temp, not a broken snapshot.
  const saved = await readFile(snapshot, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (saved !== body) await atomic(snapshot, body);
  const latestPath = join(root, "run.json");
  const existing = await readFile(latestPath, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (existing && existing.updatedAt > journal.updatedAt) return root;
  await atomic(latestPath, body);
  const counts = {};
  for (const record of journal.experiments)
    counts[record.status === "measured" ? record.failure : record.status] =
      (counts[record.status === "measured" ? record.failure : record.status] ??
        0) + 1;
  await atomic(
    join(root, "experiments.jsonl"),
    journal.experiments.map((r) => JSON.stringify(r)).join("\n") +
      (journal.experiments.length ? "\n" : ""),
  );
  await atomic(
    join(root, "README.md"),
    `# 연구 ${journal.id}\n\n${journal.from}–${journal.to} · ${(journal.universe ?? []).join(", ")} · ${journal.status}\n\n실험 ${journal.experiments.length}개 · 연구 API 비용 $${journal.costUsd}\n\n${Object.entries(
      counts,
    )
      .map(([key, n]) => `- ${key}: ${n}`)
      .join(
        "\n",
      )}\n\n${journal.endReason ?? "진행 중"}\n\nrun.json: 현재 기록 / experiments.jsonl: 개발 실험 / snapshots/: 변경 이력.\n최종 결과는 finalEvaluation에 분리되며 설계 입력에 사용하지 않습니다.\n`,
  );
  return root;
}

export async function syncJournals(
  base,
  {
    cookie = "",
    secret = "",
    runner = false,
    directory = DEFAULT_JOURNAL_DIR,
  } = {},
) {
  let after = "",
    runs = 0,
    experiments = 0;
  do {
    const url = new URL("/api/strategy-generation", base);
    url.searchParams.set("journal", "1");
    if (runner) url.searchParams.set("source", "runner");
    if (after) url.searchParams.set("after", after);
    const response = await fetch(url, {
      headers: {
        cookie,
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
          ? {
              "x-vercel-protection-bypass":
                process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
            }
          : {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`Research journal export HTTP ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page.journals))
      throw new Error("Server does not support research journal export");
    for (const journal of page.journals) {
      await writeJournal(journal, directory);
      runs++;
      experiments += journal.experiments.length;
    }
    after = page.next;
  } while (after);
  return { runs, experiments, directory };
}

export async function loadResearchCookie(base) {
  const path = join(
    DEFAULT_JOURNAL_DIR,
    `session-${hash(new URL(base).origin)}.json`,
  );
  return readFile(path, "utf8")
    .then((body) => JSON.parse(body).cookie)
    .catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
}

export async function saveResearchCookie(base, cookie) {
  await mkdir(DEFAULT_JOURNAL_DIR, { recursive: true, mode: 0o700 });
  const path = join(
    DEFAULT_JOURNAL_DIR,
    `session-${hash(new URL(base).origin)}.json`,
  );
  await atomic(path, JSON.stringify({ cookie }));
}
