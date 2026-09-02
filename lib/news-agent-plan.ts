export type ResearchPlanMode = "research_pipeline" | "analyze_existing" | "answer" | "clarify";
export type ResearchStep = "retrieve_news" | "score_sentiment" | "persist_test" | "compare_tests" | "find_patterns" | "build_strategy" | "run_backtest";

export type PlannerDraft = {
  mode?: ResearchPlanMode;
  eventRoot?: string | null;
  requestedSteps?: string[];
  goal?: string;
  confidence?: number;
};

export type ValidatedResearchPlan = {
  version: 1;
  mode: ResearchPlanMode;
  goal: string;
  eventRoot: string | null;
  eventLabel: string | null;
  range: { from: string; to: string; label: string; source: "explicit" | "relative" } | null;
  requestedSteps: ResearchStep[];
  confidence: number;
  assumptions: string[];
  clarification: string | null;
};

export const NEWS_EVENT_DEFINITIONS = [
  { root: "cpi", label: "CPI", aliases: /\bcpi\b|\bpci\b|소비자\s*물가|consumer\s*price/i },
  { root: "pce", label: "PCE", aliases: /\bpce\b|개인\s*소비\s*지출|personal\s*consumption/i },
  { root: "ppi", label: "PPI", aliases: /\bppi\b|생산자\s*물가|producer\s*price/i },
  { root: "nfp", label: "NFP", aliases: /\bnfp\b|비농업|고용\s*보고서|jobs?\s*report|nonfarm/i },
  { root: "fomc", label: "FOMC", aliases: /\bfomc\b|금리\s*결정|연준\s*회의|fed\s*(?:meeting|decision)/i },
  { root: "gdp", label: "GDP", aliases: /\bgdp\b|국내\s*총생산/i },
  { root: "ism-manufacturing", label: "ISM 제조업", aliases: /ism\s*제조|제조업\s*(?:ism|pmi)|manufacturing\s*(?:ism|pmi)/i },
  { root: "ism-services", label: "ISM 서비스업", aliases: /ism\s*서비스|서비스업\s*(?:ism|pmi)|services?\s*(?:ism|pmi)/i },
] as const;

const allowedSteps: ResearchStep[] = [
  "retrieve_news", "score_sentiment", "persist_test", "compare_tests", "find_patterns", "build_strategy", "run_backtest",
];

function isoDate(year: string, month: string, day: string) {
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function shiftMonths(date: string, months: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() - months);
  return value.toISOString().slice(0, 10);
}

function calendarYearRange(today: string, year: number) {
  const currentYear = Number(today.slice(0, 4));
  const selected = year === 0 ? currentYear : currentYear - 1;
  const to = year === 0 ? today : `${selected}-12-31`;
  return { from: `${selected}-01-01`, to, label: year === 0 ? "올해" : "작년", source: "relative" as const };
}

export function extractRequestedRange(question: string, today: string): ValidatedResearchPlan["range"] {
  const dates = [...question.matchAll(/(20\d{2})[-/.년]\s*(\d{1,2})[-/.월]\s*(\d{1,2})일?/g)]
    .map((match) => isoDate(match[1], match[2], match[3]));
  if (dates.length >= 2) {
    const [from, to] = dates[0] <= dates[1] ? [dates[0], dates[1]] : [dates[1], dates[0]];
    return { from, to: to > today ? today : to, label: `${from} → ${to > today ? today : to}`, source: "explicit" };
  }
  if (/\b올해\b/.test(question)) return calendarYearRange(today, 0);
  if (/\b작년\b|지난\s*해/.test(question)) return calendarYearRange(today, 1);
  const yearMatch = question.match(/(?:최근|지난)?\s*(\d{1,2})\s*년(?:간|동안)?/i);
  if (yearMatch) {
    const years = Math.min(5, Math.max(1, Number(yearMatch[1])));
    return { from: shiftMonths(today, years * 12), to: today, label: `최근 ${years}년`, source: "relative" };
  }
  if (/최근\s*반년|지난\s*반년/.test(question)) {
    return { from: shiftMonths(today, 6), to: today, label: "최근 6개월", source: "relative" };
  }
  const monthMatch = question.match(/(?:최근|지난)?\s*(\d{1,2})\s*(?:개월|달)(?:간|동안)?/i);
  if (monthMatch) {
    const months = Math.min(60, Math.max(1, Number(monthMatch[1])));
    return { from: shiftMonths(today, months), to: today, label: `최근 ${months}개월`, source: "relative" };
  }
  return null;
}

