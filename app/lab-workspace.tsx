"use client";

import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined";
import Check from "lucide-react/dist/esm/icons/check";
import Clock3 from "lucide-react/dist/esm/icons/clock-3";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import Loader from "lucide-react/dist/esm/icons/loader";
import Send from "lucide-react/dist/esm/icons/send";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import MessageSquarePlus from "lucide-react/dist/esm/icons/message-square-plus";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { AgentActivity, LabAgentPhase, LabArtifact, LabMessage, LabStreamEvent, LabToolTrace } from "@/lib/lab-types";
import { ArtifactView, artifactKindLabel, type StrategyAction } from "./lab-charts";
import { Markdown } from "./markdown";

type LiveTurn = { text: string; tools: LabToolTrace[]; status: string; detail: string; phase: LabAgentPhase };

const RUN_PHASES = [
  { id: "connecting", label: "요청 접수" },
  { id: "grounding", label: "사실 확인" },
  { id: "tools", label: "도구 실행" },
  { id: "verifying", label: "결과 종합" },
  { id: "writing", label: "답변 작성" },
] as const;

const PHASE_INDEX: Record<LabAgentPhase, number> = { connecting: 0, grounding: 1, planning: 1, tools: 2, verifying: 3, writing: 4 };

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
  const complete = tools.filter((tool) => tool.status !== "running").length;
  return <div className="lab-tool-traces" role="list">
    <header><span>실행 도구</span><small>{complete}/{tools.length}</small></header>
    {tools.map((trace, index) => <span className={trace.status} role="listitem" key={trace.id ?? `${trace.name}-${index}`}>
      <i />
      <b>{trace.label}</b>
      <em>{trace.status === "running" ? "실행 중" : trace.status === "failed" ? "확인 필요" : "완료"}</em>
      <small>{trace.detail}{trace.durationMs ? ` · ${(trace.durationMs / 1000).toFixed(1)}s` : ""}</small>
    </span>)}
  </div>;
}

