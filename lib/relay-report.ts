/**
 * The relay backtest report: what the dashboards' 백테스트 button shows, and the
 * PDF it downloads.
 *
 * Built from `RelayResult` alone so the screen and the PDF cannot disagree. Pure
 * apart from the PDF font fetch, and `pdf-lib` is imported lazily so the report
 * type can be used on the server without pulling the PDF code in.
 */

import type { RelayResult, SlotOutcome, SlotStrategy } from "./relay-engine.ts";
import { slotById } from "./trade-slots.ts";
import { adherencePct } from "./trade-adherence.ts";

export type RelayDataSource = {
  symbol: string; provider: string; bars: number; firstDate: string; lastDate: string;
  fallbackReason: string | null; cachedMonths?: number; fetchedMonths?: number;
};

export type RelayStrategyReport = {
  id: string; name: string; slot: string; slotLabel: string; universe: string[];
  signals: number; trades: number; missedSignals: number;
  compliantTrades: number;
  /** Trades that departed from the rule, plus signals that never filled. */
  deviations: number;
  adherencePct: number | null;
  /** Filled signals over all signals. */
  fillRatePct: number | null;
  pnlUsd: number; contributionPct: number; costUsd: number;
  winRatePct: number | null; avgTradeReturnPct: number | null;
  exits: { stop: number; target: number; slot_end: number };
  deviationReasons: Array<{ reason: string; count: number }>;
};

export type RelayTradeRow = {
  date: string; strategyId: string; strategyName: string; slotLabel: string; symbol: string;
  signalTime: string | null; entryTime: string | null; exitTime: string | null;
  entryPrice: number | null; exitPrice: number | null; quantity: number;
  exit: SlotOutcome["exit"]; pnlUsd: number; returnPct: number; costUsd: number;
  traded: boolean; ruleCompliant: boolean | null; violations: string[]; reason: string;
};

export type RelayBacktestReport = {
  version: 2; generatedAt: string; requested: { from: string; to: string };
  dashboard: "live" | "paper" | null;
  capitalUsd: number; /** Every bar resolution the book's rules read, e.g. "5m" or "1m · 5m". */ interval: string; dataSources: RelayDataSource[]; warnings: string[];
  strategies: RelayStrategyReport[];
  daily: Array<{ date: string; startEquityUsd: number; endEquityUsd: number; pnlUsd: number; returnPct: number; intradayLowPct: number; trades: number; cumulativeReturnPct: number }>;
  trades: RelayTradeRow[];
  metrics: RelayResult["metrics"];
  totals: { endingEquityUsd: number; pnlUsd: number; returnPct: number; costUsd: number; signals: number; trades: number; compliantTrades: number; deviations: number };
};

const rounded = (value: number, digits = 4) => Number(value.toFixed(digits));

