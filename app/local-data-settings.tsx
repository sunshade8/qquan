"use client";
import { useEffect, useState } from "react";
type Job = {
  id: string;
  status: string;
  done: number;
  total: number;
  errors: string;
  start: number;
  end: number;
};
type Dataset = {
  dataset: "stock" | "btc" | "eth" | "sol";
  location: string;
  status: string;
  target: number[];
  coverage: number[][];
  rows: number;
  bytes: number;
  updated: number | null;
  latest: number | null;
  corruptFiles: number;
  job: Job | null;
};
const date = (n: number) => new Date(n).toLocaleDateString("ko-KR");
export default function LocalDataSettings() {
  const [data, setData] = useState<Dataset[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      const r = await fetch("/api/local-data", { signal: AbortSignal.timeout(120_000) });
      const d = (await r.json()) as Dataset[] & { error?: string };
      if (!r.ok) throw Error(d.error);
      setData(d);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (!stopped) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 0);
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  async function action(body: object) {
    setBusy(true);
    try {
      const r = await fetch("/api/local-data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const d = (await r.json()) as { error?: string };
      if (!r.ok) throw Error(d.error);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div id="local-market-data">
      <h2>공유 로컬 1분봉 저장소</h2>
      <p>
        브라우저를 닫아도 로컬 실행기가 계속 처리합니다. 컴퓨터가 잠들거나
        꺼지면 중단되며 실행기를 다시 시작하면 완료 구간을 재사용합니다.
      </p>
      {error && <p role="alert">{error}</p>}
      {!error && data.length > 0 && <p>로컬 저장소 연결됨 · 저장된 파일 검증 결과</p>}
      {data.map((d) => (
        <article key={d.dataset} style={{ display: "block" }}>
          <h3>
            {d.dataset === "stock"
              ? "주식 1분봉 · NVDA · Massive"
              : `코인 1분봉 · ${{ btc: "BTCUSDT", eth: "ETHUSDT", sol: "SOLUSDT" }[d.dataset]} Spot · Binance Public Data`}{" "}
            · 최근 5년
          </h3>
          <p>
            {
              (
                {
                  empty: "데이터 없음",
                  partial: "부분 확보",
                  ready: "준비 완료",
                } as Record<string, string>
              )[d.status]
            }{" "}
            · 작업 {d.job?.status ?? "없음"} · 손상 파일 {d.corruptFiles}
          </p>
          <p>
            저장 위치: <code>{d.location}</code>
          </p>
          <p>
            목표 {date(d.target[0])}–{date(d.target[1])} · 실제 검증{" "}
            {d.coverage.length
              ? `${date(Math.min(...d.coverage.map((c) => c[0])))}–${date(Math.max(...d.coverage.map((c) => c[1])))}`
              : "없음"}{" "}
            ({d.coverage.length}개 구간, 내부 부족 구간은 준비 완료에 포함하지
            않음)
          </p>
          <p>
            {d.rows.toLocaleString()}행 · {(d.bytes / 1048576).toFixed(2)} MiB ·
            마지막 검증{" "}
            {d.updated ? new Date(d.updated).toLocaleString("ko-KR") : "없음"} ·
            최신 봉{" "}
            {d.latest ? new Date(d.latest).toLocaleString("ko-KR") : "없음"}
          </p>
          {d.job && (
            <>
              <p>
                파일 요청 구간 작업 {d.job.done}/{d.job.total} 완료 · 요청{" "}
                {date(d.job.start)}–{date(d.job.end)}
              </p>
              {d.job.errors !== "[]" && (
                <p role="alert">
                  {d.job.errors} · 권한 오류는 Massive 요금제/키를 확인하고,
                  미공개 아카이브는 공개 후 재개하세요.
                </p>
              )}
            </>
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              disabled={busy}
              onClick={() =>
                void action({ action: "enqueue", dataset: d.dataset })
              }
            >
              다운로드 / 증분 갱신
            </button>
            {d.job && (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action({ action: "cancel", id: d.job!.id })
                  }
                >
                  취소
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action({ action: "resume", id: d.job!.id })
                  }
                >
                  재개
                </button>
              </>
            )}
          </div>
          <p>
            {d.dataset === "stock"
              ? "Massive 실제 이용 권한에 따라 과거 범위가 거부될 수 있습니다. 5년 목표와 확보 범위를 구분합니다."
              : "USDT 가격을 KRW로 변환하지 않습니다. 공개 지연이 있으며 Upbit 실거래와 별개입니다."}
          </p>
        </article>
      ))}
    </div>
  );
}
