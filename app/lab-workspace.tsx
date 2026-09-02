"use client";

import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle";
import ArrowDownRight from "lucide-react/dist/esm/icons/arrow-down-right";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined";
import Check from "lucide-react/dist/esm/icons/check";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import Send from "lucide-react/dist/esm/icons/send";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AgentActivity, LabArtifact, LabMessage, LabToolTrace } from "@/lib/lab-types";

function messageId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatPercent(value: number | null) {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function PriceComparison({ artifact }: { artifact: Extract<LabArtifact, { type: "price-comparison" }> }) {
  const width = 820;
  const height = 320;
  const pad = { top: 26, right: 28, bottom: 36, left: 48 };
  const values = artifact.points.flatMap((point) => [point.left, point.right]);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const buffer = Math.max((rawMax - rawMin) * .1, 1);
  const min = rawMin - buffer;
  const max = rawMax + buffer;
  const x = (index: number) => pad.left + (index / Math.max(1, artifact.points.length - 1)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + ((max - value) / (max - min)) * (height - pad.top - pad.bottom);
  const line = (key: "left" | "right") => artifact.points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point[key]).toFixed(2)}`).join(" ");
  const ticks = [0, .25, .5, .75, 1];
  return <article className="lab-artifact-card comparison">
    <header><div><span>PRICE SIMILARITY</span><h2>{artifact.title}</h2><p>{artifact.period.from} → {artifact.period.to} · {artifact.period.sessions} 공통 거래일</p></div><div className="lab-legend"><span className="left"><i />{artifact.left.symbol}</span><span className="right"><i />{artifact.right.symbol}</span></div></header>
    <div className="lab-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${artifact.left.name}와 ${artifact.right.name} 정규화 가격 비교`}>
      {ticks.map((tick) => { const yy = pad.top + tick * (height - pad.top - pad.bottom); const value = max - tick * (max - min); return <g key={tick}><line x1={pad.left} x2={width - pad.right} y1={yy} y2={yy} /><text x={pad.left - 9} y={yy + 4} textAnchor="end">{value.toFixed(0)}</text></g>; })}
      <path className="left-line" d={line("left")} /><path className="right-line" d={line("right")} />
      <text x={pad.left} y={height - 10}>{artifact.period.from}</text><text x={width - pad.right} y={height - 10} textAnchor="end">{artifact.period.to}</text>
    </svg></div>
    <div className="lab-metric-grid">
      <span><small>일간 수익률 상관</small><b>{artifact.metrics.returnCorrelation?.toFixed(3) ?? "—"}</b></span>
      <span><small>누적 경로 상관</small><b>{artifact.metrics.pathCorrelation?.toFixed(3) ?? "—"}</b></span>
      <span><small>{artifact.left.symbol} 기간 수익률</small><b className={(artifact.left.returnPct ?? 0) >= 0 ? "positive" : "negative"}>{formatPercent(artifact.left.returnPct)}</b></span>
      <span><small>{artifact.right.symbol} 기간 수익률</small><b className={(artifact.right.returnPct ?? 0) >= 0 ? "positive" : "negative"}>{formatPercent(artifact.right.returnPct)}</b></span>
    </div>
    <footer>{artifact.notes.join(" · ")}</footer>
  </article>;
}

function DrawdownNews({ artifact }: { artifact: Extract<LabArtifact, { type: "drawdown-news" }> }) {
  return <article className="lab-artifact-card drawdown">
    <header><div><span>EVENT LINKAGE</span><h2>{artifact.title}</h2><p>{artifact.period.from} → {artifact.period.to}</p></div><ArrowDownRight size={25} /></header>
    <div className="drawdown-events">{artifact.events.map((event) => <section key={event.date}>
      <div className="drawdown-date"><span>{event.date}</span><strong>{formatPercent(event.returnPct)}</strong><small>종가 ${event.close.toFixed(2)}</small></div>
      <div className="drawdown-headlines">{event.news.length ? event.news.map((news) => <a href={news.url} target="_blank" rel="noreferrer" key={`${news.url}-${news.title}`}><span>{news.source} · {news.publishedAt.slice(0, 10)}</span><strong>{news.title}</strong><ExternalLink size={12} /></a>) : <p>이 ±뉴스 구간에서 검색된 {artifact.company} 헤드라인이 없습니다.</p>}</div>
    </section>)}</div>
    <footer>{artifact.notes.join(" · ")}</footer>
  </article>;
}

function ArtifactView({ artifact }: { artifact: LabArtifact }) {
  if (artifact.type === "price-comparison") return <PriceComparison artifact={artifact} />;
  if (artifact.type === "drawdown-news") return <DrawdownNews artifact={artifact} />;
  return <article className="lab-artifact-card limitation"><AlertTriangle size={22} /><div><span>DATA LIMITATION</span><h2>{artifact.title}</h2><p>{artifact.explanation}</p><ul>{artifact.suggestions.map((item) => <li key={item}>{item}</li>)}</ul></div></article>;
}

