"use client";

import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import Play from "lucide-react/dist/esm/icons/play";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import Zap from "lucide-react/dist/esm/icons/zap";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LabArtifact } from "@/lib/lab-types";
import { formatPercent, StrategyBacktestView, toneOf } from "./lab-charts";

type StrategyStatus = "draft" | "backtested" | "candidate" | "rejected" | "paper" | "live";
type Spec = {
  name: string; hypothesis: { thesis: string; mechanism: string; prediction: string; falsification: string }; universe: string[]; benchmark: string;
  entry: unknown[]; exit: unknown[]; holding: { maxSessions?: number | null; stopLossPct?: number | null; takeProfitPct?: number | null }; sizing: { mode: string; positionPct?: number | null };
  costBps: number; period: { from: string; to: string }; successCriteria: Record<string, number>; notes?: string[];
};
type BacktestResult = {
  spec: Spec; period: { from: string; to: string; sessions: number }; metrics: Record<string, number | null>;
  equityCurve: Array<{ date: string; strategy: number; benchmark: number; market: number | null }>;
  perSymbol: Array<{ symbol: string; totalReturnPct: number | null; benchmarkReturnPct: number | null; sharpe: number | null; maxDrawdownPct: number | null; trades: number; winRatePct: number | null; currentSignal: string }>;
  trades: Array<{ symbol: string; entryDate: string; exitDate: string; entryPrice: number; exitPrice: number; returnPct: number; sessions: number; reason: string }>;
  robustness: { inSample: { from: string; to: string; cagrPct: number | null; sharpe: number | null }; outOfSample: { from: string; to: string; cagrPct: number | null; sharpe: number | null }; perturbations: Array<{ label: string; cagrPct: number | null; sharpe: number | null; maxDrawdownPct: number | null }>; stabilityScore: number | null };
  verdict: { status: "pass" | "fail" | "inconclusive"; reasons: string[] };
  missingSymbols: Array<{ symbol: string; reason: string }>;
};
type Strategy = { id: string; name: string; status: StrategyStatus; spec: Spec; latestResult: BacktestResult | null; sourceConversationId: string | null; createdAt: string; updatedAt: string };
type Run = { id: string; verdict: string; createdAt: string; period: { from: string; to: string; sessions: number } | null; metrics: Record<string, number | null> | null };
type LiveSignal = { symbol: string; latestDate: string; latestClose: number; signal: "long" | "flat"; changedToday: boolean; transition: string; exitReason: string | null; broker: { available: boolean; price?: number; session?: { label: string }; reason?: string } };
type OrderIntent = { id: string; symbol: string; side: "buy" | "sell"; quantity: number; referencePrice: number; notionalUsd: number; reason: string; signalDate: string; broker: { available: boolean; session?: string } };
type SignalsResponse = { asOf: string; capitalUsd: number; gateway: { id: string; label: string }; signals: LiveSignal[]; intents: OrderIntent[]; submissions: Array<{ intentId: string; accepted: boolean; message: string }> };

const STATUS_LABELS: Record<StrategyStatus, string> = { draft: "가설", backtested: "백테스트 완료", candidate: "시그널 후보", rejected: "기각", paper: "페이퍼", live: "실거래" };
const PIPELINE: StrategyStatus[] = ["draft", "backtested", "candidate", "paper", "live"];

function toArtifact(result: BacktestResult, strategyId: string | null): Extract<LabArtifact, { type: "strategy-backtest" }> {
  const metrics = result.metrics;
  return {
    id: `bt-${strategyId ?? "adhoc"}`, type: "strategy-backtest", title: `백테스트 · ${result.spec.name}`, strategyId, strategyName: result.spec.name, verdict: result.verdict, period: result.period,
    metrics: { "총수익": metrics.totalReturnPct, "동일가중 매수보유": metrics.benchmarkReturnPct, [result.spec.benchmark]: metrics.marketReturnPct, CAGR: metrics.cagrPct, "초과 CAGR": metrics.excessCagrPct, "샤프": metrics.sharpe, "소르티노": metrics.sortino, "최대낙폭": metrics.maxDrawdownPct, "변동성": metrics.annualizedVolatilityPct, "거래": metrics.trades, "승률": metrics.winRatePct, "평균 거래": metrics.averageTradePct, "노출": metrics.exposurePct, "손익비": metrics.profitFactor },
    equityCurve: result.equityCurve, perSymbol: result.perSymbol, robustness: { inSample: result.robustness.inSample, outOfSample: result.robustness.outOfSample, stabilityScore: result.robustness.stabilityScore },
    notes: ["신호 종가 → 다음 종가 체결 · 롱온리 · 동일가중 · 배당 미반영", `비용 ${result.spec.costBps}bps 편도 · 인샘플 70% / 아웃오브샘플 30%`, ...(result.missingSymbols.length ? [`제외: ${result.missingSymbols.map((item) => `${item.symbol}(${item.reason})`).join(", ")}`] : [])],
  };
}

