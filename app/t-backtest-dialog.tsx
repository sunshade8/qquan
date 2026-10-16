"use client";
import "./ct.css";
import { useEffect, useState } from "react";
import type { CTPackage } from "@/lib/t-research-store";
import type { CTResult } from "@/lib/t-engine";
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
        거래 {result.trades.length} · 수익 {result.netReturnPct.toFixed(2)}% ·
        낙폭 {result.maxDrawdownPct.toFixed(2)}%
      </span>
      <span>
        승률 {result.winRatePct.toFixed(2)}% · 비용 {result.costs.toFixed(4)}
      </span>
    </div>
  );
}
export function CTBacktestDialog({
  book,
  onClose,
}: {
  book: "ct-stock" | "ct-crypto";
  onClose: () => void;
}) {
  const [data, setData] = useState<{
      package: CTPackage;
      result: CTResult;
    } | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch(
      `/api/invest/t/backtest?market=${book === "ct-stock" ? "stock" : "crypto"}`,
      { signal: abort.signal },
    )
      .then(async (r) => {
        const p = (await r.json()) as {
          package: CTPackage;
          result: CTResult;
          error?: string;
        };
        if (!r.ok) throw new Error(p.error);
        setData(p);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => abort.abort();
  }, [book]);
  return (
    <div className="strategy-modal-backdrop">
      <section
        className="strategy-modal"
        role="dialog"
        aria-modal="true"
        aria-label="CT 동결 규칙 백테스트"
      >
        <header>
          <h2>CT 동결 규칙 백테스트</h2>
          <button onClick={onClose} aria-label="닫기">
            ×
          </button>
        </header>
        <div className="strategy-modal-scroll">
          {error ? (
            <p role="alert">{error}</p>
          ) : data ? (
            <>
              <p>
                {data.package.spec.name} · {data.package.hash}
              </p>
              <p>
                등록 당시 동결한 전체 기간을 같은 엔진으로 재계산합니다. 원래
                최종 검증 결과와 별도로 표시하며 새 검증 승인에 사용하지
                않습니다.
              </p>
              <ResultMetrics
                result={data.result}
                label="동결 전체 기간 재계산"
              />
              <button
                onClick={() =>
                  download(data, `ct-backtest-${data.package.id}.json`)
                }
              >
                백테스트 결과 다운로드
              </button>
            </>
          ) : (
            <p>동일 데이터·규칙 해시 확인 후 재계산 중…</p>
          )}
        </div>
      </section>
    </div>
  );
}
