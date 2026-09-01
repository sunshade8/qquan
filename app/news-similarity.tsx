"use client";

import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined";
import Check from "lucide-react/dist/esm/icons/check";
import Copy from "lucide-react/dist/esm/icons/copy";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Send from "lucide-react/dist/esm/icons/send";
import X from "lucide-react/dist/esm/icons/x";
import { useEffect, useMemo, useState } from "react";

type ForecastEvent = {
  indicator: string;
  scheduledReleaseDate: string | null;
  scheduledTimeET: string | null;
};

export type SimilarityTest = {
  id: string;
  periodStart: string;
  periodEnd: string;
  articleCount: number;
  overallScore: number;
  overallLabel: string;
  forecastEvents?: ForecastEvent[];
};

type PathPoint = { offset: number; date: string; value: number };
type MarketReaction = {
  effectiveDate: string;
  previousDate: string;
  preDayPct: number | null;
  eventGapPct: number | null;
  eventIntradayPct: number | null;
  eventDayPct: number | null;
  changeVsPrePct: number | null;
  next1DPct: number | null;
  post3DPct: number | null;
  normalizedPath: PathPoint[];
};
type ComparisonRow = SimilarityTest & {
  anchorDate: string;
  anchorLabel: string;
  markets: { nasdaq: MarketReaction | null; nyse: MarketReaction | null };
};
type ComparisonResponse = {
  results: ComparisonRow[];
  methodology: { anchor: string; preDay: string; eventDay: string; normalization: string };
  sources: Record<"nasdaq" | "nyse", { origin: string; reason: string | null }>;
};
type MarketKey = "nasdaq" | "nyse";

const offsets = [-3, -2, -1, 0, 1, 2, 3];

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function comparisonAnchor(test: SimilarityTest) {
  const candidates = (test.forecastEvents ?? [])
    .filter((event) => event.scheduledReleaseDate && /^\d{4}-\d{2}-\d{2}$/.test(event.scheduledReleaseDate))
    .map((event) => ({ ...event, scheduledReleaseDate: event.scheduledReleaseDate! }))
    .sort((a, b) => a.scheduledReleaseDate.localeCompare(b.scheduledReleaseDate));
  const nearFuture = candidates.find((event) => event.scheduledReleaseDate >= test.periodEnd && event.scheduledReleaseDate <= shiftDate(test.periodEnd, 7));
  const inside = candidates.filter((event) => event.scheduledReleaseDate >= test.periodStart && event.scheduledReleaseDate <= test.periodEnd).at(-1);
  const chosen = nearFuture ?? inside;
  return chosen
    ? { anchorDate: chosen.scheduledReleaseDate, anchorLabel: chosen.indicator }
    : { anchorDate: test.periodEnd, anchorLabel: "뉴스 범위 종료일" };
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1));
}

function pearson(left: number[], right: number[]) {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquare += leftDelta ** 2;
    rightSquare += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator ? numerator / denominator : null;
}

