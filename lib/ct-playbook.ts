/**
 * The playbook (stage 3): what earlier CT runs on a market tried and how each idea ended, kept
 * across runs so the designer does not rediscover a dead idea and the reviewers know how many tests
 * a result has survived. It replaces `ctMemory` as the designer's cross-run memory (the memory of
 * measured rules stays for citing parents, now with the same leak rule).
 *
 * Leak rule (no exceptions):
 *   - The final split's performance is never stored in `detail`, never shown.
 *   - An entry whose measured window overlaps the NEW run's development or final window
 *     ([trainingToMs, toMs]) shows its mechanism and grade only: no numbers anywhere.
 *   - Entries measured only before the new run's development window may carry their numbers.
 *
 * Tables (created by ensureCTSchema): ct_playbook (one row per idea) and ct_playbook_runs (one row per
 * finished run with its hypothesis-test ledger, the cumulative count's source).
 */
import { ctDb } from "./ct-data.ts";
import { ctRuleText, ctTestSignature, ctFreedom, type CTContract } from "./ct-spec.ts";
import { ctCandidateIdea } from "./ct-families.ts";
import type { CTCandidate, CTPlaybookSnapshot, CTResearch } from "./ct-research.ts";
import type { GenerationJob } from "./strategy-generation-types.ts";
import { ctIsCalibrationHypothesis, ctMigrateCalibration } from "./ct-calibration.ts";

export const CT_PLAYBOOK_GRADES = ["rejected_in_training", "screen_failed", "development_failed", "passed_final", "failed_final", "adopted_daily"] as const;
export type CTPlaybookGrade = (typeof CT_PLAYBOOK_GRADES)[number];
export const CT_PLAYBOOK_GRADE_TEXT: Record<CTPlaybookGrade, string> = {
  rejected_in_training: "학습 구간에서 기각",
  screen_failed: "학습 게이트 탈락",
  development_failed: "개발 구간 탈락",
  passed_final: "최종 통과",
  failed_final: "최종 탈락",
  adopted_daily: "일봉 조건부 채택(단타 아님)",
};

export const CT_PLAYBOOK_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ct_playbook (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,run_id TEXT NOT NULL,market TEXT NOT NULL,symbols TEXT NOT NULL,timeframe TEXT NOT NULL,comparable INTEGER NOT NULL,mechanism TEXT NOT NULL,structure TEXT NOT NULL,evidence_kind TEXT NOT NULL,evidence_ref TEXT NOT NULL,grade TEXT NOT NULL,reason TEXT NOT NULL,measured_from INTEGER NOT NULL,measured_to INTEGER NOT NULL,cost_profile TEXT NOT NULL,engine TEXT NOT NULL,source TEXT NOT NULL,detail TEXT NOT NULL,recorded_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_ct_playbook_market ON ct_playbook (market, recorded_at)",
  "CREATE TABLE IF NOT EXISTS ct_playbook_runs (run_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,market TEXT NOT NULL,symbols TEXT NOT NULL,timeframe TEXT NOT NULL,hypothesis_tests INTEGER NOT NULL,tool_calls INTEGER NOT NULL,measured_from INTEGER NOT NULL,measured_to INTEGER NOT NULL,engine TEXT NOT NULL,note TEXT NOT NULL,recorded_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ct_chart_images (run_id TEXT NOT NULL,chart_id TEXT NOT NULL,png TEXT NOT NULL,meta TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,chart_id))",
] as const;

export type PlaybookRow = {
  id: string;
  owner_id: string;
  run_id: string;
  market: string;
  symbols: string;
  timeframe: string;
  comparable: number;
  mechanism: string;
  structure: string;
  evidence_kind: string;
  evidence_ref: string;
  grade: CTPlaybookGrade;
  reason: string;
  measured_from: number;
  measured_to: number;
  cost_profile: string;
  engine: string;
  source: string;
  detail: string;
  recorded_at: number;
};

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Digits (and signs/percent) in a free-text result replaced, for entries that must show no numbers. */
export const ctStripNumbers = (text: string) => text.replace(/[+\-−]?\d[\d.,]*\s*(%p|%|배|건|봉|분|일)?/g, "#");

