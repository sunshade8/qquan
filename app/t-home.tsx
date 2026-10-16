"use client";

/**
 * T — CT's research engine on free models. The workspace below is a clone of CT's (own tables, own routes); this wrapper
 * adds the one thing CT does not have: which free model plays which role, ranked by LiveBench.
 */

import { useCallback, useEffect, useState } from "react";
import { CTWorkspace } from "./t-workspace";

type Placement = { role: string; model: string; name: string; family: string; score: number | null; scoreText: number | null; chain: string[] };
type Models = {
  router: { url: string; error: string | null; total: number; ready: number; fetchedAt: string };
  liveBench: { release: string; source: string };
  virtualRate: { input: number; output: number };
  independence: { sameCompany: boolean; models: { designer: string; risk: string; evidence: string } };
  placements: Placement[];
  ranked: Array<{ name: string; family: string; overall: number; ids: string[]; routable: boolean; listed: boolean }>;
};

const ROLE_LABEL: Record<string, string> = {
  ctDesigner: "설계자 · 도구 루프",
  ctRiskReviewer: "위험 검토",
  ctEvidenceReviewer: "최종 검토",
  ctOrchestrator: "총괄",
  ctAnalyst: "자료 분석",
  ctLessons: "교훈 증류",
};

function ModelPlacement() {
  const [data, setData] = useState<Models | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/invest/t?models=1${refresh ? "&refresh=1" : ""}`, { cache: "no-store" });
      const body = (await r.json()) as Models & { error?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setData(body);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "모델 목록을 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { queueMicrotask(() => void load(false)); }, [load]);

  return (
    <section className="ui-card pad" aria-labelledby="t-models-h" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 className="ui-title" id="t-models-h">모델 배치 <span className="ui-sub">LiveBench 2.0 · {data?.liveBench.release ?? "2026-10-14"}</span></h2>
        <button className="ui-btn" disabled={busy} onClick={() => void load(true)}>{busy ? "불러오는 중" : "모델 다시 불러오기"}</button>
      </div>
      {error ? <p className="ui-alert" role="alert">{error}</p> : null}
      {data ? (
        <>
          <p className="ui-sub">
            freellmapi <code>{data.router.url}</code> · {data.router.error ? `연결 실패: ${data.router.error}` : `모델 ${data.router.total}개 중 ${data.router.ready}개 사용 가능`} · 비용 $0 (예산은 가상 단가 ${data.virtualRate.input}/${data.virtualRate.output} per 1M 토큰으로 일의 양만 제한)
          </p>
          <div className="ui-scroll-x">
            <table className="ui-table">
              <thead><tr><th>역할</th><th>배치된 모델</th><th>계열</th><th>역할 점수</th><th>실패 시 순서</th></tr></thead>
              <tbody>
                {data.placements.map((p) => (
                  <tr key={p.role}>
                    <td>{ROLE_LABEL[p.role] ?? p.role}</td>
                    <td><code>{p.model}</code>{p.name !== p.model ? <> · {p.name}</> : null}</td>
                    <td>{p.family}</td>
                    <td className="ui-num">{p.scoreText != null ? p.scoreText.toFixed(1) : "미등재"}</td>
                    <td><small>{p.chain.join(" → ")}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.independence.sameCompany ? (
            <p className="ui-sub" role="note">검토자가 설계자와 같은 회사 계열입니다(지금 쓸 수 있는 키가 한 계열뿐). 모델은 달라서 같은 모델의 자기 검토는 아니지만, CT만큼 독립적이지는 않습니다. 다른 회사의 제공자 키를 freellmapi에 추가하면 다음 연구부터 자동으로 갈라집니다.</p>
          ) : (
            <p className="ui-sub" role="note">설계자와 검토자가 서로 다른 회사 계열입니다.</p>
          )}
          <details>
            <summary className="ui-sub">LiveBench 순위와 지금 쓸 수 있는지</summary>
            <div className="ui-scroll-x">
              <table className="ui-table">
                <thead><tr><th>모델</th><th>계열</th><th>종합</th><th>freellmapi 상태</th></tr></thead>
                <tbody>
                  {data.ranked.map((r) => (
                    <tr key={r.name}><td>{r.name}</td><td>{r.family}</td><td className="ui-num">{r.overall.toFixed(1)}</td><td>{r.routable ? "사용 가능" : r.listed ? "키 필요" : "미제공"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : null}
    </section>
  );
}

export function TWorkspace({ onPrepareData }: { onPrepareData?: () => void }) {
  return (
    <div className="t-home">
      <ModelPlacement />
      <CTWorkspace onPrepareData={onPrepareData} />
    </div>
  );
}
