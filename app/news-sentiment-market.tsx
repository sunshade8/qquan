"use client";

import { useMemo, useState } from "react";

/**
 * The core question of the News workspace, made visible: does pre-release
 * headline sentiment line up with what the index actually did?
 */

export type SentimentMarketRow = {
  id: string;
  periodStart: string;
  periodEnd: string;
  label: string | null;
  sentiment: number;
  techScore: number;
  valueScore: number;
  nasdaqReturnPct: number | null;
  nyseReturnPct: number | null;
};

type MarketKey = "nasdaq" | "nyse";

function pearson(left: number[], right: number[]) {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    covariance += (left[index] - leftMean) * (right[index] - rightMean);
    leftVariance += (left[index] - leftMean) ** 2;
    rightVariance += (right[index] - rightMean) ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator ? covariance / denominator : null;
}

function tone(value: number | null) {
  if (value === null || Math.abs(value) < 0.005) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function percent(value: number | null, digits = 2) {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function SentimentMarketPanel({ rows, onAsk }: { rows: SentimentMarketRow[]; onAsk?: (prompt: string) => void }) {
  const [market, setMarket] = useState<MarketKey>("nasdaq");
  const [view, setView] = useState<"paired" | "scatter">("paired");
  const usable = useMemo(() => rows.filter((row) => (market === "nasdaq" ? row.nasdaqReturnPct : row.nyseReturnPct) !== null).map((row) => ({ ...row, returnPct: (market === "nasdaq" ? row.nasdaqReturnPct : row.nyseReturnPct)! })).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)), [rows, market]);
  const stats = useMemo(() => {
    const directional = usable.filter((row) => Math.abs(row.sentiment) >= 10 && Math.abs(row.returnPct) >= 0.05);
    const hits = directional.filter((row) => row.sentiment * row.returnPct > 0).length;
    const strong = usable.filter((row) => Math.abs(row.sentiment) >= 30);
    const strongHits = strong.filter((row) => row.sentiment * row.returnPct > 0).length;
    return {
      n: usable.length,
      correlation: pearson(usable.map((row) => row.sentiment), usable.map((row) => row.returnPct)),
      hitRate: directional.length ? (hits / directional.length) * 100 : null, hitSample: directional.length,
      strongHitRate: strong.length ? (strongHits / strong.length) * 100 : null, strongSample: strong.length,
      averageBullish: (() => { const values = usable.filter((row) => row.sentiment > 10).map((row) => row.returnPct); return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; })(),
      averageBearish: (() => { const values = usable.filter((row) => row.sentiment < -10).map((row) => row.returnPct); return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; })(),
    };
  }, [usable]);

  if (rows.length < 2) return null;
  const marketName = market === "nasdaq" ? "NASDAQ" : "NYSE";

  const width = 900;
  const height = 250;
  const pad = { top: 18, right: 18, bottom: 40, left: 46 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  function pairedChart() {
    const maxReturn = Math.max(0.5, ...usable.map((row) => Math.abs(row.returnPct)));
    const slot = plotWidth / Math.max(1, usable.length);
    const zero = pad.top + plotHeight / 2;
    const sentimentY = (value: number) => zero - (value / 100) * (plotHeight / 2);
    const returnY = (value: number) => zero - (value / maxReturn) * (plotHeight / 2);
    return <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`감성 점수와 ${marketName} 수익률 비교`}>
      <line className="svm-zero" x1={pad.left} x2={width - pad.right} y1={zero} y2={zero} />
      <text className="svm-axis" x={pad.left - 6} y={pad.top + 4} textAnchor="end">+100</text>
      <text className="svm-axis" x={pad.left - 6} y={pad.top + plotHeight + 4} textAnchor="end">−100</text>
      <text className="svm-axis right" x={width - pad.right + 4} y={pad.top + 4}>{percent(maxReturn, 1)}</text>
      <text className="svm-axis right" x={width - pad.right + 4} y={pad.top + plotHeight + 4}>{percent(-maxReturn, 1)}</text>
      {usable.map((row, index) => {
        const x = pad.left + index * slot;
        const match = Math.abs(row.sentiment) >= 10 && Math.abs(row.returnPct) >= 0.05 ? (row.sentiment * row.returnPct > 0 ? "match" : "mismatch") : "neutral";
        return <g key={row.id} className={`svm-pair ${match}`}>
          <rect className="svm-sentiment" x={x + slot * 0.14} y={Math.min(zero, sentimentY(row.sentiment))} width={slot * 0.3} height={Math.max(1.5, Math.abs(sentimentY(row.sentiment) - zero))} rx="2"><title>{`${row.periodStart} → ${row.periodEnd} · 감성 ${row.sentiment}`}</title></rect>
          <rect className="svm-return" x={x + slot * 0.52} y={Math.min(zero, returnY(row.returnPct))} width={slot * 0.3} height={Math.max(1.5, Math.abs(returnY(row.returnPct) - zero))} rx="2"><title>{`${marketName} ${percent(row.returnPct)}`}</title></rect>
          {usable.length <= 16 && <text className="svm-label" x={x + slot / 2} y={height - 22} textAnchor="middle">{row.periodEnd.slice(2, 10)}</text>}
          <text className={`svm-verdict ${match}`} x={x + slot / 2} y={height - 8} textAnchor="middle">{match === "match" ? "●" : match === "mismatch" ? "○" : "·"}</text>
        </g>;
      })}
    </svg>;
  }

  function scatterChart() {
    const maxReturn = Math.max(0.5, ...usable.map((row) => Math.abs(row.returnPct)));
    const x = (sentiment: number) => pad.left + ((sentiment + 100) / 200) * plotWidth;
    const y = (value: number) => pad.top + ((maxReturn - value) / (2 * maxReturn)) * plotHeight;
    const sentimentValues = usable.map((row) => row.sentiment);
    const returnValues = usable.map((row) => row.returnPct);
    const meanX = sentimentValues.reduce((sum, value) => sum + value, 0) / sentimentValues.length;
    const meanY = returnValues.reduce((sum, value) => sum + value, 0) / returnValues.length;
    const slope = sentimentValues.reduce((sum, value, index) => sum + (value - meanX) * (returnValues[index] - meanY), 0) / (sentimentValues.reduce((sum, value) => sum + (value - meanX) ** 2, 0) || 1);
    const intercept = meanY - slope * meanX;
    return <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`감성 점수 대비 ${marketName} 수익률 산점도`}>
      <rect className="svm-quadrant" x={x(0)} y={pad.top} width={plotWidth / 2} height={plotHeight / 2} />
      <rect className="svm-quadrant" x={pad.left} y={y(0)} width={plotWidth / 2} height={plotHeight / 2} />
      <line className="svm-zero" x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} />
      <line className="svm-zero" x1={x(0)} x2={x(0)} y1={pad.top} y2={pad.top + plotHeight} />
      {usable.length >= 3 && <line className="svm-fit" x1={x(-100)} y1={y(Math.max(-maxReturn, Math.min(maxReturn, intercept - 100 * slope)))} x2={x(100)} y2={y(Math.max(-maxReturn, Math.min(maxReturn, intercept + 100 * slope)))} />}
      {usable.map((row) => <circle key={row.id} className={`svm-dot ${row.sentiment * row.returnPct > 0 ? "match" : "mismatch"}`} cx={x(row.sentiment)} cy={y(row.returnPct)} r="5.5"><title>{`${row.periodStart} → ${row.periodEnd}${row.label ? ` · ${row.label}` : ""}\n감성 ${row.sentiment} · ${marketName} ${percent(row.returnPct)}`}</title></circle>)}
      <text className="svm-axis" x={pad.left} y={height - 10}>감성 −100</text>
      <text className="svm-axis" x={width - pad.right} y={height - 10} textAnchor="end">감성 +100</text>
      <text className="svm-axis" x={pad.left - 6} y={pad.top + 4} textAnchor="end">{percent(maxReturn, 1)}</text>
      <text className="svm-axis" x={pad.left - 6} y={pad.top + plotHeight + 4} textAnchor="end">{percent(-maxReturn, 1)}</text>
    </svg>;
  }

  const brief = `[감성 vs ${marketName} 실현 수익률 · n=${stats.n}]\n상관 r=${stats.correlation === null ? "—" : stats.correlation.toFixed(3)} · 방향 적중률 ${stats.hitRate === null ? "—" : `${stats.hitRate.toFixed(0)}%`} (n=${stats.hitSample}) · |감성|≥30 적중률 ${stats.strongHitRate === null ? "—" : `${stats.strongHitRate.toFixed(0)}%`} (n=${stats.strongSample})\n긍정 감성 후 평균 ${percent(stats.averageBullish)} · 부정 감성 후 평균 ${percent(stats.averageBearish)}\n\n이 관계가 우연인지, 어떤 이벤트 유형에서 강한지, 다음에 무엇을 검증해야 하는지 설명해줘.`;

  return <section className="sentiment-market-panel" aria-label="감성 점수와 실제 지수 움직임 비교">
    <header>
      <div><span>SENTIMENT vs MARKET</span><strong>뉴스 감성이 {marketName} 실제 움직임과 맞았나</strong></div>
      <div className="svm-switches">
        <div role="tablist" aria-label="지수"><button role="tab" aria-selected={market === "nasdaq"} className={market === "nasdaq" ? "active" : ""} onClick={() => setMarket("nasdaq")}>NASDAQ</button><button role="tab" aria-selected={market === "nyse"} className={market === "nyse" ? "active" : ""} onClick={() => setMarket("nyse")}>NYSE</button></div>
        <div role="tablist" aria-label="보기"><button role="tab" aria-selected={view === "paired"} className={view === "paired" ? "active" : ""} onClick={() => setView("paired")}>쌍 막대</button><button role="tab" aria-selected={view === "scatter"} className={view === "scatter" ? "active" : ""} onClick={() => setView("scatter")}>산점도</button></div>
        {onAsk && <button className="svm-ask" onClick={() => onAsk(brief)}>JARVIS에게 해석 요청</button>}
      </div>
    </header>
    <div className="svm-kpis">
      <span><small>표본</small><b>{stats.n}</b></span>
      <span><small>상관 r</small><b className={tone(stats.correlation)}>{stats.correlation === null ? "—" : stats.correlation.toFixed(3)}</b></span>
      <span><small>방향 적중률</small><b>{stats.hitRate === null ? "—" : `${stats.hitRate.toFixed(0)}%`}<em>n={stats.hitSample}</em></b></span>
      <span><small>|감성| ≥ 30 적중률</small><b>{stats.strongHitRate === null ? "—" : `${stats.strongHitRate.toFixed(0)}%`}<em>n={stats.strongSample}</em></b></span>
      <span><small>긍정 감성 후</small><b className={tone(stats.averageBullish)}>{percent(stats.averageBullish)}</b></span>
      <span><small>부정 감성 후</small><b className={tone(stats.averageBearish)}>{percent(stats.averageBearish)}</b></span>
    </div>
    <div className="svm-chart">{usable.length ? (view === "paired" ? pairedChart() : scatterChart()) : <p className="svm-empty">{marketName} 수익률이 채워진 Test가 아직 없습니다.</p>}</div>
    <footer><span><i className="sentiment" />감성 점수 (−100~+100)</span><span><i className="return" />{marketName} 기간 수익률</span><span>● 방향 일치 · ○ 불일치 · 중립(|감성|&lt;10)은 제외</span></footer>
  </section>;
}
