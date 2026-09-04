/**
 * Daily-return target feasibility math.
 *
 * A "2% a day" goal is not a strategy, it is a constraint on four numbers:
 * risk per trade, reward:risk, trades per day, and win rate. Fix any three and
 * the fourth is determined — usually at a value nobody sustains. This module
 * solves for that fourth number before any data is touched, so an infeasible
 * configuration is rejected by arithmetic rather than by a year of losses.
 *
 * Three deliberate choices:
 *
 * 1. Friction is expressed in R, not basis points. Slippage on a stop-based
 *    intraday rule scales with the stop distance, so "0.1R per trade" survives
 *    a change of instrument in a way that "5bps" does not. It shortens the win
 *    and lengthens the loss, which is exactly how it raises the required edge.
 * 2. The per-day distribution is exact, not simulated. Wins per day are
 *    binomial, so P(day >= target) is a tail sum, and reporting it next to the
 *    *mean* daily return is the point: a positive mean with a 25% hit rate is a
 *    different business from the same mean at 60%.
 * 3. The Monte Carlo compounds within the day and reports drawdown, because the
 *    closed form is additive and therefore silent about the thing that actually
 *    ends accounts.
 */

export type TargetMathInput = {
  targetDailyPct: number;
  riskPerTradePct: number;
  rewardRisk: number;
  tradesPerDay: number;
  /** null asks the solver "what would this have to be?" instead of evaluating. */
  winRatePct: number | null;
  /** Round-trip slippage + fees per trade, in units of the trade's own risk. */
  costPerTradeR: number;
  tradingDaysPerYear: number;
  simulationDays: number;
  simulationRuns: number;
  seed: number;
};

export const TARGET_MATH_DEFAULTS: TargetMathInput = {
  targetDailyPct: 2,
  riskPerTradePct: 0.5,
  rewardRisk: 2,
  tradesPerDay: 4,
  winRatePct: null,
  costPerTradeR: 0.05,
  tradingDaysPerYear: 252,
  simulationDays: 252,
  simulationRuns: 2000,
  seed: 20260905,
};

export type FeasibilityVerdict = "impossible" | "extreme" | "demanding" | "plausible" | "modest";

export const FEASIBILITY_LABELS: Record<FeasibilityVerdict, string> = {
  impossible: "산술적으로 불가능",
  extreme: "현실 표본에서 거의 관측되지 않는 수준",
  demanding: "달성 가능하나 상위권 실력이 지속돼야 함",
  plausible: "검증 대상으로 삼을 만함",
  modest: "요구 승률이 낮음 — 가정이 낙관적인지 먼저 의심",
};

function round(value: number | null, digits = 3) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

function logFactorial(value: number) {
  let total = 0;
  for (let index = 2; index <= value; index += 1) total += Math.log(index);
  return total;
}

/** P(X = wins) for X ~ Binomial(trials, probability), via logs so large n stays stable. */
export function binomialPmf(trials: number, wins: number, probability: number) {
  if (wins < 0 || wins > trials) return 0;
  if (probability <= 0) return wins === 0 ? 1 : 0;
  if (probability >= 1) return wins === trials ? 1 : 0;
  const logCoefficient = logFactorial(trials) - logFactorial(wins) - logFactorial(trials - wins);
  return Math.exp(logCoefficient + wins * Math.log(probability) + (trials - wins) * Math.log(1 - probability));
}

