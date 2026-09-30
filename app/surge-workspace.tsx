"use client";

import Check from "lucide-react/dist/esm/icons/check";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert";
import Flame from "lucide-react/dist/esm/icons/flame";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Scale from "lucide-react/dist/esm/icons/scale";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import Wallet from "lucide-react/dist/esm/icons/wallet";
import WifiOff from "lucide-react/dist/esm/icons/wifi-off";
import { useCallback, useEffect, useRef, useState } from "react";
import { GENERATION_MODELS } from "@/lib/strategy-generation-models";
import { SURGE_STAGES, type SurgeJob, type SurgeActivity } from "@/lib/surge-types";
import type { SurgePool } from "@/lib/surge-spec";
import type { summarizeSurgeResearch } from "@/lib/surge-research";
import { SurgeActivityPanel } from "./surge-activity";
import { SurgeCases } from "./surge-cases";
import { TradingDashboards } from "./trading-dashboards";

type Job = Omit<SurgeJob, "ownerId">;

type Strategy = {
  runId: string; id: string; name: string; summary: string; pool: SurgePool; interval: string;
  entryFrom: string; entryTo: string; minMinutesSinceEvent: number; maxMinutesSinceEvent: number;
  maxHoldMinutes: number; maxTradesPerDay: number; exitBy: string;
  stopPct: number; rewardRisk: number; targetPct: number;
  rules: string[]; cautions: string[];
};

type State = {
  jobs: Job[];
  availability: { ready: boolean; missing: string[] };
  strategies: Strategy[];
  market: { sessions: number; firstDate: string | null; lastDate: string | null };
  splits: { events: number; firstDate: string | null; lastDate: string | null };
  bars: Array<{ interval: string; symbols: number; sessions: number; firstDate: string; lastDate: string }>;
  window: { tradingDays: number; capitalUsd: number; reason: string };
  filters: {
    eventChangePct: number; minPriceUsd: number; maxPriceUsd: number; minSessionDollarVolumeUsd: number;
    historyFloor: string; tradableWindow: { from: string; to: string }; massiveCallsPerMinute: number;
    intervals: string[];
  };
  error?: string;
};

type LiveRow = {
  rank: number; symbol: string; lastPrice: number | null; basePrice: number | null;
  changeRate: number | null; tradingVolume: number | null; tradingAmountKrw: number | null;
};
type Board = {
  id: string; label: string; note: string; rankedAt: string | null; duration: string | null;
  filtered: number; rows: LiveRow[]; error: string | null;
};
type EventRow = {
  symbol: string; rank: number; observedAt: string | null; availableAt: string | null; changePct: number;
  observedPrice: number | null; prevClose: number; sessionDollarVolume: number; modelledRoundTripPct: number;
};
type LiveRule = {
  id: string; name: string; interval: string; pool: string; timing: string;
  stopPct: number; targetPct: number; rewardRisk: number; maxTradesPerDay: number;
  universe: string[]; observed: number; checkedAt: string | null; withheld: string | null;
};
type Live = {
  pool: SurgePool; fetchedAt?: string;
  observation: { date: string; checkedAt: string | null; error: string | null; note: string | null; events: EventRow[] } | null;
  rules: LiveRule[];
  boards: Board[];
  error?: string | null;
};

const POOL_LABEL: Record<SurgePool, string> = { gainers: "급상승", losers: "급하락" };
const signedPct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const STATUS_LABEL: Record<Job["status"], string> = {
  running: "실행 중", paused: "대기", completed: "등록됨", rejected: "기준 미달", failed: "중단", cancelled: "취소됨",
};

/**
 * `fetch` rejects with a bare TypeError ("Failed to fetch" / "Load failed") only
 * when the server could not be reached at all. That is a connection state, not
 * a failed action, and it clears itself as soon as the server answers again —
 * the run is durable in D1 and resumes from the saved stage.
 */
const OFFLINE = "서버에 연결하지 못했습니다 — 개발 서버가 꺼졌거나 재시작 중입니다. 저장된 단계에서 자동으로 이어집니다.";
const unreachable = (error: unknown) => error instanceof TypeError;
const pct = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? "—" : `${value.toFixed(digits)}%`;
const rr = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${value.toFixed(2)}R`;
const compact = (value: number | null | undefined) =>
  value === null || value === undefined ? "—"
    : value >= 1e9 ? `${(value / 1e9).toFixed(1)}B`
    : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M`
    : Math.round(value).toLocaleString();

