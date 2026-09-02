import assert from "node:assert/strict";
import test from "node:test";
import { validateResearchPlan } from "../lib/news-agent-plan.ts";
import { MARKET_EVENT_CALENDAR } from "../app/market-calendar-data.ts";

const today = "2026-09-02";

test("preserves a one-year CPI pipeline request instead of defaulting to six months", () => {
  const plan = validateResearchPlan("최근 1년간 cpi 발표에 대한 news retrieval → LLM 분석 → test 섹션 비교 분석까지 진행해줘", today);
  assert.equal(plan.mode, "research_pipeline");
  assert.equal(plan.eventRoot, "cpi");
  assert.deepEqual(plan.range, { from: "2025-09-02", to: today, label: "최근 1년", source: "relative" });
  assert.deepEqual(plan.requestedSteps, ["retrieve_news", "score_sentiment", "persist_test", "compare_tests"]);
  const events = MARKET_EVENT_CALENDAR.filter((event) => event.id.startsWith("cpi-") && event.date >= plan.range.from && event.date <= plan.range.to);
  assert.equal(events.length, 11);
  assert.equal(events[0].date, "2025-09-11");
  assert.equal(events.at(-1).date, "2026-08-12");
});

test("does not silently invent a default period", () => {
  const plan = validateResearchPlan("CPI 뉴스를 수집해서 LLM 분석하고 Test 비교해줘", today);
  assert.equal(plan.mode, "clarify");
  assert.equal(plan.range, null);
  assert.match(plan.clarification ?? "", /기간/);
});

test("routes a follow-up pattern question to accumulated-test analysis", () => {
  const plan = validateResearchPlan("지금까지 분석한 결과에서 공통점을 찾아줘", today);
  assert.equal(plan.mode, "analyze_existing");
  assert.ok(plan.requestedSteps.includes("find_patterns"));
  assert.ok(plan.requestedSteps.includes("compare_tests"));
});
