"use client";

import Activity from "lucide-react/dist/esm/icons/activity";
import Bell from "lucide-react/dist/esm/icons/bell";
import Bot from "lucide-react/dist/esm/icons/bot";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Clock3 from "lucide-react/dist/esm/icons/clock-3";
import Database from "lucide-react/dist/esm/icons/database";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import Gauge from "lucide-react/dist/esm/icons/gauge";
import LayoutDashboard from "lucide-react/dist/esm/icons/layout-dashboard";
import LineChartIcon from "lucide-react/dist/esm/icons/chart-no-axes-combined";
import Menu from "lucide-react/dist/esm/icons/menu";
import MessageSquare from "lucide-react/dist/esm/icons/message-square";
import Play from "lucide-react/dist/esm/icons/play";
import Plus from "lucide-react/dist/esm/icons/plus";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Search from "lucide-react/dist/esm/icons/search";
import Settings from "lucide-react/dist/esm/icons/settings";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import Target from "lucide-react/dist/esm/icons/target";
import X from "lucide-react/dist/esm/icons/x";
import { FormEvent, useState } from "react";
import type { BacktestResult } from "@/lib/backtesting";

type View = "overview" | "agent" | "data" | "backtests";
type Signal = { name: string; value: string; direction: string; reason: string };
type ChatMessage = { role: "agent" | "user"; text: string; meta?: string };

type Hypothesis = {
  id: string;
  title: string;
  symbolUniverse: string;
  thesis: string;
  entryRule: string;
  exitRule: string;
  sizingRule: string;
  status: string;
};

const chartPoints = [42, 46, 44, 52, 50, 58, 61, 56, 64, 70, 68, 78];
const defaultSignals: Signal[] = [
  { name: "Market breadth", value: "68.4%", direction: "positive", reason: "50일 이동평균 위 종목 비율이 지난 4주 동안 상승했습니다." },
  { name: "Realized volatility", value: "14.8", direction: "neutral", reason: "20일 변동성이 1년 중앙값 아래지만 반전 위험은 남아 있습니다." },
  { name: "Momentum spread", value: "+6.2%", direction: "positive", reason: "상위 모멘텀 그룹과 지수의 3개월 성과 차이가 확대됐습니다." },
];

const initialHypothesis: Hypothesis = {
  id: "momentum-breadth-v1",
  title: "Breadth-confirmed momentum",
  symbolUniverse: "S&P 500 · large cap",
  thesis: "시장 참여 폭이 넓어질 때 상대강도가 높은 종목의 추세가 더 오래 지속된다.",
  entryRule: "20일 상대강도 상위 10% + 시장 폭 55% 이상",
  exitRule: "상위 25% 이탈 또는 시장 폭 45% 미만",
  sizingRule: "동일가중 10종목 · 종목당 최대 10%",
  status: "ready",
};

const sampleRuns = [
  { name: "Breadth-confirmed momentum", range: "10 years", returnValue: "+12.4%", sharpe: "1.68", date: "Today, 9:42 AM", status: "Completed" },
  { name: "Low-volatility rotation", range: "7 years", returnValue: "+8.1%", sharpe: "1.21", date: "Aug 27, 4:18 PM", status: "Completed" },
  { name: "Earnings drift", range: "5 years", returnValue: "—", sharpe: "—", date: "Aug 24, 1:03 PM", status: "Stopped" },
];

function MiniLine({ points, className = "" }: { points: number[]; className?: string }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const normalized = points.map((point) => 12 + ((point - min) / Math.max(1, max - min)) * 72);
  return (
    <div className={`line-canvas ${className}`} role="img" aria-label={`Trend from ${points[0]} to ${points.at(-1)}`}>
      {normalized.slice(0, -1).map((point, index) => {
        const next = normalized[index + 1];
        const dx = 100 / (normalized.length - 1);
        const dy = point - next;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(-dy, dx) * 180 / Math.PI;
        return <i key={index} style={{ left: `${index * dx}%`, bottom: `${point}%`, width: `${length}%`, transform: `rotate(${angle}deg)` }} />;
      })}
    </div>
  );
}

