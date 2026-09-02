import assert from "node:assert/strict";
import test from "node:test";
import { describeFindingsForContext, rankFindingsForQuestion, validateFinding } from "../lib/findings.ts";

function finding(overrides = {}) {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    title: "반도체 과매도 반등",
    claim: "SOXX 구성 종목에서 RSI(14)<30 이후 5거래일 평균 +1.4% (베이스라인 +0.3%, n=214)",
    evidence: ["conditional_stats: 평균 +1.4% vs 기준 +0.3%"],
    symbols: ["NVDA", "AMD"],
    tags: ["mean-reversion"],
    confidence: "medium",
    status: "open",
    falsification: "표본을 2년 더 늘렸을 때 초과분이 0.2%p 아래로 떨어지면 기각",
    sourceConversationId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

test("validateFinding requires a claim and at least one piece of evidence", () => {
  const missing = validateFinding({ title: "유효한 제목", claim: "짧음", evidence: [] });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors.length, 2);
  assert.match(missing.errors.join(" "), /claim/);
  assert.match(missing.errors.join(" "), /evidence/);
});

test("validateFinding normalises symbols, defaults, and trims empty evidence", () => {
  const result = validateFinding({
    title: "테스트 결론",
    claim: "20일 모멘텀 상위 종목의 다음 5일 초과수익은 관측되지 않았다 (n=180)",
    evidence: ["screen_universe 상위 15종목", "  ", "conditional_stats n=180"],
    symbols: ["nvda", " amd "],
    confidence: "터무니없는값",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.symbols, ["NVDA", "AMD"]);
  assert.deepEqual(result.value.evidence, ["screen_universe 상위 15종목", "conditional_stats n=180"]);
  assert.equal(result.value.confidence, "medium");
  assert.equal(result.value.status, "open");
});

test("rankFindingsForQuestion surfaces the notes whose text overlaps the question", () => {
  const notes = [
    finding({ id: "a", title: "반도체 과매도 반등", symbols: ["NVDA"] }),
    finding({ id: "b", title: "에너지 계절성", claim: "XLE는 11월에 강했다", symbols: ["XLE"], tags: ["seasonality"] }),
  ];
  const ranked = rankFindingsForQuestion(notes, "NVDA 과매도 반등 다시 확인해줘", 1);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, "a");
});

test("rankFindingsForQuestion still returns notes when nothing overlaps", () => {
  const notes = [finding({ id: "a" }), finding({ id: "b" })];
  const ranked = rankFindingsForQuestion(notes, "!!!", 2);
  assert.equal(ranked.length, 2);
});

test("describeFindingsForContext carries the claim and its falsification condition", () => {
  const block = describeFindingsForContext([finding()]);
  assert.match(block, /반도체 과매도 반등/);
  assert.match(block, /베이스라인 \+0\.3%/);
  assert.match(block, /반증 조건:/);
  assert.match(block, /신뢰도 보통 · 검증 중 · 2026-09-02/);
});

test("describeFindingsForContext is empty when there is nothing stored", () => {
  assert.equal(describeFindingsForContext([]), "");
});
