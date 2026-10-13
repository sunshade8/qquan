"use client";
// Styles travel with the components so hot reload never pairs new markup with an old stylesheet.
import "./ct.css";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import ChartCandlestick from "lucide-react/dist/esm/icons/chart-candlestick";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert";
import Download from "lucide-react/dist/esm/icons/download";
import Info from "lucide-react/dist/esm/icons/info";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import X from "lucide-react/dist/esm/icons/x";
import type { GenerationJob, ResearchMeter } from "@/lib/strategy-generation-types";
import { mergeCalls, pickMeter } from "@/lib/ct-activity";
import type { ActiveGeneration } from "@/lib/strategy-generation-store";
import type { CTPackage } from "@/lib/ct-research-store";
import type { CTBar, CTResult } from "@/lib/ct-engine";
import type { CTResearch, CTSource, CTTrial } from "@/lib/ct-research";
import { ctRuleText, type CTSpec, type CTMarket } from "@/lib/ct-spec";
import { CTEvidenceChart } from "./ct-evidence-chart";
import { CT_EXIT_REASON_TEXT } from "@/lib/ct-trade-levels";
import { TradingDashboards } from "./trading-dashboards";
import {
  ActivityFeed,
  CT_PHASES,
  LatestTrialCard,
  LiveStatusBar,
  NowPanel,
  PhaseStepper,
  isLive,
  trialPassed,
  type CTJob,
} from "./ct-progress";
import { ResearchPicker } from "./ct-picker";

export { CT_PHASES };