/** P(X >= wins). */
export function binomialTail(trials: number, wins: number, probability: number) {
  if (wins <= 0) return 1;
  let total = 0;
  for (let index = Math.ceil(wins); index <= trials; index += 1) total += binomialPmf(trials, index, probability);
  return Math.min(1, total);
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], ratio: number) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export type TargetMathResult = {
  input: TargetMathInput;
  /** Net win and loss per trade, in R, after friction. */
  netWinR: number;
  netLossR: number;
  /** Total R the day must produce to clear the target. */
  targetDailyR: number;
  requiredRPerTrade: number;
  requiredWinRatePct: number | null;
  breakevenWinRatePct: number;
  edgeOverBreakevenPts: number | null;
  verdict: FeasibilityVerdict;
  /** Populated only when a win rate was supplied. */
  evaluation: {
    winRatePct: number;
    expectedRPerTrade: number;
    expectedDailyPct: number;
    medianDailyPct: number;
    hitTargetRatePct: number;
    losingDayRatePct: number;
    fullLossDayPct: number;
    expectedAnnualPct: number | null;
    kellyRiskPerTradePct: number | null;
    riskVsKelly: "over" | "at" | "under" | "no_edge";
    dayOutcomes: Array<{ wins: number; probabilityPct: number; dayReturnPct: number; meetsTarget: boolean }>;
  } | null;
  /** Compounded path statistics. Populated only when a win rate was supplied. */
  simulation: {
    days: number;
    runs: number;
    medianTerminalMultiple: number;
    p5TerminalMultiple: number;
    p95TerminalMultiple: number;
    medianMaxDrawdownPct: number;
    p95MaxDrawdownPct: number;
    lossRunRatePct: number;
    halvedRatePct: number;
    medianDailyPct: number;
    meanDailyPct: number;
  } | null;
  /** Required win rate across nearby reward:risk and trades-per-day settings. */
  sensitivity: Array<{ rewardRisk: number; tradesPerDay: number; requiredWinRatePct: number | null; feasible: boolean }>;
  notes: string[];
};

function classify(requiredWinRatePct: number | null): FeasibilityVerdict {
  if (requiredWinRatePct === null || requiredWinRatePct > 100) return "impossible";
  if (requiredWinRatePct > 75) return "extreme";
  if (requiredWinRatePct > 65) return "demanding";
  if (requiredWinRatePct > 55) return "plausible";
  return "modest";
}

function requiredWinRate(targetDailyPct: number, riskPerTradePct: number, rewardRisk: number, tradesPerDay: number, costPerTradeR: number) {
  const netWin = rewardRisk - costPerTradeR;
  const netLoss = 1 + costPerTradeR;
  if (netWin <= 0) return null;
  const requiredR = targetDailyPct / riskPerTradePct / tradesPerDay;
  // p * netWin - (1 - p) * netLoss = requiredR  ->  p = (requiredR + netLoss) / (netWin + netLoss)
  return ((requiredR + netLoss) / (netWin + netLoss)) * 100;
}

