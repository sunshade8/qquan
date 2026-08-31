"use client";

import CalendarDays from "lucide-react/dist/esm/icons/calendar-days";
import ChartCandlestick from "lucide-react/dist/esm/icons/chart-candlestick";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Database from "lucide-react/dist/esm/icons/database";
import FileUp from "lucide-react/dist/esm/icons/file-up";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import HistoryIcon from "lucide-react/dist/esm/icons/history";
import PanelRight from "lucide-react/dist/esm/icons/panel-right";
import Play from "lucide-react/dist/esm/icons/play";
import Newspaper from "lucide-react/dist/esm/icons/newspaper";
import Send from "lucide-react/dist/esm/icons/send";
import Settings from "lucide-react/dist/esm/icons/settings";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { TradingViewChart } from "./tradingview-chart";
import { MarketCalendar } from "./market-calendar";
import { MarketNews } from "./market-news";

type View = "market" | "backtest" | "calendar" | "news" | "settings";
type DataTab = "rows" | "study" | "hypothesis";
type Feature = "return1d" | "gap" | "range" | "volume20";
type Operator = "gt" | "lt";

type PriceRow = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ProviderReport = {
  primary: "toss" | "yahoo";
  toss: { status: "connected" | "unavailable" | "not_configured"; bars?: number; start?: string; end?: string; reason?: string };
  yahoo: { status: "connected" | "unavailable"; bars?: number; start?: string; end?: string; reason?: string };
  validation: { overlap: number; latestDate: string | null; latestCloseDeltaPct: number | null } | null;
};

type BrokerSnapshot = {
  available: boolean;
  provider: "Toss Securities";
  symbol: string;
  price?: number;
  timestamp?: string;
  currency?: string;
  bid?: number | null;
  ask?: number | null;
  spreadPct?: number | null;
  recentTrades?: Array<{ price: number; volume: number; timestamp: string }>;
  session?: { code: "day" | "pre" | "regular" | "after" | "closed"; label: string; nextOpen?: string };
  reason?: string;
  code?: string;
};

type StudyResult = {
  occurrences: number;
  positiveRate: number;
  average: number;
  median: number;
  best: number;
  worst: number;
};

type ChatMessage = { id: string; role: "user" | "agent"; text: string; symbol: string; createdAt: string };
type WorkspaceHistoryItem = { id: string; kind: "chat" | "news"; title: string; detail: string; context: string; createdAt: string };
type MarketSession = { code: "pre" | "regular" | "after" | "closed"; label: string; time: string; zone: string; schedule: string };

const CHAT_STORAGE_KEY = "qquant.chat.v1";
const HISTORY_STORAGE_KEY = "qquant.history.v1";

const symbols = [
  { label: "NVDA", value: "NASDAQ:NVDA" },
  { label: "AAPL", value: "NASDAQ:AAPL" },
  { label: "MSFT", value: "NASDAQ:MSFT" },
  { label: "AMZN", value: "NASDAQ:AMZN" },
  { label: "META", value: "NASDAQ:META" },
  { label: "SPY", value: "AMEX:SPY" },
];

const intervals = [
  { label: "15m", value: "15" },
  { label: "1H", value: "60" },
  { label: "1D", value: "D" },
  { label: "1W", value: "W" },
];

const featureLabels: Record<Feature, string> = {
  return1d: "일간 수익률 (%)",
  gap: "시가 갭 (%)",
  range: "일중 변동폭 (%)",
  volume20: "20일 평균 대비 거래량 (배)",
};

