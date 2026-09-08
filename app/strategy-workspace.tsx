"use client";

import Download from "lucide-react/dist/esm/icons/download";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Layers from "lucide-react/dist/esm/icons/layers";
import Play from "lucide-react/dist/esm/icons/play";
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
/** One coded strategy plus whatever settings and history exist for it. */
type Card = {
  key: string; id: string | null; name: string;
  capitalUsd: number; gateway: "dry_run" | "toss";
  lastBacktestAt: string | null; lastTradeAt: string | null;
  configured: boolean; reports: ReportSummary[];
};
type TossCause = "disabled" | "no_credentials" | "ip_allowlist" | "auth" | "permission" | "no_account" | "unknown";
type TossStatus = {
  ready: boolean; reason: string | null; cause: TossCause | null; egressIp: string | null;
  account: { accountNo: string; accountSeq: number; accountType: string } | null;
  buyingPowerUsd: number | null;
  usCommissionRate: number | null;
  usCommissionEndDate: string | null;
  orderMode: "loc" | "market";
};
type BoardResponse = { catalog: CatalogEntry[]; cards: Card[]; toss: TossStatus; defaultCapitalUsd: number; persistence?: string };

/** What to actually do about each way the broker connection can be unavailable. */
const TOSS_FIX: Record<TossCause, { title: string; how: string }> = {
  no_credentials: {
    title: "이 배포 환경에 토스 키가 없습니다.",
    how: "`.dev.vars` 는 로컬 전용이라 커밋되지 않습니다. 배포 환경의 시크릿에 TOSS_CLIENT_ID 와 TOSS_CLIENT_SECRET 을 같은 이름으로 넣어야 합니다.",
  },
  ip_allowlist: {
    title: "토스가 이 서버의 IP를 차단했습니다 (403).",
    how: "토스 WTS > 설정 > Open API > 허용 IP 관리에 등록된 IP에서만 호출이 됩니다. 로컬에서 되고 배포에서 안 되는 이유가 이것입니다 — 등록된 건 개발 PC 주소이고, 배포된 Worker는 Cloudflare 대역에서 나갑니다. 그 주소는 요청마다 바뀔 수 있어서 하나만 등록해도 다음 호출에서 또 막힐 수 있습니다. 확실한 방법은 고정 IP를 가진 서버를 거쳐 호출하거나, 주문 실행만 허용 IP가 등록된 로컬에서 돌리는 것입니다.",
  },
  auth: { title: "토스 인증에 실패했습니다.", how: "키가 만료됐거나 잘못 복사됐을 수 있습니다. 콘솔에서 Client ID/Secret 을 다시 확인하세요." },
  permission: { title: "이 앱에 필요한 권한이 없습니다.", how: "토스증권 콘솔에서 계좌·자산·주문 스코프가 켜져 있는지 확인하세요." },
  no_account: { title: "주문 가능한 계좌를 찾지 못했습니다.", how: "종합매매(BROKERAGE) 계좌가 이 앱에 연결돼 있는지 확인하세요." },
  disabled: { title: "실주문이 잠겨 있습니다.", how: "환경변수 TOSS_TRADING_DISABLED 를 지우면 풀립니다." },
  unknown: { title: "토스 연결을 확인하지 못했습니다.", how: "아래 원문 메시지를 확인하세요." },
};

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
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  /** Unsaved capital edits, keyed by strategy, so typing does not fight a reload. */
  const [capitalDraft, setCapitalDraft] = useState<Record<string, number>>({});

  const [backtest, setBacktest] = useState<(BacktestResponse & { strategyKey: string }) | null>(null);
  const [trade, setTrade] = useState<(TradeResponse & { strategyKey: string; strategyName: string }) | null>(null);
  const [tradeConfirming, setTradeConfirming] = useState(false);
  const [viewer, setViewer] = useState<{ title: string; filename: string; markdown: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/trade-strategies", { cache: "no-store" });
      setBoard(await response.json() as BoardResponse);
    } catch {
      setBoard(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const capitalOf = (card: Card) => capitalDraft[card.key] ?? card.capitalUsd;

  async function saveSettings(card: Card, patch: { capitalUsd?: number; gateway?: "dry_run" | "toss" }) {
    setError("");
    try {
      const response = await fetch("/api/trade-strategies", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategyKey: card.key, ...patch }),
      });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error || "설정을 저장하지 못했습니다.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "설정을 저장하지 못했습니다.");
    }
  }

  async function clearHistory(card: Card) {
    if (confirmClear !== card.key) { setConfirmClear(card.key); window.setTimeout(() => setConfirmClear((current) => current === card.key ? null : current), 4000); return; }
    setConfirmClear(null);
    setBusy(`clear-${card.key}`);
    await fetch(`/api/trade-strategies?strategyKey=${encodeURIComponent(card.key)}`, { method: "DELETE" }).catch(() => undefined);
    setBusy(null);
    await load();
  }

  async function runBacktest(card: Card) {
    setBusy(`bt-${card.key}`);
    setError("");
    try {
      const response = await fetch("/api/trade-strategies/backtest", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategyKey: card.key, capitalUsd: capitalOf(card), sessions: 60 }),
      });
      const data = await response.json() as BacktestResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "백테스트에 실패했습니다.");
      setBacktest({ ...data, strategyKey: card.key });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "백테스트에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function planTrade(card: Card, submit: boolean) {
    setBusy(`tr-${card.key}`);
    setError("");
    try {
      const response = await fetch("/api/trade-strategies/trade", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategyKey: card.key, capitalUsd: capitalOf(card), gateway: card.gateway, submit, confirm: submit ? "매매" : undefined }),
      });
      const data = await response.json() as TradeResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "주문 계획에 실패했습니다.");
      setTrade({ ...data, strategyKey: card.key, strategyName: card.name });
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
  const cards = board?.cards ?? [];
  const tossFix = board?.toss && !board.toss.ready ? TOSS_FIX[board.toss.cause ?? "unknown"] : null;

  return <section className="strategy-board">
    <header className="lab-page-head">
      <div><span>RULE → BACKTEST → ORDER</span><h1>전략</h1><p>코드로 구현된 매매 규칙마다 카드가 하나씩 있고, 같은 함수로 백테스트하거나 실제 주문을 냅니다.</p></div>
      <div className="lab-capabilities"><span><Layers size={13} />규칙 = 코드</span><span><Play size={13} />최근 60거래일</span><span><Zap size={13} />Toss 주문</span></div>
    </header>

    {tossFix && <div className="strategy-warning">
      <TriangleAlert size={15} />
      <div>
        <strong>{tossFix.title}</strong>
        <p>{tossFix.how}</p>
        {board?.toss.egressIp && <p className="strategy-egress">이 서버가 토스에 접속하는 IP: <code>{board.toss.egressIp}</code></p>}
        {board?.toss.reason && <p className="strategy-raw">토스 응답: {board.toss.reason}</p>}
        <p>이 상태에서 “매매”를 누르면 주문 계획만 만들어 페이퍼 원장에 기록하고, 실제 주문은 나가지 않습니다.</p>
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
      <strong>전략 {cards.length}</strong>
      <span className="strategy-board-note">코드에 등록된 규칙이 곧 카드입니다. 추가 절차 없이 바로 실행할 수 있습니다.</span>
    </div>

    {!ready && <div className="research-empty"><RefreshCw size={16} className="spin" /><strong>불러오는 중</strong></div>}
    {ready && !cards.length && <div className="lab-canvas-empty"><Layers size={28} /><strong>코드에 등록된 전략이 없습니다.</strong><p><code>lib/trade-strategies.ts</code>의 <code>TRADE_STRATEGIES</code>에 규칙을 추가하면 여기에 카드가 생깁니다.</p></div>}

    <div className="strategy-cards">
      {cards.map((card) => {
        const entry = catalog.find((item) => item.key === card.key);
        const lastBacktest = card.reports.find((report) => report.kind === "backtest");
        return <article key={card.key} className="strategy-card">
          <header>
            <div><strong>{card.name}</strong><small>{entry ? `${entry.universeCount}종목 · 벤치마크 ${entry.benchmark}` : card.key}</small></div>
            {card.configured && <button className={confirmClear === card.key ? "danger" : "ghost"} disabled={busy === `clear-${card.key}`} onClick={() => clearHistory(card)} aria-label="기록 지우기"><Trash2 size={13} />{confirmClear === card.key ? "한 번 더" : ""}</button>}
          </header>
          {entry && <p className="strategy-card-summary">{entry.summary}</p>}
          {entry && <ul className="strategy-card-rules">{entry.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>}
          <div className="strategy-card-settings">
            <label>자본 USD<input type="number" min={100} step={500} value={capitalOf(card)}
              onChange={(event) => setCapitalDraft((draft) => ({ ...draft, [card.key]: Number(event.target.value) }))}
              onBlur={() => { if (capitalOf(card) !== card.capitalUsd && capitalOf(card) >= 100) void saveSettings(card, { capitalUsd: capitalOf(card) }); }} /></label>
            <label>주문 경로<select value={card.gateway} onChange={(event) => void saveSettings(card, { gateway: event.target.value === "toss" ? "toss" : "dry_run" })}>
              <option value="dry_run">Dry run (원장 기록만)</option>
              <option value="toss">토스 실주문</option>
            </select></label>
          </div>
          <dl className="strategy-card-meta">
            <div><dt>최근 백테스트</dt><dd>{when(card.lastBacktestAt)}</dd></div>
            <div><dt>최근 매매</dt><dd>{when(card.lastTradeAt)}</dd></div>
          </dl>
          {lastBacktest && <div className="strategy-card-last">
            <span>지난 백테스트</span>
            <b className={tone(Number(lastBacktest.summary.totalReturnPct))}>{pct(Number(lastBacktest.summary.totalReturnPct))}</b>
            <small>{String(lastBacktest.summary.trades ?? "—")}거래 · 승률 {lastBacktest.summary.winRatePct === null ? "—" : `${lastBacktest.summary.winRatePct}%`} · 거래당 {pct(Number(lastBacktest.summary.avgNetPct))}</small>
          </div>}
          <div className="strategy-card-actions">
            <button className="run-button" disabled={busy === `bt-${card.key}`} onClick={() => runBacktest(card)}><Play size={13} fill="currentColor" />{busy === `bt-${card.key}` ? "실행 중…" : "백테스트"}</button>
            <button className="trade-button" disabled={busy === `tr-${card.key}`} onClick={() => planTrade(card, false)}><Zap size={13} />{busy === `tr-${card.key}` ? "계산 중…" : "매매"}</button>
          </div>
          {card.reports.length > 0 && <details className="strategy-card-reports">
            <summary><FileText size={12} />기록 {card.reports.length}건</summary>
            <ul>{card.reports.map((report) => <li key={report.id}>
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
                ? <><button className="ghost" onClick={() => setTradeConfirming(false)}>취소</button><button className="danger" disabled={busy === `tr-${trade.strategyKey}`} onClick={() => { const card = cards.find((item) => item.key === trade.strategyKey); if (card) void planTrade(card, true); }}>{busy === `tr-${trade.strategyKey}` ? "전송 중…" : `${trade.orders.length}건 실행`}</button></>
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