export function computeTargetMath(partial: Partial<TargetMathInput>): TargetMathResult {
  const input: TargetMathInput = {
    ...TARGET_MATH_DEFAULTS,
    ...partial,
    targetDailyPct: Math.max(0.01, Math.min(50, Number(partial.targetDailyPct ?? TARGET_MATH_DEFAULTS.targetDailyPct))),
    riskPerTradePct: Math.max(0.01, Math.min(25, Number(partial.riskPerTradePct ?? TARGET_MATH_DEFAULTS.riskPerTradePct))),
    rewardRisk: Math.max(0.1, Math.min(20, Number(partial.rewardRisk ?? TARGET_MATH_DEFAULTS.rewardRisk))),
    tradesPerDay: Math.max(1, Math.min(20, Math.round(Number(partial.tradesPerDay ?? TARGET_MATH_DEFAULTS.tradesPerDay)))),
    costPerTradeR: Math.max(0, Math.min(1, Number(partial.costPerTradeR ?? TARGET_MATH_DEFAULTS.costPerTradeR))),
    simulationRuns: Math.max(200, Math.min(5000, Math.round(Number(partial.simulationRuns ?? TARGET_MATH_DEFAULTS.simulationRuns)))),
    simulationDays: Math.max(20, Math.min(1260, Math.round(Number(partial.simulationDays ?? TARGET_MATH_DEFAULTS.simulationDays)))),
  };
  const { targetDailyPct, riskPerTradePct, rewardRisk, tradesPerDay, costPerTradeR } = input;

  const netWinR = rewardRisk - costPerTradeR;
  const netLossR = 1 + costPerTradeR;
  const targetDailyR = targetDailyPct / riskPerTradePct;
  const requiredRPerTrade = targetDailyR / tradesPerDay;
  const rawRequired = requiredWinRate(targetDailyPct, riskPerTradePct, rewardRisk, tradesPerDay, costPerTradeR);
  const requiredWinRatePct = rawRequired === null ? null : round(rawRequired, 2);
  const breakevenWinRatePct = round((netLossR / (netWinR + netLossR)) * 100, 2)!;
  const verdict = classify(requiredWinRatePct);

  const notes: string[] = [];
  notes.push(`목표 ${targetDailyPct}%/일 = 하루 ${round(targetDailyR, 2)}R (거래당 리스크 ${riskPerTradePct}% 기준).`);
  if (netWinR <= 0) notes.push(`손익비 ${rewardRisk}에서 거래당 마찰 ${costPerTradeR}R을 빼면 순이익이 남지 않는다. 어떤 승률로도 불가능.`);
  else if (requiredWinRatePct !== null && requiredWinRatePct > 100) notes.push(`요구 승률 ${requiredWinRatePct}% — 100%를 넘으므로 이 조합으로는 목표에 도달할 수 없다. 손익비나 거래 횟수, 거래당 리스크를 올려야 한다.`);
  notes.push(`마찰 ${costPerTradeR}R은 손익비를 ${rewardRisk} → ${round(netWinR, 3)}로 줄이고 손실을 ${round(netLossR, 3)}R로 늘린다. 손익분기 승률이 ${round((1 / (1 + rewardRisk)) * 100, 2)}%에서 ${breakevenWinRatePct}%로 올라간다.`);

  let evaluation: TargetMathResult["evaluation"] = null;
  let simulation: TargetMathResult["simulation"] = null;

  if (input.winRatePct !== null && Number.isFinite(input.winRatePct)) {
    const winRatePct = Math.max(0, Math.min(100, Number(input.winRatePct)));
    const probability = winRatePct / 100;
    const expectedRPerTrade = probability * netWinR - (1 - probability) * netLossR;
    const expectedDailyPct = expectedRPerTrade * tradesPerDay * riskPerTradePct;

    const dayOutcomes = Array.from({ length: tradesPerDay + 1 }, (_, wins) => {
      const dayR = wins * netWinR - (tradesPerDay - wins) * netLossR;
      return {
        wins,
        probabilityPct: round(binomialPmf(tradesPerDay, wins, probability) * 100, 3)!,
        dayReturnPct: round(dayR * riskPerTradePct, 3)!,
        meetsTarget: dayR * riskPerTradePct >= targetDailyPct - 1e-9,
      };
    });
    // Smallest win count clearing the target: k*netWin - (n-k)*netLoss >= targetR.
    const requiredWins = (targetDailyR + tradesPerDay * netLossR) / (netWinR + netLossR);
    const hitTargetRatePct = binomialTail(tradesPerDay, requiredWins, probability) * 100;
    // Summed straight off the exact per-day outcomes rather than another tail
    // formula, because the boundary case (a day that lands exactly flat) belongs
    // in neither bucket and is easy to get wrong twice.
    const losingDayRatePct = dayOutcomes.filter((outcome) => outcome.dayReturnPct < 0).reduce((sum, outcome) => sum + outcome.probabilityPct, 0);
    const cumulative = dayOutcomes.reduce<Array<{ wins: number; cumulativePct: number }>>((list, outcome) => {
      const previous = list.at(-1)?.cumulativePct ?? 0;
      list.push({ wins: outcome.wins, cumulativePct: previous + outcome.probabilityPct });
      return list;
    }, []);
    const medianWins = cumulative.find((entry) => entry.cumulativePct >= 50)?.wins ?? 0;
    const medianDailyPct = (medianWins * netWinR - (tradesPerDay - medianWins) * netLossR) * riskPerTradePct;

    // Kelly for an asymmetric bet paying b and losing L per unit staked; the
    // reported number is the *risk* at that stake, comparable to riskPerTradePct.
    // Full Kelly is far larger than anyone trades, so "under" is the normal and
    // healthy reading here; "over" is the alarm, because past that point extra
    // risk lowers the long-run growth rate instead of raising it.
    const kellyFraction = (probability * netWinR - (1 - probability) * netLossR) / (netWinR * netLossR);
    const kellyRiskPerTradePct = expectedRPerTrade > 0 ? kellyFraction * netLossR * 100 : null;
    const riskVsKelly: "over" | "at" | "under" | "no_edge" =
      kellyRiskPerTradePct === null ? "no_edge"
        : riskPerTradePct > kellyRiskPerTradePct * 1.05 ? "over"
          : riskPerTradePct < kellyRiskPerTradePct * 0.95 ? "under" : "at";

    evaluation = {
      winRatePct,
      expectedRPerTrade: round(expectedRPerTrade, 4)!,
      expectedDailyPct: round(expectedDailyPct, 4)!,
      medianDailyPct: round(medianDailyPct, 4)!,
      hitTargetRatePct: round(hitTargetRatePct, 2)!,
      losingDayRatePct: round(losingDayRatePct, 2)!,
      fullLossDayPct: round(-tradesPerDay * netLossR * riskPerTradePct, 3)!,
      expectedAnnualPct: null,
      kellyRiskPerTradePct: round(kellyRiskPerTradePct, 3),
      riskVsKelly,
      dayOutcomes,
    };

    simulation = simulate(input, probability, netWinR, netLossR);
    evaluation.expectedAnnualPct = round((Math.pow(simulation.medianTerminalMultiple, input.tradingDaysPerYear / input.simulationDays) - 1) * 100, 2);

    notes.push(`승률 ${winRatePct}%에서 기대 일수익은 ${round(expectedDailyPct, 3)}%지만 목표 ${targetDailyPct}%를 실제로 넘는 날은 ${round(hitTargetRatePct, 1)}%뿐이다. 평균은 소수의 큰 날이 끌어올린다.`);
    if (riskVsKelly === "over") notes.push(`거래당 리스크 ${riskPerTradePct}%는 켈리 최적 ${round(kellyRiskPerTradePct, 2)}%를 넘는다. 기대값이 양수여도 장기 복리 성장률은 오히려 떨어지고 파산 확률이 커진다.`);
    if (expectedRPerTrade <= 0) notes.push(`이 승률에서는 거래당 기대값이 ${round(expectedRPerTrade, 4)}R로 음수다. 목표 이전에 생존이 문제다.`);
  }

  const rewardGrid = [...new Set([1, 1.5, 2, 3, rewardRisk].map((value) => round(value, 2)!))].sort((left, right) => left - right);
  const tradeGrid = [...new Set([1, 2, 4, 6, tradesPerDay])].sort((left, right) => left - right);
  const sensitivity = rewardGrid.flatMap((reward) => tradeGrid.map((trades) => {
    const value = requiredWinRate(targetDailyPct, riskPerTradePct, reward, trades, costPerTradeR);
    return { rewardRisk: reward, tradesPerDay: trades, requiredWinRatePct: round(value, 1), feasible: value !== null && value <= 100 };
  }));

  return {
    input, netWinR: round(netWinR, 4)!, netLossR: round(netLossR, 4)!,
    targetDailyR: round(targetDailyR, 3)!, requiredRPerTrade: round(requiredRPerTrade, 4)!,
    requiredWinRatePct, breakevenWinRatePct,
    edgeOverBreakevenPts: requiredWinRatePct === null ? null : round(requiredWinRatePct - breakevenWinRatePct, 2),
    verdict, evaluation, simulation, sensitivity, notes,
  };
}