const chartIndicators = [
  { id: "RSI@tv-basicstudies", label: "RSI", aliases: ["rsi", "상대강도"] },
  { id: "MACD@tv-basicstudies", label: "MACD", aliases: ["macd"] },
  { id: "BB@tv-basicstudies", label: "Bollinger Bands", aliases: ["bollinger", "볼린저", "bb"] },
  { id: "MASimple@tv-basicstudies", label: "SMA", aliases: ["sma", "단순이동평균", "단순 이동평균"] },
  { id: "MAExp@tv-basicstudies", label: "EMA", aliases: ["ema", "지수이동평균", "지수 이동평균"] },
  { id: "Volume@tv-basicstudies", label: "Volume", aliases: ["volume", "거래량"] },
  { id: "VWAP@tv-basicstudies", label: "VWAP", aliases: ["vwap"] },
  { id: "StochasticRSI@tv-basicstudies", label: "Stochastic RSI", aliases: ["stochastic rsi", "스토캐스틱 rsi", "스토캐스틱"] },
  { id: "ROC@tv-basicstudies", label: "ROC", aliases: ["roc", "변화율"] },
];

function parseChartCommand(text: string) {
  const normalized = text.toLowerCase();
  const matched = chartIndicators.filter((indicator) => indicator.aliases.some((alias) => normalized.includes(alias)));
  const remove = /제거|삭제|지워|빼줘|remove|delete|clear/.test(normalized);
  const add = /추가|띄워|보여|적용|넣어|add|show|apply/.test(normalized);
  const clearAll = remove && /전부|모두|다 |all/.test(normalized);
  if (clearAll) return { action: "clear" as const, indicators: chartIndicators };
  if (!matched.length || (!add && !remove)) return null;
  return { action: remove ? "remove" as const : "add" as const, indicators: matched };
}

function parseNumber(value: string) {
  const number = Number(value.replaceAll(",", "").trim());
  return Number.isFinite(number) ? number : NaN;
}

function parseCsv(text: string): PriceRow[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((header) => header.trim().toLowerCase().replaceAll(/[^a-z]/g, ""));
  const index = (names: string[]) => headers.findIndex((header) => names.includes(header));
  const columns = {
    date: index(["date", "datetime", "timestamp"]),
    open: index(["open"]),
    high: index(["high"]),
    low: index(["low"]),
    close: index(["close", "adjclose", "adjustedclose"]),
    volume: index(["volume", "vol"]),
  };
  if (Object.values(columns).some((column) => column < 0)) return [];

  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return {
      date: cells[columns.date]?.trim() ?? "",
      open: parseNumber(cells[columns.open] ?? ""),
      high: parseNumber(cells[columns.high] ?? ""),
      low: parseNumber(cells[columns.low] ?? ""),
      close: parseNumber(cells[columns.close] ?? ""),
      volume: parseNumber(cells[columns.volume] ?? ""),
    };
  }).filter((row) => row.date && Object.values(row).slice(1).every((value) => Number.isFinite(value)))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function valueForFeature(rows: PriceRow[], index: number, feature: Feature) {
  const row = rows[index];
  const previous = rows[index - 1];
  if (!previous) return null;
  if (feature === "return1d") return ((row.close / previous.close) - 1) * 100;
  if (feature === "gap") return ((row.open / previous.close) - 1) * 100;
  if (feature === "range") return ((row.high - row.low) / row.open) * 100;
  if (index < 20) return null;
  const averageVolume = rows.slice(index - 20, index).reduce((sum, item) => sum + item.volume, 0) / 20;
  return averageVolume ? row.volume / averageVolume : null;
}

function runEventStudy(rows: PriceRow[], feature: Feature, operator: Operator, threshold: number, horizon: number): StudyResult | null {
  const returns: number[] = [];
  for (let index = 1; index < rows.length - horizon; index += 1) {
    const value = valueForFeature(rows, index, feature);
    if (value === null) continue;
    const match = operator === "gt" ? value > threshold : value < threshold;
    if (match) returns.push(((rows[index + horizon].close / rows[index].close) - 1) * 100);
  }
  if (!returns.length) return null;
  return {
    occurrences: returns.length,
    positiveRate: returns.filter((value) => value > 0).length / returns.length,
    average: returns.reduce((sum, value) => sum + value, 0) / returns.length,
    median: median(returns),
    best: Math.max(...returns),
    worst: Math.min(...returns),
  };
}

