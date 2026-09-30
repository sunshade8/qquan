"use client";

import CircleStop from "lucide-react/dist/esm/icons/circle-stop";
import Download from "lucide-react/dist/esm/icons/download";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import Play from "lucide-react/dist/esm/icons/play";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import X from "lucide-react/dist/esm/icons/x";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { DashboardMode, DashboardTrade, StopPhase, TradingDashboardResponse, TradingDashboardView } from "@/lib/dashboard-types";
import type { RelayBacktestReport } from "@/lib/relay-report";

const LIVE_CONFIRM = "실거래 시작";
const POLL_MS = 5_000;
const TICK_MS = 15_000;

const MODE_TITLE: Record<DashboardMode, string> = { live: "실전 투자", paper: "모의투자" };
const MODE_SUB: Record<DashboardMode, string> = { live: "토스증권 계좌 · 실제 주문", paper: "토스 실시간 시세 · 가상 체결" };
const STATUS_TEXT = { stopped: "정지됨", running: "실행 중", stopping: "정지 중" } as const;
const STOP_STEPS: Array<{ phase: StopPhase; label: string }> = [
  { phase: "cancel_buys", label: "미체결 매수 취소" },
  { phase: "liquidate", label: "보유 종목 청산" },
  { phase: "confirm", label: "체결 확인" },
];
const EXIT_TEXT: Record<string, string> = { stop: "손절", target: "목표", slot_end: "시간 청산", shutdown: "정지 청산" };

function usd(value: number | null | undefined, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value: number | null | undefined, digits = 2, signed = true) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value < 0 ? "−" : signed && value > 0 ? "+" : ""}${Math.abs(value).toFixed(digits)}%`;
}

const tone = (value: number | null | undefined) => (value === null || value === undefined || value === 0 ? "" : value > 0 ? "positive" : "negative");

function ago(iso: string | null, now: number) {
  if (!iso) return "—";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}시간 전`;
  return new Date(iso).toLocaleDateString("ko-KR");
}

const clock = (iso: string | null) => iso ? new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";

