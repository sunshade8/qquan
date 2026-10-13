/**
 * CT ceiling: is there ANY after-cost edge in this playing field? (docs/research/ct-ceiling-*.md)
 *
 * No models, no money. For each combination of cost × holding cap × data range it
 *  1. labels every minute (enter next open; +3×cost before −1×cost within the cap, day-bounded),
 *  2. measures the base rate,
 *  3. trains a depth-3 tree on the 10 DSL features at 1m/1h/1d scale + time of day and scores it
 *     walk-forward (≥4 expanding folds, purged at the seam) on the realised after-cost outcome.
 *
 *   node --env-file-if-exists=.dev.vars --experimental-strip-types scripts/research/ct-ceiling.ts \
 *        [--only=btc|nvda] [--k=3] [--m=1] [--measured-cost=0.2002] [--out=docs/research/ct-ceiling-2026-10-14.md]
 */
import { writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { queryLocalMarket } from "../../lib/local-market-data.ts";
import type { CTBar } from "../../lib/ct-engine.ts";
import { ctRoundTripCostPct } from "../../lib/ct-engine.ts";
import { baseRate, dayInfo, labelMoves, moveFeatures, walkForward } from "../../lib/ct-moves.ts";
import { writeOut } from "./_load.ts";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const K = Number(args.k ?? 3),
  M = Number(args.m ?? 1),
  DAY = 86_400_000;
const outPath = args.out ?? `docs/research/ct-ceiling-${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)}.md`;

const stockCosts = { feePct: 0.1, sellTaxPct: 0.0008, spreadPct: 0.05, slippagePct: 0.03 },
  cryptoCosts = { feePct: 0.1, sellTaxPct: 0, spreadPct: 0.05, slippagePct: 0.03 };
const current = {
  crypto: ctRoundTripCostPct({ costs: cryptoCosts } as never),
  stock: ctRoundTripCostPct({ costs: stockCosts } as never),
};

/** Measured crypto round trip: 2 × Binance fee (0.1%, official) + 2 × p90 per-side impact of a $1,000 order. */
function measuredCrypto() {
  if (args["measured-cost"]) return { cost: Number(args["measured-cost"]), note: "CLI" };
  const file = join(process.env.QQUAN_DATA_DIR || join(homedir(), ".qquan"), "state", "research.sqlite");
  if (!existsSync(file)) return { cost: 0.2, note: "no samples: fee only" };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT buy_bp,sell_bp FROM ct_orderbook_samples WHERE venue='binance' AND symbol='BTCUSDT' AND notional_usd=1000").all() as Array<{ buy_bp: number | null; sell_bp: number | null }>;
    const sides = rows.flatMap((r) => [r.buy_bp, r.sell_bp]).filter((x): x is number => x !== null).sort((a, b) => a - b);
    if (!sides.length) return { cost: 0.2, note: "no samples: fee only" };
    const p90 = sides[Math.floor(sides.length * 0.9)];
    return { cost: 0.2 + (2 * p90) / 100, note: `${rows.length} snapshots, p90 side impact ${p90.toFixed(4)} bp` };
  } finally {
    db.close();
  }
}

async function load(dataset: "btc" | "stock", symbol: string, from: number, to: number): Promise<CTBar[]> {
  const bars: CTBar[] = [];
  for (let cursor = from; cursor < to; cursor += 31 * DAY) {
    const page = await queryLocalMarket({
      dataset,
      instrument: symbol,
      quoteCurrency: dataset === "stock" ? "USD" : "USDT",
      from: cursor,
      to: Math.min(to, cursor + 31 * DAY),
      minutes: 1,
      session: dataset === "stock" ? "regular" : "all",
    });
    bars.push(...page.bars);
  }
  // Pages are disjoint, but make sure.
  const seen = new Set<number>();
  return bars.filter((b) => (seen.has(b.endMs) ? false : (seen.add(b.endMs), true))).sort((a, b) => a.endMs - b.endMs);
}