type CTResponse = {
  jobs: Omit<GenerationJob, "ownerId">[];
  /** Running job holding the account's single slot that this device cannot see. */
  blocking: ActiveGeneration | null;
  registered: CTPackage[];
  availability: { ready: boolean; missing: string[] };
  runnerOnline: boolean;
  /** Cost profile a start would use (exchange, version, round trip per symbol). */
  costPreview?: { label: string; version: number; provisional: boolean; feeVerified: boolean; perSymbol: Array<{ symbol: string; roundTripPct: number }> };
};
const CRYPTO_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
const tone = (n: number) => (n > 0 ? "positive" : n < 0 ? "negative" : "");
const pct = (n: number, digits = 2) => `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
/** Mean daily net return; results saved before the field existed derive it from daily rows. */
const dayMean = (r: CTResult) =>
  r.meanDailyReturnPct ?? (r.daily.length ? r.daily.reduce((s, d) => s + d.returnPct, 0) / r.daily.length : 0);
const money = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
const BLOCKING_KIND = { "ct-stock": "CT 주식 연구", "ct-crypto": "CT 코인 연구", slot: "전략 탭 슬롯 연구" } as const;
const clockTime = (iso: string) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
const RUNNER_COMMAND = "node --env-file=.dev.vars scripts/trading-runner.mjs --generation-only";
/** No checkpoint for this long while running: whoever was advancing it has gone away. */
const BLOCKING_STALE_MS = 2 * 60_000;
const quietFor = (ms: number) =>
  ms < 3_600_000 ? `${Math.floor(ms / 60_000)}분` : `${Math.floor(ms / 3_600_000)}시간 ${Math.floor((ms % 3_600_000) / 60_000)}분`;

/** 동결 규칙 최종 평가 요약. */
function FinalMetrics({ result }: { result: CTResult }) {
  return (
    <div className="ui-metrics">
      <div className="ui-metric"><span>최종 일평균 순수익</span><b className={tone(dayMean(result))}>{pct(dayMean(result), 3)}</b><small>{result.daily.length}일 · 기준 0% 초과</small></div>
      <div className="ui-metric"><span>최종 순수익</span><b className={tone(result.netReturnPct)}>{pct(result.netReturnPct)}</b><small>비용 {money(result.costs)}</small></div>
      <div className="ui-metric"><span>거래 수</span><b>{result.tradeCount ?? result.trades.length}</b><small>무거래 {result.emptyDays}일</small></div>
      <div className="ui-metric"><span>최대 낙폭</span><b>{result.maxDrawdownPct.toFixed(2)}%</b></div>
      <div className="ui-metric"><span>승률</span><b>{result.winRatePct.toFixed(1)}%</b><small>손익비 {result.payoff.toFixed(2)}</small></div>
      <div className="ui-metric"><span>규칙 준수</span><b>{result.compliancePct}%</b><small>기대값 {result.expectancy.toFixed(4)}</small></div>
    </div>
  );
}

/** 구간별 측정값을 한 표로 비교한다. */
function SliceTable({ trial }: { trial: CTTrial }) {
  const cols: Array<[string, CTResult]> = [
    ["학습", trial.training],
    ["개발", trial.development],
    ["비용 2배", trial.stress],
    ["1봉 진입 지연", trial.delayed],
  ];
  const rows: Array<[string, (r: CTResult) => React.ReactNode]> = [
    ["일평균 순수익", (r) => <span className={tone(dayMean(r))}>{pct(dayMean(r), 3)}</span>],
    ["순수익", (r) => <span className={tone(r.netReturnPct)}>{pct(r.netReturnPct)}</span>],
    ["수익 일 비율", (r) => r.daily.length ? `${((r.daily.filter((d) => d.returnPct > 0).length / r.daily.length) * 100).toFixed(0)}%` : "—"],
    ["최악의 날", (r) => r.daily.length ? pct(Math.min(...r.daily.map((d) => d.returnPct))) : "—"],
    ["거래 수", (r) => r.tradeCount ?? r.trades.length],
    ["무거래 일수", (r) => r.emptyDays],
    ["최대 낙폭", (r) => `${r.maxDrawdownPct.toFixed(2)}%`],
    ["승률", (r) => `${r.winRatePct.toFixed(1)}%`],
    ["손익비", (r) => r.payoff.toFixed(2)],
    ["기대값", (r) => r.expectancy.toFixed(4)],
    ["비용", (r) => money(r.costs)],
    ["규칙 준수", (r) => `${r.compliancePct}%`],
  ];
  return (
    <div className="ui-scroll-x">
      <table className="ui-table">
        <thead>
          <tr>
            <th scope="col"><span className="ui-sr-only">지표</span></th>
            {cols.map(([label]) => <th scope="col" key={label}>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}>
              <td>{label}</td>
              {cols.map(([c, r]) => <td key={c}>{f(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrialItem({ trial, index }: { trial: CTTrial; index: number }) {
  const pass = trialPassed(trial);
  return (
    <details className="ct-trial">
      <summary>
        <span className="ct-trial-no ui-num">{index + 1}</span>
        <span className="ct-trial-name">{trial.spec.name}</span>
        <span className={`ct-trial-ret ui-num ${tone(trial.development.netReturnPct)}`}>{pct(trial.development.netReturnPct)}</span>
        <span className="ui-badge" data-tone={pass ? "accent" : undefined}>{pass ? "개발 기준 통과" : "검증 미달"}</span>
        <code className="ct-trial-hash">{trial.hash.slice(0, 10)}</code>
      </summary>
      <div className="ct-trial-body ui-korean">
        <dl className="ct-prose">
          <div><dt>현상</dt><dd>{trial.hypothesis.phenomenon}</dd></div>
          <div><dt>이유</dt><dd>{trial.hypothesis.mechanism}</dd></div>
          <div><dt>반증 조건</dt><dd>{trial.hypothesis.falsification}</dd></div>
          <div><dt>실패 국면</dt><dd>{trial.hypothesis.failureRegimes.join(" · ")}</dd></div>
          {trial.parentId ? (
            <>
              <div><dt>관측 문제</dt><dd>{trial.observedProblem}</dd></div>
              <div><dt>변경</dt><dd>{trial.changes.join(" · ")}</dd></div>
              <div><dt>기대 효과</dt><dd>{trial.expectedEffect}</dd></div>
            </>
          ) : null}
        </dl>
        <pre>{ctRuleText(trial.spec)}</pre>
        <SliceTable trial={trial} />
        <p className="ui-sub">
          {trial.reasons.join(" · ") || "서버 개발 기준 충족. 독립 검토·최종 평가는 별도입니다."}
        </p>
        <p className="ui-sub ui-num">
          민감도 {trial.sensitivity.map((s) => `${s.change}: ${s.result.netReturnPct.toFixed(2)}%`).join(" · ")}
        </p>
      </div>
    </details>
  );
}
const TrialHistory = memo(
  function TrialHistory({ trials }: { trials: CTTrial[] }) {
    return (
      <section className="ct-section" aria-labelledby="ct-trials-h">
        <h2 className="ui-title" id="ct-trials-h">후보와 수정 이력 <span className="ct-count ui-num">{trials.length}</span></h2>
        {trials.length ? (
          <div className="ct-trials">
            {trials.map((t, i) => <TrialItem key={t.id} trial={t} index={i} />)}
          </div>
        ) : (
          <p className="ui-sub">데이터와 출처를 확인한 뒤 모델이 후보를 설계합니다.</p>
        )}
      </section>
    );
  },
  (a, b) => a.trials.length === b.trials.length && a.trials.at(-1)?.id === b.trials.at(-1)?.id,
);

const Sources = memo(
  function Sources({ sources, approaches }: { sources: CTSource[]; approaches: CTResearch["approaches"] }) {
    return (
      <section className="ct-section" aria-labelledby="ct-sources-h">
        <h2 className="ui-title" id="ct-sources-h">조사 출처 <span className="ct-count ui-num">{sources.length}</span></h2>
        <div className="ct-sources">
          {sources.map((s) => (
            <article className="ct-source" key={s.id}>
              <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
              <small>
                원문 확인 {new Date(s.fetchedAt).toLocaleString("ko-KR")} · 게시일 미확인 · <code>{s.hash.slice(0, 12)}</code>
              </small>
              {approaches?.filter((a) => a.sourceId === s.id).map((a, i) => (
                <details className="ui-disclosure" key={i}>
                  <summary>{a.trader}<small>원리·구현 가정</small></summary>
                  <div className="ui-disclosure-body ui-korean">
                    <p>{a.principle}</p>
                    <blockquote>{a.quote}</blockquote>
                    <p>가격·거래량 구조: {a.structure} · 국면: {a.regime}</p>
                    <p>구현 가정: {a.approximation} · 재량 요소: {a.discretionary}</p>
                  </div>
                </details>
              ))}
            </article>
          ))}
        </div>
        <p className="ui-sub">공개 자료는 가설의 출처입니다. 역사적 검증 이후 공개된 접근법일 수 있어 전향 모의투자가 필요합니다.</p>
      </section>
    );
  },
  (a, b) => a.sources.length === b.sources.length && a.approaches?.length === b.approaches?.length,
);

/** The designer's research: sessions, every training query, rejected hypotheses and training-gate rejections. */
const ResearchSessions = memo(
  function ResearchSessions({ ct }: { ct: CTResearch }) {
    const sessions = ct.sessions ?? [];
    if (!sessions.length && !ct.sourceNote) return null;
    return (
      <section className="ct-section" aria-labelledby="ct-sessions-h">
        <h2 className="ui-title" id="ct-sessions-h">설계 세션 <span className="ct-count ui-num">{sessions.length}</span></h2>
        {ct.sourceNote ? <p className="ui-sub">{ct.sourceNote}</p> : null}
        {sessions.map((s) => {
          const queries = (ct.queries ?? []).filter((q) => q.session === s.index);
          const screened = (ct.screened ?? []).filter((t) => t.session === s.index);
          return (
            <details className="ui-disclosure" key={s.index} open={s.status === "open"}>
              <summary>
                세션 {s.index + 1} · {s.status === "open" ? "진행 중" : s.status === "submitted" ? "제출" : "실패"}
                <small className="ui-num">턴 {s.turns} · 도구 {s.toolCalls} · 조회 {queries.length} · 사전 검사 {s.screens}{s.endReason ? ` · ${s.endReason}` : ""}</small>
              </summary>
              <div className="ui-disclosure-body ui-korean">
                {s.submission?.noEdgeReason ? <p><b>우위 없음 판단</b> {s.submission.noEdgeReason}</p> : null}
                {s.submission?.rejectedHypotheses.length ? (
                  <>
                    <p><b>기각한 가설</b></p>
                    <ul>
                      {s.submission.rejectedHypotheses.map((h, i) => (
                        <li key={i}>{h.hypothesis} — {h.result} <small className="ui-num">{h.evidence.join(", ")}</small></li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {queries.length ? (
                  <>
                    <p><b>학습 구간 조회</b></p>
                    <ul>
                      {queries.map((q) => (
                        <li key={q.queryId}><code>{q.queryId}</code> {q.features.map((f) => (f.timeframe > 1 ? `${f.feature}(${f.timeframe}분)` : f.feature)).join(" · ")} — {q.summary}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {screened.length ? (
                  <>
                    <p><b>학습 게이트 탈락 · 개발 미실행</b></p>
                    <ul>
                      {screened.map((t) => (
                        <li key={t.id}>{t.candidate.spec.name} — {t.reasons.join(" · ")} <small className="ui-num">학습 {t.training.netReturnPct.toFixed(2)}%</small></li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </details>
          );
        })}
      </section>
    );
  },
  (a, b) => JSON.stringify(a.ct.sessions) === JSON.stringify(b.ct.sessions) && a.ct.queries?.length === b.ct.queries?.length && a.ct.screened?.length === b.ct.screened?.length,
);

/** Chart evidence for any candidate (the latest by default); the frozen final result only belongs to the latest. */
function TradeEvidencePanel({
  jobId,
  trials,
  latestId,
  final,
  currency,
}: {
  jobId: string;
  trials: Array<{ id: string; spec: CTSpec; training: CTResult; development: CTResult }>;
  latestId: string;
  final?: CTResult;
  currency: string;
}) {
  const [picked, setPicked] = useState(latestId);
  const trial = trials.find((t) => t.id === picked) ?? trials.at(-1)!;
  return (
    <>
      {trials.length > 1 ? (
        <label className="ui-field ct-evidence-pick">
          <span>차트를 볼 후보</span>
          <select aria-label="차트를 볼 후보" value={trial.id} onChange={(e) => setPicked(e.target.value)}>
            {trials.map((t, i) => (
              <option key={t.id} value={t.id}>
                후보 {i + 1} · {t.spec.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <TradeEvidence
        key={trial.id}
        jobId={jobId}
        spec={trial.spec}
        currency={currency}
        results={final && trial.id === latestId ? [trial.training, trial.development, final] : [trial.training, trial.development]}
      />
    </>
  );
}

function TradeEvidence({
  jobId,
  results,
  currency,
  spec,
}: {
  jobId: string;
  results: CTResult[];
  currency: string;
  spec: CTSpec;
}) {
  const trades = results.flatMap((r) => r.trades),
    [index, setIndex] = useState(0),
    [bars, setBars] = useState<CTBar[] | null>(null),
    [error, setError] = useState<string | null>(null);
  const trade = trades[index] ?? trades[0],
    chartSymbol = trade?.symbol,
    chartExit = trade?.exitAt;
  useEffect(() => {
    if (!chartSymbol || chartExit === undefined) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      setBars(null);
      setError(null);
    });
    fetch(
      `/api/invest/ct?chart=1&id=${encodeURIComponent(jobId)}&symbol=${encodeURIComponent(chartSymbol)}&at=${chartExit}`,
      { signal: controller.signal },
    )
      .then(async (r) => {
        const p = (await r.json()) as { error?: string; bars: CTBar[] };
        if (!r.ok) throw new Error(p.error);
        if (!controller.signal.aborted) setBars(p.bars);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, [jobId, chartSymbol, chartExit]);
  if (!trades.length)
    return (
      <section className="ct-section">
        <h2 className="ui-title">차트 판단 근거</h2>
        <p className="ui-sub">측정된 거래 사례 없음. 무거래와 미실행은 연구 상태에서 구분됩니다.</p>
      </section>
    );
  return (
    <section className="ct-section" aria-labelledby="ct-evidence-h">
      <div className="ui-card-head">
        <h2 className="ui-title" id="ct-evidence-h">차트 판단 근거 <span className="ct-sub-title">대표 수익·손실 사례</span></h2>
        <label className="ui-field ct-evidence-pick">
          <span className="ui-sr-only">거래 사례</span>
          <select
            aria-label="거래 사례"
            value={trades[index] ? index : 0}
            onChange={(e) => setIndex(Number(e.target.value))}
          >
            {trades.map((t, i) => (
              <option key={`${t.symbol}${t.entryAt}${i}`} value={i}>
                {t.symbol} · {new Date(t.entryAt).toLocaleDateString("ko-KR")} · {CT_EXIT_REASON_TEXT[t.reason] ?? t.reason}{t.management?.moves.length ? ` · 손절선 ${t.management.moves.length}회 상향` : ""} · {t.pnl.toFixed(2)} {currency}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <div className="ui-alert" data-tone="quiet" role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          <div><strong>증거 차트를 불러오지 못했습니다</strong><p>{error}</p></div>
        </div>
      ) : bars && trade ? (
        <CTEvidenceChart
          key={`${trade.symbol}${trade.entryAt}`}
          bars={bars}
          trade={trade}
          currency={currency}
          spec={spec}
        />
      ) : (
        <p className="ui-sub">엔진 차트 데이터 불러오는 중…</p>
      )}
    </section>
  );
}

export function CTWorkspace({onPrepareData}:{onPrepareData?:()=>void}) {
  const [market, setMarket] = useState<CTMarket>("stock"),
    [data, setData] = useState<CTResponse | null>(null),
    [selected, setSelected] = useState(""),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [brief, setBrief] = useState(""),
    [symbols, setSymbols] = useState(""),
    [budget, setBudget] = useState(8),
    [capital, setCapital] = useState(""),
    [days, setDays] = useState(""),
    [ready, setReady] = useState(false),
    [streamed, setStreamed] = useState<ResearchMeter | null>(null),
    [clock, setClock] = useState(() => Date.now());
  const advancing = useRef(false),
    loading = useRef(false),
    lastRaw = useRef(""),
    marketRef = useRef(market);
  useEffect(() => {
    marketRef.current = market;
  }, [market]);
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("qquan.ct.v1") ?? "null");
      if (stored)
        queueMicrotask(() => {
          if (stored.market === "stock" || stored.market === "crypto")
            setMarket(stored.market);
          setSelected(stored.selected ?? "");
          setBrief(stored.brief ?? "");
          setSymbols(stored.symbols ?? "");
          setBudget([8, 16, 24].includes(stored.budget) ? stored.budget : 8);
          setCapital(stored.capital ?? "");
          setDays(stored.days ?? "");
        });
    } catch {
      /* Storage is optional. */
    }
    queueMicrotask(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(
        "qquan.ct.v1",
        JSON.stringify({
          market,
          selected,
          brief,
          symbols,
          budget,
          capital,
          days,
        }),
      );
    } catch {
      /* Storage is optional. */
    }
  }, [ready, market, selected, brief, symbols, budget, capital, days]);
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const r = await fetch(`/api/invest/ct?market=${market}`, {
        cache: "no-store",
      });
      // Compare the raw payload so an unchanged poll never re-renders the tree.
      const text = await r.text();
      const p = JSON.parse(text) as CTResponse & { error?: string };
      if (!r.ok) throw new Error(p.error);
      if (marketRef.current === market) {
        if (text !== lastRaw.current) {
          lastRaw.current = text;
          setData(p);
        }
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "CT 연결 실패");
    } finally {
      loading.current = false;
    }
  }, [market]);
  useEffect(() => {
    queueMicrotask(() => {
      lastRaw.current = "";
      setData(null);
      void load();
    });
  }, [load]);
  const anyRunning = Boolean(data?.jobs.some((j) => j.status === "running") || data?.blocking);
  useEffect(() => {
    // The usage snapshot is written every ~2s during a model call; poll at that pace only while
    // something runs, and not at all in a background tab (it catches up on return).
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, anyRunning ? 2000 : 5000);
    const back = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [load, anyRunning]);
  useEffect(() => {
    if (!data?.blocking) return;
    queueMicrotask(() => setClock(Date.now()));
    const id = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [data?.blocking]);
  const runningId = data?.jobs.find((j) => j.status === "running")?.id;
  useEffect(() => {
    // A research that starts (here or from a resumed one) takes the stage once; picking another later sticks.
    if (runningId) queueMicrotask(() => setSelected(runningId));
  }, [runningId]);
  const job = data?.jobs.find((j) => j.id === selected) ?? data?.jobs[0],
    ct = job?.ct;
  const cj = job && ct ? (job as CTJob) : undefined;
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/invest/ct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id: job?.id, ...extra }),
      });
      if (!r.ok) {
        const p = (await r.json()) as { error?: string };
        throw new Error(p.error);
      }
      const p = (await r.json()) as { job?: { id: string } };
      if (p.job) setSelected(p.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "CT 요청 실패");
    } finally {
      // A refused start usually means something else holds the slot; refresh so it shows.
      await load();
      setBusy(false);
    }
  };
  useEffect(() => {
    if (job?.status !== "running" || !ready) return;
    let disposed = false;
    const advance = async () => {
      if (advancing.current) return;
      advancing.current = true;
      try {
        const r = await fetch("/api/invest/ct", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "advance", id: job.id }),
        });
        if (!r.ok || !r.body) throw new Error(await r.text());
        // NDJSON: usage lines arrive with every streamed model chunk. Coalesce them to
        // at most ~4 renders a second; the last one always lands.
        const reader = r.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "",
          pending: ResearchMeter | null = null,
          flushAt = 0;
        const flush = () => {
          if (pending && !disposed) setStreamed(pending);
          pending = null;
        };
        for (;;) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const m = JSON.parse(line) as { type: string; meter?: ResearchMeter; message?: string };
            if (m.type === "usage" && m.meter) pending = m.meter;
            if (m.type === "error" && !disposed) setError(m.message ?? "CT 단계 실행 실패");
          }
          if (pending && Date.now() >= flushAt) {
            flush();
            flushAt = Date.now() + 250;
          }
          if (done) break;
        }
        flush();
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        advancing.current = false;
        if (!disposed) await load();
      }
    };
    void advance();
    const timer = setInterval(() => void advance(), 3500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status, load, ready]);
  const generate = () =>
    act("research", {
      requestId: crypto.randomUUID(),
      market,
      brief,
      budgetUsd: budget,
      ...(symbols.trim()
        ? {
            symbols: symbols
              .split(/[,\s]+/)
              .filter(Boolean)
              .map((s) => s.toUpperCase()),
          }
        : {}),
      ...(capital ? { capital: Number(capital) } : {}),
      ...(days ? { days: Number(days) } : {}),
    });
  const reportError = useCallback((m: string) => setError(m), []);
  const latestTrial = ct?.trials.at(-1);
  const live = cj ? isLive(cj.status) : false;
  const registeredThis = Boolean(job && data?.registered.some((p) => p.runId === job.id));
  const blocking = data?.blocking ?? null;
  const startBlocked = busy || data?.availability.ready === false || Boolean(runningId) || Boolean(blocking);
  const calls = cj ? mergeCalls(cj.calls, cj.status === "running" ? pickMeter(cj.id, cj.liveMeter, streamed) : null) : [];
  const blockingQuiet = blocking ? clock - Date.parse(blocking.updatedAt) : 0;
  const blockingStale = Boolean(blocking && !data?.runnerOnline && blockingQuiet > BLOCKING_STALE_MS);
  const chosenSymbols = symbols.trim() ? symbols.trim().toUpperCase().split(/[,\s]+/).filter(Boolean) : [market === "stock" ? "NVDA" : "BTCUSDT"];
  const summary = [
    chosenSymbols.join(", "),
    "1분봉",
    `${days || 365}일`,
    `예산 $${budget}`,
    capital ? `자본 ${Number(capital).toLocaleString("ko-KR")}` : "기본 자본",
  ].join(" · ");
  const preview = data?.costPreview;
  // The worst chosen symbol prices the contract (ctProfileCosts), so show that one.
  const previewRoundTrip = preview
    ? Math.max(...preview.perSymbol.filter((p) => !p.symbol || chosenSymbols.includes(p.symbol)).map((p) => p.roundTripPct), 0)
    : 0;
  const toggleSymbol = (s: string) => {
    const next = chosenSymbols.includes(s) ? chosenSymbols.filter((x) => x !== s) : [...chosenSymbols, s];
    setSymbols(next.length ? CRYPTO_SYMBOLS.filter((x) => next.includes(x)).join(", ") : "");
  };
  const runnerOnline = data?.runnerOnline ?? false;

  return (
    <div className="ct-workspace">
      {cj && live ? (
        <div className="ct-sticky" role="region" aria-label="연구 진행 상태">
          <LiveStatusBar job={cj} runnerOnline={runnerOnline} busy={busy} onAct={(a) => void act(a)} />
        </div>
      ) : null}

      <header className="ct-head">
        <h1><ChartCandlestick size={22} strokeWidth={1.9} aria-hidden="true" />차트 트레이딩</h1>
        <p className="ui-sub">공개 접근법 조사부터 실제 실험까지. 검증된 규칙을 모의·실전 운용으로 연결합니다.</p>
      </header>

      <div className="ct-market">
        <div className="ui-segmented" role="group" aria-label="CT 시장">
          {(["stock", "crypto"] as const).map((m) => (
            <button
              key={m}
              aria-pressed={market === m}
              onClick={() => {
                setMarket(m);
                setSelected("");
                setSymbols("");
                setCapital("");
              }}
            >
              {m === "stock" ? "주식" : "코인"}
            </button>
          ))}
        </div>
        <span className="ui-sub">
          {market === "stock"
            ? "Toss · 미국 현금 주식 · USD"
            : "Binance BTCUSDT · USDT 현물 연구 · Upbit 실행 미지원"}
        </span>
      </div>

      <section className="ct-start ui-card pad" aria-labelledby="ct-start-h">
        <div className="ct-start-head">
          <div>
            <h2 className="ui-title" id="ct-start-h">전략 연구 시작</h2>
            <p className="ui-sub ui-num">{summary}</p>
            {preview ? (
              <p className="ui-sub" data-testid="ct-cost-profile">
                비용 프로필: {preview.label} v{preview.version}{preview.provisional ? " (잠정 · 호가 측정 72시간 미만)" : ""} · 왕복 {previewRoundTrip.toFixed(3)}%{preview.feeVerified ? "" : " · 수수료 공식 문서 미확인"}
              </p>
            ) : null}
            <p className="ui-sub">기본 설정으로 시작할 수 있습니다. 생성 완료와 매매 시작은 별도입니다.</p>
          </div>
          <button className="ui-btn primary lg" disabled={startBlocked} onClick={() => void generate()}>
            {busy ? <RefreshCw size={15} className="spin" aria-hidden="true" /> : <ChartCandlestick size={15} aria-hidden="true" />}
            전략 생성
          </button>
        </div>
        {job?.status === "running" ? (
          <p className="ui-sub">진행 중인 연구가 끝나거나 취소되면 새 연구를 시작할 수 있습니다.</p>
        ) : null}
        {blocking ? (
          <div className="ui-alert ct-blocking" data-tone={blockingStale ? undefined : "info"} role="alert">
            {blockingStale ? <TriangleAlert size={16} aria-hidden="true" /> : <Info size={16} aria-hidden="true" />}
            <div>
              <strong>
                {blockingStale
                  ? `실행 중인 연구가 ${quietFor(blockingQuiet)}째 멈춰 있어 새로 시작할 수 없습니다`
                  : "실행 중인 연구가 있어 새로 시작할 수 없습니다"}
              </strong>
              <p>
                {BLOCKING_KIND[blocking.kind]}
                {blocking.phase ? ` · ${CT_PHASES[blocking.phase as keyof typeof CT_PHASES] ?? blocking.phase}` : ""} · {clockTime(blocking.createdAt)} 시작 · 마지막 갱신 {clockTime(blocking.updatedAt)} · 비용 ${blocking.costUsd.toFixed(2)} / ${blocking.budgetUsd}
              </p>
              <p>
                {blocking.mine
                  ? blocking.kind === "slot"
                    ? "전략 탭에서 진행 상황을 볼 수 있습니다."
                    : `${blocking.kind === "ct-crypto" ? "코인" : "주식"} 시장을 선택하면 진행 상황을 볼 수 있습니다.`
                  : "다른 브라우저 세션에서 시작한 연구라 이 화면에서는 세부 진행을 볼 수 없습니다. 시작한 브라우저 창에서 단계별 진행을 볼 수 있습니다."}
                {blockingStale
                  ? " 진행시키던 화면이 닫혔고 러너도 꺼져 있습니다. 그 창을 다시 열거나 연구 러너를 켜면 저장된 단계에서 이어집니다."
                  : ""}
              </p>
              {blockingStale ? <code className="ct-blocking-cmd">{RUNNER_COMMAND}</code> : null}
            </div>
            <div className="ct-blocking-actions">
              {blocking.mine && blocking.kind !== "slot" && blocking.kind !== `ct-${market}` ? (
                <button
                  className="ui-btn sm"
                  onClick={() => {
                    setMarket(blocking.kind === "ct-crypto" ? "crypto" : "stock");
                    setSelected(blocking.id);
                  }}
                >
                  {blocking.kind === "ct-crypto" ? "코인" : "주식"} 연구 보기
                </button>
              ) : null}
              <button
                className="ui-btn sm"
                disabled={busy}
                onClick={() => void act("cancel_blocking", { id: blocking.id })}
              >
                <X size={13} aria-hidden="true" />이 연구 취소
              </button>
            </div>
          </div>
        ) : null}
        <details className="ui-disclosure ct-options">
          <summary>선택 설정<small>연구 방향, 종목, 예산, 자본</small></summary>
          <div className="ui-disclosure-body">
            <div className="ct-form">
              <label className="ui-field ct-form-wide">
                <span>연구 방향</span>
                <textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  placeholder="예: 거래량이 줄어드는 눌림목을 연구해줘"
                  maxLength={1500}
                />
              </label>
              {market === "crypto" ? (
                <div className="ui-field" role="group" aria-label="코인 종목">
                  <span>종목 (1–3개)</span>
                  <div className="ui-segmented">
                    {CRYPTO_SYMBOLS.map((s) => (
                      <button key={s} type="button" aria-pressed={chosenSymbols.includes(s)} onClick={() => toggleSymbol(s)}>
                        {s.replace("USDT", "")}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <label className="ui-field">
                  <span>종목 범위</span>
                  <input
                    value={symbols}
                    onChange={(e) => setSymbols(e.target.value)}
                    placeholder="기본 NVDA"
                  />
                </label>
              )}
              <label className="ui-field">
                <span>연구 기간 (일)</span>
                <input
                  type="number"
                  min="90"
                  max="1095"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  placeholder="기본 365"
                />
              </label>
              <label className="ui-field">
                <span>연구 API 예산</span>
                <select value={budget} onChange={(e) => setBudget(Number(e.target.value))}>
                  {[8, 16, 24].map((n) => (
                    <option key={n} value={n}>${n}</option>
                  ))}
                </select>
              </label>
              <label className="ui-field">
                <span>운용 자본 ({market === "stock" ? "USD" : "USDT"})</span>
                <input
                  type="number"
                  min="1"
                  value={capital}
                  onChange={(e) => setCapital(e.target.value)}
                  placeholder={market === "stock" ? "1,000" : "1,000,000"}
                />
              </label>
            </div>
          </div>
        </details>
        {data && !data.availability.ready ? (
          <div className="ui-alert" role="alert">
            <TriangleAlert size={16} aria-hidden="true" />
            <div>
              <strong>연구 모델 설정 필요</strong>
              <p>{data.availability.missing.join(", ")}</p>
            </div>
          </div>
        ) : null}
        {error ? (
          <div className="ui-alert" data-tone="danger" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <div><strong>요청 실패</strong><p>{error}</p></div>
            {onPrepareData ? <button className="ui-btn sm" onClick={onPrepareData}>저장소·연결 확인</button> : null}
          </div>
        ) : null}
      </section>

      <section className="ct-progress-section" aria-labelledby="ct-progress-h">
        <div className="ui-card-head">
          <h2 className="ui-title" id="ct-progress-h">연구 진행</h2>
          <div className="ct-progress-tools">
            {!cj && data ? (
              <span className="ui-badge" data-tone={runnerOnline ? undefined : "warn"}>
                <span className="ui-dot" data-tone={runnerOnline ? "done" : "warn"} aria-hidden="true" />
                러너 {runnerOnline ? "온라인" : "오프라인"}
              </span>
            ) : null}
            {data?.jobs.length ? (
              <ResearchPicker jobs={data.jobs} currentId={job?.id ?? ""} onSelect={setSelected} />
            ) : null}
            {cj ? (
              <button className="ui-btn sm" onClick={() => download(job, `ct-${job?.id}.json`)}>
                <Download size={13} aria-hidden="true" />연구 기록 다운로드
              </button>
            ) : null}
          </div>
        </div>

        {cj ? (
          <>
            {!live ? <LiveStatusBar job={cj} runnerOnline={runnerOnline} busy={busy} onAct={(a) => void act(a)} /> : null}
            {live ? (
              <NowPanel job={cj} calls={calls} driver={runnerOnline ? "runner" : "here"} />
            ) : null}
            {cj.status === "running" && !runnerOnline ? (
              <div className="ui-alert" data-tone="info" role="status">
                <Info size={16} aria-hidden="true" />
                <div>
                  <strong>백그라운드 러너가 꺼져 있습니다</strong>
                  <p>이 탭에서 단계를 실행하고 있습니다. 탭을 닫으면 연구는 저장된 단계에서 대기합니다.</p>
                </div>
              </div>
            ) : null}
            {/* A transient error with a scheduled retry is shown in the now panel, not as a failure. */}
            {cj.error && !(cj.status === "running" && cj.recovery?.retryAt) ? (
              <div className="ui-alert" data-tone="danger" role="alert">
                <CircleAlert size={16} aria-hidden="true" />
                <div>
                  <strong>{cj.error}</strong>
                  {cj.nextAction ? <p>{cj.nextAction}</p> : null}
                </div>
                {onPrepareData ? <button className="ui-btn sm" onClick={onPrepareData}>데이터 설정 열기</button> : null}
              </div>
            ) : null}
            <div className="ct-progress-grid">
              <PhaseStepper job={cj} />
              <div className="ct-progress-main">
                <LatestTrialCard trial={latestTrial} index={cj.ct.trials.length} total={cj.ct.contract.policy.maxCandidates} />
                <ActivityFeed
                  key={cj.id}
                  jobId={cj.id}
                  tools={cj.ct.tools}
                  calls={calls}
                  live={live}
                  onDownload={download}
                  onError={reportError}
                />
              </div>
            </div>
          </>
        ) : (
          <div className="ui-empty">
            <strong>아직 연구가 없습니다</strong>
            <p>전략 생성을 누르면 연구 계약을 저장하고, 에이전트가 공개 자료 조사와 실제 시장 실험을 시작합니다. 진행 상황은 이 자리에 단계별로 표시됩니다.</p>
          </div>
        )}
      </section>

      {cj?.ct.endReason ? (
        <section className="ct-result ui-card pad" data-passed={cj.ct.passed ? "true" : "false"} aria-labelledby="ct-result-h">
          <div className="ct-result-head">
            <div>
              <h2 className="ui-title" id="ct-result-h">{cj.ct.passed ? "검증 통과 전략" : "통과 전략 없음"}</h2>
              <p className="ui-sub">
                {cj.ct.passed
                  ? cj.ct.endReason
                  : `연구는 정상적으로 종료되었습니다. 기준을 넘은 후보가 없어 등록할 전략이 없습니다. ${cj.ct.endReason}`}
              </p>
              {cj.ct.frozenHash ? <code className="ct-hash">{cj.ct.frozenHash}</code> : null}
            </div>
            {cj.ct.passed ? (
              <button className="ui-btn primary lg" disabled={busy || registeredThis} onClick={() => void act("register")}>
                {registeredThis ? "등록됨" : "전략 등록"}
              </button>
            ) : null}
          </div>
          {cj.ct.final ? (
            <>
              <h3 className="ui-label">동결 규칙 최종 평가</h3>
              <FinalMetrics result={cj.ct.final} />
            </>
          ) : null}
        </section>
      ) : null}

      {cj ? <ResearchSessions ct={cj.ct} /> : null}

      {cj ? <TrialHistory trials={cj.ct.trials} /> : null}

      {cj && latestTrial ? (
        <TradeEvidencePanel
          jobId={cj.id}
          trials={cj.ct.trials}
          latestId={latestTrial.id}
          final={cj.ct.final}
          currency={cj.ct.contract.currency}
        />
      ) : null}

      {cj && cj.ct.sources.length ? <Sources sources={cj.ct.sources} approaches={cj.ct.approaches} /> : null}

      {cj ? (
        <details className="ui-disclosure ct-advanced">
          <summary>고급<small>동결 계약, 독립 검토, 원시 기록</small></summary>
          <div className="ui-disclosure-body">
            <p className="ui-sub ui-num">
              학습 ~{new Date(cj.ct.contract.trainingToMs).toLocaleDateString("ko-KR")} · 개발 ~
              {new Date(cj.ct.contract.developmentToMs).toLocaleDateString("ko-KR")} · 최종 ~
              {new Date(cj.ct.contract.toMs).toLocaleDateString("ko-KR")} · 최종 기간 {cj.ct.finalConsumed ? "소진" : "미개봉"}
            </p>
            <pre>{JSON.stringify({ contract: cj.ct.contract, inventory: cj.ct.inventory, dataHash: cj.ct.dataHash }, null, 2)}</pre>
            {cj.ct.riskReview || cj.ct.finalReview ? (
              <>
                <h3 className="ui-label">독립 검토 결과</h3>
                <pre>{JSON.stringify({ risk: cj.ct.riskReview, final: cj.ct.finalReview }, null, 2)}</pre>
              </>
            ) : null}
          </div>
        </details>
      ) : null}

      {data?.registered.length ? (
        <section className="ct-section" aria-labelledby="ct-reg-h">
          <h2 className="ui-title" id="ct-reg-h">등록된 전략 <span className="ct-count ui-num">{data.registered.length}</span></h2>
          <ul className="ct-registered">
            {data.registered.map((p) => (
              <li key={p.id}>
                <span className="ct-registered-name">{p.spec.name}</span>
                <code>버전 {p.hash.slice(0, 12)}</code>
                <button className="ui-btn sm" onClick={() => download(p, `${p.id}.json`)}>
                  <Download size={13} aria-hidden="true" />전략 패키지 다운로드
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <TradingDashboards
        key={market}
        book={market === "stock" ? "ct-stock" : "ct-crypto"}
      />
    </div>
  );
}
