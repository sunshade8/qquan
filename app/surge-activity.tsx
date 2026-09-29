"use client";

import { useEffect, useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Clock from "lucide-react/dist/esm/icons/clock";
import { SURGE_STAGES, type SurgeActivity, type SurgeJob } from "@/lib/surge-types";
import { GENERATION_MODELS } from "@/lib/strategy-generation-models";

export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분`;
}

export function SurgeActivityPanel({ job, streamed, online }: {
  job: Omit<SurgeJob, "ownerId">; streamed: SurgeActivity[]; online: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (job.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job.status]);
  const entries = [...new Map([...(job.activities ?? []), ...streamed.filter((entry) => job.status === "running" || entry.at <= job.updatedAt)].map((entry) => [entry.id, entry])).values()]
    .sort((a, b) => a.at.localeCompare(b.at)).slice(-160);
  const last = entries.at(-1);
  const running = job.status === "running";
  const end = running ? now : Date.parse(job.updatedAt);
  const retrying = running && !!job.retryAt && Date.parse(job.retryAt) > now;
  const quietMs = now - Date.parse(last?.at ?? job.updatedAt);
  const currentStage = SURGE_STAGES[job.stageIndex];
  const groups = entries.reduce<Array<{ key: string; stage: SurgeActivity["stage"]; attempt: number; rows: SurgeActivity[] }>>((all, entry) => {
    const key = `${entry.attempt}:${entry.stage}`;
    if (all.at(-1)?.key === key) all.at(-1)!.rows.push(entry);
    else all.push({ key, stage: entry.stage, attempt: entry.attempt, rows: [entry] });
    return all;
  }, []);
  return <section className="surge-activity" aria-label="에이전트 실제 작업 내역">
    <header className="surge-activity-head">
      <span className={`surge-activity-indicator ${running && online && !retrying ? "active" : ""}`} aria-hidden />
      <strong>{!online ? "연결 확인 필요" : retrying ? "모델 호출 재시도 대기" : running ? "에이전트 작업 내역" : "작업 기록"}</strong>
      <span className="surge-activity-clock"><Clock size={13} aria-hidden />시작 후 {duration(end - Date.parse(job.createdAt))}</span>
    </header>
    <div className="surge-activity-current" role="status" aria-live="polite">
      <b>{!online ? "연결이 끊겨 현재 작업을 확인할 수 없습니다" : retrying ? "호출 한도로 다음 재시도를 기다리고 있습니다" : (!running ? job.error : null) ?? last?.detail ?? job.events.at(-1)?.detail ?? "첫 실행 기록을 기다리고 있습니다"}</b>
    </div>
    <div className="surge-activity-timing">
      {retrying ? <span>재시도까지 {duration(Date.parse(job.retryAt!) - now)}</span> : running && last ? <span>마지막 작업 소식 {duration(quietMs)} 전</span> : null}
      {running && <span>{currentStage?.role ? "모델 응답 시간은 예측할 수 없습니다" : "전체 완료 시간은 데이터 확보와 검증 결과에 따라 달라집니다"}</span>}
      {running && online && !retrying && quietMs > 45_000 && <span className="surge-activity-wait">새 작업 기록을 기다리고 있습니다. 경과 시간은 작업 진척을 의미하지 않습니다.</span>}
    </div>
    <div className="surge-activity-groups">
      {groups.toReversed().map((group, index) => {
        const stage = SURGE_STAGES.find((item) => item.id === group.stage)!;
        const current = index === 0;
        const first = group.rows[0];
        const tail = group.rows.at(-1)!;
        return <details key={`${group.key}:${index}`} open={current} className="surge-activity-group">
          <summary>
            <ChevronRight size={14} aria-hidden />
            <span>{stage.label}<small>{group.attempt}회차 · {stage.role ? GENERATION_MODELS[stage.role].model : "실행 엔진"}</small></span>
            <time>{new Date(first.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 시작</time>
          </summary>
          <ol>
            {group.rows.toReversed().map((row) => <li key={row.id} className={row.kind}>
              <span className="surge-activity-mark" aria-hidden>{row.kind === "done" ? "✓" : row.kind === "error" ? "!" : "·"}</span>
              <span>{row.detail}</span>
              <time dateTime={row.at}>{new Date(row.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
            </li>)}
          </ol>
          <footer>표시된 기록 구간 {duration(Date.parse(tail.at) - Date.parse(first.at))}</footer>
        </details>;
      })}
    </div>
    <p className="surge-activity-caption">실제 실행 이벤트 · 최신순 · 최근 160개 기록 · 시작 후 시간에는 대기·일시정지가 포함됩니다</p>
  </section>;
}
