export type CTMemoryScope = {
  venue: string;
  product: string;
  instrument: string;
  direction: string;
  decisionMinutes: number;
  executionMinutes: number;
  regime: string;
  setupVersion: string;
  riskProfile: string;
  costProfile: string;
};
export type CTScopedMemory = {
  id: string;
  owner: string;
  scope: CTMemoryScope;
  observedAt: number;
  recordedAt: number;
  availableAt: number;
  from: number;
  to: number;
  split: "training" | "development" | "final";
  grade:
    | "rejected_in_scope"
    | "insufficient"
    | "data_limited"
    | "validating"
    | "reproduced"
    | "weakened";
  conclusion: string;
  trainingEvidence?: Record<string, number>;
};
export function ctAllowedMemory(
  rows: CTScopedMemory[],
  query: {
    owner: string;
    scope: CTMemoryScope;
    at: number;
    trainingTo: number;
  },
) {
  return rows
    .filter(
      (m) =>
        m.owner === query.owner &&
        m.availableAt <= query.at &&
        m.observedAt <= query.at &&
        m.recordedAt <= query.at &&
        m.to <= query.trainingTo &&
        m.split === "training" &&
        Object.entries(query.scope).every(
          ([k, v]) =>
            v !== "unknown" &&
            m.scope[k as keyof CTMemoryScope] !== "unknown" &&
            m.scope[k as keyof CTMemoryScope] === v,
        ),
    )
    .map((m) => ({
      ...m,
      match: "일치하는 범위",
      reason: "동일 scope의 사용 가능한 학습 근거",
    }));
}
