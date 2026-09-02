export type LabToolTrace = { id?: string; name: string; label: string; status: "running" | "complete" | "failed"; detail: string; startedAt?: string; durationMs?: number };
export type AgentActivity = { label: string; detail: string; progress?: string };
export type LabAgentPhase = "connecting" | "grounding" | "planning" | "tools" | "verifying" | "writing";

export type ChartPoint = { date: string; value: number };
export type ChartSeries = { name: string; points: ChartPoint[]; color?: string; dashed?: boolean };
export type Overlay = { name: string; values: Array<number | null>; color?: string; dashed?: boolean };

export type LabArtifact =
  | {
    id: string; type: "price-chart"; title: string; symbol: string; name: string;
    period: { from: string; to: string; sessions: number };
    bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>;
    overlays: Overlay[];
    stats: Record<string, string | number | null>;
    trailing: Record<string, number | null>;
    notes: string[];
  }
  | {
    id: string; type: "price-comparison"; title: string; period: { from: string; to: string; sessions: number };
    series: Array<{ symbol: string; name: string; returnPct: number | null; points: ChartPoint[] }>;
    correlations: Array<{ left: string; right: string; returnCorrelation: number | null; pathCorrelation: number | null }>;
    notes: string[];
  }
  | {
    id: string; type: "indicator-panel"; title: string; symbol: string; period: { from: string; to: string };
    dates: string[]; close: number[];
    overlays: Overlay[];
    panels: Array<{ name: string; lines: Overlay[]; bands?: Array<{ value: number; label: string }>; histogram?: Array<number | null> }>;
    readings: Array<{ label: string; value: string; tone: "positive" | "negative" | "neutral" }>;
    notes: string[];
  }
  | {
    id: string; type: "event-study"; title: string; symbol: string; period: { from: string; to: string };
    condition: string; horizon: number;
    stats: Record<string, number | string | null>;
    distribution: Array<{ from: number; to: number; count: number }>;
    events: Array<{ date: string; value: number; forwardReturnPct: number; close: number }>;
    notes: string[];
  }
  | {
    id: string; type: "backtest"; title: string; symbol: string; strategy: string; period: { from: string; to: string; sessions: number };
    metrics: Record<string, number | string | null>;
    equityCurve: Array<{ date: string; strategy: number; benchmark: number }>;
    trades: Array<{ entryDate: string; exitDate: string; entryPrice: number; exitPrice: number; returnPct: number; sessions: number }>;
    notes: string[];
  }
  | {
    id: string; type: "seasonality"; title: string; symbol: string; years: number;
    monthly: Array<{ label: string; samples: number; averagePct: number | null; medianPct: number | null; positiveRatePct: number | null }>;
    weekday: Array<{ label: string; samples: number; averagePct: number | null; positiveRatePct: number | null }>;
    notes: string[];
  }
  | {
    id: string; type: "table"; title: string; subtitle?: string;
    columns: string[]; rows: Array<Array<string | number | null>>; notes: string[];
  }
  | {
    id: string; type: "drawdown-news"; title: string; symbol: string; company: string;
    period: { from: string; to: string };
    events: Array<{ date: string; returnPct: number; close: number; news: Array<{ title: string; source: string; url: string; publishedAt: string }> }>;
    notes: string[];
  }
  | {
    id: string; type: "news-list"; title: string; query: string; period: { from: string; to: string };
    items: Array<{ title: string; source: string; url: string; publishedAt: string }>; notes: string[];
  }
  | {
    id: string; type: "calendar"; title: string; period: { from: string; to: string };
    events: Array<{ date: string; time: string; title: string; category: string; importance: string; note: string }>; notes: string[];
  }
  | { id: string; type: "tradingview"; title: string; symbol: string; interval: string; studies: string[]; notes: string[] }
  | { id: string; type: "strategy-proposal"; title: string; spec: Record<string, unknown>; summary: { entry: string; exit: string; holding: string; universe: string; cost: string }; strategyId: string | null; status: string | null; notes: string[] }
  | {
    id: string; type: "strategy-backtest"; title: string; strategyId: string | null; strategyName: string; verdict: { status: "pass" | "fail" | "inconclusive"; reasons: string[] };
    period: { from: string; to: string; sessions: number }; metrics: Record<string, number | string | null>;
    equityCurve: Array<{ date: string; strategy: number; benchmark: number; market: number | null }>;
    perSymbol: Array<{ symbol: string; totalReturnPct: number | null; benchmarkReturnPct: number | null; sharpe: number | null; maxDrawdownPct: number | null; trades: number; winRatePct: number | null; currentSignal: string }>;
    robustness: { inSample: { from: string; to: string; cagrPct: number | null; sharpe: number | null }; outOfSample: { from: string; to: string; cagrPct: number | null; sharpe: number | null }; stabilityScore: number | null };
    notes: string[];
  }
  | { id: string; type: "web-search"; title: string; query: string; results: Array<{ title: string; url: string; snippet: string }>; notes: string[] }
  | { id: string; type: "limitation"; title: string; explanation: string; suggestions: string[] };

export type LabMessage = {
  id: string;
  role: "user" | "agent";
  content: string;
  tools: LabToolTrace[];
  artifacts: LabArtifact[];
  createdAt: string;
  model?: string;
  costUsd?: number | null;
};

/** Server-sent events emitted by /api/lab/agent while a turn runs. */
export type LabStreamEvent =
  | { type: "status"; phase: LabAgentPhase; label: string; detail?: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; label: string; detail: string }
  | { type: "tool_end"; id: string; name: string; label: string; status: "complete" | "failed"; detail: string; durationMs: number }
  | { type: "artifact"; artifact: LabArtifact }
  | { type: "done"; message: LabMessage; conversationId: string }
  | { type: "error"; message: string; status?: number };
