// Stage 5 (2026-10-15): family lessons, the coverage map, the end-of-run distillation with its own reserve,
// lessonChecks on submit_candidates, reviewer inputs, the lessons tab model, and stage-4 contracts unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { z } from "zod";
import { ctState, candidate, bars, spec as specFixture } from "./helpers/ct-fixture.mjs";
import { STAGE3_POLICY, STAGE4_POLICY, STAGE5_POLICY } from "./helpers/ct-policies.mjs";
import { CT_POLICY, ctHash, ctPolicyForNewContract, ctSessionPolicy } from "../lib/ct-spec.ts";
import { CT_FAMILIES, ctCandidateFamilies, ctIdeaFamily, ctParseSignature, ctStructuralFamily } from "../lib/ct-families.ts";
import { researchMaxTokens, researchModel, CT_ROLES, RESEARCH_MODELS } from "../lib/strategy-generation-models.ts";
import { ctSessionContext, ctSubmissionSchema, ctSubmissionSchemaStage5, CT_DESIGNER_SYSTEM_STAGE5 as CT_DESIGNER_SYSTEM, CT_DESIGNER_SYSTEM_STAGE4 } from "../lib/ct-research.ts";
import { lessonsPanelModel, playbookAnchor } from "../lib/ct-lessons-view.ts";
register("./helpers/slot-test-loader.mjs", import.meta.url);

const sqlite = new DatabaseSync(":memory:");
class Statement {
  constructor(sql, values = []) { this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sql, values); }
  async run() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
  async raw() { return (await this.all()).results.map(Object.values); }
}
globalThis.__strategyTestEnv = {
  OPENAI_API_KEY: "test-openai", ANTHROPIC_API_KEY: "test-anthropic",
  DB: { prepare: (s) => new Statement(s), batch: async (ss) => Promise.all(ss.map((s) => s.run())) },
};
const fail = () => { throw new Error("unexpected structured call"); };
globalThis.__strategyTestHooks = { call: fail, turn: fail };
const research = await import("../lib/ct-research-store.ts");
const store = await import("../lib/strategy-generation-store.ts");
const flow = await import("../lib/strategy-generation.ts");
const playbook = await import("../lib/ct-playbook.ts");
const lessons = await import("../lib/ct-lessons.ts");
await research.ensureCTSchema();

/** The conversion the tool definitions use. */
const schemaJson = (schema) => z.toJSONSchema(schema, { io: "input" });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);
const sha = (x) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const FIXTURE = JSON.parse(readFileSync(new URL("./helpers/ct-playbook-rows.json", import.meta.url), "utf8"));
const COMPARABLE = FIXTURE.filter((r) => r.comparable === 1);
const now = () => new Date().toISOString();
const MANAGED = { stop: { type: "atr", value: 2 }, trail: { type: "swing_low", value: 0.1, activateR: 1 }, maxHoldBars: 30 };

/** A finished run the way advanceCTResearch leaves it, with ideas of every grade; numbers that must never reach a lesson are distinctive. */
function finishedRun(id, over = {}) {
  const ct = ctState();
  ct.phase = "done";
  ct.endReason = "설계자 판단: 비용 후 우위 미발견 · 통과 전략 없음";
  const q = (queryId, features) => ({ queryId, session: 0, at: now(), from: ct.contract.fromMs, to: ct.contract.trainingToMs, stages: [], features, horizons: [5], events: 41, uniqueDays: 9, summary: "이벤트 41건 · 순평균 12.346%" });
  ct.queries = [
    q("qa", [{ feature: "return_pct", timeframe: 1 }, { feature: "volume_ratio", timeframe: 1 }]),
    q("qb", [{ feature: "prior_high_distance_pct", timeframe: 12 }, { feature: "volume_ratio", timeframe: 12 }]),
    q("qc", [{ feature: "vwap_distance_pct", timeframe: 1 }]),
    q("qd", [{ feature: "return_pct", timeframe: 60 }, { feature: "range_position", timeframe: 12 }]),
  ];
  const rej = (hypothesis, mechanism, evidence) => ({ hypothesis, mechanism, evidence, result: "기준선 대비 +12.346%p였으나 최종 99.9% 이벤트 41건 p=0.01" });
  ct.sessions = [{ index: 0, kind: "design", status: "submitted", startedAt: now(), turns: 3, toolCalls: 4, screens: 0, messages: 4,
    submission: { candidates: 0, accepted: 0, duplicates: 0, noEdgeReason: "왕복 비용 0.31%를 넘는 조건이 없었다. 최종 99.9%는 없다.", rejectedHypotheses: [
      rej("1시간 -1%와 거래량 2배 동반 투매 뒤 반등", "투매 소진", ["qa"]),
      rej("4시간 급락 뒤 과매도 반등", "되돌림", ["qa"]),
      rej("24시간 고점 돌파와 거래량", "숏 커버 유입", ["qb"]),
      rej("VWAP 아래 이탈 뒤 재탈환", "공정가치 회복", ["qc"]),
      rej("일봉 상승 추세에서 눌림 매수", "추세 속 차익실현", ["qd"]),
    ] } }];
  Object.assign(ct, over.ct ?? {});
  return { id, ownerId: "owner", slot: "open", status: "completed", stageIndex: 0, createdAt: now(), updatedAt: now(), from: "a", to: "b", capitalUsd: 1, budgetUsd: 8, costUsd: 0.2, brief: "", events: [], calls: [], universe: ["KRW-BTC"], ct, ...(over.job ?? {}) };
}
/** Adds a screened candidate, a developed trial and a final-consumed trial carrying distinctive numbers. */
function withCandidates(job, kinds = ["screened", "trial"]) {
  const ct = job.ct;
  const s = (name, exit) => ({ ...structuredClone(specFixture()), name, ...(exit ? { exit } : {}) });
  const result = (net) => ({ netReturnPct: net, meanDailyReturnPct: 0.01, positiveDayPct: 40, worstDayPct: -1, maxDrawdownPct: 3, winRatePct: 40, payoff: 1, trades: [], tradeCount: 33, emptyDays: 0, days: [] });
  if (kinds.includes("screened"))
    ct.screened = [{ id: `${job.id}:0`, hash: "h0", at: now(), session: 0, candidate: { ...candidate(), spec: s("고점 돌파 거래량") }, training: result(-0.52), reasons: ["학습 순수익 -0.52% 미달", "거래 수 11건 < 20건"] }];
  if (kinds.includes("trial"))
    ct.trials = [{ ...candidate(), spec: s("돌파 후 눌림", MANAGED), id: `${job.id}:1`, hash: "h1", at: now(), training: result(1.5), development: result(12.346), stress: result(1), delayed: result(1), sensitivity: [], reasons: ["개발 구간 일평균 수익 ≤ 0"] }];
  return job;
}
const INSERT_RUN = async (job) => {
  await store.createGenerationJob(job);
  await playbook.recordCTPlaybook(job);
  return job;
};

/* ------------------------------------------------------------------ 2.1 families */

