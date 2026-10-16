import { z } from "zod";
import { ctDb, ctSnapshotFor } from "./t-data.ts";
import { queryLocalMarket } from "./local-market-data.ts";
import { ctDatasetFor } from "./t-symbols.ts";
import { ctHash, CT_ENGINE, type CTContract, type CTSpec } from "./t-spec.ts";
import { replayCT, type CTBar, type CTResult } from "./t-engine.ts";
import {
  ctBaselinePolicy,
  CT_BASELINE_VERSIONS,
  type CTDecision,
} from "./t-decision-playbooks.ts";
import {
  CT_COMPARISON_PLAN,
  ctDailyMetrics,
  ctPairedVerdict,
} from "./t-experiment-stats.ts";
import { ensureCTSchema, prepareCTContract } from "./t-research-store.ts";
import { getGenerationJob } from "./t-generation-store.ts";
const DAY = 86400000;
export const CT_EXPERIMENT_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS t_experiments(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,market TEXT NOT NULL,status TEXT NOT NULL,manifest TEXT NOT NULL,manifest_hash TEXT NOT NULL,next_ms INTEGER NOT NULL,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS t_experiment_days(experiment_id TEXT NOT NULL,day TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(experiment_id,day))",
  "CREATE TABLE IF NOT EXISTS t_decision_events(experiment_id TEXT NOT NULL,arm TEXT NOT NULL,decision_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(experiment_id,arm,decision_id))",
  "CREATE INDEX IF NOT EXISTS t_experiments_owner ON t_experiments(owner_id,market,created_at)",
];
export async function ensureCTExperiments() {
  await ensureCTSchema();
  await ctDb().batch(CT_EXPERIMENT_SCHEMA.map((s) => ctDb().prepare(s)));
}
export const ctExperimentRequest = z
  .object({
    requestId: z.string().uuid(),
    market: z.enum(["stock", "crypto"]),
    runId: z.string().optional(),
    baseline: z.string(),
    changed: z.string(),
    change: z.string().min(3).max(500),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    split: z.enum(["development", "final"]).default("development"),
    maxDays: z.number().int().min(1).max(90).default(30),
  })
  .strict();
export type CTExperimentManifest = {
  contract: CTContract;
  baseline: string;
  changed: string;
  change: string;
  diff: Record<string, { before: unknown; after: unknown }>;
  comparisonKind: "single-change" | "whole-configuration";
  from: number;
  to: number;
  split: "development" | "final";
  plan: typeof CT_COMPARISON_PLAN;
  versions: {
    model: "deterministic-no-llm";
    tools: "ct-decision-1";
    memory: "empty-scoped-v1";
    product: "v0.0";
  };
  modelBudgetUsd: 0;
  computeBudgetMs: number;
  armHashes: string[];
  seed: number;
  dataSnapshot: string[];
  frozenAt: string;
};
export type CTExperimentRow = {
  id: string;
  owner_id: string;
  market: string;
  status: string;
  manifest: string;
  manifest_hash: string;
  next_ms: number;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};
