"use client";

import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Newspaper from "lucide-react/dist/esm/icons/newspaper";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import { useMemo, useState } from "react";

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
type SentimentAnalysis = {
  score?: number;
  label?: string;
  macroTone?: string;
  confidence?: number;
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
  events: Array<{ date: string; timeET: string; title: string; importance: string }>;
  articleCount: number;
};
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
      onHistory?.({ title: "뉴스 감성 분석", detail: `${retrieved.start} – ${retrieved.end} · ${chosen.length}건 · ${data.analysis.label ?? "분석 완료"}` });
    } catch (reason) {
      setAnalysisError(reason instanceof Error ? reason.message : "뉴스 분석에 실패했습니다.");
    } finally {
      setAnalyzing(false);
    }
  }

  const score = Math.max(-100, Math.min(100, analysis?.analysis.score ?? 0));
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
    </section>
  );
}