test("families: one deterministic family per stored row, `other` under 30%, and the rules read the idea's head", () => {
  const once = COMPARABLE.map(ctIdeaFamily);
  const again = [...COMPARABLE].reverse().map(ctIdeaFamily).reverse();
  assert.deepEqual(once, again, "no state: the same row gets the same family in any order");
  assert.equal(once.length, COMPARABLE.length);
  assert.ok(once.every((f) => CT_FAMILIES.includes(f)));
  const other = once.filter((f) => f === "other").length / once.length;
  assert.ok(other <= 0.3, `other ${(other * 100).toFixed(1)}%`);
  assert.ok(new Set(once).size >= 7, "the real history spans most families");
  const of = (text) => ctIdeaFamily({ mechanism: text, structure: "(구조 미기록)" });
  assert.equal(of("2시간 -2% 급락 저점권 평균회귀(단독 규칙) — 강제청산 소진"), "mean_reversion", "a liquidation named only in the why does not move the family");
  assert.equal(of("1분봉 10봉 -1.2%·거래량 3배 급락(청산 캐스케이드) 반등 — 연쇄 청산"), "liquidation_cascade");
  assert.equal(of("거래량 2배를 동반한 24시간 고점 돌파 모멘텀 — 숏 손절"), "breakout");
  assert.equal(of("변동성 수축 후 고점 돌파 — 스퀴즈 후 확장"), "volatility_regime");
  assert.equal(of("VWAP 아래 -1% 이탈 뒤 VWAP 재탈환 — 공정가치"), "levels_gaps");
  assert.equal(of("UTC 시간대 계절성: 특정 블록에 진입 — 세션 수급"), "time_seasonality");
  assert.equal(of("전일 급락 다음 날 보유 — 일간 과잉 반응"), "holding_overnight");
  assert.equal(of("상위 시간대(12분봉 SMA) 위에서 15분 눌림 매수 — 추세 중 일시 눌림"), "trend_following", "상위 시간대 is a filter, not the clock");
  assert.equal(of("직전 특징(ATR, VWAP)으로 움직임을 미리 고를 수 있다 — 변동성"), "other");
  // Structure decides only when the words do not.
  assert.equal(ctIdeaFamily({ mechanism: "새 아이디어 — ?", structure: "vwap_distance_pct(1m) · return_pct(1m)" }), "levels_gaps");
  assert.equal(ctIdeaFamily({ mechanism: "새 아이디어 — ?", structure: "swing_low_distance_pct(12m)" }), "mean_reversion");
  assert.equal(ctIdeaFamily({ mechanism: "새 아이디어 — ?", structure: "return_pct(1m)" }), "other");
});

test("families: the structural family reads conditions only, a ledger signature parses back into them, and a candidate has both", () => {
  assert.equal(ctStructuralFamily([{ feature: "prior_high_distance_pct", timeframe: 12, op: "gte" }, { feature: "volume_ratio", timeframe: 12, op: "gte" }]), "breakout");
  assert.equal(ctStructuralFamily([{ feature: "return_pct", timeframe: 12, op: "lte" }, { feature: "range_position", timeframe: 12, op: "lte" }]), "mean_reversion");
  assert.equal(ctStructuralFamily([{ feature: "sma_distance_pct", timeframe: 12, op: "gte" }, { feature: "return_pct", timeframe: 1, op: "gte" }]), "trend_following");
  assert.equal(ctStructuralFamily([{ feature: "atr_percentile", timeframe: 60, op: "lte" }, { feature: "return_pct", timeframe: 1, op: "gte" }]), "volatility_regime");
  assert.equal(ctStructuralFamily([{ feature: "vwap_distance_pct", timeframe: 1, op: "lte" }]), "levels_gaps");
  const sig = ctParseSignature("return_pct|1|lte|pct&volume_ratio|1|gte|pct>vwap_distance_pct|1|lte|atr|W");
  assert.equal(sig.kind, "conditions");
  assert.equal(sig.window, true);
  assert.deepEqual(sig.uses.map((u) => `${u.feature}:${u.timeframe}:${u.op}:${u.unit}`), ["return_pct:1:lte:pct", "volume_ratio:1:gte:pct", "vwap_distance_pct:1:lte:atr"]);
  assert.deepEqual(ctParseSignature("contrast|day_range_position|1|pct|q2|k4m1.5h240c1|losers").uses, [{ feature: "day_range_position", timeframe: 1, unit: "pct" }]);
  const diag = ctParseSignature("diagnose|return_pct|12|lte|pct&volume_ratio|12|gte|pct|time_of_day|08-12");
  assert.equal(diag.kind, "diagnose");
  assert.equal(diag.uses.length, 2);
  assert.equal(ctParseSignature("label|k4|m1.5|h240|c1").kind, "label");
  assert.equal(ctParseSignature("blind|abc").kind, "blind");
  // A candidate: the family its playbook row will carry (text + structure) and the structural one; a name cannot move the structural one.
  const c = candidate();
  const f = ctCandidateFamilies(c);
  assert.equal(f.primary, "breakout");
  assert.equal(f.structural, "breakout");
  const renamed = ctCandidateFamilies({ ...c, spec: { ...c.spec, name: "다음 날 보유 전략" } });
  assert.equal(renamed.primary, "holding_overnight");
  assert.equal(renamed.structural, "breakout");
  assert.deepEqual(renamed.all.sort(), ["breakout", "holding_overnight"]);
});

/* ------------------------------------------------------------------ 2.2 coverage */

