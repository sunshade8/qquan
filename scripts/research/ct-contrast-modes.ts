/**
 * Stage 4 real-data check (no models, no money): run the designer's contrast_moves request of run 3ab2ad6c on the same
 * BTCUSDT training window in all three control groups and print the lift tables with their shapes.
 *
 *   node --env-file-if-exists=.dev.vars --experimental-strip-types --no-warnings scripts/research/ct-contrast-modes.ts [--out=docs/research/ct-contrast-modes-2026-10-14.md]
 */
import { writeFileSync } from "node:fs";
import { queryLocalMarket } from "../../lib/local-market-data.ts";
import type { CTBar } from "../../lib/ct-engine.ts";
import { CT_ENGINE, CT_POLICY, type CTContract } from "../../lib/ct-spec.ts";
import { ctRunLabels, ctLabelMovesSchema, ctContrastMoves, ctContrastMovesSchema, ctLoserEvents } from "../../lib/ct-trader-tools.ts";
import { ctProfileCosts } from "../../lib/ct-costs.ts";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"]; }));
const DAY = 86_400_000;
// The window of run 3ab2ad6c (BTCUSDT, 365 days, training = first 60%).
const fromMs = 1760313600000, trainingToMs = 1779235200000, developmentToMs = 1785542400000, toMs = 1791849600000;
const priced = ctProfileCosts("crypto", ["BTCUSDT"], 1000);
const contract = { market: "crypto", symbols: ["BTCUSDT"], minutes: 1, fromMs, trainingToMs, developmentToMs, toMs, currency: "USDT", timezone: "UTC", capital: 1000, costs: priced.costs, costProfile: priced.costProfile, policy: CT_POLICY, engine: CT_ENGINE, createdAt: new Date().toISOString(), selection: "script" } as CTContract;

const bars: CTBar[] = [];
for (let cursor = fromMs; cursor < trainingToMs; cursor += 31 * DAY) {
  const page = await queryLocalMarket({ dataset: "btc", instrument: "BTCUSDT", quoteCurrency: "USDT", from: cursor, to: Math.min(trainingToMs, cursor + 31 * DAY), minutes: 1, session: "all" });
  bars.push(...page.bars);
}
console.error(`${bars.length} training bars`);
const params = ctLabelMovesSchema.parse({ k: 5, m: 2, horizon: 240, costMultiplier: 1 });
const t0 = Date.now();
const runs = ctRunLabels(params, { BTCUSDT: bars }, contract);
const run = runs[0];
console.error(`labels ${((Date.now() - t0) / 1000).toFixed(1)}s · valid ${run.validMoments} · positive moments ${run.positiveMoments} · events ${run.events.length} · loser events ${ctLoserEvents(run).length}`);
const features = [
  { feature: "return_pct", lookback: 7, offset: 0, timeframe: 1440 },
  { feature: "range_position", lookback: 20, offset: 0, timeframe: 1440 },
  { feature: "atr_percentile", lookback: 30, offset: 0, timeframe: 60 },
  { feature: "contraction_ratio", lookback: 40, offset: 0, timeframe: 3 },
  { feature: "prev_day_close_distance_pct", lookback: 2, offset: 0, timeframe: 1 },
  { feature: "vwap_distance_pct", lookback: 2, offset: 0, timeframe: 1, unit: "atr", atrLookback: 24, atrTimeframe: 60 },
  { feature: "return_pct", lookback: 4, offset: 0, timeframe: 60, unit: "atr", atrLookback: 24, atrTimeframe: 60 },
  { feature: "volume_ratio", lookback: 60, offset: 0, timeframe: 1 },
];
const lines: string[] = [];
const out = (s = "") => { lines.push(s); console.log(s); };
out(`# contrast_moves 세 대조군 비교 · BTCUSDT 학습 구간 ${new Date(fromMs).toISOString().slice(0, 10)}~${new Date(trainingToMs).toISOString().slice(0, 10)}`);
out(`라벨 k5 · m2 · 240봉 · 비용 1배(왕복 ${(priced.costs.feePct * 2 + priced.costs.spreadPct + priced.costs.slippagePct).toFixed(4)}%) · 사건 ${run.events.length}건 · 음성(손절 먼저) 사건 ${ctLoserEvents(run).length}건 · 특징은 3ab2ad6c의 contrast 요청 8개와 같다. 모델 비용 $0.`);
const results: Record<string, ReturnType<typeof ctContrastMoves>> = {};
for (const controls of ["time", "vol_matched", "losers"] as const) {
  const s = Date.now();
  const request = ctContrastMovesSchema.parse({ labelId: "28d1ba31e99b13ee", features, controls, tree: true, seed: 1 });
  const r = ctContrastMoves(request, params, runs, contract);
  results[controls] = r;
  out();
  out(`## 대조군 \`${controls}\` — 사건 ${r.events}건 · 대조군 ${r.controls}개 (사건당 ${r.controlsPerEvent}) · 버린 사건 ${r.droppedEvents}건 · ${((Date.now() - s) / 1000).toFixed(1)}초`);
  out();
  out("| 특징 | 모양 | 하위 20% | 20–40% | 40–60% | 60–80% | 상위 20% |");
  out("| --- | --- | --- | --- | --- | --- | --- |");
  for (const f of r.features) out(`| ${f.feature} | **${f.shape}** | ${f.bins.map((b) => `${b.lift ?? "—"} (z ${b.z})`).join(" | ")} |`);
  if (r.tree) {
    out();
    out(`트리(깊이 3, 앞 2/3로 성장·뒤 1/3로 재측정): 학습 행 ${r.tree.trainRows} · 홀드아웃 행 ${r.tree.holdoutRows} · 잎 ${r.tree.leaves.length}개`);
    out();
    out("| 잎 | 학습 lift | 홀드아웃 lift | 홀드아웃 n | 홀드아웃 순평균(%) |");
    out("| --- | ---: | ---: | ---: | ---: |");
    for (const l of r.tree.leaves.slice(0, 6)) out(`| ${l.rule} | ${l.train.lift} | ${l.holdout.lift} | ${l.holdout.n} | ${l.holdout.net} |`);
  } else out("\n(트리: 표본 부족으로 생략)");
}
const shapes = (m: string) => results[m].features.map((f) => `${f.feature.split("(")[0]}:${f.shape}`).join(" ");
out();
out("## 모양 요약");
for (const m of ["time", "vol_matched", "losers"]) out(`- ${m}: ${shapes(m)}`);
if (args.out) writeFileSync(args.out, lines.join("\n") + "\n");
