"use client";
import { useCallback, useEffect, useState } from "react";
import CloudDownload from "lucide-react/dist/esm/icons/cloud-download";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert";
import type { CTMarket } from "@/lib/ct-spec";

type Job = { status?: string; done?: number; total?: number; errors?: string } | null;
type DataStatus = { dataset: string; instrument: string; missingRanges: number[][]; job?: Job };
export type StaleDataset = { dataset: string; instrument: string; days: number; progress: number; job: Job };

const DAY_MS = 86_400_000;
const ACTIVE = new Set(["queued", "running"]);

/**
 * The research window ends at yesterday 00:00 UTC and moves forward every day, so after a few days away the local
 * 1-minute store is several days short. The download worker tops it up by itself (scripts/data/store.py
 * auto_topup); this hook only reports how far behind the selected market is, so the screen can say so before the
 * button is pressed (the server refuses a window with a missing day) and show progress while it catches up.
 */
export function useStaleData(market: CTMarket, symbols: string, days: string) {
  const [rows, setRows] = useState<DataStatus[] | null>(null),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/local-data", { cache: "no-store" });
      const body = await r.json();
      if (r.ok && Array.isArray(body)) setRows(body as DataStatus[]);
    } catch {
      /* the research request reports its own connection error */
    }
  }, []);
  const toMs = Math.floor((Date.now() - DAY_MS) / DAY_MS) * DAY_MS,
    fromMs = toMs - (Number(days) || 365) * DAY_MS,
    wanted = symbols.toUpperCase().split(/[,\s]+/).filter(Boolean),
    stale: StaleDataset[] = (rows ?? [])
      .filter((d) => {
        if (market === "stock" ? d.dataset !== "stock" : d.dataset === "stock") return false;
        if (market === "crypto" && wanted.length && !wanted.some((w) => w.startsWith(d.dataset.toUpperCase()))) return false;
        return d.missingRanges.some(([a, b]) => a < toMs && b > fromMs);
      })
      .map((d) => {
        const missing = d.missingRanges.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, toMs) - Math.max(a, fromMs)), 0);
        const active = d.job && ACTIVE.has(d.job.status ?? "");
        return {
          dataset: d.dataset,
          instrument: d.instrument,
          days: Math.max(1, Math.ceil(missing / DAY_MS)),
          progress: active && d.job?.total ? Math.min(1, (d.job.done ?? 0) / d.job.total) : 0,
          job: d.job ?? null,
        };
      }),
    waiting = stale.length > 0;
  useEffect(() => {
    queueMicrotask(() => void refresh());
    // Poll quickly only while there is something to watch; the status call reads every dataset.
    const timer = setInterval(() => void refresh(), waiting ? 4_000 : 20_000);
    return () => clearInterval(timer);
  }, [refresh, waiting]);
  const topUp = async () => {
    setBusy(true);
    setFailure(null);
    try {
      for (const d of stale) {
        if (ACTIVE.has(d.job?.status ?? "")) continue;
        const r = await fetch("/api/local-data", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "enqueue", dataset: d.dataset }),
        });
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "다운로드 요청 실패");
      }
      await refresh();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { stale, busy, failure, topUp };
}

/** Shown in place of the start gate while the store catches up. Calm, one number, no spinner theatre. */
export function DataSyncCard({ sync }: { sync: ReturnType<typeof useStaleData> }) {
  const { stale } = sync;
  if (!stale.length) return null;
  const working = stale.some((d) => ACTIVE.has(d.job?.status ?? "")),
    failed = !working && stale.some((d) => d.job?.status === "error"),
    progress = stale.reduce((n, d) => n + d.progress, 0) / stale.length,
    days = Math.max(...stale.map((d) => d.days));
  const title = failed
    ? "데이터를 내려받지 못했습니다"
    : working
      ? "최신 데이터를 내려받고 있어요"
      : "다운로드를 준비하고 있어요";
  const body = failed
    ? "잠시 뒤 자동으로 다시 시도합니다. 바로 다시 받으려면 아래 버튼을 눌러 주세요."
    : `최근 ${days}일치가 비어 있습니다. 끝나면 전략 생성이 자동으로 열리니 잠시만 기다려 주세요. 창을 닫아도 계속 받습니다.`;
  return (
    <section className="ct-sync ui-card" data-state={failed ? "error" : working ? "working" : "queued"} data-testid="ct-data-stale" aria-live="polite">
      <div className="ct-sync-head">
        <span className="ct-sync-icon" aria-hidden="true">{failed ? <CircleAlert size={18} /> : <CloudDownload size={18} />}</span>
        <div className="ct-sync-copy">
          <strong>{title}</strong>
          <p>{body}</p>
        </div>
        {!working ? (
          <button className="ui-btn sm" disabled={sync.busy} onClick={() => void sync.topUp()}>
            {failed ? "다시 받기" : "지금 시작"}
          </button>
        ) : (
          <span className="ct-sync-pct ui-num">{Math.round(progress * 100)}%</span>
        )}
      </div>
      <span className="ct-sync-rail" role="progressbar" aria-label="데이터 다운로드 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
        <i style={{ "--v": working ? Math.max(progress, 0.04) : 0 } as React.CSSProperties} data-indeterminate={working && progress === 0 ? "" : undefined} />
      </span>
      <ul className="ct-sync-list">
        {stale.map((d) => (
          <li key={d.dataset}>
            <span>{d.instrument}</span>
            <span className="ui-num">
              {ACTIVE.has(d.job?.status ?? "")
                ? `${d.job?.done ?? 0}/${d.job?.total ?? 0} 구간`
                : d.job?.status === "error"
                  ? "오류 · 재시도 대기"
                  : `${d.days}일 남음`}
            </span>
          </li>
        ))}
      </ul>
      {sync.failure ? <p className="ct-sync-error">{sync.failure}</p> : null}
    </section>
  );
}
