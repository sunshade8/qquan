"use client";

import Download from "lucide-react/dist/esm/icons/download";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Layers from "lucide-react/dist/esm/icons/layers";
import Play from "lucide-react/dist/esm/icons/play";
import Plus from "lucide-react/dist/esm/icons/plus";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import X from "lucide-react/dist/esm/icons/x";
import Zap from "lucide-react/dist/esm/icons/zap";
import { useCallback, useEffect, useState } from "react";

type CatalogEntry = {
  key: string; name: string; summary: string; universe: string[]; universeCount: number;
  benchmark: string; rules: string[]; evidence: string; cautions: string[]; params: Record<string, number>;
};
type ReportSummary = { id: string; kind: "backtest" | "trade"; title: string; filename: string; createdAt: string; summary: Record<string, unknown> };
type Instance = {
  id: string; strategyKey: string; name: string; capitalUsd: number; gateway: "dry_run" | "toss";
  createdAt: string; updatedAt: string; lastBacktestAt: string | null; lastTradeAt: string | null; reports: ReportSummary[];
};
type TossStatus = {
  ready: boolean; reason: string | null;
  account: { accountNo: string; accountSeq: number; accountType: string } | null;
  buyingPowerUsd: number | null;
  usCommissionRate: number | null;
  usCommissionEndDate: string | null;
  orderMode: "loc" | "market";
};
type BoardResponse = { catalog: CatalogEntry[]; instances: Instance[]; toss: TossStatus; persistence?: string };

type BacktestMetrics = {
  trades: number; winRatePct: number | null; avgNetPct: number | null; medianNetPct: number | null;
  avgWinPct: number | null; avgLossPct: number | null; payoff: number | null; totalReturnPct: number | null;
  maxDrawdownPct: number | null; activeDays: number; activeDayPct: number | null; exposurePct: number | null;
  benchmarkReturnPct: number | null; costPaidUsd: number;
};
type BacktestTrade = { symbol: string; entryDate: string; exitDate: string; quantity: number; entryPrice: number; exitPrice: number; sessions: number; netPct: number; netUsd: number; exit: string };
type BacktestResponse = {
  result: {
    strategyName: string; from: string; to: string; sessions: number; startingCapitalUsd: number; endingEquityUsd: number;
    metrics: BacktestMetrics; trades: BacktestTrade[];
    openPositions: Array<{ symbol: string; quantity: number; averagePrice: number; lastPrice: number; unrealizedUsd: number; entryDate: string }>;
    missing: string[];
  };
  markdown: string; filename: string; title: string; createdAt: string; reportId: string | null; reportSaved: boolean;
};

type PlannedOrder = { symbol: string; side: "buy" | "sell"; quantity: number; referencePrice: number; notionalUsd: number; reason: string; rule: string; stopPrice: number | null };
type TradeResponse = {
  asOf: string; submitted: boolean;
  gateway: {
    id: string; label: string; tossReady: boolean; tossReason: string | null;
    accountNo: string | null; buyingPowerUsd: number | null;
    usCommissionRate: number | null; usCommissionEndDate: string | null; orderMode: "loc" | "market";
  };
  capitalUsd: number;
  positionSource: "ledger" | "broker";
  untouched: Array<{ symbol: string; quantity: number; reason: string }>;
  positions: Array<{ symbol: string; quantity: number; averagePrice: number; entryDate: string; sessionsAtFill: number }>;
  orders: PlannedOrder[];
  skipped: Array<{ symbol: string; reason: string; metric: number | null }>;
  notes: string[];
  quotes: Record<string, { price: number; bid: number | null; ask: number | null; session: string | null }>;
  missing: string[];
  submissions: Array<{ intentId: string; symbol: string; side: string; accepted: boolean; message: string; ledger: string }>;
  markdown: string | null; reportId: string | null; confirmPhrase: string;
};