function simulate(input: TargetMathInput, probability: number, netWinR: number, netLossR: number) {
  const random = mulberry32(input.seed);
  const riskFraction = input.riskPerTradePct / 100;
  const terminals: number[] = [];
  const drawdowns: number[] = [];
  const dailyReturns: number[] = [];
  let losingRuns = 0;
  let halved = 0;

  for (let run = 0; run < input.simulationRuns; run += 1) {
    let equity = 1;
    let peak = 1;
    let worstDrawdown = 0;
    let touchedHalf = false;
    for (let day = 0; day < input.simulationDays; day += 1) {
      const dayStart = equity;
      for (let trade = 0; trade < input.tradesPerDay; trade += 1) {
        // Risk is sized off current equity, so the path compounds within the day.
        equity *= random() < probability ? 1 + riskFraction * netWinR : 1 - riskFraction * netLossR;
      }
      if (run === 0 || run % 7 === 0) dailyReturns.push((equity / dayStart - 1) * 100);
      peak = Math.max(peak, equity);
      worstDrawdown = Math.max(worstDrawdown, (1 - equity / peak) * 100);
      if (equity <= 0.5) touchedHalf = true;
    }
    terminals.push(equity);
    drawdowns.push(worstDrawdown);
    if (equity < 1) losingRuns += 1;
    if (touchedHalf) halved += 1;
  }

  const sortedTerminals = [...terminals].sort((left, right) => left - right);
  const sortedDrawdowns = [...drawdowns].sort((left, right) => left - right);
  const sortedDaily = [...dailyReturns].sort((left, right) => left - right);
  return {
    days: input.simulationDays,
    runs: input.simulationRuns,
    medianTerminalMultiple: round(quantile(sortedTerminals, 0.5), 4)!,
    p5TerminalMultiple: round(quantile(sortedTerminals, 0.05), 4)!,
    p95TerminalMultiple: round(quantile(sortedTerminals, 0.95), 4)!,
    medianMaxDrawdownPct: round(quantile(sortedDrawdowns, 0.5), 2)!,
    p95MaxDrawdownPct: round(quantile(sortedDrawdowns, 0.95), 2)!,
    lossRunRatePct: round((losingRuns / input.simulationRuns) * 100, 2)!,
    halvedRatePct: round((halved / input.simulationRuns) * 100, 2)!,
    medianDailyPct: round(quantile(sortedDaily, 0.5), 4)!,
    meanDailyPct: round(sortedDaily.reduce((sum, value) => sum + value, 0) / (sortedDaily.length || 1), 4)!,
  };
}

