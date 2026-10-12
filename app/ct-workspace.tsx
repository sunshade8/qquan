"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ChartCandlestick from "lucide-react/dist/esm/icons/chart-candlestick";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import type { GenerationJob } from "@/lib/strategy-generation-types";
import type { CTPackage } from "@/lib/ct-research-store";
import type { CTBar, CTResult } from "@/lib/ct-engine";
import { ctRuleText, type CTSpec, type CTMarket } from "@/lib/ct-spec";
import { CTEvidenceChart } from "./ct-evidence-chart";
import { TradingDashboards } from "./trading-dashboards";
export const CT_PHASES = {
  data: "데이터·연구 계약",
  sources: "공개 접근법 검색",
  read: "원문 확인",
  approaches: "원리·구현 가정",
  design: "가설·규칙 설계",
  experiment: "실제 엔진 실험",
  reflect: "실패 진단·수정",
  risk_review: "독립 위험 검토",
  final: "동결 규칙 최종 평가",
  evidence_review: "독립 최종 검토",
  done: "연구 종료",
};
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
function ResultMetrics({ result, label }: { result: CTResult; label: string }) {
  return (
    <div className="ct-metrics">
      <b>{label}</b>
      <span>
        거래 {result.tradeCount ?? result.trades.length} · 무거래{" "}
        {result.emptyDays}일
      </span>
      <strong className={result.netReturnPct > 0 ? "positive" : "negative"}>
        {result.netReturnPct.toFixed(2)}%
      </strong>
      <span>
        낙폭 {result.maxDrawdownPct.toFixed(2)}% · 승률{" "}
        {result.winRatePct.toFixed(1)}%
      </span>
      <span>
        손익비 {result.payoff.toFixed(2)} · 기대값{" "}
        {result.expectancy.toFixed(4)}
      </span>
      <span>
        비용{" "}
        {result.costs.toLocaleString("ko-KR", { maximumFractionDigits: 4 })} ·
        준수 {result.compliancePct}%
      </span>
    </div>
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
      <p className="strategy-note">
        측정된 거래 사례 없음. 무거래와 미실행은 연구 상태에서 구분됩니다.
      </p>
    );
  return (
    <section>
      <h3>차트 판단 근거 · 대표 수익·손실 사례</h3>
      <select
        aria-label="거래 사례"
        value={trades[index] ? index : 0}
        onChange={(e) => setIndex(Number(e.target.value))}
      >
        {trades.map((t, i) => (
          <option key={`${t.symbol}${t.entryAt}${i}`} value={i}>
            {t.symbol} · {new Date(t.entryAt).toLocaleDateString("ko-KR")} ·{" "}
            {t.reason} · {t.pnl.toFixed(2)} {currency}
          </option>
        ))}
      </select>
      {error ? (
        <p role="alert">{error}</p>
      ) : bars && trade ? (
        <CTEvidenceChart
          key={`${trade.symbol}${trade.entryAt}`}
          bars={bars}
          trade={trade}
          currency={currency}
          spec={spec}
        />
      ) : (
        <p>엔진 차트 데이터 불러오는 중…</p>
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
      const p = (await r.json()) as CTResponse & { error?: string };
      if (!r.ok) throw new Error(p.error);
      if (marketRef.current === market) {
        setData(p);
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
      setData(null);
      void load();
    });
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const job = data?.jobs.find((j) => j.id === selected) ?? data?.jobs[0],
    ct = job?.ct;
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
  const latestTrial = ct?.trials.at(-1);
  return (
    <div className="ct-workspace">
      <header className="ct-title">
        <div>
          <span>CT — CHART TRADING</span>
          <h1>
            <ChartCandlestick size={25} />
            차트 트레이딩
          </h1>
          <p>
            공개 접근법 조사부터 실제 실험까지. 검증된 규칙을 모의·실전 운용으로
            연결합니다.
          </p>
        </div>
      </header>
      <nav className="trading-tabs" aria-label="CT 시장">
        {(["stock", "crypto"] as const).map((m) => (
          <button
            key={m}
            aria-pressed={market === m}
            className={market === m ? "active" : ""}
            onClick={() => {
              setMarket(m);
              setSelected("");
              setSymbols("");
              setCapital("");
            }}
          >
            <b>{m === "stock" ? "주식" : "코인"}</b>
            <small>
              {m === "stock"
                ? "Toss · 미국 현금 주식 · USD"
                : "Binance BTCUSDT · USDT 현물 연구 · Upbit 실행 미지원"}
            </small>
          </button>
        ))}
      </nav>
      <section className="ct-research-card">
        <div className="ct-section-head">
          <div>
            <h2>차트 트레이딩 전략 연구 에이전트</h2>
            <p>
              기본 설정으로 시작할 수 있습니다. 생성 완료와 매매 시작은
              별도입니다.
            </p>
          </div>
          <button
            className="ct-primary"
            disabled={
              busy ||
              data?.availability.ready === false ||
              job?.status === "running"
            }
            onClick={() => void generate()}
          >
            {busy ? (
              <RefreshCw size={14} className="spin" />
            ) : (
              <ChartCandlestick size={14} />
            )}
            전략 생성
          </button>
        </div>
        <details className="ct-settings">
          <summary>선택 설정 · 연구 방향, 종목, 주기, 예산</summary>
          <div className="ct-form">
            <label>
              연구 방향
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="예: 거래량이 줄어드는 눌림목을 연구해줘"
                maxLength={1500}
              />
            </label>
            <label>
              종목 범위
              <input
                value={symbols}
                onChange={(e) => setSymbols(e.target.value)}
                placeholder={
                  market === "stock" ? "기본 NVDA" : "기본 BTCUSDT"
                }
              />
            </label>
            <label>
              봉 주기
              <select
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              >
                <option value="">시장 기본값</option>
                {[5, 15, 60].map((n) => (
                  <option key={n} value={n}>
                    {n}분
                  </option>
                ))}
              </select>
            </label>
            <label>
              연구 API 예산
              <select
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
              >
                {[8, 16, 24].map((n) => (
                  <option key={n} value={n}>
                    ${n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              운용 자본 ({market === "stock" ? "USD" : "USDT"})
              <input
                type="number"
                min="1"
                value={capital}
                onChange={(e) => setCapital(e.target.value)}
                placeholder={market === "stock" ? "1,000" : "1,000,000"}
              />
            </label>
          </div>
        </details>
        {data && !data.availability.ready ? (
          <p className="strategy-warning">
            연구 모델 설정 필요: {data.availability.missing.join(", ")}
          </p>
        ) : null}
        {error ? (
          <p className="strategy-warning error" role="alert">
            {error} {onPrepareData && <button onClick={onPrepareData}>설정에서 1분봉 다운로드</button>}
          </p>
        ) : null}
        <div className="ct-section-head">
          <label>
            과거 연구
            <select
              value={job?.id ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">연구 선택</option>
              {data?.jobs.map((j) => (
                <option value={j.id} key={j.id}>
                  {new Date(j.createdAt).toLocaleString("ko-KR")} · {j.status} ·{" "}
                  {j.ct ? CT_PHASES[j.ct.phase] : ""}
                </option>
              ))}
            </select>
          </label>
          <span className="strategy-note">
            {data?.runnerOnline
              ? "백그라운드 러너 온라인"
              : job?.status === "running"
                ? "러너 오프라인 · 이 탭에서 단계 실행, 탭을 닫으면 대기"
                : "러너 오프라인 · 생성한 연구는 DB에 보존"}
          </span>
        </div>
        {job && ct ? (
          <>
            <div className="ct-progress" aria-live="polite">
              <strong>{CT_PHASES[ct.phase]}</strong>
              <span>
                {job.status} · 후보 {ct.trials.length}/
                {ct.contract.policy.maxCandidates} · 백테스트 {ct.backtests}회 ·
                API ${job.costUsd.toFixed(4)} / ${job.budgetUsd}
              </span>
              <span>
                데이터 {ct.dataCursor.pages}페이지 · 로컬 계산{" "}
                {(ct.computeMs / 1000).toFixed(1)}초
              </span>
            </div>
            {job.error ? (
              <p className="strategy-warning">
                {job.error} {job.nextAction} {onPrepareData && <button onClick={onPrepareData}>데이터 설정 열기</button>}
              </p>
            ) : null}
            <div className="ct-controls">
              {job.status === "running" ? (
                <>
                  <button disabled={busy} onClick={() => void act("pause")}>
                    일시정지
                  </button>
                  <button disabled={busy} onClick={() => void act("cancel")}>
                    취소
                  </button>
                </>
              ) : job.status === "paused" ? (
                <>
                  <button disabled={busy} onClick={() => void act("resume")}>
                    저장된 단계부터 재개
                  </button>
                  <button disabled={busy} onClick={() => void act("cancel")}>
                    취소
                  </button>
                </>
              ) : null}
              <button onClick={() => download(job, `ct-${job.id}.json`)}>
                연구 기록 다운로드
              </button>
              {ct.passed ? (
                <button
                  className="ct-primary"
                  disabled={
                    busy || data?.registered.some((p) => p.runId === job.id)
                  }
                  onClick={() => void act("register")}
                >
                  {data?.registered.some((p) => p.runId === job.id)
                    ? "등록됨"
                    : "전략 등록"}
                </button>
              ) : null}
            </div>
            <details>
              <summary>동결 연구 계약 · 데이터·비용·접근 범위</summary>
              <p className="strategy-note">
                학습 ~
                {new Date(ct.contract.trainingToMs).toLocaleDateString("ko-KR")}{" "}
                · 개발 ~
                {new Date(ct.contract.developmentToMs).toLocaleDateString(
                  "ko-KR",
                )}{" "}
                · 최종 ~{new Date(ct.contract.toMs).toLocaleDateString("ko-KR")}{" "}
                · 최종 기간 {ct.finalConsumed ? "소진" : "미개봉"}
              </p>
              <pre>
                {JSON.stringify(
                  {
                    contract: ct.contract,
                    inventory: ct.inventory,
                    dataHash: ct.dataHash,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {ct.sources.length ? (
              <section>
                <h3>조사한 접근법과 출처</h3>
                {ct.sources.map((s) => (
                  <article className="ct-source" key={s.id}>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.title}
                    </a>
                    <small>
                      원문 확인 {new Date(s.fetchedAt).toLocaleString("ko-KR")}{" "}
                      · 게시일 미확인 · {s.hash.slice(0, 12)}
                    </small>
                    {ct.approaches
                      ?.filter((a) => a.sourceId === s.id)
                      .map((a, i) => (
                        <div key={i}>
                          <b>{a.trader}</b>
                          <p>{a.principle}</p>
                          <blockquote>{a.quote}</blockquote>
                          <p>
                            가격·거래량 구조: {a.structure} · 국면: {a.regime}
                          </p>
                          <p>
                            구현 가정: {a.approximation} · 재량 요소:{" "}
                            {a.discretionary}
                          </p>
                        </div>
                      ))}
                  </article>
                ))}
                <p className="strategy-note">
                  공개 자료는 가설의 출처입니다. 역사적 검증 이후 공개된
                  접근법일 수 있어 전향 모의투자가 필요합니다.
                </p>
              </section>
            ) : null}
            <section>
              <h3>후보와 수정 이력</h3>
              {ct.trials.length ? (
                ct.trials.map((t, i) => (
                  <details
                    className="ct-trial"
                    key={t.id}
                    open={i === ct.trials.length - 1}
                  >
                    <summary>
                      {i + 1}. {t.spec.name} ·{" "}
                      {t.reasons.length ? "검증 미달" : "개발 기준 통과"} ·{" "}
                      {t.hash.slice(0, 10)}
                    </summary>
                    <p>{t.hypothesis.phenomenon}</p>
                    <p>왜: {t.hypothesis.mechanism}</p>
                    <p>반증 조건: {t.hypothesis.falsification}</p>
                    <p>실패 국면: {t.hypothesis.failureRegimes.join(" · ")}</p>
                    {t.parentId ? (
                      <p>
                        부모 {t.parentId} · 관측 문제 {t.observedProblem}
                        <br />
                        변경 {t.changes.join(" · ")} · 기대 {t.expectedEffect}
                      </p>
                    ) : null}

                    <pre>{ctRuleText(t.spec)}</pre>
                    <div className="ct-metric-grid">
                      <ResultMetrics result={t.training} label="학습" />
                      <ResultMetrics result={t.development} label="개발" />
                      <ResultMetrics result={t.stress} label="비용 2배" />
                      <ResultMetrics result={t.delayed} label="1봉 진입 지연" />
                    </div>
                    <p className="strategy-note">
                      {t.reasons.join(" · ") ||
                        "서버 개발 기준 충족. 독립 검토·최종 평가는 별도입니다."}
                    </p>
                    <p className="strategy-note">
                      민감도{" "}
                      {t.sensitivity
                        .map(
                          (s) =>
                            `${s.change}: ${s.result.netReturnPct.toFixed(2)}%`,
                        )
                        .join(" · ")}
                    </p>
                  </details>
                ))
              ) : (
                <p className="strategy-note">
                  데이터와 출처를 확인한 뒤 모델이 후보를 설계합니다.
                </p>
              )}
            </section>
            {ct.endReason ? (
              <div className={`ct-result ${ct.passed ? "positive" : ""}`}>
                <h3>{ct.passed ? "검증 통과 전략" : "통과 전략 없음"}</h3>
                <p>{ct.endReason}</p>
                {ct.frozenHash ? <code>{ct.frozenHash}</code> : null}
              </div>
            ) : null}
            {ct.final ? (
              <ResultMetrics result={ct.final} label="동결 규칙 최종 평가" />
            ) : null}
            {ct.riskReview || ct.finalReview ? (
              <details>
                <summary>독립 검토 결과</summary>
                <pre>
                  {JSON.stringify(
                    { risk: ct.riskReview, final: ct.finalReview },
                    null,
                    2,
                  )}
                </pre>
              </details>
            ) : null}
            {latestTrial ? (
              <TradeEvidence
                key={latestTrial.id}
                jobId={job.id}
                spec={latestTrial.spec}
                currency={ct.contract.currency}
                results={
                  ct.final
                    ? [latestTrial.training, latestTrial.development, ct.final]
                    : [latestTrial.training, latestTrial.development]
                }
              />
            ) : null}
            <details>
              <summary>
                실제 도구 호출·결과 {ct.tools.length}건 · 모델 호출{" "}
                {job.calls?.length ?? 0}건
              </summary>
              <ol className="ct-tools">
                {ct.tools.map((t, i) => (
                  <li key={`${t.id}${i}`}>
                    <b>{t.name}</b> · {t.status} · {t.at}
                    {t.status === "completed" ? (
                      <button
                        onClick={() =>
                          void fetch(
                            `/api/invest/ct?id=${encodeURIComponent(job.id)}&artifact=${t.id}`,
                          )
                            .then(async (r) => {
                              const p = (await r.json()) as { error?: string };
                              if (!r.ok) throw new Error(p.error);
                              download(p, `ct-tool-${t.id}.json`);
                            })
                            .catch((e) => setError(String(e)))
                        }
                      >
                        도구 결과·전체 거래 다운로드
                      </button>
                    ) : null}
                    <pre>
                      {JSON.stringify(
                        { input: t.input, output: t.output, error: t.error },
                        null,
                        2,
                      )}
                    </pre>
                  </li>
                ))}
              </ol>
            </details>
          </>
        ) : (
          <p className="research-empty">
            전략 생성을 누르면 연구 계약을 저장하고, 에이전트가 공개 자료 조사와
            실제 시장 실험을 시작합니다.
          </p>
        )}
        {data?.registered.length ? (
          <details>
            <summary>등록된 전략 {data.registered.length}개</summary>
            {data.registered.map((p) => (
              <p key={p.id}>
                {p.spec.name} · 버전 {p.hash.slice(0, 12)}{" "}
                <button onClick={() => download(p, `${p.id}.json`)}>
                  전략 패키지 다운로드
                </button>
              </p>
            ))}
          </details>
        ) : null}
      </section>
      <TradingDashboards
        key={market}
        book={market === "stock" ? "ct-stock" : "ct-crypto"}
      />
    </div>
  );
}
