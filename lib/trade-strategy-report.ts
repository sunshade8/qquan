/**
 * Markdown records for the 전략 tab.
 *
 * Every backtest and every trade run writes one of these. The point is not
 * presentation: a run that exists only as a popup is a run nobody can compare
 * against next month, and the whole reason this rule was adopted is that its
 * out-of-sample behaviour was checked against a written record. The file is
 * stored in D1 and offered as a `.md` download so the record survives the tab
 * being closed.
 */

import { roundTripPct, feePerSidePct, assumedSlippagePct } from "./broker-costs.ts";
import type { ReplayResult } from "./trade-strategy-engine.ts";
import type { PlannedOrder, StrategyPlan, TradeStrategy } from "./trade-strategies.ts";

function pct(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
}
/** Share prices, at the precision anyone actually reads. */
function price(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(2);
}
/** Drawdown is carried as a positive magnitude; it is reported as a loss. */
function drawdown(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `−${Math.abs(value).toFixed(2)}%`;
}
function usd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  // The sign belongs outside the currency symbol: "$-58" reads as a price.
  return `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function costLine() {
  return `왕복 ${roundTripPct()}% (편도 수수료 ${feePerSidePct()}% × 2 + SEC 매도 0.0008% + 가정 슬리피지 ${assumedSlippagePct()}%) — \`lib/broker-costs.ts\``;
}

export function backtestFilename(strategy: TradeStrategy, result: ReplayResult, createdAt: string) {
  return `backtest-${strategy.id}-${result.from}_${result.to}-${createdAt.slice(0, 19).replace(/[:T]/g, "")}.md`;
}

export function tradeFilename(strategy: TradeStrategy, asOf: string, createdAt: string) {
  return `trade-${strategy.id}-${asOf}-${createdAt.slice(0, 19).replace(/[:T]/g, "")}.md`;
}

