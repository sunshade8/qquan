"use client";

import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import Newspaper from "lucide-react/dist/esm/icons/newspaper";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import { useEffect, useMemo, useState } from "react";

type NewsTopic = "macro" | "fed" | "inflation" | "labor" | "markets";
type NewsArticle = {
  id: string;
  title: string;
  source: string;
  sourceUrl: string;
  url: string;
  publishedAt: string;
  topic: NewsTopic;
};
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

export function MarketNews() {
  const [date, setDate] = useState(koreaDate);
  const [lookback, setLookback] = useState(1);
  const [topic, setTopic] = useState<NewsTopic>("macro");
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setAnalysis(null);
    setAnalysisError("");
    fetch(`/api/news?date=${date}&lookback=${lookback}&topic=${topic}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { articles?: NewsArticle[]; error?: string };
        if (!response.ok) throw new Error(data.error || "뉴스를 가져오지 못했습니다.");
        const next = data.articles ?? [];
        setArticles(next);
        setSelected(new Set(next.slice(0, 40).map((article) => article.id)));
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setArticles([]);
        setSelected(new Set());
        setError(reason instanceof Error ? reason.message : "뉴스를 가져오지 못했습니다.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date, lookback, refreshKey, topic]);

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
    if (!selected.size || analyzing) return;
    setAnalyzing(true);
    setAnalysisError("");
    try {
      const chosen = articles.filter((article) => selected.has(article.id)).slice(0, 40);
      const response = await fetch("/api/news/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date, start: lookback === 1 ? date : new Date(new Date(`${date}T00:00:00Z`).getTime() - (lookback - 1) * 86400000).toISOString().slice(0, 10), articles: chosen }),
      });
      const data = await response.json() as AnalysisResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "뉴스 분석에 실패했습니다.");
      setAnalysis(data);
    } catch (reason) {
      setAnalysisError(reason instanceof Error ? reason.message : "뉴스 분석에 실패했습니다.");
    } finally {
      setAnalyzing(false);
    }
  }

  const score = Math.max(-100, Math.min(100, analysis?.analysis.score ?? 0));

  return (
    <section className="news-view">
      <header className="news-page-head">
        <div><span>ECONOMIC NEWS</span><h1>News Research</h1></div>
        <div className="news-controls">
          <label>기준일 · KST<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label>수집 기간<select value={lookback} onChange={(event) => setLookback(Number(event.target.value))}><option value={1}>당일</option><option value={3}>이전 3일</option><option value={7}>이전 7일</option></select></label>
          <button onClick={() => setRefreshKey((value) => value + 1)} aria-label="뉴스 새로고침"><RefreshCw size={15} /></button>
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

          <div className="news-scroll">
            {loading && <div className="news-empty"><RefreshCw size={19} className="spin" /><strong>뉴스를 불러오는 중</strong></div>}
            {!loading && error && <div className="news-empty"><Newspaper size={19} /><strong>{error}</strong></div>}
            {!loading && !error && !articles.length && <div className="news-empty"><Newspaper size={19} /><strong>이 날짜에는 검색된 뉴스가 없습니다.</strong></div>}
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
          <footer>Google News 색인 · 제목/출처만 수집 · 원문은 각 언론사 링크</footer>
        </article>

        <aside className="news-analysis">
          <div className="news-analysis-head">
            <div><span className="agent-mark"><Sparkles size={15} /></span><div><strong>Sentiment</strong><small>{date} · {selected.size}개 선택</small></div></div>
            <button className="run-button" disabled={!selected.size || analyzing || loading} onClick={runAnalysis}>{analyzing ? "분석 중…" : "LLM 분석"}</button>
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
