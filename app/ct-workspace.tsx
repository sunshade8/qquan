"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import ChartCandlestick from "lucide-react/dist/esm/icons/chart-candlestick";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert";
import Download from "lucide-react/dist/esm/icons/download";
import Info from "lucide-react/dist/esm/icons/info";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import type { GenerationJob } from "@/lib/strategy-generation-types";
import type { CTPackage } from "@/lib/ct-research-store";
import type { CTBar, CTResult } from "@/lib/ct-engine";
import type { CTResearch, CTSource, CTTrial } from "@/lib/ct-research";
import { ctRuleText, type CTSpec, type CTMarket } from "@/lib/ct-spec";
import { CTEvidenceChart } from "./ct-evidence-chart";
import { TradingDashboards } from "./trading-dashboards";
import {
  ActivityFeed,
  CT_PHASES,
  LatestTrialCard,
  LiveStatusBar,
  PhaseStepper,
  isLive,
  trialPassed,
  type CTJob,
} from "./ct-progress";
import { ResearchPicker } from "./ct-picker";

export { CT_PHASES };

type CTResponse = {
  jobs: Omit<GenerationJob, "ownerId">[];
  registered: CTPackage[];
  availability: { ready: boolean; missing: string[] };
  runnerOnline: boolean;
};
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
const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
const money = (n: number) => n.toLocaleString("ko-KR", { maximumFractionDigits: 4 });

/** 동결 규칙 최종 평가 요약. */
function FinalMetrics({ result }: { result: CTResult }) {
  return (
    <div className="ui-metrics">
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
    ["순수익", (r) => <span className={tone(r.netReturnPct)}>{pct(r.netReturnPct)}</span>],
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
                {t.symbol} · {new Date(t.entryAt).toLocaleDateString("ko-KR")} · {t.reason} · {t.pnl.toFixed(2)} {currency}
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
    [minutes, setMinutes] = useState(""),
    [budget, setBudget] = useState(8),
    [capital, setCapital] = useState(""),
    [ready, setReady] = useState(false);
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
          setMinutes(stored.minutes ?? "");
          setBudget([8, 16, 24].includes(stored.budget) ? stored.budget : 8);
          setCapital(stored.capital ?? "");
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
          minutes,
          budget,
          capital,
        }),
      );
    } catch {
      /* Storage is optional. */
    }
  }, [ready, market, selected, brief, symbols, minutes, budget, capital]);
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
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
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
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "CT 요청 실패");
    } finally {
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
        await fetch("/api/invest/ct", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "advance", id: job.id }),
        }).then(async (r) => {
          const body = await r.text();
          if (!r.ok) throw new Error(body);
        });
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
      ...(minutes ? { minutes: Number(minutes) } : {}),
      ...(capital ? { capital: Number(capital) } : {}),
    });
  const reportError = useCallback((m: string) => setError(m), []);
  const latestTrial = ct?.trials.at(-1);
  const live = cj ? isLive(cj.status) : false;
  const registeredThis = Boolean(job && data?.registered.some((p) => p.runId === job.id));
  const startBlocked = busy || data?.availability.ready === false || job?.status === "running";
  const summary = [
    symbols.trim() ? symbols.trim().toUpperCase().split(/[,\s]+/).join(", ") : market === "stock" ? "NVDA" : "BTCUSDT",
    minutes ? `${minutes}분봉` : "시장 기본 봉",
    `예산 $${budget}`,
    capital ? `자본 ${Number(capital).toLocaleString("ko-KR")}` : "기본 자본",
  ].join(" · ");
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
        <details className="ui-disclosure ct-options">
          <summary>선택 설정<small>연구 방향, 종목, 주기, 예산</small></summary>
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
              <label className="ui-field">
                <span>종목 범위</span>
                <input
                  value={symbols}
                  onChange={(e) => setSymbols(e.target.value)}
                  placeholder={market === "stock" ? "기본 NVDA" : "기본 BTCUSDT"}
                />
              </label>
              <label className="ui-field">
                <span>봉 주기</span>
                <select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
                  <option value="">시장 기본값</option>
                  {[5, 15, 60].map((n) => (
                    <option key={n} value={n}>{n}분</option>
                  ))}
                </select>
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
            {cj.status === "running" && !runnerOnline ? (
              <div className="ui-alert" data-tone="info" role="status">
                <Info size={16} aria-hidden="true" />
                <div>
                  <strong>백그라운드 러너가 꺼져 있습니다</strong>
                  <p>이 탭에서 단계를 실행하고 있습니다. 탭을 닫으면 연구는 저장된 단계에서 대기합니다.</p>
                </div>
              </div>
            ) : null}
            {cj.error ? (
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
                  modelCalls={cj.calls?.length ?? 0}
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

      {cj ? <TrialHistory trials={cj.ct.trials} /> : null}

      {cj && latestTrial ? (
        <TradeEvidence
          key={latestTrial.id}
          jobId={cj.id}
          spec={latestTrial.spec}
          currency={cj.ct.contract.currency}
          results={
            cj.ct.final
              ? [latestTrial.training, latestTrial.development, cj.ct.final]
              : [latestTrial.training, latestTrial.development]
          }
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