function yesterdayEt() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const value = new Date(`${today}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function shift(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------- charts

type Point = { label: string; value: number };

/** Equity over time against the starting capital, with a crosshair readout. */
function EquityChart({ points, base, caption }: { points: Point[]; base: number; caption: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640, height = 150, padX = 6, padY = 12;
  if (points.length < 2) return null;
  const values = [base, ...points.map((point) => point.value)];
  const low = Math.min(...values), high = Math.max(...values), span = high - low || 1;
  const x = (index: number) => padX + (index / (points.length - 1)) * (width - padX * 2);
  const y = (value: number) => padY + (1 - (value - low) / span) * (height - padY * 2);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const up = points.at(-1)!.value >= base;
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
  };
  const active = hover === null ? null : points[hover];
  return <figure className="trading-chart">
    <figcaption><span>{caption}</span>{active ? <b>{active.label} · {usd(active.value)} <em className={tone(active.value - base)}>{pct((active.value / base - 1) * 100)}</em></b> : <b>{usd(points.at(-1)!.value)} <em className={tone(points.at(-1)!.value - base)}>{pct((points.at(-1)!.value / base - 1) * 100)}</em></b>}</figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onPointerMove={move} onPointerLeave={() => setHover(null)} role="img" aria-label={`${caption}: ${usd(points[0].value)}에서 ${usd(points.at(-1)!.value)}`}>
      <line x1={0} x2={width} y1={y(base)} y2={y(base)} className="trading-chart-base" />
      <path d={`${path} L${x(points.length - 1)},${height} L${x(0)},${height} Z`} className={`trading-chart-wash ${up ? "up" : "down"}`} />
      <path d={path} className={`trading-chart-line ${up ? "up" : "down"}`} vectorEffect="non-scaling-stroke" />
      {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} className="trading-chart-cross" vectorEffect="non-scaling-stroke" />}
    </svg>
    <div className="trading-chart-axis"><span>{points[0].label}</span><span>시작 자본 {usd(base)} 기준선</span><span>{points.at(-1)!.label}</span></div>
  </figure>;
}

/** One column per day, green up and red down, each carrying its own readout. */
function ReturnBars({ points }: { points: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return null;
  const width = 640, height = 90, mid = height / 2;
  const peak = Math.max(0.01, ...points.map((point) => Math.abs(point.value)));
  const slot = width / points.length;
  const bar = Math.max(1, Math.min(24, slot - 2));
  const active = hover === null ? null : points[hover];
  return <figure className="trading-chart">
    <figcaption><span>날짜별 수익률</span>{active ? <b>{active.label} <em className={tone(active.value)}>{pct(active.value)}</em></b> : <b>최대 ±{peak.toFixed(2)}%</b>}</figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onPointerLeave={() => setHover(null)} role="img" aria-label="날짜별 수익률 막대">
      <line x1={0} x2={width} y1={mid} y2={mid} className="trading-chart-base" />
      {points.map((point, index) => {
        const size = (Math.abs(point.value) / peak) * (mid - 4);
        const left = index * slot + (slot - bar) / 2;
        const radius = Math.min(4, bar / 2, size);
        const d = point.value >= 0
          ? `M${left},${mid} V${mid - size + radius} Q${left},${mid - size} ${left + radius},${mid - size} H${left + bar - radius} Q${left + bar},${mid - size} ${left + bar},${mid - size + radius} V${mid} Z`
          : `M${left},${mid} V${mid + size - radius} Q${left},${mid + size} ${left + radius},${mid + size} H${left + bar - radius} Q${left + bar},${mid + size} ${left + bar},${mid + size - radius} V${mid} Z`;
        return <g key={point.label} onPointerEnter={() => setHover(index)}>
          <rect x={index * slot} y={0} width={slot} height={height} fill="transparent" />
          <path d={d} className={`trading-bar ${point.value >= 0 ? "up" : "down"} ${hover === index ? "hover" : ""}`} />
        </g>;
      })}
    </svg>
  </figure>;
}

// ------------------------------------------------------------------ dialogs

function Modal({ title, eyebrow, subtitle, onClose, children, footer, compact }: { title: string; eyebrow: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; compact?: boolean }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="strategy-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`strategy-modal ${compact ? "compact" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><div><span>{eyebrow}</span><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button onClick={onClose} aria-label="닫기"><X size={16} /></button></header>
      <div className="strategy-modal-scroll">{children}</div>
      {footer && <footer>{footer}</footer>}
    </section>
  </div>;
}

function StartDialog({ mode, book, data, onClose, onConfirm, busy }: { mode: DashboardMode; book: TradingBookId; data: TradingDashboardResponse; onClose: () => void; onConfirm: (confirm: string) => void; busy: boolean }) {
  const [phrase, setPhrase] = useState("");
  const live = mode === "live";
  return <Modal compact eyebrow={live ? "LIVE ORDERS" : "PAPER TRADING"} title={`${MODE_TITLE[mode]} 시작`} subtitle={MODE_SUB[mode]} onClose={onClose}
    footer={<><span>{live ? "실제 돈으로 주문이 나갑니다." : "주문은 나가지 않습니다."}</span><div className="trading-dialog-actions"><button className="ghost" onClick={onClose}>취소</button><button className={live ? "danger" : "primary"} disabled={busy || (live && phrase !== LIVE_CONFIRM)} onClick={() => onConfirm(phrase)}>{busy ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}시작</button></div></>}>
    <dl className="trading-dialog-facts">
      <div><dt>시작 자본</dt><dd>{usd(data.capitalUsd)}</dd></div>
      <div><dt>{BOOK_COPY[book].source}</dt><dd>{data.registeredStrategies}개</dd></div>
      {live && <div><dt>토스 계좌</dt><dd>{data.toss.accountNo ?? "—"}</dd></div>}
      {live && <div><dt>USD 매수가능</dt><dd>{usd(data.toss.buyingPowerUsd)}</dd></div>}
    </dl>
    <ul className="trading-dialog-notes">
      <li>{book === "surge" ? "급등주 규칙은 오늘 관측된 급등락 사건을 보고, 규칙이 정한 봉(1·3·5분)이 완성될 때마다 판단합니다" : "현재 슬롯에 배정된 전략이 자기 봉 주기(1·3·5분)의 완성된 봉을 보고 판단합니다"}. 신호가 나면 다음 봉에 {live ? "지정가(호가 +밴드) 매수 주문을 냅니다" : "토스 현재가로 가상 체결합니다"}. {book === "surge" ? "최대 보유 시간이나 15:55 ET에 청산합니다." : "슬롯이 끝나면 청산합니다."}</li>
      {book === "surge" && <li>이 대시보드는 <strong>급등주 규칙만</strong> 거래합니다. 전략 탭의 슬롯 전략은 여기서 실행되지 않고, 두 계좌의 잔고·기록도 분리돼 있습니다.</li>}
      {data.registeredStrategies === 0 && <li><strong>오늘 거래할 규칙이 0개입니다.</strong> {BOOK_COPY[book].empty}</li>}
      <li>대시보드는 자신이 매수한 수량만 매도합니다. {live ? "계좌의 다른 보유 종목에는 손대지 않습니다." : ""}</li>
      {!data.runner.online && <li>백그라운드 러너가 꺼져 있어 <strong>이 탭이 열려 있는 동안만</strong> 거래합니다. 탭을 닫아도 계속하려면 <code>npm run trader</code>를 실행하세요.</li>}
    </ul>
    {live && <label className="trading-confirm">확인 문구 <b>{LIVE_CONFIRM}</b>를 입력하세요<input value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder={LIVE_CONFIRM} /></label>}
  </Modal>;
}

function StopDialog({ mode, view, onClose, onConfirm, busy }: { mode: DashboardMode; view: TradingDashboardView; onClose: () => void; onConfirm: () => void; busy: boolean }) {
  return <Modal compact eyebrow="STOP" title={`${MODE_TITLE[mode]} 정지`} subtitle="정지는 세 단계로 진행되고, 매도 체결이 확인돼야 끝납니다." onClose={onClose}
    footer={<><span>보유 {view.positions.length}건 · 미체결 주문 {view.orders.length}건</span><div className="trading-dialog-actions"><button className="ghost" onClick={onClose}>취소</button><button className="danger" disabled={busy} onClick={onConfirm}>{busy ? <RefreshCw size={13} className="spin" /> : <CircleStop size={13} />}정지</button></div></>}>
    <ol className="trading-stop-plan">
      <li><b>미체결 매수 취소</b><span>아직 체결되지 않은 매수 주문을 먼저 취소합니다. 취소 전에 일부 체결된 수량은 다음 단계에서 팝니다.</span></li>
      <li><b>대시보드가 매수한 보유 종목 청산</b><span>이 대시보드가 산 수량만 {mode === "live" ? "지정가(호가 −밴드)로" : "현재가로"} 매도합니다.</span></li>
      <li><b>체결 확인 후 정지 완료</b><span>매도가 전부 체결되면 정지됩니다. 장이 닫혀 주문이 거부되면 1분마다 재시도하며 ‘정지 중’으로 남습니다.</span></li>
    </ol>
  </Modal>;
}

type BacktestState =
  | { step: "form"; error: string | null }
  | { step: "running"; log: string[] }
  | { step: "result"; report: RelayBacktestReport };

function BacktestDialog({ mode, onClose }: { mode: DashboardMode; onClose: () => void }) {
  const latest = useMemo(() => yesterdayEt(), []);
  const earliest = useMemo(() => shift(latest, -729), [latest]);
  const [from, setFrom] = useState(() => shift(latest, -29));
  const [to, setTo] = useState(latest);
  const [state, setState] = useState<BacktestState>({ step: "form", error: null });
  const [pdfBusy, setPdfBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const run = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setState({ step: "running", log: ["요청 전송"] });
    try {
      const response = await fetch("/api/relay/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to, dashboard: mode }), signal: controller.signal });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        setState({ step: "form", error: payload.error ?? `백테스트 실패 (HTTP ${response.status})` });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const message = JSON.parse(line) as { type: string; message?: string; report?: RelayBacktestReport };
          if (message.type === "progress") setState((current) => current.step === "running" ? { step: "running", log: [...current.log.slice(-40), message.message ?? ""] } : current);
          if (message.type === "error") { setState({ step: "form", error: message.message ?? "백테스트 실패" }); return; }
          if (message.type === "result" && message.report) { setState({ step: "result", report: message.report }); return; }
        }
        if (done) break;
      }
      setState({ step: "form", error: "결과 없이 연결이 끊겼습니다." });
    } catch (error) {
      if (!controller.signal.aborted) setState({ step: "form", error: error instanceof Error ? error.message : "백테스트 실패" });
    }
  };

  const downloadPdf = async (report: RelayBacktestReport) => {
    setPdfBusy(true);
    try {
      const { generateRelayPdf, reportFilename } = await import("@/lib/relay-report");
      const bytes = await generateRelayPdf(report);
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = reportFilename(report);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "PDF를 만들지 못했습니다.");
    } finally {
      setPdfBusy(false);
    }
  };

  if (state.step === "result") {
    const report = state.report;
    return <Modal eyebrow="BACKTEST RESULT" title="백테스트 결과" subtitle={`${report.requested.from} ~ ${report.requested.to} · 시작 자본 ${usd(report.capitalUsd)} · ${report.interval.replace(/m/g, "분봉")} · 전략 ${report.strategies.length}개`} onClose={onClose}
      footer={<><span>생성 {clock(report.generatedAt)}</span><div className="trading-dialog-actions"><button className="ghost" onClick={() => setState({ step: "form", error: null })}>기간 바꾸기</button><button className="primary" disabled={pdfBusy} onClick={() => downloadPdf(report)}>{pdfBusy ? <RefreshCw size={13} className="spin" /> : <Download size={13} />}PDF 다운로드</button></div></>}>
      <BacktestReportView report={report} />
    </Modal>;
  }

  return <Modal compact eyebrow="BACKTEST" title="백테스트" subtitle={`등록된 전략 전부를 ${MODE_TITLE[mode]}과 같은 $1,000 규칙으로 돌립니다.`} onClose={onClose}
    footer={state.step === "form"
      ? <><span>분봉: Massive · 최근 2년 · 전 거래일까지</span><div className="trading-dialog-actions"><button className="ghost" onClick={onClose}>취소</button><button className="primary" disabled={!from || !to || from > to} onClick={run}><FlaskConical size={13} />실행</button></div></>
      : <><span>처음 받는 달은 Massive 호출 한도(분당 5회)로 기다립니다.</span><div className="trading-dialog-actions"><button className="ghost" onClick={() => { abort.current?.abort(); setState({ step: "form", error: null }); }}>중단</button></div></>}>
    {state.step === "form" ? <>
      <div className="trading-date-fields">
        <label>시작일<input type="date" value={from} min={earliest} max={latest} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>종료일<input type="date" value={to} min={earliest} max={latest} onChange={(event) => setTo(event.target.value)} /></label>
      </div>
      <div className="trading-date-presets">
        {[["1주", 6], ["1개월", 29], ["3개월", 89], ["6개월", 181], ["1년", 364]].map(([label, days]) => <button key={label} onClick={() => { setTo(latest); setFrom(shift(latest, -Number(days))); }}>{label}</button>)}
      </div>
      {state.error && <div className="strategy-warning error inline"><TriangleAlert size={15} /><div><strong>실행하지 못했습니다</strong><p>{state.error}</p></div></div>}
    </> : <div className="trading-progress">
      <RefreshCw size={15} className="spin" />
      <ol>{state.log.map((line, index) => <li key={`${index}-${line}`} className={index === state.log.length - 1 ? "current" : ""}>{line}</li>)}</ol>
    </div>}
  </Modal>;
}

