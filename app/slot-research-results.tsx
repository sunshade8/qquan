"use client";
import { useState } from "react";
import type { GenerationJob } from "@/lib/strategy-generation-types";
import type { Trial, Summary } from "@/lib/slot-research";
import type { RelayResult } from "@/lib/relay-engine";
import { SLOTS } from "@/lib/trade-slots";
const pct = (v: number | null | undefined) =>
  v == null ? "미측정" : `${v.toFixed(4)}%`;
function targetText(s?: Summary) {
  if (!s) return "미측정";
  return s.targets.every((t) => t.reached === false)
    ? "전 시나리오 미달"
    : s.targets.every((t) => t.reached === null)
      ? "미측정"
      : `${s.targets.filter((t) => t.reached).length}/${s.targets.length} 수치 도달`;
}
function TrialDetails({ trial, jobId }: { trial: Trial; jobId: string }) {
  const [result, setResult] = useState<{
    training: RelayResult;
    development: RelayResult;
  } | null>(null);
  const [error, setError] = useState(""),
    [limit, setLimit] = useState(30);
  const url = `/api/strategy-generation?id=${jobId}&artifact=${trial.artifact}`;
  const load = async () => {
    if (result) return;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("산출물 조회 실패");
      const data = (await response.json()) as {
        detail?: { training: RelayResult; development: RelayResult };
      };
      if (!data.detail) throw new Error("백테스트 미실행");
      setResult(data.detail);
    } catch (e) {
      setError(String(e));
    }
  };
  const days = result?.development.days ?? [],
    trades = days.flatMap((d) =>
      d.slots.filter((t) => t.traded).map((t) => ({ ...t, date: d.date })),
    );
  const equity = days.map((d) => d.endEquityUsd),
    lo = Math.min(...equity),
    hi = Math.max(...equity);
  return (
    <details
      className="research-option-detail"
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>
        {trial.spec.candidate.name} ·{" "}
        {trial.status === "measured"
          ? pct(trial.development?.metrics.meanDailyPct)
          : "백테스트 미실행"}{" "}
        · 규칙·원장·개선 이력
      </summary>
      <p>
        {trial.change}
        {trial.parentId &&
          ` · 이전 ${trial.parentId} 대비 ${trial.deltaPct === null ? "미측정" : trial.deltaPct.toFixed(4) + "%p"}`}
      </p>
      <p>
        {trial.reasons.join(" · ") || "개발 수치 기준 충족; 최종 검증과 별개"}
      </p>
      <p>
        규칙 v{trial.spec.version} · {trial.spec.candidate.barInterval} ·{" "}
        {trial.spec.universe.join(", ")} 중 {trial.spec.candidate.rankBy}{" "}
        {trial.spec.candidate.rankDirection} 순으로 1종목. 완성 봉 신호 후 다음
        봉 시가 진입, 손절 {trial.spec.candidate.stopPct}%, 익절{" "}
        {trial.spec.candidate.targetPct === null
          ? "슬롯 종료"
          : `${trial.spec.candidate.targetPct}%`}
        . 정수 수량: 현금 99% 및 봉 거래량 1% 중 작은 한도. 하루 슬롯당 1회,
        동시 손절·익절은 손절 우선.
      </p>
      <pre style={{ whiteSpace: "pre-wrap" }}>
        {JSON.stringify(trial.spec.candidate.conditions, null, 2)}
      </pre>
      <p>
        실측 신호 차단 횟수:{" "}
        {Object.entries(trial.diagnostics ?? {})
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ")}
      </p>
      <p>
        비교 기준: 현금 유지 0%/세션. 개발 초과수익{" "}
        {pct(trial.development?.metrics.meanDailyPct)}. 반복 선택한 개발 성과 ·
        다중 시도 보정 하한 {pct(trial.development?.selectionLowerPct)}.
      </p>
      {trial.train && trial.development && (
        <div className="lab-table-wrap">
          <table className="lab-table">
            <thead>
              <tr>
                <th>구간</th>
                <th>실제 기간</th>
                <th>일평균 순수익</th>
                <th>누적</th>
                <th>거래</th>
                <th>비용</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["학습", trial.train],
                ["개발", trial.development],
              ].map(([name, s]) => {
                const a = s as Summary;
                return (
                  <tr key={name as string}>
                    <td>{name as string}</td>
                    <td>
                      {a.from}–{a.to}
                    </td>
                    <td>{pct(a.metrics.meanDailyPct)}</td>
                    <td>{pct(a.metrics.totalReturnPct)}</td>
                    <td>{a.metrics.totalTrades}</td>
                    <td>${a.metrics.costPaidUsd.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p>
        개발 전반/후반 평균: {trial.development?.halves.map(pct).join(" / ")} ·
        거래 발생일 평균 {pct(trial.development?.conditionalMeanPct)} · 평균
        보유 {trial.development?.meanHoldMinutes?.toFixed(1) ?? "미측정"}분
      </p>
      {equity.length > 0 && (
        <svg
          viewBox="0 0 600 140"
          role="img"
          aria-label="개발 구간 날짜순 자본곡선"
          style={{ width: "100%", maxWidth: 700, background: "var(--surface)" }}
        >
          <title>
            {days[0]?.date}–{days.at(-1)?.date} 자본곡선
          </title>
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            points={equity
              .map(
                (v, i) =>
                  `${10 + (i / Math.max(1, equity.length - 1)) * 580},${125 - ((v - lo) / Math.max(0.01, hi - lo)) * 105}`,
              )
              .join(" ")}
          />
          <text x="10" y="14" fontSize="12">
            ${lo.toFixed(2)}–${hi.toFixed(2)}
          </text>
        </svg>
      )}
      {error && <p role="alert">{error}</p>}
      {!!trades.length && (
        <div className="lab-table-wrap">
          <table className="lab-table">
            <thead>
              <tr>
                <th>날짜·종목</th>
                <th>진입 ET / 가격</th>
                <th>청산 ET / 가격</th>
                <th>수량</th>
                <th>비용</th>
                <th>손익</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, limit).map((t) => (
                <tr key={`${t.date}-${t.slot}`}>
                  <td>
                    {t.date} {t.symbol}
                  </td>
                  <td>
                    {t.entryTime} / ${t.entryPrice?.toFixed(4)}
                  </td>
                  <td>
                    {t.exitTime} / ${t.exitPrice?.toFixed(4)}
                  </td>
                  <td>{t.quantity}</td>
                  <td>${t.costUsd.toFixed(4)}</td>
                  <td>${t.pnlUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {limit < trades.length && (
            <button onClick={() => setLimit(limit + 50)}>
              거래 50개 더 보기
            </button>
          )}
        </div>
      )}
      {!!days.length && (
        <details>
          <summary>날짜별 순수익·자본 ({days.length}세션)</summary>
          <div className="lab-table-wrap">
            <table className="lab-table">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>순수익</th>
                  <th>시작 자본</th>
                  <th>종료 자본</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td>{pct(d.returnPct)}</td>
                    <td>${d.startEquityUsd.toFixed(2)}</td>
                    <td>${d.endEquityUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <p>실험 SHA-256: {trial.hash}</p>
      <a href={url} download={`experiment-${trial.id}.json`}>
        데이터·비용·엔진 버전 및 전체 원장 JSON
      </a>
    </details>
  );
}
export function SlotResearchResults({
  job,
}: {
  job: Omit<GenerationJob, "ownerId">;
}) {
  const search = job.search!,
    manifest = search.manifest;
  return (
    <section
      className="slot-research-results"
      aria-label="슬롯별 실측 연구 결과"
    >
      <p>
        종료/진행: {search.endReason ?? search.phase} · 후보{" "}
        {search.trials.length}개 · 백테스트 {search.backtests}회 · 캐시 재사용{" "}
        {search.cacheHits}회 · 로컬 계산 {(search.computeMs / 1000).toFixed(1)}
        초 · LLM ${job.costUsd.toFixed(5)} / ${job.budgetUsd}
      </p>
      <p>
        설계 주체: {search.agent?.mode === "agent" ? "프로그램 내 연구 에이전트" : "내장 결정론 규칙"} ·
        저장된 설계 배치 {search.agent?.batches.length ?? 0}개 · 성과 측정 {search.evaluation === "partial" ? "일부 슬롯 미완료" : search.evaluation === "measured" ? "대상 슬롯 측정됨" : "진행 중 또는 미측정"}
      </p>
      {!!search.agent?.batches.length && <details className="research-log"><summary>에이전트의 설계·실패 반영 기록</summary>
        {search.agent.batches.map((batch, index) => <article key={batch.outputHash}>
          <h4>설계 배치 {index + 1} · 선행 개발 실험 {batch.basedOnTrialIds.length}개</h4>
          <p>{batch.summary}</p>
          {batch.designs.map(design => <p key={design.family}><strong>{design.candidate.name}</strong> · {design.mechanism}<br />변경: {design.change}</p>)}
          <p>설계 버전 {batch.outputHash.slice(0, 12)} · 최종 시험 성과는 설계 입력에서 제외</p>
        </article>)}
      </details>}
      <p>
        슬롯 단독 일평균 순수익률 = 각 정상 세션의 시작 잔고 대비 비용 후 수익률
        평균. 무거래 정상 세션의 0% 포함. 누락 세션은 분모에서 제외하여 별도
        보고합니다. 계좌 전체 기여나 거래일 평균과 다릅니다.
      </p>
      {manifest && (
        <p>
          {manifest.source} · 원본 {manifest.sourceMinutes}분봉 ·{" "}
          {manifest.from}–{manifest.to} · 학습 ≤{manifest.trainingTo}, 개발 ≤
          {manifest.developmentTo}, 최종 ≥{manifest.holdoutFrom}.{" "}
          {manifest.sourceMinutes === 5
            ? "5분봉 개발 연구: 실시간 1분 원본의 완전성 검증 미통과."
            : ""}{" "}
          원본 관측 {manifest.dates.length}세션. 과거 노출:{" "}
          {manifest.exposure === "previously_seen"
            ? "이전 연구와 중복"
            : "독립성 미확인"}
          .
        </p>
      )}
      {!!manifest?.acquisitionWarnings?.length && <p>데이터 보충 제한: {manifest.acquisitionWarnings.join(" · ")} 보유 정상 봉만 사용하며 누락은 아래에 별도로 표시합니다.</p>}
      <div className="lab-table-wrap">
        <table className="lab-table">
          <thead>
            <tr>
              <th>슬롯 / 전략</th>
              <th>목표</th>
              <th>실측 순수익 / 차이</th>
              <th>거래 수 · 발동률</th>
              <th>낙폭 · 비용</th>
              <th>평가 기간·단계</th>
              <th>목표 판정</th>
              <th>검증 상태</th>
            </tr>
          </thead>
          <tbody>
            {search.slots.map((slot) => {
              const trials = search.trials.filter((t) => t.slot === slot),
                best =
                  trials.find((t) => t.id === search.selected[slot]) ??
                  [...trials]
                    .filter((t) => t.status === "measured")
                    .sort(
                      (a, b) =>
                        (b.development?.metrics.meanDailyPct ?? -Infinity) -
                          (a.development?.metrics.meanDailyPct ?? -Infinity) ||
                        a.id.localeCompare(b.id),
                    )[0];
              const final = search.final[slot],
                s = final?.summary ?? best?.development,
                c = manifest?.coverage.find((c) => c.slot === slot);
              return (
                <tr key={slot}>
                  <th>
                    {SLOTS.find((x) => x.id === slot)?.label}
                    <br />
                    {best?.spec.candidate.name ?? "미실행"}
                  </th>
                  <td>
                    {search.target
                      ? `${s?.targets[0]?.targetPct ?? "—"}%/정상세션`
                      : "12개 시나리오 비교"}
                  </td>
                  <td>
                    {pct(s?.metrics.meanDailyPct)}
                    <br />
                    {search.target && s?.targets[0]?.gapPct != null
                      ? `${s.targets[0].gapPct.toFixed(4)}%p`
                      : "아래 시나리오별 차이"}
                  </td>
                  <td>
                    {s?.metrics.totalTrades ?? "미측정"} · {pct(s?.fireRatePct)}
                  </td>
                  <td>
                    {pct(s?.metrics.maxDrawdownPct)}
                    <br />${s?.metrics.costPaidUsd.toFixed(2) ?? "미측정"}
                  </td>
                  <td>
                    {s ? `${s.from}–${s.to}` : "미측정"}
                    <br />
                    {final ? "최종 (독립성 미확인)" : "개발 · 반복 선택"}
                    <br />
                    정상 {s?.metrics.sessions ?? 0} / 누락·불명{" "}
                    {c?.excluded.filter((d) =>
                      final
                        ? d.date >= (manifest?.holdoutFrom ?? "")
                        : d.date > (manifest?.trainingTo ?? "") &&
                          d.date <= (manifest?.developmentTo ?? ""),
                    ).length ?? 0}
                  </td>
                  <td>{targetText(s)}</td>
                  <td>
                    {final?.passed
                      ? "최종 검증 통과"
                      : !best
                        ? trials.length
                          ? "데이터/실행 오류"
                          : "백테스트 미실행"
                        : (s?.metrics.totalTrades ?? 0) < 10
                          ? "표본 부족"
                          : best.eligible
                            ? "개발 통과 · 실행/독립 검증 필요"
                            : "개발 검증 미달"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {search.slots.map((slot) => {
        const trials = search.trials.filter((t) => t.slot === slot),
          best = [...trials]
            .filter((t) => t.development)
            .sort(
              (a, b) =>
                (b.development!.metrics.meanDailyPct ?? -Infinity) -
                (a.development!.metrics.meanDailyPct ?? -Infinity),
            )[0];
        return (
          <details className="research-log" key={slot}>
            <summary>
              {SLOTS.find((s) => s.id === slot)?.label} · {trials.length}개
              시도와 목표 시나리오
            </summary>
            {search.final[slot] && <p>
              최종 판정: {search.final[slot].passed ? "검증 통과" : search.final[slot].reasons.join(" · ")}
              {" · "}<a href={`/api/strategy-generation?id=${job.id}&artifact=${search.final[slot].artifact}`} download={`${slot}-final.json`}>최종 원장·일별 자본·스트레스 결과</a>
            </p>}
            {best?.development && (
              <div className="lab-table-wrap">
                <table className="lab-table">
                  <thead>
                    <tr>
                      <th>계좌 일 목표</th>
                      <th>슬롯 수</th>
                      <th>슬롯 목표/정상세션</th>
                      <th>실측 차이</th>
                      <th>수치 판정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {best.development.targets.map((t) => (
                      <tr key={`${t.dailyTargetPct}-${t.slots}`}>
                        <td>{t.dailyTargetPct}%</td>
                        <td>{t.slots}</td>
                        <td>{t.targetPct}%</td>
                        <td>{t.gapPct?.toFixed(4) ?? "미측정"}%p</td>
                        <td>
                          {t.reached === null
                            ? "미측정"
                            : t.reached
                              ? "도달 (검증과 별개)"
                              : "미달"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {trials.map((t) => (
              <TrialDetails key={t.id} trial={t} jobId={job.id} />
            ))}
            <details>
              <summary>누락·품질 제외 세션</summary>
              <pre style={{ whiteSpace: "pre-wrap" }}>
                {manifest?.coverage
                  .find((c) => c.slot === slot)
                  ?.excluded.map((d) => `${d.date}: ${d.reason}`)
                  .join("\n") || "없음"}
              </pre>
            </details>
          </details>
        );
      })}
      <p>
        비교 기준은 현금 유지(일평균 0%). 최종 진출 후보와 슬롯 결합을 함께
        동결한 경우에만 하나의 잔고로 계좌 성과를 다시 계산합니다.{" "}
        {search.combined
          ? `결합 최종 일평균 ${pct(search.combined.metrics.meanDailyPct)}`
          : "계좌 결합 성과 미측정."}
      </p>
      <p>
        동일 규칙 재계산: node --experimental-strip-types scripts/research/verify-slot-replay.mjs 기록.json.
        새 설계 연구: node scripts/research/run-slot-research.mjs --replay 기록.json.
        에이전트의 새 설계는 달라질 수 있으며, 저장된 규칙과 데이터의 재계산은 결정론적입니다.
      </p>
    </section>
  );
}
