"use client";

import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import HistoryIcon from "lucide-react/dist/esm/icons/history";
import Newspaper from "lucide-react/dist/esm/icons/newspaper";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Send from "lucide-react/dist/esm/icons/send";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import X from "lucide-react/dist/esm/icons/x";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { NEWS_EVENT_DEFINITIONS, type ResearchStep, type ValidatedResearchPlan } from "@/lib/news-agent-plan";
import type { AgentActivity } from "@/lib/lab-types";
import { Markdown } from "./markdown";
import { NewsSentimentPanelBridge } from "./news-sentiment-bridge";
import { NewsSimilarity } from "./news-similarity";
import type { MarketEvent } from "./market-calendar-data";

type NewsTopic = "macro" | "forecast" | "fed" | "inflation" | "labor" | "markets";
type NewsArticle = {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  sourceUrl: string;
  url: string;
  publishedAt: string;
  topic: NewsTopic;
  eventId?: string;
  eventTitle?: string;
  eventDate?: string;
  eventTimeET?: string;
  stage?: "pre_release_forecast";
};
type NewsSource = { id: string; name: string; count: number; status: "ok" | "error" };
type RetrievedQuery = { start: string; end: string; topic: NewsTopic };
type MarketWindow = { anchorDate: string; close: number; prior1D: number | null; prior5D: number | null; forward1D: number | null; forward5D: number | null } | null;
type SegmentSentiment = { score: number; label: string; rationale: string };
type ForecastEvent = { indicator: string; scheduledReleaseDate: string | null; scheduledTimeET: string | null; consensus: string | null; previous: string | null; expectationDirection: string; evidenceIds: string[]; caveat: string };
type BenchmarkValue = { symbol: string; name: string; startDate: string; endDate: string; startClose: number; endClose: number; returnPct: number; origin?: string };
type RangeBenchmark = BenchmarkValue | { unavailable: string } | null;
type SentimentAnalysis = {
  score?: number;
  label?: string;
  macroTone?: string;
  confidence?: number;
  segments?: { tech?: SegmentSentiment; value?: SegmentSentiment };
  forecastEvents?: ForecastEvent[];
  distribution?: { positive: number; neutral: number; negative: number };
  summary?: string;
  themes?: Array<{ name: string; tone: string; evidence: string }>;
  marketRead?: string;
  hypotheses?: string[];
  nextTest?: string;
  limitations?: string[];
  articleSignals?: Array<{ id: string; label: string; score: number }>;
  raw?: string;
};
type AnalysisResult = {
  analysis: SentimentAnalysis;
  market: { SPY: MarketWindow; QQQ: MarketWindow };
  benchmarks: { NASDAQ: RangeBenchmark; NYSE: RangeBenchmark };
  events: Array<{ date: string; timeET: string; title: string; importance: string }>;
  articleCount: number;
};
type NewsTest = {
  id: string;
  periodStart: string;
  periodEnd: string;
  topic: string;
  articleCount: number;
  overallScore: number;
  overallLabel: string;
  techScore: number;
  techLabel: string;
  valueScore: number;
  valueLabel: string;
  nasdaq: RangeBenchmark;
  nyse: RangeBenchmark;
  forecastEvents?: ForecastEvent[];
  createdAt: string;
};
type TestDetailReaction = { effectiveDate: string; eventDayPct: number | null; next1DPct: number | null; post3DPct: number | null } | null;
type TestDetailEvent = {
  id: string;
  date: string;
  timeET: string;
  title: string;
  note: string;
  category: "fed" | "inflation" | "labor" | "growth" | "business";
  categoryLabel: string;
  importance: "high" | "medium";
  source: string;
  sourceUrl: string;
  reactions: { nasdaq: TestDetailReaction; nyse: TestDetailReaction };
};
type TestDetailIndex = {
  symbol: string;
  name: string;
  origin: string;
  reason: string | null;
  points: Array<{ date: string; close: number; dailyReturnPct: number | null; phase: "pre" | "selected" | "post" }>;
  summary: null | {
    startDate: string;
    endDate: string;
    startClose: number;
    endClose: number;
    returnPct: number;
    maxDrawdownPct: number;
    annualizedVolatilityPct: number | null;
    upDays: number;
    downDays: number;
    sessions: number;
  };
};
type TestDetail = {
  period: { start: string; end: string; chartStart: string; chartEnd: string };
  indices: { nasdaq: TestDetailIndex; nyse: TestDetailIndex };
  events: TestDetailEvent[];
  methodology: string;
};
type NewsAgentMessage = { id: string; role: "user" | "agent"; content: string; createdAt: string };
type NewsHistoryEvent = { title: string; detail: string };
type BatchResearchPlan = {
  root: string; label: string; range: { from: string; to: string; label: string; source: "explicit" | "relative" }; note: string | null;
  requestedSteps: ResearchStep[]; events: MarketEvent[]; coverageWarning: string | null; planner: string;
};
type BatchStatus = { completed: number; total: number; label: string; phase: string };
type ResearchRunStage = { date: string; status: "queued" | "running" | "complete" | "reused" | "failed"; detail: string; testId?: string };
type ResearchRun = {
  id: string; command: string; label: string; status: "running" | "complete" | "partial" | "failed";
  totalEvents: number; completedEvents: number; failedEvents: number; stages: ResearchRunStage[];
  result: { summary?: string; testIds?: string[]; plan?: { range: string; steps: ResearchStep[]; planner: string } }; createdAt: string; updatedAt: string;
};
type AgentSpecialist = { id: string; label: string; status: "running" | "complete" | "skipped" | "failed"; model?: string; role?: string };
type NewsAgentEvent =
  | { type: "specialist"; specialist: AgentSpecialist }
  | { type: "text"; delta: string }
  | { type: "done"; answer: string; intent: string; specialists: AgentSpecialist[]; artifacts?: unknown; model: string }
  | { type: "error"; message: string; status?: number };

async function readAgentStream(response: Response, onEvent: (event: NewsAgentEvent) => void) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = await response.json().catch(() => ({})) as { answer?: string; error?: string; specialists?: AgentSpecialist[]; intent?: string; model?: string };
    if (!response.ok || !data.answer) throw new Error(data.error || "News JARVIS에 연결하지 못했습니다.");
    onEvent({ type: "done", answer: data.answer, intent: data.intent ?? "answer", specialists: data.specialists ?? [], model: data.model ?? "" });
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("서버가 스트림을 반환하지 않았습니다.");
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      try {
        const event = JSON.parse(line.slice(6)) as NewsAgentEvent;
        onEvent(event);
        if (event.type === "done") finished = true;
        if (event.type === "error") throw new Error(event.message);
      } catch (reason) {
        if (reason instanceof Error && reason.message !== "Unexpected end of JSON input") throw reason;
      }
    }
  }
  if (!finished) throw new Error("응답 스트림이 중간에 끊겼습니다.");
}
type AgentPlanResult = {
  plan: ValidatedResearchPlan;
  planner: string;
  events: MarketEvent[];
  coverage: { complete: boolean; availableFrom: string | null; availableTo: string | null; warning: string | null };
  error?: string;
};

const topicOptions: Array<{ id: NewsTopic; label: string }> = [
  { id: "macro", label: "전체 거시" },
  { id: "forecast", label: "지표 예측" },
  { id: "fed", label: "연준·금리" },
  { id: "inflation", label: "물가" },
  { id: "labor", label: "고용" },
  { id: "markets", label: "시장" },
];

const topicLabels: Record<NewsTopic, string> = { macro: "Macro", forecast: "Forecast", fed: "Fed", inflation: "Inflation", labor: "Labor", markets: "Markets" };
const researchStepLabels: Record<ResearchStep, string> = {
  retrieve_news: "뉴스 수집", score_sentiment: "LLM 감성", persist_test: "Test 저장", compare_tests: "Test 비교",
  find_patterns: "공통점 분석", build_strategy: "전략 설계", run_backtest: "백테스트",
};

