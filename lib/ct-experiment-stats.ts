import { ctRng } from "./ct-trader-tools.ts";
export const CT_COMPARISON_PLAN = Object.freeze({
  blockDays: 5,
  replicates: 4000,
  seed: 20261016,
  confidence: 0.95,
  minDays: 30,
  minTrades: 20,
  minImprovementPct: 0,
});
export function ctDailyMetrics(
  daily: Array<{ date: string; equity: number; returnPct: number }>,
  annualDays = 365,
) {
  const xs = daily.map((d) => d.returnPct),
    n = xs.length,
    mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, n),
    variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1);
  const first = daily[0];
  let peak =
      first && first.returnPct > -100
        ? first.equity / (1 + first.returnPct / 100)
        : (first?.equity ?? 0),
    drawdown = 0;
  for (const d of daily) {
    peak = Math.max(peak, d.equity);
    drawdown = Math.max(drawdown, peak > 0 ? (1 - d.equity / peak) * 100 : 0);
  }
  return {
    totalNetReturnPct:
      daily.length && peak > 0
        ? (daily.at(-1)!.equity / (first.equity / (1 + first.returnPct / 100)) -
            1) *
          100
        : 0,
    meanDailyPct: mean,
    positiveDays: xs.filter((x) => x > 0).length,
    negativeDays: xs.filter((x) => x < 0).length,
    emptyDays: xs.filter((x) => x === 0).length,
    positiveDayPct: (xs.filter((x) => x > 0).length / Math.max(1, n)) * 100,
    sharpe:
      variance > 0
        ? (mean / Math.sqrt(variance)) * Math.sqrt(annualDays)
        : null,
    maxDrawdownPct: drawdown,
    worstDayPct: n ? Math.min(...xs) : null,
  };
}
export function ctPairedVerdict(
  a: Array<{ date: string; returnPct: number }>,
  b: Array<{ date: string; returnPct: number }>,
  options: {
    safe: boolean;
    trades: number;
    completed: boolean;
    plan?: typeof CT_COMPARISON_PLAN;
  },
) {
  const plan = options.plan ?? CT_COMPARISON_PLAN;
  if (
    a.length !== b.length ||
    a.some((d, i) => d.date !== b[i].date) ||
    [...a, ...b].some((d) => !Number.isFinite(d.returnPct))
  )
    return {
      verdict: "비교 불가",
      reason: "동일 일자/데이터 정렬 실패",
      mean: null,
      ci: null,
      p: null,
    };
  const xs = a.map((d, i) => b[i].returnPct - d.returnPct),
    n = xs.length,
    mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, n),
    rng = ctRng(plan.seed),
    samples: number[] = [];
  for (let r = 0; r < plan.replicates; r++) {
    let total = 0,
      k = 0;
    while (k < n) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < plan.blockDays && k < n; j++, k++)
        total += xs[(start + j) % n];
    }
    samples.push(total / Math.max(1, n));
  }
  samples.sort((a, b) => a - b);
  const ci = [
      samples[Math.floor(samples.length * 0.025)],
      samples[Math.floor(samples.length * 0.975)],
    ] as [number, number],
    p =
      (samples.filter((x) => x - mean >= mean).length + 1) /
      (samples.length + 1);
  let verdict = "판단 보류",
    reason = "신뢰구간이 최소 개선 폭을 포함합니다";
  if (!options.completed)
    reason = "중단/진행 결과는 선택 편향 가능성이 있어 불완전합니다";
  else if (n < plan.minDays || options.trades < plan.minTrades)
    reason = "독립 일자/거래 표본 부족";
  else if (ci[1] < -plan.minImprovementPct) {
    verdict = "악화 확인";
    reason = "일평균 차이의 신뢰구간 상한이 악화 기준보다 낮습니다";
  } else if (!options.safe) reason = "절대 성과·위험·스트레스 기준 미충족";
  else if (ci[0] > plan.minImprovementPct) {
    verdict = "개선 확인";
    reason = "일평균 차이의 신뢰구간 하한과 안전 기준을 충족합니다";
  }
  return { verdict, reason, mean, ci, p };
}
export function ctHolm(ps: number[]) {
  const sorted = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p),
    out = new Array<number>(ps.length);
  let max = 0;
  sorted.forEach((x, k) => {
    max = Math.max(max, Math.min(1, x.p * (ps.length - k)));
    out[x.i] = max;
  });
  return out;
}
