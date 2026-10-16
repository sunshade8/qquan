import { ctBarsAt, ctDate, type CTBar, type CTSignal } from "./ct-engine.ts";
export type CTSetup = {
  kind: "A" | "B";
  phase:
    | "idle"
    | "impulse"
    | "pullback"
    | "breakout"
    | "confirmed"
    | "invalidated"
    | "expired";
  direction: "long" | "short";
  anchor: number;
  boundary: number;
  started: number;
  expires: number;
  pullbacks: number;
  rangeLow: number;
  rangeHigh: number;
  lastClose: number;
};
export const ctEmptySetup = (): CTSetup => ({
  kind: "A",
  phase: "idle",
  direction: "long",
  anchor: 0,
  boundary: 0,
  started: 0,
  expires: 0,
  pullbacks: 0,
  rangeLow: 0,
  rangeHigh: 0,
  lastClose: 0,
});
export type CTDecision = {
  decisionId: string;
  observedThrough: number;
  executionEligibleAt: number;
  selectedPlaybook: "A" | "B" | null;
  action:
    | "NO_TRADE"
    | "WAIT"
    | "CANCEL_WAIT"
    | "ENTER_LONG"
    | "ENTER_SHORT"
    | "HOLD";
  setup: CTSetup;
  context: "trend" | "range" | "insufficient";
  waitingFor: string;
  invalidation: string;
  rationale: string;
  inputHash?: string;
  accepted: boolean;
  reason?: string;
};
export const CT_BASELINE_VERSIONS = [
  {
    id: "ct-router-baseline-1",
    label: "기준 A/B · v1",
    config: {
      engine: "ct-decision-1",
      router: "ct-router-1",
      decisionMinutes: 5,
      impulsePct: 0.3,
      rangeBars: 12,
      expiryMinutes: 30,
      contextFilter: false,
    },
  },
  {
    id: "ct-router-baseline-2",
    label: "A/B · 상황 필터 v2",
    config: {
      engine: "ct-decision-1",
      router: "ct-router-1",
      decisionMinutes: 5,
      impulsePct: 0.3,
      rangeBars: 12,
      expiryMinutes: 30,
      contextFilter: true,
    },
  },
] as const;
export type CTBaselineVersion = (typeof CT_BASELINE_VERSIONS)[number];
/** All levels are frozen before the trigger. Confirmation cannot move a reference after seeing the outcome. */
export function ctPlaybookStep(
  previous: CTSetup,
  bars: CTBar[],
  version: CTBaselineVersion,
  direction: "long" | "short" = "long",
) {
  let s = { ...previous };
  const b = bars.at(-1),
    prior = bars.at(-2);
  if (!b || !prior)
    return {
      state: s,
      action: "NO_TRADE" as const,
      context: "insufficient" as const,
    };
  const sign = direction === "long" ? 1 : -1,
    move =
      bars.length >= 4 ? sign * (b.close / bars.at(-4)!.close - 1) * 100 : 0;
  const trend = Math.abs(move) >= version.config.impulsePct,
    context = trend ? ("trend" as const) : ("range" as const);
  if (["expired", "invalidated", "confirmed"].includes(s.phase))
    s = ctEmptySetup();
  const expired = s.phase !== "idle" && b.endMs >= s.expires;
  const adverse =
    direction === "long" ? b.low < s.boundary : b.high > s.boundary;
  if (expired) {
    s.phase = "expired";
    return { state: s, action: "CANCEL_WAIT" as const, context };
  }
  if (s.phase === "idle") {
    if (move >= version.config.impulsePct) {
      s = {
        ...s,
        kind: "A",
        phase: "impulse",
        direction,
        anchor: direction === "long" ? b.high : b.low,
        boundary: bars.at(-4)!.close,
        started: b.endMs,
        expires: b.endMs + version.config.expiryMinutes * 60000,
        lastClose: b.close,
      };
      return { state: s, action: "WAIT" as const, context };
    }
    if (bars.length >= 13 && !trend) {
      const window = bars.slice(-13, -1),
        low = Math.min(...window.map((x) => x.low)),
        high = Math.max(...window.map((x) => x.high));
      if (direction === "long" ? b.low < low : b.high > high) {
        s = {
          ...s,
          kind: "B",
          phase: "breakout",
          direction,
          rangeLow: low,
          rangeHigh: high,
          anchor: direction === "long" ? low : high,
          boundary: direction === "long" ? b.low : b.high,
          started: b.endMs,
          expires: b.endMs + version.config.expiryMinutes * 60000,
          lastClose: b.close,
        };
        return { state: s, action: "WAIT" as const, context };
      }
    }
    return { state: s, action: "NO_TRADE" as const, context };
  }
  if (s.kind === "A") {
    if (adverse) {
      s.phase = "invalidated";
      return { state: s, action: "CANCEL_WAIT" as const, context };
    }
    const pulling = sign * (b.close - prior.close) < 0;
    if (pulling && sign * (prior.close - s.lastClose) >= 0) s.pullbacks++;
    if (s.phase === "impulse" && pulling) {
      s.phase = "pullback";
      s.pullbacks = 1;
    }
    if (s.pullbacks > 1) {
      s.phase = "invalidated";
      return { state: s, action: "CANCEL_WAIT" as const, context };
    }
    if (
      s.phase === "pullback" &&
      (direction === "long" ? b.close > prior.high : b.close < prior.low) &&
      (!version.config.contextFilter || move >= 0)
    ) {
      s.phase = "confirmed";
      return {
        state: s,
        action:
          direction === "long"
            ? ("ENTER_LONG" as const)
            : ("ENTER_SHORT" as const),
        context,
      };
    }
  } else {
    if (direction === "long" ? b.low < s.boundary : b.high > s.boundary) {
      s.phase = "invalidated";
      return { state: s, action: "CANCEL_WAIT" as const, context };
    }
    if (
      direction === "long"
        ? b.close > s.rangeLow && b.close < s.rangeHigh
        : b.close < s.rangeHigh && b.close > s.rangeLow
    ) {
      s.phase = "confirmed";
      return {
        state: s,
        action:
          direction === "long"
            ? ("ENTER_LONG" as const)
            : ("ENTER_SHORT" as const),
        context,
      };
    }
  }
  s.lastClose = prior.close;
  return { state: s, action: "WAIT" as const, context };
}
export function ctBaselinePolicy(
  symbol: string,
  version: CTBaselineVersion,
  run: string,
  arm: string,
  market: "stock" | "crypto" = "crypto",
) {
  const minutes: CTBar[] = [],
    completed: CTBar[] = [];
  let setup = ctEmptySetup(),
    signal: CTSignal | null = null,
    lastDay = "";
  const decisions: CTDecision[] = [];
  return {
    decisions,
    observe: (bar: CTBar) => {
      const day = ctDate(bar.startMs, market);
      if (day !== lastDay) {
        setup = ctEmptySetup();
        lastDay = day;
      }
      minutes.push(bar);
      if (minutes.length > 5) minutes.shift();
      signal = null;
      const aggregate = ctBarsAt([...minutes], 5).at(-1);
      if (!aggregate || aggregate.endMs !== bar.endMs) return;
      completed.push(aggregate);
      if (completed.length > 120) completed.shift();
      const step = ctPlaybookStep(setup, completed, version);
      setup = step.state;
      decisions.push({
        decisionId: `${run}:${arm}:${bar.endMs}`,
        observedThrough: bar.endMs,
        executionEligibleAt: bar.endMs,
        selectedPlaybook: setup.phase === "idle" ? null : setup.kind,
        action: step.action,
        setup: { ...setup },
        context: step.context,
        waitingFor:
          setup.kind === "A"
            ? "첫 되돌림 뒤 직전 봉 고가/저가 돌파"
            : "동결 범위 안 복귀",
        invalidation: `기준선 ${setup.boundary} / 만료 ${setup.expires}`,
        rationale:
          setup.kind === "A"
            ? "방향성 움직임·최초 되돌림·구조 보존을 순서대로 확인"
            : "이탈 이전 범위와 시간 제한을 유지",
        accepted: true,
      });
      if (step.action === "ENTER_LONG")
        signal = {
          symbol,
          decidedAt: bar.endMs,
          validUntil: bar.endMs + 60000,
          reference: bar.close,
          patternFrom: setup.started,
          patternLow: setup.boundary,
          support: setup.boundary,
          resistance: setup.anchor,
          stages: [
            { index: 0, at: setup.started, values: [setup.anchor] },
            { index: 1, at: bar.endMs, values: [bar.close] },
          ],
          swings: [],
        };
    },
    signal: () => signal,
  };
}