function percent(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function signed(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function returnClass(value: number | null | undefined) {
  if (value === null || value === undefined || Math.abs(value) < .005) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function pathValues(reaction: MarketReaction) {
  const byOffset = new Map(reaction.normalizedPath.map((point) => [point.offset, point.value]));
  return offsets.map((offset) => byOffset.get(offset) ?? null);
}

function summaryFor(rows: ComparisonRow[], market: MarketKey) {
  const usable = rows.flatMap((row) => row.markets[market] ? [{ row, reaction: row.markets[market]! }] : []);
  const eventValues = usable.flatMap(({ reaction }) => reaction.eventDayPct === null ? [] : [reaction.eventDayPct]);
  const preValues = usable.flatMap(({ reaction }) => reaction.preDayPct === null ? [] : [reaction.preDayPct]);
  const shiftValues = usable.flatMap(({ reaction }) => reaction.changeVsPrePct === null ? [] : [reaction.changeVsPrePct]);
  const positive = eventValues.filter((value) => value > 0).length;
  const negative = eventValues.filter((value) => value < 0).length;
  const majorityCount = Math.max(positive, negative);
  const directional = positive + negative;
  const sentimentPairs = usable.filter(({ row, reaction }) => Math.abs(row.overallScore) >= 10 && reaction.eventDayPct !== null && Math.abs(reaction.eventDayPct) >= .005);
  const sentimentHits = sentimentPairs.filter(({ row, reaction }) => row.overallScore * reaction.eventDayPct! > 0).length;
  const sentimentCorrelationRows = usable.filter(({ reaction }) => reaction.eventDayPct !== null);

  const pairwise: number[] = [];
  for (let left = 0; left < usable.length; left += 1) {
    for (let right = left + 1; right < usable.length; right += 1) {
      const leftValues = pathValues(usable[left].reaction);
      const rightValues = pathValues(usable[right].reaction);
      const pairs = leftValues.flatMap((value, index) => value === null || rightValues[index] === null ? [] : [[value, rightValues[index]!] as const]);
      const correlation = pearson(pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1]));
      if (correlation !== null) pairwise.push(correlation);
    }
  }

  return {
    usable,
    sampleSize: eventValues.length,
    medianPre: median(preValues),
    medianEvent: median(eventValues),
    medianShift: median(shiftValues),
    eventStdDev: standardDeviation(eventValues),
    directionConsistency: directional ? (majorityCount / directional) * 100 : null,
    majorityDirection: positive === negative ? "혼재" : positive > negative ? "상승" : "하락",
    sentimentHitRate: sentimentPairs.length ? (sentimentHits / sentimentPairs.length) * 100 : null,
    sentimentPairCount: sentimentPairs.length,
    sentimentCorrelation: pearson(
      sentimentCorrelationRows.map(({ row }) => row.overallScore),
      sentimentCorrelationRows.map(({ reaction }) => reaction.eventDayPct!),
    ),
    pathSimilarity: median(pairwise),
  };
}

function OverlayChart({ rows, market }: { rows: ComparisonRow[]; market: MarketKey }) {
  const series = rows.flatMap((row) => row.markets[market] ? [{ id: row.id, label: row.anchorDate, values: pathValues(row.markets[market]!) }] : []);
  if (!series.length) return <div className="similarity-chart-empty">표시할 일봉 경로가 없습니다.</div>;
  const allValues = series.flatMap((item) => item.values.filter((value): value is number => value !== null));
  const rawMin = Math.min(100, ...allValues);
  const rawMax = Math.max(100, ...allValues);
  const buffer = Math.max((rawMax - rawMin) * .14, .35);
  const min = rawMin - buffer;
  const max = rawMax + buffer;
  const width = 920;
  const height = 270;
  const pad = { top: 20, right: 24, bottom: 38, left: 58 };
  const x = (offset: number) => pad.left + ((offset + 3) / 6) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + ((max - value) / (max - min)) * (height - pad.top - pad.bottom);
  const path = (values: Array<number | null>) => values.map((value, index) => value === null ? "" : `${index && values[index - 1] !== null ? "L" : "M"}${x(offsets[index]).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  const medianValues = offsets.map((_, index) => median(series.flatMap((item) => item.values[index] === null ? [] : [item.values[index]!])));
  const yTicks = [0, .25, .5, .75, 1].map((ratio) => max - ratio * (max - min));

  return (
    <div className="similarity-overlay-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${market === "nasdaq" ? "NASDAQ" : "NYSE"} 이벤트 정렬 정규화 경로`}>
        <rect className="similarity-event-zone" x={x(-.18)} y={pad.top} width={x(.18) - x(-.18)} height={height - pad.top - pad.bottom} />
        {yTicks.map((tick) => <g key={tick}><line className="similarity-grid" x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} /><text className="similarity-axis" x={pad.left - 9} y={y(tick) + 4} textAnchor="end">{tick.toFixed(1)}</text></g>)}
        <line className="similarity-base" x1={pad.left} x2={width - pad.right} y1={y(100)} y2={y(100)} />
        {series.map((item) => <path className="similarity-series" d={path(item.values)} key={item.id}><title>{item.label}</title></path>)}
        <path className="similarity-median" d={path(medianValues)} />
        {medianValues.map((value, index) => value === null ? null : <circle className="similarity-median-dot" key={offsets[index]} cx={x(offsets[index])} cy={y(value)} r="3.3" />)}
        {offsets.map((offset) => <text className="similarity-axis" key={offset} x={x(offset)} y={height - 11} textAnchor="middle">{offset === 0 ? "D0" : offset > 0 ? `D+${offset}` : `D${offset}`}</text>)}
        <text className="similarity-event-label" x={x(0)} y={pad.top + 12} textAnchor="middle">EVENT</text>
      </svg>
      <div className="similarity-legend"><span><i className="runs" />각 날짜 범위</span><span><i className="median" />중앙값 경로</span><small>D-1 종가 = 100</small></div>
    </div>
  );
}