function MetricCard({ label, value, detail, featured = false }: { label: string; value: string; detail: React.ReactNode; featured?: boolean }) {
  return <article className={`metric-card ${featured ? "featured" : ""}`}><span className="card-label">{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

export function QuantWorkspace() {
  const [activeView, setActiveView] = useState<View>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [selectedSymbols, setSelectedSymbols] = useState(["NVDA", "MSFT", "META"]);
  const [signals, setSignals] = useState(defaultSignals);
  const [analysisSummary, setAnalysisSummary] = useState("선택한 종목과 시장 폭을 함께 보면 모멘텀 지속 가능성이 높지만, 변동성 반전 조건을 반드시 포함해야 합니다.");
  const [analysisMode, setAnalysisMode] = useState<"demo" | "live">("demo");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "agent", text: "현재 데이터에서 두 가지가 보입니다. 시장 폭은 개선되고 있고, 선택 종목의 상대강도는 지수보다 빠르게 상승했습니다. 먼저 어떤 실패 조건을 중요하게 볼까요?", meta: "Tactic Agent · AI-generated" },
    { role: "user", text: "급락장에서 손실이 커지는 전략은 피하고 싶어. 시장 폭을 필터로 쓰면 어때?" },
    { role: "agent", text: "좋습니다. 시장 폭 55%를 진입 필터로, 45%를 위험 축소 기준으로 두면 가설이 명확해집니다. 과최적화를 피하려면 두 임계값을 ±5% 범위로 민감도 테스트하겠습니다.", meta: "Evidence-based suggestion" },
  ]);
  const [chatDraft, setChatDraft] = useState("");
  const [hypothesis, setHypothesis] = useState(initialHypothesis);
  const [toast, setToast] = useState("");
  const [showBacktest, setShowBacktest] = useState(false);
  const [years, setYears] = useState(10);
  const [capital, setCapital] = useState(100000);
  const [costBps, setCostBps] = useState(8);
  const [isBacktesting, setIsBacktesting] = useState(false);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "demo">("idle");

  const navItems = [
    { id: "overview" as View, label: "Overview", icon: LayoutDashboard },
    { id: "agent" as View, label: "Tactic Agent", icon: Sparkles },
    { id: "data" as View, label: "Market Data", icon: Database },
    { id: "backtests" as View, label: "Backtests", icon: FlaskConical },
  ];

  const displayTitle = ({ overview: "Overview", agent: "Tactic Agent", data: "Market Data", backtests: "Backtests" })[activeView];

  function navigate(view: View) {
    setActiveView(view);
    setMobileNav(false);
  }

  async function runAnalysis() {
    setIsAnalyzing(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbols: selectedSymbols, question: "Find robust, testable chart and data signals.", context: { breadth: 68.4, realizedVolatility: 14.8, momentumSpread: 6.2 } }),
      });
      const data = await response.json() as { summary?: string; signals?: Signal[]; hypothesis?: string; mode?: "demo" | "live"; error?: string };
      if (!response.ok) throw new Error(data.error || "Analysis failed");
      if (data.summary) setAnalysisSummary(data.summary);
      if (data.signals?.length) setSignals(data.signals);
      if (data.hypothesis) {
        const nextThesis = data.hypothesis;
        setHypothesis((current) => ({ ...current, thesis: nextThesis }));
      }
      setAnalysisMode(data.mode ?? "demo");
      setToast(data.mode === "live" ? "Claude 분석이 완료되었습니다." : "데모 데이터로 분석 흐름을 실행했습니다.");
    } catch {
      setToast("분석 서비스에 연결하지 못했습니다. 기존 결과를 유지합니다.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = chatDraft.trim();
    if (!text) return;
    setMessages((current) => [...current, { role: "user", text }, { role: "agent", text: "이 조건은 검증 가능한 규칙으로 바꿀 수 있습니다. 진입 기준과 청산 기준을 분리하고, 거래비용을 포함한 결과와 제외한 결과를 함께 비교하겠습니다.", meta: "Draft response · Connect API for live reasoning" }]);
    setChatDraft("");
  }

  async function saveHypothesis() {
    try {
      const response = await fetch("/api/hypotheses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(hypothesis) });
      const data = await response.json() as { persisted?: boolean };
      setToast(data.persisted ? "가설을 데이터베이스에 저장했습니다." : "가설을 현재 세션에 보관했습니다. 데이터베이스 연결 후 영구 저장됩니다.");
    } catch {
      setToast("가설은 화면에 유지되지만 아직 영구 저장되지 않았습니다.");
    }
  }

  async function runBacktest() {
    setIsBacktesting(true);
    try {
      const response = await fetch("/api/backtest", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ hypothesisId: hypothesis.id, years, initialCapital: capital, transactionCostBps: costBps }),
      });
      const data = await response.json() as { result?: BacktestResult; error?: string };
      if (!response.ok || !data.result) throw new Error(data.error || "Backtest failed");
      setBacktestResult(data.result);
      setShowBacktest(false);
      setActiveView("backtests");
      setToast("백테스트가 완료되었습니다. 이 실행에는 LLM을 사용하지 않았습니다.");
    } catch {
      setToast("백테스트를 완료하지 못했습니다. 입력값을 확인해 주세요.");
    } finally {
      setIsBacktesting(false);
    }
  }

  async function syncData() {
    setSyncState("syncing");
    try {
      await fetch("/api/market/sync", { method: "POST" });
      setSyncState("demo");
      setToast("동기화 경로를 확인했습니다. 시세 공급자 연결 전에는 데모 모드로 유지됩니다.");
    } catch {
      setSyncState("idle");
      setToast("동기화 서비스에 연결하지 못했습니다.");
    }
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`} aria-label="Primary navigation">
        <div className="brand-lockup"><div className="brand-mark" aria-hidden="true">Q</div><div><strong>QQuant</strong><small>Personal research</small></div></div>
        <nav className="side-nav">
          {navItems.map((item) => <button key={item.id} className={`nav-item ${activeView === item.id ? "active" : ""}`} onClick={() => navigate(item.id)}><item.icon size={17} strokeWidth={2} /><b>{item.label}</b>{activeView === item.id && <span className="nav-indicator" />}</button>)}
        </nav>
        <div className="sidebar-section"><span>Workspace</span><button className="plain-row"><Settings size={16} /><b>Settings</b></button></div>
        <div className="sidebar-status"><span className="status-dot" aria-hidden="true" /><span><strong>Data healthy</strong><small>Demo snapshot · 8m ago</small></span></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title"><button className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav((value) => !value)}><Menu size={20} /></button><div><p className="eyebrow">QQuant / {displayTitle}</p><h1>{activeView === "overview" ? "Good morning, Woojin." : displayTitle}</h1></div></div>
          <div className="top-actions"><button className="icon-button" aria-label="Search"><Search size={17} /></button><button className="icon-button" aria-label="Notifications"><Bell size={17} /></button><div className="avatar" aria-label="User profile">WP</div></div>
        </header>

        {activeView === "overview" && <>
          <div className="hero-row"><div><span className="section-kicker">Research cockpit</span><h2>From signal to evidence.</h2><p>데이터에서 신호를 찾고, Tactic Agent와 검증 가능한 가설을 만든 뒤, LLM 없이 백테스트하세요.</p></div><button className="primary-button" onClick={() => navigate("agent")}><Sparkles size={16} /> Start AI analysis</button></div>
          <section className="metric-grid" aria-label="Research overview">
            <MetricCard featured label="Strategy capital" value="$100,000" detail={<><em>↑ 12.4%</em> illustrative return</>} />
            <MetricCard label="Universe" value="503" detail="S&P 500 securities" />
            <MetricCard label="Active hypotheses" value="3" detail="1 ready to backtest" />
            <MetricCard label="Last backtest" value="1.68" detail="Sharpe ratio · 10Y" />
          </section>
          <section className="content-grid">
            <article className="panel chart-panel"><div className="panel-heading"><div><span className="card-label">Market pulse</span><h3>S&amp;P 500 breadth</h3></div><div className="segmented" aria-label="Chart range"><button>1M</button><button className="selected">3M</button><button>1Y</button></div></div><div className="chart-summary"><strong>68.4%</strong><span className="positive">↑ 4.2%</span></div><MiniLine points={chartPoints} /><div className="chart-axis"><span>Jun</span><span>Jul</span><span>Aug</span></div><p className="chart-note"><Sparkles size={14} /><span>AI watch</span> Breadth is improving while volatility compresses. This may support a momentum hypothesis.</p></article>
            <article className="panel agent-panel"><div className="agent-icon"><Sparkles size={18} /></div><span className="card-label">Tactic Agent</span><h3>Turn market evidence into a testable rule.</h3><p>신호를 검토하고, 반례를 찾고, 백테스트가 실행할 정확한 규칙을 준비합니다.</p><div className="flow-steps"><div className="done"><span><Check size={13} /></span><b>Analyze data</b><small>Signals selected</small></div><div className="current"><span>2</span><b>Build hypothesis</b><small>Continue conversation</small></div><div><span>3</span><b>Run backtest</b><small>Rules only, no LLM</small></div></div><button className="secondary-button" onClick={() => navigate("agent")}>Open workspace <ChevronRight size={16} /></button></article>
          </section>
          <section className="panel recent-panel"><div className="panel-heading"><div><span className="card-label">Recent activity</span><h3>Backtest history</h3></div><button className="text-button" onClick={() => navigate("backtests")}>View all <ChevronRight size={14} /></button></div><div className="run-list">{sampleRuns.slice(0, 2).map((run) => <div className="run-row" key={run.name}><div className="run-icon"><FlaskConical size={16} /></div><div><strong>{run.name}</strong><small>{run.range} · {run.date}</small></div><span className="run-return">{run.returnValue}</span><span>{run.sharpe}</span><span className="status-pill success"><Check size={11} />{run.status}</span></div>)}</div></section>
        </>}

        {activeView === "agent" && <section className="agent-workspace">
          <div className="page-intro"><div><span className="section-kicker">Human-in-the-loop research</span><h2>Tactic Agent</h2><p>LLM은 신호와 가설을 제안할 뿐입니다. 규칙을 확인하고 백테스트를 시작하는 결정은 항상 사용자가 합니다.</p></div><div className="ai-badge"><Bot size={15} /><span>Claude Opus 4.7</span><small>On demand</small></div></div>
          <div className="research-layout">
            <aside className="research-rail panel"><div className="rail-heading"><span className="card-label">Analysis context</span><button aria-label="Add symbol"><Plus size={15} /></button></div><p className="field-label">Selected symbols</p><div className="symbol-list">{["NVDA", "MSFT", "META", "AMZN", "AVGO"].map((symbol) => <button key={symbol} className={selectedSymbols.includes(symbol) ? "selected" : ""} onClick={() => setSelectedSymbols((current) => current.includes(symbol) ? current.filter((value) => value !== symbol) : [...current, symbol])}><span>{symbol.slice(0, 1)}</span><b>{symbol}</b>{selectedSymbols.includes(symbol) && <Check size={13} />}</button>)}</div><div className="data-context"><div><Database size={14} /><span><b>Daily OHLCV</b><small>10 years · adjusted</small></span></div><div><Activity size={14} /><span><b>Technical factors</b><small>18 signals</small></span></div><div><ShieldCheck size={14} /><span><b>Point-in-time guard</b><small>Enabled</small></span></div></div><button className="primary-button full" disabled={isAnalyzing || selectedSymbols.length === 0} onClick={runAnalysis}>{isAnalyzing ? <RefreshCw size={16} className="spin" /> : <Sparkles size={16} />}{isAnalyzing ? "Analyzing…" : "Find signals"}</button><p className="privacy-note">선택한 데이터만 서버의 AI 모델로 전송됩니다.</p></aside>
            <section className="conversation panel"><div className="conversation-head"><div><div className="agent-avatar"><Sparkles size={17} /></div><span><strong>Research session</strong><small>{analysisMode === "live" ? "Live AI analysis" : "Demo analysis · API key not connected"}</small></span></div><button className="icon-button" aria-label="Session options"><Settings size={16} /></button></div><div className="analysis-banner"><div><Gauge size={18} /><span><strong>Current read</strong><p>{analysisSummary}</p></span></div><span className="confidence">Moderate confidence</span></div><div className="signal-strip">{signals.map((signal) => <article key={signal.name}><span className={`signal-dot ${signal.direction}`} /><small>{signal.name}</small><strong>{signal.value}</strong><p>{signal.reason}</p></article>)}</div><div className="chat-log" aria-live="polite">{messages.map((message, index) => <div className={`message ${message.role}`} key={`${message.role}-${index}`}><div className="message-author">{message.role === "agent" ? <Sparkles size={13} /> : "WP"}</div><div><p>{message.text}</p>{message.meta && <small>{message.meta}</small>}</div></div>)}</div><form className="composer" onSubmit={sendMessage}><MessageSquare size={17} /><input aria-label="Message Tactic Agent" value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} placeholder="Ask about assumptions, failure cases, or parameters…" /><button disabled={!chatDraft.trim()} aria-label="Send message"><ChevronRight size={18} /></button></form><p className="ai-disclosure">AI 결과는 오류를 포함할 수 있으며 투자 조언이 아닙니다. 백테스트 전에 규칙과 데이터 범위를 확인하세요.</p></section>
            <aside className="hypothesis-panel panel"><div className="hypothesis-head"><div><span className="card-label">Hypothesis</span><span className="status-pill ready">Ready to test</span></div><button className="icon-button" aria-label="Close inspector"><X size={15} /></button></div><label>Title<input value={hypothesis.title} onChange={(event) => setHypothesis({ ...hypothesis, title: event.target.value })} /></label><label>Universe<input value={hypothesis.symbolUniverse} onChange={(event) => setHypothesis({ ...hypothesis, symbolUniverse: event.target.value })} /></label><label>Thesis<textarea rows={4} value={hypothesis.thesis} onChange={(event) => setHypothesis({ ...hypothesis, thesis: event.target.value })} /></label><div className="rule-block"><span><Target size={14} />Entry rule</span><textarea rows={3} value={hypothesis.entryRule} onChange={(event) => setHypothesis({ ...hypothesis, entryRule: event.target.value })} /></div><div className="rule-block"><ShieldCheck size={14} /><span>Exit rule</span><textarea rows={3} value={hypothesis.exitRule} onChange={(event) => setHypothesis({ ...hypothesis, exitRule: event.target.value })} /></div><label>Position sizing<input value={hypothesis.sizingRule} onChange={(event) => setHypothesis({ ...hypothesis, sizingRule: event.target.value })} /></label><div className="inspector-actions"><button className="ghost-button" onClick={saveHypothesis}>Save draft</button><button className="primary-button" onClick={() => setShowBacktest(true)}><Play size={15} fill="currentColor" /> Backtest</button></div></aside>
          </div>
        </section>}

        {activeView === "data" && <section className="data-view">
          <div className="page-intro"><div><span className="section-kicker">Data foundation</span><h2>Market Data</h2><p>S&amp;P 500 유니버스와 조정 일봉 데이터를 한 곳에서 관리합니다. 증분 작업은 24시간 주기로 설계되어 있습니다.</p></div><button className="primary-button" disabled={syncState === "syncing"} onClick={syncData}><RefreshCw size={16} className={syncState === "syncing" ? "spin" : ""} />{syncState === "syncing" ? "Checking…" : "Update now"}</button></div>
          <section className="data-metrics"><article className="panel"><Database size={19} /><span><small>Securities</small><strong>503</strong><em>Universe snapshot</em></span></article><article className="panel"><LineChartIcon size={19} /><span><small>Daily price rows</small><strong>1.24M</strong><em>10 years retained</em></span></article><article className="panel"><Clock3 size={19} /><span><small>Next update</small><strong>23h 52m</strong><em>Daily at 06:00 UTC</em></span></article><article className="panel"><ShieldCheck size={19} /><span><small>Data quality</small><strong>99.96%</strong><em>2 flags to review</em></span></article></section>
          <article className="panel pipeline-panel"><div className="panel-heading"><div><span className="card-label">Daily pipeline</span><h3>Ingestion status</h3></div><span className={`status-pill ${syncState === "demo" ? "warning" : "success"}`}>{syncState === "demo" ? "Provider required" : "Healthy"}</span></div><div className="pipeline"><div className="complete"><span><Check size={14} /></span><b>Universe</b><small>S&amp;P membership</small></div><ChevronRight size={16} /><div className="complete"><span><Check size={14} /></span><b>Prices</b><small>Adjusted OHLCV</small></div><ChevronRight size={16} /><div className="complete"><span><Check size={14} /></span><b>Quality checks</b><small>Gaps & splits</small></div><ChevronRight size={16} /><div><span><Clock3 size={14} /></span><b>Factor build</b><small>18 derived signals</small></div></div></article>
          <article className="panel source-panel"><div className="panel-heading"><div><span className="card-label">Storage & sources</span><h3>Dataset inventory</h3></div><button className="text-button"><Settings size={14} /> Configure</button></div><div className="data-table" role="table" aria-label="Market data inventory"><div className="table-row table-head" role="row"><span>Dataset</span><span>Source</span><span>Coverage</span><span>Last updated</span><span>Status</span></div>{[
            ["S&P 500 constituents", "Reference adapter", "503 symbols", "Today, 5:58 AM", "Current"],
            ["Adjusted daily prices", "Market data adapter", "2016–2026", "Today, 6:07 AM", "Current"],
            ["Corporate actions", "Market data adapter", "Splits · dividends", "Today, 6:04 AM", "Current"],
            ["Fundamentals", "Not connected", "—", "—", "Required"],
          ].map((row) => <div className="table-row" role="row" key={row[0]}>{row.map((cell, index) => <span role="cell" key={cell} data-label={["Dataset", "Source", "Coverage", "Updated", "Status"][index]}>{index === 4 ? <span className={`status-pill ${cell === "Required" ? "warning" : "success"}`}>{cell}</span> : cell}</span>)}</div>)}</div></article>
        </section>}

        {activeView === "backtests" && <section className="backtest-view">
          <div className="page-intro"><div><span className="section-kicker">Deterministic engine</span><h2>Backtests</h2><p>확정된 가설과 저장된 가격 데이터만 사용합니다. 이 단계에서는 LLM 호출이 없습니다.</p></div><button className="primary-button" onClick={() => setShowBacktest(true)}><Play size={15} fill="currentColor" /> New backtest</button></div>
          {backtestResult && <article className="panel result-card"><div className="result-head"><div><span className="card-label">Latest illustrative run</span><h3>{hypothesis.title}</h3><p>{backtestResult.periodStart} → {backtestResult.periodEnd} · ${capital.toLocaleString()} initial capital</p></div><span className="no-ai-badge"><ShieldCheck size={15} /> No LLM used</span></div><div className="result-metrics"><div><small>Annual return</small><strong className="positive">+{(backtestResult.annualReturn * 100).toFixed(1)}%</strong></div><div><small>Sharpe ratio</small><strong>{backtestResult.sharpe}</strong></div><div><small>Max drawdown</small><strong className="negative">{(backtestResult.maxDrawdown * 100).toFixed(1)}%</strong></div><div><small>Win rate</small><strong>{(backtestResult.winRate * 100).toFixed(1)}%</strong></div><div><small>Final value</small><strong>${backtestResult.finalValue.toLocaleString()}</strong></div></div><div className="equity-wrap"><div className="equity-legend"><span><i className="strategy-key" />Strategy</span><span><i className="benchmark-key" />S&amp;P 500</span></div><MiniLine points={backtestResult.equity.map((point) => point.strategy)} className="result-line" /><MiniLine points={backtestResult.equity.map((point) => point.benchmark)} className="benchmark-line" /></div><p className="prototype-note"><FlaskConical size={14} /> 현재 결과는 엔진 연결을 검증하기 위한 합성 수익률입니다. 실제 매매 판단에는 사용할 수 없습니다.</p></article>}
          <article className="panel history-card"><div className="panel-heading"><div><span className="card-label">Run history</span><h3>All backtests</h3></div><div className="search-field"><Search size={14} /><input aria-label="Search backtests" placeholder="Search" /></div></div><div className="run-list detailed">{sampleRuns.map((run) => <button className="run-row" key={run.name}><div className="run-icon"><FlaskConical size={16} /></div><div><strong>{run.name}</strong><small>{run.range} · {run.date}</small></div><span className="run-return">{run.returnValue}</span><span>{run.sharpe}</span><span className={`status-pill ${run.status === "Completed" ? "success" : "muted"}`}>{run.status === "Completed" && <Check size={11} />}{run.status}</span><ChevronRight size={15} /></button>)}</div></article>
        </section>}
      </section>

      {showBacktest && <div className="modal-backdrop"><button className="modal-dismiss" aria-label="Close backtest settings" onClick={() => setShowBacktest(false)} /><section className="backtest-sheet" role="dialog" aria-modal="true" aria-labelledby="backtest-title"><div className="sheet-head"><div><span className="card-label">Ready to test</span><h2 id="backtest-title">Configure backtest</h2><p>과최적화를 줄이기 위해 최소 7년을 권장합니다.</p></div><button className="icon-button" aria-label="Close" onClick={() => setShowBacktest(false)}><X size={17} /></button></div><div className="sheet-hypothesis"><Target size={17} /><span><strong>{hypothesis.title}</strong><small>{hypothesis.symbolUniverse}</small></span><span className="status-pill ready">3 rules</span></div><div className="form-grid"><label>Test period<select value={years} onChange={(event) => setYears(Number(event.target.value))}><option value={5}>5 years</option><option value={7}>7 years</option><option value={10}>10 years · Recommended</option><option value={15}>15 years</option></select><small>Covers multiple market regimes</small></label><label>Initial capital<div className="money-input"><span>$</span><input type="number" min={1000} step={1000} value={capital} onChange={(event) => setCapital(Number(event.target.value))} /></div><small>Strategy allocation only</small></label><label>Benchmark<select><option>S&amp;P 500 (SPY)</option><option>Equal-weight S&amp;P 500</option></select></label><label>Transaction cost<div className="money-input"><input type="number" min={0} max={100} value={costBps} onChange={(event) => setCostBps(Number(event.target.value))} /><span>bps</span></div><small>Applied on each trade</small></label></div><div className="recommendation"><Bot size={17} /><span><strong>Agent recommendation</strong><p>10년, $100,000, 거래비용 8bps로 시작하고 시장 폭 임계값 ±5% 민감도 테스트를 추가하세요.</p></span></div><div className="sheet-note"><ShieldCheck size={15} /><span><strong>The AI stops here.</strong><small>백테스트 엔진은 고정된 규칙과 가격 데이터만 사용합니다.</small></span></div><div className="sheet-actions"><button className="ghost-button" onClick={() => setShowBacktest(false)}>Cancel</button><button className="primary-button" disabled={isBacktesting} onClick={runBacktest}>{isBacktesting ? <RefreshCw size={16} className="spin" /> : <Play size={15} fill="currentColor" />}{isBacktesting ? "Running…" : "Run backtest"}</button></div></section></div>}

      {toast && <div className="toast" role="status"><Check size={15} /><span>{toast}</span><button aria-label="Dismiss" onClick={() => setToast("")}><X size={14} /></button></div>}
    </main>
  );
}