const costProfileOf = (c: CTContract) => (c.costProfile ? `${c.costProfile.id}@${c.costProfile.version}` : "");

/** The feature list of a rejected hypothesis, from the measurements it cites ("return_pct(1m) · volume_ratio(1m)"). */
export function ctEvidenceFeatures(ct: Pick<CTResearch, "queries" | "contrasts" | "diagnoses">, ids: string[]) {
  const names = new Set<string>();
  for (const id of ids) {
    for (const q of ct.queries ?? []) if (q.queryId === id) for (const f of q.features) names.add(`${f.feature}(${f.timeframe}m)`);
    for (const x of ct.contrasts ?? []) if (x.contrastId === id) for (const f of x.features) names.add(`${f.feature}(${f.timeframe}m)`);
    for (const x of ct.diagnoses ?? []) if (x.diagnosisId === id) for (const f of x.features) names.add(`${f.feature}(${f.timeframe}m)`);
  }
  return [...names].join(" · ") || "(구조 미기록)";
}

/** How many hypothesis tests a run's ledger holds (older runs: distinct query signatures). */
export function ctRunTests(ct: CTResearch) {
  const signatures = ct.tests?.signatures ?? {};
  const n = Object.keys(signatures).length;
  if (n) return { hypotheses: n, calls: Object.values(signatures).reduce((s, x) => s + x, 0) };
  const sigs = new Set((ct.queries ?? []).map((q) => q.signature ?? ctTestSignature(q.stages, false)));
  return { hypotheses: sigs.size, calls: ct.queries?.length ?? 0 };
}

/**
 * The bar size a run is filed under ("1m", "5m", "15m", "60m"). Every intraday bar size counts toward the
 * market's cumulative tests (they mine the same history); only the daily seeds ("daily") stay apart.
 */
