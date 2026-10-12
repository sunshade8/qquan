"use client";
import "./ct.css";
import { useState } from "react";
import type { CTSpec } from "@/lib/ct-spec";
import type { CTBar, CTTrade } from "@/lib/ct-engine";
export function CTEvidenceChart({
  bars,
  trade,
  currency,
  spec,
  outcome,
  observedAt,
}: {
  bars: CTBar[];
  trade: CTTrade;
  currency: string;
  spec: CTSpec;
  outcome?: string;
  observedAt?: number;
}) {
  const [cursor, setCursor] = useState(
    observedAt ? bars.length : bars.length - 1,
  );
  const visible = bars.slice(0, cursor + 1),
    now =
      observedAt && cursor >= bars.length
        ? observedAt
        : (visible.at(-1)?.endMs ?? 0);
  if (!visible.length) return <p>차트 데이터 없음</p>;
  const knownLevels = [
    ...(now >= trade.entryAt
      ? [
          trade.entry,
          Math.max(
            trade.entry * (1 - spec.exit.stopPct / 100),
            spec.exit.invalidation === "last_stage_low"
              ? trade.signal.patternLow
              : 0,
          ),
          trade.entry * (1 + spec.exit.targetPct / 100),
        ]
      : []),
    ...(now >= trade.exitAt ? [trade.exit] : []),
    ...(now >= trade.signal.decidedAt
      ? [
          trade.signal.support,
          trade.signal.resistance,
          ...(trade.signal.references ?? []).map((r) => r.price),
        ]
      : []),
  ];
  const width = 900,
    height = 320,
    pad = 30,
    min = Math.min(...visible.map((b) => b.low), ...knownLevels),
    max = Math.max(...visible.map((b) => b.high), ...knownLevels),
    span = max - min || 1;
  const x = (ms: number) =>
    pad +
    ((ms - visible[0].startMs) /
      Math.max(1, Math.max(now, visible.at(-1)!.endMs) - visible[0].startMs)) *
      (width - pad * 2);
  const y = (p: number) => pad + (1 - (p - min) / span) * 210;
  const volume = Math.max(...visible.map((b) => b.volume), 1),
    signal = trade.signal;
  const line = (
    price: number,
    label: string,
    knownAt: number,
    color: string,
  ) =>
    now >= knownAt ? (
      <g key={label}>
        <line
          x1={Math.max(pad, x(knownAt))}
          x2={width - pad}
          y1={y(price)}
          y2={y(price)}
          stroke={color}
          strokeDasharray="4 4"
        />
        <text
          x={width - pad}
          y={y(price) - 4}
          textAnchor="end"
          fill={color}
          fontSize="11"
        >
          {label} {price.toLocaleString("ko-KR", { maximumFractionDigits: 8 })}
        </text>
      </g>
    ) : null;
  return (
    <figure className="ct-evidence-chart">
      <figcaption>
        <b>{trade.symbol} · 엔진 신호 근거</b>
        <span>
          {currency} · {new Date(now).toLocaleString("ko-KR")} ·{" "}
          {outcome ??
            (now >= trade.exitAt
              ? `${trade.pnl >= 0 ? "수익" : "손실"} 사례`
              : "청산 결과 미확정")}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="완성봉·패턴 구간·확인 피벗·진입·손절·목표·청산 및 거래량"
      >
        {now >= signal.decidedAt ? (
          <rect
            x={x(signal.patternFrom)}
            y={pad}
            width={Math.max(1, x(signal.decidedAt) - x(signal.patternFrom))}
            height={210}
            fill="currentColor"
            opacity=".05"
          />
        ) : null}
        {visible.map((b, i) => {
          const cx = x(b.startMs),
            bar = Math.max(1, ((width - pad * 2) / visible.length) * 0.55),
            up = b.close >= b.open;
          return (
            <g
              key={b.startMs}
              fill={up ? "var(--up)" : "var(--down)"}
              stroke={up ? "var(--up)" : "var(--down)"}
            >
              <line x1={cx} x2={cx} y1={y(b.high)} y2={y(b.low)} />
              <rect
                x={cx - bar / 2}
                y={y(Math.max(b.open, b.close))}
                width={bar}
                height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
              />
              <rect
                x={cx - bar / 2}
                y={height - 15 - (b.volume / volume) * 50}
                width={bar}
                height={(b.volume / volume) * 50}
                opacity=".4"
              />
              <title>
                {i + 1} · {new Date(b.endMs).toISOString()} · 거래량 {b.volume}
              </title>
            </g>
          );
        })}
        {line(signal.resistance, "참고 20봉 고점", signal.decidedAt, "var(--secondary)")}
        {line(signal.support, "참고 20봉 저점", signal.decidedAt, "var(--secondary)")}
        {signal.references?.map((r, i) =>
          line(r.price, `${r.feature} (${i + 1})`, signal.decidedAt, "var(--secondary)"),
        )}
        {line(trade.entry, "진입", trade.entryAt, "var(--accent)")}
        {line(
          Math.max(
            trade.entry * (1 - spec.exit.stopPct / 100),
            spec.exit.invalidation === "last_stage_low" ? signal.patternLow : 0,
          ),
          "손절·무효화",
          trade.entryAt,
          "var(--down)",
        )}
        {line(
          trade.entry * (1 + spec.exit.targetPct / 100),
          "목표",
          trade.entryAt,
          "var(--up)",
        )}
        {line(trade.exit, "청산", trade.exitAt, "var(--warn)")}
        {signal.stages
          .filter((s) => now >= signal.decidedAt && s.at <= now)
          .map((s, i) => (
            <g key={s.at}>
              <line
                x1={x(s.at)}
                x2={x(s.at)}
                y1={pad}
                y2={240}
                stroke="var(--secondary)"
                opacity=".5"
              />
              <text
                x={x(s.at) + 3}
                y={20 + i * 12}
                fontSize="10"
                fill="currentColor"
              >
                단계 {i + 1} 확정
              </text>
            </g>
          ))}
        {signal.swings
          .filter((s) => s.confirmedAt <= now && s.at >= visible[0].startMs)
          .map((s) => (
            <g key={`${s.kind}${s.at}`}>
              <circle cx={x(s.at)} cy={y(s.price)} r={3} fill="var(--warn)" />
              <title>
                {s.kind} · 사용 가능 {new Date(s.confirmedAt).toISOString()}
              </title>
            </g>
          ))}
        {now >= signal.decidedAt ? (
          <text
            x={x(signal.decidedAt)}
            y={250}
            fontSize="10"
            fill="currentColor"
          >
            신호 확정
          </text>
        ) : null}
      </svg>
      <label>
        리플레이 · 이 시점까지 알려진 정보만 표시
        <input
          type="range"
          min={0}
          max={observedAt ? bars.length : bars.length - 1}
          value={cursor}
          onChange={(e) => setCursor(Number(e.target.value))}
        />
      </label>
      <p className="strategy-note">
        피벗은 오른쪽 2봉이 완성된 뒤 표시됩니다. 선은 신호 확정·체결 시점부터
        표시합니다. 거래량과 조건 실측값은 저장된 엔진 기록입니다.
      </p>
      <dl className="ct-values">
        {signal.stages
          .filter((s) => now >= signal.decidedAt && s.at <= now)
          .map((s, i) => (
            <div key={s.at}>
              <dt>단계 {i + 1}</dt>
              <dd>
                {s.values
                  .map(
                    (v, j) =>
                      `${spec.stages[i]?.conditions[j]?.feature}: ${v.toFixed(4)}`,
                  )
                  .join(" · ")}
              </dd>
            </div>
          ))}
      </dl>
    </figure>
  );
}
