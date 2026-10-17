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
import { mergeCalls, pickMeter, traderSummary } from "@/lib/ct-activity";
import { ctSessionPolicy } from "@/lib/ct-spec";
import type { ActiveGeneration } from "@/lib/strategy-generation-store";
import type { CTPackage } from "@/lib/ct-research-store";
import type { CTBar, CTResult } from "@/lib/ct-engine";
import type { CTResearch, CTSource, CTTrial } from "@/lib/ct-research";
import type { CTLessonView, CTCoverage, CTLessonsRecorded } from "@/lib/ct-lessons";
import { lessonsPanelModel, playbookAnchor } from "@/lib/ct-lessons-view";
import { ctRuleText, type CTSpec, type CTMarket } from "@/lib/ct-spec";
import { CTEvidenceChart } from "./ct-evidence-chart";
import { CT_EXIT_REASON_TEXT } from "@/lib/ct-trade-levels";
import { TradingDashboards } from "./trading-dashboards";
import { DataSyncCard, useStaleData } from "./ct-data-sync";
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
import type { CTCapability } from "@/lib/ct-capabilities";
import { ctDailyMetrics } from "@/lib/ct-experiment-stats";
import { CTValidation, CTConnectionStatus } from "./ct-validation";
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
  costPreview?: { label: string; version: number; provisional: boolean; feeVerified: boolean; fee?: { makerPct: number; takerPct: number; url: string; checkedAt: string }; executionNote?: string | null; perSymbol: Array<{ symbol: string; roundTripPct: number }> };
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
  const metrics=ctDailyMetrics(result.daily);
  return (
    <div className="ui-metrics">
      <div className="ui-metric"><span>최종 일평균 순수익</span><b className={tone(dayMean(result))}>{pct(dayMean(result), 3)}</b><small>{result.daily.length}일 · 기준 0% 초과</small></div>
      <div className="ui-metric"><span>수익일 비율</span><b>{metrics.positiveDayPct.toFixed(1)}%</b><small>무거래일 포함</small></div>
      <div className="ui-metric"><span>일간 샤프(연율화)</span><b>{metrics.sharpe?.toFixed(2)??"정의 불가"}</b></div>
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
    ["일간 샤프(연율화)",(r)=>ctDailyMetrics(r.daily,trial.spec.market==="stock"?252:365).sharpe?.toFixed(2)??"정의 불가"],
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

/**
 * The designer's thinking, turn by turn, from the session's stored messages. A stage-4 contract asks for summarized thinking;
 * an older contract stored only the signature, which is said plainly instead of shown as an empty box.
 */
function SessionThinking({ jobId, session, turns, summarized }: { jobId: string; session: number; turns: number; summarized: boolean }) {
  const [items, setItems] = useState<Array<{ turn: number; text: string; tools: string[] }> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/invest/ct?thinking=1&id=${encodeURIComponent(jobId)}&session=${session}`, { cache: "no-store" })
      .then(async (r) => {
        const body = (await r.json()) as { turns?: Array<{ turn: number; text: string; tools: string[] }> };
        if (!live) return;
        if (r.ok && body.turns) {
          setItems(body.turns);
          setFailed(false);
        } else setFailed(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [jobId, session, turns]);
  if (failed) return <p className="ui-sub">설계자 생각을 불러오지 못했습니다.</p>;
  if (!items) return <p className="ui-sub">설계자 생각 불러오는 중…</p>;
  if (!items.length) return null;
  return (
    <div className="ct-thinking" aria-label="설계자 생각(요약)">
      <p><b>설계자 생각(요약)</b></p>
      {items.map((t) => (
        <details className="ui-disclosure" key={t.turn}>
          <summary>
            턴 {t.turn}
            <small className="ui-num">{t.tools.length ? t.tools.join(" · ") : "도구 호출 없음"}</small>
          </summary>
          <div className="ui-disclosure-body ui-korean">
            {t.text ? <p className="ct-thinking-text">{t.text}</p> : <p className="ui-sub">{summarized ? "이 턴은 생각 요약이 없습니다(모델이 생각 없이 응답함)." : "기록 없음(이 계약은 생각 요약을 받지 않음)"}</p>}
          </div>
        </details>
      ))}
    </div>
  );
}

/** The designer's research: sessions, every training query, rejected hypotheses and training-gate rejections. */
const ResearchSessions = memo(
  function ResearchSessions({ ct, jobId }: { ct: CTResearch; jobId: string }) {
    const sessions = ct.sessions ?? [];
    if (!sessions.length && !ct.sourceNote) return null;
    const trader = traderSummary(ct);
    const ledger = ct.tests ? Object.keys(ct.tests.signatures).length : 0;
    return (
      <section className="ct-section" aria-labelledby="ct-sessions-h">
        <h2 className="ui-title" id="ct-sessions-h">설계 세션 <span className="ct-count ui-num">{sessions.length}</span></h2>
        {ct.sourceNote ? <p className="ui-sub">{ct.sourceNote}</p> : null}
        {ct.contract.repeat ? (
          <p className="ui-alert" data-tone="info" role="note">
            같은 판 {ct.contract.repeat.n}번째 실행 · 사유: {ct.contract.repeat.reason}
            <small className="ui-num"> 이전 실행 {ct.contract.repeat.previousRuns.map((id) => id.slice(0, 8)).join(", ")}</small>
          </p>
        ) : null}
        {ct.lessons ? (
          <p className="ui-sub ct-lessons-line" role="note">
            시작 때 받은 교훈 <b className="ui-num">{ct.lessons.entries.length}</b>개 · dead 계열 <b className="ui-num">{ct.lessons.deadFamilies.length}</b>개
            {ct.lessonsRecorded ? <> · 교훈 증류 <b>{lessonsStatus(ct.lessonsRecorded)}</b></> : ct.phase === "done" ? " · 교훈 증류 대기" : ""}
          </p>
        ) : null}
        {trader ? (
          <div className="ct-trader" aria-label="단타 고수 도구 요약">
            <ul className="ct-trader-stats">
              <li><b className="ui-num">{trader.events}</b> 이벤트 <small>라벨 {trader.labelSets}세트{trader.lastLabel ? ` · 하루 ${trader.lastLabel.eventsPerDay}건` : ""}</small></li>
              <li><b className="ui-num">{trader.topLift ? `×${trader.topLift.lift}` : "—"}</b> 최대 lift <small>{trader.topLift ? `${trader.topLift.feature} · ${trader.topLift.bin}` : "contrast 미실행"}</small></li>
              <li><b className="ui-num">{trader.chartsViewed}</b> 본 차트 <small>블라인드 {trader.blindSets}세트</small></li>
              <li><b className="ui-num">{trader.blindAccuracyPct === null ? "—" : `${trader.blindAccuracyPct}%`}</b> 보정 정답률 <small>{trader.blindP === null ? "미채점" : `p=${trader.blindP}`}</small></li>
              <li><b className="ui-num">{trader.lastDiagnosis ? `${trader.lastDiagnosis.losersTouched1RPct}% / ${trader.lastDiagnosis.losersNeverProfitablePct}%` : "—"}</b> 청산 / 진입 문제 <small>손실 거래 중 +1R 도달 / 수익권 미도달{trader.lastDiagnosis ? "" : " · 복기 미실행"}</small></li>
              <li><b className="ui-num">{ledger}</b> 가설 검정 <small>{ct.playbook ? `이전 연구 ${ct.playbook.cumulativeTests}회 별도` : "누적 장부"}</small></li>
            </ul>
            {ct.charts?.length ? (
              <div className="ct-thumbs" aria-label="설계자가 본 차트">
                {ct.charts.slice(-12).map((c) => (
                  <a key={c.chartId} className="ct-thumb" href={`/api/invest/ct?chartImage=${c.chartId}&id=${jobId}`} target="_blank" rel="noreferrer" title={`차트 #${c.n} · ${c.symbol}${c.blind ? " · 블라인드" : ""}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/invest/ct?chartImage=${c.chartId}&id=${jobId}`} alt={`차트 ${c.n} ${c.symbol}`} loading="lazy" />
                    <small>{c.blind ? "블라인드" : c.group === "positive" ? "이벤트" : c.group === "control" ? "대조군" : "조회 시점"} · #{c.n}</small>
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
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
                <SessionThinking jobId={jobId} session={s.index} turns={s.turns} summarized={ctSessionPolicy(ct.contract).toolsVersion >= 2} />
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
                {s.submission?.calibrationRefs?.length ? (
                  <p className="ui-sub">눈(차트 판독) 보정 결과 {s.submission.calibrationRefs.length}건은 기각 가설이 아니라 보정 기록으로 저장되었습니다.</p>
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
  (a, b) =>
    a.jobId === b.jobId &&
    JSON.stringify(a.ct.sessions) === JSON.stringify(b.ct.sessions) &&
    a.ct.queries?.length === b.ct.queries?.length &&
    a.ct.screened?.length === b.ct.screened?.length &&
    JSON.stringify(traderSummary(a.ct)) === JSON.stringify(traderSummary(b.ct)) &&
    JSON.stringify(a.ct.lessonsRecorded) === JSON.stringify(b.ct.lessonsRecorded) &&
    a.ct.lessons?.entries.length === b.ct.lessons?.entries.length &&
    a.ct.phase === b.ct.phase &&
    a.ct.charts?.length === b.ct.charts?.length,
);

/** 교훈 증류의 결과 한 줄: 기록됨 / 건너뜀(예비 부족) / 실패. */
const lessonsStatus = (r: CTLessonsRecorded) =>
  r.failed ? `실패 (${r.failed.slice(0, 60)})` : r.skipped === "reserve" ? "건너뜀(예비 부족)" : r.skipped === "no_ideas" ? "건너뜀(기록할 아이디어 없음)" : `기록됨 · 교훈 ${r.lessons ?? 0}개`;

type CalibrationItem = { run: string; symbols: string[]; blindId: string; n: number; hits: number; pValue: number; verdict: "skill" | "no_skill" | "inconclusive"; reading: string; neededHits: number; powerIfEyeIs70Pct: number; measured: string; source: string };
const VERDICT_TEXT: Record<CalibrationItem["verdict"], string> = { skill: "신호 있음", no_skill: "신호 없음", inconclusive: "판정 불가" };
type PlaybookItem = { id: string; market: string; timeframe: string; comparable: boolean; mechanism: string; structure: string; grade: string; reason: string; measured: string; run: string; source: string; detail?: Record<string, number | string> };
const GRADE_TEXT: Record<string, string> = {
  rejected_in_training: "학습 기각",
  screen_failed: "학습 게이트 탈락",
  development_failed: "개발 탈락",
  passed_final: "최종 통과",
  failed_final: "최종 탈락",
  adopted_daily: "일봉 채택",
};
/** Read-only playbook of one market: what earlier runs tried and how each ended, with filters. Numbers follow the same leak rule the designer gets. */
const PlaybookPanel = memo(function PlaybookPanel({ market }: { market: CTMarket }) {
  const [data, setData] = useState<{ entries: PlaybookItem[]; runs: Array<{ runId: string; tests: number; timeframe: string; note: string; at: string }>; cumulativeTests: number; calibration?: CalibrationItem[]; lessons?: CTLessonView[]; coverage?: CTCoverage } | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"items" | "lessons">("items");
  const [focusId, setFocusId] = useState("");
  const [grade, setGrade] = useState("all");
  const [timeframe, setTimeframe] = useState("all");
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    fetch(`/api/invest/ct?playbook=1&market=${market}`, { cache: "no-store" })
      .then(async (r) => {
        const body = (await r.json()) as typeof data & { error?: string };
        if (!live) return;
        if (!r.ok || !body || (body as { error?: string }).error) setError((body as { error?: string } | null)?.error ?? "플레이북을 불러오지 못했습니다");
        else setData(body);
      })
      .catch(() => live && setError("플레이북을 불러오지 못했습니다"));
    return () => {
      live = false;
    };
  }, [market]);
  const lessonsModel = lessonsPanelModel(data, data?.entries ?? []);
  /** A lesson's evidence link: show every item, then scroll to the one the lesson rests on. */
  const openEvidence = (id: string) => {
    setView("items");
    setGrade("all");
    setTimeframe("all");
    setQuery("");
    setFocusId(id);
    requestAnimationFrame(() => document.getElementById(playbookAnchor(id))?.scrollIntoView({ block: "center" }));
  };
  const shown = (data?.entries ?? []).filter((e) => e.market === market && (grade === "all" || e.grade === grade) && (timeframe === "all" || e.timeframe === timeframe) && (!query.trim() || `${e.mechanism} ${e.structure} ${e.reason}`.toLowerCase().includes(query.trim().toLowerCase())));
  return (
    <section className="ct-section" aria-labelledby="ct-playbook-h">
      <details className="ui-disclosure">
        <summary id="ct-playbook-h">
          플레이북 · {market === "stock" ? "주식" : "코인"}
          <small className="ui-num">{data ? `${data.entries.length}개 항목 · 이전 단타 연구 가설 검정 ${data.cumulativeTests}회` : "불러오는 중"}</small>
        </summary>
        <div className="ui-disclosure-body ui-korean">
          <p className="ui-sub">연구가 끝날 때마다 기각·탈락·통과한 아이디어를 시장별로 쌓습니다. 설계자는 이 목록(메커니즘과 결과 등급)을 보고 시작하고, 최종 구간 성과 수치는 어디에도 저장되지 않습니다. 일봉 항목은 단타(1/5/15/60분봉)와 직접 비교할 수 없습니다.</p>
          {error ? <p role="alert" className="ct-error">{error}</p> : null}
          <div className="ui-segmented" role="tablist" aria-label="플레이북 보기">
            <button role="tab" aria-selected={view === "items"} onClick={() => setView("items")}>항목 <span className="ui-num">{data?.entries.length ?? 0}</span></button>
            <button role="tab" aria-selected={view === "lessons"} onClick={() => setView("lessons")}>교훈 <span className="ui-num">{lessonsModel.cards.length}</span></button>
          </div>
          {view === "lessons" ? <LessonsTab model={lessonsModel} onEvidence={openEvidence} /> : null}
          <div className="ct-playbook-filters" hidden={view !== "items"}>
            <label>등급 <select value={grade} onChange={(e) => setGrade(e.target.value)}><option value="all">전체</option>{Object.entries(GRADE_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label>주기 <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}><option value="all">전체</option><option value="1m">1분봉(단타)</option><option value="5m">5분봉(단타)</option><option value="15m">15분봉(단타)</option><option value="60m">60분봉(단타)</option><option value="daily">일봉(직접 비교 불가)</option></select></label>
            <label>검색 <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="메커니즘·구조·사유" /></label>
          </div>
          {view === "items" && data?.calibration?.length ? (
            <div className="ct-calibration" aria-label="설계자의 눈 보정 기록">
              <p><b>보정 기록 · 설계자의 눈</b> <small>거래 아이디어의 기각이 아니라 도구 측정입니다. 작은 세트의 p가 큰 것은 &lsquo;판별력 없음&rsquo;이 아니라 &lsquo;알 수 없음&rsquo;입니다.</small></p>
              <ul className="ct-playbook">
                {data.calibration.map((c) => (
                  <li key={`${c.run}-${c.blindId}`}>
                    <b>{c.symbols.join(", ")} · 블라인드 {c.n}장 중 {c.hits}장 적중 (p={c.pValue})</b>
                    <span className={`ct-grade ct-grade-calibration-${c.verdict}`}>{VERDICT_TEXT[c.verdict]}</span>
                    <span>{c.reading} · 이 크기에서 유의하려면 {c.neededHits}장 이상, 실제 70% 눈을 잡아낼 확률 {Math.round(c.powerIfEyeIs70Pct * 100)}%</span>
                    <small className="ui-num">{c.measured} · 실행 {c.run}{c.source === "migrated" ? " · 기존 기록에서 이전" : ""}</small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <ul className="ct-playbook" hidden={view !== "items"}>
            {shown.map((e) => (
              <li key={e.id} id={playbookAnchor(e.id)} data-focus={focusId === e.id ? "true" : undefined}>
                <b>{e.mechanism}</b>
                <span className={`ct-grade ct-grade-${e.grade}`}>{GRADE_TEXT[e.grade] ?? e.grade}</span>
                {!e.comparable ? <span className="ct-grade">단타와 직접 비교 불가</span> : null}
                <small className="ui-num">{e.structure}</small>
                <span>{e.reason}</span>
                <small className="ui-num">{e.measured} · 실행 {e.run}{e.detail ? ` · ${Object.entries(e.detail).map(([k, v]) => `${k} ${v}`).join(" · ")}` : ""}</small>
              </li>
            ))}
            {data && !shown.length ? <li>조건에 맞는 항목이 없습니다.</li> : null}
          </ul>
        </div>
      </details>
    </section>
  );
});

/** 교훈 탭: 계열 단위 한 문장 교훈(수치 없음)과 아직 안 건드린 영역(개수만). 읽기 전용 · 빈 칸은 목표가 아니다. */
function LessonsTab({ model, onEvidence }: { model: ReturnType<typeof lessonsPanelModel>; onEvidence: (id: string) => void }) {
  const cov = model.coverage;
  return (
    <div className="ct-lessons" aria-label="계열별 교훈">
      <p className="ui-sub">연구가 끝날 때마다 아이디어를 계열 단위로 정리한 한 문장 교훈입니다. 모든 수치를 가린 기록에서 만들었고 숫자가 없습니다. 이 판에서 그 계열이 왜 안 됐는지에 대한 기억이지, 성과의 증거도 채워야 할 목표도 아닙니다.</p>
      {model.empty ? (
        <p className="ui-empty" role="status">아직 교훈이 없습니다. 5단계 정책으로 연구가 끝나면 쌓입니다. 이전 연구는 소유자가 소급 증류 스크립트를 돌릴 때 채워집니다.</p>
      ) : (
        <ul className="ct-lesson-cards">
          {model.cards.map((c) => (
            <li key={c.id} className="ui-card pad ct-lesson-card" data-verdict={c.verdict}>
              <div className="ui-card-head">
                <b>{c.familyText}</b>
                <span className="ui-badge" data-tone={c.verdict === "dead" ? "danger" : c.verdict === "weak" ? "warn" : undefined}>{c.verdictText}</span>
              </div>
              <p className="ui-korean">{c.lesson}</p>
              <small className="ui-sub">원인 · {c.causeText}{c.nextToTry ? ` · 아직 안 본 변형(제안) · ${c.nextToTry}` : ""}</small>
              <small className="ui-num">
                근거{" "}
                {c.evidence.map((e, i) => (
                  <span key={e.id}>
                    {i ? ", " : ""}
                    {e.listed ? <a href={`#${e.anchor}`} title="플레이북 항목으로 이동" onClick={(ev) => { ev.preventDefault(); onEvidence(e.id); }}>{e.label}</a> : <span title="불러온 목록 밖의 항목">{e.label}</span>}
                  </span>
                ))}
                {" "}· {c.updated} 갱신 · 실행 {c.lastRun}
              </small>
            </li>
          ))}
        </ul>
      )}
      {cov ? (
        <div className="ct-coverage" aria-label="아직 안 건드린 영역">
          <p><b>아직 안 건드린 영역</b> <small>{model.note}</small></p>
          <div className="ct-table-wrap">
            <table className="ui-table ct-coverage-table">
              <thead><tr><th>계열</th><th>아이디어</th><th title="조건 서명으로 센 서로 다른 검정. 시간대·청산·다음 날 보유는 서명으로 표현되지 않아 센 값이 없습니다">검정</th><th>최고 등급</th><th>마지막 실행</th><th>교훈</th></tr></thead>
              <tbody>
                {cov.families.map((f) => (
                  <tr key={f.family}><td>{f.familyText}</td><td>{f.ideas}</td><td>{f.tests ?? "—"}</td><td>{f.bestGrade ?? "—"}</td><td>{f.lastRun ?? "—"}</td><td>{f.hasLesson ? "있음" : "없음"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ui-sub">피처×주기 칸 {cov.touchedCells}/{cov.totalCells}개 사용됨. 한 번도 안 쓰인 칸: {cov.untouched.length ? cov.untouched.join(", ") : "없음"}{cov.moreUntouched ? ` 외 ${cov.moreUntouched}개` : ""}</p>
          <p className="ui-sub">ATR 단위를 못 써 본 피처: {cov.atrUntouched.length ? cov.atrUntouched.join(", ") : "없음"} · 진입 시간 창 {cov.entryWindowUsed ? "사용됨" : "한 번도 안 씀"} · 안 쓴 관리형 청산 요소: {cov.exitUntouched.length ? cov.exitUntouched.join(", ") : "없음"}</p>
          {cov.emptyCells.length ? <p className="ui-sub">계열 × 청산 구조의 빈 칸: {cov.emptyCells.join(" · ")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

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
  const [products,setProducts]=useState<CTCapability[]>([]),[product,setProduct]=useState("spot"),[selectionMode,setSelectionMode]=useState("manual");
  useEffect(()=>{fetch("/api/invest/ct/experiments").then(r=>r.json() as Promise<{capabilities:CTCapability[]}>).then(p=>setProducts(p.capabilities)).catch(()=>setProducts([]));},[]);
  const [tab,setTab]=useState("research");
  useEffect(()=>{const read=()=>setTab(new URLSearchParams(location.search).get("ctTab")??"research");read();window.addEventListener("popstate",read);return()=>window.removeEventListener("popstate",read);},[]);
  const selectTab=(next:string)=>{setTab(next);const u=new URL(location.href);u.searchParams.set("ctTab",next);u.searchParams.set("ctMarket",market);history.pushState({},"",u);};
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
    [repeat, setRepeat] = useState<{ message: string; previous: Array<{ id: string; at: string; status: string; endReason: string | null }> } | null>(null),
    [repeatReason, setRepeatReason] = useState(""),
    [ready, setReady] = useState(false),
    [streamed, setStreamed] = useState<ResearchMeter | null>(null),
    [clock, setClock] = useState(() => Date.now());
  const staleData = useStaleData(market, symbols, days);
  const advancing = useRef(false),
    loading = useRef(false),
    lastRaw = useRef(""),
    marketRef = useRef(market);
  useEffect(() => {
    marketRef.current = market;
  }, [market]);
  useEffect(() => {
    // A shared link's market wins over the stored one, with or without stored settings.
    const linked = new URLSearchParams(location.search).get("ctMarket");
    if (linked === "stock" || linked === "crypto") queueMicrotask(() => setMarket(linked));
    try {
      const stored = JSON.parse(localStorage.getItem("qquan.ct.v1") ?? "null");
      if (stored)
        queueMicrotask(() => {
          if ((stored.market === "stock" || stored.market === "crypto") && linked !== "stock" && linked !== "crypto")
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
        const p = (await r.json()) as { error?: string; boardRepeat?: { previous: Array<{ id: string; at: string; status: string; endReason: string | null }> } };
        // Same board as an earlier run: show why, and offer "run anyway" only with a reason (nothing was paid for).
        if (p.boardRepeat) {
          setRepeat({ message: p.error ?? "같은 판입니다", previous: p.boardRepeat.previous });
          return;
        }
        throw new Error(p.error);
      }
      const p = (await r.json()) as { job?: { id: string } };
      if (p.job) {
        setSelected(p.job.id);
        setRepeat(null);
        setRepeatReason("");
      }
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
  const generate = (reason?: string) =>
    act("research", {
      tradeSettings:{product:market==="stock"?"stock":product,selectionMode,directions:["long"],riskPct:.5},
      requestId: crypto.randomUUID(),
      ...(reason ? { repeatReason: reason } : {}),
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
  const startBlocked = busy || data?.availability.ready === false || Boolean(runningId) || Boolean(blocking) || staleData.stale.length > 0;
  const calls = cj ? mergeCalls(cj.calls, cj.status === "running" ? pickMeter(cj.id, cj.liveMeter, streamed) : null) : [];
  const blockingQuiet = blocking ? clock - Date.parse(blocking.updatedAt) : 0;
  const blockingStale = Boolean(blocking && !data?.runnerOnline && blockingQuiet > BLOCKING_STALE_MS);
  const chosenSymbols = symbols.trim() ? symbols.trim().toUpperCase().split(/[,\s]+/).filter(Boolean) : [market === "stock" ? "NVDA" : "BTCUSDT"];
  const summary = [
    chosenSymbols.join(", "),
    "봉 주기 에이전트 선택",
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

  const startCard = (
      <section className="ct-start ui-card pad" aria-labelledby="ct-start-h">
        <div className="ct-start-head">
          <div>
            <h2 className="ui-title" id="ct-start-h">{cj ? "새 연구 시작" : "전략 연구 시작"}</h2>
            <p className="ui-sub ui-num">{summary}</p>
            {preview ? (
              <p className="ui-sub" data-testid="ct-cost-profile">
                비용 프로필: {preview.label} v{preview.version}{preview.provisional ? " (잠정 · 호가 측정 72시간 미만)" : ""} · 왕복 {previewRoundTrip.toFixed(3)}%{preview.feeVerified ? "" : " · 수수료 공식 문서 미확인"}
              
                {preview.fee ? <><br />수수료 메이커 {preview.fee.makerPct}% / 테이커 {preview.fee.takerPct}% · 출처 <a href={preview.fee.url} target="_blank" rel="noreferrer">{new URL(preview.fee.url).hostname}</a> · 확인 {preview.fee.checkedAt}</> : null}
                {preview.executionNote ? <><br />{preview.executionNote}</> : null}
              </p>
            ) : null}
            {market==="crypto"?<div className="ct-compare-toolbar"><label>상품 <select value={product} onChange={e=>setProduct(e.target.value)}>{products.filter(p=>p.product!=="stock").map(p=><option key={p.product} value={p.product}>{p.label}</option>)}</select></label><label>거래 설정 선택 <select value={selectionMode} onChange={e=>setSelectionMode(e.target.value)}><option value="manual">직접 지정</option><option value="agent">에이전트 선택</option></select></label><span className="ui-sub">허용 방향 롱 · 거래 위험 0.5% · 총 배분 상한 25%</span>{product!=="spot"?<p className="ui-alert">{products.find(p=>p.product===product)?.reason.join(" · ")} · 현재 연구/운용 연결 미완료이며 시작을 차단합니다.</p>:null}</div>:null}
            <p className="ui-sub">기본 설정으로 시작할 수 있습니다. 생성 완료와 매매 시작은 별도입니다.</p>
          </div>
          <button className="ui-btn primary lg" disabled={startBlocked||(market==="crypto"&&product!=="spot")} onClick={() => { setRepeat(null); void generate(); }}>
            {busy ? <RefreshCw size={15} className="spin" aria-hidden="true" /> : <ChartCandlestick size={15} aria-hidden="true" />}
            전략 생성
          </button>
        </div>
        {job?.status === "running" ? (
          <p className="ui-sub">진행 중인 연구가 끝나거나 취소되면 새 연구를 시작할 수 있습니다.</p>
        ) : null}
        {repeat ? (
          <div className="ui-alert ct-blocking" role="alert" data-testid="ct-board-repeat">
            <TriangleAlert size={16} aria-hidden="true" />
            <div>
              <strong>같은 판을 다시 돌리려고 합니다 · 아직 아무것도 시작하지 않았고 비용은 0입니다</strong>
              <p>{repeat.message}</p>
              <ul>
                {repeat.previous.map((p) => (
                  <li key={p.id}><code>{p.id.slice(0, 8)}</code> {p.at.slice(0, 10)} · {p.status === "running" || p.status === "paused" ? "진행 중" : "완료"}{p.endReason ? ` · ${p.endReason}` : ""}</li>
                ))}
              </ul>
              <label className="ui-field">
                <span>그래도 실행하는 이유 (10자 이상)</span>
                <textarea value={repeatReason} onChange={(e) => setRepeatReason(e.target.value)} maxLength={500} placeholder="예: 새 정책의 대조군 모드를 같은 데이터에서 확인한다" />
              </label>
              <div className="ct-blocking-actions">
                <button className="ui-btn sm" disabled={startBlocked || repeatReason.trim().length < 10} onClick={() => void generate(repeatReason.trim())}>그래도 실행</button>
                <button className="ui-btn sm" onClick={() => setRepeat(null)}>닫기</button>
              </div>
            </div>
          </div>
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
        <DataSyncCard sync={staleData} />
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
  );

  return (
    <div className="ct-workspace">
      {cj && live ? (
        <div className="ct-sticky" role="region" aria-label="연구 진행 상태">
          <LiveStatusBar job={cj} runnerOnline={runnerOnline} busy={busy} onAct={(a) => void act(a)} />
        </div>
      ) : null}

      <header className="ct-head">
        <h1><ChartCandlestick size={22} strokeWidth={1.9} aria-hidden="true" />차트 트레이딩 <small className="ui-sub">v0.0</small></h1>
        <p className="ui-sub">공개 접근법 조사부터 실제 실험까지. 검증된 규칙을 모의·실전 운용으로 연결합니다.</p>
      </header>

      <div className="ct-toolbar">
      <div className="ct-market">
        <div className="ui-segmented" role="group" aria-label="CT 시장">
          {(["stock", "crypto"] as const).map((m) => (
            <button
              key={m}
              aria-pressed={market === m}
              onClick={() => {
                setMarket(m);
                const u=new URL(location.href);u.searchParams.set("ctMarket",m);for(const key of ["experiment","day","decision"])u.searchParams.delete(key);history.pushState({},"",u);
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
            : "Binance · Spot · USDT"}
        </span>
      </div>

      <nav className="ui-segmented ct-subtabs" aria-label="CT 작업">
        {[["research","연구"],["validation","검증"],["operation","운용"]].map(([key,label])=><button key={key} aria-current={tab===key?"page":undefined} aria-pressed={tab===key} onClick={()=>selectTab(key)}>{label}</button>)}
      </nav>
      </div>
      {tab==="validation"?<CTValidation key={market} market={market} runId={job?.id}/>:null}
      <div className="ct-research" hidden={tab!=="research"}>
      {!cj ? startCard : null}
      <section className="ct-progress-section" aria-labelledby="ct-progress-h">
        <div className="ui-card-head">
          <h2 className="ui-title" id="ct-progress-h">연구</h2>
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
            <details className="ui-disclosure ct-steps" open={live}>
              <summary>진행 단계와 활동 기록<small className="ui-num">{CT_PHASES[cj.ct.phase]} · 도구 {cj.ct.tools.length}건 · 모델 {calls.length}건</small></summary>
              <div className="ui-disclosure-body">
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
              </div>
            </details>
          </>
        ) : (
          <div className="ui-empty">
            <strong>아직 연구가 없습니다</strong>
            <p>전략 생성을 누르면 연구 계약을 저장하고, 에이전트가 공개 자료 조사와 실제 시장 실험을 시작합니다. 진행 상황은 이 자리에 단계별로 표시됩니다.</p>
          </div>
        )}
      </section>


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

      {cj ? startCard : null}
      {cj ? (
        <details className="ui-disclosure ct-detail-group">
          <summary>연구 상세 기록<small className="ui-num">설계 세션 {cj.ct.sessions?.length ?? 0} · 후보 {cj.ct.trials.length} · 출처 {cj.ct.sources.length}</small></summary>
          <div className="ui-disclosure-body ct-detail-body">
      {cj ? <ResearchSessions ct={cj.ct} jobId={cj.id} /> : null}
      <PlaybookPanel market={market} />

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

      {ct&&ctSessionPolicy(ct.contract).book?<section className="ui-card pad"><h2 className="ui-title">부품 · 북 · 정책 7</h2><p className="ui-sub">제품 {ct.contract.semantics?.productVersion??"v0.0"} · {ct.contract.semantics?.engine??"ct-decision-1"} · traderTools {ct.contract.policy.traderTools}</p><h3>부품</h3>{ct.components?.length?<div className="ui-scroll-x"><table className="ui-table"><thead><tr><th scope="col">조건/봉</th><th scope="col">이벤트/일</th><th scope="col">기준선 대비</th><th scope="col">군집 p</th><th scope="col">학습·개발 판정</th></tr></thead><tbody>{ct.components.map(r=><tr key={r.id}><th scope="row">{r.candidate.spec.name} · {r.candidate.spec.minutes}분 · 롱</th><td>{r.training?.events??"—"} / {r.training?.days??"—"}</td><td>{r.training?.differencePct.toFixed(4)??"—"}%</td><td>{r.training?.p.toFixed(4)??"—"}</td><td>{r.duplicateOf?"중복 제외":r.grade} · {r.training?.reasons.join(" · ")}</td></tr>)}</tbody></table></div>:<p className="ui-sub">제출된 부품 없음</p>}<h3>북</h3>{ct.books?.length?ct.books.map(b=><article key={b.id}><strong>{b.id} · {b.rule.kind} {"k" in b.rule?b.rule.k:""}</strong><p>{b.componentIds.join(" · ")}</p><p>일평균 {dayMean(b.development??b.training).toFixed(4)}% · 수익일 {(b.development??b.training).positiveDayPct?.toFixed(1)??"—"}% · 낙폭 {(b.development??b.training).maxDrawdownPct.toFixed(2)}%</p><p>{b.reasons.join(" · ")||"검증 중"}</p></article>):<p className="ui-sub">학습 통과·중복 제거 후 부품 2개 이상이 필요합니다. 개발에서 재조합하지 않습니다.</p>}<button className="ui-btn" onClick={()=>selectTab("validation")}>검증에서 비교 · 판단 리플레이</button></section>:null}
          </div>
        </details>
      ) : null}
      </div>
      <div className="ct-research" hidden={tab!=="operation"}>
      <CTConnectionStatus/>
      <TradingDashboards
        key={market}
        book={market === "stock" ? "ct-stock" : "ct-crypto"}
      />
      </div>
    </div>
  );
}