function BacktestReportView({ report }: { report: RelayBacktestReport }) {
  const m = report.metrics;
  return <div className="trading-report">
    <section className="trading-kpis">
      <Kpi label="총 수익" value={usd(report.totals.pnlUsd, true)} tone={tone(report.totals.pnlUsd)} hint={`최종 잔고 ${usd(report.totals.endingEquityUsd)}`} />
      <Kpi label="총 수익률" value={pct(report.totals.returnPct)} tone={tone(report.totals.returnPct)} hint={`일평균 ${pct(m.meanDailyPct, 3)}`} />
      <Kpi label="최대 낙폭 (장중 포함)" value={m.maxDrawdownPct === null ? "—" : `−${m.maxDrawdownPct.toFixed(2)}%`} tone={m.maxDrawdownPct ? "negative" : ""} hint={`종가 기준 −${(m.endOfDayMaxDrawdownPct ?? 0).toFixed(2)}%`} />
      <Kpi label="전략 준수율" value={m.adherencePct === null ? "—" : `${m.adherencePct.toFixed(1)}%`} hint={`신호 ${m.signals} · 체결 ${m.totalTrades} · 미체결 ${m.missedSignals}`} />
      <Kpi label="수익 난 날" value={m.positiveDayPct === null ? "—" : `${m.positiveDayPct.toFixed(1)}%`} hint={`${m.sessions}세션 중 · +1% 이상 ${m.daysAbove1PctShare ?? 0}%`} />
      <Kpi label="최악의 날" value={pct(m.worstDayPct)} tone={tone(m.worstDayPct)} hint={`장중 최저 ${pct(m.worstIntradayPct)}`} />
      <Kpi label="승률" value={m.winRatePct === null ? "—" : `${m.winRatePct.toFixed(1)}%`} hint={`거래 ${m.totalTrades}건`} />
      <Kpi label="거래 비용" value={usd(report.totals.costUsd)} hint="수수료 + 종목별 스프레드" />
    </section>

    {report.warnings.map((warning) => <div key={warning} className="strategy-warning inline"><TriangleAlert size={15} /><div><p>{warning}</p></div></div>)}

    {report.daily.length >= 2 && <div className="trading-charts">
      <EquityChart caption="잔고 추이" base={report.capitalUsd} points={report.daily.map((day) => ({ label: day.date, value: day.endEquityUsd }))} />
      <ReturnBars points={report.daily.map((day) => ({ label: day.date, value: day.returnPct }))} />
    </div>}

    <h3 className="strategy-modal-sub">전략별 수익과 준수</h3>
    {report.strategies.length ? <div className="lab-table-wrap"><table className="lab-table">
      <thead><tr><th>전략</th><th>슬롯</th><th>순손익</th><th>계좌 기여</th><th>승률</th><th>신호</th><th>체결률</th><th>준수율</th><th>이탈</th><th>손절/목표/슬롯종료</th><th>비용</th></tr></thead>
      <tbody>{report.strategies.map((row) => <tr key={row.id}>
        <td><strong>{row.name}</strong><br /><small>{row.universe.join(", ")}</small></td><td>{row.slotLabel}</td>
        <td className={tone(row.pnlUsd)}>{usd(row.pnlUsd, true)}</td><td className={tone(row.contributionPct)}>{pct(row.contributionPct)}</td>
        <td>{row.winRatePct === null ? "—" : `${row.winRatePct.toFixed(1)}%`}</td><td>{row.signals}</td>
        <td>{row.fillRatePct === null ? "—" : `${row.fillRatePct.toFixed(0)}%`}</td>
        <td>{row.adherencePct === null ? "—" : `${row.adherencePct.toFixed(1)}%`}</td>
        <td className={row.deviations ? "negative" : ""} title={row.deviationReasons.map((item) => `${item.reason} ${item.count}건`).join("\n")}>{row.deviations}</td>
        <td>{row.exits.stop} / {row.exits.target} / {row.exits.slot_end}</td><td>{usd(row.costUsd)}</td>
      </tr>)}</tbody>
    </table></div> : <p className="strategy-note">등록된 전략이 없습니다.</p>}
    {report.strategies.some((row) => row.deviationReasons.length) && <ul className="trading-reasons">{report.strategies.filter((row) => row.deviationReasons.length).map((row) => <li key={row.id}><b>{row.name}</b> 이탈 사유: {row.deviationReasons.map((item) => `${item.reason} ${item.count}건`).join(", ")}</li>)}</ul>}

    <h3 className="strategy-modal-sub">날짜별 수익(률)</h3>
    <div className="lab-table-wrap trading-scroll"><table className="lab-table">
      <thead><tr><th>날짜</th><th>시작 잔고</th><th>종료 잔고</th><th>손익</th><th>수익률</th><th>장중 저점</th><th>누적</th><th>거래</th></tr></thead>
      <tbody>{[...report.daily].reverse().map((day) => <tr key={day.date}>
        <td>{day.date}</td><td>{usd(day.startEquityUsd)}</td><td>{usd(day.endEquityUsd)}</td>
        <td className={tone(day.pnlUsd)}>{usd(day.pnlUsd, true)}</td><td className={tone(day.returnPct)}>{pct(day.returnPct)}</td>
        <td className={tone(day.intradayLowPct)}>{pct(day.intradayLowPct)}</td><td className={tone(day.cumulativeReturnPct)}>{pct(day.cumulativeReturnPct)}</td><td>{day.trades}</td>
      </tr>)}</tbody>
    </table></div>

    <h3 className="strategy-modal-sub">거래 기록</h3>
    {report.trades.length ? <div className="lab-table-wrap trading-scroll"><table className="lab-table">
      <thead><tr><th>날짜</th><th>전략</th><th>종목</th><th>신호 → 진입 → 청산 (ET)</th><th>진입가</th><th>청산가</th><th>수량</th><th>손익</th><th>청산</th><th>준수</th></tr></thead>
      <tbody>{[...report.trades].reverse().map((trade, index) => <tr key={`${trade.date}-${trade.strategyId}-${index}`}>
        <td>{trade.date}</td><td>{trade.strategyName}</td><td>{trade.symbol}</td>
        <td>{trade.traded ? `${trade.signalTime} → ${trade.entryTime} → ${trade.exitTime}` : `${trade.signalTime ?? "—"} (미체결)`}</td>
        <td>{trade.entryPrice ?? "—"}</td><td>{trade.exitPrice ?? "—"}</td><td>{trade.quantity}</td>
        <td className={tone(trade.pnlUsd)}>{trade.traded ? usd(trade.pnlUsd, true) : "—"}</td><td>{trade.exit ? EXIT_TEXT[trade.exit] : "—"}</td>
        <td className={trade.ruleCompliant === true ? "positive" : trade.violations.length ? "negative" : ""}>{trade.ruleCompliant === true ? "준수" : trade.violations[0] ?? "—"}</td>
      </tr>)}</tbody>
    </table></div> : <p className="strategy-note">기간 중 신호가 없었습니다.</p>}

    <h3 className="strategy-modal-sub">데이터</h3>
    <ul className="trading-reasons">{report.dataSources.map((source) => <li key={source.symbol}><b>{source.symbol}</b> {source.provider} · {source.bars.toLocaleString()}봉 · {source.firstDate || "—"} ~ {source.lastDate || "—"}{source.fetchedMonths ? ` · 새로 받은 달 ${source.fetchedMonths}` : ""}{source.cachedMonths ? ` · 캐시 ${source.cachedMonths}` : ""}{source.fallbackReason ? ` · ${source.fallbackReason}` : ""}</li>)}</ul>
    <p className="strategy-note">규칙은 각자의 봉 주기로 완성된 봉만 보고 결정하고 다음 봉 시가에 체결됩니다. 진입 봉을 포함해 매 봉 손절·목표를 확인하며, 최대 낙폭은 보유 중 매 봉 저가 기준의 장중 낙폭입니다.</p>
  </div>;
}