export const ctPlaybookTimeframe = (contract: Pick<CTContract, "minutes">) => `${contract.minutes}m`;
// A run's own ledger row (ct_playbook_runs) keeps its data bar ("1m"); its candidates and rejected ideas carry their own bars.
/** The playbook rows a finished run contributes. Deterministic ids: recording twice changes nothing. */
export function ctPlaybookRows(job: Pick<GenerationJob, "id" | "ownerId"> & { ct?: CTResearch }, now = Date.now()): PlaybookRow[] {
  const ct = job.ct;
  if (!ct) return [];
  const c = ct.contract;
  const base = {
    owner_id: job.ownerId,
    run_id: job.id,
    market: c.market,
    symbols: JSON.stringify(c.symbols),
    timeframe: ctPlaybookTimeframe(c),
    comparable: 1,
    cost_profile: costProfileOf(c),
    engine: c.engine,
    source: "research",
    recorded_at: now,
  };
  const rows: PlaybookRow[] = [];
  const queryFeatures = (ids: string[]) => ctEvidenceFeatures(ct, ids);
  // 1) Hypotheses the designer rejected on training evidence.
  for (const s of ct.sessions ?? []) {
    (s.submission?.rejectedHypotheses ?? []).forEach((h, k) => {
      // A hypothesis whose only evidence is a blind set is a measurement of the designer's eye, not a trading idea:
      // it lives in ct_calibration (lib/ct-calibration.ts) and must never be filed (or revived by a backfill) as a rejected mechanism.
      if (ctIsCalibrationHypothesis(h.evidence, ct.blinds)) return;
      // Free bars: a hypothesis rejected on a coarser-bar query is filed under that bar.
      const bar = (ct.queries ?? []).find((q) => h.evidence.includes(q.queryId) && q.barMinutes)?.barMinutes;
      rows.push({
        ...base,
        ...(bar ? { timeframe: `${bar}m` } : {}),
        id: `${job.id}:rej:${s.index}:${k}`,
        mechanism: clip(`${h.hypothesis} — ${h.mechanism}`, 400),
        structure: clip(queryFeatures(h.evidence), 300),
        evidence_kind: "queryId",
        evidence_ref: h.evidence.join(",").slice(0, 200),
        grade: "rejected_in_training",
        reason: clip(h.result, 400),
        measured_from: c.fromMs,
        measured_to: c.trainingToMs,
        detail: "{}",
      });
    });
  }
  // 2) Candidates that failed the free training gate.
  for (const t of ct.screened ?? []) {
    rows.push({
      ...base,
      // Free bars: a candidate is filed under the bar it trades on.
      timeframe: ctPlaybookTimeframe(t.candidate.spec),
      id: `${job.id}:scr:${t.id}`,
      ...ctCandidateIdea(t.candidate.spec.name, t.candidate.hypothesis.mechanism, t.candidate.spec),
      evidence_kind: "candidate",
      evidence_ref: t.id,
      grade: "screen_failed",
      reason: t.reasons.join(" · "),
      measured_from: c.fromMs,
      measured_to: c.trainingToMs,
      detail: JSON.stringify({ trainingNetReturnPct: Number(t.training.netReturnPct.toFixed(3)), trainingTrades: t.training.tradeCount ?? t.training.trades.length, freedom: ctFreedom(t.candidate.spec).total }),
    });
  }
  // 3) Candidates that reached development (and possibly the final split). Final numbers are never stored.
  for (const t of ct.trials) {
    const isSelected = ct.selectedId === t.id;
    const finalOpened = Boolean(ct.finalConsumed) && isSelected;
    const grade: CTPlaybookGrade = finalOpened ? (ct.passed ? "passed_final" : "failed_final") : "development_failed";
    const reason = finalOpened
      ? ct.passed
        ? "서버 수치 게이트와 독립 최종 검토 통과 · 전향 모의투자 필요"
        : ct.endReason ?? "최종 평가 탈락"
      : isSelected && ct.riskReview && !ct.riskReview.approved
        ? "개발 통과 후 독립 위험 검토 반려"
        : t.reasons.join(" · ") || "개발 구간 탈락";
    rows.push({
      ...base,
      timeframe: ctPlaybookTimeframe(t.spec),
      id: `${job.id}:trial:${t.id}`,
      ...ctCandidateIdea(t.spec.name, t.hypothesis.mechanism, t.spec),
      evidence_kind: "candidate",
      evidence_ref: t.id,
      grade,
      reason,
      measured_from: c.fromMs,
      measured_to: finalOpened ? c.toMs : c.developmentToMs,
      detail: JSON.stringify({
        trainingNetReturnPct: Number(t.training.netReturnPct.toFixed(3)),
        developmentNetReturnPct: Number(t.development.netReturnPct.toFixed(3)),
        developmentTrades: t.development.tradeCount ?? t.development.trades.length,
        freedom: ctFreedom(t.spec).total,
      }),
    });
  }
  return rows;
}

export function ctPlaybookRunRow(job: Pick<GenerationJob, "id" | "ownerId"> & { ct?: CTResearch }, now = Date.now()) {
  const ct = job.ct!;
  const c = ct.contract;
  const tests = ctRunTests(ct);
  const note = (ct.sessions ?? []).map((s) => s.submission?.noEdgeReason).filter(Boolean).at(-1) ?? ct.endReason ?? "";
  return {
    run_id: job.id,
    owner_id: job.ownerId,
    market: c.market,
    symbols: JSON.stringify(c.symbols),
    timeframe: ctPlaybookTimeframe(c),
    hypothesis_tests: tests.hypotheses,
    tool_calls: tests.calls,
    measured_from: c.fromMs,
    measured_to: ct.finalConsumed ? c.toMs : c.developmentToMs,
    engine: c.engine,
    note: clip(String(note), 600),
    recorded_at: now,
  };
}

const INSERT_ROW =
  "INSERT OR IGNORE INTO ct_playbook (id,owner_id,run_id,market,symbols,timeframe,comparable,mechanism,structure,evidence_kind,evidence_ref,grade,reason,measured_from,measured_to,cost_profile,engine,source,detail,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const rowValues = (r: PlaybookRow) => [r.id, r.owner_id, r.run_id, r.market, r.symbols, r.timeframe, r.comparable, r.mechanism, r.structure, r.evidence_kind, r.evidence_ref, r.grade, r.reason, r.measured_from, r.measured_to, r.cost_profile, r.engine, r.source, r.detail, r.recorded_at];