type Row = {
  data: string;
  market: string;
  costLabel: string;
  costPct: number;
  hold: string;
  days: number;
  entries: number;
  positiveShare: number;
  positivesPerDay: number;
  unconditionalNetPct: number;
  trades: number;
  tradesPerDay: number;
  meanNetPct: number;
  dailyMeanPct: number;
  dailyMean2xPct: number;
  dailyT: number;
  positiveFolds: number;
  bestTrainLeafNetPct: number;
  splits: number;
  leaves: string[];
  seconds: number;
};
const rows: Row[] = [];
let tests = 0;

async function runDataset(market: "crypto" | "stock", label: string, symbol: string, bars: CTBar[], costs: Array<[string, number]>) {
  const t0 = Date.now();
  const day = dayInfo(bars, market);
  const features = moveFeatures(bars, day, market, symbol);
  console.error(`  [${label}] ${bars.length} bars, ${new Set(day.key).size} days, features ${features.names.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const stride = bars.length > 800_000 ? 6 : bars.length > 300_000 ? 3 : 2;
  for (const [costLabel, costPct] of costs) {
    for (const [holdLabel, hold] of [["60봉", 60], ["240봉", 240], ["390봉", 390], ["당일 청산", Infinity]] as const) {
      const s = Date.now();
      const labels = labelMoves(bars, day, { costPct, k: K, m: M, holdBars: hold });
      const base = baseRate(labels, day, costPct);
      const wf = walkForward({ bars, day, labels, features, costPct, folds: 4, depth: 3, trainStride: stride });
      tests += 4 * features.names.length;
      rows.push({
        data: label,
        market,
        costLabel,
        costPct,
        hold: holdLabel,
        days: base.days,
        entries: base.valid,
        positiveShare: base.positiveShare,
        positivesPerDay: base.positivesPerDay,
        unconditionalNetPct: base.unconditionalNetPct,
        trades: wf.trades,
        tradesPerDay: wf.tradesPerDay,
        meanNetPct: wf.meanNetPct,
        dailyMeanPct: wf.dailyMeanPct,
        dailyMean2xPct: wf.dailyMean2xPct,
        dailyT: wf.dailyT,
        positiveFolds: wf.positiveFolds,
        bestTrainLeafNetPct: wf.bestTrainLeafNetPct,
        splits: wf.candidateSplits,
        leaves: [...new Set(wf.folds.flatMap((f) => f.selectedLeaves))],
        seconds: (Date.now() - s) / 1000,
      });
      const r = rows.at(-1)!;
      console.error(`    ${label} · ${costLabel} ${costPct.toFixed(3)}% · ${holdLabel}: base ${(r.positiveShare * 100).toFixed(1)}% · trades ${r.trades} (${r.tradesPerDay.toFixed(2)}/일) · 거래당 ${r.meanNetPct.toFixed(3)}% · 일평균 ${r.dailyMeanPct.toFixed(4)}% (2x ${r.dailyMean2xPct.toFixed(4)}%) · 양수 폴드 ${r.positiveFolds}/4 · ${r.seconds.toFixed(0)}s`);
    }
  }
}

const f = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : "—");
function markdown(meta: { btcRange: string; nvdaRange: string; measured: { cost: number; note: string } }) {
  const lines: string[] = [];
  const table = (subset: Row[]) => {
    lines.push("| 데이터 | 비용(왕복) | 보유 | 진입점 | 양성 비율 | 양성/일 | 무조건 진입 거래당(%) | 선택 거래/일 | 거래당 순(%) | 일평균 순(%) | 비용 2배 일평균(%) | 일평균 t | 양수 폴드 | 학습 최고 잎 거래당(%) |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const r of subset)
      lines.push(
        `| ${r.data} | ${r.costLabel} ${f(r.costPct)}% | ${r.hold} | ${r.entries.toLocaleString("en-US")} | ${f(r.positiveShare * 100, 1)}% | ${f(r.positivesPerDay, 2)} | ${f(r.unconditionalNetPct)} | ${f(r.tradesPerDay, 2)} | ${f(r.meanNetPct)} | ${f(r.dailyMeanPct, 4)} | ${f(r.dailyMean2xPct, 4)} | ${f(r.dailyT, 2)} | ${r.positiveFolds}/4 | ${f(r.bestTrainLeafNetPct)} |`,
      );
  };
  lines.push(`# CT 천장 측정 (${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)})`);
  lines.push("");
  lines.push("이 판(1분봉 롱 전용 단타, 비용 후)에 우위가 존재할 수 있는가의 상한을 모델 비용 0으로 잰 결과다. 생성: `scripts/research/ct-ceiling.ts`, 함수: `lib/ct-moves.ts`.");
  lines.push("");
  lines.push("## 방법");
  lines.push("");
  lines.push(`- **라벨**: 1분봉 매 시점 t에 t+1 시가 진입을 가정한다. 보유 상한 H(당일 경계를 넘지 않음) 안에서 수익이 +${K}×왕복비용에 먼저 닿고 −${M}×왕복비용에 닿지 않았으면 양성이다. 같은 봉에서 둘 다 닿으면 손절 먼저, 불리한 갭은 시가 체결(엔진 \`ctExit\`와 같음). 코인의 하루는 UTC 00:00(KST 09:00), 주식은 정규장 종료이며 마지막 1분 봉은 신규 진입·청산에 쓰지 않는다(\`ctSessionClosing\`과 같은 규칙).`);
  lines.push("- **실현 결과**: 같은 규칙(손절 −m×비용, 목표 +k×비용, 보유 상한 또는 당일 마감 종가 청산)으로 체결했을 때의 총수익에서 왕복 비용을 뺀 값. 라벨과 결과가 한 번의 순회에서 나온다.");
  lines.push("- **피처 31개**: DSL 10개 × {1분 30봉, 1시간 24봉, 일봉 10봉} + 시간대(분). 상위 봉은 완성된 것만 쓴다. 주식 1분 피처는 세션 안 연속 봉만, 상위 봉은 이전 세션까지 이어 쓴다.");
  lines.push(`- **검증**: 깊이 ≤ 3 분류 트리(잎 최소 표본 = 학습 구간 일수 이상, 학습 표본은 N분마다 1개). 전체 기간을 일 단위로 5블록으로 나눠 **확장 창 워크포워드 4폴드**(블록 0..f 학습 → 블록 f+1 검증, 검증 블록 시작 전에 닫히지 않은 학습 거래는 제외). 잎은 **학습** 구간의 평균 순결과가 양수일 때 선택. 검증 구간에서 포지션 하나씩 순서대로 거래한다.`);
  lines.push("- **지표**: 거래당 순수익(%)은 포지션 명목 대비. 일평균은 검증 구간 모든 날(무거래일 0)의 일별 거래 순수익 합의 평균(포지션 명목 100% 기준; 계약의 배분 25%면 ×0.25). \"비용 2배\" 열은 같은 거래를 왕복 비용 2배로 다시 계산한 값이다.");
  lines.push("- **학습 최고 잎**: 각 폴드의 학습 구간(표본 내)에서 가장 좋았던 잎의 거래당 평균 순결과의 최댓값. 0보다 작으면 이 피처로는 학습 구간에서조차 비용을 넘는 잎이 없었다는 뜻이며(그래서 선택 거래가 0), 이 값이 이 판의 표본 내 천장이다.");
  lines.push("- **비용 행**: 현재 계약 비용 / 실측 프로필 / 각각의 2배(라벨의 임계값도 그 비용으로 다시 계산).");
  lines.push(`- 데이터: 코인 BTCUSDT ${meta.btcRange}, NVDA ${meta.nvdaRange}. 코인 실측 왕복 비용 ${f(meta.measured.cost, 4)}% = 수수료 0.1%×2 + 실측 호가 충격(${meta.measured.note}); 주식은 호가 실측이 없어 현재 계약 비용(Toss)만 쓴다.`);
  lines.push("");
  const verdictRows = rows.filter((r) => /^(현재|실측)$/.test(r.costLabel));
  const positive2x = verdictRows.filter((r) => r.dailyMean2xPct > 0);
  const positive1x = rows.filter((r) => r.dailyMeanPct > 0);
  lines.push("## 결론");
  lines.push("");
  lines.push(
    positive2x.length
      ? `비용 2배에서도 검증 구간 일평균이 양수인 조합이 ${positive2x.length}개 있다(현재·실측 비용 조합 ${verdictRows.length}개 중): ${positive2x.map((r) => `${r.data}/${r.costLabel}/${r.hold}(2배 일평균 ${f(r.dailyMean2xPct, 4)}%, 거래 ${f(r.tradesPerDay, 2)}/일, 양수 폴드 ${r.positiveFolds}/4)`).join(", ")}. 반복 검정 ${tests.toLocaleString("en-US")}건(아래) 가운데의 결과이므로 이 숫자는 우연일 수 있다 — 표본·폴드 안정성과 함께 읽어야 한다.`
      : `**비용 2배 워크포워드 일평균이 양수인 조합은 없다**(현재·실측 비용 조합 ${verdictRows.length}개 전부 음수 또는 거래 없음). 1배 비용에서 일평균이 양수인 조합은 ${positive1x.length}개(전체 ${rows.length}개 중)다.`,
  );
  lines.push("");
  const withTrades = rows.filter((r) => r.trades > 0),
    inSample = rows.filter((r) => r.bestTrainLeafNetPct > 0),
    least = withTrades.length ? withTrades.reduce((a, b) => (b.dailyMeanPct > a.dailyMeanPct ? b : a)) : null;
  lines.push(
    `조합 ${rows.length}개 중 학습 구간에서 비용 후 양수인 잎을 골라 거래한 조합은 ${withTrades.length}개이고, 그중 검증 구간 일평균이 양수인 조합은 ${withTrades.filter((r) => r.dailyMeanPct > 0).length}개다${least ? `(가장 덜 나쁜 조합: ${least.data}/${least.costLabel}/${least.hold}, 거래 ${least.trades}건, 일평균 ${f(least.dailyMeanPct, 4)}%)` : ""}. 표본 내(학습 구간)에서 비용 후 거래당 평균이 양수인 잎이 있었던 조합은 ${inSample.length}개(최대 ${f(Math.max(...rows.map((r) => r.bestTrainLeafNetPct)), 3)}%)이므로, 표본 내 우위는 흔히 보이지만 표본 밖으로 이어지지 않는다 — 학습 구간의 양수는 증거가 되지 못한다. 무조건 진입(아무 규칙도 없이 매 분 진입)의 거래당 비용 후 평균은 ${f(Math.min(...rows.map((r) => r.unconditionalNetPct)))}~${f(Math.max(...rows.map((r) => r.unconditionalNetPct)))}%다.`,
  );
  lines.push("");
  lines.push(`반복 검정 수: 조합 ${rows.length}개 × 폴드 4 × 피처 31 = **${tests.toLocaleString("en-US")}건**의 (조합, 폴드, 피처) 후보 분할이고, 트리가 실제로 평가한 후보 분할 임계값은 합계 ${rows.reduce((s, r) => s + r.splits, 0).toLocaleString("en-US")}개다. 조합 수를 늘려 숫자를 좋게 만들지 않았다.`);
  lines.push("");
  for (const [title, market] of [["코인 (BTCUSDT)", "crypto"], ["주식 (NVDA)", "stock"]] as const) {
    const subset = rows.filter((r) => r.market === market);
    if (!subset.length) continue;
    lines.push(`## ${title}`);
    lines.push("");
    table(subset);
    lines.push("");
  }
  lines.push("## 선택된 잎 (학습 구간에서 비용 후 평균이 양수였던 규칙; 검증 일평균이 높은 순 8개 조합)");
  lines.push("");
  for (const r of rows.filter((x) => x.leaves.length).sort((a, b) => b.dailyMeanPct - a.dailyMeanPct).slice(0, 8)) {
    lines.push(`- ${r.data} · ${r.costLabel} · ${r.hold} (검증 일평균 ${f(r.dailyMeanPct, 4)}%, 거래 ${r.trades}건): ${r.leaves.slice(0, 3).join(" ｜ ")}`);
  }
  lines.push("");
  lines.push("## 한계");
  lines.push("");
  lines.push("- 단일 얕은 트리·31개 피처·3:1 고정 손익비의 결과다. 피처를 더 만들거나 손익비·보유를 바꾸면 다른 결과가 나올 수 있다 — 이 보고서는 \"이 단순한 설정으로는 우위가 없다\"는 상한 측정이고 어떤 규칙도 없다는 증명이 아니다.");
  lines.push("- 비용은 계약 비용 또는 실측 프로필이며, 신호 봉 종가와 체결 사이의 지연·역선택은 없다(체결은 다음 봉 시가). 실측 왕복 비용은 가산식(수수료×2 + 충격×2)이라 계약의 곱셈식(0.1998%)과 0.0002%p 다르다.");
  lines.push("- 일평균은 포지션 명목 100% 기준이고 거래는 한 번에 하나, 검증 구간 첫 날 이전의 주식 데이터(2024-10 이전)는 로컬에 없다.");
  lines.push("");
  lines.push("원본 JSON: `~/.qquan/research/out/ct-ceiling.json`.");
  return lines.join("\n");
}

const end = Math.floor(Number(args.end ?? Date.parse("2026-10-12T00:00:00Z")) / DAY) * DAY;
const measured = measuredCrypto();
console.error(`end ${new Date(end).toISOString()} · current ${JSON.stringify(current)} · measured ${JSON.stringify(measured)}`);
const only = args.only;
let btcRange = "—",
  nvdaRange = "—";
if (!only || only === "btc") {
  const full = await load("btc", "BTCUSDT", end - 1095 * DAY, end);
  console.error(`BTCUSDT loaded: ${full.length} bars (${new Date(full[0].startMs).toISOString().slice(0, 10)} → ${new Date(full.at(-1)!.endMs).toISOString().slice(0, 10)})`);
  btcRange = `${new Date(full[0].startMs).toISOString().slice(0, 10)} → ${new Date(full.at(-1)!.endMs).toISOString().slice(0, 10)}`;
  const costs: Array<[string, number]> = [
    ["현재", current.crypto],
    ["실측", measured.cost],
    ["현재×2", current.crypto * 2],
    ["실측×2", measured.cost * 2],
  ];
  for (const [label, days] of [["BTC 180일", 180], ["BTC 1년", 365], ["BTC 3년", 1095]] as const)
    await runDataset("crypto", label, "BTCUSDT", full.filter((b) => b.startMs >= end - days * DAY), costs);
}
if (!only || only === "nvda") {
  const full = await load("stock", "NVDA", Date.parse("2024-10-12T00:00:00Z"), end);
  console.error(`NVDA loaded: ${full.length} bars (${new Date(full[0].startMs).toISOString().slice(0, 10)} → ${new Date(full.at(-1)!.endMs).toISOString().slice(0, 10)})`);
  nvdaRange = `${new Date(full[0].startMs).toISOString().slice(0, 10)} → ${new Date(full.at(-1)!.endMs).toISOString().slice(0, 10)}`;
  const costs: Array<[string, number]> = [
    ["현재", current.stock],
    ["현재×2", current.stock * 2],
  ];
  await runDataset("stock", "NVDA 180일", "NVDA", full.filter((b) => b.startMs >= end - 180 * DAY), costs);
  await runDataset("stock", "NVDA 전체", "NVDA", full, costs);
}
writeOut("ct-ceiling.json", { rows, tests, current, measured, K, M });
writeFileSync(outPath, markdown({ btcRange, nvdaRange, measured }) + "\n");
console.error(`wrote ${outPath} · ${rows.length} cells · ${tests} (cell,fold,feature) tests`);
