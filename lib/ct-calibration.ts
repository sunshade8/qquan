/**
 * Calibration records (stage 4): how well the designer's EYE reads charts on a market, kept apart from the
 * playbook's trading-idea rows.
 *
 * Why a table of its own and not a playbook "kind": a playbook row is a mechanism with a grade ("rejected_in_training")
 * that the next run is told to avoid. A blind-set result is not a mechanism — it is a measurement of a tool, with its own
 * fields (n, hits, p-value, power) and its own reading ("8 charts cannot tell"). Run `bcf289ab` filed "6 of 8, p = 0.145"
 * as a rejected trading idea; the next two runs then skipped charts entirely. Separate rows cannot be read as a mechanism.
 *
 * Leak rule: like every cross-run memory, a record whose measured window overlaps the new run's development/final window
 * shows only its verdict and size, never hits or p.
 */
import { ctDb } from "./ct-data.ts";
import { ctBinomialUpperP, ctCalibrationFacts, ctCalibrationVerdict, type CTCalibrationVerdict } from "./ct-trader-tools.ts";
import type { CTContract } from "./ct-spec.ts";
import type { CTResearch } from "./ct-research.ts";
import type { GenerationJob } from "./strategy-generation-types.ts";

/** Chart rendering format of blind sets drawn until 2026-10-14: three panels, 1,420 × 456, the decision time printed in the header and on the clock ticks. */
export const CT_CHART_FORMAT = "ct-chart-1";
/** Stage-4 blind sets: the same panels with the decision time and clock ticks hidden (relative minutes), so the designer cannot match a chart to the times it chose. */
export const CT_CHART_FORMAT_BLIND = "ct-chart-2-blind";

export const CT_CALIBRATION_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ct_calibration (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,run_id TEXT NOT NULL,market TEXT NOT NULL,symbols TEXT NOT NULL,blind_id TEXT NOT NULL,n INTEGER NOT NULL,k INTEGER NOT NULL,p_value REAL NOT NULL,verdict TEXT NOT NULL,power70 REAL NOT NULL,power75 REAL NOT NULL,needed_hits INTEGER NOT NULL,measured_from INTEGER NOT NULL,measured_to INTEGER NOT NULL,chart_format TEXT NOT NULL,source TEXT NOT NULL,recorded_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_ct_calibration_market ON ct_calibration (market, recorded_at)",
] as const;

export type CalibrationRow = {
  id: string;
  owner_id: string;
  run_id: string;
  market: string;
  symbols: string;
  blind_id: string;
  n: number;
  k: number;
  p_value: number;
  verdict: CTCalibrationVerdict;
  power70: number;
  power75: number;
  needed_hits: number;
  measured_from: number;
  measured_to: number;
  chart_format: string;
  source: string;
  recorded_at: number;
};

/** The record of one graded blind set. Deterministic id, so recording twice changes nothing. */
export function ctCalibrationRow(job: Pick<GenerationJob, "id" | "ownerId">, ct: Pick<CTResearch, "contract">, blindId: string, graded: { correct: number; total: number; pValue?: number }, source: "research" | "migrated", chartFormat: string = CT_CHART_FORMAT, now = Date.now()): CalibrationRow {
  const c = ct.contract;
  const facts = ctCalibrationFacts(graded.total, graded.correct);
  return {
    id: `${job.id}:blind:${blindId}`,
    owner_id: job.ownerId,
    run_id: job.id,
    market: c.market,
    symbols: JSON.stringify(c.symbols),
    blind_id: blindId,
    n: graded.total,
    k: graded.correct,
    p_value: Number(ctBinomialUpperP(graded.total, graded.correct, 0.5).toPrecision(3)),
    verdict: facts.verdict,
    power70: facts.powerIfEyeIs70Pct,
    power75: facts.powerIfEyeIs75Pct,
    needed_hits: facts.neededHitsForSignificance,
    measured_from: c.fromMs,
    measured_to: c.trainingToMs,
    chart_format: chartFormat,
    source,
    recorded_at: now,
  };
}
const COLUMNS = "id,owner_id,run_id,market,symbols,blind_id,n,k,p_value,verdict,power70,power75,needed_hits,measured_from,measured_to,chart_format,source,recorded_at";
export async function ctRecordCalibration(row: CalibrationRow) {
  await ctDb()
    .prepare(`INSERT OR IGNORE INTO ct_calibration (${COLUMNS}) VALUES (${COLUMNS.split(",").map(() => "?").join(",")})`)
    .bind(...COLUMNS.split(",").map((c) => row[c as keyof CalibrationRow]))
    .run();
}