export function buildRelayReport(input: {
  result: RelayResult; strategies: SlotStrategy[]; from: string; to: string;
  sources: RelayDataSource[]; warnings?: string[]; generatedAt?: string; dashboard?: "live" | "paper" | null;
}): RelayBacktestReport {
  const { result } = input;
  const names = new Map(input.strategies.map((strategy) => [strategy.id, strategy]));

  const strategies = input.strategies.map((strategy): RelayStrategyReport => {
    const outcomes = result.days.flatMap((day) => day.slots.filter((slot) => slot.strategyId === strategy.id));
    const signals = outcomes.filter((outcome) => outcome.signal);
    const trades = outcomes.filter((outcome) => outcome.traded);
    const compliant = trades.filter((outcome) => outcome.ruleCompliant === true).length;
    const deviating = outcomes.filter((outcome) => outcome.ruleCompliant === false || (!outcome.traded && outcome.violations.length > 0));
    const reasons = new Map<string, number>();
    for (const outcome of deviating) {
      for (const violation of outcome.violations) {
        const key = violation.replace(/[−-]?\d+(\.\d+)?%?|\$\d+/g, "#").replace(/\s+/g, " ").split(":")[0].trim();
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
    }
    const pnlUsd = rounded(trades.reduce((sum, outcome) => sum + outcome.pnlUsd, 0), 2);
    return {
      id: strategy.id, name: strategy.name, slot: strategy.slot,
      slotLabel: slotById(strategy.slot)?.label ?? strategy.slot, universe: strategy.universe,
      signals: signals.length, trades: trades.length, missedSignals: signals.length - trades.length,
      compliantTrades: compliant, deviations: deviating.length,
      adherencePct: adherencePct(compliant, trades.length),
      fillRatePct: signals.length ? rounded((trades.length / signals.length) * 100, 2) : null,
      pnlUsd, contributionPct: rounded(pnlUsd / result.startingCapitalUsd * 100),
      costUsd: rounded(trades.reduce((sum, outcome) => sum + outcome.costUsd, 0), 2),
      winRatePct: trades.length ? rounded(trades.filter((outcome) => outcome.pnlUsd > 0).length / trades.length * 100, 2) : null,
      avgTradeReturnPct: trades.length ? rounded(trades.reduce((sum, outcome) => sum + outcome.returnPct, 0) / trades.length) : null,
      exits: {
        stop: trades.filter((outcome) => outcome.exit === "stop").length,
        target: trades.filter((outcome) => outcome.exit === "target").length,
        slot_end: trades.filter((outcome) => outcome.exit === "slot_end").length,
      },
      deviationReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((left, right) => right.count - left.count),
    };
  });

  const daily = result.days.map((day) => ({
    date: day.date, startEquityUsd: day.startEquityUsd, endEquityUsd: day.endEquityUsd,
    pnlUsd: rounded(day.endEquityUsd - day.startEquityUsd, 2), returnPct: day.returnPct,
    intradayLowPct: day.intradayLowPct, trades: day.slots.filter((slot) => slot.traded).length,
    cumulativeReturnPct: rounded((day.endEquityUsd / result.startingCapitalUsd - 1) * 100),
  }));

  const trades = result.days.flatMap((day) => day.slots
    .filter((slot) => slot.strategyId && slot.signal)
    .map((slot): RelayTradeRow => ({
      date: day.date, strategyId: slot.strategyId!, strategyName: names.get(slot.strategyId!)?.name ?? slot.strategyId!,
      slotLabel: slotById(slot.slot)?.label ?? slot.slot, symbol: slot.symbol ?? "-",
      signalTime: slot.signalTime, entryTime: slot.entryTime, exitTime: slot.exitTime,
      entryPrice: slot.entryPrice, exitPrice: slot.exitPrice, quantity: slot.quantity, exit: slot.exit,
      pnlUsd: slot.pnlUsd, returnPct: slot.returnPct, costUsd: slot.costUsd,
      traded: slot.traded, ruleCompliant: slot.ruleCompliant, violations: slot.violations, reason: slot.reason,
    })));

  return {
    version: 2, generatedAt: input.generatedAt ?? new Date().toISOString(), requested: { from: input.from, to: input.to },
    dashboard: input.dashboard ?? null,
    capitalUsd: result.startingCapitalUsd,
    interval: [...new Set(input.strategies.map((strategy) => strategy.barMinutes ?? 5))].sort((a, b) => a - b).map((step) => `${step}m`).join(" · ") || "5m",
    dataSources: input.sources,
    warnings: input.warnings ?? [], strategies, daily, trades, metrics: result.metrics,
    totals: {
      endingEquityUsd: result.endingEquityUsd,
      pnlUsd: rounded(result.endingEquityUsd - result.startingCapitalUsd, 2), returnPct: result.metrics.totalReturnPct ?? 0,
      costUsd: result.metrics.costPaidUsd,
      signals: result.metrics.signals, trades: result.metrics.totalTrades,
      compliantTrades: result.metrics.compliantTrades,
      deviations: strategies.reduce((sum, row) => sum + row.deviations, 0),
    },
  };
}

export const EXIT_LABEL: Record<NonNullable<SlotOutcome["exit"]>, string> = { stop: "손절", target: "목표", slot_end: "슬롯 종료" };

export function reportFilename(report: RelayBacktestReport) {
  return `qquan-backtest-${report.requested.from}_${report.requested.to}.pdf`;
}

/** Client-side PDF export. Font bytes may be supplied by tests. */
export async function generateRelayPdf(report: RelayBacktestReport, options: { fontBytes?: Uint8Array } = {}): Promise<Uint8Array> {
  const [{ PDFDocument, rgb }, { default: fontkit }] = await Promise.all([import("pdf-lib"), import("@pdf-lib/fontkit")]);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  let fontBytes = options.fontBytes;
  if (!fontBytes) {
    const response = await fetch("/fonts/NanumGothic-Regular.ttf");
    if (!response.ok) throw new Error("PDF 한글 글꼴을 불러오지 못했습니다.");
    fontBytes = new Uint8Array(await response.arrayBuffer());
  }
  const font = await doc.embedFont(fontBytes, { subset: true });
  const ink = rgb(0.12, 0.13, 0.15), muted = rgb(0.42, 0.43, 0.46), blue = rgb(0.03, 0.48, 1);
  const green = rgb(0.09, 0.53, 0.29), red = rgb(0.82, 0.23, 0.23), line = rgb(0.88, 0.88, 0.9);
  const width = 595.28, height = 841.89, margin = 42, usable = width - margin * 2;
  let page = doc.addPage([width, height]);
  let y = height - margin;
  const newPage = () => { page = doc.addPage([width, height]); y = height - margin; };
  const ensure = (space: number) => { if (y - space < margin + 24) newPage(); };
  const clean = (text: string) => text.replace(/[‐-―−]/g, "-").replace(/[→]/g, ">").replace(/[^\S\n]+/g, " ");
  const text = (value: string, size = 9, color = ink, x = margin) => {
    ensure(size + 6);
    page.drawText(clean(value), { x, y, size, font, color }); y -= size + 6;
  };
  const wrap = (value: string, size = 9, color = muted) => {
    for (const paragraph of clean(value).split("\n")) {
      let part = "";
      for (const character of paragraph) {
        if (font.widthOfTextAtSize(part + character, size) > usable) { text(part, size, color); part = character; }
        else part += character;
      }
      text(part, size, color);
    }
  };
  const title = (value: string) => { ensure(60); y -= 12; page.drawText(clean(value), { x: margin, y, size: 13, font, color: ink }); y -= 8; page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.6, color: line }); y -= 14; };
  const amount = (value: number | null) => value === null ? "-" : `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pct = (value: number | null, digits = 2) => value === null ? "-" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
  const tone = (value: number | null) => value === null || value === 0 ? ink : value > 0 ? green : red;
  const table = (headers: string[], rows: Array<Array<string | { text: string; color: ReturnType<typeof rgb> }>>, widths: number[]) => {
    const scale = usable / widths.reduce((sum, value) => sum + value, 0);
    const columns = widths.map((value) => value * scale);
    const drawRow = (cells: Array<string | { text: string; color: ReturnType<typeof rgb> }>, header = false) => {
      if (y < margin + 40) { newPage(); drawRow(headers, true); }
      let x = margin;
      if (header) page.drawRectangle({ x: margin - 3, y: y - 5, width: usable + 6, height: 17, color: rgb(0.95, 0.95, 0.96) });
      cells.forEach((cell, index) => {
        const raw = typeof cell === "string" ? cell : cell.text;
        let value = clean(raw);
        while (value.length > 1 && font.widthOfTextAtSize(value, 7.5) > columns[index] - 5) value = `${value.slice(0, -2)}…`;
        page.drawText(value, { x, y, size: 7.5, font, color: header ? muted : typeof cell === "string" ? ink : cell.color });
        x += columns[index];
      });
      y -= 16;
    };
    drawRow(headers, true); rows.forEach((cells) => drawRow(cells)); y -= 6;
  };
  const kpis = (items: Array<[string, string, ReturnType<typeof rgb>?]>) => {
    const perRow = 4, cell = usable / perRow;
    for (let index = 0; index < items.length; index += perRow) {
      ensure(44);
      items.slice(index, index + perRow).forEach(([label, value, color], column) => {
        const x = margin + column * cell;
        page.drawRectangle({ x, y: y - 26, width: cell - 6, height: 36, borderColor: line, borderWidth: 0.6, color: rgb(1, 1, 1) });
        page.drawText(clean(label), { x: x + 7, y: y - 1, size: 7, font, color: muted });
        page.drawText(clean(value), { x: x + 7, y: y - 17, size: 12, font, color: color ?? ink });
      });
      y -= 44;
    }
  };

  const m = report.metrics;
  doc.setTitle("QQUAN 전략 백테스트 보고서"); doc.setAuthor("qquan");
  text("QQUAN / SLOT RELAY BACKTEST", 8, blue); y -= 18;
  text("전략 백테스트 보고서", 22); y -= 4;
  text(`${report.requested.from} ~ ${report.requested.to}  |  시작 자본 ${amount(report.capitalUsd)}  |  ${report.interval.replace(/m/g, "분봉")} · 04:00-19:55 ET${report.dashboard ? `  |  ${report.dashboard === "live" ? "실전 대시보드" : "모의투자 대시보드"}` : ""}`, 9, muted);
  text(`생성 ${report.generatedAt}  |  평가 세션 ${m.sessions}일  |  전략 ${report.strategies.length}개`, 8, muted);

  title("총 수익과 위험");
  kpis([
    ["최종 잔고", amount(report.totals.endingEquityUsd)],
    ["총 수익", amount(report.totals.pnlUsd), tone(report.totals.pnlUsd)],
    ["총 수익률", pct(report.totals.returnPct), tone(report.totals.returnPct)],
    ["거래 비용", amount(report.totals.costUsd)],
    ["일평균 수익률", pct(m.meanDailyPct, 3), tone(m.meanDailyPct)],
    ["수익 난 날", m.positiveDayPct === null ? "-" : `${m.positiveDayPct.toFixed(1)}%`],
    ["최대 낙폭 (장중 포함)", m.maxDrawdownPct === null ? "-" : `-${m.maxDrawdownPct.toFixed(2)}%`, red],
    ["최대 낙폭 (종가 기준)", m.endOfDayMaxDrawdownPct === null ? "-" : `-${m.endOfDayMaxDrawdownPct.toFixed(2)}%`],
    ["최악의 날", pct(m.worstDayPct), tone(m.worstDayPct)],
    ["최악의 장중 저점", pct(m.worstIntradayPct), tone(m.worstIntradayPct)],
    ["+1% 달성일", m.daysAbove1PctShare === null ? "-" : `${m.daysAbove1PctShare.toFixed(1)}%`],
    ["+2% 달성일", m.daysAbove2PctShare === null ? "-" : `${m.daysAbove2PctShare.toFixed(1)}%`],
  ]);

  title("전략 준수 (규칙대로 거래했는가)");
  kpis([
    ["규칙 준수율", m.adherencePct === null ? "-" : `${m.adherencePct.toFixed(1)}%`],
    ["신호 / 체결", `${m.signals} / ${m.totalTrades}`],
    ["미체결 신호", String(m.missedSignals), m.missedSignals ? red : ink],
    ["승률", m.winRatePct === null ? "-" : `${m.winRatePct.toFixed(1)}%`],
  ]);
  wrap("규칙 준수 = 체결된 거래 중 (1) 모형 진입가에 체결, (2) 손절폭을 넘는 손실 없음, (3) 슬롯 종료 전 청산을 모두 지킨 비율. 백테스트에서 이탈은 주로 갭으로 손절가를 건너뛴 경우이고, 미체결 신호는 슬롯 마지막 봉 신호·잔고 부족·잘못된 주문입니다.", 7.5);

  // Equity curve.
  if (report.daily.length > 1) {
    ensure(150);
    y -= 6;
    const chartHeight = 110, chartBottom = y - chartHeight;
    const values = [report.capitalUsd, ...report.daily.map((day) => day.endEquityUsd)];
    const low = Math.min(...values), high = Math.max(...values), span = high - low || 1;
    page.drawRectangle({ x: margin, y: chartBottom, width: usable, height: chartHeight, borderColor: line, borderWidth: 0.6 });
    const base = chartBottom + ((report.capitalUsd - low) / span) * chartHeight;
    page.drawLine({ start: { x: margin, y: base }, end: { x: width - margin, y: base }, thickness: 0.4, color: line, dashArray: [3, 3] });
    const step = usable / (values.length - 1);
    for (let index = 1; index < values.length; index += 1) {
      page.drawLine({
        start: { x: margin + (index - 1) * step, y: chartBottom + ((values[index - 1] - low) / span) * chartHeight },
        end: { x: margin + index * step, y: chartBottom + ((values[index] - low) / span) * chartHeight },
        thickness: 1.2, color: values.at(-1)! >= report.capitalUsd ? green : red,
      });
    }
    y = chartBottom - 12;
    text(`잔고 추이 (일별 종가 기준, 점선 = 시작 자본) · 최고 ${amount(high)} · 최저 ${amount(low)}`, 7.5, muted);
  }

  title("전략별 수익");
  if (!report.strategies.length) wrap("등록된 전략이 없습니다.");
  table(
    ["전략", "슬롯", "순손익", "계좌 기여", "비용", "거래", "승률", "평균 수익"],
    report.strategies.map((row) => [row.name, row.slotLabel, { text: amount(row.pnlUsd), color: tone(row.pnlUsd) }, { text: pct(row.contributionPct), color: tone(row.contributionPct) }, amount(row.costUsd), String(row.trades), row.winRatePct === null ? "-" : `${row.winRatePct.toFixed(1)}%`, pct(row.avgTradeReturnPct, 3)]),
    [120, 55, 65, 55, 50, 35, 45, 55],
  );
  table(
    ["전략", "신호", "체결률", "준수율", "이탈", "손절", "목표", "슬롯 종료"],
    report.strategies.map((row) => [row.name, String(row.signals), row.fillRatePct === null ? "-" : `${row.fillRatePct.toFixed(1)}%`, row.adherencePct === null ? "-" : `${row.adherencePct.toFixed(1)}%`, String(row.deviations), String(row.exits.stop), String(row.exits.target), String(row.exits.slot_end)]),
    [120, 45, 55, 55, 45, 45, 45, 55],
  );
  for (const row of report.strategies.filter((item) => item.deviationReasons.length)) {
    wrap(`${row.name} 이탈 사유: ${row.deviationReasons.map((item) => `${item.reason} ${item.count}건`).join(", ")}`, 7.5);
  }
  wrap("계좌 기여 = 전략 순손익 ÷ 시작 자본. 슬롯은 같은 잔고를 순서대로 쓰므로 전략 단독 복리 수익률이 아닙니다.", 7.5);

  title("날짜별 수익(률)");
  table(
    ["날짜", "시작 잔고", "종료 잔고", "손익", "수익률", "장중 저점", "누적", "거래"],
    report.daily.map((day) => [day.date, amount(day.startEquityUsd), amount(day.endEquityUsd), { text: amount(day.pnlUsd), color: tone(day.pnlUsd) }, { text: pct(day.returnPct), color: tone(day.returnPct) }, pct(day.intradayLowPct), { text: pct(day.cumulativeReturnPct), color: tone(day.cumulativeReturnPct) }, String(day.trades)]),
    [62, 62, 62, 55, 48, 48, 50, 30],
  );

  title("거래 기록");
  if (!report.trades.length) wrap("기간 중 신호가 없었습니다.");
  table(
    ["날짜", "전략", "종목", "신호→진입→청산", "수량", "손익", "청산", "준수"],
    report.trades.map((trade) => [
      trade.date, trade.strategyName, trade.symbol,
      trade.traded ? `${trade.signalTime} > ${trade.entryTime} > ${trade.exitTime}` : `${trade.signalTime ?? "-"} (미체결)`,
      String(trade.quantity), { text: amount(trade.pnlUsd), color: tone(trade.pnlUsd) },
      trade.exit ? EXIT_LABEL[trade.exit] : "-",
      trade.ruleCompliant === true ? "준수" : { text: trade.violations[0] ?? "이탈", color: red },
    ]),
    [52, 70, 38, 88, 32, 50, 40, 90],
  );

  title("데이터와 가정");
  report.dataSources.forEach((source) => wrap(`${source.symbol}: ${source.provider}, ${source.bars.toLocaleString()}봉, ${source.firstDate || "-"} ~ ${source.lastDate || "-"}${source.fallbackReason ? ` (${source.fallbackReason})` : ""}`, 7.5));
  report.warnings.forEach((warning) => wrap(`주의: ${warning}`, 7.5, red));
  wrap("규칙은 각자의 봉 주기(1·3·5분)로 완성된 봉만 보고 결정하며, 체결은 다음 봉 시가입니다. 진입 봉을 포함해 매 봉 손절·목표를 확인하고, 한 봉 안에서 둘 다 닿으면 손절로 봅니다. 수수료와 종목별 스프레드를 편도마다 차감하고, 정수 주식·단일 잔고·슬롯 종료 청산을 적용합니다. 최대 낙폭은 보유 중 매 봉의 저가로 평가한 청산가치 기준입니다. 호가 공백·시장 충격·부분 체결은 실제 주문과 다를 수 있습니다.", 7.5);

  const pages = doc.getPages();
  pages.forEach((item, index) => item.drawText(`QQUAN  |  ${index + 1} / ${pages.length}`, { x: margin, y: 22, size: 7.5, font, color: muted }));
  return doc.save();
}
