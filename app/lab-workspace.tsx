"use client";

import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined";
import Check from "lucide-react/dist/esm/icons/check";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import Loader from "lucide-react/dist/esm/icons/loader";
import Send from "lucide-react/dist/esm/icons/send";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { AgentActivity, LabArtifact, LabMessage, LabStreamEvent, LabToolTrace } from "@/lib/lab-types";
import { ArtifactView, artifactKindLabel } from "./lab-charts";
import { Markdown } from "./markdown";

type LiveTurn = { text: string; tools: LabToolTrace[]; status: string };

const QUICK_PROMPTS = [
  "NVDA 최근 1년 차트와 핵심 지표 보여줘",
  "RKLB, ASTS, LUNR 1년 상대 성과와 상관 비교해줘",
  "SPY가 하루 -3% 이상 빠졌을 때 이후 10거래일 수익률 분포는?",
  "QQQ 50/200 이동평균 골든크로스 전략을 5년 백테스트해줘",
  "TSLA 최근 급락일 3개와 그때 뉴스 찾아줘",
  "이번 달 미국 경제 일정과 News에서 저장한 감성 Test 요약해줘",
];

function messageId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ToolTraces({ tools }: { tools: LabToolTrace[] }) {
  if (!tools.length) return null;
  return <div className="lab-tool-traces">{tools.map((trace, index) => <span className={trace.status} key={trace.id ?? `${trace.name}-${index}`}><i />{trace.label}<small>{trace.detail}{trace.durationMs ? ` · ${(trace.durationMs / 1000).toFixed(1)}s` : ""}</small></span>)}</div>;
}