function AgentRunPanel({ live, elapsedSeconds }: { live: LiveTurn; elapsedSeconds: number }) {
  const activeIndex = PHASE_INDEX[live.phase];
  return <section className="lab-run-panel" aria-label="JARVIS 작업 진행 상황">
    <header>
      <span className="lab-run-orbit"><Loader size={14} className="spin" /></span>
      <div><strong>{live.status}</strong><small>{live.detail || "요청을 분석하고 다음 단계를 준비하고 있습니다."}</small></div>
      <time><Clock3 size={11} />{elapsedSeconds}s</time>
    </header>
    <ol className="lab-run-phases">
      {RUN_PHASES.map((phase, index) => <li className={index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending"} key={phase.id}>
        <span>{index < activeIndex ? <Check size={9} /> : index + 1}</span>
        <small>{phase.label}</small>
      </li>)}
    </ol>
    <ToolTraces tools={live.tools} />
  </section>;
}

export function newConversationId() {
  return crypto.randomUUID();
}

export function LabWorkspace({ conversationId, onConversationChange, onActivityChange, onOpenBacktest, pendingPrompt, onPromptConsumed }: {
  conversationId: string;
  onConversationChange?: (id: string) => void;
  onActivityChange?: (activity: AgentActivity | null) => void;
  onOpenBacktest?: (strategyId: string | null) => void;
  pendingPrompt?: string | null;
  onPromptConsumed?: () => void;
}) {
  const [messages, setMessages] = useState<LabMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [ready, setReady] = useState(false);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const artifacts = useMemo(() => messages.flatMap((message) => message.artifacts), [messages]);
  const liveArtifacts = useRef<LabArtifact[]>([]);
  const [pendingArtifacts, setPendingArtifacts] = useState<LabArtifact[]>([]);
  const allArtifacts = useMemo(() => [...artifacts, ...pendingArtifacts], [artifacts, pendingArtifacts]);
  const activeArtifact = allArtifacts.find((artifact) => artifact.id === activeArtifactId) ?? allArtifacts.at(-1) ?? null;

  // A new conversation id means a fresh chat; an id chosen from History reloads that thread.
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setReady(false); setActiveArtifactId(null); setError(""); } });
    fetch(`/api/lab/state?conversation=${encodeURIComponent(conversationId)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.json() as Promise<{ messages?: LabMessage[] }>)
      .then((data) => { if (!controller.signal.aborted) setMessages(Array.isArray(data.messages) ? data.messages : []); })
      .catch(() => { if (!controller.signal.aborted) setMessages([]); })
      .finally(() => { if (!controller.signal.aborted) setReady(true); });
    return () => controller.abort();
  }, [conversationId]);

  useEffect(() => {
    if (pendingPrompt && !running && ready) queueMicrotask(() => { setQuestion(pendingPrompt); onPromptConsumed?.(); });
  }, [pendingPrompt, running, ready, onPromptConsumed]);

  useEffect(() => {
    onActivityChange?.(running ? { label: "Lab JARVIS", detail: live?.status || "도구를 선택하고 결과를 계산 중", progress: live?.tools.length ? `${live.tools.filter((tool) => tool.status !== "running").length}/${live.tools.length}` : "RUNNING" } : null);
  }, [onActivityChange, running, live?.status, live?.tools]);

  useEffect(() => {
    if (!running) { queueMicrotask(() => setElapsedSeconds(0)); return; }
    const timer = window.setInterval(() => setElapsedSeconds((current) => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, live?.text, live?.tools.length]);

  function applyEvent(event: LabStreamEvent) {
    if (event.type === "status") setLive((current) => ({ text: current?.text ?? "", tools: current?.tools ?? [], status: event.label, detail: event.detail ?? "", phase: event.phase }));
    else if (event.type === "text") setLive((current) => ({ text: `${current?.text ?? ""}${event.delta}`, tools: current?.tools ?? [], status: current?.status ?? "답변 작성 중", detail: current?.detail ?? "검증된 숫자와 근거를 읽기 쉬운 답변으로 정리하고 있습니다.", phase: current?.phase ?? "writing" }));
    else if (event.type === "tool_start") setLive((current) => ({ text: current?.text ?? "", status: `${event.label} 실행 중`, detail: event.detail || "필요한 데이터를 불러오고 계산하고 있습니다.", phase: "tools", tools: [...(current?.tools ?? []), { id: event.id, name: event.name, label: event.label, status: "running", detail: event.detail }] }));
    else if (event.type === "tool_end") setLive((current) => {
      const tools = (current?.tools ?? []).map((tool) => tool.id === event.id ? { ...tool, status: event.status, detail: event.detail, durationMs: event.durationMs } : tool);
      const stillRunning = tools.some((tool) => tool.status === "running");
      return { text: current?.text ?? "", status: stillRunning ? "데이터 도구 실행 중" : event.status === "failed" ? `${event.label} 결과 확인 중` : `${event.label} 완료`, detail: event.status === "failed" ? event.detail : stillRunning ? "여러 데이터 작업을 병렬로 처리하고 있습니다." : "도구 결과를 검증하고 다음 분석 단계로 연결합니다.", phase: stillRunning ? "tools" : "verifying", tools };
    });
    else if (event.type === "artifact") { liveArtifacts.current = [...liveArtifacts.current, event.artifact]; setPendingArtifacts(liveArtifacts.current); setActiveArtifactId(event.artifact.id); }
    else if (event.type === "error") setError(event.message);
    else if (event.type === "done") {
      setMessages((current) => [...current, event.message].slice(-200));
      if (event.message.artifacts.length) setActiveArtifactId(event.message.artifacts.at(-1)!.id);
      if (event.conversationId && event.conversationId !== conversationId) onConversationChange?.(event.conversationId);
    }
  }

  async function askAgent(prompt: string) {
    if (!prompt || running) return;
    const userMessage: LabMessage = { id: messageId("user"), role: "user", content: prompt, tools: [], artifacts: [], createdAt: new Date().toISOString() };
    setMessages((current) => [...current, userMessage].slice(-200));
    setQuestion("");
    setError("");
    setElapsedSeconds(0);
    setRunning(true);
    setLive({ text: "", tools: [], status: "요청 접수 중", detail: "JARVIS에 질문을 전달하고 작업 공간을 준비하고 있습니다.", phase: "connecting" });
    liveArtifacts.current = [];
    setPendingArtifacts([]);
    try {
      const response = await fetch("/api/lab/agent", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: prompt, conversationId, history: messages.slice(-12).map(({ role, content }) => ({ role, content })) }),
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
    try { await fetch(`/api/conversations?id=${encodeURIComponent(conversationId)}`, { method: "DELETE" }); } catch { /* local state clears regardless */ }
    setMessages([]);
    setActiveArtifactId(null);
    onConversationChange?.(newConversationId());
  }

  async function handleStrategyAction(action: StrategyAction) {
    if (action.type === "open") { onOpenBacktest?.(action.strategyId); return; }
    setError("");
    try {
      const response = await fetch("/api/strategies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec: action.spec, sourceConversationId: conversationId }) });
      const data = await response.json() as { strategy?: { id: string }; error?: string };
      if (!response.ok || !data.strategy) throw new Error(data.error || "전략 저장에 실패했습니다.");
      if (action.runNow) {
        const run = await fetch("/api/strategies/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: data.strategy.id }) });
        const runData = await run.json() as { error?: string };
        if (!run.ok) throw new Error(runData.error || "백테스트에 실패했습니다.");
      }
      onOpenBacktest?.(data.strategy.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "전략 저장에 실패했습니다.");
    }
  }

  return <section className="lab-view">
    <header className="lab-page-head">
      <div><span>MARKET INTELLIGENCE HQ</span><h1>Lab</h1><p>JARVIS에게 종목·시장·전략을 묻고, 계산과 차트는 Research Canvas에서 확인합니다.</p></div>
      <div className="lab-capabilities"><span><ChartNoAxesCombined size={13} />Charts · Indicators</span><span><FlaskConical size={13} />Event study · Backtest</span><span><Check size={13} />Grounded numbers</span></div>
    </header>
    <div className="lab-layout">
      <aside className={`lab-agent ${messages.length ? "" : "with-prompts"}`}>
        <header className="lab-agent-header">
          <div className="lab-agent-identity">
            <span className="agent-mark"><Sparkles size={15} /></span>
            <div><span><strong>Lab JARVIS</strong><em className={running ? "running" : "ready"}>{running ? "RUNNING" : "READY"}</em></span><small>quant PM · 14 tools · persistent memory</small></div>
          </div>
          <nav className="lab-agent-actions" aria-label="대화 관리">
            <button disabled={!messages.length || running} onClick={() => onConversationChange?.(newConversationId())} title="현재 대화를 History에 보관하고 새 대화 시작"><MessageSquarePlus size={13} /><span>새 대화</span></button>
            <button disabled={!messages.length || running} className={confirmClear ? "danger" : ""} onClick={clearHistory} title={confirmClear ? "한 번 더 누르면 삭제" : "현재 대화 삭제"}>{confirmClear ? <X size={13} /> : <Trash2 size={13} />}<span>{confirmClear ? "삭제 확인" : "대화 삭제"}</span></button>
          </nav>
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
            <span>JARVIS<small> · live workspace</small></span>
            <AgentRunPanel live={live} elapsedSeconds={elapsedSeconds} />
            {live.text ? <Markdown text={live.text} /> : null}
          </article>}
        </div>
        <form className="lab-composer" onSubmit={submit}>
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={onKeyDown} disabled={running} rows={3} aria-label="Lab JARVIS에게 질문" placeholder="예: 반도체 3대장(NVDA, AVGO, TSM) 6개월 상대 성과와 리스크 비교해줘" />
          <footer><span className={error ? "error" : ""}>{error || (running ? "현재 작업이 끝나면 다음 질문을 보낼 수 있습니다." : "⌘/Ctrl + Enter · 대화와 결과 자동 저장")}</span><button type="submit" disabled={!question.trim() || running} aria-label="Lab JARVIS에 메시지 보내기"><span>{running ? "작업 중" : "보내기"}</span>{running ? <Loader size={13} className="spin" /> : <Send size={13} />}</button></footer>
        </form>
      </aside>
      <section className="lab-canvas">
        <header><div><span>RESEARCH CANVAS</span><strong>{activeArtifact ? activeArtifact.title : "아직 생성된 결과가 없습니다"}</strong></div><span>{allArtifacts.length} artifacts</span></header>
        {allArtifacts.length > 1 && <div className="lab-artifact-tabs">{[...allArtifacts].reverse().map((artifact) => <button className={activeArtifact?.id === artifact.id ? "active" : ""} onClick={() => setActiveArtifactId(artifact.id)} key={artifact.id}>{artifactKindLabel(artifact)} · {artifact.title}</button>)}</div>}
        <div className="lab-canvas-body">{activeArtifact ? <ArtifactView artifact={activeArtifact} onAction={handleStrategyAction} /> : <div className="lab-canvas-empty"><ChartNoAxesCombined size={28} /><strong>분석 결과가 이곳에 쌓입니다.</strong><p>차트·표·백테스트 자본곡선은 시각적으로, 상관계수·수익률·날짜·표본 수는 대화에서 다시 쓸 수 있는 숫자로 함께 저장됩니다.</p></div>}</div>
      </section>
    </div>
  </section>;
}