export function BacktestWorkspace({ focusStrategyId, onAskLab }: { focusStrategyId?: string | null; onAskLab?: (prompt: string) => void }) {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [ready, setReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [costBps, setCostBps] = useState(5);
  const [signals, setSignals] = useState<SignalsResponse | null>(null);
  const [signalsLoading, setSignalsLoading] = useState(false);
  const [capital, setCapital] = useState(10000);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/strategies", { cache: "no-store" });
      const data = await response.json() as { strategies?: Strategy[] };
      setStrategies(Array.isArray(data.strategies) ? data.strategies : []);
    } catch {
      setStrategies([]);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);
  useEffect(() => { if (focusStrategyId) queueMicrotask(() => setSelectedId(focusStrategyId)); }, [focusStrategyId]);

  const selected = useMemo(() => strategies.find((item) => item.id === selectedId) ?? strategies[0] ?? null, [strategies, selectedId]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setFrom(selected.spec.period.from);
      setTo(selected.spec.period.to);
      setCostBps(selected.spec.costBps);
      setSignals(null);
      setError("");
    });
    fetch(`/api/strategies?id=${encodeURIComponent(selected.id)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.json() as Promise<{ runs?: Run[] }>)
      .then((data) => setRuns(Array.isArray(data.runs) ? data.runs : []))
      .catch(() => setRuns([]));
    return () => controller.abort();
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runBacktest() {
    if (!selected || running) return;
    setRunning(true);
    setError("");
    try {
      const spec = { ...selected.spec, period: { from, to }, costBps };
      const response = await fetch("/api/strategies/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: selected.id, spec }) });
      const data = await response.json() as { error?: string; strategy?: Strategy };
      if (!response.ok) throw new Error(data.error || "백테스트에 실패했습니다.");
      await load();
      if (data.strategy) setSelectedId(data.strategy.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "백테스트에 실패했습니다.");
    } finally {
      setRunning(false);
    }
  }

  async function setStatus(status: StrategyStatus) {
    if (!selected) return;
    await fetch("/api/strategies", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: selected.id, status }) });
    await load();
  }

  async function remove() {
    if (!selected) return;
    if (!confirmDelete) { setConfirmDelete(true); window.setTimeout(() => setConfirmDelete(false), 4000); return; }
    setConfirmDelete(false);
    await fetch(`/api/strategies?id=${encodeURIComponent(selected.id)}`, { method: "DELETE" });
    setSelectedId(null);
    await load();
  }

  async function loadSignals(submit = false) {
    if (!selected || signalsLoading) return;
    setSignalsLoading(true);
    try {
      const response = await fetch("/api/strategies/signals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: selected.id, capitalUsd: capital, submit, gateway: "dry_run" }) });
      const data = await response.json() as SignalsResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "시그널 계산에 실패했습니다.");
      setSignals(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "시그널 계산에 실패했습니다.");
    } finally {
      setSignalsLoading(false);
    }
  }

  const result = selected?.latestResult ?? null;
  const stageIndex = selected ? PIPELINE.indexOf(selected.status === "rejected" ? "backtested" : selected.status) : -1;

  return <section className="backtest-view">
    <header className="lab-page-head">
      <div><span>HYPOTHESIS → RULE → EVIDENCE</span><h1>Backtest</h1><p>Lab JARVIS가 탑다운 가설로 만든 전략을 실제 일봉으로 검증하고, 통과한 시그널을 실거래 준비 단계로 넘깁니다.</p></div>
      <div className="lab-capabilities"><span><FlaskConical size={13} />IS / OOS · 교란 견고성</span><span><FlaskConical size={13} />통과 기준 판정</span><span><Zap size={13} />Live signal · Toss</span></div>
    </header>
    <div className="backtest-layout">
      <aside className="strategy-list">
        <header><strong>전략</strong><span>{strategies.length}</span></header>
        {!ready && <div className="research-empty"><RefreshCw size={16} className="spin" /><strong>불러오는 중</strong></div>}
        {ready && !strategies.length && <div className="research-empty"><Sparkles size={18} /><strong>아직 전략이 없습니다.</strong><p>Lab에서 JARVIS에게 “~한 가설로 전략 만들어줘”라고 하면 탑다운 가설과 규칙이 카드로 제안되고, 저장하면 여기에 쌓입니다.</p>{onAskLab && <button className="run-button" onClick={() => onAskLab("금리 인하 사이클에서 장기 성장주가 초과수익을 낸다는 가설로 QQQ 추세추종 전략을 만들어줘")}>Lab에서 전략 만들기</button>}</div>}
        {strategies.map((item) => <button key={item.id} className={`strategy-row ${selected?.id === item.id ? "active" : ""} ${item.status}`} onClick={() => setSelectedId(item.id)}>
          <span><strong>{item.name}</strong><small>{item.spec.universe.join(", ")} · {item.spec.period.from.slice(0, 4)}–{item.spec.period.to.slice(0, 4)}</small></span>
          <em className={item.status}>{STATUS_LABELS[item.status]}</em>
          {item.latestResult && <b className={toneOf(item.latestResult.metrics.excessCagrPct)}>{formatPercent(item.latestResult.metrics.cagrPct)}<small>CAGR</small></b>}
        </button>)}
      </aside>
      <section className="strategy-detail">
        {!selected && ready && <div className="lab-canvas-empty"><FlaskConical size={28} /><strong>전략을 선택하세요.</strong><p>왼쪽 목록에서 전략을 고르면 가설, 규칙, 백테스트 결과, 실거래 시그널을 볼 수 있습니다.</p></div>}
        {selected && <>
          <header className="strategy-head">
            <div><span>{STATUS_LABELS[selected.status]}{selected.sourceConversationId ? " · Lab 대화에서 생성" : ""}</span><h2>{selected.name}</h2><p>{selected.spec.universe.join(", ")} · 벤치마크 {selected.spec.benchmark}</p></div>
            <div className="strategy-actions">
              {onAskLab && <button onClick={() => onAskLab(`저장된 전략 "${selected.name}"의 최신 백테스트 결과를 해석하고, 가설이 지지되는지와 다음 검증 단계를 제안해줘.`)}><Sparkles size={13} />JARVIS 해석</button>}
              <button className={confirmDelete ? "danger" : ""} onClick={remove}><Trash2 size={13} />{confirmDelete ? "한 번 더 누르면 삭제" : "삭제"}</button>
            </div>
          </header>
          <ol className="strategy-pipeline">{PIPELINE.map((stage, index) => <li key={stage} className={index < stageIndex ? "done" : index === stageIndex ? "current" : ""}>{STATUS_LABELS[stage]}</li>)}{selected.status === "rejected" && <li className="rejected">기각</li>}</ol>
          <section className="strategy-hypothesis">
            <header><span>TOP-DOWN HYPOTHESIS</span><strong>가설 → 반증 조건</strong></header>
            <ol className="lab-hypothesis">
              <li><small>1 · 논제</small><p>{selected.spec.hypothesis.thesis}</p></li>
              <li><small>2 · 메커니즘</small><p>{selected.spec.hypothesis.mechanism}</p></li>
              <li><small>3 · 예측</small><p>{selected.spec.hypothesis.prediction}</p></li>
              <li><small>4 · 반증</small><p>{selected.spec.hypothesis.falsification}</p></li>
            </ol>
          </section>
          <section className="strategy-controls">
            <label>시작<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>종료<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
            <label>비용 bps<input type="number" min={0} step={1} value={costBps} onChange={(event) => setCostBps(Number(event.target.value))} /></label>
            <button className="run-button" disabled={running} onClick={runBacktest}><Play size={13} fill="currentColor" />{running ? "실행 중…" : "백테스트 실행"}</button>
            {error && <em className="error">{error}</em>}
          </section>
          {result ? <StrategyBacktestView artifact={toArtifact(result, selected.id)} /> : <div className="lab-canvas-empty compact"><FlaskConical size={22} /><strong>아직 백테스트 결과가 없습니다.</strong><p>기간과 비용을 확인한 뒤 실행하세요.</p></div>}
          {result && result.robustness.perturbations.length > 0 && <section className="strategy-robustness"><header><span>ROBUSTNESS</span><strong>파라미터 교란</strong></header><div className="lab-table-wrap"><table className="lab-table"><thead><tr><th>변형</th><th>CAGR</th><th>샤프</th><th>MDD</th></tr></thead><tbody>{result.robustness.perturbations.map((row) => <tr key={row.label}><td>{row.label}</td><td className={toneOf(row.cagrPct)}>{formatPercent(row.cagrPct)}</td><td>{row.sharpe ?? "—"}</td><td className={toneOf(row.maxDrawdownPct)}>{formatPercent(row.maxDrawdownPct)}</td></tr>)}</tbody></table></div></section>}
          {result && result.trades.length > 0 && <section className="strategy-trades"><header><span>TRADES</span><strong>최근 거래 {Math.min(20, result.trades.length)}건</strong></header><div className="lab-table-wrap"><table className="lab-table"><thead><tr><th>종목</th><th>진입</th><th>청산</th><th>진입가</th><th>청산가</th><th>보유일</th><th>수익률</th><th>사유</th></tr></thead><tbody>{[...result.trades].reverse().slice(0, 20).map((trade) => <tr key={`${trade.symbol}-${trade.entryDate}`}><td>{trade.symbol}</td><td>{trade.entryDate}</td><td>{trade.exitDate}</td><td>{trade.entryPrice}</td><td>{trade.exitPrice}</td><td>{trade.sessions}</td><td className={toneOf(trade.returnPct)}>{formatPercent(trade.returnPct)}</td><td>{trade.reason}</td></tr>)}</tbody></table></div></section>}
          <section className="strategy-live">
            <header><div><span>LIVE SIGNAL · TOSS</span><strong>현재 신호와 주문 초안</strong></div><div className="strategy-live-controls"><label>자본 USD<input type="number" min={100} step={100} value={capital} onChange={(event) => setCapital(Number(event.target.value))} /></label><button className="run-button" disabled={signalsLoading} onClick={() => loadSignals(false)}><Zap size={13} />{signalsLoading ? "계산 중…" : "시그널 계산"}</button></div></header>
            {selected.status !== "candidate" && selected.status !== "paper" && selected.status !== "live" && <p className="strategy-live-note">통과 기준을 만족한 “시그널 후보” 이후 단계에서 실거래 연결을 검토하세요. 지금도 계산은 가능하지만 검증되지 않은 규칙입니다.</p>}
            {signals && <>
              <div className="lab-table-wrap"><table className="lab-table"><thead><tr><th>종목</th><th>기준일</th><th>종가</th><th>신호</th><th>전환</th><th>Toss 현재가</th><th>세션</th></tr></thead><tbody>{signals.signals.map((signal) => <tr key={signal.symbol}><td>{signal.symbol}</td><td>{signal.latestDate}</td><td>{signal.latestClose}</td><td className={signal.signal === "long" ? "positive" : "neutral"}>{signal.signal.toUpperCase()}</td><td>{signal.transition === "enter" ? "진입" : signal.transition === "exit" ? `청산 (${signal.exitReason ?? ""})` : signal.transition === "hold" ? "보유" : "관망"}</td><td>{signal.broker.available ? signal.broker.price : signal.broker.reason ?? "—"}</td><td>{signal.broker.session?.label ?? "—"}</td></tr>)}</tbody></table></div>
              {signals.intents.length ? <div className="order-intents">{signals.intents.map((intent) => <article key={intent.id} className={intent.side}><span>{intent.side === "buy" ? "BUY" : "SELL"}</span><strong>{intent.quantity} × {intent.symbol}</strong><small>@ {intent.referencePrice} · ${intent.notionalUsd.toLocaleString()} · {intent.reason} · 신호일 {intent.signalDate}</small></article>)}</div> : <p className="strategy-live-note">현재 새 주문이 필요한 신호 변화가 없습니다.</p>}
              <footer className="strategy-live-footer"><span>게이트웨이 {signals.gateway.label} · {new Date(signals.asOf).toLocaleString("ko-KR")}</span><button disabled={!signals.intents.length || signalsLoading} onClick={() => loadSignals(true)}>Dry run 기록</button><em>이 화면은 dry run 전용입니다. 실주문은 전략 탭에서 토스 게이트웨이로 실행하세요.</em></footer>
              {signals.submissions.length > 0 && <ul className="submissions">{signals.submissions.map((item) => <li key={item.intentId} className={item.accepted ? "ok" : "bad"}>{item.message}</li>)}</ul>}
            </>}
          </section>
          <section className="strategy-status">
            <header><span>STAGE</span><strong>단계 이동</strong></header>
            <div>
              <button disabled={selected.status === "candidate"} onClick={() => setStatus("candidate")}>시그널 후보로</button>
              <button disabled={selected.status === "paper"} onClick={() => setStatus("paper")}>페이퍼 트레이딩</button>
              <button disabled={selected.status === "live"} onClick={() => setStatus("live")}>실거래 준비</button>
              <button disabled={selected.status === "rejected"} onClick={() => setStatus("rejected")}>기각</button>
            </div>
          </section>
          {runs.length > 0 && <section className="strategy-runs"><header><span>HISTORY</span><strong>실행 기록</strong></header><div className="lab-table-wrap"><table className="lab-table"><thead><tr><th>시각</th><th>기간</th><th>CAGR</th><th>샤프</th><th>MDD</th><th>판정</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{new Date(run.createdAt).toLocaleString("ko-KR")}</td><td>{run.period ? `${run.period.from} → ${run.period.to}` : "—"}</td><td className={toneOf(run.metrics?.cagrPct)}>{formatPercent(run.metrics?.cagrPct)}</td><td>{run.metrics?.sharpe ?? "—"}</td><td className={toneOf(run.metrics?.maxDrawdownPct)}>{formatPercent(run.metrics?.maxDrawdownPct)}</td><td>{run.verdict}</td></tr>)}</tbody></table></div></section>}
        </>}
      </section>
    </div>
  </section>;
}