export function LabWorkspace({ onActivityChange }: { onActivityChange?: (activity: AgentActivity | null) => void }) {
  const [messages, setMessages] = useState<LabMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [ready, setReady] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const artifacts = useMemo(() => messages.flatMap((message) => message.artifacts), [messages]);
  const liveArtifacts = useRef<LabArtifact[]>([]);
  const [pendingArtifacts, setPendingArtifacts] = useState<LabArtifact[]>([]);
  const allArtifacts = useMemo(() => [...artifacts, ...pendingArtifacts], [artifacts, pendingArtifacts]);
  const activeArtifact = allArtifacts.find((artifact) => artifact.id === activeArtifactId) ?? allArtifacts.at(-1) ?? null;

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
    onActivityChange?.(running ? { label: "Lab JARVIS", detail: live?.status || "도구를 선택하고 결과를 계산 중", progress: live?.tools.length ? `${live.tools.filter((tool) => tool.status !== "running").length}/${live.tools.length}` : "RUNNING" } : null);
  }, [onActivityChange, running, live?.status, live?.tools]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, live?.text, live?.tools.length]);

  function applyEvent(event: LabStreamEvent) {
    if (event.type === "status") setLive((current) => ({ text: current?.text ?? "", tools: current?.tools ?? [], status: event.detail ? `${event.label} · ${event.detail}` : event.label }));
    else if (event.type === "text") setLive((current) => ({ text: `${current?.text ?? ""}${event.delta}`, tools: current?.tools ?? [], status: "답변 작성 중" }));
    else if (event.type === "tool_start") setLive((current) => ({ text: current?.text ?? "", status: `${event.label} 실행 중`, tools: [...(current?.tools ?? []), { id: event.id, name: event.name, label: event.label, status: "running", detail: event.detail }] }));
    else if (event.type === "tool_end") setLive((current) => ({ text: current?.text ?? "", status: `${event.label} ${event.status === "failed" ? "실패" : "완료"}`, tools: (current?.tools ?? []).map((tool) => tool.id === event.id ? { ...tool, status: event.status, detail: event.detail, durationMs: event.durationMs } : tool) }));
    else if (event.type === "artifact") { liveArtifacts.current = [...liveArtifacts.current, event.artifact]; setPendingArtifacts(liveArtifacts.current); setActiveArtifactId(event.artifact.id); }
    else if (event.type === "error") setError(event.message);
    else if (event.type === "done") {
      setMessages((current) => [...current, event.message].slice(-200));
      if (event.message.artifacts.length) setActiveArtifactId(event.message.artifacts.at(-1)!.id);
    }
  }

  async function askAgent(prompt: string) {
    if (!prompt || running) return;
    const userMessage: LabMessage = { id: messageId("user"), role: "user", content: prompt, tools: [], artifacts: [], createdAt: new Date().toISOString() };
    setMessages((current) => [...current, userMessage].slice(-200));
    setQuestion("");
    setError("");
    setRunning(true);
    setLive({ text: "", tools: [], status: "연결 중" });
    liveArtifacts.current = [];
    setPendingArtifacts([]);
    try {
      const response = await fetch("/api/lab/agent", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: prompt, history: messages.slice(-12).map(({ role, content }) => ({ role, content })) }),
      });
      if (!response.body) throw new Error("서버가 스트림을 반환하지 않았습니다.");
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || "Lab JARVIS 실행에 실패했습니다.");
      }
      const reader = response.body.getReader();
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
            const event = JSON.parse(line.slice(6)) as LabStreamEvent;
            applyEvent(event);
            if (event.type === "done") finished = true;
          } catch {
            // Ignore malformed frames; the next one carries the state forward.
          }
        }
      }
      if (!finished) throw new Error("응답 스트림이 중간에 끊겼습니다.");
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "Lab JARVIS 실행에 실패했습니다.";
      setError(detail);
      setMessages((current) => [...current, { id: messageId("agent"), role: "agent", content: `⚠️ ${detail}`, tools: live?.tools ?? [], artifacts: liveArtifacts.current, createdAt: new Date().toISOString() }]);
    } finally {
      setRunning(false);
      setLive(null);
      setPendingArtifacts([]);
      liveArtifacts.current = [];
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void askAgent(question.trim());
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void askAgent(question.trim()); }
  }

  async function clearHistory() {
    if (!confirmClear) { setConfirmClear(true); window.setTimeout(() => setConfirmClear(false), 4000); return; }
    setConfirmClear(false);
    try { await fetch("/api/lab/state", { method: "DELETE" }); } catch { /* local state clears regardless */ }
    setMessages([]);
    setActiveArtifactId(null);
  }

  return <section className="lab-view">
    <header className="lab-page-head">
      <div><span>MARKET INTELLIGENCE HQ</span><h1>Lab</h1><p>JARVIS에게 종목·시장·전략을 묻고, 계산과 차트는 Research Canvas에서 확인합니다.</p></div>
      <div className="lab-capabilities"><span><ChartNoAxesCombined size={13} />Charts · Indicators</span><span><FlaskConical size={13} />Event study · Backtest</span><span><Check size={13} />Grounded numbers</span></div>
    </header>
    <div className="lab-layout">
      <aside className={`lab-agent ${messages.length ? "" : "with-prompts"}`}>
        <header>
          <span className="agent-mark"><Sparkles size={15} /></span>
          <div><strong>Lab JARVIS</strong><small>quant PM · 14 tools · persistent memory</small></div>
          <div className="lab-agent-actions">
            <em className={running ? "running" : "ready"}>{running ? "RUNNING" : "READY"}</em>
            {messages.length > 0 && !running && <button className={confirmClear ? "danger" : ""} onClick={clearHistory} aria-label="대화 기록 지우기" title={confirmClear ? "한 번 더 누르면 삭제" : "대화 기록 지우기"}>{confirmClear ? <X size={13} /> : <Trash2 size={13} />}</button>}
          </div>
        </header>
        {!messages.length && <div className="lab-quick-prompts">{QUICK_PROMPTS.map((prompt) => <button key={prompt} disabled={running} onClick={() => void askAgent(prompt)}>{prompt}</button>)}</div>}
        <div className="lab-conversation" aria-live="polite" ref={logRef}>
          {ready && !messages.length && <div className="lab-empty"><Sparkles size={20} /><strong>무엇이든 물어보세요.</strong><p>가격·차트·지표·상관·이벤트 스터디·백테스트·리스크·계절성·뉴스·경제 일정을 실제 데이터로 계산하고, 시장 지식 질문은 바로 답합니다.</p></div>}
          {messages.map((message) => <article className={message.role} key={message.id}>
            <span>{message.role === "user" ? "You" : "JARVIS"}{message.role === "agent" && message.model ? <small> · {message.model}{typeof message.costUsd === "number" ? ` · $${message.costUsd.toFixed(4)}` : ""}</small> : null}</span>
            {message.role === "user" ? <p>{message.content}</p> : <Markdown text={message.content} />}
            <ToolTraces tools={message.tools} />
            {message.artifacts.length > 0 && <div className="lab-artifact-links">{message.artifacts.map((artifact) => <button key={artifact.id} className={activeArtifact?.id === artifact.id ? "active" : ""} onClick={() => setActiveArtifactId(artifact.id)}>{artifactKindLabel(artifact)} · {artifact.title}</button>)}</div>}
          </article>)}
          {running && live && <article className="agent live">
            <span>JARVIS<small> · {live.status}</small></span>
            <ToolTraces tools={live.tools} />
            {live.text ? <Markdown text={live.text} /> : <div className="lab-running-inline"><Loader size={13} className="spin" /><small>{live.status}</small></div>}
          </article>}
        </div>
        <form className="lab-composer" onSubmit={submit}>
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={onKeyDown} disabled={running} rows={4} aria-label="Lab JARVIS에게 질문" placeholder="예: 반도체 3대장(NVDA, AVGO, TSM) 6개월 상대 성과와 리스크 비교해줘" />
          <div><span className={error ? "error" : ""}>{error || "⌘/Ctrl + Enter로 전송 · 대화와 결과는 자동 저장"}</span><button disabled={!question.trim() || running} aria-label="Lab JARVIS에 보내기"><Send size={15} /></button></div>
        </form>
      </aside>
      <section className="lab-canvas">
        <header><div><span>RESEARCH CANVAS</span><strong>{activeArtifact ? activeArtifact.title : "아직 생성된 결과가 없습니다"}</strong></div><span>{allArtifacts.length} artifacts</span></header>
        {allArtifacts.length > 1 && <div className="lab-artifact-tabs">{[...allArtifacts].reverse().map((artifact) => <button className={activeArtifact?.id === artifact.id ? "active" : ""} onClick={() => setActiveArtifactId(artifact.id)} key={artifact.id}>{artifactKindLabel(artifact)} · {artifact.title}</button>)}</div>}
        <div className="lab-canvas-body">{activeArtifact ? <ArtifactView artifact={activeArtifact} /> : <div className="lab-canvas-empty"><ChartNoAxesCombined size={28} /><strong>분석 결과가 이곳에 쌓입니다.</strong><p>차트·표·백테스트 자본곡선은 시각적으로, 상관계수·수익률·날짜·표본 수는 대화에서 다시 쓸 수 있는 숫자로 함께 저장됩니다.</p></div>}</div>
      </section>
    </div>
  </section>;
}