export function renderBacktestMarkdown(strategy: TradeStrategy, result: ReplayResult, createdAt: string) {
  const m = result.metrics;
  const lines: string[] = [];

  lines.push(`# 백테스트 · ${strategy.name}`);
  lines.push("");
  lines.push(`- 실행 시각: ${createdAt}`);
  lines.push(`- 기간: **${result.from} → ${result.to}** (${result.sessions}세션)`);
  lines.push(`- 시작 자본: ${usd(result.startingCapitalUsd)} · 종료 평가액: **${usd(result.endingEquityUsd)}**`);
  lines.push(`- 비용: ${costLine()} — 편도 ${result.costPerSidePct}%를 매수·매도 양쪽에 부과`);
  lines.push(`- 체결 규약: 신호는 종가 확정 후, 체결은 **다음 세션 종가**. 손절은 진입과 함께 거는 상시 스탑이며 장중 체결(갭 하락 시 시가 체결).`);
  lines.push("");

  lines.push("## 규칙");
  lines.push("");
  for (const rule of strategy.rules) lines.push(`- ${rule}`);
  lines.push("");
  lines.push(`근거: ${strategy.evidence}`);
  lines.push("");

  lines.push("## 성적");
  lines.push("");
  lines.push("| 지표 | 값 |");
  lines.push("|---|---|");
  lines.push(`| 총수익 | **${pct(m.totalReturnPct)}** |`);
  lines.push(`| 벤치마크 ${strategy.benchmark} 같은 기간 | ${pct(m.benchmarkReturnPct)} |`);
  lines.push(`| 초과 | ${pct(m.totalReturnPct !== null && m.benchmarkReturnPct !== null ? m.totalReturnPct - m.benchmarkReturnPct : null)} |`);
  lines.push(`| 거래 수 | ${m.trades} |`);
  lines.push(`| 승률 | ${m.winRatePct === null ? "—" : `${m.winRatePct}%`} |`);
  lines.push(`| 거래당 순수익 | **${pct(m.avgNetPct)}** |`);
  lines.push(`| 거래당 중앙값 | ${pct(m.medianNetPct)} |`);
  lines.push(`| 평균 이익 / 평균 손실 | ${pct(m.avgWinPct)} / ${pct(m.avgLossPct)} |`);
  lines.push(`| 손익비 | ${m.payoff ?? "—"} |`);
  lines.push(`| 최대 낙폭 | ${drawdown(m.maxDrawdownPct)} |`);
  lines.push(`| 진입일 / 노출 | ${m.activeDays}일 (${m.activeDayPct ?? "—"}%) / ${m.exposurePct ?? "—"}% |`);
  lines.push(`| 지불한 비용 | ${usd(m.costPaidUsd)} |`);
  lines.push("");

  if (result.trades.length) {
    const closed = [...result.trades].sort((a, b) => (a.exitDate < b.exitDate ? 1 : -1));
    lines.push(`## 거래 내역 (${closed.length}건)`);
    lines.push("");
    lines.push("| 종목 | 진입일 | 청산일 | 수량 | 진입가 | 청산가 | 보유 | 순수익% | 손익 | 청산 |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const trade of closed) {
      lines.push(`| ${trade.symbol} | ${trade.entryDate} | ${trade.exitDate} | ${trade.quantity} | ${price(trade.entryPrice)} | ${price(trade.exitPrice)} | ${trade.sessions}일 | ${pct(trade.netPct)} | ${usd(trade.netUsd)} | ${trade.exit === "stop" ? "손절" : "시간"} |`);
    }
    lines.push("");
  } else {
    lines.push("## 거래 내역");
    lines.push("");
    lines.push("이 기간에 청산된 거래가 없습니다.");
    lines.push("");
  }

  if (result.openPositions.length) {
    lines.push("## 기간 종료 시점 미청산 포지션");
    lines.push("");
    lines.push("| 종목 | 수량 | 평단 | 최종가 | 평가손익 | 진입일 |");
    lines.push("|---|---|---|---|---|---|");
    for (const position of result.openPositions) {
      lines.push(`| ${position.symbol} | ${position.quantity} | ${price(position.averagePrice)} | ${price(position.lastPrice)} | ${usd(position.unrealizedUsd)} | ${position.entryDate} |`);
    }
    lines.push("");
  }

  if (strategy.cautions.length) {
    lines.push("## 알려진 한계");
    lines.push("");
    for (const caution of strategy.cautions) lines.push(`- ${caution}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(`이 기록은 \`lib/trade-strategies.ts\`의 \`${strategy.id}.plan()\` — **실거래에 쓰는 것과 같은 함수** — 를 과거 봉에 다시 돌려 만들었습니다. 백테스트와 매매가 다른 코드를 쓰지 않습니다.`);
  lines.push("");
  return lines.join("\n");
}

export function renderTradeMarkdown(
  strategy: TradeStrategy,
  plan: StrategyPlan,
  input: { createdAt: string; capitalUsd: number; gateway: string; submitted: boolean; positionsBefore: Array<{ symbol: string; quantity: number; averagePrice: number; entryDate: string }>; submissions: Array<{ symbol: string; side: string; accepted: boolean; message: string }> },
) {
  const lines: string[] = [];
  lines.push(`# 매매 실행 · ${strategy.name}`);
  lines.push("");
  lines.push(`- 실행 시각: ${input.createdAt}`);
  lines.push(`- 신호 기준일(마지막 확정 종가): **${plan.asOf}**`);
  lines.push(`- 자본: ${usd(input.capitalUsd)} · 게이트웨이: **${input.gateway}**`);
  lines.push(`- 상태: ${input.submitted ? "주문 전송 시도함" : "계획만 생성 (전송 안 함)"}`);
  lines.push(`- 비용 가정: ${costLine()}`);
  lines.push("");

  lines.push("## 실행 전 보유");
  lines.push("");
  if (input.positionsBefore.length) {
    lines.push("| 종목 | 수량 | 평단 | 진입일 |");
    lines.push("|---|---|---|---|");
    for (const position of input.positionsBefore) lines.push(`| ${position.symbol} | ${position.quantity} | ${price(position.averagePrice)} | ${position.entryDate} |`);
  } else {
    lines.push("보유 포지션 없음.");
  }
  lines.push("");

  lines.push(`## 주문 (${plan.orders.length}건)`);
  lines.push("");
  if (plan.orders.length) {
    lines.push("| 구분 | 종목 | 수량 | 기준가 | 금액 | 손절 | 사유 |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const order of plan.orders as PlannedOrder[]) {
      lines.push(`| ${order.side === "buy" ? "매수" : "매도"} | ${order.symbol} | ${order.quantity} | ${price(order.referencePrice)} | ${usd(order.notionalUsd)} | ${order.stopPrice === null ? "—" : price(order.stopPrice)} | ${order.reason} |`);
    }
  } else {
    lines.push("주문 없음.");
  }
  lines.push("");

  if (plan.skipped.length) {
    lines.push("## 조건은 맞았지만 건너뛴 종목");
    lines.push("");
    lines.push("| 종목 | 3일 수익률 | 사유 |");
    lines.push("|---|---|---|");
    for (const item of plan.skipped) lines.push(`| ${item.symbol} | ${item.metric === null ? "—" : `${item.metric}%`} | ${item.reason} |`);
    lines.push("");
  }

  if (input.submissions.length) {
    lines.push("## 전송 결과");
    lines.push("");
    for (const submission of input.submissions) {
      lines.push(`- ${submission.accepted ? "✅" : "❌"} **${submission.side === "buy" ? "매수" : "매도"} ${submission.symbol}** — ${submission.message}`);
    }
    lines.push("");
  }

  if (plan.notes.length) {
    lines.push("## 메모");
    lines.push("");
    for (const note of plan.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  return lines.join("\n");
}
