/**
 * Stage 5: distil the lessons of the runs that ended before lessons existed, one call per market over the whole playbook.
 * docs/ct.md「연구 교훈」. The owner runs this; an agent never passes --run on its own.
 *
 *   node --env-file-if-exists=.dev.vars --experimental-strip-types --no-warnings scripts/research/ct-lessons-backfill.ts [--market=crypto|stock|both]
 *        [--run] [--max-usd=0.50] [--max-input-chars=100000] [--owner=<owner id>] [--out=docs/research/ct-lessons-backfill-YYYY-MM-DD.md]
 *
 * Default is a DRY RUN: the database is opened read-only, no model is called, nothing is written. It prints, per market, the
 * number of playbook items per family, the share classified `other`, the token and cost estimate of the one call, and which
 * families the server would allow to be called `dead`. --run calls the model (cheap class, gpt-6-luna) within --max-usd,
 * validates every answer with the same server checks as a live run, writes the lessons with source "backfill", and prints
 * (and with --out writes) a table of every lesson with its evidence for a human to check.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
register("../../tests/helpers/slot-test-loader.mjs", import.meta.url);

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"]; }));
const RUN = args.run === "true";
const MAX_USD = Number(args["max-usd"] ?? 0.5);
const MAX_INPUT_CHARS = Number(args["max-input-chars"] ?? 100_000);
const markets = args.market === "crypto" || args.market === "stock" ? [args.market] : ["crypto", "stock"];
const file = join(process.env.QQUAN_DATA_DIR || join(homedir(), ".qquan"), "state", "research.sqlite");
const sqlite = new DatabaseSync(file, RUN ? {} : { readOnly: true });
if (RUN) sqlite.exec("PRAGMA busy_timeout=10000");

class Statement {
  sql: string;
  values: unknown[];
  constructor(sql: string, values: unknown[] = []) { this.sql = sql; this.values = values; }
  bind(...values: unknown[]) { return new Statement(this.sql, values); }
  async run() {
    if (!RUN) throw new Error("dry run: no writes");
    return { meta: { changes: Number(sqlite.prepare(this.sql).run(...(this.values as never[])).changes) } };
  }
  async first() { return sqlite.prepare(this.sql).get(...(this.values as never[])) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...(this.values as never[])) }; }
  async raw() { return (await this.all()).results.map((r) => Object.values(r as object)); }
}
const env: Record<string, unknown> = { DB: { prepare: (s: string) => new Statement(s), batch: async (ss: Statement[]) => Promise.all(ss.map((s) => s.run())) } };
for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) if (process.env[k]) env[k] = process.env[k];
(globalThis as Record<string, unknown>).__strategyTestEnv = env;
(globalThis as Record<string, unknown>).__strategyTestHooks = { realLlm: RUN };

const lessons = await import("../../lib/ct-lessons.ts");
const { CT_FAMILIES, CT_FAMILY_TEXT, ctIdeaFamily } = await import("../../lib/ct-families.ts");
const { researchMaxTokens, RESEARCH_MODELS, researchModel } = await import("../../lib/strategy-generation-models.ts");
type Row = import("../../lib/ct-playbook.ts").PlaybookRow;

const owner = args.owner ?? (sqlite.prepare("SELECT owner_id FROM ct_playbook_runs WHERE owner_id<>'' ORDER BY recorded_at DESC LIMIT 1").get() as { owner_id: string } | undefined)?.owner_id;
if (!owner) throw new Error("owner id not found: pass --owner=");
const today = new Date().toISOString().slice(0, 10);
const model = RESEARCH_MODELS.ctLessons;
const rowsOf = (market: string) =>
  sqlite.prepare("SELECT * FROM ct_playbook WHERE market=? AND (owner_id=? OR owner_id='') AND comparable=1 ORDER BY recorded_at, id").all(market, owner) as unknown as Row[];
const lines: string[] = [];
const out = (s = "") => { lines.push(s); console.log(s); };

out(`# 소급 증류 ${RUN ? "실행" : "점검(dry run)"} · ${today}`);
out(`DB ${file} · 소유자 ${owner.slice(0, 8)} · 모델 ${model.model}(입력 $${model.input}/백만 · 출력 $${model.output}/백만) · 한도 $${MAX_USD.toFixed(2)} · 입력 상한 ${MAX_INPUT_CHARS.toLocaleString()}자${RUN ? "" : " · 모델 호출 0 · 쓰기 0"}`);

let spent = 0;
for (const market of markets) {
  const rows = rowsOf(market);
  out();
  out(`## ${market === "crypto" ? "코인" : "주식"} · 1분봉 항목 ${rows.length}개`);
  if (!rows.length) { out("항목 없음"); continue; }
  const byFamily = new Map<string, Row[]>(CT_FAMILIES.map((f) => [f, []]));
  for (const r of rows) byFamily.get(ctIdeaFamily(r))!.push(r);
  const other = byFamily.get("other")!.length;
  out(`\`other\` 비율 ${(other / rows.length * 100).toFixed(1)}% ${other / rows.length > 0.3 ? "· 30% 초과: 분류 규칙을 보강해야 합니다" : "(기준 30% 이하)"}`);
  out();
  out("| 계열 | 항목 | 서로 다른 구조 | 최고 등급 | dead 허용 |");
  out("| --- | --- | --- | --- | --- |");
  for (const f of CT_FAMILIES) {
    const items = byFamily.get(f)!;
    if (!items.length) continue;
    const shapes = new Set(items.map((r) => r.structure)).size;
    const best = items.reduce((m, r) => Math.max(m, lessons.GRADE_RANK[r.grade] ?? 0), 0);
    out(`| ${CT_FAMILY_TEXT[f]} (${f}) | ${items.length} | ${shapes} | ${Object.entries(lessons.GRADE_RANK).find(([, v]) => v === best)![0]} | ${lessons.ctDeadAllowed(items) ? "가능" : "불가"} |`);
  }
  const current = new Map<import("../../lib/ct-families.ts").CTFamily, import("../../lib/ct-lessons.ts").LessonRow>();
  for (const l of sqlite.prepare("SELECT * FROM ct_playbook_lessons WHERE market=? AND owner_id=? ORDER BY recorded_at, id").all(market, owner) as unknown as import("../../lib/ct-lessons.ts").LessonRow[]) current.set(l.family, l);
  const { prompt, refs } = lessons.ctLessonsPromptRefs({ market, newRows: rows, priorRows: [], current: [...current.values()], noEdgeReason: null, eyeVerdict: null, maxChars: MAX_INPUT_CHARS });
  const outTokens = researchMaxTokens("ctLessons");
  const schemaChars = JSON.stringify((await import("zod")).z.toJSONSchema(lessons.ctLessonsOutputSchema)).length;
  // The ledger reserves (chars + schema + 4000) × 2 tokens at the input price and the full output allowance; the estimate assumes ~1 token per 1.5 Korean characters and a 3,000-token answer.
  const reserve = (((prompt.length + schemaChars + 4000) * 2) * model.input + outTokens * model.output) / 1_000_000;
  const estimate = ((prompt.length / 1.5) * model.input + 3000 * model.output) / 1_000_000;
  out();
  out(`입력 ${prompt.length.toLocaleString()}자(약 ${Math.round(prompt.length / 1.5).toLocaleString()}토큰) · 출력 상한 ${outTokens.toLocaleString()}토큰 · 예상 비용 $${estimate.toFixed(4)} · 한도 확인용 예약 $${reserve.toFixed(4)}${prompt.length >= MAX_INPUT_CHARS - 50 ? " · 입력 상한에 닿아 오래된 항목/긴 문장이 잘렸습니다" : ""}`);
  if (!RUN) continue;
  if (spent + reserve > MAX_USD) { out(`한도 $${MAX_USD.toFixed(2)} 초과 가능: 이 시장은 실행하지 않습니다`); continue; }

  // The real call (the shared structured-output path: same model, streaming, usage accounting as a live run).
  sqlite.exec(lessons.CT_LESSONS_SCHEMA.map((s) => `${s};`).join("\n"));
  const { generationCall } = await import("../../lib/strategy-generation-llm.ts");
  const started = Date.now();
  const result = await generationCall(owner, "ctLessons", lessons.ctLessonsOutputSchema, prompt, { ct: true, maxOutputTokens: outTokens });
  spent += result.costUsd;
  out(`호출 완료 · ${((Date.now() - started) / 1000).toFixed(1)}초 · 입력 ${result.usage.input_tokens ?? "?"}토큰 · 출력 ${result.usage.output_tokens ?? "?"}토큰 · 비용 $${result.costUsd.toFixed(4)} (누적 $${spent.toFixed(4)})`);
  const runId = `backfill:${market}:${today}`;
  const check = lessons.ctValidateLessons(result.data, {
    ownerId: owner, market, runId, rows, newIds: new Set(rows.map((r) => r.id)), current, model: researchModel("ctLessons").model, source: "backfill", refs,
  });
  // A second attempt of the same day's backfill replaces its own earlier rows (never any other run's).
  sqlite.prepare("DELETE FROM ct_playbook_lessons WHERE run_id=? AND source='backfill'").run(runId);
  // Written through the same function a live run uses (a write failure here is fatal: nothing is half-recorded silently).
  await lessons.ctRecordLessons(check.rows);
  out();
  out(`저장된 교훈 ${check.rows.length}개 · 거부 ${check.rejected.length}개${check.rejected.length ? ` (${check.rejected.map((r) => `${r.family}:${r.reason}`).join(", ")})` : ""} · dead를 weak로 낮춤 ${check.downgraded.length}개${check.downgraded.length ? ` (${check.downgraded.join(", ")})` : ""}`);
  out();
  out("| 계열 | 판정 | 원인 | 교훈 | 아직 안 본 변형 | 근거 항목 수 |");
  out("| --- | --- | --- | --- | --- | --- |");
  for (const l of check.rows) out(`| ${l.family} | ${l.verdict} | ${l.cause} | ${l.lesson} | ${l.next_to_try ?? "—"} | ${(JSON.parse(l.evidence_ids) as string[]).length} |`);
  out();
  out("### 근거 대조(사람이 확인)");
  for (const l of check.rows) {
    const ids = JSON.parse(l.evidence_ids) as string[];
    const items = rows.filter((r) => ctIdeaFamily(r) === l.family);
    const shapes = new Set(items.map((r) => r.structure)).size;
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    out(`- **${l.family}** (${l.verdict}) · 계열 항목 ${items.length}개 · 서로 다른 구조 ${shapes}개 · 최고 등급 ${items.reduce((m, r) => (lessons.GRADE_RANK[r.grade] > m.rank ? { rank: lessons.GRADE_RANK[r.grade], grade: r.grade } : m), { rank: -1, grade: "" }).grade} · 근거 id 실존 ${ids.length - missing.length}/${ids.length} · 수치 패턴 ${lessons.MEASUREMENT.test(`${l.lesson} ${l.next_to_try ?? ""}`) ? "있음(!)" : "없음"}`);
  }
}
if (RUN) out(`\n총 모델 비용 $${spent.toFixed(4)} / 한도 $${MAX_USD.toFixed(2)}`);
if (RUN && args.out) writeFileSync(args.out, lines.join("\n") + "\n");