/** True when a hypothesis' evidence consists only of blind-set ids of this run: it is about the eye, not a trading idea. */
export function ctIsCalibrationHypothesis(evidence: string[], blinds: Record<string, unknown> | undefined) {
  return evidence.length > 0 && !!blinds && evidence.every((id) => id in blinds);
}

/**
 * One-time (idempotent) migration of what stage 3 filed as trading ideas:
 *  1. every graded blind set of every run becomes a calibration record;
 *  2. the playbook rows whose only evidence is a blind-set id (`<run>:rej:<session>:<k>`) are deleted.
 * `ctPlaybookRows` no longer produces such rows, so re-running the playbook backfill cannot bring them back.
 */
export async function ctMigrateCalibration() {
  const db = ctDb();
  const runs = await db
    .prepare("SELECT payload FROM strategy_generation_runs WHERE json_extract(payload,'$.ct.version')=1 AND json_extract(payload,'$.ct.blinds') IS NOT NULL")
    .all<{ payload: string }>();
  let records = 0,
    removed = 0;
  for (const r of runs.results) {
    const job = JSON.parse(r.payload) as GenerationJob;
    const ct = job.ct;
    if (!ct?.blinds) continue;
    for (const set of Object.values(ct.blinds)) {
      if (!set.graded) continue;
      await ctRecordCalibration(ctCalibrationRow(job, ct, set.blindId, set.graded, "migrated"));
      records++;
    }
    const rows = await db.prepare("SELECT id,evidence_kind,evidence_ref FROM ct_playbook WHERE run_id=? AND id LIKE ?").bind(job.id, `${job.id}:rej:%`).all<{ id: string; evidence_kind: string; evidence_ref: string }>();
    for (const row of rows.results) {
      const ids = row.evidence_ref.split(",").filter(Boolean);
      if (row.evidence_kind === "queryId" && ctIsCalibrationHypothesis(ids, ct.blinds)) {
        await db.prepare("DELETE FROM ct_playbook WHERE id=?").bind(row.id).run();
        removed++;
      }
    }
  }
  return { records, removed };
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const overlaps = (row: { measured_from: number; measured_to: number }, contract: Pick<CTContract, "trainingToMs" | "toMs">) =>
  row.measured_to > contract.trainingToMs && row.measured_from < contract.toMs;

export type CTCalibrationView = {
  run: string;
  /** "시각 표시" = the charts printed the decision time (the designer could have matched them to its own list); "시각 숨김" = stage-4 blind charts. */
  chartFormat: string;
  symbols: string[];
  n: number;
  verdict: CTCalibrationVerdict;
  reading: string;
  measured: string;
  /** Present only when the record's window does not overlap this run's development/final window. */
  hits?: number;
  accuracyPct?: number;
  pValue?: number;
  neededHits?: number;
  powerIfEyeIs70Pct?: number;
};
export type CTCalibrationSnapshot = {
  note: string;
  records: CTCalibrationView[];
  /** All non-overlapping sets of this market pooled (same chart format): more charts, more power. */
  pooled: { sets: number; n: number; hits: number; accuracyPct: number; pValue: number; verdict: CTCalibrationVerdict; powerIfEyeIs70Pct: number } | null;
};

const READING: Record<CTCalibrationVerdict, string> = {
  skill: "눈에 신호가 있었다",
  no_skill: "눈에 신호가 없었다(표본이 충분했다)",
  inconclusive: "표본이 작아 판정 불가 — '판별력 없음'이 아니다",
};

/** Calibration records the designer starts a stage-4 run with (frozen in the run, like the playbook). */
export async function ctCalibrationSnapshot(ownerId: string, contract: Pick<CTContract, "market" | "trainingToMs" | "toMs">, runId: string): Promise<CTCalibrationSnapshot> {
  const rows = await ctDb()
    .prepare("SELECT * FROM ct_calibration WHERE market=? AND owner_id=? AND run_id<>? ORDER BY recorded_at DESC, id LIMIT 40")
    .bind(contract.market, ownerId, runId)
    .all<CalibrationRow>();
  // Only sets drawn with the decision time hidden are pooled: a set whose charts printed the time could be matched to the designer's own list of times.
  const open = rows.results.filter((r) => !overlaps(r, contract) && r.chart_format === CT_CHART_FORMAT_BLIND);
  const n = open.reduce((s, r) => s + r.n, 0),
    hits = open.reduce((s, r) => s + r.k, 0);
  const facts = n ? ctCalibrationFacts(n, hits) : null;
  return {
    note: "설계자의 '눈'(차트 판독)을 블라인드 세트로 잰 보정 기록(합산은 결정 시각을 숨긴 세트만). 거래 아이디어의 기각이 아니라 도구 보정이다. 검정력이 낮은 작은 세트의 p가 큰 것은 '판별력 없음'이 아니라 '알 수 없음'이다. 수치는 이 연구의 개발·최종 구간과 겹치지 않는 측정에만 있다.",
    records: rows.results.slice(0, 12).map((r) => {
      const hide = overlaps(r, contract);
      return {
        run: r.run_id.slice(0, 8),
        chartFormat: r.chart_format === CT_CHART_FORMAT_BLIND ? "시각 숨김" : "시각 표시(식별 누출 가능성 · 합산하지 않음)",
        symbols: JSON.parse(r.symbols) as string[],
        n: r.n,
        verdict: r.verdict,
        reading: READING[r.verdict],
        measured: `${iso(r.measured_from)}~${iso(r.measured_to)}${hide ? " · 이 연구의 개발·최종 구간과 겹쳐 수치 비공개" : ""}`,
        ...(hide ? {} : { hits: r.k, accuracyPct: Number(((r.k / r.n) * 100).toFixed(1)), pValue: r.p_value, neededHits: r.needed_hits, powerIfEyeIs70Pct: r.power70 }),
      };
    }),
    pooled: facts
      ? { sets: open.length, n, hits, accuracyPct: Number(((hits / n) * 100).toFixed(1)), pValue: Number(ctBinomialUpperP(n, hits, 0.5).toPrecision(3)), verdict: ctCalibrationVerdict(n, hits), powerIfEyeIs70Pct: facts.powerIfEyeIs70Pct }
      : null,
  };
}

/** The owner's read-only list for the playbook screen. */
export async function ctCalibrationList(ownerId: string, market: string) {
  const rows = await ctDb().prepare("SELECT * FROM ct_calibration WHERE market=? AND owner_id=? ORDER BY recorded_at DESC, id LIMIT 100").bind(market, ownerId).all<CalibrationRow>();
  return rows.results.map((r) => ({
    run: r.run_id.slice(0, 8),
    symbols: JSON.parse(r.symbols) as string[],
    blindId: r.blind_id,
    n: r.n,
    hits: r.k,
    pValue: r.p_value,
    verdict: r.verdict,
    reading: READING[r.verdict],
    neededHits: r.needed_hits,
    powerIfEyeIs70Pct: r.power70,
    measured: `${iso(r.measured_from)}~${iso(r.measured_to)}`,
    chartFormat: r.chart_format,
    source: r.source,
  }));
}