test("coverage: a signature a rerun repeated counts once, untouched vocabulary shows, and the map holds counts only", async () => {
  sqlite.exec("DELETE FROM ct_playbook; DELETE FROM ct_playbook_runs; DELETE FROM strategy_generation_runs");
  const sigBreakout = "prior_high_distance_pct|12|gte|pct&volume_ratio|12|gte|pct";
  const a = withCandidates(finishedRun("cov-a"));
  a.ct.tests = { signatures: { [sigBreakout]: 2, "return_pct|60|lte|atr&volume_ratio|1|gte|pct": 1, "contrast|day_range_position|1|pct|q0|k4m1.5h240c1|losers": 1, "label|k4|m1.5|h240|c1": 1 } };
  const b = finishedRun("cov-b");
  b.ct.tests = { signatures: { [sigBreakout]: 5, "atr_pct|60|gte|pct>return_pct|1|gte|pct|W": 1 } };
  await INSERT_RUN(a);
  await INSERT_RUN(b);
  const cov = await lessons.ctCoverage("owner", "crypto", "new-run");
  const breakout = cov.families.find((f) => f.family === "breakout");
  assert.equal(breakout.tests, 1, "the same signature in two runs, and called 2 and 5 times, is one test");
  assert.ok(breakout.ideas >= 2);
  assert.equal(cov.families.find((f) => f.family === "mean_reversion").tests, 1);
  assert.equal(cov.families.find((f) => f.family === "volatility_regime").tests, 1);
  assert.equal(cov.families.find((f) => f.family === "time_seasonality").tests, null, "a signature has no clock: its tests cannot be attributed, and the map says so instead of printing 0");
  assert.equal(cov.families.find((f) => f.family === "liquidation_cascade").tests, null);
  assert.equal(cov.basis.signatures, 4 + 1, "label and contrast cells are signatures too, counted once across both runs (the shared one once)");
  const v = cov.vocabulary;
  assert.ok(v.featureCells.untouched.includes("contraction_ratio(1440m)"), "never used anywhere");
  assert.ok(!v.featureCells.untouched.includes("vwap_distance_pct(1m)"), "used by a rejected hypothesis' structure");
  assert.ok(!v.featureCells.untouched.includes("day_range_position(1m)"), "examined in a contrast cell");
  assert.ok(!v.featureCells.untouched.includes("atr_pct(60m)"), "used in a ledger signature");
  assert.equal(v.featureCells.untouched.length + v.featureCells.moreUntouched, v.featureCells.total - v.featureCells.touched);
  assert.ok(v.featureCells.untouched.length <= lessons.COVERAGE_UNTOUCHED_LIMIT);
  assert.ok(!v.atrUnit.untouched.includes("return_pct"), "tried with an ATR unit in a signature");
  assert.ok(v.atrUnit.untouched.includes("sma_distance_pct"), "never tried with an ATR unit");
  assert.equal(v.entryWindow.used, true, "a windowed signature");
  assert.ok(!v.managedExit.untouched.includes("stop.atr") && !v.managedExit.untouched.includes("trail.swing_low"), "the developed trial's managed exit");
  assert.ok(v.managedExit.untouched.includes("target.r") && v.managedExit.untouched.includes("breakeven"));
  assert.ok(cov.emptyCells.includes("liquidation_cascade × 관리형 청산"));
  // Counts only: no number in the map is anything but a non-negative integer, and no key names a performance figure.
  const numbers = [];
  const walk = (x, path) => {
    if (typeof x === "number") numbers.push([path, x]);
    else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${path}[${i}]`));
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) { assert.doesNotMatch(k, /return|pct|profit|sharpe|pvalue|netReturn/i, k); walk(y, `${path}.${k}`); }
  };
  walk(cov, "coverage");
  assert.ok(numbers.length > 10);
  for (const [path, n] of numbers) assert.ok(Number.isInteger(n) && n >= 0, `${path}=${n}`);
  assert.doesNotMatch(JSON.stringify(cov), /12\.346|99\.9|0\.52/);
  assert.match(cov.note, /목표도 아닙니다/);
});

/* ------------------------------------------------------------------ 2.3 distillation */

test("distillation input: every number masked, no detail, no thinking, no reviewer text; a lesson's evidence must be real", async () => {
  sqlite.exec("DELETE FROM ct_playbook; DELETE FROM ct_playbook_runs; DELETE FROM strategy_generation_runs; DELETE FROM ct_playbook_lessons");
  const job = withCandidates(finishedRun("dist-1"));
  job.ct.final = { netReturnPct: 99.9, trades: [], days: [] };
  job.ct.finalConsumed = true;
  job.ct.riskReview = { approved: true, summary: "위험 검토 요약 문장 SECRET-REVIEW", blockers: [], cautions: [] };
  const rows = playbook.ctPlaybookRows(job).filter((r) => r.comparable === 1);
  assert.ok(rows.some((r) => /12\.346/.test(r.detail)), "the playbook row itself keeps its development number (the leak rule hides it from other runs)");
  assert.ok(rows.length >= 7);
  const prompt = lessons.ctLessonsPrompt({ market: "crypto", newRows: rows, priorRows: [], current: [], noEdgeReason: job.ct.sessions[0].submission.noEdgeReason, eyeVerdict: "inconclusive", maxChars: 60_000 });
  for (const leak of ["12.346", "12.35", "99.9", "0.52", "41건", "p=0.01", "SECRET-REVIEW", "thinking", "\"detail\""]) assert.ok(!prompt.includes(leak), `leaked ${leak}`);
  assert.match(prompt, /"new":true/);
  assert.match(prompt, /Write a lesson ONLY for a family that has at least one item with new: true/);
  assert.match(prompt, /No number of any kind/);
  assert.match(prompt, /cause: no_edge_after_cost = after costs the result was not above its baseline/);
  assert.match(prompt, /Write "계열" for family in Korean/);
  const facts = JSON.parse(prompt.slice(prompt.indexOf('{"market"'))).familyFacts;
  const breakoutFacts = facts.find((f) => f.family === "breakout");
  assert.ok(breakoutFacts.candidates >= 2 && breakoutFacts.managedExitCandidates === 1, "the fixture has one fixed-exit and one managed-exit breakout candidate");
  assert.ok(facts.every((f) => Object.values(f).every((v) => typeof v === "string" || Array.isArray(v) || Number.isInteger(v))), "counts and cell names only");
  const withRefs = lessons.ctLessonsPromptRefs({ market: "crypto", newRows: rows, priorRows: [], current: [], noEdgeReason: job.ct.sessions[0].submission.noEdgeReason, eyeVerdict: "inconclusive", maxChars: 60_000 });
  assert.equal(withRefs.prompt, prompt);
  const items = JSON.parse(prompt.slice(prompt.indexOf('{"market"'))).items;
  assert.deepEqual(items.map((i) => i.ref), rows.map((_, k) => `i${k + 1}`), "short refs, in order");
  assert.deepEqual([...withRefs.refs.values()], rows.map((r) => r.id), "each ref maps back to its playbook row");
  assert.ok(!prompt.includes(rows[0].id), "the model never has to copy a long id");
  assert.ok(items.every((i) => CT_FAMILIES.includes(i.family) && typeof i.reason === "string"));
  // Deterministic: the same inputs give the same prompt (the paid response is keyed on it, so a resume reuses it).
  const again = lessons.ctLessonsPrompt({ market: "crypto", newRows: playbook.ctPlaybookRows(job, Date.now() + 5000).filter((r) => r.comparable === 1), priorRows: [], current: [], noEdgeReason: job.ct.sessions[0].submission.noEdgeReason, eyeVerdict: "inconclusive", maxChars: 60_000 });
  assert.equal(again, prompt);
  // The input cap is a hard cap: older prior items go first.
  const prior = COMPARABLE.map((r) => ({ ...r, run_id: "old" }));
  const small = lessons.ctLessonsPrompt({ market: "crypto", newRows: rows, priorRows: prior, current: [], noEdgeReason: null, eyeVerdict: null, maxChars: 12_000 });
  assert.ok(small.length <= 12_000);
  assert.ok(small.includes('"ref":"i1"'), "the run's own items come first and survive the cap");
});

function ctx(overrides = {}) {
  const rows = COMPARABLE.filter((r) => r.market === "crypto").map((r) => ({ ...r, owner_id: "owner" }));
  return { ownerId: "owner", market: "crypto", runId: "run-x", rows, newIds: new Set(rows.map((r) => r.id)), current: new Map(), model: "gpt-6-luna", source: "research", now: 1_000, ...overrides };
}
const ids = (family, c = ctx()) => c.rows.filter((r) => ctIdeaFamily(r) === family).map((r) => r.id);
const answer = (family, over = {}, c = ctx()) => ({ lessons: [{ family, verdict: "dead", cause: "no_edge_after_cost", lesson: "이 판에서는 급락 뒤 반등이 비용을 넘지 못했다.", nextToTry: "청산 구조만 바꾼 변형은 아직 보지 않았다.", evidence: ids(family, c).slice(0, 3), ...over }] });

test("lesson validation: evidence must exist, no measurement-shaped text, dead needs the items, new evidence is required", () => {
  const c = ctx();
  const ok = lessons.ctValidateLessons(answer("mean_reversion"), c);
  assert.equal(ok.rows.length, 1);
  assert.deepEqual(ok.rejected, []);
  assert.equal(ok.rows[0].verdict, "dead", "28 mean-reversion ideas of 12+ structures, none beyond development_failed");
  assert.equal(ok.rows[0].id, "run-x:crypto:mean_reversion");
  assert.equal(JSON.parse(ok.rows[0].evidence_ids).length, 3);
  // An evidence id that is not a playbook row discards the lesson.
  assert.deepEqual(lessons.ctValidateLessons(answer("mean_reversion", { evidence: ["no-such-row", ...ids("mean_reversion").slice(0, 1)] }), c).rejected, [{ family: "mean_reversion", reason: "unknown_evidence" }]);
  assert.deepEqual(lessons.ctValidateLessons(answer("mean_reversion", { evidence: [] }), c).rejected, [{ family: "mean_reversion", reason: "unknown_evidence" }]);
  // Measurement-shaped text is rejected: percent, decimal, signed, a count with a unit, p, a multiple. Plain "4시간" passes.
  for (const bad of ["반등이 평균 0.3%에 그쳤다.", "수익률이 -1 이하였다.", "이벤트 41건에서 우위가 없었다.", "p<0.05를 넘지 못했다.", "비용의 3배를 못 넘었다.", "순수익 12.5였다."])
    assert.deepEqual(lessons.ctValidateLessons(answer("mean_reversion", { lesson: bad }), c).rejected, [{ family: "mean_reversion", reason: "numbers" }], bad);
  assert.deepEqual(lessons.ctValidateLessons(answer("mean_reversion", { nextToTry: "한도를 3배로 넓힌 변형" }), c).rejected, [{ family: "mean_reversion", reason: "numbers" }]);
  assert.equal(lessons.ctValidateLessons(answer("mean_reversion", { lesson: "4시간 이동평균 아래 급락은 비용을 넘지 못했다." }), c).rows.length, 1);
  assert.deepEqual(lessons.ctValidateLessons(answer("mean_reversion", { lesson: "가".repeat(201) }), c).rejected, [{ family: "mean_reversion", reason: "too_long" }]);
  assert.deepEqual(lessons.ctValidateLessons(answer("mean_reversion", { lesson: "  " }), c).rejected, [{ family: "mean_reversion", reason: "empty" }]);
  // dead needs three distinct ideas, two feature structures and nothing beyond development_failed: otherwise it is lowered, not refused.
  const few = ctx({ rows: ctx().rows.filter((r) => ctIdeaFamily(r) !== "liquidation_cascade" || ids("liquidation_cascade").slice(0, 2).includes(r.id)) });
  const lowered = lessons.ctValidateLessons(answer("liquidation_cascade", {}, few), few);
  assert.equal(lowered.rows[0].verdict, "weak");
  assert.deepEqual(lowered.downgraded, ["liquidation_cascade"]);
  const oneShape = ["a", "b", "c"].map((n, i) => ({ ...ctx().rows[0], id: `x${i}`, mechanism: `급락 반등 변형 ${n} — 투매`, structure: "return_pct(1m) · volume_ratio(1m)", grade: "rejected_in_training" }));
  assert.equal(lessons.ctDeadAllowed(oneShape), false, "variants of one structure are one mechanism");
  assert.equal(lessons.ctDeadAllowed([...oneShape, { ...oneShape[0], id: "x9", mechanism: "다른 아이디어 — 반등", structure: "range_position(12m)" }]), true);
  assert.equal(lessons.ctDeadAllowed([...oneShape, { ...oneShape[0], id: "x8", mechanism: "다른 아이디어 — 반등", structure: "range_position(12m)", grade: "failed_final" }]), false, "a family with a final-split result is not dead");
  // A lesson for a family with no new item is ignored: a model cannot rewrite old lessons without new evidence.
  const stale = ctx({ newIds: new Set(ids("breakout")) });
  assert.deepEqual(lessons.ctValidateLessons(answer("mean_reversion", { verdict: "weak" }, stale), stale).rejected, [{ family: "mean_reversion", reason: "no_new_evidence" }]);
  assert.equal(lessons.ctValidateLessons(answer("breakout", {}, stale), stale).rows.length, 1);
  // The model cites refs; the server maps them back (an unknown ref discards the lesson), and "가족" reads 계열.
  const refs = new Map([["i1", ids("mean_reversion")[0]], ["i2", ids("mean_reversion")[1]]]);
  const viaRefs = lessons.ctValidateLessons(answer("mean_reversion", { evidence: ["i1", "i2"], lesson: "급락 뒤 반등은 가족 전체가 비용을 못 넘었다." }), { ...c, refs });
  assert.deepEqual(JSON.parse(viaRefs.rows[0].evidence_ids), [ids("mean_reversion")[0], ids("mean_reversion")[1]]);
  assert.equal(viaRefs.rows[0].lesson, "급락 뒤 반등은 계열 전체가 비용을 못 넘었다.");
  assert.deepEqual(lessons.ctValidateLessons(answer("mean_reversion", { evidence: ["i1", "i99"] }), { ...c, refs }).rejected, [{ family: "mean_reversion", reason: "unknown_evidence" }]);
  // One lesson per family.
  const twice = { lessons: [...answer("breakout").lessons, ...answer("breakout").lessons] };
  const dup = lessons.ctValidateLessons(twice, c);
  assert.equal(dup.rows.length, 1);
  assert.deepEqual(dup.rejected, [{ family: "breakout", reason: "duplicate" }]);
  // The evidence is the union with the current lesson's, so an update never drops what the old lesson rested on.
  const first = lessons.ctValidateLessons(answer("breakout"), c).rows[0];
  const second = lessons.ctValidateLessons(answer("breakout", { evidence: ids("breakout").slice(3, 5), verdict: "weak" }), ctx({ current: new Map([["breakout", first]]), runId: "run-y" })).rows[0];
  assert.deepEqual(JSON.parse(second.evidence_ids), [...JSON.parse(first.evidence_ids), ...ids("breakout").slice(3, 5)]);
  assert.equal(second.id, "run-y:crypto:breakout");
});

test("distillation is idempotent, appends history, and cannot soften a lesson without new evidence", async () => {
  sqlite.exec("DELETE FROM ct_playbook; DELETE FROM ct_playbook_runs; DELETE FROM strategy_generation_runs; DELETE FROM ct_playbook_lessons");
  const run1 = withCandidates(finishedRun("dist-a"));
  await INSERT_RUN(run1);
  const rowsOf = (job) => playbook.ctPlaybookRows(job).filter((r) => r.comparable === 1);
  const mr = (job) => rowsOf(job).filter((r) => ctIdeaFamily(r) === "mean_reversion").map((r) => r.id);
  const calls = [];
  const ask = (response) => async (role, schema, prompt) => { calls.push({ role, prompt }); return schema.parse(response); };
  const opts = { maxInputChars: 60_000, model: "gpt-6-luna" };
  const first = await lessons.ctDistillRun(run1, ask({ lessons: [{ family: "mean_reversion", verdict: "weak", cause: "no_edge_after_cost", lesson: "급락 뒤 반등은 비용을 넘지 못했다.", nextToTry: null, evidence: mr(run1) }] }), opts);
  assert.equal(first.lessons, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "ctLessons");
  const rows = () => sqlite.prepare("SELECT * FROM ct_playbook_lessons ORDER BY id").all();
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].id, "dist-a:crypto:mean_reversion");
  // The same run distilled again: same id, no extra row.
  await lessons.ctDistillRun(run1, ask({ lessons: [{ family: "mean_reversion", verdict: "weak", cause: "regime_concentrated", lesson: "급락 뒤 반등은 특정 국면에만 있었다.", nextToTry: null, evidence: mr(run1) }] }), opts);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].cause, "regime_concentrated");
  assert.doesNotMatch(JSON.stringify(rows()), /99\.9|12\.346|0\.52/, "no stored lesson row carries a measured number");
  // A later run that adds no mean-reversion item cannot touch the lesson, however the model answers.
  const run2 = finishedRun("dist-b");
  run2.ct.sessions[0].submission.rejectedHypotheses = [{ hypothesis: "24시간 고점 돌파와 거래량", mechanism: "숏 커버", evidence: ["qb"], result: "차이 없음" }];
  await INSERT_RUN(run2);
  const second = await lessons.ctDistillRun(run2, ask({ lessons: [{ family: "mean_reversion", verdict: "unresolved", cause: "sample_too_small", lesson: "표본이 작아 알 수 없다.", nextToTry: null, evidence: mr(run1) }] }), opts);
  assert.deepEqual(second.rejected, [{ family: "mean_reversion", reason: "no_new_evidence" }]);
  assert.equal(second.lessons, 0);
  assert.equal(rows().length, 1, "the current lesson stands");
  // With a new item the update is allowed, and history stays: the old row is never deleted.
  const run3 = finishedRun("dist-c");
  run3.ct.sessions[0].submission.rejectedHypotheses = [{ hypothesis: "2시간 급락 뒤 반등 확인 진입", mechanism: "매도 소진", evidence: ["qa"], result: "차이 없음" }];
  await INSERT_RUN(run3);
  const third = await lessons.ctDistillRun(run3, ask({ lessons: [{ family: "mean_reversion", verdict: "unresolved", cause: "sample_too_small", lesson: "표본이 작아 아직 알 수 없다.", nextToTry: "반등 확인 뒤 진입하는 변형은 보지 않았다.", evidence: mr(run3) }] }), opts);
  assert.equal(third.lessons, 1);
  assert.deepEqual(rows().map((r) => r.run_id).sort(), ["dist-a", "dist-c"]);
  const current = await lessons.ctCurrentLessons("owner", "crypto");
  assert.equal(current.get("mean_reversion").run_id, "dist-c");
  assert.ok(JSON.parse(current.get("mean_reversion").evidence_ids).length > mr(run3).length, "evidence is the union with the earlier lesson's");
  // The prompt of run 3 carried the current lesson, and only run 3's ideas as new.
  const prompt = calls.at(-1).prompt;
  assert.match(prompt, /"currentLessons":\[\{"family":"mean_reversion"/);
  // A model failure or an empty run never throws.
  const failed = await lessons.ctDistillRun(run3, async () => { throw new Error("provider down"); }, opts);
  assert.match(failed.failed, /provider down/);
  const budget = await lessons.ctDistillRun(run3, async () => { throw new Error("연구 예산 $8 내 추가 호출 여유가 없습니다."); }, opts);
  assert.equal(budget.skipped, "reserve");
  const empty = await lessons.ctDistillRun({ id: "none", ownerId: "owner", ct: { ...ctState(), sessions: [] } }, ask({ lessons: [] }), opts);
  assert.equal(empty.skipped, "no_ideas");
});

/* ------------------------------------------------------------------ the reserve */

test("the distillation's reserve: designer and reviewers cannot spend it, the distillation can, and older contracts are unchanged", () => {
  const job = (policy, phase) => ({ budgetUsd: 8, ct: { phase, contract: { policy } } });
  // Stage 5: 8 × 0.65 for design, the full budget for review, both minus the withheld reserve; the distillation may reach the whole budget.
  near(flow.researchCeilingUsd(job(CT_POLICY, "design"), "ctDesigner"), 8 * 0.65 - 0.05);
  near(flow.researchCeilingUsd(job(CT_POLICY, "reflect"), "ctDesigner"), 8 * 0.65 - 0.05);
  near(flow.researchCeilingUsd(job(CT_POLICY, "risk_review"), "ctRiskReviewer"), 8 - 0.05);
  near(flow.researchCeilingUsd(job(CT_POLICY, "evidence_review"), "ctEvidenceReviewer"), 8 - 0.05);
  assert.equal(flow.researchCeilingUsd(job(CT_POLICY, "done"), "ctLessons"), 8);
  assert.equal(flow.researchCeilingUsd(job(CT_POLICY, "design"), "ctLessons"), 8, "the distillation never waits behind the review reserve");
  assert.ok(flow.researchCeilingUsd(job(CT_POLICY, "done"), "ctLessons") - flow.researchCeilingUsd(job(CT_POLICY, "evidence_review"), "ctEvidenceReviewer") >= CT_POLICY.lessonReserveUsd - 1e-12);
  // Earlier contracts: exactly the numbers they always had.
  near(flow.researchCeilingUsd(job(STAGE4_POLICY, "design"), "ctDesigner"), 8 * 0.65);
  near(flow.researchCeilingUsd(job(STAGE4_POLICY, "risk_review"), "ctRiskReviewer"), 8);
  near(flow.researchCeilingUsd(job(STAGE3_POLICY, "design"), "ctDesigner"), 8 * 0.65);
  // The model: the cheap extraction class, not the designer's company, no say in any verdict.
  assert.deepEqual([RESEARCH_MODELS.ctLessons.provider, RESEARCH_MODELS.ctLessons.model, RESEARCH_MODELS.ctLessons.effort], ["OpenAI", "gpt-6-luna", "low"]);
  assert.notEqual(researchModel("ctLessons").provider, researchModel("ctDesigner").provider);
  assert.ok(CT_ROLES.includes("ctLessons"));
  assert.equal(researchMaxTokens("ctLessons"), CT_POLICY.lessonMaxOutputTokens, "the output cap in the policy is the cap the call is made with");
  assert.ok(RESEARCH_MODELS.ctLessons.input <= 0.1 && RESEARCH_MODELS.ctLessons.output <= 0.5, "the same cheap class as the principle extraction");
  // A worst-case distillation (the full input cap, the full output cap) fits the reserve with room to spare.
  const worst = ((CT_POLICY.lessonMaxInputChars + 3000 + 4000) * 2 * RESEARCH_MODELS.ctLessons.input + CT_POLICY.lessonMaxOutputTokens * RESEARCH_MODELS.ctLessons.output) / 1_000_000;
  assert.ok(worst < CT_POLICY.lessonReserveUsd, `worst case ${worst}`);
});

/* ------------------------------------------------------------------ policy and contracts */

test("policy: a new contract carries stage 5 (and free bars), earlier ones are filled with nothing, QQUAN_CT_POLICY_VERSION still rebuilds them", () => {
  // Free bars (tool version 4) keep every stage-5 field; stage 5 itself is tool version 3.
  assert.equal(CT_POLICY.traderTools, 4);
  assert.equal(ctSessionPolicy({ policy: CT_POLICY }).toolsVersion, 4);
  assert.equal(ctSessionPolicy({ policy: CT_POLICY }).lessons, true);
  assert.equal(ctSessionPolicy({ policy: STAGE5_POLICY }).toolsVersion, 3);
  assert.equal(ctSessionPolicy({ policy: STAGE5_POLICY }).lessons, true);
  assert.equal(ctSessionPolicy({ policy: STAGE5_POLICY }).freeBars, false);
  for (const p of [STAGE3_POLICY, STAGE4_POLICY]) {
    const s = ctSessionPolicy({ policy: p });
    assert.equal(s.lessons, false);
    assert.equal(s.lessonReserveUsd, 0);
    assert.equal("lessonReserveUsd" in p, false);
  }
  const keep = process.env.QQUAN_CT_POLICY_VERSION;
  try {
    delete process.env.QQUAN_CT_POLICY_VERSION;
    assert.equal(ctPolicyForNewContract(), CT_POLICY, "default behaviour unchanged");
    process.env.QQUAN_CT_POLICY_VERSION = "3";
    assert.deepEqual(ctPolicyForNewContract(), STAGE5_POLICY);
    process.env.QQUAN_CT_POLICY_VERSION = "2";
    const two = ctPolicyForNewContract();
    assert.equal(two.traderTools, 2);
    assert.equal("lessonReserveUsd" in two, false);
    assert.deepEqual(ctSessionPolicy({ policy: two }), ctSessionPolicy({ policy: STAGE4_POLICY }));
    process.env.QQUAN_CT_POLICY_VERSION = "1";
    assert.equal(ctPolicyForNewContract().traderTools, 1);
    assert.equal(ctPolicyForNewContract().sessionMaxCharts, 32);
  } finally {
    if (keep === undefined) delete process.env.QQUAN_CT_POLICY_VERSION;
    else process.env.QQUAN_CT_POLICY_VERSION = keep;
  }
});

test("a stage-4 contract keeps its brief, tools and stable block byte for byte; stage 5 has its own and adds lessons after the playbook", () => {
  // Pinned from the code before this change (HEAD a9336d5) on the same fixture.
  const fixture = (policy) => {
    const ct = ctState();
    ct.contract = { ...ct.contract, policy };
    ct.playbook = { entries: [{ id: "run1:rej:0:0", market: "crypto", timeframe: "1m", comparable: true, mechanism: "급락 뒤 반등 — 투매 소진", structure: "return_pct(1m)", grade: "rejected_in_training", reason: "차이 없음", measured: "2025-01-01~2025-02-01", run: "run1" }], cumulativeTests: 12, priorRuns: 2, omitted: 3 };
    ct.calibration = { note: "n", records: [], pooled: null };
    ct.measured = { note: "m", runs: [] };
    return ct;
  };
  const session = { index: 0, kind: "design", status: "open", startedAt: "", turns: 0, toolCalls: 0, screens: 0, messages: 0 };
  const old = ctSessionContext(fixture(STAGE4_POLICY), "연구 방향", { note: "h", rows: [] }, session);
  assert.equal(sha(old.stable), "e0dcdb6ac4be58c4cce70bb788059548c77546f25f8c2bdde0fad81aa70b1e39");
  assert.equal(sha(old.history), "ba68511221cddf1f8a257e2c29b8bbb31234f992c7453c056879eb21d563080b");
  assert.equal(sha(old.task), "747cda8ca99a6ff9dea2d4f63cd42b990b472f2f17a454c50a568e898eb02ed0");
  assert.doesNotMatch(old.stable, /"lessons"|"coverage"/);
  assert.equal(sha(CT_DESIGNER_SYSTEM_STAGE4), "bc6b18e14505fdc67827872c1f6d57f21fdb558a65736bffe04cdda9ab015ad3");
  assert.equal(sha(research.CT_SESSION_TOOLS_STAGE4), "38763047f3977d83fa767e1033f8a4c97629d5ade4d98d7be52a69ea20b34848");
  assert.equal(research.ctSessionTools({ policy: STAGE4_POLICY }), research.CT_SESSION_TOOLS_STAGE4);
  assert.equal(research.ctSessionTools({ policy: STAGE5_POLICY }), research.CT_SESSION_TOOLS_STAGE5);
  // Stage 5 frozen when free bars arrived (pinned from HEAD fa974b5, where it was the newest brief and tool set).
  assert.equal(sha(CT_DESIGNER_SYSTEM), "17e702871a755a0373062a1b16dccc9128b87b10931ae779a35fca9030dbc67e");
  assert.equal(sha(research.CT_SESSION_TOOLS_STAGE5), "ba5d3aaa933a099cb3a75f5075791c547bc8ed3c5c1caa197924c6454cb3643a");
  // The ct-pattern stage-4 submit_candidates schema is the old one; the new field exists only in stage 5's definition.
  const submit = (tools) => tools.find((t) => t.name === "submit_candidates");
  assert.equal(submit(research.CT_SESSION_TOOLS_STAGE4).input_schema.properties.lessonChecks, undefined);
  assert.ok(submit(research.CT_SESSION_TOOLS_STAGE5).input_schema.properties.lessonChecks);
  assert.ok(submit(research.CT_SESSION_TOOLS_STAGE5).input_schema.properties.rejectedHypotheses.items.properties.family);
  assert.equal(submit(research.CT_SESSION_TOOLS_STAGE4).input_schema.properties.rejectedHypotheses.items.properties.family, undefined);
  assert.equal(JSON.stringify(submit(research.CT_SESSION_TOOLS_STAGE4).input_schema), JSON.stringify(schemaJson(ctSubmissionSchema)));
  assert.deepEqual(research.CT_SESSION_TOOLS_STAGE5.map((t) => t.name), research.CT_SESSION_TOOLS_STAGE4.map((t) => t.name));
  for (const t of research.CT_SESSION_TOOLS_STAGE5.filter((x) => x.name !== "submit_candidates")) assert.equal(t, research.CT_SESSION_TOOLS_STAGE4.find((x) => x.name === t.name), "every other tool is the stage-4 object");
  assert.notEqual(CT_DESIGNER_SYSTEM, CT_DESIGNER_SYSTEM_STAGE4);
  assert.match(CT_DESIGNER_SYSTEM, /lessonChecks/);
  assert.match(CT_DESIGNER_SYSTEM, /not a goal and not evidence of performance/);
  assert.match(CT_DESIGNER_SYSTEM, /do not add one merely to fill an empty cell/);
  assert.match(CT_DESIGNER_SYSTEM, /"no edge" remains a normal result/);
  assert.match(CT_DESIGNER_SYSTEM, /nextToTry is a suggestion, not an instruction/);
  // Stage 5 stable block: lessons then coverage, after the playbook, identical on a resume (it is built from the frozen snapshot).
  const ct5 = fixture(STAGE5_POLICY);
  ct5.lessons = { note: "n", entries: [{ id: "r:crypto:breakout", family: "breakout", verdict: "dead", cause: "no_edge_after_cost", lesson: "돌파는 비용을 넘지 못했다.", nextToTry: null, evidence: ["run1:rej:0:0"], omittedEvidence: 0 }], deadFamilies: ["breakout"], coverage: { note: "c", families: [], vocabulary: {}, exitStructure: [], emptyCells: [], basis: { ideas: 1, signatures: 1 } } };
  const a = ctSessionContext(ct5, "연구 방향", { note: "h", rows: [] }, session).stable;
  const b = ctSessionContext(structuredClone(ct5), "연구 방향", { note: "h", rows: [] }, session).stable;
  assert.equal(a, b);
  const keys = Object.keys(JSON.parse(a));
  assert.ok(keys.indexOf("playbook") < keys.indexOf("lessons") && keys.indexOf("lessons") < keys.indexOf("coverage"), keys.join(","));
  assert.deepEqual(JSON.parse(a).lessons.deadFamilies, ["breakout"]);
  assert.doesNotMatch(JSON.stringify(JSON.parse(a).lessons), /\d+\.\d+|\d%/, "a lesson holds no measured number, so neither does the block built from it");
});

/* ------------------------------------------------------------------ the session: lessonChecks */

let sequence = 0;
async function sessionJob(over = {}) {
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled' WHERE status='running'");
  const ct = ctState();
  ct.phase = "design";
  const data = bars(864);
  ct.dataHash = await ctHash({ "KRW-BTC": data });
  Object.assign(ct, over.ct ?? {});
  const j = { id: "lessons-session-" + ++sequence, ownerId: "owner", slot: "open", status: "running", stageIndex: 0, createdAt: now(), updatedAt: now(), from: "2025-01-01", to: "2025-01-04", capitalUsd: 1e6, budgetUsd: 8, costUsd: over.costUsd ?? 0, brief: "", events: [], calls: [], universe: ["KRW-BTC"], ct };
  await store.createGenerationJob(j);
  sqlite.prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)").run(j.id, "KRW-BTC", ct.contract.toMs, JSON.stringify(data));
  return j;
}
const advance = (id) => flow.advanceGeneration(id);
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const reply = (...content) => ({ content: [{ type: "thinking", thinking: "", signature: `sig-${content.map((c) => c.id).join("-")}` }, ...content], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 200 } });
const draft = (mutate = () => {}) => {
  const c = structuredClone(candidate());
  delete c.evidenceVersion;
  c.selfRebuttal = [1, 2, 3].map((n) => ({ chance: `우연 가능성 ${n}: 표본이 적거나 한 시기에 몰렸을 수 있음`, check: `월별 분포와 비용 2배 결과로 ${n}번째 가능성을 확인함`, excluded: "partly" }));
  mutate(c);
  return c;
};
const deadBreakout = () => ({
  note: "n", deadFamilies: ["breakout"],
  entries: [{ id: "old-run:crypto:breakout", family: "breakout", familyText: "돌파", verdict: "dead", cause: "no_edge_after_cost", causeText: "비용을 넘는 우위 없음", lesson: "돌파 계열은 비용을 넘지 못했다.", nextToTry: null, evidence: ["old:rej:0:0"], omittedEvidence: 1, lastRun: "old-run", updated: "2026-10-14", source: "research" }],
  coverage: { note: "c", families: [], vocabulary: { featureCells: { total: 1, touched: 0, untouched: [], moreUntouched: 0 }, atrUnit: { untouched: [] }, entryWindow: { used: false }, managedExit: { untouched: [] } }, exitStructure: [], emptyCells: [], basis: { ideas: 0, signatures: 0 } },
});
const results = (id, session = 0) => sqlite.prepare("SELECT payload FROM ct_session_messages WHERE run_id=? AND session=? ORDER BY seq").all(id, session).map((r) => JSON.parse(r.payload)).filter((m) => m.role === "user").flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");

test("submit_candidates: a candidate in a dead family needs differsBecause, the server's family wins, live families and no-candidate endings are not checked", async () => {
  const replies = [];
  globalThis.__strategyTestHooks.turn = async () => replies.shift();
  // 1) no explanation: refused with an error to fix in the same session. 2) declared family differs from the server's: the server's is used.
  replies.push(
    reply(toolUse("s1", "submit_candidates", { candidates: [draft()], noEdgeReason: null, rejectedHypotheses: [] })),
    reply(toolUse("s2", "submit_candidates", { candidates: [draft()], noEdgeReason: null, rejectedHypotheses: [], lessonChecks: [{ candidateIndex: 0, family: "trend_following", lessonId: null, differsBecause: "짧음" }] })),
    reply(toolUse("s3", "submit_candidates", { candidates: [draft()], noEdgeReason: null, rejectedHypotheses: [{ hypothesis: "VWAP 이탈 뒤 재탈환", mechanism: "공정가치", evidence: ["x"], result: "차이 없음" }, { hypothesis: "기타", mechanism: "m", evidence: [], result: "r", family: "time_seasonality" }], lessonChecks: [{ candidateIndex: 0, family: "trend_following", lessonId: null, differsBecause: "이전 돌파는 고정 손절이었고 이번에는 거래량이 확인된 뒤에만 진입해 원인이 다르다" }] })),
  );
  const created = await sessionJob({ ct: { lessons: deadBreakout() } });
  let job = await advance(created.id); // session opened
  for (let k = 0; k < 3; k++) {
    job = await advance(created.id); // designer turn
    job = await advance(created.id); // tools
  }
  const r = results(created.id);
  assert.equal(r.length, 3);
  assert.equal(r[0].is_error, true);
  assert.match(String(r[0].content), /dead 교훈/);
  assert.match(String(r[0].content), /lessonChecks/);
  assert.equal(r[1].is_error, true, "an explanation under 20 characters is no explanation");
  assert.equal(r[2].is_error, undefined, String(r[2].content));
  assert.equal(job.ct.sessions[0].status, "submitted");
  assert.equal(job.ct.duplicateCount, 0, "a refused submission is not counted twice");
  const stored = job.ct.queue[0].candidate;
  assert.deepEqual(stored.lessonCheck, { family: "breakout", declaredFamily: "trend_following", lessonId: "old-run:crypto:breakout", differsBecause: "이전 돌파는 고정 손절이었고 이번에는 거래량이 확인된 뒤에만 진입해 원인이 다르다" });
  const submission = job.ct.sessions[0].submission;
  assert.deepEqual(submission.lessonChecks.map((c) => [c.candidateIndex, c.family, c.declaredFamily]), [[0, "breakout", "trend_following"]]);
  assert.equal(submission.rejectedHypotheses[0].family, "levels_gaps", "filled by the server from the text the playbook row will carry");
  assert.equal(submission.rejectedHypotheses[1].family, "time_seasonality", "a declared family is kept");

  // Live family (no dead lesson for it) and a no-candidate ending: nothing to explain.
  replies.push(reply(toolUse("t1", "submit_candidates", { candidates: [draft()], noEdgeReason: null, rejectedHypotheses: [] })));
  const live = await sessionJob({ ct: { lessons: { ...deadBreakout(), deadFamilies: ["mean_reversion"], entries: [{ ...deadBreakout().entries[0], family: "mean_reversion", id: "old-run:crypto:mean_reversion" }] } } });
  let j2 = await advance(live.id);
  j2 = await advance(live.id);
  j2 = await advance(live.id);
  assert.equal(results(live.id)[0].is_error, undefined);
  assert.equal(j2.ct.queue[0].candidate.lessonCheck, undefined);
  replies.push(reply(toolUse("u1", "submit_candidates", { candidates: [], noEdgeReason: "비용을 넘는 조건이 없었다", rejectedHypotheses: [] })));
  const none = await sessionJob({ ct: { lessons: deadBreakout() } });
  let j3 = await advance(none.id);
  j3 = await advance(none.id);
  j3 = await advance(none.id);
  assert.equal(results(none.id)[0].is_error, undefined);
  assert.equal(j3.ct.phase, "done");
  // A stage-4 contract has no lessonChecks at all: the old schema refuses the field, and nothing is looked up.
  assert.ok(ctSubmissionSchema.safeParse({ candidates: [], noEdgeReason: "x", rejectedHypotheses: [], lessonChecks: [] }).error);
  assert.ok(ctSubmissionSchemaStage5.safeParse({ candidates: [], noEdgeReason: "x", rejectedHypotheses: [], lessonChecks: [] }).success);
});

/* ------------------------------------------------------------------ the run's end */

test("a run that ends records its lessons with a cheap call from its own reserve; a failure or a missing reserve leaves the result alone", async () => {
  sqlite.exec("DELETE FROM ct_playbook; DELETE FROM ct_playbook_runs; DELETE FROM ct_playbook_lessons");
  const seen = [];
  globalThis.__strategyTestHooks.call = async (role, prompt) => {
    seen.push({ role, prompt });
    if (role !== "ctLessons") throw new Error(`unexpected role ${role}`);
    const rows = JSON.parse(prompt.slice(prompt.indexOf('{"market"'))).items.filter((i) => i.new && i.family === "mean_reversion").map((i) => i.ref);
    return { lessons: [{ family: "mean_reversion", verdict: "weak", cause: "no_edge_after_cost", lesson: "급락 뒤 반등은 이 판에서 비용을 넘지 못했다.", nextToTry: null, evidence: rows }] };
  };
  // A session already submitted its ideas; a new one does not fit the budget (the headroom check), which is how a long run really ends.
  const base = finishedRun("seed").ct;
  const ending = (costUsd) => ({ costUsd, ct: { sessions: structuredClone(base.sessions), queries: structuredClone(base.queries) } });
  const spend = async (cost) => advance((await sessionJob(ending(cost))).id);

  let job = await spend(7.98);
  assert.equal(job.ct.phase, "done");
  assert.match(job.ct.endReason, /새 설계 세션 여유 없음/);
  assert.equal(job.ct.lessonsRecorded.lessons, 1, JSON.stringify(job.ct.lessonsRecorded));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].role, "ctLessons");
  const call = job.calls.find((c) => c.role === "ctLessons");
  assert.equal(call.status, "completed");
  assert.equal(call.provider, "OpenAI");
  assert.equal(call.model, "gpt-6-luna");
  assert.ok(call.costUsd <= CT_POLICY.lessonReserveUsd, `the distillation cost ${call.costUsd} stays inside its reserve`);
  assert.ok(job.costUsd <= job.budgetUsd, `${job.costUsd} of ${job.budgetUsd}`);
  assert.ok(job.ct.tools.some((t) => t.name === "lessons_record" && t.status === "completed"));
  assert.equal(sqlite.prepare("SELECT count(*) n FROM ct_playbook_lessons").get().n, 1);
  assert.equal(job.ct.passed, false);
  assert.equal(job.status, "completed");

  // Read back from the stored run: a resume neither distils nor pays again.
  const stored = await store.getGenerationJob(job.id);
  assert.equal(stored.ct.lessonsRecorded.lessons, 1);
  const before = seen.length;
  stored.status = "running";
  await research.advanceCTResearch(stored, "fixture", async () => { throw new Error("must not be asked again"); }).catch(() => undefined);
  assert.equal(seen.length, before);

  // A failing distillation: the run ends the same way, and the failure is recorded and visible.
  globalThis.__strategyTestHooks.call = async () => { throw new Error("provider down"); };
  const failedRun = await spend(7.98);
  assert.equal(failedRun.ct.phase, "done");
  assert.equal(failedRun.status, "completed");
  assert.match(failedRun.ct.endReason, /새 설계 세션 여유 없음/);
  assert.match(failedRun.ct.lessonsRecorded.failed, /provider down/);
  assert.ok(failedRun.ct.tools.some((t) => t.name === "lessons_record" && t.status === "failed"));
  assert.equal(failedRun.ct.passed, false);

  // No room left even for the distillation's reserve: skipped, said so, nothing reserved or paid, result unchanged.
  globalThis.__strategyTestHooks.call = async () => { throw new Error("must not be called"); };
  const broke = await spend(7.999);
  assert.equal(broke.ct.phase, "done");
  assert.equal(broke.ct.lessonsRecorded.skipped, "reserve");
  assert.equal(broke.calls.filter((c) => c.role === "ctLessons" && c.status !== "failed").length, 0);
  assert.match(broke.ct.endReason, /새 설계 세션 여유 없음/);
  globalThis.__strategyTestHooks.call = fail;
});

test("older contracts end exactly as before: no distillation, no field, no reserve", async () => {
  globalThis.__strategyTestHooks.call = async () => { throw new Error("must not be called"); };
  const created = await sessionJob({ costUsd: 7.99, ct: { contract: { ...ctState().contract, policy: STAGE4_POLICY }, sessions: finishedRun("y").ct.sessions } });
  const job = await advance(created.id);
  assert.equal(job.ct.phase, "done");
  assert.equal(job.ct.lessonsRecorded, undefined);
  assert.equal(job.calls.length, 0);
  assert.equal(job.ct.tools.some((t) => /lessons/.test(t.name)), false);
  globalThis.__strategyTestHooks.call = fail;
});

/* ------------------------------------------------------------------ reviewers */

async function passingJob(policy) {
  sqlite.exec("DELETE FROM ct_exposure");
  const ct = ctState();
  ct.phase = "experiment";
  ct.pending = candidate();
  if (policy) ct.contract = { ...ct.contract, policy };
  ct.pending.spec.stages[0].conditions.push({ feature: "volume_ratio", lookback: 3, offset: 0, timeframe: 1, op: "gte", value: 0.5 });
  ct.pending.mapping.push({ stage: 0, condition: 1, feature: "volume_ratio", sourceId: "verified", implementationAssumption: "Fixture completion-volume condition." });
  const c = ct.contract;
  c.fromMs = Date.UTC(2025, 0, 1); c.trainingToMs = Date.UTC(2025, 3, 1); c.developmentToMs = Date.UTC(2025, 6, 1); c.toMs = Date.UTC(2025, 9, 1);
  const data = Array.from({ length: 273 }, (_, day) => bars(18, c.fromMs + day * 86400000).map((b, i) => ({ ...b, open: 1000 + i * 6, close: 1004 + i * 6, high: 1005 + i * 6, low: 999 + i * 6, volume: i < 9 ? 100000 : 100000 / 10 ** (i - 8) }))).flat();
  ct.dataHash = await ctHash({ "KRW-BTC": data });
  sqlite.exec("UPDATE strategy_generation_runs SET status='cancelled' WHERE status='running'");
  const j = { id: "lessons-review-" + ++sequence, ownerId: "owner", slot: "open", status: "running", stageIndex: 0, createdAt: now(), updatedAt: now(), from: "2025-01-01", to: "2025-01-04", capitalUsd: 1e6, budgetUsd: 8, costUsd: 0, events: [], calls: [], universe: ["KRW-BTC"], ct };
  await store.createGenerationJob(j);
  await store.claimGenerationJob(j.id, "fixture");
  sqlite.prepare("INSERT INTO ct_data_pages VALUES (?,?,?,?)").run(j.id, "KRW-BTC", c.toMs, JSON.stringify(data));
  return j;
}
const noModel = async () => { throw new Error("unexpected model"); };

test("reviewers get the lessons for the candidate's family, every dead family and the designer's explanation — stage 5 only, never the designer's thinking", async () => {
  const prompts = {};
  for (const [name, policy] of [["stage5", CT_POLICY], ["stage4", STAGE4_POLICY]]) {
    const j = await passingJob(policy);
    await research.advanceCTResearch(j, "fixture", noModel);
    assert.equal(j.ct.phase, "risk_review", name);
    if (name === "stage5") {
      j.ct.lessons = deadBreakout();
      j.ct.trials[0].lessonCheck = { family: "breakout", lessonId: "old-run:crypto:breakout", differsBecause: "이번에는 거래량이 확인된 뒤에만 진입해 원인이 다르다" };
    }
    j.ct.sessions = [{ index: 0, kind: "design", status: "submitted", startedAt: now(), turns: 1, toolCalls: 1, screens: 0, messages: 2, submission: { candidates: 1, accepted: 1, duplicates: 0, noEdgeReason: null, rejectedHypotheses: [] } }];
    await research.advanceCTResearch(j, "fixture", async (role, _schema, prompt) => {
      if (role === "ctLessons") return { lessons: [] };
      prompts[name] = { role, prompt };
      return { approved: false, blockers: ["stop here"], findings: [], suggestions: [] };
    });
  }
  const five = prompts.stage5.prompt;
  assert.match(five, /"lessons":\{"candidateFamilies":\["breakout"\],"forCandidate":\[\{"lessonId":"old-run:crypto:breakout","family":"breakout","verdict":"dead"/);
  assert.match(five, /"deadFamilies":\[\{"lessonId":"old-run:crypto:breakout"/);
  assert.match(five, /"lessonChecks":\[\{"family":"breakout","lessonId":"old-run:crypto:breakout","differsBecause":"이번에는 거래량이 확인된 뒤에만 진입해 원인이 다르다"\}\]/);
  assert.match(five, /whether this rule is a variant of an idea family the lessons mark dead/);
  assert.match(five, /an untouched coverage cell is never a reason to approve/);
  assert.doesNotMatch(five, /thinking|summarized|생각 요약/i, "the designer's thinking never reaches a reviewer");
  const four = prompts.stage4.prompt;
  assert.doesNotMatch(four, /"lessons"|lessonChecks|idea family the lessons/);
  assert.match(four, /Numeric gates binding\. No tuning on final\./, "the stage-4 prompt text is unchanged");
});

/* ------------------------------------------------------------------ the screen */

test("lessons tab: an empty state, cards with a dead/weak verdict, evidence links that point at playbook items, coverage as counts", async () => {
  const empty = lessonsPanelModel({ lessons: [], coverage: undefined }, []);
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.cards, []);
  assert.equal(empty.coverage, null);
  assert.equal(lessonsPanelModel(null, []).empty, true);

  sqlite.exec("DELETE FROM ct_playbook; DELETE FROM ct_playbook_runs; DELETE FROM strategy_generation_runs; DELETE FROM ct_playbook_lessons");
  const run = withCandidates(finishedRun("tab-a"));
  await INSERT_RUN(run);
  const mr = playbook.ctPlaybookRows(run).filter((r) => ctIdeaFamily(r) === "mean_reversion").map((r) => r.id);
  await lessons.ctDistillRun(run, async (_r, schema) => schema.parse({ lessons: [{ family: "mean_reversion", verdict: "weak", cause: "regime_concentrated", lesson: "급락 뒤 반등은 특정 국면에만 있었다.", nextToTry: "하락 추세가 아닌 날만 따로 본 변형은 아직 없다.", evidence: [...mr, "tab-a:rej:0:4"] }] }), { maxInputChars: 60_000, model: "gpt-6-luna" });
  const list = await lessons.ctLessonsList("owner", "crypto");
  const entries = (await playbook.ctPlaybookList("owner", "crypto")).entries;
  const model = lessonsPanelModel(list, entries);
  assert.equal(model.empty, false);
  assert.equal(model.cards.length, 1);
  const card = model.cards[0];
  assert.equal(card.familyText, "평균 회귀 · 급락·과매도 반등");
  assert.equal(card.verdictText, "약한 증거");
  assert.equal(card.causeText, "특정 국면에 집중");
  assert.equal(card.nextToTry, "하락 추세가 아닌 날만 따로 본 변형은 아직 없다.");
  assert.ok(card.evidence.length >= 2);
  assert.ok(card.evidence.every((e) => e.listed && e.anchor === playbookAnchor(e.id) && entries.some((p) => p.id === e.id)), "every evidence link points at an item the list renders");
  assert.ok(card.evidence.every((e) => e.label.length > 0 && e.label.length <= 22 && !/^[0-9a-f-]{8,}:/.test(e.label)), "a link reads as the idea it points at, not as an internal id");
  assert.equal(card.evidence[0].label, entries.find((p) => p.id === card.evidence[0].id).mechanism.slice(0, 21) + "…", "the first words of the item");
  assert.ok(model.coverage.families.find((f) => f.family === "mean_reversion").hasLesson);
  assert.ok(model.coverage.untouched.length > 0);
  assert.equal(model.coverage.totalCells, lessons.CT_FEATURE_CELLS.length);
  // An item older than the loaded list is shown unlinked, not as a broken link.
  const partial = lessonsPanelModel(list, entries.slice(0, 1));
  assert.ok(partial.cards[0].evidence.some((e) => !e.listed));
  assert.doesNotMatch(JSON.stringify(list), /12\.346|99\.9|0\.52/, "nothing the tab shows carries a measured number");
});
