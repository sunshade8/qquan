"use client";

import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle";
import type { LabArtifact, Overlay } from "@/lib/lab-types";
import { TradingViewChart } from "./tradingview-chart";

const PALETTE = ["#087aff", "#9a62da", "#d88700", "#18864b", "#d13b3b", "#0a9396"];

export function formatPercent(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function formatNumber(value: number | string | null | undefined, digits = 2) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (Math.abs(value) >= 1_000_000) return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

export function toneOf(value: number | string | null | undefined) {
  if (typeof value !== "number" || Math.abs(value) < 0.005) return "neutral";
  return value > 0 ? "positive" : "negative";
}

type Series = { name: string; values: Array<number | null>; color?: string; dashed?: boolean; width?: number };

function niceTicks(min: number, max: number, count = 4) {
  const span = max - min || 1;
  const rough = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((item) => item * magnitude).find((item) => item >= rough) ?? magnitude;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + 1e-9; value += step) ticks.push(Number(value.toFixed(6)));
  return ticks;
}

/** Generic multi-series line chart with optional volume bars and horizontal reference lines. */
export function LineChart({ dates, series, height = 280, bars, references, shade, yFormat = (value) => formatNumber(value), ariaLabel }: {
  dates: string[]; series: Series[]; height?: number; bars?: Array<number | null>; references?: Array<{ value: number; label: string }>; shade?: { fromIndex: number; toIndex: number }; yFormat?: (value: number) => string; ariaLabel: string;
}) {
  const width = 860;
  const pad = { top: 18, right: 22, bottom: 34, left: 60 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom - (bars ? 46 : 0);
  const values = series.flatMap((item) => item.values.filter((value): value is number => value !== null && Number.isFinite(value))).concat(references?.map((item) => item.value) ?? []);
  if (!values.length || !dates.length) return <div className="lab-chart-empty">표시할 데이터가 없습니다.</div>;
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const buffer = Math.max((rawMax - rawMin) * 0.06, Math.abs(rawMax) * 0.002, 0.01);
  const min = rawMin - buffer;
  const max = rawMax + buffer;
  const x = (index: number) => pad.left + (dates.length === 1 ? plotWidth / 2 : (index / (dates.length - 1)) * plotWidth);
  const y = (value: number) => pad.top + ((max - value) / (max - min)) * plotHeight;
  const path = (line: Array<number | null>) => line.map((value, index) => value === null || !Number.isFinite(value) ? "" : `${index && line[index - 1] !== null ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const ticks = niceTicks(min, max, 4);
  const dateTicks = [...new Set([0, Math.floor((dates.length - 1) / 3), Math.floor(((dates.length - 1) * 2) / 3), dates.length - 1])];
  const barValues = bars?.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value)) ?? [];
  const barMax = Math.max(0, ...barValues);
  const barMin = Math.min(0, ...barValues);
  const barSpan = barMax - barMin || 1;
  const barTop = pad.top + plotHeight + 10;
  const barZero = barTop + ((barMax - 0) / barSpan) * 36;
  const barY = (value: number) => barTop + ((barMax - value) / barSpan) * 36;
  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
        {shade && <rect className="lab-chart-shade" x={x(shade.fromIndex)} y={pad.top} width={Math.max(2, x(shade.toIndex) - x(shade.fromIndex))} height={plotHeight} rx="6" />}
        {ticks.map((tick) => <g key={tick}><line className="grid" x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} /><text className="axis" x={pad.left - 8} y={y(tick) + 4} textAnchor="end">{yFormat(tick)}</text></g>)}
        {references?.map((reference) => <g key={reference.label}><line className="reference" x1={pad.left} x2={width - pad.right} y1={y(reference.value)} y2={y(reference.value)} /><text className="reference-label" x={width - pad.right} y={y(reference.value) - 4} textAnchor="end">{reference.label}</text></g>)}
        {bars && bars.map((value, index) => value === null || value === undefined || !Number.isFinite(value) ? null : <rect className={value >= 0 ? "volume" : "volume negative"} key={index} x={x(index) - Math.max(0.6, plotWidth / dates.length / 2 - 0.4)} y={Math.min(barY(value), barZero)} width={Math.max(1.2, plotWidth / dates.length - 0.8)} height={Math.max(0.5, Math.abs(barY(value) - barZero))} />)}
        {series.map((item, index) => <path key={item.name} className={item.dashed ? "dashed" : ""} d={path(item.values)} style={{ stroke: item.color ?? PALETTE[index % PALETTE.length], strokeWidth: item.width ?? 1.9 }} />)}
        {dateTicks.map((index) => <text className="axis" key={index} x={x(index)} y={height - 9} textAnchor={index === 0 ? "start" : index === dates.length - 1 ? "end" : "middle"}>{dates[index]}</text>)}
      </svg>
      <div className="lab-legend">{series.map((item, index) => <span key={item.name}><i style={{ background: item.color ?? PALETTE[index % PALETTE.length] }} />{item.name}</span>)}</div>
    </div>
  );
}

export function BarChart({ items, height = 200, ariaLabel, valueFormat = (value) => formatPercent(value) }: { items: Array<{ label: string; value: number | null; hint?: string }>; height?: number; ariaLabel: string; valueFormat?: (value: number) => string }) {
  const width = 860;
  const pad = { top: 22, right: 16, bottom: 30, left: 50 };
  const values = items.map((item) => item.value ?? 0);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const plotHeight = height - pad.top - pad.bottom;
  const zero = pad.top + ((max - 0) / (max - min || 1)) * plotHeight;
  const slot = (width - pad.left - pad.right) / Math.max(1, items.length);
  const y = (value: number) => pad.top + ((max - value) / (max - min || 1)) * plotHeight;
  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
        <line className="grid" x1={pad.left} x2={width - pad.right} y1={zero} y2={zero} />
        {items.map((item, index) => {
          const value = item.value ?? 0;
          const top = Math.min(y(value), zero);
          return <g key={item.label}>
            <rect className={value >= 0 ? "bar positive" : "bar negative"} x={pad.left + index * slot + slot * 0.18} y={top} width={slot * 0.64} height={Math.max(1, Math.abs(y(value) - zero))} rx="3"><title>{`${item.label}: ${item.value === null ? "—" : valueFormat(item.value)}${item.hint ? ` · ${item.hint}` : ""}`}</title></rect>
            <text className="axis" x={pad.left + index * slot + slot / 2} y={height - 10} textAnchor="middle">{item.label}</text>
            <text className="bar-value" x={pad.left + index * slot + slot / 2} y={value >= 0 ? top - 4 : y(value) + 12} textAnchor="middle">{item.value === null ? "—" : valueFormat(item.value)}</text>
          </g>;
        })}
      </svg>
    </div>
  );
}

export function StatGrid({ items }: { items: Array<{ label: string; value: string; tone?: "positive" | "negative" | "neutral" }> }) {
  return <div className="lab-stat-grid">{items.map((item) => <span key={item.label}><small>{item.label}</small><b className={item.tone ?? "neutral"}>{item.value}</b></span>)}</div>;
}

function percentStat(label: string, value: number | string | null | undefined, signed = true) {
  return { label, value: typeof value === "number" ? (signed ? formatPercent(value) : `${value.toFixed(2)}%`) : value ?? "—", tone: toneOf(value) as "positive" | "negative" | "neutral" };
}

function overlaysToSeries(overlays: Overlay[]): Series[] {
  return overlays.map((overlay, index) => ({ name: overlay.name, values: overlay.values, color: overlay.color ?? PALETTE[(index + 1) % PALETTE.length], dashed: overlay.dashed, width: 1.2 }));
}

function ArtifactFrame({ eyebrow, title, subtitle, notes, children, tone }: { eyebrow: string; title: string; subtitle?: string; notes?: string[]; children: React.ReactNode; tone?: "warning" }) {
  return <article className={`lab-artifact-card ${tone ?? ""}`}>
    <header><div><span>{eyebrow}</span><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></header>
    <div className="lab-artifact-body">{children}</div>
    {notes && notes.length > 0 && <footer>{notes.join(" · ")}</footer>}
  </article>;
}

export function ArtifactView({ artifact }: { artifact: LabArtifact }) {
  switch (artifact.type) {
    case "price-chart": {
      const dates = artifact.bars.map((bar) => bar.date);
      return <ArtifactFrame eyebrow="PRICE HISTORY" title={artifact.title} subtitle={`${artifact.period.from} → ${artifact.period.to} · ${artifact.period.sessions} 거래일`} notes={artifact.notes}>
        <LineChart dates={dates} ariaLabel={`${artifact.name} 종가 차트`} series={[{ name: "종가", values: artifact.bars.map((bar) => bar.close), color: "#087aff" }, ...overlaysToSeries(artifact.overlays)]} bars={artifact.bars.map((bar) => bar.volume)} height={330} />
        <StatGrid items={Object.entries(artifact.stats).map(([label, value]) => label === "샤프" ? { label, value: value === null ? "—" : String(value), tone: "neutral" as const } : percentStat(label, value))} />
        <div className="lab-trailing">{Object.entries(artifact.trailing).map(([label, value]) => <span key={label}><small>{label}</small><b className={toneOf(value)}>{formatPercent(value)}</b></span>)}</div>
      </ArtifactFrame>;
    }
    case "price-comparison": {
      const dates = artifact.series[0]?.points.map((point) => point.date) ?? [];
      return <ArtifactFrame eyebrow="RELATIVE PERFORMANCE" title={artifact.title} subtitle={`${artifact.period.from} → ${artifact.period.to} · ${artifact.period.sessions} 공통 거래일`} notes={artifact.notes}>
        <LineChart dates={dates} ariaLabel="정규화 가격 비교" series={artifact.series.map((item, index) => ({ name: `${item.symbol} (${formatPercent(item.returnPct)})`, values: item.points.map((point) => point.value), color: PALETTE[index % PALETTE.length] }))} references={[{ value: 100, label: "기준 100" }]} height={320} />
        {artifact.correlations.length > 0 && <div className="lab-table-wrap"><table className="lab-table"><thead><tr><th>쌍</th><th>일간 수익률 상관</th><th>누적 경로 상관</th></tr></thead><tbody>{artifact.correlations.map((row) => <tr key={`${row.left}-${row.right}`}><td>{row.left} × {row.right}</td><td>{row.returnCorrelation?.toFixed(3) ?? "—"}</td><td>{row.pathCorrelation?.toFixed(3) ?? "—"}</td></tr>)}</tbody></table></div>}
      </ArtifactFrame>;
    }
    case "indicator-panel":
      return <ArtifactFrame eyebrow="TECHNICAL INDICATORS" title={artifact.title} subtitle={`${artifact.period.from} → ${artifact.period.to}`} notes={artifact.notes}>
        <div className="lab-readings">{artifact.readings.map((reading) => <span key={reading.label} className={reading.tone}><small>{reading.label}</small><b>{reading.value}</b></span>)}</div>
        <LineChart dates={artifact.dates} ariaLabel={`${artifact.symbol} 가격과 이동평균`} series={[{ name: "종가", values: artifact.close, color: "#171719" }, ...overlaysToSeries(artifact.overlays)]} height={280} />
        {artifact.panels.map((panel) => <div className="lab-subpanel" key={panel.name}><strong>{panel.name}</strong><LineChart dates={artifact.dates} ariaLabel={panel.name} series={overlaysToSeries(panel.lines).map((line) => ({ ...line, width: 1.6 }))} references={panel.bands} bars={panel.histogram} height={170} /></div>)}
      </ArtifactFrame>;
    case "event-study":
      return <ArtifactFrame eyebrow="EVENT STUDY" title={artifact.title} subtitle={`${artifact.period.from} → ${artifact.period.to} · 조건 ${artifact.condition} · 이후 ${artifact.horizon} 거래일`} notes={artifact.notes}>
        <StatGrid items={Object.entries(artifact.stats).map(([label, value]) => label === "발생" ? { label, value: String(value ?? "—") } : label.includes("승률") ? { label, value: typeof value === "number" ? `${value.toFixed(1)}%` : "—", tone: "neutral" as const } : percentStat(label, value))} />
        {artifact.distribution.length > 0 && <BarChart ariaLabel="이후 수익률 분포" items={artifact.distribution.map((bin) => ({ label: `${bin.from.toFixed(1)}~${bin.to.toFixed(1)}%`, value: bin.count, hint: "건" }))} valueFormat={(value) => `${value}건`} height={190} />}
        {artifact.events.length > 0 && <div className="lab-table-wrap"><table className="lab-table"><thead><tr><th>발생일</th><th>조건값</th><th>종가</th><th>이후 {artifact.horizon}D</th></tr></thead><tbody>{artifact.events.map((event) => <tr key={event.date}><td>{event.date}</td><td>{event.value}</td><td>{formatNumber(event.close)}</td><td className={toneOf(event.forwardReturnPct)}>{formatPercent(event.forwardReturnPct)}</td></tr>)}</tbody></table></div>}
      </ArtifactFrame>;
    case "backtest": {
      const dates = artifact.equityCurve.map((point) => point.date);
      return <ArtifactFrame eyebrow="BACKTEST" title={artifact.title} subtitle={`${artifact.period.from} → ${artifact.period.to} · ${artifact.period.sessions} 거래일`} notes={artifact.notes}>
        <LineChart dates={dates} ariaLabel="전략 vs 매수보유 자본곡선" series={[{ name: artifact.strategy, values: artifact.equityCurve.map((point) => point.strategy), color: "#087aff" }, { name: "매수 후 보유", values: artifact.equityCurve.map((point) => point.benchmark), color: "#9b9ba1", dashed: true }]} references={[{ value: 100, label: "시작 100" }]} height={300} />
        <StatGrid items={Object.entries(artifact.metrics).map(([label, value]) => /샤프|거래/.test(label) ? { label, value: value === null ? "—" : String(value), tone: "neutral" as const } : label.includes("승률") || label.includes("노출") ? { label, value: typeof value === "number" ? `${value.toFixed(1)}%` : "—", tone: "neutral" as const } : percentStat(label, value))} />
        {artifact.trades.length > 0 && <div className="lab-table-wrap"><table className="lab-table"><thead><tr><th>진입</th><th>청산</th><th>진입가</th><th>청산가</th><th>보유일</th><th>수익률</th></tr></thead><tbody>{[...artifact.trades].reverse().slice(0, 15).map((trade) => <tr key={`${trade.entryDate}-${trade.exitDate}`}><td>{trade.entryDate}</td><td>{trade.exitDate}</td><td>{formatNumber(trade.entryPrice)}</td><td>{formatNumber(trade.exitPrice)}</td><td>{trade.sessions}</td><td className={toneOf(trade.returnPct)}>{formatPercent(trade.returnPct)}</td></tr>)}</tbody></table></div>}
      </ArtifactFrame>;
    }
    case "seasonality":
      return <ArtifactFrame eyebrow="SEASONALITY" title={artifact.title} subtitle={`${artifact.years}년 표본`} notes={artifact.notes}>
        <BarChart ariaLabel="월별 평균 수익률" items={artifact.monthly.map((month) => ({ label: month.label, value: month.averagePct, hint: `n=${month.samples} · 상승 ${month.positiveRatePct ?? "—"}%` }))} height={220} />
        <BarChart ariaLabel="요일별 평균 수익률" items={artifact.weekday.map((day) => ({ label: day.label, value: day.averagePct, hint: `n=${day.samples} · 상승 ${day.positiveRatePct ?? "—"}%` }))} height={160} valueFormat={(value) => formatPercent(value, 3)} />
      </ArtifactFrame>;
    case "table":
      return <ArtifactFrame eyebrow="DATA TABLE" title={artifact.title} subtitle={artifact.subtitle} notes={artifact.notes}>
        <div className="lab-table-wrap"><table className="lab-table"><thead><tr>{artifact.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{artifact.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className={cellIndex > 0 && typeof cell === "number" && /[%]/.test(artifact.columns[cellIndex] ?? "") ? toneOf(cell) : ""}>{typeof cell === "number" ? formatNumber(cell) : cell ?? "—"}</td>)}</tr>)}</tbody></table></div>
      </ArtifactFrame>;
    case "drawdown-news":
      return <ArtifactFrame eyebrow="EVENT LINKAGE" title={artifact.title} subtitle={`${artifact.period.from} → ${artifact.period.to}`} notes={artifact.notes}>
        <div className="drawdown-events">{artifact.events.map((event) => <section key={event.date}>
          <div className="drawdown-date"><span>{event.date}</span><strong className={toneOf(event.returnPct)}>{formatPercent(event.returnPct)}</strong><small>종가 {formatNumber(event.close)}</small></div>
          <div className="drawdown-headlines">{event.news.length ? event.news.map((news) => <a href={news.url} target="_blank" rel="noreferrer" key={`${news.url}-${news.title}`}><span>{news.source} · {news.publishedAt.slice(0, 10)}</span><strong>{news.title}</strong><ExternalLink size={12} /></a>) : <p>이 구간에서 검색된 {artifact.company} 헤드라인이 없습니다.</p>}</div>
        </section>)}</div>
      </ArtifactFrame>;
    case "news-list":
      return <ArtifactFrame eyebrow="NEWS" title={artifact.title} subtitle={`${artifact.period.from} → ${artifact.period.to} · ${artifact.items.length}건`} notes={artifact.notes}>
        <div className="drawdown-headlines">{artifact.items.map((item) => <a href={item.url} target="_blank" rel="noreferrer" key={`${item.url}-${item.title}`}><span>{item.source} · {item.publishedAt.slice(0, 16).replace("T", " ")}</span><strong>{item.title}</strong><ExternalLink size={12} /></a>)}</div>
      </ArtifactFrame>;
    case "calendar":
      return <ArtifactFrame eyebrow="ECONOMIC CALENDAR" title={artifact.title} subtitle={`${artifact.events.length}개 일정 · ET`} notes={artifact.notes}>
        <div className="lab-table-wrap"><table className="lab-table"><thead><tr><th>날짜</th><th>시각 ET</th><th>일정</th><th>분류</th><th>중요도</th></tr></thead><tbody>{artifact.events.map((event) => <tr key={`${event.date}-${event.title}`}><td>{event.date}</td><td>{event.time}</td><td><strong>{event.title}</strong><br /><small>{event.note}</small></td><td>{event.category}</td><td>{event.importance === "high" ? "높음" : "보통"}</td></tr>)}</tbody></table></div>
      </ArtifactFrame>;
    case "tradingview":
      return <ArtifactFrame eyebrow="TRADINGVIEW" title={artifact.title} subtitle={artifact.symbol} notes={artifact.notes}>
        <div className="lab-tradingview"><TradingViewChart symbol={artifact.symbol} interval={artifact.interval} studies={artifact.studies} /></div>
      </ArtifactFrame>;
    default:
      return <article className="lab-artifact-card limitation"><AlertTriangle size={22} /><div><span>DATA LIMITATION</span><h2>{artifact.title}</h2><p>{artifact.explanation}</p><ul>{artifact.suggestions.map((item) => <li key={item}>{item}</li>)}</ul></div></article>;
  }
}

export function artifactKindLabel(artifact: LabArtifact) {
  const labels: Record<LabArtifact["type"], string> = { "price-chart": "가격", "price-comparison": "비교", "indicator-panel": "지표", "event-study": "이벤트", backtest: "백테스트", seasonality: "계절성", table: "표", "drawdown-news": "급등락", "news-list": "뉴스", calendar: "일정", tradingview: "차트", limitation: "제한" };
  return labels[artifact.type];
}