function SameDayPatterns({ data }: { data?: Record<string, unknown> }) {
  const patterns = data?.afterSimilarFirst15m as ReturnType<typeof summarizeSurgeResearch>["afterSimilarFirst15m"] | undefined;
  if (!patterns) return null;
  const names: Record<string, string> = { first15m_up: "첫 15분 +1% 이상", first15m_flat: "첫 15분 −1%~+1%", first15m_down: "첫 15분 −1% 이하" };
  return <details className="surge-evidence">
    <summary>비슷한 당일 패턴 이후의 움직임 · 학습 구간</summary>
    <p className="generator-note">급등락을 처음 관측한 시점을 맞춘 뒤 첫 15분 움직임으로 묶었습니다. 아래 수익률은 그 15분이 지난 가격부터의 변화입니다. 중앙값 [10~90백분위] · 유효 표본 수를 함께 표시합니다.</p>
    <div className="lab-table-wrap"><table className="lab-table">
      <thead><tr><th>관측 후 첫 15분</th><th>사건 / 거래일 / 종목</th><th>이후 15분</th><th>이후 30분</th><th>이후 60분</th></tr></thead>
      <tbody>{patterns.groups.map(group => <tr key={group.shape}>
        <th scope="row">{names[group.shape] ?? group.shape}</th>
        <td>{group.events} / {group.sessions} / {group.symbols}</td>
        {["+15m", "+30m", "+60m"].map(horizon => {
          const row = group.forwardReturnPct[horizon];
          return <td key={horizon}>{pct(row.median)} [{pct(row.p10)} ~ {pct(row.p90)}] · {row.samples}건</td>;
        })}
      </tr>)}</tbody>
    </table></div>
    <p className="generator-note">같은 거래일 안에서만 비교하며 관측 시점의 가격을 100으로 정규화합니다. 미래 움직임으로 분류하지 않고, 해당 시점의 봉이 없으면 결측으로 남깁니다. 이 통계는 비용 차감 전 패턴 비교이며, 전략의 거래 성과는 별도로 검증합니다.</p>
  </details>;
}