/**
 * Broker fees, translated into the unit the rest of this module works in.
 *
 * A commission quoted as a percentage of notional becomes a fraction of *risk*
 * once a stop is attached, and the conversion is where intraday plans quietly
 * die: the same 0.1%-per-side schedule costs 0.2R against a 1% stop and 0.8R
 * against a 0.25% stop. Tightening the stop to trade smaller does not reduce the
 * fee, it multiplies its weight against the edge — which is why "it beats
 * commission" is not the same test as "it is worth trading".
 */
export type FeeModel = {
  /** Broker commission per side, percent of notional. */
  feePerSidePct: number;
  /** Expected round-trip slippage plus half-spread, percent of notional. */
  slippagePct: number;
  /** Average stop distance, percent of entry price. This is what one R is worth. */
  stopDistancePct: number;
};

export type FeeFloor = {
  model: FeeModel;
  roundTripCostPct: number;
  costPerTradeR: number;
  /** Gross move, in percent of notional, a trade must make just to break even. */
  breakevenMovePct: number;
  /** Breakeven win rate at this reward:risk once the cost is charged. */
  breakevenWinRatePct: number;
  /** The same rate with no costs, for comparison. */
  frictionlessWinRatePct: number;
  winRatePenaltyPts: number;
  notes: string[];
};

