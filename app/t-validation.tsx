"use client";
import { useCallback, useEffect, useState } from "react";
import type {
  CTExperimentRow,
  CTExperimentDay,
  CTExperimentManifest,
} from "@/lib/t-experiment-store";
import { CT_BASELINE_VERSIONS } from "@/lib/t-decision-playbooks";
import type { CTMarket } from "@/lib/t-spec";
import type { CTResult } from "@/lib/t-engine";
import type { CTCapability } from "@/lib/t-capabilities";
type Packet = { experiment: CTExperimentRow; days: CTExperimentDay[] };
const endpoint = "/api/invest/t/experiments",
  pct = (n: number | null | undefined) =>
    n == null ? "정의 불가" : `${n.toFixed(4)}%`;
const push = (values: Record<string, string>) => {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(values))
    if (v) u.searchParams.set(k, v);
    else u.searchParams.delete(k);
  history.pushState({}, "", u);
};
function EquityChart({ days }: { days: CTExperimentDay[] }) {
  const curves = [0, 1].map((i) =>
      days.map((d) => d.arms[i].result.daily.at(-1)?.equity ?? null),
    ),
    all = curves.flat().filter((n): n is number => n !== null);
  if (!all.length) return <p className="ui-sub">저장된 일별 자산 없음</p>;
  const lo = Math.min(...all),
    hi = Math.max(...all),
    y = (n: number) => 100 - ((n - lo) / Math.max(0.0001, hi - lo)) * 90;
  return (
    <svg
      viewBox="0 0 700 125"
      role="img"
      aria-label="동일 초기 자본의 기준·변경 일별 누적 자산"
      className="ct-comparison-chart"
    >
      {curves.map((xs, i) => (
        <polyline
          key={i}
          fill="none"
          stroke={i ? "var(--accent,#2563eb)" : "currentColor"}
          strokeDasharray={i ? undefined : "5 4"}
          strokeWidth="2"
          points={xs
            .flatMap((n, k) =>
              n === null
                ? []
                : [`${10 + (k / Math.max(1, xs.length - 1)) * 680},${y(n)}`],
            )
            .join(" ")}
        />
      ))}
      <text x="10" y="120" fill="currentColor" fontSize="10">
        기준 점선 · 변경 실선
      </text>
    </svg>
  );
}
function DecisionReplay({
  day,
  onClose,
}: {
  day: CTExperimentDay;
  onClose: () => void;
}) {
  const times = [
    ...new Set(
      day.arms.flatMap((a) => a.decisions.map((d) => d.observedThrough)),
    ),
  ].sort((a, b) => a - b);
  const [index, setIndex] = useState(() => {
      const t = Number(
        typeof location !== "undefined"
          ? new URLSearchParams(location.search).get("decision")
          : 0,
      );
      return Math.max(0, times.indexOf(t));
    }),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [outcome, setOutcome] = useState(false),
    [visible, setVisible] = useState("both");
  const at = times[index] ?? day.bars[0]?.endMs ?? 0,
    prices = day.bars.filter((b) => outcome || b.endMs <= at),
    values = prices.flatMap((b) => [b.high, b.low]),
    lo = Math.min(...values),
    hi = Math.max(...values),
    y = (n: number) => 180 - ((n - lo) / Math.max(0.0001, hi - lo)) * 165;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        setIndex((i) => {
          if (i >= times.length - 1) {
            setPlaying(false);
            return i;
          }
          return i + 1;
        }),
      1000 / speed,
    );
    return () => clearInterval(timer);
  }, [playing, speed, times.length]);
  const select = (i: number) => {
    setIndex(i);
    push({ decision: String(times[i]) });
  };
  return (
    <section className="ui-card pad ct-replay" aria-label="동기 판단 리플레이">
      <div className="ct-compare-toolbar">
        <button className="ui-btn sm" onClick={onClose}>
          비교로 돌아가기
        </button>
        <strong>
          {day.day} ·{" "}
          {new Date(at).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}{" "}
          KST
        </strong>
        <button
          className="ui-btn sm"
          onClick={() => setPlaying((p) => !p)}
          disabled={!times.length}
        >
          {playing ? "일시정지" : "재생"}
        </button>
        <button
          className="ui-btn sm"
          onClick={() => select(Math.max(0, index - 1))}
          disabled={!index}
        >
          이전 판단
        </button>
        <button
          className="ui-btn sm"
          onClick={() => select(Math.min(times.length - 1, index + 1))}
          disabled={index >= times.length - 1}
        >
          다음 판단
        </button>
        <label>
          속도{" "}
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
        </label>
        <label>
          버전{" "}
          <select value={visible} onChange={(e) => setVisible(e.target.value)}>
            <option value="both">기준·변경</option>
            <option value="0">기준</option>
            <option value="1">변경</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={outcome}
            onChange={(e) => setOutcome(e.target.checked)}
          />{" "}
          결과 보기
        </label>
      </div>
      <p className="ui-sub">
        {outcome
          ? "완료 일자의 사후 복기입니다. 당시 판단 입력과 구별합니다."
          : "당시 정보 · 커서 이후 가격과 성과, 차트 축 범위를 숨깁니다."}
      </p>
      {prices.length ? (
        <svg
          viewBox="0 0 700 200"
          role="img"
          aria-label="현재 커서까지 관측한 가격"
          className="ct-comparison-chart"
        >
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            points={prices
              .map(
                (b, i) =>
                  `${10 + (i / Math.max(1, prices.length - 1)) * 680},${y(b.close)}`,
              )
              .join(" ")}
          />
          <text x="10" y="198" fill="currentColor" fontSize="10">
            {lo.toFixed(2)} … {hi.toFixed(2)}
          </text>
        </svg>
      ) : (
        <p>현재 시각의 관측 데이터 없음</p>
      )}
      <div className="ct-replay-arms">
        {day.arms.map((a, i) => {
          if (visible !== "both" && visible !== String(i)) return null;
          const d = a.decisions.filter((d) => d.observedThrough <= at).at(-1);
          return (
            <article key={i}>
              <h3>
                {i ? "변경" : "기준"} · {a.version}
              </h3>
              {d ? (
                <>
                  <dl className="ct-prose">
                    <div>
                      <dt>상황</dt>
                      <dd>{d.context}</dd>
                    </div>
                    <div>
                      <dt>플레이북</dt>
                      <dd>{d.selectedPlaybook ?? "관망"}</dd>
                    </div>
                    <div>
                      <dt>행동</dt>
                      <dd>
                        {d.action} · {d.accepted ? "서버 수락" : "거부"}
                      </dd>
                    </div>
                    <div>
                      <dt>기다리는 조건</dt>
                      <dd>{d.waitingFor}</dd>
                    </div>
                    <div>
                      <dt>무효화</dt>
                      <dd>
                        {/* Stored decisions keep epoch ms; show it as the KST clock without rewriting the frozen record. */}
                        {d.invalidation.replace(/만료 (\d{13})/, (_, ms: string) =>
                          `만료 ${new Date(Number(ms)).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })} KST`,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>위험/증거금</dt>
                      <dd>위험 0.5% · 배분 상한 25% · 현금 계좌</dd>
                    </div>
                    <div>
                      <dt>근거</dt>
                      <dd>{d.rationale}</dd>
                    </div>
                  </dl>
                  <details>
                    <summary>입력 snapshot·판단 해시</summary>
                    <code>{day.snapshot}</code>
                    <p>
                      <code>{d.inputHash}</code>
                    </p>
                    <pre>{JSON.stringify(d.setup, null, 2)}</pre>
                  </details>
                </>
              ) : (
                <p>이 시각의 판단 없음</p>
              )}
            </article>
          );
        })}
      </div>
      <details>
        <summary>판단 이벤트 · 체결 · 비용</summary>
        {day.arms.map((a, i) => (
          <div key={i}>
            <h4>{i ? "변경" : "기준"}</h4>
            <p>
              관망{" "}
              {
                a.decisions.filter(
                  (d) => d.observedThrough <= at && d.action === "NO_TRADE",
                ).length
              }
              회 · 대기{" "}
              {
                a.decisions.filter(
                  (d) => d.observedThrough <= at && d.action === "WAIT",
                ).length
              }
              회
            </p>
            <pre>
              {JSON.stringify(
                a.result.trades.filter((t) => outcome || t.exitAt <= at),
                null,
                2,
              )}
            </pre>
          </div>
        ))}
      </details>
    </section>
  );
}
export function CTValidation({
  market,
  runId,
}: {
  market: CTMarket;
  runId?: string;
}) {
  const [rows, setRows] = useState<CTExperimentRow[]>([]),
    [packet, setPacket] = useState<Packet | null>(null),
    [id, setId] = useState(() =>
      typeof location !== "undefined"
        ? (new URLSearchParams(location.search).get("experiment") ?? "")
        : "",
    ),
    [create, setCreate] = useState(false),
    [baseline, setBaseline] = useState(CT_BASELINE_VERSIONS[0].id as string),
    [changed, setChanged] = useState(CT_BASELINE_VERSIONS[1].id as string),
    [change, setChange] = useState("상황 필터 추가"),
    [days, setDays] = useState(30),
    [split, setSplit] = useState("development"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [day, setDay] = useState(() =>
      typeof location !== "undefined"
        ? (new URLSearchParams(location.search).get("day") ?? "")
        : "",
    );
  const load = useCallback(async () => {
    try {
      const response = await fetch(
        endpoint +
          "?market=" +
          market +
          (id ? "&id=" + encodeURIComponent(id) : ""),
      );
      const p = (await response.json()) as Packet & {
        error?: string;
        experiments: CTExperimentRow[];
      };
      if (!response.ok) throw new Error(p.error ?? "요청 실패");
      if (id) setPacket(p);
      else setRows(p.experiments);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id, market]);
  useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, [load]);
  useEffect(() => {
    const pop = () => {
      const q = new URLSearchParams(location.search);
      setId(q.get("experiment") ?? "");
      setDay(q.get("day") ?? "");
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (packet?.experiment.status !== "running") return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [packet?.experiment.status, load]);
  const act = async (action: string) => {
    setBusy(true);
    setError("");
    try {
      const body =
        action === "create"
          ? {
              action,
              requestId: crypto.randomUUID(),
              market,
              ...(runId ? { runId } : {}),
              baseline,
              changed,
              change,
              maxDays: days,
              split,
            }
          : { action, id };
      const r = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        p = (await r.json()) as {
          error?: string;
          experiment?: CTExperimentRow;
        };
      if (!r.ok) throw new Error(p.error ?? "요청 실패");
      if (p.experiment) {
        setId(p.experiment.id);
        push({ experiment: p.experiment.id, day: "" });
        setCreate(false);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const selectedDay = packet?.days.find((d) => d.day === day),
    m = packet
      ? (JSON.parse(packet.experiment.manifest) as CTExperimentManifest)
      : null,
    result = packet?.experiment.result
      ? (JSON.parse(packet.experiment.result) as {
          verdict: string;
          reason: string;
          mean: number | null;
          ci: [number, number] | null;
          baseline: Record<string, number | null>;
          changed: Record<string, number | null>;
        })
      : null;
  if (selectedDay)
    return (
      <DecisionReplay
        key={day}
        day={selectedDay}
        onClose={() => {
          setDay("");
          push({ day: "", decision: "" });
        }}
      />
    );
  return (
    <section className="ct-validation" aria-label="검증 비교">
      <div className="ct-compare-toolbar">
        <button
          className="ui-btn"
          onClick={() => {
            setId("");
            setPacket(null);
            push({ experiment: "", day: "" });
          }}
        >
          비교 기록 선택
        </button>
        <button className="ui-btn" onClick={() => setCreate((c) => !c)}>
          새 비교
        </button>
        <span className="ui-sub">
          {market === "crypto"
            ? "Binance · Spot · USDT"
            : "Toss · 미국 현금 주식 · USD"}
        </span>
      </div>
      {error ? (
        <p className="ui-alert" role="alert">
          {error}
        </p>
      ) : null}
      {create ? (
        <form
          className="ui-card pad ct-compare-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act("create");
          }}
        >
          <h2 className="ui-title">새 비교</h2>
          <label>
            기준 버전
            <select
              value={baseline}
              onChange={(e) => setBaseline(e.target.value)}
            >
              {CT_BASELINE_VERSIONS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            변경 버전
            <select
              value={changed}
              onChange={(e) => setChanged(e.target.value)}
            >
              {CT_BASELINE_VERSIONS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            이번에 바꾼 것 하나
            <input
              required
              minLength={3}
              value={change}
              onChange={(e) => setChange(e.target.value)}
            />
          </label>
          <label>
            평가 구간
            <select value={split} onChange={(e) => setSplit(e.target.value)}>
              <option value="development">준비된 개발 구간</option>
              <option value="final">최종 구간 · 공동 1회 소비</option>
            </select>
          </label>
          <label>
            평가 일수
            <input
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </label>
          <p className="ui-sub">
            동일 snapshot·초기 자본·위험·비용을 적용합니다. 판단은 무료 고정
            정책이며 모델 호출 비용 $0입니다. 실제 설정 차이는 서버가 계산해
            저장합니다. 최소 30일/20거래와 스트레스 게이트를 충족해야 개선을
            확인합니다.
          </p>
          <button type="submit" className="ui-btn" disabled={busy}>
            설정 고정하고 비교 시작
          </button>
        </form>
      ) : null}
      {!id && !create ? (
        <div className="ui-scroll-x">
          <table className="ui-table">
            <thead>
              <tr>
                <th scope="col">날짜</th>
                <th scope="col">기준 → 변경</th>
                <th scope="col">변경점</th>
                <th scope="col">평가 기간</th>
                <th scope="col">상태·판정</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const m = JSON.parse(r.manifest) as CTExperimentManifest;
                return (
                  <tr key={r.id}>
                    <td>
                      <button
                        className="ui-btn sm"
                        onClick={() => {
                          setId(r.id);
                          push({ experiment: r.id });
                        }}
                      >
                        {new Date(r.created_at).toLocaleDateString("ko-KR")}
                      </button>
                    </td>
                    <td>
                      {m.baseline} → {m.changed}
                    </td>
                    <td>{m.change}</td>
                    <td>
                      {new Date(m.from).toISOString().slice(0, 10)} …{" "}
                      {new Date(m.to - 1).toISOString().slice(0, 10)}
                    </td>
                    <td>
                      {r.status} ·{" "}
                      {r.result ? JSON.parse(r.result).verdict : "평가 대기"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length ? (
            <p className="ui-sub">
              비교 기록이 없습니다. 등록 전략 없이 기준 플레이북으로 비교할 수
              있습니다.
            </p>
          ) : null}
        </div>
      ) : null}
      {packet && m ? (
        <article className="ui-card pad">
          <h2 className="ui-title">
            {m.baseline} → {m.changed} · {packet.experiment.status}
          </h2>
          <p>
            변경점: {m.change} ·{" "}
            {m.comparisonKind === "single-change"
              ? "단일 기능 효과 비교"
              : "전체 구성 비교"}
          </p>
          <p className="ui-sub">
            평가 {new Date(m.from).toISOString().slice(0, 10)} …{" "}
            {new Date(m.to - 1).toISOString().slice(0, 10)} UTC ·{" "}
            {m.split === "final" ? "최종 공동 평가" : "개발 노출 자료"}
          </p>
          {packet.experiment.status === "running" ? (
            <p role="status">
              완료 {packet.days.length}일 · 하루 리플레이 · 모델 $0 · heartbeat{" "}
              {new Date(packet.experiment.updated_at).toLocaleTimeString(
                "ko-KR",
              )}
            </p>
          ) : (
            <>
              <h3>{result?.verdict ?? "판단 보류"}</h3>
              <p>
                {result?.reason ??
                  packet.experiment.error ??
                  "불완전 비교 결과"}
              </p>
              {result ? (
                <p>
                  비용 후 일평균 차이 {pct(result.mean)} · 95% 신뢰구간{" "}
                  {result.ci?.map(pct).join(" … ")}
                </p>
              ) : null}
            </>
          )}
          <div className="ct-compare-toolbar">
            {["running", "paused", "failed"].includes(
              packet.experiment.status,
            ) ? (
              <>
                <button
                  className="ui-btn sm"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      packet.experiment.status === "running"
                        ? "pause"
                        : "resume",
                    )
                  }
                >
                  {packet.experiment.status === "running" ? "일시정지" : "재개"}
                </button>
                <button
                  className="ui-btn sm"
                  disabled={busy}
                  onClick={() => void act("cancel")}
                >
                  중단
                </button>
                <button
                  className="ui-btn sm"
                  disabled={busy || packet.experiment.status !== "running"}
                  onClick={() => void act("advance")}
                >
                  하루 진행
                </button>
              </>
            ) : null}
          </div>
          {result ? (
            <div className="ui-scroll-x">
              <table className="ui-table">
                <thead>
                  <tr>
                    <th scope="col">지표</th>
                    <th scope="col">기준</th>
                    <th scope="col">변경</th>
                    <th scope="col">차이</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["meanDailyPct", "비용 후 일평균"],
                    ["positiveDayPct", "수익일 비율"],
                    ["sharpe", "일간 샤프(연율화)"],
                    ["maxDrawdownPct", "최대 낙폭"],
                    ["worstDayPct", "최악의 날"],
                    ["positiveDays", "수익일"],
                    ["negativeDays", "손실일"],
                    ["emptyDays", "무수익일"],
                  ].map(([key, label]) => {
                    const a = result.baseline[key],
                      b = result.changed[key];
                    return (
                      <tr key={key}>
                        <th scope="row">{label}</th>
                        <td>{a == null ? "정의 불가" : a.toFixed(4)}</td>
                        <td>{b == null ? "정의 불가" : b.toFixed(4)}</td>
                        <td>
                          {a == null || b == null ? "—" : (b - a).toFixed(4)}
                        </td>
                      </tr>
                    );
                  })}
                  {(() => {
                    // Sums over the stored days; the model column is the manifest's frozen budget, not a measured spend.
                    const sum = (arm: number, f: (r: CTResult) => number) =>
                      packet.days.reduce((s, d) => s + f(d.arms[arm].result), 0);
                    const rows: Array<[string, number | null, number | null, number]> = [
                      ["전체 순수익", result.baseline.totalNetReturnPct, result.changed.totalNetReturnPct, 4],
                      ["거래 수", sum(0, (r) => r.trades.length), sum(1, (r) => r.trades.length), 0],
                      ["거래 비용", sum(0, (r) => r.costs), sum(1, (r) => r.costs), 2],
                      ["규칙 준수 미달 일수", sum(0, (r) => (r.compliancePct < 100 ? 1 : 0)), sum(1, (r) => (r.compliancePct < 100 ? 1 : 0)), 0],
                    ];
                    return (
                      <>
                        {rows.map(([label, a, b, digits]) => (
                          <tr key={label}>
                            <th scope="row">{label}</th>
                            <td>{a == null ? "정의 불가" : a.toFixed(digits)}</td>
                            <td>{b == null ? "정의 불가" : b.toFixed(digits)}</td>
                            <td>{a == null || b == null ? "—" : (b - a).toFixed(digits)}</td>
                          </tr>
                        ))}
                        <tr>
                          <th scope="row">모델 호출 비용</th>
                          <td colSpan={3}>
                            {m?.versions.model === "deterministic-no-llm"
                              ? "$0 · 고정 결정 정책(LLM 미호출)"
                              : `상한 $${m?.modelBudgetUsd ?? "—"}`}
                          </td>
                        </tr>
                        <tr>
                          <th scope="row">증거금·강제청산</th>
                          <td colSpan={3}>
                            {["spot", "stock"].includes(m?.contract.tradeSettings?.product ?? (m?.contract.market === "crypto" ? "spot" : "stock"))
                              ? "해당 없음 · 현금 상품(레버리지·증거금 없음)"
                              : "측정 불가 · 상품 회계 미연결"}
                          </td>
                        </tr>
                      </>
                    );
                  })()}
                </tbody>
              </table>
            </div>
          ) : null}
          <EquityChart days={packet.days} />
          <div className="ui-scroll-x">
            <table className="ui-table">
              <thead>
                <tr>
                  <th scope="col">날짜</th>
                  <th scope="col">기준</th>
                  <th scope="col">변경</th>
                  <th scope="col">차이</th>
                  <th scope="col">거래 수</th>
                  <th scope="col">판단 리플레이</th>
                </tr>
              </thead>
              <tbody>
                {packet.days.map((d) => {
                  const a = d.arms[0].result.daily.at(-1)?.returnPct ?? 0,
                    b = d.arms[1].result.daily.at(-1)?.returnPct ?? 0;
                  return (
                    <tr key={d.day}>
                      <th scope="row">{d.day}</th>
                      <td>{pct(a)}</td>
                      <td>{pct(b)}</td>
                      <td>{pct(b - a)}</td>
                      <td>
                        {d.arms.map((a) => a.result.trades.length).join(" / ")}
                      </td>
                      <td>
                        <button
                          className="ui-btn sm"
                          onClick={() => {
                            setDay(d.day);
                            push({ day: d.day });
                          }}
                        >
                          같은 시각의 판단
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details>
            <summary>실험 조건과 판정 근거 · JSON 내보내기</summary>
            <p>
              계약 해시 {packet.experiment.manifest_hash} · 최종 노출{" "}
              {m.split === "final" ? "공동 묶음 1회" : "개발"} · 일별 block
              bootstrap 5일 / 4,000회 / seed 20261016
            </p>
            <pre>{JSON.stringify(m, null, 2)}</pre>
            <button
              className="ui-btn sm"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(packet, null, 2)], {
                    type: "application/json",
                  }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = `ct-comparison-${id}.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              JSON 다운로드
            </button>
          </details>
        </article>
      ) : null}
    </section>
  );
}
export function CTConnectionStatus() {
  const [rows, setRows] = useState<CTCapability[]>([]);
  // unknown stays its own state: never shown as yes or no.
  const yesNo = (v: boolean | "unknown") => (v === "unknown" ? "미확인" : v ? "예" : "아니오");
  useEffect(() => {
    fetch(endpoint)
      .then((r) => r.json() as Promise<{ capabilities?: CTCapability[] }>)
      .then((p) => setRows(p.capabilities ?? []))
      .catch(() => setRows([]));
  }, []);
  return (
    <details className="ui-card pad">
      <summary>상품별 연결·검증 상태 · 실전 기본 잠금</summary>
      <div className="ui-scroll-x">
        <table className="ui-table">
          <thead>
            <tr>
              <th scope="col">상품</th>
              <th scope="col">거래소 지원</th>
              <th scope="col">계좌 권한</th>
              <th scope="col">연구 데이터</th>
              <th scope="col">엔진 검증</th>
              <th scope="col">실전</th>
              <th scope="col">이유</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product}>
                <th scope="row">{r.label}</th>
                <td>{yesNo(r.exchangeSupported)}</td>
                <td>{yesNo(r.accountPermission)}</td>
                <td>{yesNo(r.dataReady)}</td>
                <td>{yesNo(r.engineValidated)}</td>
                <td>{r.liveReady ? "검증됨" : "잠금"}</td>
                <td>{r.reason.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ui-sub">
        public data / signed account / product permission / user stream / runner
        / orders enabled는 각각 별도 확인합니다. unknown은 미확인입니다.
      </p>
    </details>
  );
}
