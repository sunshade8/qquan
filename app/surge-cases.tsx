"use client";

import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { useCallback, useEffect, useState } from "react";
import type { CaseProfile } from "@/lib/surge-cases";

type Case = {
  id: string; statedDate: string; symbol: string; board: string; reportedPct: number; rank: number;
  status: "pending" | "collected" | "mismatch" | "failed"; sessionDate: string | null; note: string | null; profile: CaseProfile | null;
};
type Stage = { id: string; label: string; role: string | null; kind: string; state: "done" | "ready" | "waiting"; detail: string };
type Payload = { cases: Case[]; counts: { recorded: number; collected: number; pending: number; failed: number; nights: number }; agent: Stage[]; error?: string };

const STATUS_LABEL: Record<Case["status"], string> = { pending: "수집 대기", collected: "수집됨", mismatch: "확인 필요", failed: "실패" };
const STATE_LABEL: Record<Stage["state"], string> = { done: "완료", ready: "실행 가능", waiting: "대기" };
const pct = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`);
const tone = (value: number | null | undefined) => (value === null || value === undefined ? "" : value > 0 ? "positive" : value < 0 ? "negative" : "");

export function SurgeCases() {
  const [data, setData] = useState<Payload | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/invest/surge/cases", { cache: "no-store" });
      const payload = await response.json() as Payload;
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setData(payload);
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); const timer = setInterval(() => void load(), 30_000); return () => clearInterval(timer); }, [load]);

  const record = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/invest/surge/cases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "record", text }) });
      const payload = await response.json() as { error?: string; recorded?: { parsed: unknown[]; errors: Array<{ line: string; reason: string }> }; collected?: { collected: number; waiting: number } };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      const errors = payload.recorded?.errors ?? [];
      setMessage(`${payload.recorded?.parsed.length ?? 0}건 기록 · 바로 수집 ${payload.collected?.collected ?? 0}건 · 장 마감 대기 ${payload.collected?.waiting ?? 0}건${errors.length ? ` · 읽지 못한 줄 ${errors.length}: ${errors.map((e) => `"${e.line}" (${e.reason})`).join(", ")}` : ""}`);
      if (!errors.length) setText("");
      await load();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return <section className="surge-live surge-cases">
    <header>
      <div>
        <span>CASES · 토스 TOP10 기록</span>
        <strong>급등락 사례 {data ? `${data.counts.recorded}건 · ${data.counts.nights}일` : "…"}</strong>
      </div>
      <div className="surge-pool-switch"><button onClick={() => void load()}><RefreshCw size={12} />새로고침</button></div>
    </header>
    <p className="surge-note">
      데이터는 <strong>소유자가 매일 한국시간 00:00에 넘기는 토스 급상승·급하락 상위 10개</strong>뿐입니다(토스 랭킹은 당일만 조회되고 시간대마다 바뀌어서 과거를 재구성하지 않습니다).
      00:00 KST는 미국 정규장 <strong>11:00 ET(서머타임) / 10:00 ET(겨울)</strong>입니다 — 각 사례는 &quot;그 시각에 목록에 있었다&quot;는 기록이고, 그 이전은 배경, 이후가 매매 대상입니다.
      장이 끝나면(20:00 ET) 그 종목의 당일 1분봉을 토스에서 받아 붙입니다. 날짜를 한국 날짜로 적어도, 다시 계산한 스냅샷 등락률이 받은 값과 맞는 세션으로 자동 해석합니다.
    </p>
    <div className="surge-case-input">
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} placeholder={"날짜/종목/등락폭 — 한 줄에 하나\n2026-09-30/ABCD/+45.2%\n2026-09-30/WXYZ/-31.0%"} />
      <button onClick={() => void record()} disabled={busy || !text.trim()}>{busy ? "기록 중" : "기록"}</button>
    </div>
    {message && <p className="surge-note">{message}</p>}

    <div className="surge-agent">
      {data?.agent.map((stage, index) => <div key={stage.id} className={stage.state}>
        <b>{index + 1}. {stage.label}</b>
        <small>{STATE_LABEL[stage.state]}{stage.kind === "model" ? " · 모델" : ""} — {stage.detail}</small>
      </div>)}
    </div>

    {!!data?.cases.length && <div className="lab-table-wrap"><table className="lab-table">
      <thead><tr><th>날짜(받은 값)</th><th>순위</th><th>종목</th><th>받은 등락폭</th><th>상태</th><th>미국 세션 · 스냅샷</th><th>스냅샷 재계산</th><th>스냅샷 이후 → 종가</th><th>이후 최대 ↑ / ↓</th></tr></thead>
      <tbody>{data.cases.map((row) => <tr key={row.id} title={row.note ?? undefined}>
        <td>{row.statedDate}</td>
        <td>{row.board === "gainers" ? "↑" : "↓"}{row.rank}</td>
        <td><strong>{row.symbol}</strong></td>
        <td className={tone(row.reportedPct)}>{pct(row.reportedPct)}</td>
        <td>{STATUS_LABEL[row.status]}{row.note ? <small> · {row.note}</small> : null}</td>
        <td>{row.sessionDate ? `${row.sessionDate} · ${row.profile?.snapshotEt ?? ""} ET` : "—"}</td>
        <td className={tone(row.profile?.changeAtSnapshotPct)}>{pct(row.profile?.changeAtSnapshotPct)}</td>
        <td className={tone(row.profile?.afterSnapshot?.toClosePct)}>{pct(row.profile?.afterSnapshot?.toClosePct)}</td>
        <td>{row.profile?.afterSnapshot ? `${pct(row.profile.afterSnapshot.maxUpPct)} (${row.profile.afterSnapshot.maxUpAt}) / ${pct(row.profile.afterSnapshot.maxDownPct)} (${row.profile.afterSnapshot.maxDownAt})` : "—"}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
