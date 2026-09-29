"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GENERATION_STAGES,
  type GenerationJob,
} from "@/lib/strategy-generation-types";
import { GENERATION_MODELS } from "@/lib/strategy-generation-models";
import type { SlotId } from "@/lib/trade-slots";

type Job = Omit<GenerationJob, "ownerId">;
type State = {
  jobs: Job[];
  availability: { ready: boolean; missing: string[] };
  inventory: Array<{
    symbol: string;
    interval: string;
    provider: string;
    sessions: number;
    firstDate: string;
    lastDate: string;
    bars: number;
  }>;
  error?: string;
};
type Props = {
  slots: Array<{ id: string; label: string; strategy: unknown | null }>;
  onRegistered: () => void;
};
export function StrategyGenerator({ slots, onRegistered }: Props) {
  const [data, setData] = useState<State | null>(null),
    [slot, setSlot] = useState<SlotId>("trend");
  const [symbols, setSymbols] = useState("");
  const universe = [
    ...new Set(
      symbols
        .toUpperCase()
        .split(/[\s,]+/)
        .filter(Boolean),
    ),
  ];
  const validUniverse =
    universe.length > 0 &&
    universe.length <= 10 &&
    universe.every((s) => /^[A-Z][A-Z0-9.-]{0,14}$/.test(s));
  const [brief, setBrief] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [progress, setProgress] = useState("");
  const advancing = useRef(false),
    knownCompleted = useRef(new Set<string>()),
    requestId = useRef<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/strategy-generation", {
        cache: "no-store",
      });
      const body = (await response.json()) as State;
      if (!response.ok)
        throw new Error(body.error ?? "생성 상태를 불러오지 못했습니다.");
      setData(body);
      for (const job of body.jobs)
        if (job.status === "completed" && !knownCompleted.current.has(job.id)) {
          knownCompleted.current.add(job.id);
          onRegistered();
        }
    } catch (e) {
      setError(e instanceof Error ? e.message : "상태 조회 실패");
    }
  }, [onRegistered]);
  useEffect(() => {
    queueMicrotask(() => void load());
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);
  const active = data?.jobs.find((j) => j.status === "running"),
    latest = active ?? data?.jobs[0];
  const activeId =
    active?.id ??
    data?.jobs.find((j) => j.status === "paused" && j.pauseReason === "data")
      ?.id;
  useEffect(() => {
    if (!activeId) return;
    let disposed = false;
    const advance = async () => {
      if (advancing.current || disposed) return;
      advancing.current = true;
      try {
        const response = await fetch("/api/strategy-generation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "advance", id: activeId }),
        });
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          throw new Error(body.error ?? "단계 실행 실패");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("진행 응답 없음");
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines)
            if (line.trim()) {
              const message = JSON.parse(line);
              if (message.type === "progress" && !disposed)
                setProgress(message.message);
              if (message.type === "error") throw new Error(message.message);
            }
          if (done) break;
        }
        if (!disposed) {
          setError(null);
          await load();
        }
      } catch (e) {
        if (!disposed)
          setError(
            e instanceof Error
              ? e.message
              : "연결이 끊겼습니다. 저장된 단계에서 재확인합니다.",
          );
      } finally {
        advancing.current = false;
      }
    };
    void advance();
    const timer = setInterval(() => void advance(), 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [activeId, load]); // Persisted lease serialises tabs and the background runner.

  const create = async () => {
    setBusy(true);
    setError(null);
    requestId.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/strategy-generation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          slot,
          universe,
          brief,
          requestId: requestId.current,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        requestId.current = null;
        throw new Error(body.error ?? "생성 시작 실패");
      }
      requestId.current = null;
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "생성 요청 실패");
    } finally {
      setBusy(false);
    }
  };
  const resumeBudget = async () => {
    if (!latest) return;
    setBusy(true);
    try {
      const response = await fetch("/api/strategy-generation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume_budget", id: latest.id }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "연구 재개 실패");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    const cancellable = active ?? (latest?.status === "paused" ? latest : null);
    if (!cancellable) return;
    setBusy(true);
    try {
      const response = await fetch("/api/strategy-generation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel", id: cancellable.id }),
      });
      if (!response.ok) throw new Error("취소 실패");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const vacant = slots.filter((s) => !s.strategy),
    selectedAvailable = vacant.some((s) => s.id === slot);
  return (
    <section className="strategy-generator" aria-label="전략 생성 에이전트">
      <div className="generator-head">
        <div>
          <span>STRATEGY STUDIO</span>
          <h2>아이디어에서 검증된 슬롯까지</h2>
          <p>선택한 종목과 자본 안에서 설계·실행·독립 검증을 반복합니다.</p>
        </div>
        <div className="generator-actions">
          <label>
            전략 생성 종목코드 (필수)
            <input
              aria-label="전략 생성 종목코드"
              value={symbols}
              onChange={(e) => {
                setSymbols(e.target.value);
                requestId.current = null;
              }}
              placeholder="예: AAPL, QQQ, SPY"
              disabled={!!active || busy}
              maxLength={170}
            />
          </label>
          <label>
            생성 슬롯
            <select
              aria-label="생성 슬롯"
              value={slot}
              onChange={(e) => setSlot(e.target.value as SlotId)}
              disabled={!!active || busy}
            >
              {slots.map((s) => (
                <option key={s.id} value={s.id} disabled={!!s.strategy}>
                  {s.label}
                  {s.strategy ? " · 배정됨" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            className="generator-create"
            onClick={() => void create()}
            disabled={
              !data?.availability.ready ||
              !!active ||
              busy ||
              !selectedAvailable ||
              !validUniverse
            }
          >
            {active ? "전략 생성 중" : busy ? "시작 중…" : "새 전략 생성"}
          </button>
        </div>
      </div>
      <p className="generator-note">
        입력한 종목만 연구합니다. 최대 10개 · 최근 2년 5분봉 · 연구 자본 $1,000
        · API 예산 $8 안에서 자동 개선. 실시간 주문 가능 잔고와는 별도입니다.
      </p>
      {!active && (
        <div className="generator-data" aria-live="polite">
          <b>저장된 데이터 확인</b>
          {!universe.length && (
            <p>
              생성할 종목코드를 먼저 입력하세요. 아래는 기존 요청 종목의 저장
              상태입니다.
            </p>
          )}
          {(universe.length ? universe : ["QQQ", "SPY"]).map((symbol) => {
            const cached =
              data?.inventory?.filter((row) => row.symbol === symbol) ?? [];
            return (
              <p key={symbol}>
                {symbol}:{" "}
                {!data
                  ? "확인 중…"
                  : !cached.length
                    ? "저장 데이터 없음 · 생성 시 누락 기간 확보"
                    : cached
                        .map(
                          (row) =>
                            `${row.firstDate}–${row.lastDate} · ${row.sessions}거래일 · ${row.bars.toLocaleString()}개 ${row.interval === "5m" ? "5분봉" : row.interval} (${row.provider})`,
                        )
                        .join(" / ")}
              </p>
            );
          })}
          <small>
            표시 기간은 실제 저장된 첫·마지막 거래일입니다. 중간 누락과 슬롯별
            봉 품질은 설계 전 별도로 검사합니다.
          </small>
        </div>
      )}
      {!active && (
        <details className="generator-options">
          <summary>전략에 반영할 조건 (선택)</summary>
          <textarea
            aria-label="전략 생성 요청"
            maxLength={1500}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="예: 거래량이 충분한 대형주 위주로, 급등 추격을 피하는 추세 전략"
          />
          <p>
            초기 학습 60% · 이후 검증은 시간순 미사용 구간으로 분리 · 생성당 API
            비용 상한 $8
          </p>
        </details>
      )}
      {data && !data.availability.ready && (
        <p className="generator-error">
          서버 API 키가 필요합니다: {data.availability.missing.join(", ")}. 두
          회사가 모두 연결되어야 시작됩니다.
        </p>
      )}
      {error && (
        <p className="generator-error" role="alert">
          {error}
        </p>
      )}
      {latest && (
        <div className={`generator-run ${latest.status}`}>
          <div className="generator-run-title" aria-live="polite">
            <strong>
              {latest.status === "completed"
                ? "전략이 슬롯에 추가됐습니다"
                : latest.status === "paused"
                  ? latest.pauseReason === "data"
                    ? "새 데이터 대기 · 자동 재개"
                    : "연구 대기 · 이어서 진행 가능"
                  : latest.status === "rejected"
                    ? "검증 기준 미달 · 슬롯 미등록"
                    : latest.status === "failed"
                      ? "생성이 중단됐습니다"
                      : latest.status === "cancelled"
                        ? "생성이 취소됐습니다"
                        : (GENERATION_STAGES[latest.stageIndex]?.label ??
                          "준비 중")}
            </strong>
            <span>
              {latest.attempt ?? 1}회차 · API ${latest.costUsd.toFixed(3)} / $
              {latest.budgetUsd}
            </span>
            {(active || latest.status === "paused") && (
              <button onClick={() => void cancel()} disabled={busy}>
                생성 취소
              </button>
            )}
          </div>
          {active && (
            <>
              <p className="generator-progress" role="status">
                {progress || "에이전트 준비 중"}
              </p>
              <ol className="generator-steps">
                {GENERATION_STAGES.map((stage, i) => (
                  <li
                    key={stage.id}
                    className={
                      i < latest.stageIndex
                        ? "done"
                        : i === latest.stageIndex
                          ? "current"
                          : ""
                    }
                  >
                    <span>{i < latest.stageIndex ? "✓" : i + 1}</span>
                    <div>
                      <b>{stage.label}</b>
                      <small>
                        {i < latest.stageIndex
                          ? "완료"
                          : i === latest.stageIndex
                            ? "실행 중"
                            : "대기"}{" "}
                        ·{" "}
                        {stage.role
                          ? GENERATION_MODELS[stage.role].model
                          : "실행 엔진"}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="generator-note">
                처음 조회하는 과거 데이터는 수 분 이상 걸릴 수 있습니다. 탭을
                다시 열면 저장된 단계에서 이어집니다. 백그라운드 러너가 켜져
                있으면 탭을 닫아도 계속됩니다.
              </p>
            </>
          )}
          {latest.status === "completed" && (
            <p>
              {latest.selected?.candidate.name} · 아래 모의투자 또는 실전투자
              대시보드에서 실행할 수 있습니다. 실행 중인 대시보드에는 다음
              시작부터 적용됩니다.
            </p>
          )}
          {latest.error && <p className="generator-error">{latest.error}</p>}
          {latest.nextAction && <p>{latest.nextAction}</p>}
          {latest.pauseReason === "budget" && latest.status === "paused" && (
            <button
              onClick={() => void resumeBudget()}
              disabled={busy || !!active}
            >
              연구 예산 $8 추가하고 이어서 진행
            </button>
          )}
          {!!latest.attempts?.length && (
            <details>
              <summary>자동 개선 기록 · {latest.attempts.length}회</summary>
              <ul className="generator-events">
                {latest.attempts.map((a, i) => (
                  <li key={i}>
                    {a.attempt}회차: {a.reasons.join("; ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {latest.status !== "running" && (
            <details>
              <summary>검증 기록 · 모델별 작업 보기</summary>
              {latest.report && <p>{latest.report.summary}</p>}
              {latest.evidence && (
                <div className="lab-table-wrap">
                  <table className="lab-table">
                    <thead>
                      <tr>
                        <th>구간</th>
                        <th>기간</th>
                        <th>거래</th>
                        <th>순수익률</th>
                        <th>최대 낙폭</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(
                        [
                          "training",
                          "validation",
                          "holdout",
                          "stress",
                          "delayed",
                        ] as const
                      ).map((key, i) => {
                        const p = latest.evidence![key];
                        return (
                          <tr key={key}>
                            <td>
                              {
                                [
                                  "학습",
                                  "검증",
                                  "최종 미사용",
                                  "비용 2배",
                                  "5분 지연",
                                ][i]
                              }
                            </td>
                            <td>
                              {p.from}–{p.to}
                            </td>
                            <td>{p.metrics.totalTrades}</td>
                            <td>
                              {p.metrics.totalReturnPct?.toFixed(2) ?? "—"}%
                            </td>
                            <td>
                              {p.metrics.maxDrawdownPct?.toFixed(2) ?? "—"}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <ul className="generator-events">
                {latest.events.map((e, i) => (
                  <li key={i}>
                    {e.state === "done" ? "✓" : e.state === "error" ? "!" : "→"}{" "}
                    {e.detail}
                    {e.role && (
                      <small> · {GENERATION_MODELS[e.role].model}</small>
                    )}
                  </li>
                ))}
              </ul>
              <a
                href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(latest, null, 2))}`}
                download={`strategy-${latest.id}.json`}
              >
                전체 검증 기록 다운로드
              </a>
            </details>
          )}
        </div>
      )}
      <details className="generator-roster">
        <summary>역할별 모델 · 검증 기준</summary>
        <div className="generator-models">
          {Object.entries(GENERATION_MODELS).map(([key, m]) => (
            <div key={key}>
              <b>{m.label}</b>
              <span>{m.model}</span>
              <small>
                100만 토큰 입력 ${m.input} / 출력 ${m.output}
              </small>
            </div>
          ))}
        </div>
        <p>
          모델은 통과 기준을 낮출 수 없습니다. 실제 과거 봉 실행, 비용 2배·진입
          지연, 표본 수·손실·규칙 준수 기준과 타사 검증을 모두 통과해야
          등록됩니다. 과거 검증은 향후 수익을 보장하지 않습니다.
        </p>
      </details>
    </section>
  );
}