export type CTExperimentDay = {
  day: string;
  arms: Array<{
    version: string;
    result: CTResult;
    stress?: CTResult;
    delayed?: CTResult;
    decisions: CTDecision[];
  }>;
  bars: CTBar[];
  snapshot: string;
};
const version = (id: string) => {
  const v = CT_BASELINE_VERSIONS.find((v) => v.id === id);
  if (!v) throw new Error("알 수 없는 불변 정책 버전");
  return v;
};
export async function createCTExperiment(owner: string, input: unknown) {
  await ensureCTExperiments();
  const req = ctExperimentRequest.parse(input);
  const existing = await ctDb()
    .prepare("SELECT * FROM t_experiments WHERE id=? AND owner_id=?")
    .bind(req.requestId, owner)
    .first<CTExperimentRow>();
  if (existing) return existing;
  const source = req.runId ? await getGenerationJob(req.runId) : null;
  if (
    req.runId &&
    (!source?.ct ||
      source.ownerId !== owner ||
      source.ct.contract.market !== req.market)
  )
    throw new Error("연구 소유권/시장 불일치");
  const c =
    source?.ct?.contract ??
    (await prepareCTContract({
      requestId: req.requestId,
      market: req.market,
      days: 365,
      budgetUsd: 8,
    }));
  if (!c.dataSnapshot) throw new Error("불변 snapshot 자료 준비 필요");
  const a = version(req.baseline),
    b = version(req.changed),
    start = req.split === "final" ? c.developmentToMs : c.trainingToMs,
    end = req.split === "final" ? c.toMs : c.developmentToMs;
  const from = req.from ? Date.parse(req.from) : start,
    to = req.to
      ? Date.parse(req.to) + DAY
      : Math.min(end, from + req.maxDays * DAY);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from < start ||
    to > end ||
    to <= from ||
    to - from > 90 * DAY
  )
    throw new Error("고정 평가 구간 범위 오류");
  if (c.symbols.length !== 1)
    throw new Error("현재 비교 프로파일은 선택 instrument 1개입니다");
  const diff: CTExperimentManifest["diff"] = {};
  for (const k of Object.keys(a.config) as Array<keyof typeof a.config>)
    if (a.config[k] !== b.config[k])
      diff[k] = { before: a.config[k], after: b.config[k] };
  const manifest: CTExperimentManifest = {
    contract: c,
    baseline: a.id,
    changed: b.id,
    change: req.change,
    diff,
    comparisonKind:
      Object.keys(diff).length <= 1 ? "single-change" : "whole-configuration",
    from,
    to,
    split: req.split,
    plan: CT_COMPARISON_PLAN,
    versions: {
      model: "deterministic-no-llm",
      tools: "ct-decision-1",
      memory: "empty-scoped-v1",
      product: "v0.0",
    },
    modelBudgetUsd: 0,
    computeBudgetMs: 1200000,
    armHashes: await Promise.all([ctHash(a), ctHash(b)]),
    seed: 20261016,
    dataSnapshot: c.symbols.map((s) => ctSnapshotFor(c, s)!),
    frozenAt: new Date().toISOString(),
  };
  const hash = await ctHash(manifest),
    now = Date.now();
  // Reserve both arms as ONE exposure. Existing single-run exposures also block this atomic INSERT.
  if (req.split === "final") {
    await ctDb()
      .prepare(
        "INSERT OR IGNORE INTO t_exposure SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM t_exposure e JOIN json_each(e.symbols) s WHERE e.market=? AND e.from_ms<? AND e.to_ms>? AND e.run_id<>? AND s.value IN (SELECT value FROM json_each(?)))",
      )
      .bind(
        req.requestId,
        c.market,
        JSON.stringify(c.symbols),
        from,
        to,
        hash,
        c.market,
        to,
        from,
        req.requestId,
        JSON.stringify(c.symbols),
      )
      .run();
    const exposure = await ctDb()
      .prepare("SELECT frozen_hash FROM t_exposure WHERE run_id=?")
      .bind(req.requestId)
      .first<{ frozen_hash: string }>();
    if (exposure?.frozen_hash !== hash)
      throw new Error(
        "겹치는 최종 구간이 이미 소진됐습니다. 새 전향 자료가 필요합니다",
      );
  }
  await ctDb()
    .prepare(
      "INSERT OR IGNORE INTO t_experiments(id,owner_id,market,status,manifest,manifest_hash,next_ms,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      req.requestId,
      owner,
      c.market,
      "running",
      JSON.stringify(manifest),
      hash,
      from,
      now,
      now,
    )
    .run();
  return getCTExperiment(owner, req.requestId);
}
export async function getCTExperiment(owner: string, id: string) {
  await ensureCTExperiments();
  return ctDb()
    .prepare("SELECT * FROM t_experiments WHERE id=? AND owner_id=?")
    .bind(id, owner)
    .first<CTExperimentRow>();
}
export async function listCTExperiments(owner: string, market: string) {
  await ensureCTExperiments();
  const r = await ctDb()
    .prepare(
      "SELECT * FROM t_experiments WHERE owner_id=? AND market=? ORDER BY created_at DESC LIMIT 100",
    )
    .bind(owner, market)
    .all<CTExperimentRow>();
  return r.results;
}
export async function ctExperimentDays(owner: string, id: string) {
  if (!(await getCTExperiment(owner, id))) throw new Error("비교 없음");
  const r = await ctDb()
    .prepare(
      "SELECT payload FROM t_experiment_days WHERE experiment_id=? ORDER BY day",
    )
    .bind(id)
    .all<{ payload: string }>();
  return r.results.map((r) => JSON.parse(r.payload) as CTExperimentDay);
}
export async function controlCTExperiment(
  owner: string,
  id: string,
  action: "pause" | "resume" | "cancel",
) {
  const row = await getCTExperiment(owner, id);
  if (!row) throw new Error("비교 없음");
  if (row.status === "completed" || row.status === "cancelled")
    throw new Error("완료/취소한 비교는 수정할 수 없습니다");
  await ctDb()
    .prepare(
      "UPDATE t_experiments SET status=?,error=NULL,updated_at=? WHERE id=? AND owner_id=?",
    )
    .bind(
      action === "pause"
        ? "paused"
        : action === "resume"
          ? "running"
          : "cancelled",
      Date.now(),
      id,
      owner,
    )
    .run();
  return getCTExperiment(owner, id);
}
function baselineSpec(c: CTContract): CTSpec {
  return {
    version: 1,
    engine: CT_ENGINE,
    name: "동결 기준 A/B",
    market: c.market,
    symbols: c.symbols,
    minutes: 1,
    stages: [
      {
        label: "상태형 셋업",
        maxGapBars: 1,
        conditions: [
          {
            feature: "return_pct",
            lookback: 2,
            offset: 0,
            timeframe: 1,
            op: "gte",
            value: 0,
          },
        ],
      },
    ],
    entry: {
      order: "marketable_limit",
      validBars: 1,
      maxSpreadPct: 1,
      maxDeviationPct: 2,
      noEntryBeforeDayEndMinutes: 5,
    },
    exit: {
      stopPct: 0.6,
      targetPct: 1.2,
      maxHoldBars: 60,
      invalidation: "last_stage_low",
    },
    sizing: {
      riskPct: 0.5,
      allocationPct: 25,
      maxPositions: 1,
      cooldownBars: 5,
      participationPct: 1,
    },
    sourceIds: ["fixed-baseline-hypothesis"],
    assumptions: ["사전 고정된 검증 기준 가설, 수익성 주장 없음"],
  };
}
export async function advanceCTExperiment(owner: string, id: string) {
  const row = await getCTExperiment(owner, id);
  if (!row || row.status !== "running") return row;
  const lease = crypto.randomUUID(),
    now = Date.now(),
    claim = await ctDb()
      .prepare(
        "UPDATE t_experiments SET lease=?,lease_until=?,updated_at=? WHERE id=? AND status='running' AND lease_until<?",
      )
      .bind(lease, now + 300000, now, id, now)
      .run();
  if (!claim.meta.changes) return row;
  try {
    const m = JSON.parse(row.manifest) as CTExperimentManifest;
    if ((await ctHash(m)) !== row.manifest_hash)
      throw new Error("실험 manifest 변경 감지");
    const from = row.next_ms,
      to = Math.min(m.to, Math.floor(from / DAY + 1) * DAY),
      symbol = m.contract.symbols[0];
    const p = await queryLocalMarket({
      dataset: ctDatasetFor(m.contract.market, symbol),
      instrument: symbol,
      quoteCurrency: m.contract.currency,
      from: Math.max(m.contract.fromMs, from - 2 * DAY),
      to,
      minutes: 1,
      session: m.contract.market === "stock" ? "regular" : "all",
      snapshot: ctSnapshotFor(m.contract, symbol),
    });
    const history = await ctExperimentDays(owner, id),
      arms: CTExperimentDay["arms"] = [];
    for (const [index, vid] of [m.baseline, m.changed].entries()) {
      const policy = ctBaselinePolicy(
        symbol,
        version(vid),
        id,
        String(index),
        m.contract.market,
      );
      for (const bar of p.bars.filter((b) => b.endMs <= from))
        policy.observe(bar);
      policy.decisions.length = 0;
      const barsByTime = new Map(p.bars.map((b) => [b.endMs, b])),
        capital =
          history.at(-1)?.arms[index].result.daily.at(-1)?.equity ??
          m.contract.capital;
      const result = replayCT(
        baselineSpec(m.contract),
        { [symbol]: p.bars },
        { ...m.contract, capital },
        from,
        to,
        m.armHashes[index],
        {
          accountState: history.at(-1)?.arms[index].result.accountState ?? {
            peakEquity: m.contract.capital,
            maxDrawdownPct: 0,
          },
          deadline: now + m.computeBudgetMs,
          policy: {
            observe: (at) => {
              const b = barsByTime.get(at);
              if (b) policy.observe(b);
            },
            signal: () => policy.signal(),
            exit: () => false,
          },
        },
      );
      if (result.status === "data_error")
        throw new Error(result.diagnostics.join(" · "));
      for (const d of policy.decisions)
        d.inputHash = await ctHash({
          instrument: symbol,
          snapshot: p.snapshot,
          observedThrough: d.observedThrough,
          bars: p.bars.filter(
            (b) =>
              b.endMs <= d.observedThrough &&
              b.endMs > d.observedThrough - 60 * 60000,
          ),
          setup: d.setup,
        });
      const stressReplay = (kind: "stress" | "delayed") => {
        const alt = ctBaselinePolicy(
          symbol,
          version(vid),
          id,
          `${index}:${kind}`,
          m.contract.market,
        );
        for (const b of p.bars.filter((b) => b.endMs <= from)) alt.observe(b);
        const capital =
          history.at(-1)?.arms[index][kind]?.daily.at(-1)?.equity ??
          m.contract.capital;
        return replayCT(
          baselineSpec(m.contract),
          { [symbol]: p.bars },
          { ...m.contract, capital },
          from,
          to,
          m.armHashes[index],
          {
            accountState: history.at(-1)?.arms[index][kind]?.accountState ?? {
              peakEquity: m.contract.capital,
              maxDrawdownPct: 0,
            },
            deadline: now + m.computeBudgetMs,
            ...(kind === "stress" ? { costMultiplier: 2 } : { delayBars: 1 }),
            policy: {
              observe: (at) => {
                const b = barsByTime.get(at);
                if (b) alt.observe(b);
              },
              signal: () => alt.signal(),
              exit: () => false,
            },
          },
        );
      };
      arms.push({
        version: vid,
        result,
        stress: stressReplay("stress"),
        delayed: stressReplay("delayed"),
        decisions: policy.decisions,
      });
    }
    const day = new Date(from).toISOString().slice(0, 10),
      payload: CTExperimentDay = {
        day,
        arms,
        bars: p.bars.filter((b) => b.startMs >= from),
        snapshot: p.snapshot,
      };
    // Guard every write with the current lease; stale executors cannot append or checkpoint.
    const statements = [
      ctDb()
        .prepare(
          "INSERT OR IGNORE INTO t_experiment_days SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM t_experiments WHERE id=? AND lease=? AND status=?)",
        )
        .bind(id, day, JSON.stringify(payload), id, lease, "running"),
      ...arms.flatMap((a, i) =>
        a.decisions.map((d) =>
          ctDb()
            .prepare(
              "INSERT OR IGNORE INTO t_decision_events SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM t_experiments WHERE id=? AND lease=? AND status=?)",
            )
            .bind(
              id,
              String(i),
              d.decisionId,
              JSON.stringify(d),
              id,
              lease,
              "running",
            ),
        ),
      ),
    ];
    for (let offset = 0; offset < statements.length; offset += 50)
      await ctDb().batch(statements.slice(offset, offset + 50));
    const complete = to >= m.to;
    let result: unknown = null;
    if (complete) {
      const days = [...history, payload],
        a = days.flatMap((d) => d.arms[0].result.daily),
        b = days.flatMap((d) => d.arms[1].result.daily),
        trades = days.reduce((n, d) => n + d.arms[1].result.trades.length, 0),
        safe =
          days.every(
            (d) =>
              d.arms[1].result.maxDrawdownPct <= 15 &&
              d.arms[1].result.compliancePct === 100,
          ) && ctDailyMetrics(b).meanDailyPct > 0;
      // Cost/delay stresses are mandatory for improvement, so an unmeasured stress keeps the verdict pending.
      const stressSafe =
        days.every((d) => !!d.arms[1].stress && !!d.arms[1].delayed) &&
        days.reduce((s, d) => s + (d.arms[1].stress?.netReturnPct ?? 0), 0) >
          0 &&
        days.reduce((s, d) => s + (d.arms[1].delayed?.netReturnPct ?? 0), 0) >
          0;
      result = {
        ...ctPairedVerdict(a, b, {
          safe: safe && stressSafe,
          trades,
          completed: true,
        }),
        safety: { absolute: safe, stress: stressSafe ? "통과" : "미달/미측정" },
        baseline: ctDailyMetrics(a, m.contract.market === "stock" ? 252 : 365),
        changed: ctDailyMetrics(b, m.contract.market === "stock" ? 252 : 365),
        modelCostUsd: 0,
        days: days.length,
      };
    }
    await ctDb()
      .prepare(
        "UPDATE t_experiments SET next_ms=?,status=?,result=?,lease=NULL,lease_until=0,updated_at=? WHERE id=? AND lease=? AND status=?",
      )
      .bind(
        to,
        complete ? "completed" : "running",
        result ? JSON.stringify(result) : null,
        Date.now(),
        id,
        lease,
        "running",
      )
      .run();
  } catch (e) {
    await ctDb()
      .prepare(
        "UPDATE t_experiments SET status=?,error=?,lease=NULL,lease_until=0,updated_at=? WHERE id=? AND lease=?",
      )
      .bind(
        "failed",
        e instanceof Error ? e.message : String(e),
        Date.now(),
        id,
        lease,
      )
      .run();
  }
  return getCTExperiment(owner, id);
}