function koreaDate() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts();
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function formatKoreaTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

function publishedBeforeEvent(value: string, event: MarketEvent) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const eastern = `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}`;
  return eastern <= `${event.date}T${event.time}`;
}

function formatReturn(value: number | null) {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function toneClass(value?: string | number) {
  if (typeof value === "number") return value > 15 ? "positive" : value < -15 ? "negative" : "neutral";
  if (value === "긍정" || value === "강한 긍정") return "positive";
  if (value === "부정" || value === "강한 부정") return "negative";
  return "neutral";
}

function benchmarkValue(value: RangeBenchmark): BenchmarkValue | null {
  return value && "returnPct" in value ? value : null;
}

// A missing index return is a data-supply problem, not a zero. Say which.
function benchmarkNote(value: RangeBenchmark) {
  const resolved = benchmarkValue(value);
  if (resolved) return `${resolved.startDate} → ${resolved.endDate}${resolved.origin === "cache-stale" ? " · 캐시" : resolved.origin === "google-finance" ? " · 백업" : ""}`;
  return "시세 데이터 대기";
}

function benchmarkDetail(value: RangeBenchmark) {
  if (value && "unavailable" in value) return value.unavailable;
  return benchmarkValue(value) ? "" : "지수 데이터를 가져오지 못했습니다.";
}

function forecastBadge(event: ForecastEvent, count: number) {
  const code = event.indicator.match(/\(([A-Z]+)\)/)?.[1] ?? event.indicator.split(/\s+/)[0];
  return `${code} · ${count} event${count === 1 ? "" : "s"}`;
}

function returnClass(value: number | null | undefined) {
  if (value === null || value === undefined || Math.abs(value) < .01) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function recordId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function numericScore(value: number | undefined) {
  return Math.max(-100, Math.min(100, Number(value) || 0));
}

function hasCompleteMarketOutcome(test: NewsTest) {
  return [test.nasdaq, test.nyse].every((benchmark) => (
    benchmark !== null && "returnPct" in benchmark && typeof benchmark.returnPct === "number"
  ));
}

function newsTestFromAnalysis(query: RetrievedQuery, data: AnalysisResult, fallbackEvent?: ForecastEvent, existingId?: string): NewsTest {
  const forecastEvents = data.analysis.forecastEvents?.length
    ? data.analysis.forecastEvents
    : fallbackEvent ? [fallbackEvent] : [];
  return {
    id: existingId ?? recordId("test"), periodStart: query.start, periodEnd: query.end, topic: query.topic,
    articleCount: data.articleCount, overallScore: numericScore(data.analysis.score), overallLabel: data.analysis.label ?? "중립",
    techScore: numericScore(data.analysis.segments?.tech?.score), techLabel: data.analysis.segments?.tech?.label ?? "중립",
    valueScore: numericScore(data.analysis.segments?.value?.score), valueLabel: data.analysis.segments?.value?.label ?? "중립",
    nasdaq: data.benchmarks?.NASDAQ ?? null, nyse: data.benchmarks?.NYSE ?? null,
    forecastEvents, createdAt: new Date().toISOString(),
  };
}

function chartNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function DailyIndexChart({ index, events, variant }: { index: TestDetailIndex; events: TestDetailEvent[]; variant: "nasdaq" | "nyse" }) {
  const width = 760;
  const height = 280;
  const pad = { top: 28, right: 24, bottom: 34, left: 58 };
  const points = index.points;
  if (!points.length) return <div className="detail-chart-empty"><Newspaper size={18} /><strong>일봉 데이터를 불러오지 못했습니다.</strong><p>{index.reason}</p></div>;
  const values = points.map((point) => point.close);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const buffer = Math.max((rawMax - rawMin) * .12, rawMax * .002);
  const min = rawMin - buffer;
  const max = rawMax + buffer;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const x = (indexValue: number) => pad.left + (points.length === 1 ? plotWidth / 2 : (indexValue / (points.length - 1)) * plotWidth);
  const y = (value: number) => pad.top + ((max - value) / (max - min)) * plotHeight;
  const line = points.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${x(pointIndex).toFixed(2)},${y(point.close).toFixed(2)}`).join(" ");
  const selectedStart = Math.max(0, points.findIndex((point) => point.phase === "selected"));
  const selectedEndCandidate = points.findLastIndex((point) => point.phase === "selected");
  const selectedEnd = selectedEndCandidate < 0 ? selectedStart : selectedEndCandidate;
  const markerEvents = events.flatMap((event) => {
    const reaction = event.reactions[variant];
    const pointIndex = reaction ? points.findIndex((point) => point.date === reaction.effectiveDate) : -1;
    return pointIndex < 0 ? [] : [{ event, reaction, point: points[pointIndex], pointIndex }];
  });
  const ticks = [0, .25, .5, .75, 1];
  const dateTicks = Array.from(new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]));

  return (
    <article className={`detail-chart-card ${variant}`}>
      <header>
        <div><span>{index.symbol}</span><strong>{index.name}</strong></div>
        {index.summary && <b className={returnClass(index.summary.returnPct)}>{formatReturn(index.summary.returnPct)}</b>}
      </header>
      <div className="detail-chart-plot">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${index.name} 1일 종가 차트`}>
          <rect className="chart-range-fill" x={Math.max(pad.left, x(selectedStart) - 8)} y={pad.top} width={Math.max(16, x(selectedEnd) - x(selectedStart) + 16)} height={plotHeight} rx="8" />
          {ticks.map((tick) => {
            const tickY = pad.top + tick * plotHeight;
            const tickValue = max - tick * (max - min);
            return <g key={tick}><line className="chart-grid-line" x1={pad.left} x2={width - pad.right} y1={tickY} y2={tickY} /><text className="chart-axis-label" x={pad.left - 10} y={tickY + 4} textAnchor="end">{chartNumber(tickValue)}</text></g>;
          })}
          <path className="chart-index-line" d={line} />
          {markerEvents.map(({ event, reaction, point, pointIndex }) => (
            <g className={`chart-event-marker ${event.category} ${event.importance === "high" ? "high" : ""}`} key={event.id}>
              {event.importance === "high" && <circle className="event-pulse-ring" cx={x(pointIndex)} cy={y(point.close)} r="10" />}
              <line className="event-guide" x1={x(pointIndex)} x2={x(pointIndex)} y1={pad.top} y2={height - pad.bottom} />
              <circle className="event-point" cx={x(pointIndex)} cy={y(point.close)} r={event.importance === "high" ? 5.5 : 4} />
              <title>{`${event.title} · ${event.date} ${event.timeET} ET · 당일 ${formatReturn(reaction!.eventDayPct)}`}</title>
            </g>
          ))}
          {dateTicks.map((pointIndex) => <text className="chart-date-label" key={pointIndex} x={x(pointIndex)} y={height - 9} textAnchor={pointIndex === 0 ? "start" : pointIndex === points.length - 1 ? "end" : "middle"}>{points[pointIndex].date.slice(5)}</text>)}
        </svg>
      </div>
      {index.summary ? <div className="detail-chart-stats">
        <span><small>거래일</small><b>{index.summary.sessions}</b></span>
        <span><small>최대 낙폭</small><b className={returnClass(index.summary.maxDrawdownPct)}>{formatReturn(index.summary.maxDrawdownPct)}</b></span>
        <span><small>연환산 변동성</small><b>{index.summary.annualizedVolatilityPct === null ? "—" : `${index.summary.annualizedVolatilityPct.toFixed(2)}%`}</b></span>
        <span><small>상승 / 하락</small><b>{index.summary.upDays} / {index.summary.downDays}</b></span>
      </div> : <p className="detail-chart-warning">선택 기간 내 거래일이 없습니다.</p>}
    </article>
  );
}