export function feeFloor(model: Partial<FeeModel>, rewardRisk = 2): FeeFloor {
  const resolved: FeeModel = {
    feePerSidePct: Math.max(0, Number(model.feePerSidePct ?? 0.1)),
    slippagePct: Math.max(0, Number(model.slippagePct ?? 0.03)),
    stopDistancePct: Math.max(0.01, Number(model.stopDistancePct ?? 1)),
  };
  const roundTripCostPct = resolved.feePerSidePct * 2 + resolved.slippagePct;
  const costPerTradeR = roundTripCostPct / resolved.stopDistancePct;
  const netWin = rewardRisk - costPerTradeR;
  const netLoss = 1 + costPerTradeR;
  const breakevenWinRatePct = netWin > 0 ? (netLoss / (netWin + netLoss)) * 100 : 100;
  const frictionlessWinRatePct = (1 / (1 + rewardRisk)) * 100;
  const notes: string[] = [];
  notes.push(`왕복 비용 ${round(roundTripCostPct, 4)}%를 손절폭 ${resolved.stopDistancePct}%로 나누면 거래당 ${round(costPerTradeR, 4)}R이다.`);
  notes.push(`손익분기 승률이 ${round(frictionlessWinRatePct, 2)}%에서 ${round(breakevenWinRatePct, 2)}%로 올라간다. 이 차이가 수수료가 실제로 요구하는 실력이다.`);
  if (costPerTradeR >= rewardRisk) notes.push("비용이 목표 이익을 통째로 먹는다. 손절폭을 넓히거나 손익비를 키우기 전에는 어떤 승률로도 이 조합은 수익이 나지 않는다.");
  else if (costPerTradeR > 0.25) notes.push("거래당 비용이 0.25R을 넘는다. 손절폭 대비 수수료가 큰 구간이며, 손절을 더 조이면 상황은 나빠진다.");
  return {
    model: resolved,
    roundTripCostPct: round(roundTripCostPct, 4)!,
    costPerTradeR: round(costPerTradeR, 4)!,
    breakevenMovePct: round(roundTripCostPct, 4)!,
    breakevenWinRatePct: round(breakevenWinRatePct, 2)!,
    frictionlessWinRatePct: round(frictionlessWinRatePct, 2)!,
    winRatePenaltyPts: round(breakevenWinRatePct - frictionlessWinRatePct, 2)!,
    notes,
  };
}

export type Tactic = {
  name: string;
  tradesPerDay: number;
  winRatePct: number;
  rewardRisk: number;
  riskPerTradePct: number;
  /** Share of days this tactic finds a setup at all. */
  activeDayRatePct: number;
};

export type TacticScore = {
  name: string;
  expectedRPerTrade: number;
  /** Expected contribution per calendar day, already scaled by how often it fires. */
  expectedDailyPct: number;
  breakevenWinRatePct: number;
  edgeOverBreakevenPts: number;
  /** Expected trades per calendar day, after the active-day discount. */
  effectiveTradesPerDay: number;
  keep: boolean;
  reason: string;
};

export type PortfolioResult = {
  targetDailyPct: number;
  fee: FeeFloor;
  tactics: TacticScore[];
  kept: number;
  combinedExpectedDailyPct: number;
  shortfallPct: number;
  /** How many more tactics of the median kept size would close the gap. */
  additionalTacticsNeeded: number | null;
  totalTradesPerDay: number;
  totalDailyCostPct: number;
  notes: string[];
};

/**
 * Scores a set of tactics as one book against a daily target.
 *
 * Contributions are summed, which is correct for expectations no matter how the
 * tactics correlate — but only for expectations. Variance and drawdown are not
 * additive, and two tactics that both go long a breakout are one tactic wearing
 * two names, so the combined figure here is an upper bound on what the book
 * feels like. That is stated in the notes rather than modelled, because the
 * correlation this needs comes from the paper ledger, not from an assumption.
 */