function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function itemId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveMarketSession(now = new Date()): MarketSession {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = read("weekday");
  const hour = Number(read("hour")) % 24;
  const minute = Number(read("minute"));
  const minutes = hour * 60 + minute;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const zone = read("timeZoneName");
  const businessDay = !["Sat", "Sun"].includes(weekday);

  if (businessDay && minutes >= 240 && minutes < 570) return { code: "pre", label: "프리마켓", time, zone, schedule: "04:00–09:30 ET" };
  if (businessDay && minutes >= 570 && minutes < 960) return { code: "regular", label: "정규장", time, zone, schedule: "09:30–16:00 ET" };
  if (businessDay && minutes >= 960 && minutes < 1200) return { code: "after", label: "애프터마켓", time, zone, schedule: "16:00–20:00 ET" };
  return { code: "closed", label: "장 마감", time, zone, schedule: businessDay && minutes < 240 ? "프리마켓 04:00 ET" : "다음 거래일 04:00 ET" };
}

export function QuantWorkspace() {
  const [view, setView] = useState<View>("market");
  const [symbol, setSymbol] = useState("NASDAQ:NVDA");
  const [symbolDraft, setSymbolDraft] = useState("NASDAQ:NVDA");
  const [interval, setInterval] = useState("D");
  const [dataTab, setDataTab] = useState<DataTab>("rows");
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [datasetName, setDatasetName] = useState("");
  const [dataSource, setDataSource] = useState("");
  const [providers, setProviders] = useState<ProviderReport | null>(null);
  const [brokerSnapshot, setBrokerSnapshot] = useState<BrokerSnapshot | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [importError, setImportError] = useState("");
  const [feature, setFeature] = useState<Feature>("return1d");
  const [operator, setOperator] = useState<Operator>("gt");
  const [threshold, setThreshold] = useState(3);
  const [horizon, setHorizon] = useState(5);
  const [study, setStudy] = useState<StudyResult | null>(null);
  const [studyRan, setStudyRan] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<WorkspaceHistoryItem[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [marketSession, setMarketSession] = useState(resolveMarketSession);
  const [hypothesis, setHypothesis] = useState("");
  const [agentOpen, setAgentOpen] = useState(true);
  const [studies, setStudies] = useState<string[]>([]);

  useEffect(() => {
    let savedMessages: ChatMessage[] = [];
    let savedHistory: WorkspaceHistoryItem[] = [];
    try {
      const parsedMessages = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? "[]") as unknown;
      const parsedHistory = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) ?? "[]") as unknown;
      if (Array.isArray(parsedMessages)) savedMessages = parsedMessages.filter((item): item is ChatMessage => Boolean(item && typeof item === "object" && "text" in item && "role" in item));
      if (Array.isArray(parsedHistory)) savedHistory = parsedHistory.filter((item): item is WorkspaceHistoryItem => Boolean(item && typeof item === "object" && "detail" in item && "createdAt" in item));
    } catch {
      savedMessages = [];
      savedHistory = [];
    }
    queueMicrotask(() => {
      setMessages(savedMessages.slice(-200));
      setHistory(savedHistory.slice(-300));
      setHistoryReady(true);
    });
  }, []);

  useEffect(() => {
    if (!historyReady) return;
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-200)));
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(-300)));
    } catch {
      // Storage may be unavailable in private browsing or when the quota is full.
    }
  }, [history, historyReady, messages]);

  useEffect(() => {
    const timer = window.setInterval(() => setMarketSession(resolveMarketSession()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const ticker = symbol.split(":").at(-1) ?? symbol;
    fetch(`/api/market/history?symbol=${encodeURIComponent(ticker)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { rows?: PriceRow[]; source?: string; providers?: ProviderReport; error?: string };
        if (!response.ok || !data.rows?.length) throw new Error(data.error || "가격 데이터를 가져오지 못했습니다.");
        setRows(data.rows);
        setDatasetName(`${ticker} · 10Y daily`);
        setDataSource(data.source ?? "Market data");
        setProviders(data.providers ?? null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRows([]);
        setDatasetName("");
        setDataSource("");
        setProviders(null);
        setImportError(error instanceof Error ? error.message : "가격 데이터를 가져오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingData(false);
      });
    fetch(`/api/market/snapshot?symbol=${encodeURIComponent(ticker)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as BrokerSnapshot & { error?: string };
        if (!response.ok) throw new Error(data.error || "토스 현재가를 가져오지 못했습니다.");
        setBrokerSnapshot(data);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setBrokerSnapshot({ available: false, provider: "Toss Securities", symbol: ticker, reason: error instanceof Error ? error.message : "토스 현재가를 가져오지 못했습니다." });
      });
    return () => controller.abort();
  }, [symbol]);

  const profile = useMemo(() => {
    if (rows.length < 2) return null;
    const changes = rows.slice(1).map((row, index) => ((row.close / rows[index].close) - 1) * 100);
    const averageVolume = rows.reduce((sum, row) => sum + row.volume, 0) / rows.length;
    return {
      start: rows[0].date,
      end: rows.at(-1)?.date ?? "",
      change: ((rows.at(-1)!.close / rows[0].close) - 1) * 100,
      upDays: changes.filter((value) => value > 0).length / changes.length,
      averageVolume,
    };
  }, [rows]);

  function recordHistory(kind: WorkspaceHistoryItem["kind"], title: string, detail: string, context = symbol) {
    const entry: WorkspaceHistoryItem = { id: itemId(kind), kind, title, detail, context, createdAt: new Date().toISOString() };
    setHistory((current) => [...current, entry].slice(-300));
  }

  function appendMessage(role: ChatMessage["role"], text: string) {
    const message: ChatMessage = { id: itemId(role), role, text, symbol, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, message].slice(-200));
    recordHistory("chat", role === "user" ? "질문" : "Agent 응답", text, symbol);
  }

  function selectSymbol(next: string) {
    setSymbol(next);
    setSymbolDraft(next);
    setRows([]);
    setDatasetName("");
    setDataSource("");
    setProviders(null);
    setBrokerSnapshot(null);
    setLoadingData(true);
    setImportError("");
    setStudy(null);
    setStudyRan(false);
  }

  function submitSymbol(event: FormEvent) {
    event.preventDefault();
    const next = symbolDraft.trim().toUpperCase();
    if (!next) return;
    selectSymbol(next.includes(":") ? next : `NASDAQ:${next}`);
  }

  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = parseCsv(await file.text());
    if (parsed.length < 30) {
      setImportError("date, open, high, low, close, volume 열과 최소 30개 행이 필요합니다.");
      return;
    }
    setRows(parsed);
    setDatasetName(file.name);
    setDataSource("Imported CSV");
    setProviders(null);
    setImportError("");
    setStudy(null);
    setStudyRan(false);
    event.target.value = "";
  }

  function executeStudy() {
    setStudy(runEventStudy(rows, feature, operator, threshold, horizon));
    setStudyRan(true);
  }

  async function askAgent(event: FormEvent) {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt || asking) return;
    appendMessage("user", prompt);
    setQuestion("");

    const chartCommand = parseChartCommand(prompt);
    if (chartCommand) {
      if (chartCommand.action === "clear") setStudies([]);
      if (chartCommand.action === "add") setStudies((current) => [...new Set([...current, ...chartCommand.indicators.map((item) => item.id)])]);
      if (chartCommand.action === "remove") setStudies((current) => current.filter((id) => !chartCommand.indicators.some((item) => item.id === id)));
      const names = chartCommand.indicators.map((item) => item.label).join(", ");
      const reply = chartCommand.action === "clear" ? "차트의 보조지표를 모두 제거했습니다." : chartCommand.action === "add" ? `${names}를 차트에 추가했습니다.` : `${names}를 차트에서 제거했습니다.`;
      appendMessage("agent", `${reply} 무료 위젯을 새 설정으로 다시 불러옵니다.`);
      return;
    }

    if (!rows.length) {
      appendMessage("agent", "분석 데이터가 아직 없습니다. 자동 수집이 끝난 뒤 다시 물어보세요.");
      return;
    }
    setAsking(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol,
          question: prompt,
          dataset: {
            name: datasetName,
            profile,
            rows: rows.slice(-400),
            providers,
            brokerSnapshot,
            study: study ? { feature: featureLabels[feature], operator, threshold, horizon, result: study } : null,
          },
        }),
      });
      const data = await response.json() as { answer?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "Agent unavailable");
      appendMessage("agent", data.answer ?? "응답이 비어 있습니다.");
    } catch (error) {
      appendMessage("agent", error instanceof Error ? error.message : "에이전트 연결에 실패했습니다.");
    } finally {
      setAsking(false);
    }
  }

  const navItems = [
    { id: "market" as View, label: "Market", icon: ChartCandlestick },
    { id: "backtest" as View, label: "Backtest", icon: FlaskConical },
    { id: "calendar" as View, label: "Calendar", icon: CalendarDays },
    { id: "news" as View, label: "News", icon: Newspaper },
    { id: "settings" as View, label: "Settings", icon: Settings },
  ];

  return (
    <main className="terminal-shell">
      <aside className="rail" aria-label="Primary navigation">
        <button className="rail-brand" aria-label="QQuant market" onClick={() => setView("market")}>Q</button>
        <nav>
          {navItems.map((item) => (
            <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)} aria-label={item.label} title={item.label}>
              <item.icon size={19} strokeWidth={1.8} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="terminal-main">
        <header className="command-bar">
          <form className="symbol-search" onSubmit={submitSymbol}>
            <label htmlFor="symbol-input">Symbol</label>
            <input id="symbol-input" value={symbolDraft} onChange={(event) => setSymbolDraft(event.target.value)} spellCheck={false} />
          </form>
          <div className="watchlist" aria-label="Watchlist">
            {symbols.map((item) => <button key={item.value} className={symbol === item.value ? "active" : ""} onClick={() => selectSymbol(item.value)}>{item.label}</button>)}
          </div>
          <div className="command-tools">
            <button className="history-toggle" onClick={() => setHistoryOpen(true)} aria-label={`Agent history ${history.length} items`}><HistoryIcon size={13} /><span>History</span>{history.length > 0 && <b>{history.length}</b>}</button>
            <div className={`market-session ${marketSession.code}`} title={`America/New_York · ${marketSession.schedule} · DST 자동 반영`}>
              <i /><div><strong>{marketSession.label}</strong><small>{marketSession.time} {marketSession.zone}</small></div>
            </div>
            <div className="connection-state"><span className="live-dot" />TradingView · {brokerSnapshot?.available ? "Toss" : "Yahoo"}{providers?.yahoo.status === "connected" ? " · Yahoo" : ""}</div>
          </div>
        </header>

        {historyOpen && (
          <aside className="history-drawer" aria-label="Agent history">
            <header><div><span className="agent-mark"><HistoryIcon size={15} /></span><div><strong>Agent History</strong><small>이 브라우저에 자동 저장</small></div></div><button aria-label="Close history" onClick={() => setHistoryOpen(false)}><X size={15} /></button></header>
            <div className="history-list">
              {!history.length && <div className="history-empty"><HistoryIcon size={20} /><strong>아직 기록이 없습니다.</strong><p>질문, Agent 응답, 뉴스 수집과 분석 내역이 여기에 남습니다.</p></div>}
              {[...history].reverse().map((item) => <article key={item.id} className={item.kind}><div><span>{item.title}</span><time>{new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.createdAt))}</time></div><strong>{item.context}</strong><p>{item.detail}</p></article>)}
            </div>
            {history.length > 0 && <footer><span>{history.length}개 기록</span><button onClick={() => { setHistory([]); setMessages([]); }}>기록 지우기</button></footer>}
          </aside>
        )}

        {view === "market" && (
          <div className={`market-layout ${agentOpen ? "" : "agent-closed"}`}>
            <section className="market-stack">
              <article className="chart-surface">
                <div className="chart-toolbar">
                  <div><strong>{symbol}</strong><span>{brokerSnapshot?.available && brokerSnapshot.price !== undefined ? `${brokerSnapshot.currency ?? "USD"} ${brokerSnapshot.price.toLocaleString("en-US", { maximumFractionDigits: 4 })} · ${brokerSnapshot.session?.label ?? "Toss"}${studies.length ? ` · ${studies.length} studies` : ""}` : `${studies.length ? `${studies.length} studies · ` : ""}TradingView`}</span></div>
                  <div className="intervals" aria-label="Chart interval">
                    {intervals.map((item) => <button key={item.value} className={interval === item.value ? "active" : ""} onClick={() => setInterval(item.value)}>{item.label}</button>)}
                  </div>
                  <button className="square-button" aria-label={agentOpen ? "Hide agent" : "Show agent"} onClick={() => setAgentOpen((current) => !current)}><PanelRight size={17} /></button>
                </div>
                <div className="chart-body"><TradingViewChart symbol={symbol} interval={interval} studies={studies} /></div>
              </article>

              <article className="data-dock">
                <div className="dock-tabs">
                  <div role="tablist" aria-label="Research data">
                    <button role="tab" aria-selected={dataTab === "rows"} className={dataTab === "rows" ? "active" : ""} onClick={() => setDataTab("rows")}>Data</button>
                    <button role="tab" aria-selected={dataTab === "study"} className={dataTab === "study" ? "active" : ""} onClick={() => setDataTab("study")}>Study</button>
                    <button role="tab" aria-selected={dataTab === "hypothesis"} className={dataTab === "hypothesis" ? "active" : ""} onClick={() => setDataTab("hypothesis")}>Hypothesis</button>
                  </div>
                  <div className="dataset-actions">
                    {datasetName && <span>{datasetName} · {rows.length.toLocaleString()} rows</span>}
                    {rows.length > 0 && <button className="icon-text" onClick={() => { setRows([]); setDatasetName(""); setDataSource(""); setProviders(null); setStudy(null); }}><Trash2 size={13} />Clear</button>}
                    <label className="import-button"><FileUp size={14} />CSV fallback<input type="file" accept=".csv,text/csv" onChange={importCsv} /></label>
                  </div>
                </div>

                {dataTab === "rows" && (
                  <div className="dock-content">
                    {!rows.length ? (
                      <div className="empty-data"><Database size={19} /><div><strong>{loadingData ? "OHLCV를 가져오는 중입니다" : "분석 데이터가 없습니다"}</strong><p>{loadingData ? `${symbol}의 조정 일봉 10년치를 불러오고 있습니다.` : "자동 수집에 실패하면 CSV를 대체 입력으로 사용할 수 있습니다."}</p>{importError && <em>{importError}</em>}</div></div>
                    ) : (
                      <div className="rows-view">
                        {profile && <div className="dataset-profile"><span><small>Period</small><b>{profile.start} — {profile.end}</b></span><span><small>Total change</small><b className={profile.change >= 0 ? "positive" : "negative"}>{formatPercent(profile.change)}</b></span><span><small>Up days</small><b>{(profile.upDays * 100).toFixed(1)}%</b></span><span><small>Avg volume</small><b>{Math.round(profile.averageVolume).toLocaleString()}</b></span><span><small>Source check</small><b>{providers?.validation?.latestCloseDeltaPct !== null && providers?.validation?.latestCloseDeltaPct !== undefined ? `Δ ${providers.validation.latestCloseDeltaPct.toFixed(3)}%` : dataSource}</b></span></div>}
                        <div className="price-table" role="table" aria-label={`${datasetName} price data`}>
                          <div className="price-row head" role="row"><span>Date</span><span>Open</span><span>High</span><span>Low</span><span>Close</span><span>Volume</span></div>
                          {[...rows].reverse().slice(0, 40).map((row) => <div className="price-row" role="row" key={row.date}><span>{row.date}</span><span>{row.open.toFixed(2)}</span><span>{row.high.toFixed(2)}</span><span>{row.low.toFixed(2)}</span><span>{row.close.toFixed(2)}</span><span>{Math.round(row.volume).toLocaleString()}</span></div>)}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {dataTab === "study" && (
                  <div className="study-workbench">
                    <div className="study-query">
                      <label>When<select value={feature} onChange={(event) => { setFeature(event.target.value as Feature); setStudyRan(false); }}><option value="return1d">일간 수익률</option><option value="gap">시가 갭</option><option value="range">일중 변동폭</option><option value="volume20">20일 평균 대비 거래량</option></select><ChevronDown size={13} /></label>
                      <label>is<select value={operator} onChange={(event) => { setOperator(event.target.value as Operator); setStudyRan(false); }}><option value="gt">greater than</option><option value="lt">less than</option></select><ChevronDown size={13} /></label>
                      <label>Threshold<input type="number" step="0.1" value={threshold} onChange={(event) => { setThreshold(Number(event.target.value)); setStudyRan(false); }} /><span>{feature === "volume20" ? "×" : "%"}</span></label>
                      <label>Forward<input type="number" min="1" max="252" value={horizon} onChange={(event) => { setHorizon(Number(event.target.value)); setStudyRan(false); }} /><span>days</span></label>
                      <button className="run-button" disabled={!rows.length} onClick={executeStudy}><Play size={13} fill="currentColor" />Run</button>
                    </div>
                    {!rows.length ? <div className="study-empty">CSV를 불러오면 이 조건이 과거에 발생한 모든 시점과 이후 수익률을 계산합니다.</div> : studyRan && study ? (
                      <div className="study-results"><span><small>Occurrences</small><b>{study.occurrences}</b></span><span><small>Positive after {horizon}D</small><b>{(study.positiveRate * 100).toFixed(1)}%</b></span><span><small>Median</small><b className={study.median >= 0 ? "positive" : "negative"}>{formatPercent(study.median)}</b></span><span><small>Average</small><b className={study.average >= 0 ? "positive" : "negative"}>{formatPercent(study.average)}</b></span><span><small>Best / Worst</small><b>{formatPercent(study.best)} / {formatPercent(study.worst)}</b></span></div>
                    ) : studyRan ? <div className="study-empty">이 조건과 기간에서는 발생 사례가 없습니다.</div> : <div className="study-empty">조건을 정하고 Run을 누르세요. 계산 과정에는 LLM을 사용하지 않습니다.</div>}
                  </div>
                )}

                {dataTab === "hypothesis" && (
                  <div className="hypothesis-editor">
                    <label>Working hypothesis<textarea value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} placeholder="관찰 → 예상 메커니즘 → 진입/청산 규칙 → 반증 조건" /></label>
                    <div><span>{hypothesis.length ? "Draft · not backtested" : "No hypothesis"}</span><button className="run-button" disabled={!hypothesis.trim() || !rows.length} onClick={() => setView("backtest")}><FlaskConical size={13} />Prepare backtest</button></div>
                  </div>
                )}
              </article>
            </section>

            {agentOpen && (
              <aside className="agent-dock">
                <div className="agent-head"><div><span className="agent-mark"><Sparkles size={15} /></span><div><strong>Agent</strong><small>{rows.length ? `${datasetName} attached` : "waiting for data"}</small></div></div><button className="agent-history-shortcut" aria-label="Open agent history" onClick={() => setHistoryOpen(true)}><HistoryIcon size={14} /><span>{history.length}</span></button></div>
                <div className="agent-context">
                  <span>{symbol}</span><span>{intervals.find((item) => item.value === interval)?.label}</span><span>{studies.length} studies</span><span className={rows.length ? "connected" : "missing"}>{rows.length ? `${rows.length} rows` : "loading data"}</span><span className={brokerSnapshot?.available ? "connected" : "missing"}>{brokerSnapshot?.available ? `Toss ${brokerSnapshot.session?.label ?? "quote"}` : "Toss fallback"}</span>
                </div>
                <div className="conversation-log" aria-live="polite">
                  {!messages.length && <div className="agent-empty"><strong>차트와 데이터를 함께 조작합니다.</strong><p>“RSI와 MACD 추가해줘”처럼 차트를 바꾸거나, “이 조건이 다른 시장 국면에서도 남는지”처럼 데이터를 조사해 달라고 하세요.</p></div>}
                  {messages.map((message) => <div className={`chat-message ${message.role}`} key={message.id}><span>{message.role === "user" ? "You" : "Agent"} · {message.symbol}</span><p>{message.text}</p></div>)}
                  {asking && <div className="agent-thinking"><i /><i /><i /></div>}
                </div>
                <form className="agent-composer" onSubmit={askAgent}>
                  <textarea aria-label="Ask Agent" value={question} onChange={(event) => setQuestion(event.target.value)} disabled={asking} placeholder="RSI와 MACD 추가해줘…" rows={3} />
                  <div><span>Chart commands · grounded analysis</span><button aria-label="Send" disabled={!question.trim() || asking}><Send size={15} /></button></div>
                </form>
              </aside>
            )}
          </div>
        )}

        {view === "backtest" && (
          <section className="simple-view">
            <header><div><span>Backtest</span><h1>검증할 규칙을 확정합니다.</h1></div><span className="engine-state"><Check size={13} />No LLM</span></header>
            <div className="backtest-grid">
              <article><small>Hypothesis</small><textarea value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} placeholder="Market 화면에서 가설을 작성하세요." /><div className="config-row"><label>Capital<input type="number" defaultValue="100000" /></label><label>Cost (bps)<input type="number" defaultValue="8" /></label><label>Benchmark<select defaultValue="SPY"><option>SPY</option></select></label></div><button className="run-button large" disabled>Data engine not connected</button></article>
              <aside><strong>아직 실행하지 않습니다.</strong><p>현재는 합성 수익률을 만들지 않습니다. 실제 S&amp;P 500 데이터 공급자와 포인트인타임 유니버스가 연결된 뒤, 확정된 규칙만 백테스트 엔진에 전달합니다.</p></aside>
            </div>
          </section>
        )}

        {view === "calendar" && <MarketCalendar />}

        {view === "news" && <MarketNews onHistory={(event) => recordHistory("news", event.title, event.detail, "Google News")} />}

        {view === "settings" && (
          <section className="simple-view">
            <header><div><span>Connections</span><h1>데이터와 모델 연결</h1></div></header>
            <div className="settings-list">
              <article><div><strong>TradingView Advanced Chart</strong><p>차트, 드로잉, 보조지표</p></div><span className="connected"><i />Connected</span></article>
              <article><div><strong>Toss Securities</strong><p>브로커 현재가·호가·최근 체결·장 시간 · 읽기 전용</p></div><span className={brokerSnapshot?.available ? "connected" : "missing"}><i />{brokerSnapshot?.available ? "Connected" : brokerSnapshot?.code === "ip_allowlist" ? "IP allowlist" : "Fallback"}</span></article>
              <article><div><strong>Yahoo Finance</strong><p>조정 일봉 10년 · 토스 교차검증 및 자동 폴백</p></div><span className={providers?.yahoo.status === "connected" ? "connected" : "missing"}><i />{providers?.yahoo.status === "connected" ? "Connected" : "Unavailable"}</span></article>
              <article><div><strong>Analysis dataset</strong><p>우선순위 Toss → Yahoo · 자동 갱신 캐시 24시간</p></div><span className={rows.length ? "connected" : "missing"}><i />{rows.length ? dataSource : "Loading"}</span></article>
              <article><div><strong>Claude</strong><p>사용자가 요청할 때만 데이터 해석</p></div><span className="connected"><i />Connected</span></article>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