export function NewsSimilarity({ tests, excludedDuplicates, onClose, onAskAgent }: {
  tests: SimilarityTest[];
  excludedDuplicates: number;
  onClose: () => void;
  onAskAgent: (prompt: string) => void;
}) {
  const [data, setData] = useState<ComparisonResponse | null>(null);
  const [market, setMarket] = useState<MarketKey>("nasdaq");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const prepared = useMemo(() => tests.map((test) => ({ ...test, ...comparisonAnchor(test) })), [tests]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/news/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tests: prepared }),
      signal: controller.signal,
    }).then(async (response) => {
      const value = await response.json() as ComparisonResponse & { error?: string };
      if (!response.ok) throw new Error(value.error || "유사성 비교 데이터를 만들지 못했습니다.");
      setData(value);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "유사성 비교 데이터를 만들지 못했습니다.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [prepared]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const summary = useMemo(() => summaryFor(data?.results ?? [], market), [data, market]);
  const marketName = market === "nasdaq" ? "NASDAQ" : "NYSE";

  function conversationBrief() {
    return [
      `[이벤트 유사성 검증 · ${marketName}]`,
      `독립 날짜 범위 ${summary.sampleSize}개${excludedDuplicates ? `, 중복 분석 ${excludedDuplicates}개 제외` : ""}`,
      `이벤트 전일 중앙값 ${percent(summary.medianPre)} / 이벤트 당일 중앙값 ${percent(summary.medianEvent)} / 전일 대비 변화 중앙값 ${percent(summary.medianShift)}`,
      `당일 방향 일치율 ${percent(summary.directionConsistency, 1)} (${summary.majorityDirection}) / 감성 방향 적중률 ${percent(summary.sentimentHitRate, 1)} (n=${summary.sentimentPairCount})`,
      `감성-당일수익률 상관 r=${signed(summary.sentimentCorrelation, 3)} / 경로 유사도 중앙값 r=${signed(summary.pathSimilarity, 3)} / 당일 수익률 표준편차 ${percent(summary.eventStdDev)}`,
      "기준: 전일=D-2 종가→D-1 종가, 이벤트 당일=D-1 종가→D0 종가, 경로=D-1 종가 100 정규화.",
    ].join("\n");
  }

  function tabSeparatedData() {
    const header = ["range_start", "range_end", "anchor_date", "effective_date", "anchor_label", "sentiment", "pre_day_pct", "event_gap_pct", "event_intraday_pct", "event_day_pct", "event_vs_pre_pp", "next_1d_pct", "post_3d_pct", "sentiment_direction_match"];
    const lines = summary.usable.map(({ row, reaction }) => [
      row.periodStart, row.periodEnd, row.anchorDate, reaction.effectiveDate, row.anchorLabel.replaceAll("\t", " "), row.overallScore,
      reaction.preDayPct ?? "", reaction.eventGapPct ?? "", reaction.eventIntradayPct ?? "", reaction.eventDayPct ?? "", reaction.changeVsPrePct ?? "", reaction.next1DPct ?? "", reaction.post3DPct ?? "",
      Math.abs(row.overallScore) < 10 || reaction.eventDayPct === null ? "neutral" : row.overallScore * reaction.eventDayPct > 0 ? "match" : "mismatch",
    ].join("\t"));
    return `${conversationBrief()}\n\n${header.join("\t")}\n${lines.join("\n")}`;
  }

  async function copyData() {
    await navigator.clipboard.writeText(tabSeparatedData());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function sendToAgent() {
    onAskAgent(`${conversationBrief()}\n\n이 결과에서 반복성이 있는 부분, 예외 날짜 범위, 추가로 검증할 가설을 설명해줘.`);
    onClose();
  }

  return (
    <div className="similarity-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <article className="similarity-page" role="dialog" aria-modal="true" aria-labelledby="similarity-title">
        <header className="similarity-head">
          <div><span>EVENT SIMILARITY VALIDATION</span><h2 id="similarity-title">이벤트 전 vs 당일 · 전체 비교</h2><p>독립 날짜 범위 {tests.length}개{excludedDuplicates ? ` · 같은 범위 중복 ${excludedDuplicates}개 제외` : ""}</p></div>
          <div className="similarity-head-actions">
            <button type="button" onClick={copyData} disabled={!data || !summary.sampleSize}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "복사됨" : "데이터 복사"}</button>
            <button type="button" onClick={sendToAgent} disabled={!data || !summary.sampleSize}><Send size={14} />Agent 질문에 넣기</button>
            <button className="similarity-close" type="button" onClick={onClose} aria-label="유사성 비교 닫기"><X size={18} /></button>
          </div>
        </header>

        <div className="similarity-scroll">
          {loading && <div className="similarity-loading"><RefreshCw size={20} className="spin" /><strong>모든 날짜 범위의 동일 지점을 맞추는 중</strong><p>전일과 이벤트 당일을 같은 계산식으로 다시 산출하고 있습니다.</p></div>}
          {!loading && error && <div className="similarity-loading error"><ChartNoAxesCombined size={20} /><strong>{error}</strong></div>}
          {!loading && data && <>
            <div className="similarity-toolbar">
              <div role="tablist" aria-label="비교 지수"><button role="tab" aria-selected={market === "nasdaq"} className={market === "nasdaq" ? "active" : ""} onClick={() => setMarket("nasdaq")}>NASDAQ</button><button role="tab" aria-selected={market === "nyse"} className={market === "nyse" ? "active" : ""} onClick={() => setMarket("nyse")}>NYSE</button></div>
              <p>그림은 패턴 확인용이며, 아래 숫자가 대화·판정 기준입니다.</p>
            </div>

            <section className="similarity-kpis" aria-label="유사성 수치 요약">
              <article><small>유효 표본</small><strong>{summary.sampleSize}</strong><span>독립 date ranges</span></article>
              <article><small>전일 중앙값</small><strong className={returnClass(summary.medianPre)}>{percent(summary.medianPre)}</strong><span>D-2 close → D-1 close</span></article>
              <article><small>이벤트 당일 중앙값</small><strong className={returnClass(summary.medianEvent)}>{percent(summary.medianEvent)}</strong><span>D-1 close → D0 close</span></article>
              <article><small>전일 대비 변화</small><strong className={returnClass(summary.medianShift)}>{percent(summary.medianShift)}</strong><span>event − pre</span></article>
              <article><small>당일 방향 일치율</small><strong>{percent(summary.directionConsistency, 1)}</strong><span>다수 방향 · {summary.majorityDirection}</span></article>
              <article><small>감성 방향 적중률</small><strong>{percent(summary.sentimentHitRate, 1)}</strong><span>|감성| ≥ 10 · n={summary.sentimentPairCount}</span></article>
              <article><small>감성 ↔ 반응 상관</small><strong>{signed(summary.sentimentCorrelation, 3)}</strong><span>Pearson r</span></article>
              <article><small>경로 유사도</small><strong>{signed(summary.pathSimilarity, 3)}</strong><span>쌍별 r 중앙값</span></article>
            </section>

            <section className="similarity-visual">
              <header><div><span>NORMALIZED PATHS</span><h3>{marketName} 이벤트 정렬 경로</h3></div><p>각 선은 한 날짜 범위입니다. D-1 종가를 100으로 맞춰 절대 지수 수준의 영향을 제거했습니다.</p></header>
              <OverlayChart rows={data.results} market={market} />
            </section>

            <section className="similarity-data-section">
              <header><div><span>COMPARABLE DATA</span><h3>기간별 숫자 비교</h3></div><p>갭과 장중 반응을 분리해 당일 움직임이 언제 발생했는지 확인합니다.</p></header>
              <div className="similarity-table-wrap">
                <table className="similarity-table">
                  <thead><tr><th>DATE RANGE / EVENT</th><th>감성</th><th>전일</th><th>D0 갭</th><th>D0 장중</th><th>D0 총반응</th><th>전일 대비</th><th>+1D</th><th>+3D</th><th>감성 일치</th></tr></thead>
                  <tbody>{data.results.map((row) => { const reaction = row.markets[market]; return <tr key={row.id}>
                    <td><strong>{row.periodStart} → {row.periodEnd}</strong><span>{row.anchorLabel} · 기준 {row.anchorDate}{reaction && reaction.effectiveDate !== row.anchorDate ? ` → 거래일 ${reaction.effectiveDate}` : ""}</span></td>
                    <td><b className={returnClass(row.overallScore)}>{signed(row.overallScore, 0)}</b><span>{row.overallLabel}</span></td>
                    <td className={returnClass(reaction?.preDayPct)}>{percent(reaction?.preDayPct)}</td>
                    <td className={returnClass(reaction?.eventGapPct)}>{percent(reaction?.eventGapPct)}</td>
                    <td className={returnClass(reaction?.eventIntradayPct)}>{percent(reaction?.eventIntradayPct)}</td>
                    <td className={returnClass(reaction?.eventDayPct)}><b>{percent(reaction?.eventDayPct)}</b></td>
                    <td className={returnClass(reaction?.changeVsPrePct)}>{percent(reaction?.changeVsPrePct)}</td>
                    <td className={returnClass(reaction?.next1DPct)}>{percent(reaction?.next1DPct)}</td>
                    <td className={returnClass(reaction?.post3DPct)}>{percent(reaction?.post3DPct)}</td>
                    <td>{!reaction || reaction.eventDayPct === null || Math.abs(row.overallScore) < 10 ? <span className="similarity-neutral">중립 제외</span> : row.overallScore * reaction.eventDayPct > 0 ? <span className="similarity-match">일치</span> : <span className="similarity-mismatch">불일치</span>}</td>
                  </tr>; })}</tbody>
                </table>
              </div>
            </section>

            <footer className="similarity-method"><strong>해석 기준</strong><p>{data.methodology.anchor} {data.methodology.preDay}. {data.methodology.eventDay}. 방향 일치율과 상관계수는 표본 수가 작을 때 확정적 결론이 아니며, 중복 날짜 범위는 표본에서 제외했습니다.</p></footer>
          </>}
        </div>
      </article>
    </div>
  );
}
