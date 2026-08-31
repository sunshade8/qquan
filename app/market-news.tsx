"use client";

import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import HistoryIcon from "lucide-react/dist/esm/icons/history";
import Newspaper from "lucide-react/dist/esm/icons/newspaper";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Send from "lucide-react/dist/esm/icons/send";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import { FormEvent, useEffect, useMemo, useState } from "react";

type NewsTopic = "macro" | "fed" | "inflation" | "labor" | "markets";
type NewsArticle = {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  sourceUrl: string;
  url: string;
  publishedAt: string;
  topic: NewsTopic;
};
type NewsSource = { id: string; name: string; count: number; status: "ok" | "error" };
type RetrievedQuery = { start: string; end: string; topic: NewsTopic };
type MarketWindow = { anchorDate: string; close: number; prior1D: number | null; prior5D: number | null; forward1D: number | null; forward5D: number | null } | null;
type SegmentSentiment = { score: number; label: string; rationale: string };
type RangeBenchmark = { symbol: string; name: string; startDate: string; endDate: string; startClose: number; endClose: number; returnPct: number } | null;
type SentimentAnalysis = {
  score?: number;
  label?: string;
  macroTone?: string;
  confidence?: number;
  segments?: { tech?: SegmentSentiment; value?: SegmentSentiment };
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
  createdAt: string;
};
type NewsAgentMessage = { id: string; role: "user" | "agent"; content: string; createdAt: string };
type NewsHistoryEvent = { title: string; detail: string };

const topicOptions: Array<{ id: NewsTopic; label: string }> = [
  { id: "macro", label: "전체 거시" },
  { id: "fed", label: "연준·금리" },
  { id: "inflation", label: "물가" },
  { id: "labor", label: "고용" },
  { id: "markets", label: "시장" },
];

const topicLabels: Record<NewsTopic, string> = { macro: "Macro", fed: "Fed", inflation: "Inflation", labor: "Labor", markets: "Markets" };

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