function Kpi({ label, value, hint, tone: toneClass = "" }: { label: string; value: string; hint?: string; tone?: string }) {
  return <div className="trading-kpi"><span>{label}</span><b className={toneClass}>{value}</b>{hint && <small>{hint}</small>}</div>;
}

// ---------------------------------------------------------------- dashboard

function DashboardPanel({ view, data, now, busy, book, onStart, onStop, onBacktest }: {
  view: TradingDashboardView; data: TradingDashboardResponse; now: number; busy: boolean; book: TradingBookId;
  onStart: () => void; onStop: () => void; onBacktest: () => void;
}) {
  const today = view.daily.at(-1);
  const phaseIndex = view.stopPhase ? STOP_STEPS.findIndex((step) => step.phase === view.stopPhase) : -1;
  const blocked = view.status === "stopped" && !view.readiness.ready;
  const toss = data.toss;
  return <section className={`trading-panel ${view.mode}`}>
    <header className="trading-panel-head">
      <div>
        <span className={`trading-status ${view.status}`}><i />{STATUS_TEXT[view.status]}{view.status === "stopping" && phaseIndex >= 0 ? ` · ${phaseIndex + 1}/3 ${STOP_STEPS[phaseIndex].label}` : ""}</span>
        <h2>{MODE_TITLE[view.mode]}</h2>
        <p>{MODE_SUB[view.mode]} · {BOOK_COPY[book].source} · 운용 예산 {usd(view.initialCapitalUsd)}{view.startedAt ? ` · 시작 ${clock(view.startedAt)}` : ""}{view.lastTickAt ? ` · 마지막 틱 ${ago(view.lastTickAt, now)}` : ""}</p>
      </div>
      <div className="trading-actions">
        <button className="start" disabled={busy || view.status !== "stopped" || blocked} onClick={onStart} title={blocked ? view.readiness.reasons.join("\n") : undefined}><Play size={14} />시작</button>
        <button className="stop" disabled={busy || view.status !== "running"} onClick={onStop}><CircleStop size={14} />정지</button>
        {BOOK_COPY[book].backtest && <button className="backtest" disabled={busy} onClick={onBacktest}><FlaskConical size={14} />백테스트</button>}
      </div>
    </header>

    {view.mode === "live" && <div className="strategy-account">
      <span><i className={toss.ready ? "" : "off"} />토스 계좌 <strong>{view.brokerBalance?.accountNo ?? toss.accountNo ?? "—"}</strong></span>
      <span>토스 실제 USD 주문 가능 <strong>{usd(toss.buyingPowerUsd)}</strong></span>
      <span>계좌 보유 평가액 <strong>{usd(view.brokerBalance?.holdingsValueUsd)}</strong></span>
      <span>잔고 조회 <strong>{view.brokerBalance ? ago(view.brokerBalance.fetchedAt, now) : toss.ready ? "실행 시 1분마다" : "—"}</strong></span>
      {view.brokerBalance?.error && <span className="negative">조회 오류: {view.brokerBalance.error}</span>}
    </div>}

    {view.status === "stopped" && view.readiness.reasons.length > 0 && <div className="strategy-warning">
      <TriangleAlert size={15} />
      <div><strong>지금은 시작할 수 없습니다</strong>{view.readiness.reasons.map((reason) => <p key={reason}>{reason}</p>)}{view.mode === "live" && toss.egressIp && <p className="strategy-egress">토스에 접속한 서버 IP: <code>{toss.egressIp}</code> — WTS &gt; 설정 &gt; Open API &gt; 허용 IP에 등록하세요.</p>}</div>
    </div>}
    {data.registeredStrategies === 0 && <div className="strategy-warning">
      <TriangleAlert size={15} />
      <div><strong>오늘 거래할 {BOOK_COPY[book].source} 0개</strong><p>{BOOK_COPY[book].empty}</p></div>
    </div>}
    {view.lastError && view.status !== "stopped" && <div className="strategy-warning error"><TriangleAlert size={15} /><div><strong>최근 오류</strong><p>{view.lastError}</p></div></div>}

    {view.status === "stopping" && <ol className="trading-stepper">
      {STOP_STEPS.map((step, index) => <li key={step.phase} className={index < phaseIndex ? "done" : index === phaseIndex ? "current" : ""}><b>{index + 1}</b>{step.label}</li>)}
    </ol>}

    <section className="trading-kpis">
      <Kpi label="전략 운용자산" value={usd(view.equityUsd)} hint={`현금 ${usd(view.cashUsd)} · 보유 ${usd(view.positionsValueUsd)}`} />
      <Kpi label="총 수익" value={usd(view.totalPnlUsd, true)} tone={tone(view.totalPnlUsd)} hint={pct(view.totalReturnPct)} />
      <Kpi label="오늘 수익률" value={today ? pct(today.returnPct) : "—"} tone={tone(today?.returnPct)} hint={today ? `${today.date} · ${usd(today.pnlUsd, true)}` : "거래일 기록 없음"} />
      <Kpi label="실현 / 미실현" value={usd(view.realizedPnlUsd, true)} tone={tone(view.realizedPnlUsd)} hint={`미실현 ${usd(view.unrealizedPnlUsd, true)}`} />
      <Kpi label="최대 낙폭" value={view.maxDrawdownPct ? `−${view.maxDrawdownPct.toFixed(2)}%` : "0.00%"} tone={view.maxDrawdownPct ? "negative" : ""} hint="장중 틱 기준" />
      <Kpi label="전략 준수율" value={view.adherencePct === null ? "—" : `${view.adherencePct.toFixed(1)}%`} hint={`신호 ${view.signals} · 미체결 ${view.missedSignals}`} />
      <Kpi label={view.mode === "live" ? "수수료" : "수수료·스프레드"} value={usd(view.commissionUsd)} />
      <Kpi label="보유 / 주문" value={`${view.positions.length} / ${view.orders.length}`} hint={data.runner.online ? `러너 온라인 · ${ago(data.runner.lastHeartbeatAt, now)}` : "러너 오프라인 · 탭이 틱 구동"} />
    </section>

    {view.daily.length >= 2 ? <div className="trading-charts">
      <EquityChart caption="전략 운용자산 추이 (날짜별)" base={view.initialCapitalUsd} points={view.daily.map((day) => ({ label: day.date, value: day.equityUsd }))} />
      <ReturnBars points={view.daily.map((day) => ({ label: day.date, value: day.returnPct }))} />
    </div> : <p className="trading-chart-empty">거래일이 이틀 이상 쌓이면 총자산 추이와 날짜별 수익률 차트를 그립니다.</p>}

    <div className="trading-grid">
      <section>
        <h3>전략별 수익</h3>
        {view.strategies.length ? <div className="lab-table-wrap"><table className="lab-table">
          <thead><tr><th>전략</th><th>슬롯</th><th>신호</th><th>체결</th><th>미체결</th><th>준수율</th><th>이탈</th><th>승률</th><th>손익</th><th>기여</th></tr></thead>
          <tbody>{view.strategies.map((row) => <tr key={row.id}>
            <td><strong>{row.name}</strong>{!row.registered && <small> (해제됨)</small>}</td><td>{row.slotLabel}</td>
            <td>{row.signals}</td><td>{row.entries}</td><td className={row.missed ? "negative" : ""}>{row.missed}</td>
            <td>{row.adherencePct === null ? "—" : `${row.adherencePct.toFixed(1)}%`}</td><td className={row.deviations ? "negative" : ""}>{row.deviations}</td>
            <td>{row.closed ? `${((row.wins / row.closed) * 100).toFixed(0)}%` : "—"}</td>
            <td className={tone(row.pnlUsd)}>{usd(row.pnlUsd, true)}</td><td className={tone(row.contributionPct)}>{pct(row.contributionPct)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="strategy-note">등록된 전략이 없어 표시할 전략별 수익이 없습니다.</p>}
      </section>

      <section>
        <h3>날짜별 수익(률)</h3>
        {view.daily.length ? <div className="lab-table-wrap trading-scroll"><table className="lab-table">
          <thead><tr><th>날짜 (ET)</th><th>시작</th><th>종료</th><th>손익</th><th>수익률</th><th>거래</th></tr></thead>
          <tbody>{[...view.daily].reverse().map((day) => <tr key={day.date}>
            <td>{day.date}</td><td>{usd(day.startEquityUsd)}</td><td>{usd(day.equityUsd)}</td>
            <td className={tone(day.pnlUsd)}>{usd(day.pnlUsd, true)}</td><td className={tone(day.returnPct)}>{pct(day.returnPct)}</td><td>{day.trades}</td>
          </tr>)}</tbody>
        </table></div> : <p className="strategy-note">실행하면 거래일마다 한 줄씩 기록됩니다.</p>}
      </section>
    </div>

    {(view.positions.length > 0 || view.orders.length > 0) && <section className="trading-section">
      <h3>보유 종목과 미체결 주문</h3>
      <div className="lab-table-wrap"><table className="lab-table">
        <thead><tr><th>구분</th><th>전략</th><th>종목</th><th>수량</th><th>가격</th><th>현재가 / 지정가</th><th>손절 / 목표</th><th>상태</th></tr></thead>
        <tbody>
          {view.positions.map((trade) => <tr key={trade.id}>
            <td>보유</td><td>{trade.strategyName}</td><td><strong>{trade.symbol}</strong></td><td>{trade.boughtQuantity - trade.soldQuantity}</td>
            <td>{trade.entryPrice?.toFixed(2) ?? "—"}</td><td>{trade.markPrice?.toFixed(2) ?? "—"}</td>
            <td>−{trade.stopPct}% / {trade.targetPct === null ? "시간 청산" : `+${trade.targetPct}%`}</td>
            <td>{trade.pendingExit ? `${EXIT_TEXT[trade.pendingExit]} 매도 중` : trade.status === "entering" ? "진입 중" : `~${new Date(trade.slotEndsAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })} 청산`}</td>
          </tr>)}
          {view.orders.map((order) => <tr key={order.id}>
            <td>{order.side === "buy" ? "매수 주문" : "매도 주문"}</td><td>{order.purpose === "entry" ? "진입" : EXIT_TEXT[order.purpose]}</td><td><strong>{order.symbol}</strong></td>
            <td>{order.filledQuantity}/{order.quantity}</td><td>{order.averageFillPrice?.toFixed(2) ?? "—"}</td><td>{order.limitPrice ?? "—"}</td><td>—</td>
            <td>{order.status === "cancel_requested" ? "취소 요청됨" : order.status === "submitting" ? "응답 대기" : "체결 대기"} · {ago(order.submittedAt, now)}</td>
          </tr>)}
        </tbody>
      </table></div>
    </section>}

    <section className="trading-section">
      <h3>거래 기록 · 전략대로 거래했는가</h3>
      {view.trades.length ? <div className="lab-table-wrap trading-scroll"><table className="lab-table">
        <thead><tr><th>날짜</th><th>전략</th><th>종목</th><th>신호봉</th><th>진입</th><th>청산</th><th>수량</th><th>손익</th><th>진입 괴리</th><th>준수</th></tr></thead>
        <tbody>{view.trades.map((trade: DashboardTrade) => <tr key={trade.id}>
          <td>{trade.date}</td><td>{trade.strategyName}</td><td><strong>{trade.symbol}</strong></td><td>{trade.signalTime}</td>
          <td>{trade.entryPrice ? `${trade.entryPrice.toFixed(2)} · ${clock(trade.entryAt)}` : "—"}</td>
          <td>{trade.exitPrice ? `${trade.exitPrice.toFixed(2)} · ${trade.exit ? EXIT_TEXT[trade.exit] : ""}` : "—"}</td>
          <td>{trade.boughtQuantity}</td>
          <td className={tone(trade.pnlUsd)}>{trade.pnlUsd === null ? "—" : usd(trade.pnlUsd, true)}</td>
          <td>{trade.entrySlippagePct === null ? "—" : pct(trade.entrySlippagePct, 3)}</td>
          <td className={trade.compliant ? "positive" : "negative"} title={trade.violations.join("\n")}>{trade.status === "missed" ? `미체결 — ${trade.violations[0]?.replace("신호 미체결: ", "") ?? ""}` : trade.compliant ? "준수" : trade.violations.join(" · ")}</td>
        </tr>)}</tbody>
      </table></div> : <p className="strategy-note">아직 거래가 없습니다. 준수 기준: 기준가 대비 진입가 괴리, 전략 봉 한 개(1·3·5분) 안 진입, 손절폭 초과 손실 없음, 청산 시각 후 2분 안 청산.</p>}
    </section>

    <details className="trading-log">
      <summary>실행 로그 {view.events.length}건</summary>
      <ol>{view.events.map((item, index) => <li key={`${item.at}-${index}`} className={item.kind}><time>{clock(item.at)}</time><span>{item.message}</span></li>)}</ol>
      {view.previousRuns.length > 0 && <p className="strategy-note">이전 실행: {view.previousRuns.map((run) => `${clock(run.startedAt)} ~ ${clock(run.stoppedAt)} ${pct(run.returnPct)} (${run.trades}건)`).join(" · ")}</p>}
    </details>
  </section>;
}

/**
 * `relay` is the 전략 board's slot book; `surge` is 투자 › 급등주.
 *
 * The two share this component because they share an engine, and they are
 * deliberately not given the same controls. The surge book has no backtest
 * button: its evidence is produced once, inside generation, over a window the
 * user never picks — offering a second ad-hoc backtest here would invite the
 * question the whole split exists to prevent, which is "whose strategy did that
 * number come from?"
 */
export type TradingBookId = "relay" | "surge";

const BOOK_COPY: Record<TradingBookId, { source: string; empty: string; backtest: boolean }> = {
  relay: {
    source: "전략 탭의 슬롯 전략",
    empty: "위의 ‘전략 연구’에서 검증된 후보를 비교하고 슬롯에 배정하세요. 실행을 시작할 때 등록된 전략으로 거래합니다.",
    backtest: true,
  },
  surge: {
    source: "급등주 규칙",
    empty: "위에서 급등주 전략을 생성하세요. 이 대시보드는 급등주 규칙만 거래하고, 전략 탭의 슬롯 전략은 쓰지 않습니다.",
    backtest: false,
  },
};

export function TradingDashboards({ book = "relay" }: { book?: TradingBookId } = {}) {
  const [data, setData] = useState<TradingDashboardResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<DashboardMode>("live");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "start" | "stop" | "backtest">(null);
  const [now, setNow] = useState(() => Date.now());
  const ticking = useRef(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/trading?book=${book}`, { cache: "no-store" });
      const payload = await response.json() as TradingDashboardResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setData(payload);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "대시보드를 불러오지 못했습니다.");
    }
  }, [book]);

  const active = data ? (["live", "paper"] as const).some((item) => data.dashboards[item].status !== "stopped") : false;

  useEffect(() => {
    queueMicrotask(() => { void load(); });
    const poll = setInterval(() => { void load(); setNow(Date.now()); }, POLL_MS);
    return () => clearInterval(poll);
  }, [load]);

  // While a dashboard runs, this tab drives ticks too. The server skips a tick
  // that lands within seconds of the background runner's, so both can run.
  useEffect(() => {
    if (!active) return;
    const tick = async () => {
      if (ticking.current) return;
      ticking.current = true;
      try {
        const response = await fetch("/api/trading", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "tick" }) });
        if (response.ok) setData(await response.json() as TradingDashboardResponse);
      } catch {
        // the next poll shows the state either way
      } finally {
        ticking.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  const act = async (action: "start" | "stop", confirm?: string) => {
    setBusy(true);
    setActionError(null);
    try {
      const response = await fetch("/api/trading", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, mode, confirm, book }) });
      const payload = await response.json() as TradingDashboardResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setData(payload);
      setDialog(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "요청 실패");
      setDialog(null);
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return <section className="trading-dashboards">
      {loadError ? <div className="strategy-warning error"><TriangleAlert size={15} /><div><strong>트레이딩 대시보드를 불러오지 못했습니다</strong><p>{loadError}</p></div></div>
        : <div className="research-empty"><RefreshCw size={16} className="spin" /><strong>대시보드 불러오는 중</strong></div>}
    </section>;
  }

  const view = data.dashboards[mode];
  return <section className="trading-dashboards">
    <div className="trading-tabs" role="tablist" aria-label="트레이딩 대시보드">
      {(["live", "paper"] as const).map((item) => {
        const dashboard = data.dashboards[item];
        return <button key={item} role="tab" aria-selected={mode === item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>
          <span className={`trading-status ${dashboard.status}`}><i /></span>
          <b>{MODE_TITLE[item]}</b>
          <small className={tone(dashboard.totalPnlUsd)}>{usd(dashboard.equityUsd)} · {pct(dashboard.totalReturnPct)}</small>
        </button>;
      })}
      <span className={`trading-runner ${data.runner.online ? "online" : ""}`} title="npm run trader 로 실행하면 탭을 닫아도 틱이 돕니다">
        <i />{data.runner.online ? `백그라운드 러너 온라인 · ${data.runner.intervalSeconds}초 간격` : active ? "러너 오프라인 · 이 탭이 거래를 구동 중" : "러너 오프라인"}
      </span>
    </div>

    {actionError && <div className="strategy-warning error"><TriangleAlert size={15} /><div><strong>요청이 거절됐습니다</strong><p>{actionError}</p></div></div>}

    <DashboardPanel view={view} data={data} now={now} busy={busy} book={book}
      onStart={() => setDialog("start")} onStop={() => setDialog("stop")} onBacktest={() => setDialog("backtest")} />

    {dialog === "start" && <StartDialog mode={mode} book={book} data={data} busy={busy} onClose={() => setDialog(null)} onConfirm={(confirm) => act("start", confirm)} />}
    {dialog === "stop" && <StopDialog mode={mode} view={view} busy={busy} onClose={() => setDialog(null)} onConfirm={() => act("stop")} />}
    {dialog === "backtest" && BOOK_COPY[book].backtest && <BacktestDialog mode={mode} onClose={() => setDialog(null)} />}
  </section>;
}