function pct(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
}
function price(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(2);
}
function usd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  // The sign belongs outside the currency symbol: "$-58" reads as a price.
  return `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
/** Drawdown is stored as a positive magnitude; it reads as a loss. */
function drawdown(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `−${Math.abs(value).toFixed(2)}%`;
}
function tone(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "neutral";
  return value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
}
function when(value: string | null) {
  return value ? new Date(value).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "없음";
}

/** Saves the markdown the server rendered, so the file on disk is the stored record. */
function downloadMarkdown(filename: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function StrategyWorkspace() {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newCapital, setNewCapital] = useState(10000);
  const [newGateway, setNewGateway] = useState<"dry_run" | "toss">("dry_run");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [backtest, setBacktest] = useState<(BacktestResponse & { instanceId: string }) | null>(null);
  const [trade, setTrade] = useState<(TradeResponse & { instanceId: string; strategyName: string }) | null>(null);
  const [tradeConfirming, setTradeConfirming] = useState(false);
  const [viewer, setViewer] = useState<{ title: string; filename: string; markdown: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/trade-strategies", { cache: "no-store" });
      const data = await response.json() as BoardResponse;
      setBoard(data);
      if (!newKey && data.catalog.length) setNewKey(data.catalog[0].key);
    } catch {
      setBoard(null);
    } finally {
      setReady(true);
    }
  }, [newKey]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function addStrategy() {
    if (!newKey) return;
    setBusy("add");
    setError("");
    try {
      const response = await fetch("/api/trade-strategies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ strategyKey: newKey, capitalUsd: newCapital, gateway: newGateway }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "전략을 추가하지 못했습니다.");
      setAdding(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "전략을 추가하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function removeStrategy(id: string) {
    if (confirmDelete !== id) { setConfirmDelete(id); window.setTimeout(() => setConfirmDelete((current) => current === id ? null : current), 4000); return; }
    setConfirmDelete(null);
    setBusy(id);
    await fetch(`/api/trade-strategies?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    setBusy(null);
    await load();
  }

  async function runBacktest(instance: Instance) {
    setBusy(`bt-${instance.id}`);
    setError("");
    try {
      const response = await fetch("/api/trade-strategies/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: instance.id, sessions: 60 }) });
      const data = await response.json() as BacktestResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "백테스트에 실패했습니다.");
      setBacktest({ ...data, instanceId: instance.id });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "백테스트에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function planTrade(instance: Instance, submit: boolean) {
    setBusy(`tr-${instance.id}`);
    setError("");
    try {
      const response = await fetch("/api/trade-strategies/trade", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: instance.id, submit, confirm: submit ? "매매" : undefined }),
      });
      const data = await response.json() as TradeResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "주문 계획에 실패했습니다.");
      setTrade({ ...data, instanceId: instance.id, strategyName: instance.name });
      setTradeConfirming(false);
      if (submit) await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "주문 계획에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function openReport(id: string) {
    try {
      const response = await fetch(`/api/trade-strategies/reports?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json() as { report?: { title: string; filename: string; markdown: string }; error?: string };
      if (!response.ok || !data.report) throw new Error(data.error || "기록을 불러오지 못했습니다.");
      setViewer(data.report);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "기록을 불러오지 못했습니다.");
    }
  }

  const catalog = board?.catalog ?? [];
  const instances = board?.instances ?? [];
  const selectedCatalog = catalog.find((entry) => entry.key === newKey) ?? null;

  return <section className="strategy-board">
    <header className="lab-page-head">
      <div><span>RULE → BACKTEST → ORDER</span><h1>전략</h1><p>코드로 구현된 매매 규칙을 카드로 올려두고, 같은 함수로 백테스트하거나 실제 주문을 냅니다.</p></div>
      <div className="lab-capabilities"><span><Layers size={13} />규칙 = 코드</span><span><Play size={13} />최근 60거래일</span><span><Zap size={13} />Toss 주문</span></div>
    </header>

    {board?.toss && !board.toss.ready && <div className="strategy-warning">
      <TriangleAlert size={15} />
      <div>
        <strong>토스 실주문을 지금 보낼 수 없습니다.</strong>
        <p>{board.toss.reason ?? "계좌 상태를 확인하지 못했습니다."} 이 상태에서 “매매”를 누르면 주문 계획만 만들어 페이퍼 원장에 기록합니다.</p>
      </div>
    </div>}

    {board?.toss?.ready && <div className="strategy-account">
      <span><i />토스증권 계좌 <strong>{board.toss.account?.accountNo ?? "—"}</strong></span>
      <span>USD 매수가능 <strong className={(board.toss.buyingPowerUsd ?? 0) > 0 ? "" : "warn"}>{usd(board.toss.buyingPowerUsd)}</strong></span>
      <span>미국주식 수수료 <strong>{board.toss.usCommissionRate === null ? "—" : `${(board.toss.usCommissionRate * 100).toFixed(3)}%`}</strong> / 편도</span>
      <span>주문 유형 <strong>{board.toss.orderMode === "loc" ? "LOC (종가 지정가)" : "시장가"}</strong></span>
    </div>}

    {board?.toss?.usCommissionEndDate && board.toss.usCommissionEndDate <= new Date().toISOString().slice(0, 10) && <div className="strategy-warning">
      <TriangleAlert size={15} />
      <div>
        <strong>미국주식 수수료 적용 기간이 {board.toss.usCommissionEndDate}에 끝납니다.</strong>
        <p>모든 백테스트는 <code>lib/broker-costs.ts</code>의 편도 {(board.toss.usCommissionRate ?? 0.001) * 100}% 를 전제로 계산했습니다. 요율이 바뀌면 이 전략의 손익분기 승률도 함께 올라가므로 <code>TOSS_FEE_PER_SIDE_PCT</code>로 새 요율을 반영한 뒤 다시 백테스트하세요.</p>
      </div>
    </div>}

    {(board?.toss?.buyingPowerUsd ?? 0) <= 0 && board?.toss?.ready && <div className="strategy-warning">
      <TriangleAlert size={15} />
      <div>
        <strong>USD 매수 가능 금액이 $0입니다.</strong>
        <p>매수 주문은 <code>insufficient-buying-power</code>로 거부됩니다. 원화를 달러로 환전하거나 예수금을 채운 뒤 실행하세요. 매도 주문은 영향받지 않습니다.</p>
      </div>
    </div>}

    {error && <div className="strategy-warning error"><TriangleAlert size={15} /><div><strong>{error}</strong></div></div>}

    <div className="strategy-board-head">
      <strong>등록된 전략 {instances.length}</strong>
      <button className="run-button" onClick={() => setAdding((value) => !value)}><Plus size={13} />전략 추가</button>
    </div>

    {adding && <section className="strategy-add">
      <div className="strategy-add-fields">
        <label>전략<select value={newKey} onChange={(event) => setNewKey(event.target.value)}>{catalog.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}</option>)}</select></label>
        <label>자본 USD<input type="number" min={100} step={500} value={newCapital} onChange={(event) => setNewCapital(Number(event.target.value))} /></label>
        <label>주문 경로<select value={newGateway} onChange={(event) => setNewGateway(event.target.value === "toss" ? "toss" : "dry_run")}><option value="dry_run">Dry run (원장 기록만)</option><option value="toss">Toss 실주문</option></select></label>
        <button className="run-button" disabled={busy === "add"} onClick={addStrategy}>{busy === "add" ? "추가 중…" : "보드에 올리기"}</button>
      </div>
      {selectedCatalog && <div className="strategy-add-preview">
        <p>{selectedCatalog.summary}</p>
        <ul>{selectedCatalog.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
        <small>{selectedCatalog.evidence}</small>
      </div>}
    </section>}

    {!ready && <div className="research-empty"><RefreshCw size={16} className="spin" /><strong>불러오는 중</strong></div>}
    {ready && !instances.length && <div className="lab-canvas-empty"><Layers size={28} /><strong>아직 올린 전략이 없습니다.</strong><p>“전략 추가”를 눌러 코드로 구현된 규칙을 보드에 올리세요. 카드마다 백테스트와 매매를 각각 실행할 수 있습니다.</p></div>}

    <div className="strategy-cards">
      {instances.map((instance) => {
        const entry = catalog.find((item) => item.key === instance.strategyKey);
        const lastBacktest = instance.reports.find((report) => report.kind === "backtest");
        return <article key={instance.id} className="strategy-card">
          <header>
            <div><strong>{instance.name}</strong><small>{entry ? `${entry.universeCount}종목 · 벤치마크 ${entry.benchmark}` : instance.strategyKey}</small></div>
            <button className={confirmDelete === instance.id ? "danger" : "ghost"} onClick={() => removeStrategy(instance.id)} aria-label="전략 삭제"><Trash2 size={13} />{confirmDelete === instance.id ? "한 번 더" : ""}</button>
          </header>
          {entry && <p className="strategy-card-summary">{entry.summary}</p>}
          <dl className="strategy-card-meta">
            <div><dt>자본</dt><dd>{usd(instance.capitalUsd)}</dd></div>
            <div><dt>주문 경로</dt><dd>{instance.gateway === "toss" ? "Toss 실주문" : "Dry run"}</dd></div>
            <div><dt>최근 백테스트</dt><dd>{when(instance.lastBacktestAt)}</dd></div>
            <div><dt>최근 매매</dt><dd>{when(instance.lastTradeAt)}</dd></div>
          </dl>
          {lastBacktest && <div className="strategy-card-last">
            <span>지난 백테스트</span>
            <b className={tone(Number(lastBacktest.summary.totalReturnPct))}>{pct(Number(lastBacktest.summary.totalReturnPct))}</b>
            <small>{String(lastBacktest.summary.trades ?? "—")}거래 · 승률 {lastBacktest.summary.winRatePct === null ? "—" : `${lastBacktest.summary.winRatePct}%`} · 거래당 {pct(Number(lastBacktest.summary.avgNetPct))}</small>
          </div>}
          <div className="strategy-card-actions">
            <button className="run-button" disabled={busy === `bt-${instance.id}`} onClick={() => runBacktest(instance)}><Play size={13} fill="currentColor" />{busy === `bt-${instance.id}` ? "실행 중…" : "백테스트"}</button>
            <button className="trade-button" disabled={busy === `tr-${instance.id}`} onClick={() => planTrade(instance, false)}><Zap size={13} />{busy === `tr-${instance.id}` ? "계산 중…" : "매매"}</button>
          </div>
          {instance.reports.length > 0 && <details className="strategy-card-reports">
            <summary><FileText size={12} />기록 {instance.reports.length}건</summary>
            <ul>{instance.reports.map((report) => <li key={report.id}>
              <button onClick={() => openReport(report.id)}><em className={report.kind}>{report.kind === "backtest" ? "BT" : "TR"}</em><span>{report.title}</span><small>{when(report.createdAt)}</small></button>
              <a href={`/api/trade-strategies/reports?id=${encodeURIComponent(report.id)}&download=1`} download={report.filename} aria-label="마크다운 내려받기"><Download size={12} /></a>
            </li>)}</ul>
          </details>}
        </article>;
      })}
    </div>

    {backtest && <div className="strategy-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setBacktest(null); }}>
      <article className="strategy-modal" role="dialog" aria-modal="true" aria-labelledby="backtest-modal-title">
        <header>
          <div><span>BACKTEST · 최근 {backtest.result.sessions}거래일</span><h2 id="backtest-modal-title">{backtest.result.strategyName}</h2><p>{backtest.result.from} → {backtest.result.to} · 시작 {usd(backtest.result.startingCapitalUsd)} → 종료 {usd(backtest.result.endingEquityUsd)}</p></div>
          <button onClick={() => setBacktest(null)} aria-label="닫기"><X size={16} /></button>
        </header>
        <div className="strategy-modal-scroll">
          <div className="strategy-metric-grid">
            <div><span>총수익</span><b className={tone(backtest.result.metrics.totalReturnPct)}>{pct(backtest.result.metrics.totalReturnPct)}</b></div>
            <div><span>벤치마크</span><b className={tone(backtest.result.metrics.benchmarkReturnPct)}>{pct(backtest.result.metrics.benchmarkReturnPct)}</b></div>
            <div><span>거래</span><b>{backtest.result.metrics.trades}</b></div>
            <div><span>승률</span><b>{backtest.result.metrics.winRatePct === null ? "—" : `${backtest.result.metrics.winRatePct}%`}</b></div>
            <div><span>거래당 순수익</span><b className={tone(backtest.result.metrics.avgNetPct)}>{pct(backtest.result.metrics.avgNetPct)}</b></div>
            <div><span>손익비</span><b>{backtest.result.metrics.payoff ?? "—"}</b></div>
            <div><span>최대 낙폭</span><b className="negative">{drawdown(backtest.result.metrics.maxDrawdownPct)}</b></div>
            <div><span>지불 비용</span><b>{usd(backtest.result.metrics.costPaidUsd)}</b></div>
          </div>
          {backtest.result.missing.length > 0 && <p className="strategy-note">일봉을 못 불러온 종목 {backtest.result.missing.length}개: {backtest.result.missing.join(", ")}</p>}
          {backtest.result.trades.length > 0 ? <div className="lab-table-wrap"><table className="lab-table">
            <thead><tr><th>종목</th><th>진입</th><th>청산</th><th>수량</th><th>진입가</th><th>청산가</th><th>보유</th><th>순수익</th><th>손익</th><th>사유</th></tr></thead>
            <tbody>{[...backtest.result.trades].reverse().map((row, index) => <tr key={`${row.symbol}-${row.entryDate}-${index}`}>
              <td>{row.symbol}</td><td>{row.entryDate}</td><td>{row.exitDate}</td><td>{row.quantity}</td><td>{price(row.entryPrice)}</td><td>{price(row.exitPrice)}</td><td>{row.sessions}일</td>
              <td className={tone(row.netPct)}>{pct(row.netPct)}</td><td className={tone(row.netUsd)}>{usd(row.netUsd)}</td><td>{row.exit === "stop" ? "손절" : "시간"}</td>
            </tr>)}</tbody>
          </table></div> : <p className="strategy-note">이 기간에 청산된 거래가 없습니다.</p>}
          {backtest.result.openPositions.length > 0 && <>
            <h3 className="strategy-modal-sub">기간 종료 시점 미청산 {backtest.result.openPositions.length}건</h3>
            <div className="lab-table-wrap"><table className="lab-table">
              <thead><tr><th>종목</th><th>수량</th><th>평단</th><th>최종가</th><th>평가손익</th><th>진입일</th></tr></thead>
              <tbody>{backtest.result.openPositions.map((row) => <tr key={row.symbol}><td>{row.symbol}</td><td>{row.quantity}</td><td>{price(row.averagePrice)}</td><td>{price(row.lastPrice)}</td><td className={tone(row.unrealizedUsd)}>{usd(row.unrealizedUsd)}</td><td>{row.entryDate}</td></tr>)}</tbody>
            </table></div>
          </>}
          <h3 className="strategy-modal-sub">마크다운 기록</h3>
          <p className="strategy-note">{backtest.reportSaved ? `${backtest.filename} 로 저장했습니다. 카드의 “기록”에서 다시 열 수 있습니다.` : "저장소에 기록하지 못했습니다. 아래에서 파일로 내려받으세요."}</p>
          <pre className="strategy-markdown">{backtest.markdown}</pre>
        </div>
        <footer>
          <span>{backtest.filename}</span>
          <button className="run-button" onClick={() => downloadMarkdown(backtest.filename, backtest.markdown)}><Download size={13} />.md 내려받기</button>
        </footer>
      </article>
    </div>}

    {trade && <div className="strategy-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setTrade(null); setTradeConfirming(false); } }}>
      <article className="strategy-modal" role="dialog" aria-modal="true" aria-labelledby="trade-modal-title">
        <header>
          <div><span>{trade.submitted ? "TRADE · 전송함" : "TRADE · 주문 계획"}</span><h2 id="trade-modal-title">{trade.strategyName}</h2><p>신호 기준일 {trade.asOf} · 자본 {usd(trade.capitalUsd)} · {trade.gateway.label}</p></div>
          <button onClick={() => { setTrade(null); setTradeConfirming(false); }} aria-label="닫기"><X size={16} /></button>
        </header>
        <div className="strategy-modal-scroll">
          {!trade.gateway.tossReady && trade.gateway.id === "toss" && <div className="strategy-warning inline"><TriangleAlert size={14} /><div><strong>토스 실주문을 보낼 수 없는 상태입니다.</strong><p>{trade.gateway.tossReason ?? "계좌 확인 실패"}</p></div></div>}
          {trade.gateway.id === "toss" && trade.gateway.tossReady && <p className="strategy-note">계좌 {trade.gateway.accountNo} · USD 매수가능 {usd(trade.gateway.buyingPowerUsd)} · 주문 유형 {trade.gateway.orderMode === "loc" ? "LOC(종가 지정가)" : "시장가"}</p>}
          <h3 className="strategy-modal-sub">현재 보유 {trade.positions.length}건 <small className="strategy-source">{trade.positionSource === "broker" ? "토스 실제 보유 기준" : "페이퍼 원장 기준"}</small></h3>
          {trade.positions.length ? <div className="lab-table-wrap"><table className="lab-table">
            <thead><tr><th>종목</th><th>수량</th><th>평단</th><th>진입일</th><th>체결시점 보유일</th></tr></thead>
            <tbody>{trade.positions.map((row) => <tr key={row.symbol}><td>{row.symbol}</td><td>{row.quantity}</td><td>{price(row.averagePrice)}</td><td>{row.entryDate}</td><td>{row.sessionsAtFill > 1000 ? "창 밖" : `${row.sessionsAtFill}일`}</td></tr>)}</tbody>
          </table></div> : <p className="strategy-note">보유 포지션이 없습니다.</p>}

          {trade.untouched.length > 0 && <>
            <h3 className="strategy-modal-sub">이 전략이 건드리지 않는 보유 {trade.untouched.length}건</h3>
            <div className="lab-table-wrap"><table className="lab-table">
              <thead><tr><th>종목</th><th>수량</th><th>사유</th></tr></thead>
              <tbody>{trade.untouched.map((row) => <tr key={row.symbol}><td>{row.symbol}</td><td>{row.quantity}</td><td>{row.reason}</td></tr>)}</tbody>
            </table></div>
          </>}

          <h3 className="strategy-modal-sub">주문 {trade.orders.length}건</h3>
          {trade.orders.length ? <div className="order-intents">{trade.orders.map((order) => <article key={`${order.symbol}-${order.side}`} className={order.side}>
            <span>{order.side === "buy" ? "매수" : "매도"}</span>
            <strong>{order.quantity} × {order.symbol}</strong>
            <small>@ {price(order.referencePrice)} · {usd(order.notionalUsd)}{order.stopPrice ? ` · 손절 ${price(order.stopPrice)}` : ""} · {order.reason}{trade.quotes[order.symbol] ? ` · Toss ${trade.quotes[order.symbol].session ?? "시세"}` : " · 종가 기준(실시간 시세 없음)"}</small>
          </article>)}</div> : <p className="strategy-note">지금 낼 주문이 없습니다. {trade.notes.join(" ")}</p>}

          {trade.skipped.length > 0 && <>
            <h3 className="strategy-modal-sub">조건은 맞았지만 건너뛴 {trade.skipped.length}건</h3>
            <div className="lab-table-wrap"><table className="lab-table">
              <thead><tr><th>종목</th><th>3일 수익률</th><th>사유</th></tr></thead>
              <tbody>{trade.skipped.map((row) => <tr key={row.symbol}><td>{row.symbol}</td><td className={tone(row.metric)}>{row.metric === null ? "—" : `${row.metric}%`}</td><td>{row.reason}</td></tr>)}</tbody>
            </table></div>
          </>}

          {trade.submissions.length > 0 && <>
            <h3 className="strategy-modal-sub">전송 결과</h3>
            <ul className="submissions">{trade.submissions.map((item) => <li key={item.intentId} className={item.accepted ? "ok" : "bad"}>{item.message}<small>{item.ledger}</small></li>)}</ul>
          </>}

          {trade.markdown && <>
            <h3 className="strategy-modal-sub">마크다운 기록</h3>
            <pre className="strategy-markdown">{trade.markdown}</pre>
          </>}
        </div>
        <footer>
          {trade.submitted
            ? <><span>전송 완료 · 원장에 기록됨</span>{trade.markdown && <button className="run-button" onClick={() => downloadMarkdown(`trade-${trade.asOf}.md`, trade.markdown!)}><Download size={13} />.md 내려받기</button>}</>
            : <>
              <span>{tradeConfirming ? "확인을 누르면 위 주문이 그대로 실행됩니다." : `주문 ${trade.orders.length}건 · 아직 아무것도 전송하지 않았습니다.`}</span>
              {tradeConfirming
                ? <><button className="ghost" onClick={() => setTradeConfirming(false)}>취소</button><button className="danger" disabled={busy === `tr-${trade.instanceId}`} onClick={() => { const instance = instances.find((item) => item.id === trade.instanceId); if (instance) void planTrade(instance, true); }}>{busy === `tr-${trade.instanceId}` ? "전송 중…" : `${trade.orders.length}건 실행`}</button></>
                : <button className="trade-button" disabled={!trade.orders.length} onClick={() => setTradeConfirming(true)}><Zap size={13} />이 주문 실행</button>}
            </>}
        </footer>
      </article>
    </div>}

    {viewer && <div className="strategy-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewer(null); }}>
      <article className="strategy-modal" role="dialog" aria-modal="true" aria-labelledby="report-modal-title">
        <header><div><span>RECORD</span><h2 id="report-modal-title">{viewer.title}</h2><p>{viewer.filename}</p></div><button onClick={() => setViewer(null)} aria-label="닫기"><X size={16} /></button></header>
        <div className="strategy-modal-scroll"><pre className="strategy-markdown">{viewer.markdown}</pre></div>
        <footer><span>{viewer.filename}</span><button className="run-button" onClick={() => downloadMarkdown(viewer.filename, viewer.markdown)}><Download size={13} />.md 내려받기</button></footer>
      </article>
    </div>}
  </section>;
}