export function combineTactics(tactics: Tactic[], targetDailyPct: number, fee: FeeFloor): PortfolioResult {
  const costPerTradeR = fee.costPerTradeR;
  const scored: TacticScore[] = tactics.map((tactic) => {
    const rewardRisk = Math.max(0.1, tactic.rewardRisk);
    const netWin = rewardRisk - costPerTradeR;
    const netLoss = 1 + costPerTradeR;
    const probability = Math.max(0, Math.min(100, tactic.winRatePct)) / 100;
    const expectedRPerTrade = probability * netWin - (1 - probability) * netLoss;
    const activeRate = Math.max(0, Math.min(100, tactic.activeDayRatePct)) / 100;
    const effectiveTradesPerDay = Math.max(0, tactic.tradesPerDay) * activeRate;
    const expectedDailyPct = expectedRPerTrade * effectiveTradesPerDay * Math.max(0, tactic.riskPerTradePct);
    const breakevenWinRatePct = netWin > 0 ? (netLoss / (netWin + netLoss)) * 100 : 100;
    const keep = expectedRPerTrade > 0 && effectiveTradesPerDay > 0;
    return {
      name: tactic.name,
      expectedRPerTrade: round(expectedRPerTrade, 4)!,
      expectedDailyPct: round(expectedDailyPct, 4)!,
      breakevenWinRatePct: round(breakevenWinRatePct, 2)!,
      edgeOverBreakevenPts: round(tactic.winRatePct - breakevenWinRatePct, 2)!,
      effectiveTradesPerDay: round(effectiveTradesPerDay, 3)!,
      keep,
      reason: keep
        ? `비용 반영 후 거래당 ${round(expectedRPerTrade, 3)}R — 규모는 작아도 책에 넣을 값어치가 있다`
        : effectiveTradesPerDay <= 0 ? "발동하는 날이 없다"
          : `비용 반영 후 거래당 ${round(expectedRPerTrade, 3)}R — 수수료를 넘지 못한다`,
    };
  });

  const kept = scored.filter((tactic) => tactic.keep);
  const combined = kept.reduce((sum, tactic) => sum + tactic.expectedDailyPct, 0);
  const shortfall = targetDailyPct - combined;
  const contributions = kept.map((tactic) => tactic.expectedDailyPct).sort((left, right) => left - right);
  const medianContribution = contributions.length
    ? (contributions.length % 2 ? contributions[(contributions.length - 1) / 2] : (contributions[contributions.length / 2 - 1] + contributions[contributions.length / 2]) / 2)
    : 0;
  const totalTradesPerDay = kept.reduce((sum, tactic) => sum + tactic.effectiveTradesPerDay, 0);

  const notes: string[] = [];
  notes.push(`채택 ${kept.length}개 / 검토 ${scored.length}개 · 합산 기대 일수익 ${round(combined, 4)}% · 목표 ${targetDailyPct}%`);
  notes.push("기대값은 상관과 무관하게 더해지지만 변동성과 낙폭은 더해지지 않는다. 같은 방향 돌파를 보는 두 전술은 이름만 둘이고 실제로는 하나이므로, 이 합계는 체감 성적의 상한이다.");
  notes.push("전술별 상관은 가정하지 말고 페이퍼 원장의 전략 태그별 손익으로 측정한다. 상관이 낮은 조합만 이 합계에 근접한다.");
  if (shortfall > 0 && medianContribution > 0) notes.push(`부족분 ${round(shortfall, 4)}%를 메우려면 채택 전술의 중앙값(${round(medianContribution, 4)}%/일) 기준으로 약 ${Math.ceil(shortfall / medianContribution)}개가 더 필요하다. 그만큼 서로 상관 낮은 규칙을 실제로 찾을 수 있는지가 이 계획의 진짜 난이도다.`);
  if (shortfall <= 0) notes.push("합산 기대값이 목표를 넘는다. 다만 이는 모든 전술이 동시에 가정한 승률을 유지한다는 뜻이며, 검증되지 않은 승률이 하나라도 섞여 있으면 합계 전체가 그만큼 낙관적이다.");
  const rejected = scored.filter((tactic) => !tactic.keep);
  if (rejected.length) notes.push(`탈락 ${rejected.length}개: ${rejected.map((tactic) => tactic.name).join(", ")}. 수수료를 넘지 못하는 전술은 횟수를 늘려도 손실만 커진다.`);

  return {
    targetDailyPct,
    fee,
    tactics: scored,
    kept: kept.length,
    combinedExpectedDailyPct: round(combined, 4)!,
    shortfallPct: round(shortfall, 4)!,
    additionalTacticsNeeded: shortfall > 0 && medianContribution > 0 ? Math.ceil(shortfall / medianContribution) : shortfall <= 0 ? 0 : null,
    totalTradesPerDay: round(totalTradesPerDay, 3)!,
    totalDailyCostPct: round(totalTradesPerDay * fee.roundTripCostPct, 4)!,
    notes,
  };
}