export function LabWorkspace({ onActivityChange }: { onActivityChange?: (activity: AgentActivity | null) => void }) {
  const [messages, setMessages] = useState<LabMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const artifacts = useMemo(() => messages.flatMap((message) => message.artifacts), [messages]);
  const activeArtifact = artifacts.find((artifact) => artifact.id === activeArtifactId) ?? artifacts.at(-1) ?? null;

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/lab/state", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json() as Promise<{ messages?: LabMessage[] }>)
      .then((data) => setMessages(Array.isArray(data.messages) ? data.messages : []))
      .catch(() => undefined)
      .finally(() => { if (!controller.signal.aborted) setReady(true); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    onActivityChange?.(running ? { label: "Lab Agent", detail: "도구를 선택하고 결과를 계산 중", progress: "RUNNING" } : null);
  }, [onActivityChange, running]);

  async function persist(message: LabMessage) {
    try {
      await fetch("/api/lab/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
    } catch {
      // The in-memory result remains usable when persistence is temporarily unavailable.
    }
  }

  function append(role: LabMessage["role"], content: string, tools: LabToolTrace[] = [], nextArtifacts: LabArtifact[] = []) {
    const message: LabMessage = { id: messageId(role), role, content, tools, artifacts: nextArtifacts, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, message].slice(-200));
    if (nextArtifacts.length) setActiveArtifactId(nextArtifacts.at(-1)!.id);
    void persist(message);
    return message;
  }

  async function askAgent(event: FormEvent) {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt || running) return;
    append("user", prompt);
    setQuestion("");
    setError("");
    setRunning(true);
    try {
      const response = await fetch("/api/lab/agent", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: prompt, history: messages.slice(-10).map(({ role, content }) => ({ role, content })) }),
      });
      const data = await response.json() as { answer?: string; tools?: LabToolTrace[]; artifacts?: LabArtifact[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Lab Agent 실행에 실패했습니다.");
      append("agent", data.answer ?? "분석 결과가 비어 있습니다.", data.tools ?? [], data.artifacts ?? []);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "Lab Agent 실행에 실패했습니다.";
      setError(detail);
      append("agent", detail);
    } finally {
      setRunning(false);
    }
  }

  const quickPrompts = ["Rocket Lab과 SpaceX의 차트 유사도를 차트로 보여줘", "ASTS 주식이 최근 큰 폭으로 하락했을 때 SpaceX 뉴스를 알려줘", "최근 1년 RKLB와 ASTS의 차트 유사도를 비교해줘"];
  return <section className="lab-view">
    <header className="lab-page-head"><div><span>MARKET INTELLIGENCE HQ</span><h1>Lab</h1><p>주식 질문을 실행 가능한 가격·뉴스 도구로 연결합니다.</p></div><div className="lab-capabilities"><span><ChartNoAxesCombined size={13} />Price similarity</span><span><FlaskConical size={13} />Event linkage</span><span><Check size={13} />Grounded output</span></div></header>
    <div className="lab-layout">
      <aside className="lab-agent">
        <header><span className="agent-mark"><Sparkles size={15} /></span><div><strong>Lab Agent</strong><small>stock research orchestrator · persistent</small></div><em className={running ? "running" : "ready"}>{running ? "RUNNING" : "READY"}</em></header>
        <div className="lab-quick-prompts">{quickPrompts.map((prompt) => <button key={prompt} disabled={running} onClick={() => setQuestion(prompt)}>{prompt}</button>)}</div>
        <div className="lab-conversation" aria-live="polite">
          {ready && !messages.length && <div className="lab-empty"><Sparkles size={20} /><strong>주식 리서치의 시작점을 말해주세요.</strong><p>현재 버전은 두 종목 가격 유사도와 급락일 주변 회사 뉴스 연결을 실제 데이터로 수행합니다. 새로운 업무 도구는 이 화면에 계속 추가됩니다.</p></div>}
          {messages.map((message) => <article className={message.role} key={message.id}><span>{message.role === "user" ? "You" : "Lab Agent"}</span><p>{message.content}</p>{message.tools.length > 0 && <div className="lab-tool-traces">{message.tools.map((trace, index) => <span className={trace.status} key={`${trace.name}-${index}`}><i />{trace.label}<small>{trace.detail}</small></span>)}</div>}</article>)}
          {running && <div className="lab-running"><div className="agent-thinking"><i /><i /><i /></div><strong>질문을 분류하고 필요한 도구를 실행 중입니다.</strong><p>다른 메뉴로 이동해도 이 작업은 계속됩니다.</p></div>}
        </div>
        <form className="lab-composer" onSubmit={askAgent}><textarea value={question} onChange={(event) => setQuestion(event.target.value)} disabled={running} rows={4} aria-label="Lab Agent에게 질문" placeholder="예: 최근 1년 RKLB와 ASTS가 같은 방향으로 움직였는지 차트와 숫자로 보여줘" /><div><span>{error || "가격·뉴스 결과는 자동 저장"}</span><button disabled={!question.trim() || running} aria-label="Lab Agent에 보내기"><Send size={15} /></button></div></form>
      </aside>
      <section className="lab-canvas">
        <header><div><span>RESEARCH CANVAS</span><strong>{activeArtifact ? activeArtifact.title : "아직 생성된 결과가 없습니다"}</strong></div><span>{artifacts.length} artifacts</span></header>
        {artifacts.length > 1 && <div className="lab-artifact-tabs">{artifacts.map((artifact) => <button className={activeArtifact?.id === artifact.id ? "active" : ""} onClick={() => setActiveArtifactId(artifact.id)} key={artifact.id}>{artifact.type === "price-comparison" ? "차트" : artifact.type === "drawdown-news" ? "이벤트" : "제한"} · {artifact.title}</button>)}</div>}
        <div className="lab-canvas-body">{activeArtifact ? <ArtifactView artifact={activeArtifact} /> : <div className="lab-canvas-empty"><ChartNoAxesCombined size={28} /><strong>분석 결과가 이곳에 쌓입니다.</strong><p>차트는 시각적으로, 상관계수·수익률·날짜·뉴스 개수는 대화에 다시 사용할 수 있는 숫자로 함께 저장됩니다.</p></div>}</div>
      </section>
    </div>
  </section>;
}