function requestedStepsFromText(question: string) {
  const steps = new Set<ResearchStep>();
  if (/뉴스|news|retrieval|retrieve|수집|가져와/i.test(question)) steps.add("retrieve_news");
  if (/llm.{0,12}분석|감성(?:\s*점수|\s*분석)?|sentiment/i.test(question)) steps.add("score_sentiment");
  if (/\btest\b|테스트|row|행\s*추가|저장/i.test(question)) steps.add("persist_test");
  if (/비교|compare|유사성/i.test(question)) steps.add("compare_tests");
  if (/공통|패턴|반복|pattern/i.test(question)) steps.add("find_patterns");
  if (/전략|진입|청산|strategy/i.test(question)) steps.add("build_strategy");
  if (/백테스트|backtest|성과\s*검증/i.test(question)) steps.add("run_backtest");
  return steps;
}

function closePrerequisites(steps: Set<ResearchStep>) {
  if (steps.has("run_backtest")) steps.add("build_strategy");
  if (steps.has("build_strategy") || steps.has("find_patterns")) steps.add("compare_tests");
  if (steps.has("compare_tests")) steps.add("persist_test");
  if (steps.has("persist_test")) steps.add("score_sentiment");
  if (steps.has("score_sentiment")) steps.add("retrieve_news");
  return allowedSteps.filter((step) => steps.has(step));
}

function isPipelineRequest(question: string, steps: ResearchStep[]) {
  const explicitChain = /(?:→|->|부터.{0,30}까지|한번에|일괄|전부|모두)/i.test(question);
  return explicitChain || steps.includes("retrieve_news") && steps.some((step) => step === "persist_test" || step === "compare_tests");
}

export function validateResearchPlan(question: string, today: string, draft: PlannerDraft = {}): ValidatedResearchPlan {
  const deterministicEvent = NEWS_EVENT_DEFINITIONS.find((item) => item.aliases.test(question));
  const draftedEvent = NEWS_EVENT_DEFINITIONS.find((item) => item.root === draft.eventRoot);
  const event = deterministicEvent ?? draftedEvent ?? null;
  const range = extractRequestedRange(question, today);
  const steps = requestedStepsFromText(question);
  for (const step of draft.requestedSteps ?? []) {
    if (allowedSteps.includes(step as ResearchStep)) steps.add(step as ResearchStep);
  }
  const pipeline = isPipelineRequest(question, allowedSteps.filter((step) => steps.has(step))) || draft.mode === "research_pipeline";
  if (!pipeline) {
    if (steps.has("run_backtest")) steps.add("build_strategy");
    if (steps.has("build_strategy")) steps.add("find_patterns");
    if (steps.has("find_patterns")) steps.add("compare_tests");
  }
  const normalizedSteps = pipeline ? closePrerequisites(steps) : allowedSteps.filter((step) => steps.has(step));
  const assumptions: string[] = [];
  if (/\bpci\b/i.test(question) && event?.root === "cpi") assumptions.push("PCI는 CPI의 오타로 해석했습니다.");
  if (pipeline && !event) {
    return { version: 1, mode: "clarify", goal: draft.goal || question, eventRoot: null, eventLabel: null, range, requestedSteps: normalizedSteps, confidence: 0, assumptions, clarification: "어떤 경제 이벤트를 조사할지 지정해주세요. 예: CPI, PCE, PPI, NFP, FOMC" };
  }
  if (pipeline && !range) {
    return { version: 1, mode: "clarify", goal: draft.goal || question, eventRoot: event?.root ?? null, eventLabel: event?.label ?? null, range: null, requestedSteps: normalizedSteps, confidence: 0, assumptions, clarification: "조사 기간을 지정해주세요. 예: 최근 6개월, 최근 1년, 2025-01-01부터 2025-12-31" };
  }
  const inferredMode: ResearchPlanMode = pipeline ? "research_pipeline" : normalizedSteps.some((step) => ["find_patterns", "build_strategy", "run_backtest"].includes(step)) ? "analyze_existing" : "answer";
  return {
    version: 1,
    mode: inferredMode,
    goal: draft.goal || question,
    eventRoot: event?.root ?? null,
    eventLabel: event?.label ?? null,
    range,
    requestedSteps: normalizedSteps,
    confidence: Math.max(0, Math.min(1, Number(draft.confidence ?? (pipeline ? 0.96 : 0.82)))),
    assumptions,
    clarification: null,
  };
}
