/**
 * The per-bar overview (traderTools 5, 2026-10-16): the cost hurdle and the label_moves base rate on every bar the
 * designer may choose, measured once by the server on the TRAINING split and put in the cached stable context.
 *
 * Why: the first free-bar run (7a4354f4) used only 15-minute bars and twice declined to relabel on 60-minute bars because
 * each label/contrast adds tests to the ledger. This table has no thresholds and no condition — it is the market itself
 * at each bar size — so it is not a hypothesis test and never enters the ledger; comparing bars costs nothing.
 *
 * Every number comes from the code the tools already run: ctHurdleSample (cost_hurdle) on ctDataAt(data, bar) with a
 * contract view whose `minutes` is that bar, and ctRunLabels (label_moves) with barMinutes = bar.
 */
import { ctDataAt, ctRoundTripCostPct, type CTBar } from "./t-engine.ts";
import { ctBarAllowed, ctBarChoices, type CTContract } from "./t-spec.ts";
import { CT_VOL_REGIMES, ctHurdleHits, ctHurdleMean, ctHurdleMedian, ctHurdleQuantiles, ctHurdleSample, type HurdleRow } from "./t-design-tools.ts";
import { ctRunLabels, type CTLabelParams } from "./t-trader-tools.ts";

const DAY_MS = 86_400_000;
const round = (n: number, digits = 4) => (Number.isFinite(n) ? Number(n.toFixed(digits)) : 0);

/** Holding times compared across bars, in minutes (0 = until the day's last tradable bar). A bar shows those that are whole multiples of it. */
export const CT_OVERVIEW_HOLD_MINUTES = { crypto: [5, 15, 60, 240, 720, 0], stock: [5, 15, 60, 240, 0] } as const;
/** label_moves' own defaults: target 3 × cost before stop 1 × cost, held to the day's last tradable bar. */
export const CT_OVERVIEW_LABEL: CTLabelParams = { k: 3, m: 1, horizon: "day_end", costMultiplier: 1 };
/** Entries every 5 minutes on one-minute bars (the cost_hurdle stride), every bar on coarser bars. */
export const ctOverviewStride = (bar: number) => Math.max(1, Math.round(5 / bar));
/** The horizons (bars) the overview measures on a bar: the hold minutes that are whole multiples of it, then 0. */
export function ctOverviewHorizons(bar: number, market: CTContract["market"]) {
  return CT_OVERVIEW_HOLD_MINUTES[market].filter((m) => m === 0 || (m >= bar && m % bar === 0)).map((m) => m / bar);
}

export const CT_OVERVIEW_COLUMNS = {
  horizons: ["holdMinutes", "holdBars", "n", "mfeP25", "mfeP50", "mfeP75", "mfeP90", "maeP50", "retMean", "hit1x", "hit2x", "hit3x"],
  byTime: ["bucket", "holdMinutes", "n", "mfeP50", "hit1x", "hit2x", "hit3x"],
  byVolatility: ["regime", "holdMinutes", "n", "mfeP50", "hit1x", "hit2x", "hit3x"],
} as const;

export function ctBarOverview(data: Record<string, CTBar[]>, contract: CTContract) {
  const cost = ctRoundTripCostPct(contract);
  const days = Math.max(1, Math.round((contract.trainingToMs - contract.fromMs) / DAY_MS));
  const hits = (row: HurdleRow) => [ctHurdleHits(row, cost, 1), ctHurdleHits(row, cost, 2), ctHurdleHits(row, cost, 3)];
  const bars = ctBarChoices(contract.market).filter((bar) => ctBarAllowed(contract, bar)).map((bar) => {
    const view: CTContract = { ...contract, minutes: bar as CTContract["minutes"] };
    const at = ctDataAt(data, bar);
    const horizons = ctOverviewHorizons(bar, contract.market);
    const s = ctHurdleSample(at, view, { horizons, stride: ctOverviewStride(bar) });
    const minutes = (h: number) => h * bar;
    const brief = (row: HurdleRow) => [row.n, ctHurdleMedian(row.mfe), ...hits(row)];
    const runs = ctRunLabels({ ...CT_OVERVIEW_LABEL, barMinutes: bar as 1 | 5 | 15 | 60 }, at, view);
    const valid = runs.reduce((n, r) => n + r.validMoments, 0),
      positive = runs.reduce((n, r) => n + r.positiveMoments, 0),
      events = runs.reduce((n, r) => n + r.events.length, 0);
    const meanRange = s.ranges.reduce((a, b) => a + b, 0) / Math.max(1, s.ranges.length);
    return {
      barMinutes: bar,
      trainingBars: s.ranges.length,
      meanBarRangePct: round(meanRange),
      costToMeanBarRange: round(cost / Math.max(meanRange, 1e-9), 2),
      sampledEntries: s.overall[0].n,
      entryEveryBars: s.stride,
      volatilityWindowMinutes: 60 * bar,
      volatilityCutoffsPct: [round(s.cut[0]), round(s.cut[1])],
      labels: {
        validMoments: valid,
        positivePct: round(valid ? (positive / valid) * 100 : 0, 2),
        events,
        eventsPerDay: round(events / days, 3),
      },
      horizons: s.H.map((h, i) => {
        const q = ctHurdleQuantiles(s.overall[i].mfe, [0.25, 0.5, 0.75, 0.9]);
        return [minutes(h), h, s.overall[i].n, q.p25, q.p50, q.p75, q.p90, ctHurdleMedian(s.overall[i].mae), ctHurdleMean(s.overall[i].ret), ...hits(s.overall[i])];
      }),
      byTime: s.byTime.flatMap(({ bucket, rows }) => s.H.map((h, i) => [bucket, minutes(h), ...brief(rows[i])])),
      byVolatility: CT_VOL_REGIMES.flatMap((regime, r) => s.H.map((h, i) => [regime, minutes(h), ...brief(s.regimes[r][i])])),
    };
  });
  return {
    note:
      "봉별 개요: 서버가 학습 구간에서 한 번 계산 · 임계값·조건 없음(시장 그 자체) · 가설 검정이 아니며 다중 검정 장부에 들어가지 않음(무료) · " +
      "각 봉 크기로 만든 봉의 시가에 진입한다고 가정한 비용 전 총 이동(MFE/MAE/수익, %) · hit1x/2x/3x = MFE가 왕복 비용의 1/2/3배 이상인 진입 비율(%) · " +
      "holdMinutes 0 = 당일 마지막 거래 봉까지(가변) · 변동성 국면 = 그 봉 기준 직전 60봉 범위의 3분위(봉마다 따로, volatilityWindowMinutes) · " +
      `labels = label_moves 기본값(k ${CT_OVERVIEW_LABEL.k} · m ${CT_OVERVIEW_LABEL.m} · 당일 끝까지)으로 잰 양성 순간 비율과 사건 수(같은 봉에서 손절·목표 모두 닿으면 손절)`,
    roundTripCostPct: round(cost),
    columns: CT_OVERVIEW_COLUMNS,
    bars,
  };
}
export type CTBarOverview = ReturnType<typeof ctBarOverview>;