export function SurgeWorkspace() {
  const [data, setData] = useState<State | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pool, setPool] = useState<SurgePool>("gainers");
  const [boardId, setBoardId] = useState("TOP_GAINERS");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activityStream, setActivityStream] = useState<{ jobId: string; entries: SurgeActivity[] }>({ jobId: "", entries: [] });
  const [sync, setSync] = useState<{ online: boolean; at: number | null; problem: string | null }>({ online: true, at: null, problem: null });
  const advancing = useRef(false);
  const requestId = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/invest/surge", { cache: "no-store" });
      const body = (await response.json()) as State;
      if (!response.ok) throw new Error(body.error ?? "급등주 상태를 불러오지 못했습니다.");
      setData(body);
      setSync({ online: true, at: Date.now(), problem: null });
    } catch (e) {
      setSync((current) => ({
        ...current,
        online: false,
        problem: unreachable(e) ? OFFLINE : e instanceof Error ? e.message : "상태 조회 실패",
      }));
    }
  }, []);

  /**
   * Refresh re-fetches and swaps the rendered state in place — it is the only
   * way to see a new ranking without reloading the page, so it also has to show
   * that it is working rather than looking inert.
   */
  const loadLive = useCallback(async (which: SurgePool) => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/invest/surge/live?pool=${which}`, { cache: "no-store" });
      setLive((await response.json()) as Live);
    } catch {
      setLive((current) => ({
        pool: which, observation: null, rules: [],
        boards: current?.boards ?? [], error: "당일 관측·랭킹을 불러오지 못했습니다.",
      }));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { queueMicrotask(() => void load()); const timer = setInterval(() => void load(), 4000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { queueMicrotask(() => void loadLive(pool)); const timer = setInterval(() => void loadLive(pool), 30_000); return () => clearInterval(timer); }, [pool, loadLive]);
  /** Switching the pool moves the watched board with it, so the two never disagree. */
  const selectPool = (next: SurgePool) => {
    setPool(next);
    setBoardId(next === "gainers" ? "TOP_GAINERS" : "TOP_LOSERS");
  };

  const active = data?.jobs.find((job) => job.status === "running");
  const latest = active ?? data?.jobs[0];

  useEffect(() => {
    if (!active?.id) return;
    let disposed = false;
    const advance = async () => {
      if (advancing.current || disposed) return;
      advancing.current = true;
      try {
        const response = await fetch("/api/invest/surge", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "advance", id: active.id }),
        });
        if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "단계 실행 실패");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("진행 응답 없음");
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (message.type === "progress" && message.activity && !disposed) {
              setActivityStream((current) => ({ jobId: active.id,
                entries: [...(current.jobId === active.id ? current.entries : []), message.activity as SurgeActivity].slice(-160),
              }));
            }
            if (message.type === "error") throw new Error(message.message);
          }
          if (done) break;
        }
        if (!disposed) { setError(null); await load(); }
      } catch (e) {
        if (disposed) return;
        if (unreachable(e)) setSync((current) => ({ ...current, online: false, problem: OFFLINE }));
        else setError(e instanceof Error ? e.message : "단계 실행 실패");
      } finally {
        advancing.current = false;
      }
    };
    void advance();
    const timer = setInterval(() => void advance(), 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [active?.id, load]);

  const post = async (body: Record<string, unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/invest/surge", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? failure);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    requestId.current ??= crypto.randomUUID();
    const ok = await post({ action: "create", pool, brief, requestId: requestId.current }, "생성 시작 실패");
    requestId.current = null;
    if (ok) setActivityStream({ jobId: "", entries: [] });
  };

  const downloading = !!latest && latest.stageIndex <= 1 && latest.status === "running";
  const marketLeft = Math.max(0, (latest?.marketTasks?.length ?? 0) - (latest?.marketCursor ?? 0));
  const barsLeft = Math.max(0, (latest?.barTasks?.length ?? 0) - (latest?.barCursor ?? 0));
  const perMinute = data?.filters.massiveCallsPerMinute ?? 5;
  const etaMinutes = Math.ceil((marketLeft + barsLeft) / Math.max(1, perMinute));
  const dataTotal = latest?.stageIndex === 0 ? latest.marketTasks?.length ?? 0 : latest?.barTasks?.length ?? 0;
  const dataDone = Math.min(dataTotal, latest?.stageIndex === 0 ? latest.marketCursor ?? 0 : latest?.barCursor ?? 0);
  // 3m and 5m are rolled up from the same minutes, so the 1m row is the whole inventory.
  const minuteBars = data?.bars.find((row) => row.interval.startsWith("1m"));
  const board = live?.boards.find((row) => row.id === boardId) ?? live?.boards[0];

  const observation = live?.observation;
  const filters = data?.filters;

  return <section className="surge-board">
    <header className="lab-page-head">
      <div>
        <span>SURGE · TOSS TOP10 CASES → PATTERN → STRATEGY</span>
        <h1>급등주</h1>
        <p>매일 한국시간 00:00의 <strong>토스 급상승·급하락 상위 10개</strong>를 사례로 쌓고, 그 날들의 행동에 <strong>유사성</strong>이 있는지 분석해 매매 규칙을 만듭니다.</p>
      </div>
      <div className="lab-capabilities">
        <span><Flame size={13} />당일 사건 관측</span>
        <span><Scale size={13} />손익비 고정</span>
        <span><Wallet size={13} />트레이딩 중 LLM 0회</span>
      </div>
    </header>

    {/* ------------------------------------------ the owner's cases → agent */}
    <SurgeCases />

    {/* ---------------------------------------------------- today's events */}
    <section className="surge-live">
      <header>
        <div>
          <span>TODAY · SAME-DAY EVENTS</span>
          <strong>오늘 관측된 {POOL_LABEL[pool]} 사건{observation?.date ? ` — ${observation.date} (ET)` : ""}</strong>
        </div>
        <div className="surge-pool-switch" role="group" aria-label="사건 종류">
          {(["gainers", "losers"] as const).map((key) => (
            <button key={key} className={pool === key ? "active" : ""} onClick={() => selectPool(key)}>{POOL_LABEL[key]}</button>
          ))}
          <button onClick={() => void loadLive(pool)} disabled={refreshing} aria-busy={refreshing}>
            <RefreshCw size={12} className={refreshing ? "spin" : ""} />{refreshing ? "새로고치는 중" : "새로고침"}
          </button>
        </div>
      </header>

      <p className="surge-note">
        사건 = 정규장 <strong>완성된 1분봉</strong> 종가가 전일 종가 대비 {pool === "gainers" ? "+" : "−"}{filters?.eventChangePct ?? 10}% 이상,
        가격 ${filters?.minPriceUsd ?? 1}–${filters?.maxPriceUsd ?? 500}, 그 분까지 누적 거래대금 ≥ ${((filters?.minSessionDollarVolumeUsd ?? 1e6) / 1e6).toFixed(0)}M인 <strong>첫 분</strong>.
        백테스트와 실거래가 같은 정의를 씁니다 — 실거래는 토스 급상승·급하락 랭킹을 후보로 삼고 토스 1분봉으로 그 분을 다시 찾습니다.
        {pool === "losers" ? " 미국주식 공매도가 없어 급하락 사건은 반등 매수로만 거래합니다." : ""}
      </p>

      {live?.error && <p className="generator-error">{live.error}</p>}
      {observation?.error && <p className="surge-note surge-stale"><TriangleAlert size={12} /> {observation.error}</p>}
      {observation?.note && <p className="surge-note">{observation.note}</p>}
      {observation?.checkedAt && Date.parse(observation.checkedAt) > 0 && <p className="surge-note">마지막 관측 {new Date(observation.checkedAt).toLocaleTimeString("ko-KR")}</p>}

      {observation && !observation.events.length && <p className="surge-note">
        아직 관측된 사건이 없습니다. 관측은 정규장(09:30–16:00 ET) 동안 급등주 실전·모의 대시보드가 실행 중일 때 러너 틱마다 진행됩니다.
      </p>}

      {!!observation?.events.length && <div className="lab-table-wrap"><table className="lab-table">
        <thead><tr><th>관측 시각(ET)</th><th>종목</th><th>관측 시 등락률</th><th>관측가</th><th>전일 종가</th><th>누적 거래대금</th><th>모형 왕복비용</th></tr></thead>
        <tbody>{observation.events.map((row) => <tr key={row.symbol}>
          <td>{row.observedAt ?? "—"}{row.availableAt && row.availableAt !== row.observedAt ? <small> (확인 {row.availableAt})</small> : null}</td>
          <td><strong>{row.symbol}</strong></td>
          <td className={row.changePct >= 0 ? "positive" : "negative"}>{signedPct(row.changePct)}</td>
          <td>{row.observedPrice === null ? "—" : `$${row.observedPrice}`}</td>
          <td>${row.prevClose}</td>
          <td>${compact(row.sessionDollarVolume)}</td>
          <td>{pct(row.modelledRoundTripPct)}</td>
        </tr>)}</tbody>
      </table></div>}

      {!!live?.rules.length && <div className="surge-scope">
        {live.rules.map((rule) => <div key={rule.id} className={rule.withheld ? "withheld" : ""}>
          <b>{rule.name}</b>
          <small>{rule.interval}봉 · {rule.timing} · 손절 {rule.stopPct}% · 목표 {rule.targetPct}% · 손익비 {rule.rewardRisk}:1 · 하루 최대 {rule.maxTradesPerDay}회</small>
          {rule.withheld
            ? <p>{rule.withheld}</p>
            : <p>지금 진입 가능한 사건 {rule.universe.length}개: {rule.universe.join(", ")}</p>}
        </div>)}
      </div>}
    </section>

    {/* ------------------------------------------------------- the live screen */}
    <section className="surge-live">
      <header>
        <div>
          <span>LIVE · TOSS RANKINGS (US)</span>
          <strong>지금 랭킹 — 감시용</strong>
        </div>
        <span className="surge-note">{live?.fetchedAt ? `${new Date(live.fetchedAt).toLocaleTimeString("ko-KR")} 조회` : ""}</span>
      </header>
      <p className="surge-note">
        토스 <code>GET /api/v1/rankings</code> 의 여섯 개 랭킹을 전부 가져옵니다. 급등·급락만 보면 그 움직임에 실제 참여가 있었는지 알 수 없어서 거래대금·거래량 보드를 함께 읽습니다.
        <code>marketCountry=US</code> 에 더해 <strong>코드에서 한 번 더 미국 상장만 남깁니다</strong>.
        정규장 동안 급상승·급하락 <code>1d</code> 는 오늘의 전일 종가 대비 등락률이고 <strong>당일 관측기의 후보 목록</strong>입니다 — 목록에 오른 것만으로는 사건이 아니고, 그 종목의 1분봉이 위 정의를 충족해야 사건이 됩니다.
        개장 전에는 프리마켓 소량 체결로 순위가 정해지므로 관측하지 않습니다.
      </p>
      <div className="surge-board-tabs" role="tablist" aria-label="랭킹 보드">
        {(live?.boards ?? []).map((row) => (
          <button key={row.id} role="tab" aria-selected={board?.id === row.id} className={board?.id === row.id ? "active" : ""} onClick={() => setBoardId(row.id)}>
            {row.label}
          </button>
        ))}
      </div>
      {board && <>
        <p className="surge-note">
          {board.note}{board.duration ? ` · 기간 ${board.duration}` : ""}
          {board.filtered > 0 ? ` · 미국 상장이 아니어서 제외 ${board.filtered}건` : ""}
          {board.rankedAt ? ` · 집계 ${new Date(board.rankedAt).toLocaleString("ko-KR")}` : ""}
        </p>
        {board.error && <p className="generator-error">{board.error}</p>}
        {!!board.rows.length && <div className="lab-table-wrap"><table className="lab-table">
          <thead><tr><th>순위</th><th>종목</th><th>현재가</th><th>기준가</th><th>등락률</th><th>거래량</th><th>거래대금(KRW)</th></tr></thead>
          <tbody>{board.rows.slice(0, 20).map((row) => <tr key={`${row.rank}-${row.symbol}`}>
            <td>{row.rank}</td>
            <td><strong>{row.symbol}</strong></td>
            <td>{row.lastPrice === null ? "—" : `$${row.lastPrice}`}</td>
            <td>{row.basePrice === null ? "—" : `$${row.basePrice}`}</td>
            <td className={(row.changeRate ?? 0) >= 0 ? "positive" : "negative"}>{pct((row.changeRate ?? 0) * 100)}</td>
            <td>{compact(row.tradingVolume)}</td>
            <td>₩{compact(row.tradingAmountKrw)}</td>
          </tr>)}</tbody>
        </table></div>}
      </>}
      {!live && <div className="research-empty"><RefreshCw size={16} className="spin" /><strong>랭킹 불러오는 중</strong></div>}
    </section>

    {/* ------------------------------------------------------------ dashboards */}
    <section className="surge-invest">
      <header>
        <span>INVEST</span>
        <strong>급등주 실전·모의투자</strong>
        <p>이 대시보드는 <strong>급등주 규칙만</strong> 거래합니다. 전략 탭의 슬롯 전략은 여기서 실행되지 않고, 잔고·주문·기록도 분리된 계정으로 관리합니다.</p>
      </header>
      <TradingDashboards book="surge" />
    </section>

    {/* ----------------------------------------------------------- generator */}
    <section className="strategy-generator surge-studio" aria-label="급등주 전략 생성 에이전트">
      <div className="generator-head">
        <div>
          <span>SURGE STUDIO</span>
          <h2>당일 급등락 종목의 비슷한 움직임을 찾습니다</h2>
          <p>오늘 급등락이 관측된 종목들의 경로를 관측 시점부터 맞춰 비교하고, 반복되는 당일 움직임을 진입·청산 규칙으로 검증합니다.</p>
          <p>{data?.window.reason ?? "기간은 코드가 고정합니다."} 설계는 OpenAI, 검증은 Anthropic — 같은 회사 모델이 자기 결과를 승인할 수 없습니다.</p>
        </div>
        <div className="generator-actions">
          <label>
            연구할 사건
            <select aria-label="연구할 사건" value={pool} onChange={(event) => selectPool(event.target.value as SurgePool)} disabled={!!active || busy}>
              <option value="gainers">급상승 사건 (당일 +{filters?.eventChangePct ?? 10}% 관측 이후)</option>
              <option value="losers">급하락 사건 (당일 −{filters?.eventChangePct ?? 10}% 관측 이후 · 반등 매수)</option>
            </select>
          </label>
          <button className="generator-create" onClick={() => void create()} disabled={!data?.availability.ready || !!active || busy}>
            {active ? "생성 중" : busy ? "시작 중…" : "새 급등주 전략 생성"}
          </button>
        </div>
      </div>

      <ul className="studio-chips" aria-label="고정된 연구 조건">
        <li>최근 {Math.round((data?.window.tradingDays ?? 190) / 30)}개월</li>
        <li>당일 ±{filters?.eventChangePct ?? 10}% 사건</li>
        <li>${filters?.minPriceUsd ?? 1}–${filters?.maxPriceUsd ?? 500}</li>
        <li>누적 거래대금 ≥ ${((filters?.minSessionDollarVolumeUsd ?? 1e6) / 1e6).toFixed(0)}M</li>
        <li>{filters?.tradableWindow.from ?? "09:30"}–{filters?.tradableWindow.to ?? "15:55"} ET · 사건 기준 시간</li>
        <li>{(data?.filters.intervals ?? ["1m", "3m", "5m"]).join(" · ")}봉</li>
        <li>자본 ${data?.window.capitalUsd ?? 1000}</li>
        <li>API 비용 제한 없음</li>
      </ul>

      <details className="studio-sources">
        <summary>
          <ChevronRight size={13} aria-hidden />
          <b>데이터 출처 · Massive</b>
          <span>
            {data
              ? `분할 ${data.splits.events.toLocaleString()}건 · 일봉 ${data.market.sessions.toLocaleString()}일 · 분봉 ${minuteBars ? `${minuteBars.sessions.toLocaleString()}종목·일` : "없음"}`
              : "확인 중…"}
          </span>
        </summary>
        <div>
          <p>
            <strong>분할·병합 이력</strong> <code>/v3/reference/splits</code> — 연구 창 전체에 2~3회.
            원주가로 순위를 매기므로, 1:10 병합이 +900% 급등으로 둔갑하는 것을 막습니다.
          </p>
          <p>
            <strong>하루치 전 종목 시세</strong> <code>/v2/aggs/grouped/…/{"{date}"}</code> — 거래일 하루당 정확히 1회.
            그날 고가·저가·거래량으로 <strong>당일 사건이 있었을 수 있는 종목</strong>만 추립니다(분봉을 받을 후보일 뿐, 신호가 아닙니다).
            {data?.market.firstDate ? ` 저장 범위 ${data.market.firstDate} – ${data.market.lastDate}.` : ""}
          </p>
          <p>
            <strong>후보 종목 1분봉</strong> <code>/v2/aggs/ticker/{"{종목}"}/range/1/minute/…</code> — 종목×월당 1회.
            이 1분봉을 처음부터 다시 재생해 사건이 <strong>몇 시 몇 분에</strong> 관측됐는지 정하고, 3분·5분봉은 같은 분봉을 합쳐 만듭니다.
            후보가 하루 수십 종목이라 첫 생성은 몇 시간에서 하루 가까이 걸릴 수 있습니다.
          </p>
          <small>
            호출 한도 분당 {perMinute}회(요금제) — 진행이 시간 단위로 걸리는 이유입니다. 제공 하한 {data?.filters.historyFloor ?? "—"}(2년 롤링).
            캐시는 계정 단위라 같은 기간의 두 번째 생성은 설계 단계에서 바로 시작합니다.
          </small>
        </div>
      </details>

      <details className="generator-options">
        <summary>전략에 반영할 조건 (선택)</summary>
        <textarea
          aria-label="급등주 전략 생성 요청"
          maxLength={1500}
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          disabled={!!active || busy}
          placeholder="예: 관측 직후 추격 말고, 첫 되돌림에서 당일 VWAP 위를 지키면 매수. 1분봉, 최대 30분 보유, 손익비 2:1 이상."
        />
      </details>

      {data && !data.availability.ready && (
        <p className="studio-banner error" role="alert"><CircleAlert size={14} aria-hidden />서버 API 키가 필요합니다: {data.availability.missing.join(", ")}. 두 회사가 모두 연결되어야 시작됩니다.</p>
      )}
      {!sync.online && sync.problem && <p className="studio-banner offline" role="status"><WifiOff size={14} aria-hidden />{sync.problem}</p>}
      {error && <p className="studio-banner error" role="alert"><CircleAlert size={14} aria-hidden />{error}</p>}

      {latest && <div className={`generator-run studio-run ${latest.status}`}>
        <div className="generator-run-title" aria-live="polite">
          <span className={`studio-status ${latest.status}`}>{STATUS_LABEL[latest.status]}</span>
          <strong>
            {latest.status === "completed" ? "급등주 전략이 등록됐습니다"
              : latest.status === "rejected" ? "기준을 넘는 패턴을 찾지 못했습니다"
              : latest.status === "paused" ? "연구 대기 · 이어서 진행 가능"
              : latest.status === "failed" ? "생성이 중단됐습니다"
              : latest.status === "cancelled" ? "생성이 취소됐습니다"
              : (SURGE_STAGES[latest.stageIndex]?.label ?? "준비 중")}
          </strong>
          <span className="studio-meta">
            {POOL_LABEL[latest.pool]} · {latest.attempt ?? 1}회차 · 누적 API ${latest.costUsd.toFixed(3)}
            {sync.at ? ` · ${new Date(sync.at).toLocaleTimeString("ko-KR")} 동기화` : ""}
          </span>
          {(active || latest.status === "paused") && (
            <button className="studio-quiet" onClick={() => void post({ action: "cancel", id: latest.id }, "취소 실패")} disabled={busy}>생성 취소</button>
          )}
        </div>

        <SurgeActivityPanel key={latest.id} job={latest} streamed={activityStream.jobId === latest.id ? activityStream.entries : []} online={sync.online} />

        {active && <>
          {downloading && dataTotal > 0 && <div className="studio-meter">
            <div className="studio-meter-label">
              <b>{latest.stageIndex === 0 ? "일별 시세" : "1분봉"}</b>
              <span>{dataDone.toLocaleString()} / {dataTotal.toLocaleString()}{latest.stageIndex === 0 ? "일" : "종목·월"}</span>
              <span>미확인 항목 {(marketLeft + barsLeft).toLocaleString()}개 · 한도 기준 약 {etaMinutes}분</span>
            </div>
            <div className="studio-meter-track" role="progressbar" aria-valuemin={0} aria-valuemax={dataTotal} aria-valuenow={dataDone}>
              <i style={{ transform: `scaleX(${dataDone / dataTotal})` }} />
            </div>
            <small>분당 {perMinute}회 기준 데이터 수집 추정치입니다. 캐시·추가 페이지·다른 요청에 따라 달라지며, 모델 분석 시간은 포함하지 않습니다.</small>
          </div>}
          <ol className="generator-steps studio-steps">
            {SURGE_STAGES.map((stage, index) => {
              const state = index < latest.stageIndex ? "done" : index === latest.stageIndex ? "current" : "";
              return <li key={stage.id} className={state}>
                <span aria-hidden>{state === "done" ? <Check size={12} strokeWidth={3} /> : index + 1}</span>
                <div>
                  <b>{stage.label}</b>
                  <small>
                    {state === "done" ? "완료" : state === "current" ? "실행 중" : "대기"} · {stage.role ? GENERATION_MODELS[stage.role].model : "실행 엔진"}
                  </small>
                </div>
              </li>;
            })}
          </ol>
        </>}

        {latest.error && <p className="studio-banner error"><CircleAlert size={14} aria-hidden />{latest.error}</p>}
        {latest.nextAction && <p className="generator-note">{latest.nextAction}</p>}
        {(latest.pauseReason === "budget" || latest.pauseReason === "provider") && latest.status === "paused" && (
          <button className="generator-create" onClick={() => void post({ action: "resume", id: latest.id }, "재개 실패")} disabled={busy || !!active}>
            {latest.pauseReason === "budget" ? "예산 제한 없이 이어서 진행" : "크레딧 충전 완료 · 이어서 진행"}
          </button>
        )}

        {!!latest.barFailures?.length && <details>
          <summary>분봉을 받지 못한 종목 · {latest.barFailures.length}건</summary>
          <ul className="generator-events">{latest.barFailures.map((line, index) => <li key={index}>{line}</li>)}</ul>
          <p className="generator-note">해당 날짜에는 신호가 나오지 않습니다. 상장폐지·거래정지 종목이 대부분이며, 생존편향을 완전히 제거하지는 못합니다.</p>
        </details>}

        <SameDayPatterns data={latest.dataSummary} />

        {latest.evidence && <div className="surge-evidence">
          <header><span>EVIDENCE</span><strong>구간별 실측 — 손익비는 R로 읽습니다</strong></header>
          <div className="lab-table-wrap"><table className="lab-table">
            <thead><tr><th>구간</th><th>기간</th><th>거래</th><th>승률</th><th>기대값</th><th>평균 이익</th><th>평균 손실</th><th>실현 손익비</th><th>순수익률</th><th>최대 낙폭</th></tr></thead>
            <tbody>{(["training", "validation", "holdout", "stress", "delayed"] as const).map((key, index) => {
              const part = latest.evidence![key];
              return <tr key={key}>
                <td>{["학습", "검증", "최종 미사용", "비용 2배", "진입 1봉 지연"][index]}</td>
                <td>{part.from}–{part.to}</td>
                <td>{part.metrics.totalTrades}</td>
                <td>{pct(part.expectancy.winRatePct, 1)}</td>
                <td className={(part.expectancy.expectancyR ?? 0) > 0 ? "positive" : "negative"}>{rr(part.expectancy.expectancyR)}</td>
                <td>{rr(part.expectancy.avgWinR)}</td>
                <td>{rr(part.expectancy.avgLossR)}</td>
                <td>{part.expectancy.payoffRatio?.toFixed(2) ?? "—"}:1</td>
                <td>{pct(part.metrics.totalReturnPct)}</td>
                <td>{pct(part.metrics.maxDrawdownPct)}</td>
              </tr>;
            })}</tbody>
          </table></div>
          <p className="generator-note">
            최종 미사용 구간 기대값의 자기상관 보정 95% 하한 {rr(latest.evidence.holdout.expectancy.expectancyLower95R)} —
            이 값이 0 이하이면 “표본에서 벌었다”일 뿐 엣지가 확립된 것이 아니므로 등록되지 않습니다.
          </p>
          {!!latest.evidence.reasons.length && <ul className="generator-events">
            {latest.evidence.reasons.map((reason, index) => <li key={index}>! {reason}</li>)}
          </ul>}
        </div>}

        {!!latest.attempts?.length && <details>
          <summary>자동 개선 기록 · {latest.attempts.length}회</summary>
          <ul className="generator-events">
            {latest.attempts.map((attempt, index) => <li key={index}>{attempt.attempt}회차 ({attempt.stage}): {attempt.reasons.join("; ")}</li>)}
          </ul>
        </details>}

        {latest.status !== "running" && <details>
          <summary>검증 기록 · 모델별 작업 보기</summary>
          {latest.report && <p>{latest.report.summary}</p>}
          <ul className="generator-events">
            {latest.events.map((event, index) => <li key={index}>
              {event.state === "done" ? "✓" : event.state === "error" ? "!" : "→"} {event.detail}
              {event.role && <small> · {GENERATION_MODELS[event.role].model}</small>}
            </li>)}
          </ul>
          <a
            href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(latest, null, 2))}`}
            download={`surge-${latest.id}.json`}
          >전체 검증 기록 다운로드</a>
        </details>}
      </div>}
    </section>

    {!!data?.strategies.length && <section className="surge-registered">
      <header><span>REGISTERED</span><strong>등록된 급등주 규칙</strong></header>
      {data.strategies.map((strategy) => <article key={strategy.id}>
        <div>
          <b>{strategy.name}</b>
          <span className={`relay-tag ${strategy.pool === "gainers" ? "on" : ""}`}>{POOL_LABEL[strategy.pool]}</span>
        </div>
        <p>{strategy.summary}</p>
        <ul>{strategy.rules.map((rule, index) => <li key={index}>{rule}</li>)}</ul>
        <small>
          {strategy.interval}봉 · 관측 후 {strategy.minMinutesSinceEvent}–{strategy.maxMinutesSinceEvent}분 · {strategy.entryFrom}–{strategy.entryTo} ET 결정 ·
          최대 {strategy.maxHoldMinutes}분 보유 · {strategy.exitBy} 청산 · 하루 최대 {strategy.maxTradesPerDay}회 ·
          손절 {strategy.stopPct}% · 목표 {strategy.targetPct}% · 손익비 {strategy.rewardRisk}:1
        </small>
        {!!strategy.cautions.length && <p className="surge-cautions">{strategy.cautions.join(" · ")}</p>}
      </article>)}
    </section>}

    {!data && <div className="research-empty"><RefreshCw size={16} className="spin" /><strong>불러오는 중</strong></div>}
  </section>;
}
