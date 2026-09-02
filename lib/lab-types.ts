export type LabToolTrace = { name: string; label: string; status: "complete" | "failed"; detail: string };
export type AgentActivity = { label: string; detail: string; progress?: string };

export type LabArtifact =
  | {
    id: string; type: "price-comparison"; title: string; period: { from: string; to: string; sessions: number };
    left: { name: string; symbol: string; returnPct: number | null };
    right: { name: string; symbol: string; returnPct: number | null };
    metrics: { returnCorrelation: number | null; pathCorrelation: number | null };
    points: Array<{ date: string; left: number; right: number }>;
    notes: string[];
  }
  | {
    id: string; type: "drawdown-news"; title: string; symbol: string; company: string;
    period: { from: string; to: string };
    events: Array<{ date: string; returnPct: number; close: number; news: Array<{ title: string; source: string; url: string; publishedAt: string }> }>;
    notes: string[];
  }
  | { id: string; type: "limitation"; title: string; explanation: string; suggestions: string[] };

export type LabMessage = {
  id: string;
  role: "user" | "agent";
  content: string;
  tools: LabToolTrace[];
  artifacts: LabArtifact[];
  createdAt: string;
};
