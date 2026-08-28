export type BacktestInput = {
  hypothesisId: string;
  years: number;
  initialCapital: number;
  transactionCostBps: number;
};

export type EquityPoint = { label: string; strategy: number; benchmark: number };

export type BacktestResult = {
  id: string;
  periodStart: string;
  periodEnd: string;
  annualReturn: number;
  maxDrawdown: number;
  sharpe: number;
  winRate: number;
  finalValue: number;
  benchmarkReturn: number;
  trades: number;
  equity: EquityPoint[];
  mode: "illustrative";
};

function hashSeed(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number) {
  let state = seed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function runIllustrativeBacktest(input: BacktestInput): BacktestResult {
  const now = new Date();
  const start = new Date(now);
  start.setUTCFullYear(now.getUTCFullYear() - input.years);
  const months = Math.max(12, input.years * 12);
  const random = seededRandom(hashSeed(`${input.hypothesisId}:${input.years}`));
  let strategy = input.initialCapital;
  let benchmark = input.initialCapital;
  let peak = strategy;
  let maxDrawdown = 0;
  let wins = 0;
  let sumReturns = 0;
  let sumSquares = 0;
  const equity: EquityPoint[] = [];

  for (let month = 0; month <= months; month += 1) {
    if (month > 0) {
      const cycle = Math.sin(month / 5.2) * 0.006;
      const gross = 0.0102 + cycle + (random() - 0.5) * 0.055;
      const cost = input.transactionCostBps / 10000 / 3;
      const monthlyReturn = gross - cost;
      const benchmarkMonthly = 0.008 + Math.sin(month / 7.4) * 0.004 + (random() - 0.5) * 0.043;
      strategy *= 1 + monthlyReturn;
      benchmark *= 1 + benchmarkMonthly;
      peak = Math.max(peak, strategy);
      maxDrawdown = Math.min(maxDrawdown, strategy / peak - 1);
      if (monthlyReturn > 0) wins += 1;
      sumReturns += monthlyReturn;
      sumSquares += monthlyReturn * monthlyReturn;
    }
    if (month % Math.max(1, Math.round(months / 24)) === 0 || month === months) {
      const pointDate = new Date(start);
      pointDate.setUTCMonth(start.getUTCMonth() + month);
      equity.push({
        label: pointDate.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
        strategy: Math.round(strategy),
        benchmark: Math.round(benchmark),
      });
    }
  }

  const average = sumReturns / months;
  const variance = Math.max(0.000001, sumSquares / months - average * average);
  const annualReturn = Math.pow(strategy / input.initialCapital, 12 / months) - 1;
  const benchmarkReturn = Math.pow(benchmark / input.initialCapital, 12 / months) - 1;

  return {
    id: crypto.randomUUID(),
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: now.toISOString().slice(0, 10),
    annualReturn: Number(annualReturn.toFixed(4)),
    maxDrawdown: Number(maxDrawdown.toFixed(4)),
    sharpe: Number(((average / Math.sqrt(variance)) * Math.sqrt(12)).toFixed(2)),
    winRate: Number((wins / months).toFixed(3)),
    finalValue: Math.round(strategy),
    benchmarkReturn: Number(benchmarkReturn.toFixed(4)),
    trades: Math.round(months * 3.4),
    equity,
    mode: "illustrative",
  };
}
