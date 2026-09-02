/**
 * Durable research notes.
 *
 * Without this, every conclusion JARVIS reaches dies with the conversation and
 * the next thread starts from zero. A finding is deliberately shaped like a
 * claim rather than a chat message: what was concluded, on what evidence, and
 * what result would overturn it — so a later session can check it instead of
 * re-deriving it.
 */

export type FindingConfidence = "high" | "medium" | "low";
export type FindingStatus = "open" | "confirmed" | "refuted" | "stale";

export const FINDING_CONFIDENCE_LABELS: Record<FindingConfidence, string> = { high: "높음", medium: "보통", low: "낮음" };
export const FINDING_STATUS_LABELS: Record<FindingStatus, string> = { open: "검증 중", confirmed: "확인됨", refuted: "반증됨", stale: "재확인 필요" };

export type Finding = {
  id: string;
  title: string;
  claim: string;
  evidence: string[];
  symbols: string[];
  tags: string[];
  confidence: FindingConfidence;
  status: FindingStatus;
  falsification: string;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FindingInput = {
  id?: string;
  title: string;
  claim: string;
  evidence?: string[];
  symbols?: string[];
  tags?: string[];
  confidence?: string;
  status?: string;
  falsification?: string;
};

export function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function parseEvidence(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function confidenceOf(value: unknown): FindingConfidence {
  return value === "high" || value === "low" ? value : "medium";
}

export function statusOf(value: unknown): FindingStatus {
  return value === "confirmed" || value === "refuted" || value === "stale" ? value : "open";
}

export function validateFinding(input: FindingInput): { ok: true; value: Required<Omit<FindingInput, "id">> & { id: string | null } } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const title = String(input.title ?? "").trim();
  const claim = String(input.claim ?? "").trim();
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 12);
  if (title.length < 3) errors.push("title은 3자 이상이어야 합니다.");
  if (claim.length < 10) errors.push("claim은 결론을 문장으로 적어야 합니다 (10자 이상).");
  if (!evidence.length) errors.push("evidence는 최소 1개 필요합니다. 어떤 도구가 어떤 숫자를 냈는지 적으세요.");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : null,
      title: title.slice(0, 160),
      claim: claim.slice(0, 1200),
      evidence,
      symbols: (Array.isArray(input.symbols) ? input.symbols : []).map((item) => String(item).trim().toUpperCase()).filter(Boolean).slice(0, 20),
      tags: (Array.isArray(input.tags) ? input.tags : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 8),
      confidence: confidenceOf(input.confidence),
      status: statusOf(input.status),
      falsification: String(input.falsification ?? "").trim().slice(0, 600),
    },
  };
}

/**
 * Matches stored findings against the words of a new question. Deliberately a
 * plain token overlap rather than embeddings: it runs inside the request with
 * no extra model call, and a false positive only costs a few context tokens.
 */
export function rankFindingsForQuestion(findings: Finding[], question: string, limit = 5): Finding[] {
  const tokens = new Set(question.toLowerCase().match(/[a-z0-9]+|[가-힣]{2,}/g) ?? []);
  if (!tokens.size) return findings.slice(0, limit);
  const scored = findings.map((finding) => {
    const haystack = `${finding.title} ${finding.claim} ${finding.symbols.join(" ")} ${finding.tags.join(" ")}`.toLowerCase();
    let score = 0;
    for (const token of tokens) if (token.length > 1 && haystack.includes(token)) score += 1;
    return { finding, score };
  });
  const hits = scored.filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
  return (hits.length ? hits : scored).slice(0, limit).map((item) => item.finding);
}

/** Compact context block injected into a Lab turn so prior conclusions carry forward. */
export function describeFindingsForContext(findings: Finding[]) {
  if (!findings.length) return "";
  return findings.map((finding) => {
    const parts = [
      `- [${finding.id.slice(0, 8)}] ${finding.title} (신뢰도 ${FINDING_CONFIDENCE_LABELS[finding.confidence]} · ${FINDING_STATUS_LABELS[finding.status]} · ${finding.updatedAt.slice(0, 10)})`,
      `  결론: ${finding.claim}`,
    ];
    if (finding.symbols.length) parts.push(`  종목: ${finding.symbols.join(", ")}`);
    if (finding.falsification) parts.push(`  반증 조건: ${finding.falsification}`);
    return parts.join("\n");
  }).join("\n");
}
