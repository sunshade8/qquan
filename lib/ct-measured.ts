/**
 * "Already measured on this training data" (stage 4, docs/ct.md「이미 잰 것」).
 *
 * A run that starts on a training window an earlier run of the same owner already measured gets that run's label
 * definitions and contrast requests, with the conclusion the run drew. It is frozen into the run at the start
 * (a tool cache entry, like the playbook), so resuming gives the same stable block.
 *
 * Scope: same owner, market, symbols, research start, training end AND data hash — i.e. exactly the same training data.
 * Only training-split measurements exist in these records, so numbers may be shown (the leak rule is satisfied by construction).
 */
import { ctDb } from "./ct-data.ts";
import type { CTContract } from "./ct-spec.ts";
import type { CTLabelParams } from "./ct-trader-tools.ts";
import type { CTResearch } from "./ct-research.ts";
import type { GenerationJob } from "./strategy-generation-types.ts";

export type CTMeasuredRun = {
  run: string;
  at: string;
  endReason: string | null;
  labels: Array<{ params: CTLabelParams; events: number; eventsPerDay: number; positiveMoments: number; conclusion: string }>;
  contrasts: Array<{ labelParams: CTLabelParams; features: string[]; controls: string; summary: string; topLift: { feature: string; bin: string; lift: number } | null; conclusion: string }>;
};
export type CTMeasuredBefore = { note: string; runs: CTMeasuredRun[] };

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
/** The first sentence of a free-text conclusion, at most `n` characters. */
export function ctFirstSentence(text: string | null | undefined, n = 180) {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  const cut = t.search(/(?<=[.!?。])\s|(?<=다)\.\s/);
  return clip(cut > 0 ? t.slice(0, cut + 1) : t, n);
}
/** The key a label definition is compared by: k · m · horizon · costMultiplier. */
/** One-minute labels keep their historical key; a label on coarser bars (free bars) is a different definition. */
export const ctLabelKey = (p: Pick<CTLabelParams, "k" | "m" | "horizon" | "costMultiplier" | "barMinutes">) =>
  `k${p.k}|m${p.m}|h${p.horizon}|c${p.costMultiplier}${p.barMinutes && p.barMinutes > 1 ? `|b${p.barMinutes}` : ""}`;

/** One finished (or running) run's measurements of this training window, with its own conclusion. */
export function ctMeasuredOfRun(job: Pick<GenerationJob, "id" | "createdAt">, ct: CTResearch): CTMeasuredRun | null {
  const labels = Object.values(ct.labels ?? {});
  if (!labels.length) return null;
  const sessions = ct.sessions ?? [];
  const noEdge = ctFirstSentence([...sessions].reverse().map((s) => s.submission?.noEdgeReason).find(Boolean) ?? ct.endReason ?? "");
  const rejected = sessions.flatMap((s) => s.submission?.rejectedHypotheses ?? []);
  const resultFor = (ids: string[]) => {
    const hit = rejected.find((h) => h.evidence.some((e) => ids.includes(e)));
    return hit ? ctFirstSentence(hit.result, 200) : null;
  };
  return {
    run: job.id.slice(0, 8),
    at: job.createdAt,
    endReason: ct.endReason ?? null,
    labels: labels.map((l) => ({
      params: l.params,
      events: l.events,
      eventsPerDay: l.eventsPerDay,
      positiveMoments: l.positiveMoments,
      conclusion: resultFor((ct.contrasts ?? []).filter((c) => c.labelId === l.labelId).map((c) => c.contrastId)) ?? noEdge,
    })),
    contrasts: (ct.contrasts ?? []).flatMap((c) => {
      const label = ct.labels?.[c.labelId];
      if (!label) return [];
      return [
        {
          labelParams: label.params,
          features: ((c.request?.features ?? c.features) as Array<{ feature: string; timeframe: number; lookback?: number; unit?: string }>).map((f) => (f.lookback ? `${f.feature}(${f.lookback}, ${f.timeframe}m${f.unit === "atr" ? ",ATR" : ""})` : `${f.feature}(${f.timeframe}m)`)),
          controls: c.request?.controls ?? "time",
          summary: c.summary,
          topLift: c.topLift,
          conclusion: resultFor([c.contrastId]) ?? noEdge,
        },
      ];
    }),
  };
}

const MAX_RUNS = 6,
  MAX_ITEMS = 8;
/** Earlier runs on exactly this training data (frozen at the start of a stage-4 run). */
export async function ctMeasuredBefore(job: Pick<GenerationJob, "id" | "ownerId">, contract: CTContract, dataHash: string | undefined): Promise<CTMeasuredBefore> {
  const rows = await ctDb()
    .prepare(
      "SELECT id,created_at,payload FROM strategy_generation_runs WHERE owner_id=? AND id<>? AND json_extract(payload,'$.ct.contract.market')=? AND json_extract(payload,'$.ct.contract.fromMs')=? AND json_extract(payload,'$.ct.contract.trainingToMs')=? AND json_extract(payload,'$.ct.labels') IS NOT NULL ORDER BY created_at DESC LIMIT 40",
    )
    .bind(job.ownerId, job.id, contract.market, contract.fromMs, contract.trainingToMs)
    .all<{ id: string; created_at: number; payload: string }>();
  const runs: CTMeasuredRun[] = [];
  for (const r of rows.results) {
    const old = JSON.parse(r.payload) as GenerationJob;
    const ct = old.ct;
    if (!ct || ct.dataHash !== dataHash || JSON.stringify([...ct.contract.symbols].sort()) !== JSON.stringify([...contract.symbols].sort())) continue;
    const m = ctMeasuredOfRun({ id: r.id, createdAt: new Date(Number(r.created_at)).toISOString() }, ct);
    if (m) runs.push({ ...m, labels: m.labels.slice(0, MAX_ITEMS), contrasts: m.contrasts.slice(0, MAX_ITEMS) });
    if (runs.length >= MAX_RUNS) break;
  }
  return {
    note: "이 학습 데이터(같은 종목·기간·데이터 해시)에서 이전 연구가 이미 잰 라벨 정의와 contrast 요청, 그 연구가 내린 결론. 학습 구간 측정이라 수치를 보여 준다. 같은 정의를 다시 재도 새로 알게 되는 것은 없다(계산은 무료라 막지는 않는다).",
    runs,
  };
}