export function MarketNews({ conversationId, onConversationChange, onHistory, onActivityChange }: { conversationId: string; onConversationChange?: (id: string) => void; onHistory?: (event: NewsHistoryEvent) => void; onActivityChange?: (activity: AgentActivity | null) => void }) {
  const today = koreaDate();
  const [startDate, setStartDate] = useState(() => shiftDate(today, -2));
  const [endDate, setEndDate] = useState(today);
  const [topic, setTopic] = useState<NewsTopic>("macro");
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [sources, setSources] = useState<NewsSource[]>([]);
  const [provider, setProvider] = useState("Google News RSS");
  const [retrieved, setRetrieved] = useState<RetrievedQuery | null>(null);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const [tests, setTests] = useState<NewsTest[]>([]);
  const [agentMessages, setAgentMessages] = useState<NewsAgentMessage[]>([]);
  const [agentQuestion, setAgentQuestion] = useState("");
  const [agentThinking, setAgentThinking] = useState(false);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [researchRuns, setResearchRuns] = useState<ResearchRun[]>([]);
  const [lastSpecialists, setLastSpecialists] = useState<AgentSpecialist[]>([]);
  const [agentStatus, setAgentStatus] = useState("");
  const [lastPlan, setLastPlan] = useState<ValidatedResearchPlan | null>(null);
  const [stateReady, setStateReady] = useState(false);
  const [activeTest, setActiveTest] = useState<NewsTest | null>(null);
  const [testDetail, setTestDetail] = useState<TestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [comparison, setComparison] = useState<{ tests: NewsTest[]; excludedDuplicates: number } | null>(null);

  useEffect(() => {
    if (batchStatus) {
      onActivityChange?.({ label: "News JARVIS", detail: `${batchStatus.phase} · ${batchStatus.label}`, progress: `${batchStatus.completed}/${batchStatus.total}` });
      return;
    }
    onActivityChange?.(agentThinking ? { label: "News JARVIS", detail: agentStatus || "질문을 해석하고 실행 계획을 만드는 중", progress: "RUNNING" } : null);
  }, [agentStatus, agentThinking, batchStatus, onActivityChange]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setStateReady(false); setLastPlan(null); setLastSpecialists([]); } });
    fetch(`/api/news/research-state?conversation=${encodeURIComponent(conversationId)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.json() as Promise<{ tests?: NewsTest[]; messages?: NewsAgentMessage[]; runs?: ResearchRun[] }>)
      .then((data) => {
        if (controller.signal.aborted) return;
        setTests(Array.isArray(data.tests) ? data.tests : []);
        setAgentMessages(Array.isArray(data.messages) ? data.messages : []);
        setResearchRuns(Array.isArray(data.runs) ? data.runs : []);
      })
      .catch(() => undefined)
      .finally(() => { if (!controller.signal.aborted) setStateReady(true); });
    return () => controller.abort();
  }, [conversationId]);

  useEffect(() => {
    if (!activeTest) return;
    const controller = new AbortController();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveTest(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    const params = new URLSearchParams({ start: activeTest.periodStart, end: activeTest.periodEnd });
    fetch(`/api/news/test-detail?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as TestDetail & { error?: string };
        if (!response.ok) throw new Error(data.error || "상세 차트를 불러오지 못했습니다.");
        setTestDetail(data);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setDetailError(reason instanceof Error ? reason.message : "상세 차트를 불러오지 못했습니다.");
      })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => {
      controller.abort();
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeTest]);

  function openTestDetail(test: NewsTest) {
    setTestDetail(null);
    setDetailError("");
    setDetailLoading(true);
    setActiveTest(test);
  }

  function openComparison() {
    const seen = new Set<string>();
    const uniqueLatest = [...tests].reverse().filter((test) => {
      const key = `${test.periodStart}:${test.periodEnd}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).reverse();
    if (uniqueLatest.length < 2) return;
    setActiveTest(null);
    setComparison({ tests: uniqueLatest, excludedDuplicates: tests.length - uniqueLatest.length });
  }

  async function persistRecord(kind: "test" | "message" | "run", value: NewsTest | NewsAgentMessage | ResearchRun) {
    try {
      const response = await fetch("/api/news/research-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, [kind]: value, conversationId }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function retrieveNews() {
    if (loading) return;
    setLoading(true);
    setError("");
    setNotice("");
    setSources([]);
    setAnalysis(null);
    setAnalysisError("");
    try {
      const params = new URLSearchParams({ start: startDate, end: endDate, topic });
      const response = await fetch(`/api/news?${params}`, { cache: "no-store" });
      const data = await response.json() as { articles?: NewsArticle[]; sources?: NewsSource[]; provider?: string; error?: string; notice?: string | null };
      setSources(data.sources ?? []);
      setProvider(data.provider ?? "Google News RSS");
      if (!response.ok) throw new Error(data.error || "뉴스를 가져오지 못했습니다.");
      const next = data.articles ?? [];
      setNotice(data.notice ?? "");
      setArticles(next);
      setRetrieved({ start: startDate, end: endDate, topic });
      setSelected(new Set(next.slice(0, 40).map((article) => article.id)));
      const active = (data.sources ?? []).filter((source) => source.count > 0).length;
      onHistory?.({ title: "뉴스 수집", detail: `${startDate} – ${endDate} · ${next.length}건 · ${active}/10개 매체` });
    } catch (reason) {
      setArticles([]);
      setRetrieved(null);
      setSelected(new Set());
      setNotice("");
      setError(reason instanceof Error ? reason.message : "뉴스를 가져오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  const signalById = useMemo(() => new Map(analysis?.analysis.articleSignals?.map((signal) => [signal.id, signal]) ?? []), [analysis]);

  function toggleArticle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 40) next.add(id);
      return next;
    });
    setAnalysis(null);
  }

  async function runAnalysis() {
    if (!selected.size || analyzing || !retrieved) return;
    setAnalyzing(true);
    setAnalysisError("");
    try {
      const chosen = articles.filter((article) => selected.has(article.id)).slice(0, 40);
      const response = await fetch("/api/news/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: retrieved.end, start: retrieved.start, articles: chosen }),
      });
      const data = await response.json() as AnalysisResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "뉴스 분석에 실패했습니다.");
      setAnalysis(data);
      const test = newsTestFromAnalysis(retrieved, data);
      if (!await persistRecord("test", test)) throw new Error("분석은 완료됐지만 Test 저장에 실패했습니다.");
      setTests((current) => [...current, test].slice(-100));
      onHistory?.({ title: "뉴스 감성 분석", detail: `${retrieved.start} – ${retrieved.end} · ${chosen.length}건 · ${data.analysis.label ?? "분석 완료"}` });
    } catch (reason) {
      setAnalysisError(reason instanceof Error ? reason.message : "뉴스 분석에 실패했습니다.");
    } finally {
      setAnalyzing(false);
    }
  }

  function appendAgentMessage(role: NewsAgentMessage["role"], content: string) {
    const message = { id: recordId(role), role, content, createdAt: new Date().toISOString() };
    setAgentMessages((current) => [...current, message].slice(-200));
    void persistRecord("message", message);
    return message;
  }

  async function publishResearchRun(run: ResearchRun) {
    setResearchRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, 20));
    return persistRecord("run", run);
  }

  function agentSelectionCommand(prompt: string) {
    const normalized = prompt.replaceAll(" ", "");
    const signals = analysis?.analysis.articleSignals ?? [];
    const requested = normalized.includes("긍정") ? "긍정" : normalized.includes("부정") ? "부정" : normalized.includes("중립") ? "중립" : null;
    if (!requested || !/선택|골라|추려/.test(normalized) || !signals.length) return null;
    const ids = signals.filter((signal) => signal.label === requested).map((signal) => signal.id).slice(0, 40);
    setSelected(new Set(ids));
    setAnalysis(null);
    return `${requested}으로 분류된 뉴스 ${ids.length}건을 선택했습니다. 이 선택으로 다시 LLM 분석을 실행하면 새 Test 행이 생성됩니다.`;
  }

  async function runBatchResearch(plan: BatchResearchPlan, command: string) {
    if (!plan.events.length) {
      appendAgentMessage("agent", `${plan.note ? `${plan.note}\n` : ""}${plan.range.from} → ${plan.range.to} 범위에 등록된 ${plan.label} 발표가 없습니다.${plan.coverageWarning ? `\n${plan.coverageWarning}` : ""}`);
      return;
    }
    setBatchStatus({ completed: 0, total: plan.events.length, label: `${plan.label} · ${plan.range.label}`, phase: "계획 검증 완료" });
    const completed: NewsTest[] = [];
    const failed: string[] = [];
    const existingTests = [...tests].reverse();
    const eventDefinition = NEWS_EVENT_DEFINITIONS.find((item) => item.root === plan.root);
    const createdAt = new Date().toISOString();
    let stages: ResearchRunStage[] = plan.events.map((event) => ({ date: event.date, status: "queued", detail: "대기" }));
    let run: ResearchRun = {
      id: recordId("run"), command, label: `${plan.range.label} ${plan.label} 연구`, status: "running",
      totalEvents: plan.events.length, completedEvents: 0, failedEvents: 0, stages,
      result: { plan: { range: `${plan.range.from}→${plan.range.to}`, steps: plan.requestedSteps, planner: plan.planner } }, createdAt, updatedAt: createdAt,
    };
    await publishResearchRun(run);

    for (let index = 0; index < plan.events.length; index += 1) {
      const event = plan.events[index];
      stages = stages.map((stage, stageIndex) => stageIndex === index ? { ...stage, status: "running", detail: "사전 뉴스 탐색" } : stage);
      run = { ...run, stages, updatedAt: new Date().toISOString() };
      await publishResearchRun(run);
      const existing = existingTests.find((test) => test.forecastEvents?.some((item) => (
        item.scheduledReleaseDate === event.date && Boolean(eventDefinition?.aliases.test(item.indicator))
      )));
      if (existing && hasCompleteMarketOutcome(existing)) {
        completed.push(existing);
        stages = stages.map((stage, stageIndex) => stageIndex === index ? { ...stage, status: "reused", detail: "기존 Test 재사용", testId: existing.id } : stage);
        run = { ...run, completedEvents: completed.length, stages, updatedAt: new Date().toISOString() };
        await publishResearchRun(run);
        setBatchStatus({ completed: index + 1, total: plan.events.length, label: `${plan.label} · ${event.date}`, phase: "기존 Test 재사용" });
        continue;
      }

      try {
        setBatchStatus({ completed: index, total: plan.events.length, label: `${plan.label} · ${event.date}`, phase: "발표 전 뉴스 수집" });
        let newsStart = shiftDate(event.date, -7);
        let chosen: NewsArticle[] = [];
        let allArticles: NewsArticle[] = [];
        let newsData: { articles?: NewsArticle[]; sources?: NewsSource[]; provider?: string; notice?: string | null; error?: string } = {};
        for (const lookback of [7, 21]) {
          newsStart = shiftDate(event.date, -lookback);
          const newsParams = new URLSearchParams({ start: newsStart, end: event.date, topic: "forecast", event: plan.root });
          const newsResponse = await fetch(`/api/news?${newsParams}`, { cache: "no-store" });
          newsData = await newsResponse.json() as typeof newsData;
          if (!newsResponse.ok) throw new Error(newsData.error || "뉴스 수집 실패");
          allArticles = newsData.articles ?? [];
          chosen = allArticles.filter((article) => article.eventId === plan.root && article.eventDate === event.date && publishedBeforeEvent(article.publishedAt, event)).slice(0, 40);
          if (chosen.length) break;
        }
        if (!chosen.length) throw new Error("해당 발표의 사전 전망 뉴스가 없음");

        setArticles(allArticles);
        setSources(newsData.sources ?? []);
        setProvider(newsData.provider ?? "Google News RSS");
        setNotice(newsData.notice ?? "");
        setRetrieved({ start: newsStart, end: event.date, topic: "forecast" });
        setSelected(new Set(chosen.map((article) => article.id)));
        setBatchStatus({ completed: index, total: plan.events.length, label: `${plan.label} · ${event.date}`, phase: `${chosen.length}건 LLM 분석` });

        const analysisResponse = await fetch("/api/news/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ date: event.date, start: newsStart, articles: chosen }),
        });
        const analysisData = await analysisResponse.json() as AnalysisResult & { error?: string };
        if (!analysisResponse.ok) throw new Error(analysisData.error || "LLM 분석 실패");
        setAnalysis(analysisData);
        const fallbackEvent: ForecastEvent = {
          indicator: event.title,
          scheduledReleaseDate: event.date,
          scheduledTimeET: event.time,
          consensus: null,
          previous: null,
          expectationDirection: "불명확",
          evidenceIds: chosen.map((article) => article.id),
          caveat: "발표 일정은 경제 캘린더 기준이며, 헤드라인에서 수치 컨센서스를 추출하지 못했을 수 있습니다.",
        };
        const test = newsTestFromAnalysis({ start: newsStart, end: event.date, topic: "forecast" }, analysisData, fallbackEvent, existing?.id);
        if (!await persistRecord("test", test)) throw new Error("분석 결과의 Test 저장 실패");
        completed.push(test);
        setTests((current) => [...current.filter((item) => item.id !== test.id), test].slice(-100));
        stages = stages.map((stage, stageIndex) => stageIndex === index ? { ...stage, status: "complete", detail: `${chosen.length}개 뉴스 · ${test.overallLabel}`, testId: test.id } : stage);
        run = { ...run, completedEvents: completed.length, stages, updatedAt: new Date().toISOString() };
        await publishResearchRun(run);
        onHistory?.({ title: `${plan.label} 일괄 연구`, detail: `${event.date} · ${chosen.length}건 · ${test.overallLabel}` });
        setBatchStatus({ completed: index + 1, total: plan.events.length, label: `${plan.label} · ${event.date}`, phase: "Test 행 저장" });
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : "처리 실패";
        failed.push(`${event.date}: ${detail}`);
        stages = stages.map((stage, stageIndex) => stageIndex === index ? { ...stage, status: "failed", detail } : stage);
        run = { ...run, failedEvents: failed.length, stages, updatedAt: new Date().toISOString() };
        await publishResearchRun(run);
        setBatchStatus({ completed: index + 1, total: plan.events.length, label: `${plan.label} · ${event.date}`, phase: "건너뜀" });
      }
    }

    const unique = [...completed].reverse().filter((test, index, values) => values.findIndex((candidate) => candidate.periodEnd === test.periodEnd) === index).reverse();
    const note = plan.note ? `${plan.note}\n` : "";
    const failureText = failed.length ? `\n제외 ${failed.length}개: ${failed.join(" / ")}` : "";
    const summary = `${plan.events.length}개 발표 중 ${unique.length}개 Test 생성 · ${failed.length}개 실패`;
    run = {
      ...run, status: unique.length === plan.events.length ? "complete" : unique.length ? "partial" : "failed",
      completedEvents: unique.length, failedEvents: failed.length, stages,
      result: { summary, testIds: unique.map((test) => test.id), plan: { range: `${plan.range.from}→${plan.range.to}`, steps: plan.requestedSteps, planner: plan.planner } }, updatedAt: new Date().toISOString(),
    };
    const runPersisted = await publishResearchRun(run);
    const comparisonRequested = plan.requestedSteps.includes("compare_tests");
    const comparisonText = comparisonRequested
      ? unique.length >= 2 ? "\n요청한 Test 비교 화면을 열었습니다." : "\n비교를 요청했지만 유효 Test가 2개 미만이라 비교 화면은 열지 않았습니다."
      : "";
    appendAgentMessage("agent", `${note}${plan.range.label}(${plan.range.from} → ${plan.range.to}) ${plan.label} 발표 ${plan.events.length}개를 실행해 ${unique.length}개 Test를 준비했습니다. 발표 7일 전을 우선 탐색하고 없으면 21일까지 확장했으며, 발표 시각 이후 뉴스는 제외했습니다.${plan.coverageWarning ? `\n일정 범위 경고: ${plan.coverageWarning}` : ""}${failureText}${comparisonText}${runPersisted ? "\n실행 계획과 결과는 Test 상단 Research run에 저장했습니다." : "\n실행 내역 저장소 연결은 확인이 필요합니다."}`);
    if (comparisonRequested && unique.length >= 2) setComparison({ tests: unique, excludedDuplicates: completed.length - unique.length });
    const needsDownstreamAnalysis = plan.requestedSteps.some((step) => step === "find_patterns" || step === "build_strategy" || step === "run_backtest");
    if (needsDownstreamAnalysis) {
      setAgentStatus("후속 분석 · 전문 에이전트 실행 중");
      const response = await fetch("/api/news/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: command,
          plan: {
            version: 1, mode: "analyze_existing", goal: command, eventRoot: plan.root, eventLabel: plan.label,
            range: plan.range, requestedSteps: plan.requestedSteps,
            confidence: 1, assumptions: [], clarification: null,
          },
          context: { tests: unique },
        }),
      });
      await readAgentStream(response, (event) => {
        if (event.type === "specialist") setLastSpecialists((current) => [...current.filter((item) => item.id !== event.specialist.id), event.specialist]);
        if (event.type === "done") {
          setLastSpecialists([{ id: "planner", label: "Intent Planner", status: "complete" }, { id: "executor", label: "Research Executor", status: "complete" }, ...event.specialists]);
          appendAgentMessage("agent", event.answer || "후속 분석 응답이 비어 있습니다.");
        }
      });
    }
    setBatchStatus(null);
  }

  async function askNewsAgent(event: FormEvent) {
    event.preventDefault();
    const prompt = agentQuestion.trim();
    if (!prompt || agentThinking) return;
    appendAgentMessage("user", prompt);
    setAgentQuestion("");
    const commandReply = agentSelectionCommand(prompt);
    if (commandReply) {
      appendAgentMessage("agent", commandReply);
      return;
    }
    setAgentThinking(true);
    try {
      const planResponse = await fetch("/api/news/agent/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: prompt, today, history: agentMessages.slice(-8), testCount: tests.length }),
      });
      const planned = await planResponse.json() as AgentPlanResult;
      if (!planResponse.ok || !planned.plan) throw new Error(planned.error || "질문의 실행 계획을 만들지 못했습니다.");
      setLastPlan(planned.plan);
      setLastSpecialists([{ id: "planner", label: "Intent Planner", status: "complete" }]);
      if (planned.plan.mode === "clarify") {
        appendAgentMessage("agent", planned.plan.clarification || "요청을 실행하려면 범위나 이벤트를 조금 더 구체적으로 알려주세요.");
        return;
      }
      if (planned.plan.mode === "research_pipeline") {
        if (!planned.plan.eventRoot || !planned.plan.eventLabel || !planned.plan.range) throw new Error("실행 계획에 이벤트 또는 기간이 없습니다.");
        const batchPlan: BatchResearchPlan = {
          root: planned.plan.eventRoot,
          label: planned.plan.eventLabel,
          range: planned.plan.range,
          note: planned.plan.assumptions.join(" ") || null,
          requestedSteps: planned.plan.requestedSteps,
          events: planned.events,
          coverageWarning: planned.coverage.warning,
          planner: planned.planner,
        };
        setLastSpecialists([
          { id: "planner", label: "Intent Planner", status: "complete" },
          { id: "executor", label: "Research Executor", status: "complete" },
        ]);
        await runBatchResearch(batchPlan, prompt);
        return;
      }
      const chosen = articles.filter((article) => selected.has(article.id)).slice(0, 40)
        .map(({ id, title, source, publishedAt, topic: articleTopic, eventId, eventTitle, eventDate, eventTimeET, stage }) => ({ id, title, source, publishedAt, topic: articleTopic, eventId, eventTitle, eventDate, eventTimeET, stage }));
      setAgentStatus("전문 에이전트 실행 중");
      const response = await fetch("/api/news/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: prompt, plan: planned.plan, history: agentMessages.slice(-8).map(({ role, content }) => ({ role, content })), context: { retrieved, headlines: chosen, analysis, tests } }),
      });
      await readAgentStream(response, (event) => {
        if (event.type === "specialist") { setLastSpecialists((current) => [...current.filter((item) => item.id !== event.specialist.id), event.specialist]); setAgentStatus(`${event.specialist.label} · ${event.specialist.status === "running" ? "실행 중" : "완료"}`); }
        if (event.type === "done") { setLastSpecialists([{ id: "planner", label: "Intent Planner", status: "complete" }, ...event.specialists]); appendAgentMessage("agent", event.answer || "응답이 비어 있습니다."); }
      });
      onHistory?.({ title: "News JARVIS", detail: prompt });
    } catch (reason) {
      appendAgentMessage("agent", reason instanceof Error ? reason.message : "News Agent에 연결하지 못했습니다.");
    } finally {
      setBatchStatus(null);
      setAgentThinking(false);
      setAgentStatus("");
    }
  }

  const score = Math.max(-100, Math.min(100, analysis?.analysis.score ?? 0));
  const techScore = numericScore(analysis?.analysis.segments?.tech?.score);
  const valueScore = numericScore(analysis?.analysis.segments?.value?.score);
  const activeSourceCount = sources.filter((source) => source.count > 0).length;
  const queryChanged = Boolean(retrieved && (retrieved.start !== startDate || retrieved.end !== endDate || retrieved.topic !== topic));

  return (
    <section className="news-view">
      <header className="news-page-head">
        <div><span>ECONOMIC NEWS</span><h1>News Research</h1></div>
        <div className="news-controls">
          <label>시작일 · KST<input type="date" value={startDate} max={endDate} onChange={(event) => setStartDate(event.target.value)} /></label>
          <label>종료일 · KST<input type="date" value={endDate} min={startDate} max={today} onChange={(event) => setEndDate(event.target.value)} /></label>
          <button className="retrieve-button" onClick={retrieveNews} disabled={loading} aria-label="뉴스 가져오기"><RefreshCw size={14} className={loading ? "spin" : ""} /><span>{loading ? "수집 중" : queryChanged ? "변경 적용" : "뉴스 가져오기"}</span></button>
        </div>
      </header>

      <div className="news-workspace">
        <article className="news-feed">
          <div className="news-feed-toolbar">
            <div className="news-topics">
              {topicOptions.map((option) => <button key={option.id} className={topic === option.id ? "active" : ""} onClick={() => setTopic(option.id)}>{option.label}</button>)}
            </div>
            <div><span>{articles.length} articles</span><button onClick={() => setSelected(selected.size ? new Set() : new Set(articles.slice(0, 40).map((article) => article.id)))}>{selected.size ? "선택 해제" : "최대 40개 선택"}</button></div>
          </div>

          <div className="news-source-strip" aria-label="신뢰 언론사 수집 현황">
            {sources.length ? sources.map((source) => <span key={source.id} className={source.status === "error" ? "error" : source.count ? "active" : ""}>{source.name} <b>{source.status === "error" ? "!" : source.count}</b></span>) : <small>Reuters, AP, Bloomberg, FT, WSJ, CNBC, BBC, NYT, Washington Post, Guardian</small>}
          </div>

          <div className="news-scroll">
            {loading && <div className="news-empty"><RefreshCw size={19} className="spin" /><strong>뉴스를 불러오는 중</strong></div>}
            {!loading && error && <div className="news-empty"><Newspaper size={19} /><strong>{error}</strong></div>}
            {!loading && !error && !retrieved && <div className="news-empty"><Newspaper size={19} /><strong>날짜 범위를 고른 뒤 뉴스 가져오기를 눌러주세요.</strong></div>}
            {!loading && !error && retrieved && !articles.length && <div className="news-empty"><Newspaper size={19} /><strong>{notice || "선택한 범위에는 검색된 뉴스가 없습니다."}</strong></div>}
            {!loading && articles.map((article) => {
              const signal = signalById.get(article.id);
              return (
                <article className={`news-row ${selected.has(article.id) ? "selected" : ""}`} key={article.id}>
                  <label aria-label={`${article.title} 분석 포함`}><input type="checkbox" checked={selected.has(article.id)} onChange={() => toggleArticle(article.id)} /><span /></label>
                  <div className="news-row-body">
                    <div className="news-row-meta"><span className={`news-topic ${article.topic}`}>{topicLabels[article.topic]}</span>{article.eventId && <span className="forecast-event-chip">{article.eventId.toUpperCase()}{article.eventDate ? ` · ${article.eventDate}` : ""}</span>}<span>{article.source}</span><time>{formatKoreaTime(article.publishedAt)} KST</time>{signal && <span className={`article-tone ${toneClass(signal.label)}`}>{signal.label} {signal.score > 0 ? "+" : ""}{signal.score}</span>}</div>
                    <a href={article.url} target="_blank" rel="noreferrer"><strong>{article.title}</strong><ExternalLink size={12} /></a>
                  </div>
                </article>
              );
            })}
          </div>
          <footer>{queryChanged ? "필터가 변경되었습니다 · 뉴스 가져오기로 적용" : retrieved ? `${provider} · 신뢰 매체 ${sources.length}곳 중 ${activeSourceCount}곳 검색됨` : "Google News · 지정 신뢰 매체 10곳"} · 제목/출처만 수집</footer>
        </article>

        <aside className="news-analysis">
          <div className="news-analysis-head">
            <div><span className="agent-mark"><Sparkles size={15} /></span><div><strong>Sentiment</strong><small>{retrieved ? `${retrieved.start} – ${retrieved.end}` : "수집 전"} · {selected.size}개 선택</small></div></div>
            <button className="run-button" disabled={!selected.size || analyzing || loading || !retrieved || queryChanged} onClick={runAnalysis}>{analyzing ? "분석 중…" : "LLM 분석"}</button>
          </div>

          <div className="news-analysis-scroll">
            {!analysis && !analyzing && !analysisError && <div className="analysis-empty"><Sparkles size={20} /><strong>선택한 뉴스만 분석합니다.</strong><p>헤드라인의 거시경제 분위기와 주식시장 관점의 긍·부정을 분리하고, 해당 날짜 전후 SPY·QQQ 움직임과 연결합니다.</p></div>}
            {analyzing && <div className="analysis-empty"><div className="agent-thinking"><i /><i /><i /></div><strong>헤드라인과 시장 데이터를 비교 중</strong></div>}
            {analysisError && <div className="analysis-empty error"><strong>{analysisError}</strong></div>}
            {analysis && (
              <div className="analysis-result">
                {analysis.analysis.raw ? <p className="raw-analysis">{analysis.analysis.raw}</p> : <>
                  <section className="sentiment-score">
                    <div><span>Equity sentiment</span><strong className={toneClass(score)}>{score > 0 ? "+" : ""}{score}</strong></div>
                    <div className="sentiment-track"><i style={{ width: `${(score + 100) / 2}%` }} /></div>
                    <div><b className={toneClass(analysis.analysis.label)}>{analysis.analysis.label}</b><small>경제 톤 {analysis.analysis.macroTone} · 확신도 {analysis.analysis.confidence ?? 0}%</small></div>
                  </section>
                  <section className="segment-sentiment" aria-label="스타일별 감성">
                    <article>
                      <header><span>TECH / GROWTH</span><strong className={toneClass(techScore)}>{techScore > 0 ? "+" : ""}{techScore}</strong></header>
                      <div className="segment-track"><i style={{ width: `${(techScore + 100) / 2}%` }} /></div>
                      <div><b className={toneClass(analysis.analysis.segments?.tech?.label)}>{analysis.analysis.segments?.tech?.label ?? "중립"}</b><p>{analysis.analysis.segments?.tech?.rationale ?? "기술주 민감도 근거가 없습니다."}</p></div>
                    </article>
                    <article>
                      <header><span>VALUE</span><strong className={toneClass(valueScore)}>{valueScore > 0 ? "+" : ""}{valueScore}</strong></header>
                      <div className="segment-track"><i style={{ width: `${(valueScore + 100) / 2}%` }} /></div>
                      <div><b className={toneClass(analysis.analysis.segments?.value?.label)}>{analysis.analysis.segments?.value?.label ?? "중립"}</b><p>{analysis.analysis.segments?.value?.rationale ?? "가치주 민감도 근거가 없습니다."}</p></div>
                    </article>
                  </section>
                  {analysis.analysis.distribution && <div className="sentiment-distribution"><span><i className="positive" />긍정 <b>{analysis.analysis.distribution.positive}</b></span><span><i className="neutral" />중립 <b>{analysis.analysis.distribution.neutral}</b></span><span><i className="negative" />부정 <b>{analysis.analysis.distribution.negative}</b></span></div>}
                  <p className="analysis-summary">{analysis.analysis.summary}</p>

                  {!!analysis.analysis.forecastEvents?.length && <section className="forecast-analysis"><header><CalendarClock size={13} /><strong>발표 전 컨센서스</strong></header>{analysis.analysis.forecastEvents.map((event) => <article key={`${event.indicator}-${event.scheduledReleaseDate ?? "unknown"}`}><div><strong>{event.indicator}</strong><span>{event.scheduledReleaseDate ?? "발표일 미확인"}{event.scheduledTimeET ? ` · ${event.scheduledTimeET} ET` : ""}</span></div><dl><div><dt>CONSENSUS</dt><dd>{event.consensus ?? "헤드라인에 수치 없음"}</dd></div><div><dt>PREVIOUS</dt><dd>{event.previous ?? "확인 불가"}</dd></div><div><dt>DIRECTION</dt><dd>{event.expectationDirection}</dd></div></dl><p>{event.caveat}</p></article>)}</section>}

                  <section className="market-reaction"><header><CalendarClock size={13} /><strong>시장 전후 움직임</strong></header><div>{(["SPY", "QQQ"] as const).map((ticker) => { const item = analysis.market[ticker]; return <article key={ticker}><strong>{ticker}</strong><span><small>이전 1D</small><b className={returnClass(item?.prior1D)}>{formatReturn(item?.prior1D ?? null)}</b></span><span><small>이전 5D</small><b className={returnClass(item?.prior5D)}>{formatReturn(item?.prior5D ?? null)}</b></span><span><small>이후 5D</small><b className={returnClass(item?.forward5D)}>{formatReturn(item?.forward5D ?? null)}</b></span></article>; })}</div></section>

                  {analysis.events.length > 0 && <section className="nearby-events"><h3>근접 주요 일정</h3>{analysis.events.map((event) => <div key={`${event.date}-${event.title}`}><span>{event.date} · {event.timeET} ET</span><strong>{event.title}</strong></div>)}</section>}
                  <section className="analysis-block"><h3>판독</h3><p>{analysis.analysis.marketRead}</p></section>
                  {!!analysis.analysis.themes?.length && <section className="analysis-block"><h3>주요 테마</h3>{analysis.analysis.themes.map((theme) => <article key={theme.name}><div><strong>{theme.name}</strong><span className={toneClass(theme.tone)}>{theme.tone}</span></div><p>{theme.evidence}</p></article>)}</section>}
                  {!!analysis.analysis.hypotheses?.length && <section className="analysis-block"><h3>검증 가설</h3><ol>{analysis.analysis.hypotheses.map((item) => <li key={item}>{item}</li>)}</ol></section>}
                  {analysis.analysis.nextTest && <section className="next-test"><span>Next deterministic test</span><p>{analysis.analysis.nextTest}</p></section>}
                  {!!analysis.analysis.limitations?.length && <section className="analysis-limit"><h3>제한</h3><ul>{analysis.analysis.limitations.map((item) => <li key={item}>{item}</li>)}</ul></section>}
                </>}
              </div>
            )}
          </div>
        </aside>
      </div>

      <div className="news-research-lab">
        <section className="news-test-panel">
          <header className="research-panel-head">
            <div><span className="test-mark"><FlaskConical size={15} /></span><div><strong>Test</strong><small>Sentiment vs realized index return</small></div></div>
            <div className="test-panel-actions"><span>{tests.length} runs</span><button type="button" onClick={openComparison} disabled={tests.length < 2}><ChartNoAxesCombined size={13} />전체 비교</button></div>
          </header>
          {researchRuns[0] && <section className={`research-run-card ${researchRuns[0].status}`} aria-label="최근 자동 연구 실행">
            <div>
              <span>RESEARCH RUN</span>
              <strong>{researchRuns[0].label}</strong>
              <small>{researchRuns[0].result?.summary ?? `${researchRuns[0].completedEvents}/${researchRuns[0].totalEvents} 완료`}</small>
            </div>
            <div className="research-run-events">
              {researchRuns[0].stages.map((stage) => <span className={stage.status} key={stage.date} title={stage.detail}><i />{stage.date.slice(5)}<em>{stage.status === "complete" ? "Test" : stage.status === "reused" ? "재사용" : stage.status === "failed" ? "실패" : "진행"}</em></span>)}
            </div>
          </section>}
          <NewsSentimentPanelBridge tests={tests} onAsk={(prompt) => setAgentQuestion(prompt)} />
          <div className="test-table" role="table" aria-label="뉴스 감성 테스트 기록">
            <div className="test-row test-head" role="row"><span>DATE RANGE</span><span>SENTIMENT</span><span>TECH</span><span>VALUE</span><span>NASDAQ</span><span>NYSE</span></div>
            {!stateReady && <div className="research-empty"><RefreshCw size={17} className="spin" /><strong>기록을 불러오는 중</strong></div>}
            {stateReady && !tests.length && <div className="research-empty"><FlaskConical size={18} /><strong>아직 Test가 없습니다.</strong><p>Sentiment에서 LLM 분석을 실행하면 같은 날짜 범위의 NASDAQ·NYSE 수익률과 함께 한 행이 자동 생성됩니다.</p></div>}
            {[...tests].reverse().map((test) => { const firstForecast = test.forecastEvents?.[0]; return (
              <button className="test-row test-row-button" role="row" type="button" key={test.id} onClick={() => openTestDetail(test)} aria-label={`${test.periodStart}부터 ${test.periodEnd}까지 Test 상세 보기`}>
                <span><strong>{test.periodStart}</strong><small>→ {test.periodEnd} · {test.articleCount} news</small>{firstForecast ? <em title={firstForecast.indicator}>{forecastBadge(firstForecast, test.forecastEvents?.length ?? 1)}</em> : null}</span>
                <span><b className={toneClass(test.overallScore)}>{test.overallScore > 0 ? "+" : ""}{test.overallScore}</b><small>{test.overallLabel}</small></span>
                <span><b className={toneClass(test.techScore)}>{test.techScore > 0 ? "+" : ""}{test.techScore}</b><small>{test.techLabel}</small></span>
                <span><b className={toneClass(test.valueScore)}>{test.valueScore > 0 ? "+" : ""}{test.valueScore}</b><small>{test.valueLabel}</small></span>
                <span className="benchmark-cell" title={benchmarkDetail(test.nasdaq)}><b className={returnClass(benchmarkValue(test.nasdaq)?.returnPct)}>{formatReturn(benchmarkValue(test.nasdaq)?.returnPct ?? null)}</b><small>{benchmarkNote(test.nasdaq)}</small></span>
                <span className="benchmark-cell" title={benchmarkDetail(test.nyse)}><b className={returnClass(benchmarkValue(test.nyse)?.returnPct)}>{formatReturn(benchmarkValue(test.nyse)?.returnPct ?? null)}</b><small>{benchmarkNote(test.nyse)}</small></span>
              </button>
            ); })}
          </div>
          <footer>지수 수익률은 선택 범위 안 첫 거래일 종가 → 마지막 거래일 종가 · 인과관계가 아닌 사후 비교</footer>
        </section>

        <aside className="news-agent-panel">
          <header className="research-panel-head">
            <div><span className="agent-mark"><Sparkles size={15} /></span><div><strong>News JARVIS</strong><small>planner · analyst · auditor · strategist · synthesizer</small></div></div>
            <span className="news-agent-head-actions"><HistoryIcon size={12} /> {agentMessages.length}{agentMessages.length > 0 && !agentThinking && <button type="button" onClick={() => onConversationChange?.(crypto.randomUUID())} title="새 대화 (현재 대화는 History에 보관)">새 대화</button>}</span>
          </header>
          <div className="news-agent-context"><span>{retrieved ? `${retrieved.start} → ${retrieved.end}` : "no range"}</span><span>{selected.size} news</span><span>{tests.length} tests</span></div>
          {lastPlan && <div className="agent-plan" aria-label="해석된 실행 계획">
            <header><span>EXECUTION PLAN</span><b>{Math.round(lastPlan.confidence * 100)}%</b></header>
            <strong>{lastPlan.mode === "research_pipeline" ? `${lastPlan.eventLabel ?? "이벤트"} 연구 파이프라인` : lastPlan.mode === "analyze_existing" ? "저장된 Test 분석" : lastPlan.mode === "clarify" ? "추가 정보 필요" : "질문 응답"}</strong>
            <p>{lastPlan.range ? `${lastPlan.range.label} · ${lastPlan.range.from} → ${lastPlan.range.to}` : "기간 지정 없음"}</p>
            {!!lastPlan.requestedSteps.length && <div>{lastPlan.requestedSteps.map((step) => <span key={step}>{researchStepLabels[step]}</span>)}</div>}
          </div>}
          {!!lastSpecialists.length && <div className="agent-specialists" aria-label="이번 응답에 참여한 전문 에이전트">{lastSpecialists.map((specialist) => <span key={specialist.id} className={specialist.status} title={specialist.model ? `${specialist.label} · ${specialist.model}` : specialist.label}><i />{specialist.label}{specialist.model && <small>{specialist.model.replace(/^claude-/, "")}</small>}</span>)}</div>}
          <div className="news-agent-prompts">
            {batchStatus ? <div className="batch-progress"><span><b>{batchStatus.phase}</b><small>{batchStatus.label}</small></span><strong>{batchStatus.completed}/{batchStatus.total}</strong><i><em style={{ width: `${(batchStatus.completed / batchStatus.total) * 100}%` }} /></i></div> : ["최근 6개월 CPI 발표를 수집→분석→비교해줘", "지금까지 분석한 결과의 공통점 찾아줘", "검증 가능한 전략과 3일 백테스트 결과를 만들어줘"].map((prompt) => <button key={prompt} disabled={agentThinking} onClick={() => setAgentQuestion(prompt)}>{prompt}</button>)}
          </div>
          <div className="news-agent-log" aria-live="polite">
            {stateReady && !agentMessages.length && <div className="research-empty"><Sparkles size={18} /><strong>세 영역을 함께 조사합니다.</strong><p>현재 뉴스 선택, 감성 분석, 누적 Test를 비교하거나 “부정 뉴스만 선택해줘”처럼 뉴스 선택을 바꿔보세요.</p></div>}
            {agentMessages.map((message) => <article className={message.role} key={message.id}><span>{message.role === "user" ? "You" : "JARVIS"}</span>{message.role === "user" ? <p>{message.content}</p> : <Markdown text={message.content} />}</article>)}
            {agentThinking && <div className="agent-thinking" title={agentStatus}><i /><i /><i /></div>}
            {agentThinking && agentStatus && <small className="news-agent-status">{agentStatus}</small>}
          </div>
          <form className="news-agent-composer" onSubmit={askNewsAgent}>
            <textarea value={agentQuestion} onChange={(event) => setAgentQuestion(event.target.value)} disabled={agentThinking} aria-label="News Agent에게 질문" placeholder="예: 이 sentiment와 실제 수익률이 같은 방향이었나?" rows={3} />
            <div><span>대화는 자동 저장됩니다</span><button aria-label="News Agent에 보내기" disabled={!agentQuestion.trim() || agentThinking}><Send size={15} /></button></div>
          </form>
        </aside>
      </div>

      {comparison && <NewsSimilarity
        tests={comparison.tests}
        excludedDuplicates={comparison.excludedDuplicates}
        onClose={() => setComparison(null)}
        onAskAgent={(prompt) => setAgentQuestion(prompt)}
      />}

      {activeTest && <div className="test-detail-backdrop" role="button" tabIndex={-1} aria-label="Test 상세 닫기" onClick={(event) => { if (event.target === event.currentTarget) setActiveTest(null); }} onKeyDown={(event) => { if (event.key === "Escape") setActiveTest(null); }}>
        <article className="test-detail-page" role="dialog" aria-modal="true" aria-labelledby="test-detail-title">
          <header className="test-detail-head">
            <div>
              <span>EVENT REACTION STUDY</span>
              <h2 id="test-detail-title">Test 상세 분석</h2>
              <p>{activeTest.periodStart} → {activeTest.periodEnd} · 뉴스 {activeTest.articleCount}건</p>
            </div>
            <button type="button" onClick={() => setActiveTest(null)} aria-label="Test 상세 닫기"><X size={18} /></button>
          </header>

          <div className="test-detail-scroll">
            <section className="test-detail-summary" aria-label="감성 및 지수 요약">
              <article><small>전체 감성</small><strong className={toneClass(activeTest.overallScore)}>{activeTest.overallScore > 0 ? "+" : ""}{activeTest.overallScore}</strong><span>{activeTest.overallLabel}</span></article>
              <article><small>기술주 감성</small><strong className={toneClass(activeTest.techScore)}>{activeTest.techScore > 0 ? "+" : ""}{activeTest.techScore}</strong><span>{activeTest.techLabel}</span></article>
              <article><small>가치주 감성</small><strong className={toneClass(activeTest.valueScore)}>{activeTest.valueScore > 0 ? "+" : ""}{activeTest.valueScore}</strong><span>{activeTest.valueLabel}</span></article>
              <article><small>스타일 스프레드</small><strong className={toneClass(activeTest.techScore - activeTest.valueScore)}>{activeTest.techScore - activeTest.valueScore > 0 ? "+" : ""}{activeTest.techScore - activeTest.valueScore}</strong><span>Tech − Value</span></article>
            </section>

            {detailLoading && <div className="test-detail-loading"><RefreshCw size={20} className="spin" /><strong>NASDAQ·NYSE 일봉을 계산하는 중</strong><p>선택 기간 앞뒤 거래일과 경제 이벤트를 연결하고 있습니다.</p></div>}
            {!detailLoading && detailError && <div className="test-detail-loading error"><Newspaper size={20} /><strong>{detailError}</strong><p>Test 행은 보존되어 있습니다. 잠시 뒤 다시 열어주세요.</p></div>}
            {!detailLoading && testDetail && <>
              <section className="test-detail-section-head">
                <div><span>1D CLOSE</span><h3>지수 반응 차트</h3></div>
                <p>옅은 영역은 뉴스 분석 기간이며, 원은 주요 발표가 연결된 실제 거래일입니다.</p>
              </section>
              <section className="test-detail-charts">
                <DailyIndexChart index={testDetail.indices.nasdaq} events={testDetail.events} variant="nasdaq" />
                <DailyIndexChart index={testDetail.indices.nyse} events={testDetail.events} variant="nyse" />
              </section>

              <section className="test-event-section">
                <header>
                  <div><span>CATALYSTS</span><h3>주요 이벤트와 사후 반응</h3></div>
                  <div className="event-legend"><span className="fed">연준</span><span className="inflation">물가</span><span className="labor">고용</span><span className="growth">성장</span><span className="business">경기</span></div>
                </header>
                {testDetail.events.length ? <div className="test-event-list">
                  {testDetail.events.map((event) => <article className={event.category} key={event.id}>
                    <div className="test-event-copy">
                      <i className={event.importance === "high" ? "high" : ""} />
                      <div><span>{event.categoryLabel} · {event.date} {event.timeET} ET</span><strong>{event.title}</strong><p>{event.note} · <a href={event.sourceUrl} target="_blank" rel="noreferrer">{event.source}</a></p></div>
                    </div>
                    {(["nasdaq", "nyse"] as const).map((market) => { const reaction = event.reactions[market]; return <div className="test-event-reaction" key={market}>
                      <strong>{market === "nasdaq" ? "NASDAQ" : "NYSE"}</strong>
                      <span><small>발표 세션</small><b className={returnClass(reaction?.eventDayPct)}>{formatReturn(reaction?.eventDayPct ?? null)}</b></span>
                      <span><small>다음 1D</small><b className={returnClass(reaction?.next1DPct)}>{formatReturn(reaction?.next1DPct ?? null)}</b></span>
                      <span><small>이후 3D</small><b className={returnClass(reaction?.post3DPct)}>{formatReturn(reaction?.post3DPct ?? null)}</b></span>
                    </div>; })}
                  </article>)}
                </div> : <div className="test-event-empty"><CalendarClock size={18} /><strong>표시 구간에 등록된 주요 경제 발표가 없습니다.</strong></div>}
              </section>

              {!!activeTest.forecastEvents?.length && <section className="test-forecast-detail">
                <header><span>PRE-RELEASE SIGNALS</span><h3>뉴스에서 추출한 발표 전 예측</h3></header>
                <div>{activeTest.forecastEvents.map((event) => <article key={`${event.indicator}-${event.scheduledReleaseDate ?? "unknown"}`}><strong>{event.indicator}</strong><span>{event.scheduledReleaseDate ?? "발표일 미확인"}{event.scheduledTimeET ? ` · ${event.scheduledTimeET} ET` : ""}</span><dl><div><dt>CONSENSUS</dt><dd>{event.consensus ?? "수치 없음"}</dd></div><div><dt>PREVIOUS</dt><dd>{event.previous ?? "확인 불가"}</dd></div><div><dt>DIRECTION</dt><dd>{event.expectationDirection}</dd></div></dl><p>{event.caveat}</p></article>)}</div>
              </section>}

              <footer className="test-detail-method"><strong>읽는 법</strong><p>{testDetail.methodology} 08:30 ET 발표는 당일 종가 반응을 포함하지만, 14:00 ET 발표는 종가까지의 짧은 반응만 포함하므로 인과 추정이 아니라 이벤트 스크리닝 지표로 사용합니다.</p></footer>
            </>}
          </div>
        </article>
      </div>}
    </section>
  );
}