/** Writes a finished run's ideas and ledger to the playbook. Idempotent. */
export async function recordCTPlaybook(job: Pick<GenerationJob, "id" | "ownerId"> & { ct?: CTResearch }, source: "research" | "backfill" = "research") {
  const rows = ctPlaybookRows(job).map((r) => ({ ...r, source }));
  const run = ctPlaybookRunRow(job);
  const db = ctDb();
  for (const r of rows) await db.prepare(INSERT_ROW).bind(...rowValues(r)).run();
  await db
    .prepare("INSERT OR IGNORE INTO ct_playbook_runs (run_id,owner_id,market,symbols,timeframe,hypothesis_tests,tool_calls,measured_from,measured_to,engine,note,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(run.run_id, run.owner_id, run.market, run.symbols, run.timeframe, run.hypothesis_tests, run.tool_calls, run.measured_from, run.measured_to, run.engine, run.note, run.recorded_at)
    .run();
  return rows.length;
}

/* ----------------------------------------------------------------------- seeds */

const SEED_FROM = Date.UTC(2021, 8, 7);
const SEED_TO = Date.UTC(2026, 8, 4);
type Seed = { key: string; mechanism: string; structure: string; grade: CTPlaybookGrade; reason: string; from?: number; detail?: Record<string, number | string> };
/** docs/research/results-2026-09.md: ten daily hypotheses on US equities/ETFs (2026-09). Not comparable to 1-minute day trading. */
export const CT_PLAYBOOK_SEEDS: Seed[] = [
  { key: "H1", mechanism: "오버나이트 프리미엄: 종가 매수 → 다음 시가 매도", structure: "일봉 · 종가→시가", grade: "development_failed", reason: "사전 반증 기준 두 개 위반, 표본 밖 12칸 중 11칸 음수. 메커니즘은 있으나 왕복 비용이 더 큼", detail: { 표본밖음수칸: "11/12" } },
  { key: "H2", mechanism: "3일 급락 후 5일 단기 반전(대형주 57종목, 하루 3종목 상한, 손절 −6%)", structure: "일봉 · return_pct(3일) ≤ −X% → 다음 종가 매수 · 5거래일 보유", grade: "adopted_daily", reason: "조건부 채택: 사전 기준 통과, 11년·날짜 클러스터 보정 후에도 유의. 2020–2022 구간에서 효과 소멸(국면 의존)", from: Date.UTC(2015, 0, 1), detail: { 표본내거래당순수익: "+0.75", 표본밖거래당순수익: "+1.40" } },
  { key: "H3", mechanism: "섹터 ETF 급등일 이후 3~5일 모멘텀 지속", structure: "일봉 · 당일수익률 > k·σ · 종가 > SMA50", grade: "development_failed", reason: "9칸 중 7칸 음수. 섹터 ETF의 3일 드리프트가 왕복 비용보다 작음(σ 배수를 바꿔도 같은 산술)" },
  { key: "H4", mechanism: "실적 발표 후 긍정 반응일의 사후 드리프트(PEAD)", structure: "일봉 · 실적일 반응 + 고가 근접 마감", grade: "development_failed", reason: "10일 순수익과 승률이 사전 기준 미달. 부정 반응 쪽이 오히려 더 양수" },
  { key: "H5", mechanism: "저거래량일 시가 범위 돌파가 휩쏘 필터로 더 낫다", structure: "5분봉 · 시가 범위 돌파 · 거래량 필터", grade: "development_failed", reason: "부호가 반대: 저거래량일이 무필터보다 나쁨, 고거래량일만 양수(표본 작음)" },
  { key: "H6", mechanism: "첫 시간 급락 후 VWAP 회복(장중 평균회귀)", structure: "5분봉 · 첫 시간 급락 → VWAP 회복", grade: "development_failed", reason: "비용을 0으로 놓아도 총수익 음수. 오전 급락 후 VWAP 회복은 반전 신호가 아니라 약한 날의 중간 지점" },
  { key: "H7", mechanism: "레버리지 ETF의 추세 내 5일 저점 눌림목 매수", structure: "일봉 · 5일 저점 + 종가 > SMA50", grade: "development_failed", reason: "측정된 것은 3배 ETF의 상승 드리프트: 무조건 5일 보유와 구분되지 않고 표본 밖에서 뒤처짐" },
  { key: "H8", mechanism: "월말·월초 효과를 레버리지로 증폭", structure: "일봉 · 달력 창(−1, +3)", grade: "development_failed", reason: "12칸 전부 무작위 창 분포의 상위 10% 밖, 표본 밖에서 부호 붕괴" },
  { key: "H9", mechanism: "FOMC 발표 전 드리프트", structure: "일봉·분봉 · 발표 전 보유", grade: "development_failed", reason: "2015년 이후 데이터에서 임계값을 어느 종목·주기에서도 못 넘음(효과 소멸)" },
  { key: "H10", mechanism: "하락 추세 반등 페이드: 인버스 ETF 매수", structure: "일봉 · 하락 국면 반등 후 인버스", grade: "development_failed", reason: "방향 자체가 틀림: 하락 국면에서 돌린 규칙이 상승 국면보다 더 나쁨" },
];
export const CT_PLAYBOOK_SEED_RUN = "seed:2026-09";

/** Inserts the 2026-09 daily results once (idempotent). They count as ten hypothesis tests on the stock market, kept apart from 1-minute runs. */
export async function ensurePlaybookSeeds() {
  const db = ctDb();
  for (const s of CT_PLAYBOOK_SEEDS)
    await db
      .prepare(INSERT_ROW)
      .bind(
        ...rowValues({
          id: `${CT_PLAYBOOK_SEED_RUN}:${s.key}`,
          owner_id: "",
          run_id: CT_PLAYBOOK_SEED_RUN,
          market: "stock",
          symbols: JSON.stringify(["US 대형주·ETF"]),
          timeframe: "daily",
          comparable: 0,
          mechanism: s.mechanism,
          structure: s.structure,
          evidence_kind: "script",
          evidence_ref: `docs/research/results-2026-09.md#${s.key}`,
          grade: s.grade,
          reason: s.reason,
          measured_from: s.from ?? SEED_FROM,
          measured_to: SEED_TO,
          cost_profile: "broker-costs(왕복 0.2308%)",
          engine: "daily-scripts",
          source: "seed",
          detail: JSON.stringify(s.detail ?? {}),
          recorded_at: SEED_TO,
        }),
      )
      .run();
  await db
    .prepare("INSERT OR IGNORE INTO ct_playbook_runs (run_id,owner_id,market,symbols,timeframe,hypothesis_tests,tool_calls,measured_from,measured_to,engine,note,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(CT_PLAYBOOK_SEED_RUN, "", "stock", JSON.stringify(["US 대형주·ETF"]), "daily", CT_PLAYBOOK_SEEDS.length, CT_PLAYBOOK_SEEDS.length, SEED_FROM, SEED_TO, "daily-scripts", "가설 10개 검증(일봉·미국 주식/ETF) · 단타(1분봉)와 직접 비교 불가", SEED_TO)
    .run();
}

let backfilled: Promise<number> | null = null;
/**
 * Finished CT runs from before the playbook existed (or whose recording failed) are written once, so the
 * first run after this change already has the history of the runs before it. Idempotent per run.
 */
export function backfillPlaybook(): Promise<number> {
  backfilled ??= (async () => {
    await ensurePlaybookSeeds();
    const db = ctDb();
    const rows = await db
      .prepare(
        "SELECT payload FROM strategy_generation_runs WHERE json_extract(payload,'$.ct.version')=1 AND json_extract(payload,'$.ct.phase')='done' AND id NOT IN (SELECT run_id FROM ct_playbook_runs)",
      )
      .all<{ payload: string }>();
    let n = 0;
    for (const r of rows.results) {
      const job = JSON.parse(r.payload) as GenerationJob;
      if (!job.ct || !job.ct.sessions?.length) continue;
      n += await recordCTPlaybook(job, "backfill");
    }
    // Stage 4: blind-set results move to ct_calibration and leave the playbook (idempotent).
    await ctMigrateCalibration();
    return n;
  })().catch((error) => {
    backfilled = null;
    throw error;
  });
  return backfilled;
}
/** For tests: forget that the backfill ran. */
export function resetPlaybookBackfill() {
  backfilled = null;
}

/* ----------------------------------------------------------------------- view */

/** An entry's measured window overlaps what this run will judge on (development and final). */
export const ctOverlapsEvaluation = (entry: { measured_from: number; measured_to: number }, contract: Pick<CTContract, "trainingToMs" | "toMs">) =>
  entry.measured_to > contract.trainingToMs && entry.measured_from < contract.toMs;

export type CTPlaybookView = CTPlaybookSnapshot["entries"][number] & { overlaps: boolean };
/** One stored row as the designer (or the owner's list) sees it for a run with `contract`. */
export function ctPlaybookView(row: PlaybookRow, contract: Pick<CTContract, "trainingToMs" | "toMs">): CTPlaybookView {
  const overlaps = ctOverlapsEvaluation(row, contract);
  let detail: Record<string, number | string> | undefined;
  if (!overlaps) {
    try {
      const parsed = JSON.parse(row.detail) as Record<string, number | string>;
      if (Object.keys(parsed).length) detail = parsed;
    } catch {
      detail = undefined;
    }
  }
  return {
    id: row.id,
    market: row.market,
    timeframe: row.timeframe,
    comparable: row.comparable === 1,
    mechanism: row.mechanism,
    structure: row.structure,
    grade: row.grade,
    // Free-text reasons can carry numbers from the window; an overlapping entry gets none.
    reason: overlaps && row.evidence_kind === "queryId" ? ctStripNumbers(row.reason) : row.reason,
    measured: `${iso(row.measured_from)}~${iso(row.measured_to)}${overlaps ? " · 이 연구의 개발·최종 구간과 겹쳐 수치 비공개" : ""}`,
    run: row.run_id.startsWith("seed:") ? row.run_id : row.run_id.slice(0, 8),
    ...(detail ? { detail } : {}),
    overlaps,
  };
}

const MAX_ENTRIES = 40;
/**
 * The playbook the designer starts a run with: same market, most recent first (1-minute runs before the
 * daily seeds), at most 40 entries, never the run itself. Also the market's cumulative test count.
 */
export async function ctPlaybookSnapshot(ownerId: string, contract: CTContract, runId: string, options: { distinctTests?: boolean } = {}): Promise<CTPlaybookSnapshot> {
  await backfillPlaybook();
  const db = ctDb();
  const rows = await db
    .prepare("SELECT * FROM ct_playbook WHERE market=? AND (owner_id=? OR owner_id='') AND run_id<>? ORDER BY (timeframe<>'daily') DESC, recorded_at DESC, id LIMIT 400")
    .bind(contract.market, ownerId, runId)
    .all<PlaybookRow>();
  const seen = new Set<string>();
  const entries: CTPlaybookSnapshot["entries"] = [];
  let omitted = 0;
  for (const row of rows.results) {
    const key = `${row.mechanism}|${row.structure}|${row.grade}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (entries.length >= MAX_ENTRIES) {
      omitted++;
      continue;
    }
    const { overlaps: _overlaps, ...view } = ctPlaybookView(row, contract);
    void _overlaps;
    entries.push(view);
  }
  const runs = await db
    .prepare("SELECT timeframe,hypothesis_tests FROM ct_playbook_runs WHERE market=? AND (owner_id=? OR owner_id='') AND run_id<>?")
    .bind(contract.market, ownerId, runId)
    .all<{ timeframe: string; hypothesis_tests: number }>();
  const minute = runs.results.filter((r) => r.timeframe !== "daily");
  const rawTests = minute.reduce((s, r) => s + r.hypothesis_tests, 0);
  return {
    entries,
    // Stage 4 counts DISTINCT signatures across earlier runs (a signature a rerun counted again is not a new test).
    cumulativeTests: options.distinctTests ? (await ctDistinctPriorTests(ownerId, contract.market, runId)).total : rawTests,
    priorRuns: minute.length,
    omitted,
    ...(runs.results.some((r) => r.timeframe === "daily")
      ? { dailyTests: runs.results.filter((r) => r.timeframe === "daily").reduce((s, r) => s + r.hypothesis_tests, 0) }
      : {}),
  };
}

/**
 * Hypothesis tests of the owner's earlier 1-minute runs on a market, counted once per distinct ledger signature.
 * A run with a ledger contributes its signatures; an older run without one contributes its recorded count.
 * (Stage 4 rule: a rerun's ledger counts a signature again for the rerun itself, but the cumulative count over runs does not add it twice.)
 */
export async function ctDistinctPriorTests(ownerId: string, market: string, runId: string, own?: string[]) {
  const db = ctDb();
  const priorRuns = "SELECT run_id FROM ct_playbook_runs WHERE market=? AND (owner_id=? OR owner_id='') AND timeframe<>'daily' AND run_id<>?";
  const signed = await db
    .prepare(`SELECT DISTINCT j.key AS sig FROM strategy_generation_runs r, json_each(r.payload,'$.ct.tests.signatures') j WHERE r.id IN (${priorRuns})`)
    .bind(market, ownerId, runId)
    .all<{ sig: string }>();
  const unsigned = await db
    .prepare(`SELECT COALESCE(SUM(hypothesis_tests),0) AS n FROM ct_playbook_runs WHERE market=? AND (owner_id=? OR owner_id='') AND timeframe<>'daily' AND run_id<>? AND run_id NOT IN (SELECT r.id FROM strategy_generation_runs r, json_each(r.payload,'$.ct.tests.signatures') j)`)
    .bind(market, ownerId, runId)
    .first<{ n: number }>();
  const prior = new Set(signed.results.map((r) => r.sig));
  const extra = own ? own.filter((sig) => !prior.has(sig)).length : 0;
  return { distinctSignatures: prior.size, unsignedRuns: unsigned?.n ?? 0, total: prior.size + (unsigned?.n ?? 0), withOwn: prior.size + (unsigned?.n ?? 0) + extra };
}

/** The owner's read-only list: every entry of one market with the numbers the same leak rule allows against `contract`. */
export async function ctPlaybookList(ownerId: string, market: string, contract?: Pick<CTContract, "trainingToMs" | "toMs">) {
  await backfillPlaybook();
  const db = ctDb();
  const rows = await db
    .prepare("SELECT * FROM ct_playbook WHERE market=? AND (owner_id=? OR owner_id='') ORDER BY (timeframe<>'daily') DESC, recorded_at DESC, id LIMIT 500")
    .bind(market, ownerId)
    .all<PlaybookRow>();
  const runs = await db
    .prepare("SELECT run_id,hypothesis_tests,timeframe,note,recorded_at FROM ct_playbook_runs WHERE market=? AND (owner_id=? OR owner_id='') ORDER BY recorded_at DESC")
    .bind(market, ownerId)
    .all<{ run_id: string; hypothesis_tests: number; timeframe: string; note: string; recorded_at: number }>();
  // Without a run to compare against, the list is shown as it would be to a run starting now: windows reaching today count as overlapping.
  const against = contract ?? { trainingToMs: Date.now() - 86_400_000 * 0.4 * 365, toMs: Date.now() };
  return {
    entries: rows.results.map((r) => ({ ...ctPlaybookView(r, against), source: r.source })),
    runs: runs.results.map((r) => ({ runId: r.run_id.startsWith("seed:") ? r.run_id : r.run_id.slice(0, 8), tests: r.hypothesis_tests, timeframe: r.timeframe, note: r.note, at: new Date(r.recorded_at).toISOString() })),
    cumulativeTests: runs.results.filter((r) => r.timeframe !== "daily").reduce((s, r) => s + r.hypothesis_tests, 0),
  };
}

/** For tests and the rule text of a stored candidate. */
export const ctCandidateText = (c: CTCandidate) => ctRuleText(c.spec);