export function MarketNews({ onHistory }: { onHistory?: (event: NewsHistoryEvent) => void }) {
  const today = koreaDate();
  const [startDate, setStartDate] = useState(() => shiftDate(today, -2));
  const [endDate, setEndDate] = useState(today);
  const [topic, setTopic] = useState<NewsTopic>("macro");
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [sources, setSources] = useState<NewsSource[]>([]);
  const [retrieved, setRetrieved] = useState<RetrievedQuery | null>(null);
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
  const [stateReady, setStateReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/news/research-state", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json())
      .then((data: { tests?: NewsTest[]; messages?: NewsAgentMessage[] }) => {
        setTests(Array.isArray(data.tests) ? data.tests : []);
        setAgentMessages(Array.isArray(data.messages) ? data.messages : []);
      })
      .catch(() => undefined)
      .finally(() => { if (!controller.signal.aborted) setStateReady(true); });
    return () => controller.abort();
  }, []);

  async function persistRecord(kind: "test" | "message", value: NewsTest | NewsAgentMessage) {
    try {
      await fetch("/api/news/research-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, [kind]: value }),
      });
    } catch {
      // The current screen remains usable when durable storage is temporarily unavailable.
    }
  }

  async function retrieveNews() {
    if (loading) return;
    setLoading(true);
    setError("");
    setSources([]);
    setAnalysis(null);
    setAnalysisError("");
    try {
      const params = new URLSearchParams({ start: startDate, end: endDate, topic });
      const response = await fetch(`/api/news?${params}`, { cache: "no-store" });
      const data = await response.json() as { articles?: NewsArticle[]; sources?: NewsSource[]; error?: string };
      setSources(data.sources ?? []);
      if (!response.ok) throw new Error(data.error || "뉴스를 가져오지 못했습니다.");
      const next = data.articles ?? [];
      setArticles(next);
      setRetrieved({ start: startDate, end: endDate, topic });
      setSelected(new Set(next.slice(0, 40).map((article) => article.id)));
      const active = (data.sources ?? []).filter((source) => source.count > 0).length;
      onHistory?.({ title: "뉴스 수집", detail: `${startDate} – ${endDate} · ${next.length}건 · ${active}/10개 매체` });
    } catch (reason) {
      setArticles([]);
      setRetrieved(null);
      setSelected(new Set());
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
      const test: NewsTest = {
        id: recordId("test"), periodStart: retrieved.start, periodEnd: retrieved.end, topic: retrieved.topic,
        articleCount: data.articleCount, overallScore: numericScore(data.analysis.score), overallLabel: data.analysis.label ?? "중립",
        techScore: numericScore(data.analysis.segments?.tech?.score), techLabel: data.analysis.segments?.tech?.label ?? "중립",
        valueScore: numericScore(data.analysis.segments?.value?.score), valueLabel: data.analysis.segments?.value?.label ?? "중립",
        nasdaq: data.benchmarks?.NASDAQ ?? null, nyse: data.benchmarks?.NYSE ?? null, createdAt: new Date().toISOString(),
      };
      setTests((current) => [...current, test].slice(-100));
      void persistRecord("test", test);
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
      const chosen = articles.filter((article) => selected.has(article.id)).slice(0, 40)
        .map(({ id, title, source, publishedAt, topic: articleTopic }) => ({ id, title, source, publishedAt, topic: articleTopic }));
      const response = await fetch("/api/news/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: prompt, context: { retrieved, headlines: chosen, analysis, tests } }),
      });
      const data = await response.json() as { answer?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "News Agent에 연결하지 못했습니다.");
      appendAgentMessage("agent", data.answer ?? "응답이 비어 있습니다.");
      onHistory?.({ title: "News Agent", detail: prompt });
    } catch (reason) {
      appendAgentMessage("agent", reason instanceof Error ? reason.message : "News Agent에 연결하지 못했습니다.");
    } finally {
      setAgentThinking(false);
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
            {!loading && !error && retrieved && !articles.length && <div className="news-empty"><Newspaper size={19} /><strong>선택한 범위에는 검색된 뉴스가 없습니다.</strong></div>}
            {!loading && articles.map((article) => {
              const signal = signalById.get(article.id);
              return (
                <article className={`news-row ${selected.has(article.id) ? "selected" : ""}`} key={article.id}>
                  <label aria-label={`${article.title} 분석 포함`}><input type="checkbox" checked={selected.has(article.id)} onChange={() => toggleArticle(article.id)} /><span /></label>
                  <div className="news-row-body">
                    <div className="news-row-meta"><span className={`news-topic ${article.topic}`}>{topicLabels[article.topic]}</span><span>{article.source}</span><time>{formatKoreaTime(article.publishedAt)} KST</time>{signal && <span className={`article-tone ${toneClass(signal.label)}`}>{signal.label} {signal.score > 0 ? "+" : ""}{signal.score}</span>}</div>
                    <a href={article.url} target="_blank" rel="noreferrer"><strong>{article.title}</strong><ExternalLink size={12} /></a>
                  </div>
                </article>
              );
            })}
          </div>
          <footer>{queryChanged ? "필터가 변경되었습니다 · 뉴스 가져오기로 적용" : retrieved ? `Google News · 신뢰 매체 ${sources.length}곳 중 ${activeSourceCount}곳 검색됨` : "Google News · 지정 신뢰 매체 10곳"} · 제목/출처만 수집</footer>
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
            <span>{tests.length} runs</span>
          </header>
          <div className="test-table" role="table" aria-label="뉴스 감성 테스트 기록">
            <div className="test-row test-head" role="row"><span>DATE RANGE</span><span>SENTIMENT</span><span>TECH</span><span>VALUE</span><span>NASDAQ</span><span>NYSE</span></div>
            {!stateReady && <div className="research-empty"><RefreshCw size={17} className="spin" /><strong>기록을 불러오는 중</strong></div>}
            {stateReady && !tests.length && <div className="research-empty"><FlaskConical size={18} /><strong>아직 Test가 없습니다.</strong><p>Sentiment에서 LLM 분석을 실행하면 같은 날짜 범위의 NASDAQ·NYSE 수익률과 함께 한 행이 자동 생성됩니다.</p></div>}
            {[...tests].reverse().map((test) => (
              <div className="test-row" role="row" key={test.id}>
                <span><strong>{test.periodStart}</strong><small>→ {test.periodEnd} · {test.articleCount} news</small></span>
                <span><b className={toneClass(test.overallScore)}>{test.overallScore > 0 ? "+" : ""}{test.overallScore}</b><small>{test.overallLabel}</small></span>
                <span><b className={toneClass(test.techScore)}>{test.techScore > 0 ? "+" : ""}{test.techScore}</b><small>{test.techLabel}</small></span>
                <span><b className={toneClass(test.valueScore)}>{test.valueScore > 0 ? "+" : ""}{test.valueScore}</b><small>{test.valueLabel}</small></span>
                <span><b className={returnClass(test.nasdaq?.returnPct)}>{formatReturn(test.nasdaq?.returnPct ?? null)}</b><small>{test.nasdaq ? `${test.nasdaq.startDate} → ${test.nasdaq.endDate}` : "data unavailable"}</small></span>
                <span><b className={returnClass(test.nyse?.returnPct)}>{formatReturn(test.nyse?.returnPct ?? null)}</b><small>{test.nyse ? `${test.nyse.startDate} → ${test.nyse.endDate}` : "data unavailable"}</small></span>
              </div>
            ))}
          </div>
          <footer>지수 수익률은 선택 범위 안 첫 거래일 종가 → 마지막 거래일 종가 · 인과관계가 아닌 사후 비교</footer>
        </section>

        <aside className="news-agent-panel">
          <header className="research-panel-head">
            <div><span className="agent-mark"><Sparkles size={15} /></span><div><strong>Agent</strong><small>News · Sentiment · Test context</small></div></div>
            <span><HistoryIcon size={12} /> {agentMessages.length}</span>
          </header>
          <div className="news-agent-context"><span>{retrieved ? `${retrieved.start} → ${retrieved.end}` : "no range"}</span><span>{selected.size} news</span><span>{tests.length} tests</span></div>
          <div className="news-agent-prompts">
            {["기술주와 가치주 차이 설명", "Test 결과 해석", "다음 이벤트 윈도우 제안"].map((prompt) => <button key={prompt} onClick={() => setAgentQuestion(prompt)}>{prompt}</button>)}
          </div>
          <div className="news-agent-log" aria-live="polite">
            {stateReady && !agentMessages.length && <div className="research-empty"><Sparkles size={18} /><strong>세 영역을 함께 조사합니다.</strong><p>현재 뉴스 선택, 감성 분석, 누적 Test를 비교하거나 “부정 뉴스만 선택해줘”처럼 뉴스 선택을 바꿔보세요.</p></div>}
            {agentMessages.map((message) => <article className={message.role} key={message.id}><span>{message.role === "user" ? "You" : "Agent"}</span><p>{message.content}</p></article>)}
            {agentThinking && <div className="agent-thinking"><i /><i /><i /></div>}
          </div>
          <form className="news-agent-composer" onSubmit={askNewsAgent}>
            <textarea value={agentQuestion} onChange={(event) => setAgentQuestion(event.target.value)} disabled={agentThinking} aria-label="News Agent에게 질문" placeholder="예: 이 sentiment와 실제 수익률이 같은 방향이었나?" rows={3} />
            <div><span>대화는 자동 저장됩니다</span><button aria-label="News Agent에 보내기" disabled={!agentQuestion.trim() || agentThinking}><Send size={15} /></button></div>
          </form>
        </aside>
      </div>
    </section>
  );
}
