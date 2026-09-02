import type Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { newsTests } from "@/db/schema";
import { MARKET_EVENT_CALENDAR, MARKET_EVENT_CATEGORY_LABELS } from "@/app/market-calendar-data";
import { findCompanyNews, searchNews } from "@/lib/company-news";
import type { LabArtifact, LabToolTrace } from "@/lib/lab-types";
import { fetchTossSnapshot, type PriceRow } from "@/lib/market-data";
import { deterministicTestSummary, type ResearchTest } from "@/lib/news-research-agents";
import { loadDailyRows } from "@/lib/price-cache";
import {
  alignSeries, backtestStrategy, bollinger, correlation, dailyReturns, ema, eventStudy, findLargestMoves, macd, normalizeTo100, riskProfile, round, rsi, seasonality, sma, STRATEGY_LABELS, summaryStats, trailingReturns,
  type EventFeature, type EventOperator, type StrategyId, EVENT_FEATURE_LABELS,
} from "@/lib/quant";
import { resolveSymbol, resolveSymbols, type ResolvedSymbol } from "@/lib/symbols";
import { describeSpec, normalizeSpec, presetConditions, type BacktestResult } from "@/lib/strategy";
import { backtestSpec, getStrategy, listStrategies, runAndRecord, saveStrategy, STRATEGY_STATUS_LABELS } from "@/lib/strategy-store";

export type ToolContext = { ownerId: string; today: string; conversationId?: string | null };
export type ToolOutcome = { result: unknown; artifacts: LabArtifact[]; trace: Omit<LabToolTrace, "id" | "startedAt" | "durationMs"> };

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function windowFor(input: { from?: unknown; to?: unknown; lookbackDays?: unknown }, today: string, defaultLookback = 365) {
  const to = isDate(input.to) && input.to <= today ? input.to : today;
  const lookback = Math.min(3650, Math.max(20, Number(input.lookbackDays) || defaultLookback));
  const from = isDate(input.from) && input.from < to ? input.from : shiftDate(to, -lookback);
  return { from, to };
}

function id() {
  return crypto.randomUUID();
}

function compactBars(rows: PriceRow[]) {
  return rows.map((row) => ({ date: row.date, open: round(row.open, 4)!, high: round(row.high, 4)!, low: round(row.low, 4)!, close: round(row.close, 4)!, volume: Math.round(row.volume) }));
}

type Loaded = { asset: ResolvedSymbol; rows: PriceRow[]; origin: string; reason: string | null };

async function loadAsset(query: string, from: string, to: string): Promise<Loaded | { asset: ResolvedSymbol; error: string }> {
  const asset = await resolveSymbol(query);
  if (!asset.public || !asset.symbol) return { asset, error: asset.note ?? `${asset.name}의 공개 주가 데이터가 없습니다.` };
  const load = await loadDailyRows(asset.symbol, from, to);
  if (!load.rows.length) return { asset, error: `${asset.symbol} 일봉을 가져오지 못했습니다. ${load.reason ?? ""}`.trim() };
  return { asset, rows: load.rows, origin: load.origin, reason: load.reason };
}

function limitation(title: string, explanation: string, suggestions: string[]): LabArtifact {
  return { id: id(), type: "limitation", title, explanation, suggestions };
}

const OVERLAY_COLORS = ["#087aff", "#9a62da", "#d88700", "#18864b", "#d13b3b", "#0a9396"];

export const LAB_TOOLS: Anthropic.Tool[] = [
  {
    name: "resolve_symbols",
    description: "회사명·한글 별칭·티커를 라이브 시장 메타데이터로 확인한다. symbol·상장 상태·상장일·확인 시각·출처를 반환하며, 확인 실패를 비상장으로 단정하지 않는다. 어떤 종목인지 불확실할 때 먼저 호출한다.",
    input_schema: { type: "object", properties: { queries: { type: "array", items: { type: "string" }, description: "회사명 또는 티커 목록" } }, required: ["queries"] },
  },
  {
    name: "get_price_history",
    description: "종목의 조정 일봉(OHLCV)을 불러와 기간 수익률·CAGR·변동성·샤프·최대낙폭·기간 고저·추적 수익률(1W~1Y, YTD)을 계산하고 가격 차트를 Canvas에 그린다. 가격·차트·성과 질문의 기본 도구.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "회사명 또는 티커" },
        from: { type: "string", description: "YYYY-MM-DD (선택)" },
        to: { type: "string", description: "YYYY-MM-DD (선택, 기본 오늘)" },
        lookbackDays: { type: "integer", description: "from이 없을 때 기간(일). 기본 365" },
        overlays: { type: "array", items: { type: "string", enum: ["sma20", "sma50", "sma200", "ema21", "bollinger"] }, description: "차트에 겹칠 지표" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "compare_assets",
    description: "2~6개 자산의 일봉을 공통 거래일로 정렬해 100 기준 정규화 차트, 기간 수익률, 일간 수익률 상관·누적 경로 상관 행렬을 계산한다. 유사도·상관·상대 성과 질문에 사용.",
    input_schema: {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6, description: "회사명 또는 티커 2~6개" },
        from: { type: "string" }, to: { type: "string" }, lookbackDays: { type: "integer", description: "기본 365" },
      },
      required: ["symbols"],
    },
  },
  {
    name: "technical_indicators",
    description: "이동평균(SMA/EMA), RSI, MACD, 볼린저밴드, ATR, 고점 대비 낙폭을 계산해 최신 값과 신호(과매수/과매도, 골든·데드크로스, 밴드 위치)를 읽고 지표 패널 차트를 그린다.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string" }, lookbackDays: { type: "integer", description: "기본 365" }, to: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "event_study",
    description: "과거에 특정 조건(일간 수익률·갭·변동폭·거래량 배수·RSI·낙폭이 임계값 초과/미만)이 발생한 모든 날을 찾아 N거래일 후 수익률 분포(발생 횟수, 승률, 평균·중앙값, 최고·최악)를 무조건 기준선과 비교한다. '~했을 때 이후 어땠나' 질문용.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        feature: { type: "string", enum: ["return1d", "gap", "range", "volume20", "rsi14", "drawdown"] },
        operator: { type: "string", enum: ["gt", "lt"] },
        threshold: { type: "number", description: "% 단위(거래량은 배수, RSI는 0~100)" },
        horizonDays: { type: "integer", description: "이후 거래일 수. 기본 5" },
        lookbackDays: { type: "integer", description: "기본 1825 (5년)" },
      },
      required: ["symbol", "feature", "operator", "threshold"],
    },
  },
  {
    name: "backtest_strategy",
    description: "롱온리 규칙 전략을 실제 일봉으로 백테스트한다(신호는 종가, 체결은 다음 종가, 편도 비용 반영). 전략: sma_cross(fast/slow), momentum(period), rsi_reversal(period/entry/exit), breakout(lookback/exitLookback), buy_and_hold. 총수익·CAGR·샤프·MDD·승률·노출도와 자본곡선을 반환한다.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        strategy: { type: "string", enum: ["sma_cross", "momentum", "rsi_reversal", "breakout", "buy_and_hold"] },
        params: { type: "object", properties: { fast: { type: "integer" }, slow: { type: "integer" }, period: { type: "integer" }, entry: { type: "number" }, exit: { type: "number" }, lookback: { type: "integer" }, exitLookback: { type: "integer" } } },
        costBps: { type: "number", description: "편도 거래비용 bps. 기본 5" },
        lookbackDays: { type: "integer", description: "기본 1825" }, from: { type: "string" }, to: { type: "string" },
      },
      required: ["symbol", "strategy"],
    },
  },
  {
    name: "risk_profile",
    description: "자산(들)의 변동성, 베타, 벤치마크 상관, 샤프·소르티노, 최대낙폭, VaR/CVaR(95%), 하방편차를 계산한다. 여러 종목이면 비교 표를 만든다.",
    input_schema: {
      type: "object",
      properties: { symbols: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 }, benchmark: { type: "string", description: "기본 SPY" }, lookbackDays: { type: "integer", description: "기본 365" } },
      required: ["symbols"],
    },
  },
  {
    name: "seasonality",
    description: "월별·요일별 평균 수익률, 중앙값, 상승 확률을 여러 해에 걸쳐 계산한다.",
    input_schema: { type: "object", properties: { symbol: { type: "string" }, years: { type: "integer", description: "기본 10" } }, required: ["symbol"] },
  },
  {
    name: "largest_moves_with_news",
    description: "종목의 최대 하락(또는 상승)일을 찾고 각 날짜 전후의 실제 뉴스 헤드라인을 연결한다. 뉴스 회사를 따로 지정하면 그 회사 뉴스를 찾는다(예: ASTS 급락일의 SpaceX 뉴스).",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" }, newsCompany: { type: "string", description: "뉴스를 검색할 회사명. 기본은 symbol의 회사" },
        direction: { type: "string", enum: ["down", "up"] }, lookbackDays: { type: "integer", description: "기본 365" },
        eventCount: { type: "integer", description: "기본 3, 최대 8" }, newsWindowDays: { type: "integer", description: "기본 2" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "search_news",
    description: "Google News 헤드라인을 기간 내에서 검색한다(회사·테마·거시 키워드). 제목·매체·URL·시각만 반환하며 본문은 없다.",
    input_schema: { type: "object", properties: { query: { type: "string" }, from: { type: "string" }, to: { type: "string" }, limit: { type: "integer", description: "기본 12, 최대 25" } }, required: ["query"] },
  },
  {
    name: "get_quote",
    description: "현재가 스냅샷(토스증권 호가·체결·장 세션)과 최근 일봉 종가를 가져온다.",
    input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "market_calendar",
    description: "미국 주요 경제 일정(CPI, PPI, NFP, FOMC, PCE, GDP, ISM, JOLTS, ADP, 휴장)을 기간으로 조회한다.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, category: { type: "string", enum: ["fed", "inflation", "labor", "growth", "business", "market"] } } },
  },
  {
    name: "news_sentiment_tests",
    description: "News 화면에서 저장한 뉴스 감성 Test 행(기간, 감성 점수, 기술주/가치주 점수, 같은 기간 NASDAQ·NYSE 실제 수익률)과 결정론적 요약(평균, 부호 일치율, 상관)을 불러온다.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "show_chart",
    description: "TradingView 인터랙티브 차트를 Canvas에 띄운다. 사용자가 '차트 띄워줘/보여줘'라고만 하면 이 도구를 쓰고, 계산이 필요하면 get_price_history를 함께 쓴다.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        interval: { type: "string", enum: ["5", "15", "60", "240", "D", "W", "M"], description: "기본 D" },
        studies: { type: "array", items: { type: "string", enum: ["RSI", "MACD", "BB", "SMA", "EMA", "Volume", "VWAP", "StochasticRSI"] } },
      },
      required: ["symbol"],
    },
  },
  {
    name: "propose_strategy",
    description: "탑다운 가설에서 출발한 백테스트 전략 사양을 만든다. 순서: thesis(거시·구조적 논제) → mechanism(초과수익이 생기는 이유) → prediction(규칙이 맞다면 관측될 것) → falsification(무엇이 나오면 기각) → 기계적 entry/exit 규칙. 사용자가 전략을 만들어 달라고 하거나 대화가 매매 규칙으로 수렴하면 호출한다. 결과는 Canvas 카드로 표시되고, 사용자가 원하면 save_strategy로 Backtest 화면에 저장한다. 조건의 left/right는 {kind, period} 또는 {kind:'value', value}. kind: close, open, high, low, volume, sma, ema, rsi, macd_hist, macd_line, return(N일 %), drawdown(%), volume_ratio, bb_pos(0~1), atr_pct, highest_close, lowest_close, volatility. op: >, <, >=, <=, cross_above, cross_below.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        hypothesis: { type: "object", properties: { thesis: { type: "string" }, mechanism: { type: "string" }, prediction: { type: "string" }, falsification: { type: "string" } }, required: ["thesis", "mechanism", "prediction", "falsification"] },
        universe: { type: "array", items: { type: "string" }, description: "티커 1~12개" },
        benchmark: { type: "string", description: "기본 SPY" },
        entry: { type: "array", items: { type: "object", properties: { left: { type: "object" }, op: { type: "string", enum: [">", "<", ">=", "<=", "cross_above", "cross_below"] }, right: { type: "object" } }, required: ["left", "op", "right"] }, description: "모두 충족 시 진입" },
        exit: { type: "array", items: { type: "object", properties: { left: { type: "object" }, op: { type: "string" }, right: { type: "object" } }, required: ["left", "op", "right"] }, description: "하나라도 충족 시 청산" },
        holding: { type: "object", properties: { maxSessions: { type: "integer" }, stopLossPct: { type: "number" }, takeProfitPct: { type: "number" } } },
        costBps: { type: "number" },
        period: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
        successCriteria: { type: "object", properties: { minSharpe: { type: "number" }, minExcessCagrPct: { type: "number" }, maxDrawdownPct: { type: "number" }, minTrades: { type: "integer" }, minWinRatePct: { type: "number" } }, description: "통과 기준. 반증 조건을 숫자로 번역" },
        preset: { type: "string", enum: ["sma_cross", "momentum", "rsi_reversal", "breakout"], description: "entry/exit 대신 프리셋을 쓸 때" },
        presetParams: { type: "object", properties: { fast: { type: "integer" }, slow: { type: "integer" }, period: { type: "integer" }, entry: { type: "number" }, exit: { type: "number" }, lookback: { type: "integer" }, exitLookback: { type: "integer" } } },
        runNow: { type: "boolean", description: "true면 제안과 동시에 백테스트 실행" },
      },
      required: ["name", "hypothesis", "universe"],
    },
  },
  {
    name: "save_strategy",
    description: "propose_strategy로 만든 전략(또는 수정한 사양)을 Backtest 화면에 저장한다. 사용자가 저장·Backtest에 추가·만들자 등으로 동의했을 때만 호출한다. runNow=true면 저장 직후 백테스트를 실행하고 결과 카드를 만든다.",
    input_schema: { type: "object", properties: { spec: { type: "object", description: "propose_strategy 입력과 같은 형식의 전략 사양" }, runNow: { type: "boolean" } }, required: ["spec"] },
  },
  {
    name: "run_strategy_backtest",
    description: "저장된 전략 id 또는 전략 사양을 실제 일봉으로 백테스트한다(신호 종가 → 다음 종가 체결, 편도 비용, 동일가중 유니버스, 인/아웃오브샘플 분리, 파라미터 교란 견고성, 통과 기준 판정). 저장된 전략이면 결과와 상태가 Backtest 화면에 기록된다.",
    input_schema: { type: "object", properties: { strategyId: { type: "string" }, spec: { type: "object" } } },
  },
  {
    name: "list_strategies",
    description: "Backtest 화면에 저장된 전략 목록과 최근 결과·상태(가설/백테스트 완료/시그널 후보/기각/페이퍼/실거래)를 불러온다.",
    input_schema: { type: "object", properties: {} },
  },
];

const STUDY_IDS: Record<string, string> = {
  RSI: "RSI@tv-basicstudies", MACD: "MACD@tv-basicstudies", BB: "BB@tv-basicstudies", SMA: "MASimple@tv-basicstudies", EMA: "MAExp@tv-basicstudies", Volume: "Volume@tv-basicstudies", VWAP: "VWAP@tv-basicstudies", StochasticRSI: "StochasticRSI@tv-basicstudies",
};

type Input = Record<string, unknown>;

async function priceHistory(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const { from, to } = windowFor(input, context.today);
  const loaded = await loadAsset(String(input.symbol ?? ""), from, to);
  if ("error" in loaded) {
    return { result: { available: false, reason: loaded.error, asset: loaded.asset }, artifacts: [limitation(`${loaded.asset.name} 가격 데이터 없음`, loaded.error, ["티커를 직접 지정", "상장된 대체 종목 지정"])], trace: { name: "get_price_history", label: "가격 이력", status: "failed", detail: loaded.error } };
  }
  const rows = loaded.rows;
  const closes = rows.map((row) => row.close);
  const requested = Array.isArray(input.overlays) ? (input.overlays as string[]) : rows.length > 120 ? ["sma50", "sma200"] : ["sma20"];
  const overlays = requested.flatMap((name, index) => {
    const color = OVERLAY_COLORS[(index + 1) % OVERLAY_COLORS.length];
    if (name === "sma20") return [{ name: "SMA 20", values: sma(closes, 20), color }];
    if (name === "sma50") return [{ name: "SMA 50", values: sma(closes, 50), color }];
    if (name === "sma200") return [{ name: "SMA 200", values: sma(closes, 200), color }];
    if (name === "ema21") return [{ name: "EMA 21", values: ema(closes, 21), color }];
    if (name === "bollinger") { const band = bollinger(closes); return [{ name: "BB 상단", values: band.upper, color: "#9b9ba1", dashed: true }, { name: "BB 하단", values: band.lower, color: "#9b9ba1", dashed: true }]; }
    return [];
  });
  const stats = summaryStats(rows)!;
  const trailing = trailingReturns(rows);
  const artifact: LabArtifact = {
    id: id(), type: "price-chart", title: `${loaded.asset.name} (${loaded.asset.symbol}) 가격`, symbol: loaded.asset.symbol!, name: loaded.asset.name,
    period: { from: rows[0].date, to: rows.at(-1)!.date, sessions: rows.length }, bars: compactBars(rows), overlays,
    stats: { "기간 수익률": stats.returnPct, CAGR: stats.cagrPct, "연변동성": stats.annualizedVolatilityPct, "샤프": stats.sharpe, "최대낙폭": stats.maxDrawdownPct, "상승일 비율": stats.upDayRatePct },
    trailing, notes: [`조정 종가 · 데이터: ${loaded.origin}`, ...(loaded.reason ? [loaded.reason] : []), ...(loaded.asset.note ? [loaded.asset.note] : [])],
  };
  return {
    result: { asset: loaded.asset, stats, trailing, latest: compactBars(rows.slice(-5)), dataOrigin: loaded.origin },
    artifacts: [artifact],
    trace: { name: "get_price_history", label: `${loaded.asset.symbol} 가격 이력`, status: "complete", detail: `${rows.length}개 거래일 · ${rows[0].date} → ${rows.at(-1)!.date}` },
  };
}

async function compareAssets(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const queries = (Array.isArray(input.symbols) ? input.symbols : []).map(String).slice(0, 6);
  const { from, to } = windowFor(input, context.today);
  const loaded = await Promise.all(queries.map((query) => loadAsset(query, from, to)));
  const usable = loaded.filter((item): item is Loaded => !("error" in item));
  const failed = loaded.filter((item): item is { asset: ResolvedSymbol; error: string } => "error" in item);
  const artifacts: LabArtifact[] = failed.map((item) => limitation(`${item.asset.name} 비교 제한`, item.error, ["상장된 비교 종목 지정", "비상장사는 뉴스 이벤트로 상장 종목 반응을 비교"]));
  if (usable.length < 2) {
    const reason = failed.map((item) => item.error).join(" ") || "비교할 종목이 2개 미만입니다.";
    return { result: { available: false, reason, failed: failed.map((item) => item.asset) }, artifacts, trace: { name: "compare_assets", label: "자산 비교", status: "failed", detail: reason } };
  }
  const aligned = alignSeries(usable.map((item) => ({ key: item.asset.symbol!, rows: item.rows })));
  if (aligned.dates.length < 20) {
    const reason = `공통 거래일이 ${aligned.dates.length}개뿐이라 비교할 수 없습니다.`;
    return { result: { available: false, reason }, artifacts, trace: { name: "compare_assets", label: "자산 비교", status: "failed", detail: reason } };
  }
  const series = usable.map((item) => {
    const closes = aligned.closes[item.asset.symbol!];
    const normalized = normalizeTo100(closes);
    return { symbol: item.asset.symbol!, name: item.asset.name, returnPct: round((closes.at(-1)! / closes[0] - 1) * 100), points: aligned.dates.map((date, index) => ({ date, value: round(normalized[index])! })) };
  });
  const correlations: Array<{ left: string; right: string; returnCorrelation: number | null; pathCorrelation: number | null }> = [];
  for (let left = 0; left < series.length; left += 1) {
    for (let right = left + 1; right < series.length; right += 1) {
      const leftReturns = dailyReturns(aligned.dates.map((date, index) => ({ date, close: aligned.closes[series[left].symbol][index] })));
      const rightReturns = dailyReturns(aligned.dates.map((date, index) => ({ date, close: aligned.closes[series[right].symbol][index] })));
      correlations.push({ left: series[left].symbol, right: series[right].symbol, returnCorrelation: round(correlation(leftReturns, rightReturns)), pathCorrelation: round(correlation(series[left].points.map((point) => point.value), series[right].points.map((point) => point.value))) });
    }
  }
  const artifact: LabArtifact = {
    id: id(), type: "price-comparison", title: `${series.map((item) => item.symbol).join(" vs ")} 정규화 비교`, period: { from: aligned.dates[0], to: aligned.dates.at(-1)!, sessions: aligned.dates.length },
    series, correlations, notes: ["첫 공통 거래일 종가 = 100", "수익률 상관은 일간 방향 동조, 경로 상관은 누적 모양 유사성", `데이터: ${usable.map((item) => `${item.asset.symbol}·${item.origin}`).join(", ")}`],
  };
  return {
    result: { period: artifact.period, series: series.map(({ symbol, name, returnPct }) => ({ symbol, name, returnPct })), correlations, excluded: failed.map((item) => ({ name: item.asset.name, reason: item.error })) },
    artifacts: [...artifacts, artifact],
    trace: { name: "compare_assets", label: `${series.map((item) => item.symbol).join(" vs ")}`, status: "complete", detail: `${aligned.dates.length}개 공통 거래일` },
  };
}

async function technicalIndicators(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const { from, to } = windowFor(input, context.today, 365);
  const loaded = await loadAsset(String(input.symbol ?? ""), shiftDate(from, -300), to);
  if ("error" in loaded) return { result: { available: false, reason: loaded.error }, artifacts: [], trace: { name: "technical_indicators", label: "기술 지표", status: "failed", detail: loaded.error } };
  const rows = loaded.rows;
  const closes = rows.map((row) => row.close);
  const sma20 = sma(closes, 20); const sma50 = sma(closes, 50); const sma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14); const macdSeries = macd(closes); const band = bollinger(closes);
  const startIndex = Math.max(0, rows.findIndex((row) => row.date >= from));
  const slice = <T,>(values: T[]) => values.slice(startIndex);
  const last = rows.length - 1;
  const value = (series: Array<number | null>) => series[last];
  const prior = (series: Array<number | null>) => series[last - 1];
  const readings: Array<{ label: string; value: string; tone: "positive" | "negative" | "neutral" }> = [];
  const currentRsi = value(rsi14);
  if (currentRsi !== null) readings.push({ label: "RSI(14)", value: currentRsi.toFixed(1), tone: currentRsi >= 70 ? "negative" : currentRsi <= 30 ? "positive" : "neutral" });
  const macdNow = value(macdSeries.histogram); const macdPrior = prior(macdSeries.histogram);
  if (macdNow !== null && macdPrior !== null) readings.push({ label: "MACD 히스토그램", value: `${macdNow >= 0 ? "+" : ""}${macdNow.toFixed(3)}${Math.sign(macdNow) !== Math.sign(macdPrior) ? " · 교차" : ""}`, tone: macdNow >= 0 ? "positive" : "negative" });
  const priceVs = (name: string, series: Array<number | null>) => { const level = value(series); if (level !== null) readings.push({ label: `종가 vs ${name}`, value: `${(((closes[last] / level) - 1) * 100).toFixed(2)}%`, tone: closes[last] >= level ? "positive" : "negative" }); };
  priceVs("SMA 20", sma20); priceVs("SMA 50", sma50); priceVs("SMA 200", sma200);
  const fast = value(sma50); const slow = value(sma200); const fastPrior = prior(sma50); const slowPrior = prior(sma200);
  if (fast !== null && slow !== null) readings.push({ label: "SMA 50/200", value: fast > slow ? "골든크로스 상태" : "데드크로스 상태", tone: fast > slow ? "positive" : "negative" });
  const bandPosition = value(band.upper) !== null && value(band.lower) !== null ? (closes[last] - value(band.lower)!) / (value(band.upper)! - value(band.lower)!) : null;
  if (bandPosition !== null) readings.push({ label: "볼린저 위치", value: `${(bandPosition * 100).toFixed(0)}% (0=하단, 100=상단)`, tone: bandPosition > 1 ? "negative" : bandPosition < 0 ? "positive" : "neutral" });
  const crossRecent = fast !== null && slow !== null && fastPrior !== null && slowPrior !== null && Math.sign(fast - slow) !== Math.sign(fastPrior - slowPrior);
  const artifact: LabArtifact = {
    id: id(), type: "indicator-panel", title: `${loaded.asset.symbol} 기술 지표`, symbol: loaded.asset.symbol!, period: { from: rows[startIndex].date, to: rows[last].date },
    dates: slice(rows).map((row) => row.date), close: slice(closes).map((close) => round(close, 4)!),
    overlays: [
      { name: "SMA 20", values: slice(sma20), color: "#9a62da" }, { name: "SMA 50", values: slice(sma50), color: "#d88700" }, { name: "SMA 200", values: slice(sma200), color: "#18864b" },
      { name: "BB 상단", values: slice(band.upper), color: "#9b9ba1", dashed: true }, { name: "BB 하단", values: slice(band.lower), color: "#9b9ba1", dashed: true },
    ],
    panels: [
      { name: "RSI (14)", lines: [{ name: "RSI", values: slice(rsi14), color: "#087aff" }], bands: [{ value: 70, label: "과매수" }, { value: 30, label: "과매도" }] },
      { name: "MACD (12,26,9)", lines: [{ name: "MACD", values: slice(macdSeries.line), color: "#087aff" }, { name: "Signal", values: slice(macdSeries.signal), color: "#d88700" }], histogram: slice(macdSeries.histogram) },
    ],
    readings, notes: ["신호는 사후 확인용 스크리닝 지표이며 예측력을 보장하지 않음", `데이터: ${loaded.origin}`],
  };
  return {
    result: { asset: loaded.asset, asOf: rows[last].date, close: round(closes[last], 4), readings, latest: { sma20: round(value(sma20), 4), sma50: round(value(sma50), 4), sma200: round(value(sma200), 4), rsi14: round(currentRsi, 2), macd: round(value(macdSeries.line), 4), macdSignal: round(value(macdSeries.signal), 4), bollingerUpper: round(value(band.upper), 4), bollingerLower: round(value(band.lower), 4) }, goldenDeadCrossToday: crossRecent },
    artifacts: [artifact],
    trace: { name: "technical_indicators", label: `${loaded.asset.symbol} 기술 지표`, status: "complete", detail: readings.slice(0, 2).map((reading) => `${reading.label} ${reading.value}`).join(" · ") },
  };
}

async function runEventStudy(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const { from, to } = windowFor(input, context.today, 1825);
  const loaded = await loadAsset(String(input.symbol ?? ""), from, to);
  if ("error" in loaded) return { result: { available: false, reason: loaded.error }, artifacts: [], trace: { name: "event_study", label: "이벤트 스터디", status: "failed", detail: loaded.error } };
  const feature = (["return1d", "gap", "range", "volume20", "rsi14", "drawdown"].includes(String(input.feature)) ? input.feature : "return1d") as EventFeature;
  const operator = (input.operator === "lt" ? "lt" : "gt") as EventOperator;
  const threshold = Number(input.threshold) || 0;
  const horizon = Math.min(252, Math.max(1, Number(input.horizonDays) || 5));
  const study = eventStudy(loaded.rows, feature, operator, threshold, horizon);
  const condition = `${EVENT_FEATURE_LABELS[feature]} ${operator === "gt" ? ">" : "<"} ${threshold}`;
  const artifact: LabArtifact = {
    id: id(), type: "event-study", title: `${loaded.asset.symbol} · ${condition} 이후 ${horizon}거래일`, symbol: loaded.asset.symbol!, period: { from: loaded.rows[0].date, to: loaded.rows.at(-1)!.date },
    condition, horizon,
    stats: { "발생": study.occurrences, "승률": study.positiveRatePct, "평균": study.averagePct, "중앙값": study.medianPct, "최고": study.bestPct, "최악": study.worstPct, "표준편차": study.stdDevPct, "기준선 평균": study.baselineAveragePct, "기준선 승률": study.baselinePositiveRatePct },
    distribution: study.distribution, events: study.events, notes: ["조건 발생일 종가 → N거래일 후 종가", "기준선은 같은 기간의 모든 N거래일 수익률", "표본이 작으면 결론을 유보"],
  };
  return { result: { asset: loaded.asset, ...study, period: artifact.period }, artifacts: [artifact], trace: { name: "event_study", label: `${loaded.asset.symbol} 이벤트 스터디`, status: "complete", detail: `${study.occurrences}회 발생 · 승률 ${study.positiveRatePct ?? "—"}%` } };
}

async function runBacktest(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const { from, to } = windowFor(input, context.today, 1825);
  const loaded = await loadAsset(String(input.symbol ?? ""), shiftDate(from, -320), to);
  if ("error" in loaded) return { result: { available: false, reason: loaded.error }, artifacts: [], trace: { name: "backtest_strategy", label: "백테스트", status: "failed", detail: loaded.error } };
  const strategy = (Object.keys(STRATEGY_LABELS).includes(String(input.strategy)) ? input.strategy : "sma_cross") as StrategyId;
  const params = input.params && typeof input.params === "object" ? input.params as Record<string, number> : {};
  const costBps = Math.max(0, Number(input.costBps) || 5);
  // Warm-up bars before `from` feed the indicators; the equity curve itself starts at `from`.
  const warm = loaded.rows;
  const startIndex = Math.max(0, warm.findIndex((row) => row.date >= from));
  const result = backtestStrategy(warm, strategy, params, costBps);
  if (!result) return { result: { available: false, reason: "백테스트에 필요한 거래일이 부족합니다." }, artifacts: [], trace: { name: "backtest_strategy", label: "백테스트", status: "failed", detail: "거래일 부족" } };
  const curve = result.equityCurve.slice(startIndex);
  const base = curve[0];
  const rebased = curve.map((point) => ({ date: point.date, strategy: round((point.strategy / base.strategy) * 100)!, benchmark: round((point.benchmark / base.benchmark) * 100)! }));
  const artifact: LabArtifact = {
    id: id(), type: "backtest", title: `${loaded.asset.symbol} · ${STRATEGY_LABELS[strategy]}`, symbol: loaded.asset.symbol!, strategy: STRATEGY_LABELS[strategy],
    period: { from: rebased[0].date, to: rebased.at(-1)!.date, sessions: rebased.length },
    metrics: { "총수익": result.metrics.totalReturnPct, "매수보유": result.metrics.benchmarkReturnPct, CAGR: result.metrics.cagrPct, "샤프": result.metrics.sharpe, "매수보유 샤프": result.metrics.benchmarkSharpe, "최대낙폭": result.metrics.maxDrawdownPct, "매수보유 MDD": result.metrics.benchmarkMaxDrawdownPct, "거래": result.metrics.trades, "승률": result.metrics.winRatePct, "노출": result.metrics.exposurePct },
    equityCurve: rebased, trades: result.trades, notes: [`파라미터 ${JSON.stringify({ ...params })} · 비용 ${costBps}bps 편도`, "신호 종가 → 다음 종가 체결 · 롱온리 · 배당 미반영", "과최적화·생존편향 주의: 파라미터를 바꿔 견고성을 확인"],
  };
  return { result: { asset: loaded.asset, strategy, strategyLabel: STRATEGY_LABELS[strategy], params, costBps, period: artifact.period, metrics: result.metrics, recentTrades: result.trades.slice(-8) }, artifacts: [artifact], trace: { name: "backtest_strategy", label: `${loaded.asset.symbol} ${STRATEGY_LABELS[strategy]}`, status: "complete", detail: `총수익 ${result.metrics.totalReturnPct}% vs 매수보유 ${result.metrics.benchmarkReturnPct}%` } };
}

async function riskTable(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const queries = (Array.isArray(input.symbols) ? input.symbols : []).map(String).slice(0, 8);
  const { from, to } = windowFor(input, context.today, 365);
  const benchmarkQuery = String(input.benchmark || "SPY");
  const [benchmark, ...assets] = await Promise.all([loadAsset(benchmarkQuery, from, to), ...queries.map((query) => loadAsset(query, from, to))]);
  const benchmarkRows = "error" in benchmark ? null : benchmark.rows;
  const rows = assets.flatMap((item) => {
    if ("error" in item) return [];
    const profile = riskProfile(item.rows, benchmarkRows);
    return profile ? [{ symbol: item.asset.symbol!, name: item.asset.name, ...profile }] : [];
  });
  if (!rows.length) { const reason = assets.map((item) => "error" in item ? item.error : "").filter(Boolean).join(" "); return { result: { available: false, reason }, artifacts: [], trace: { name: "risk_profile", label: "리스크", status: "failed", detail: reason } }; }
  const columns = ["종목", "수익률 %", "연변동성 %", "베타", "상관", "샤프", "소르티노", "MDD %", "VaR95 일간 %", "CVaR95 %"];
  const artifact: LabArtifact = {
    id: id(), type: "table", title: `리스크 프로파일 · ${rows.map((row) => row.symbol).join(", ")}`, subtitle: `${from} → ${to} · 벤치마크 ${"error" in benchmark ? "없음" : benchmark.asset.symbol}`,
    columns, rows: rows.map((row) => [row.symbol, row.returnPct, row.annualizedVolatilityPct, row.beta, row.benchmarkCorrelation, row.sharpe, row.sortino, row.maxDrawdownPct, row.var95DailyPct, row.cvar95DailyPct]),
    notes: ["일간 수익률 기반 · 무위험수익률 0 가정", "베타·상관은 벤치마크와 공통 거래일로 계산"],
  };
  return { result: { period: { from, to }, benchmark: "error" in benchmark ? null : benchmark.asset.symbol, assets: rows }, artifacts: [artifact], trace: { name: "risk_profile", label: "리스크 프로파일", status: "complete", detail: `${rows.length}개 자산` } };
}

async function seasonalityTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const years = Math.min(20, Math.max(2, Number(input.years) || 10));
  const loaded = await loadAsset(String(input.symbol ?? ""), shiftDate(context.today, -365 * years), context.today);
  if ("error" in loaded) return { result: { available: false, reason: loaded.error }, artifacts: [], trace: { name: "seasonality", label: "계절성", status: "failed", detail: loaded.error } };
  const result = seasonality(loaded.rows);
  const artifact: LabArtifact = { id: id(), type: "seasonality", title: `${loaded.asset.symbol} 계절성 (${result.years}년)`, symbol: loaded.asset.symbol!, years: result.years, monthly: result.monthly, weekday: result.weekday, notes: ["월별은 월말 종가 대비 월말 종가", "표본 수가 작은 달은 노이즈가 큼"] };
  return { result: { asset: loaded.asset, ...result }, artifacts: [artifact], trace: { name: "seasonality", label: `${loaded.asset.symbol} 계절성`, status: "complete", detail: `${result.years}년 표본` } };
}

async function largestMovesWithNews(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const { from, to } = windowFor(input, context.today, 365);
  const loaded = await loadAsset(String(input.symbol ?? ""), from, to);
  if ("error" in loaded) return { result: { available: false, reason: loaded.error }, artifacts: [limitation(`${loaded.asset.name} 데이터 없음`, loaded.error, ["상장 종목 지정"])], trace: { name: "largest_moves_with_news", label: "급등락·뉴스", status: "failed", detail: loaded.error } };
  const direction = input.direction === "up" ? "up" : "down";
  const count = Math.min(8, Math.max(1, Number(input.eventCount) || 3));
  const windowDays = Math.min(7, Math.max(1, Number(input.newsWindowDays) || 2));
  const company = String(input.newsCompany || loaded.asset.name);
  const moves = findLargestMoves(loaded.rows, count, direction);
  const events = await Promise.all(moves.map(async (move) => ({ date: move.date, returnPct: round(move.returnPct)!, close: round(move.close, 4)!, news: await findCompanyNews(company, move.date, windowDays).catch(() => []) })));
  const artifact: LabArtifact = {
    id: id(), type: "drawdown-news", title: `${loaded.asset.symbol} ${direction === "down" ? "급락" : "급등"}일과 ${company} 뉴스`, symbol: loaded.asset.symbol!, company, period: { from: loaded.rows[0].date, to: loaded.rows.at(-1)!.date }, events,
    notes: [`종가 대비 종가 ${direction === "down" ? "하락" : "상승"}률 상위 ${count}일`, `뉴스는 각 날짜 ±${windowDays}일 Google News 검색`, "동시 발생은 인과관계를 증명하지 않음"],
  };
  return { result: { asset: loaded.asset, company, events: events.map((event) => ({ ...event, news: event.news.slice(0, 5) })) }, artifacts: [artifact], trace: { name: "largest_moves_with_news", label: `${loaded.asset.symbol} ${direction === "down" ? "급락" : "급등"}일`, status: "complete", detail: `${events.length}일 · 뉴스 ${events.reduce((sum, event) => sum + event.news.length, 0)}건` } };
}

async function newsSearch(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const query = String(input.query ?? "").trim();
  const { from, to } = windowFor(input, context.today, 14);
  const limit = Math.min(25, Math.max(1, Number(input.limit) || 12));
  const items = await searchNews(query, from, shiftDate(to, 1), limit).catch(() => []);
  const artifact: LabArtifact = { id: id(), type: "news-list", title: `뉴스 · ${query}`, query, period: { from, to }, items, notes: ["Google News RSS · 제목과 매체만 수집", "본문은 확인하지 않았으므로 헤드라인 근거로만 사용"] };
  return { result: { query, period: { from, to }, count: items.length, items }, artifacts: items.length ? [artifact] : [], trace: { name: "search_news", label: `뉴스 검색 · ${query}`, status: items.length ? "complete" : "failed", detail: items.length ? `${items.length}건` : "검색 결과 없음" } };
}

async function quote(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const asset = await resolveSymbol(String(input.symbol ?? ""));
  if (!asset.public || !asset.symbol) return { result: { available: false, reason: asset.note }, artifacts: [], trace: { name: "get_quote", label: "현재가", status: "failed", detail: asset.note ?? "종목 확인 실패" } };
  const [snapshot, daily] = await Promise.all([fetchTossSnapshot(asset.symbol), loadDailyRows(asset.symbol, shiftDate(context.today, -14), context.today)]);
  const last = daily.rows.at(-1);
  const previous = daily.rows.at(-2);
  return {
    result: { asset, broker: snapshot, lastDaily: last ? { ...last, changePct: previous ? round((last.close / previous.close - 1) * 100) : null } : null, dataOrigin: daily.origin },
    artifacts: [], trace: { name: "get_quote", label: `${asset.symbol} 현재가`, status: snapshot.available || last ? "complete" : "failed", detail: snapshot.available ? `${snapshot.currency ?? "USD"} ${snapshot.price} · ${snapshot.session?.label ?? ""}` : last ? `일봉 종가 ${last.close} (${last.date})` : "시세 없음" },
  };
}

function calendar(input: Input, context: ToolContext): ToolOutcome {
  const from = isDate(input.from) ? input.from : context.today;
  const to = isDate(input.to) ? input.to : shiftDate(from, 30);
  const category = typeof input.category === "string" ? input.category : null;
  const events = MARKET_EVENT_CALENDAR.filter((event) => event.date >= from && event.date <= to && (!category || event.category === category)).map((event) => ({ date: event.date, time: event.time, title: event.title, category: MARKET_EVENT_CATEGORY_LABELS[event.category], importance: event.importance, note: event.note }));
  const artifact: LabArtifact = { id: id(), type: "calendar", title: `경제 일정 ${from} → ${to}`, period: { from, to }, events, notes: ["시각은 미국 동부(ET)", "출처: BLS·BEA·Fed·ISM·NYSE 공식 일정"] };
  return { result: { period: { from, to }, count: events.length, events }, artifacts: events.length ? [artifact] : [], trace: { name: "market_calendar", label: "경제 일정", status: "complete", detail: `${events.length}개 일정` } };
}

function parseJson(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

async function sentimentTests(_input: Input, context: ToolContext): Promise<ToolOutcome> {
  try {
    await ensureSchema();
    const rows = await getDb().select().from(newsTests).where(eq(newsTests.ownerId, context.ownerId)).orderBy(desc(newsTests.createdAt)).limit(100);
    const tests: ResearchTest[] = rows.reverse().map((row) => ({
      id: row.id, periodStart: row.periodStart, periodEnd: row.periodEnd, overallScore: row.overallScore, techScore: row.techScore, valueScore: row.valueScore,
      nasdaq: parseJson(row.nasdaqPayload) as ResearchTest["nasdaq"], nyse: parseJson(row.nysePayload) as ResearchTest["nyse"], forecastEvents: (parseJson(row.forecastPayload) as ResearchTest["forecastEvents"]) ?? [],
    }));
    const summary = deterministicTestSummary(tests);
    const artifact: LabArtifact = {
      id: id(), type: "table", title: "뉴스 감성 Test 기록", subtitle: `${summary.usableTests}/${summary.totalTests} usable · 부호 일치율 ${summary.signAlignmentRatePct === null ? "—" : `${summary.signAlignmentRatePct.toFixed(0)}%`} · r=${summary.sentimentReturnCorrelation === null ? "—" : summary.sentimentReturnCorrelation.toFixed(2)}`,
      columns: ["기간", "이벤트", "감성", "Tech−Value", "NASDAQ %", "NYSE %"],
      rows: summary.rows.map((row) => [row.range, row.event, row.sentiment, round(row.techMinusValue, 1), row.nasdaqReturnPct, row.nyseReturnPct]), notes: ["News 화면에서 저장한 Test · 지수 수익률은 같은 기간 첫 거래일 종가 → 마지막 거래일 종가"],
    };
    return { result: summary, artifacts: tests.length ? [artifact] : [], trace: { name: "news_sentiment_tests", label: "뉴스 감성 Test", status: "complete", detail: `${summary.usableTests}개 usable` } };
  } catch (error) {
    const reason = "Test 저장소에 연결하지 못했습니다.";
    console.error("[lab-tools] news tests", error instanceof Error ? error.message : error);
    return { result: { available: false, reason }, artifacts: [], trace: { name: "news_sentiment_tests", label: "뉴스 감성 Test", status: "failed", detail: reason } };
  }
}

async function showChart(input: Input): Promise<ToolOutcome> {
  const asset = await resolveSymbol(String(input.symbol ?? ""));
  if (!asset.public || !asset.symbol) return { result: { available: false, reason: asset.note }, artifacts: [limitation(`${asset.name} 차트 불가`, asset.note ?? "거래 가능 종목을 확인하지 못했습니다.", ["티커와 거래소 지정"])], trace: { name: "show_chart", label: "차트", status: "failed", detail: asset.note ?? "종목 확인 실패" } };
  const interval = typeof input.interval === "string" ? input.interval : "D";
  const studies = (Array.isArray(input.studies) ? input.studies as string[] : []).map((study) => STUDY_IDS[study]).filter(Boolean);
  const tradingView = asset.tradingView ?? `NASDAQ:${asset.symbol}`;
  const artifact: LabArtifact = { id: id(), type: "tradingview", title: `${asset.name} · TradingView ${interval}`, symbol: tradingView, interval, studies, notes: ["TradingView 무료 위젯 · 에이전트는 위젯 내부 데이터를 읽지 못함"] };
  return { result: { asset, tradingViewSymbol: tradingView, interval, studies }, artifacts: [artifact], trace: { name: "show_chart", label: `${asset.symbol} 차트`, status: "complete", detail: `${tradingView} · ${interval}` } };
}

function specFromToolInput(input: Input, context: ToolContext) {
  const raw: Record<string, unknown> = { ...(input.spec && typeof input.spec === "object" ? input.spec as Record<string, unknown> : input) };
  if (typeof raw.preset === "string" && !(Array.isArray(raw.entry) && raw.entry.length)) {
    const preset = presetConditions(raw.preset, (raw.presetParams as Record<string, number> | undefined) ?? {});
    raw.entry = preset.entry;
    raw.exit = preset.exit;
  }
  return normalizeSpec(raw, context.today);
}

function backtestArtifact(result: BacktestResult, strategyId: string | null): LabArtifact {
  const metrics = result.metrics;
  return {
    id: id(), type: "strategy-backtest", title: `백테스트 · ${result.spec.name}`, strategyId, strategyName: result.spec.name, verdict: result.verdict,
    period: result.period,
    metrics: { "총수익": metrics.totalReturnPct, "동일가중 매수보유": metrics.benchmarkReturnPct, [`${result.spec.benchmark}`]: metrics.marketReturnPct, CAGR: metrics.cagrPct, "초과 CAGR": metrics.excessCagrPct, "샤프": metrics.sharpe, "소르티노": metrics.sortino, "최대낙폭": metrics.maxDrawdownPct, "변동성": metrics.annualizedVolatilityPct, "거래": metrics.trades, "승률": metrics.winRatePct, "평균 거래": metrics.averageTradePct, "노출": metrics.exposurePct, "손익비": metrics.profitFactor },
    equityCurve: result.equityCurve,
    perSymbol: result.perSymbol.map((item) => ({ symbol: item.symbol, totalReturnPct: item.totalReturnPct, benchmarkReturnPct: item.benchmarkReturnPct, sharpe: item.sharpe, maxDrawdownPct: item.maxDrawdownPct, trades: item.trades, winRatePct: item.winRatePct, currentSignal: item.currentSignal })),
    robustness: { inSample: { from: result.robustness.inSample.from, to: result.robustness.inSample.to, cagrPct: result.robustness.inSample.cagrPct, sharpe: result.robustness.inSample.sharpe }, outOfSample: { from: result.robustness.outOfSample.from, to: result.robustness.outOfSample.to, cagrPct: result.robustness.outOfSample.cagrPct, sharpe: result.robustness.outOfSample.sharpe }, stabilityScore: result.robustness.stabilityScore },
    notes: ["신호 종가 → 다음 종가 체결 · 롱온리 · 동일가중 · 배당 미반영", `비용 ${result.spec.costBps}bps 편도 · 인샘플 70% / 아웃오브샘플 30%`, ...(result.missingSymbols.length ? [`제외: ${result.missingSymbols.map((item) => `${item.symbol}(${item.reason})`).join(", ")}`] : [])],
  };
}

function compactResult(result: BacktestResult) {
  return { period: result.period, metrics: result.metrics, verdict: result.verdict, robustness: { inSample: result.robustness.inSample, outOfSample: result.robustness.outOfSample, perturbations: result.robustness.perturbations, stabilityScore: result.robustness.stabilityScore }, perSymbol: result.perSymbol.map((item) => { const { equity, ...rest } = item; void equity; return rest; }), recentTrades: result.trades.slice(-10), missingSymbols: result.missingSymbols };
}

async function proposeStrategy(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const { spec, errors } = specFromToolInput(input, context);
  if (!spec) return { result: { ok: false, errors }, artifacts: [], trace: { name: "propose_strategy", label: "전략 제안", status: "failed", detail: errors.join(" ") } };
  const artifacts: LabArtifact[] = [{ id: id(), type: "strategy-proposal", title: `전략 제안 · ${spec.name}`, spec: spec as unknown as Record<string, unknown>, summary: describeSpec(spec), strategyId: null, status: null, notes: ["Backtest 화면에 저장하려면 카드의 버튼을 누르거나 JARVIS에게 저장을 요청", "가설 → 규칙 → 백테스트 → 반증 순서로 검증"] }];
  let run: ReturnType<typeof compactResult> | null = null;
  if (input.runNow) {
    const outcome = await backtestSpec(spec);
    if (outcome.result) { artifacts.push(backtestArtifact(outcome.result, null)); run = compactResult(outcome.result); }
  }
  return { result: { ok: true, spec, summary: describeSpec(spec), backtest: run, nextStep: "사용자에게 Backtest 화면에 저장할지 물어보고, 동의하면 save_strategy를 호출" }, artifacts, trace: { name: "propose_strategy", label: `전략 제안 · ${spec.name}`, status: "complete", detail: `${spec.universe.join(", ")} · ${describeSpec(spec).entry}` } };
}

async function saveStrategyTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const { spec, errors } = specFromToolInput(input, context);
  if (!spec) return { result: { ok: false, errors }, artifacts: [], trace: { name: "save_strategy", label: "전략 저장", status: "failed", detail: errors.join(" ") } };
  try {
    let stored = await saveStrategy(context.ownerId, spec, { sourceConversationId: context.conversationId ?? null });
    const artifacts: LabArtifact[] = [];
    let run: ReturnType<typeof compactResult> | null = null;
    if (input.runNow) {
      const outcome = await runAndRecord(context.ownerId, stored);
      if (outcome.result) { stored = outcome.strategy ?? stored; artifacts.push(backtestArtifact(outcome.result, stored.id)); run = compactResult(outcome.result); }
    }
    artifacts.unshift({ id: id(), type: "strategy-proposal", title: `저장됨 · ${spec.name}`, spec: spec as unknown as Record<string, unknown>, summary: describeSpec(spec), strategyId: stored.id, status: stored.status, notes: ["Backtest 화면에서 기간·비용을 바꿔 다시 실행하고 실거래 시그널을 확인할 수 있음"] });
    return { result: { ok: true, strategyId: stored.id, status: stored.status, statusLabel: STRATEGY_STATUS_LABELS[stored.status], backtest: run }, artifacts, trace: { name: "save_strategy", label: `전략 저장 · ${spec.name}`, status: "complete", detail: `Backtest에 저장 (${STRATEGY_STATUS_LABELS[stored.status]})` } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "전략 저장 실패";
    return { result: { ok: false, reason }, artifacts: [], trace: { name: "save_strategy", label: "전략 저장", status: "failed", detail: reason } };
  }
}

async function runStrategyTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  if (typeof input.strategyId === "string") {
    const stored = await getStrategy(context.ownerId, input.strategyId).catch(() => null);
    if (!stored) return { result: { ok: false, reason: "전략을 찾지 못했습니다." }, artifacts: [], trace: { name: "run_strategy_backtest", label: "백테스트", status: "failed", detail: "전략 없음" } };
    const outcome = await runAndRecord(context.ownerId, stored);
    if (!outcome.result) return { result: { ok: false, reason: "데이터 부족", missing: outcome.missing }, artifacts: [], trace: { name: "run_strategy_backtest", label: `백테스트 · ${stored.name}`, status: "failed", detail: outcome.missing.map((item) => item.reason).join(" ") } };
    return { result: { ok: true, strategyId: stored.id, status: outcome.strategy?.status, ...compactResult(outcome.result) }, artifacts: [backtestArtifact(outcome.result, stored.id)], trace: { name: "run_strategy_backtest", label: `백테스트 · ${stored.name}`, status: "complete", detail: `${outcome.result.verdict.status} · CAGR ${outcome.result.metrics.cagrPct}% vs ${outcome.result.metrics.benchmarkCagrPct}%` } };
  }
  const { spec, errors } = specFromToolInput(input, context);
  if (!spec) return { result: { ok: false, errors }, artifacts: [], trace: { name: "run_strategy_backtest", label: "백테스트", status: "failed", detail: errors.join(" ") } };
  const outcome = await backtestSpec(spec);
  if (!outcome.result) return { result: { ok: false, reason: "데이터 부족", missing: outcome.missing }, artifacts: [], trace: { name: "run_strategy_backtest", label: `백테스트 · ${spec.name}`, status: "failed", detail: outcome.missing.map((item) => item.reason).join(" ") } };
  return { result: { ok: true, ...compactResult(outcome.result) }, artifacts: [backtestArtifact(outcome.result, null)], trace: { name: "run_strategy_backtest", label: `백테스트 · ${spec.name}`, status: "complete", detail: `${outcome.result.verdict.status} · CAGR ${outcome.result.metrics.cagrPct}% vs ${outcome.result.metrics.benchmarkCagrPct}%` } };
}

async function listStrategiesTool(context: ToolContext): Promise<ToolOutcome> {
  try {
    const items = await listStrategies(context.ownerId);
    const rows = items.map((item) => ({ id: item.id, name: item.name, status: item.status, statusLabel: STRATEGY_STATUS_LABELS[item.status], universe: item.spec.universe, thesis: item.spec.hypothesis.thesis, entry: describeSpec(item.spec).entry, verdict: item.latestResult?.verdict.status ?? null, cagrPct: item.latestResult?.metrics.cagrPct ?? null, benchmarkCagrPct: item.latestResult?.metrics.benchmarkCagrPct ?? null, sharpe: item.latestResult?.metrics.sharpe ?? null, updatedAt: item.updatedAt }));
    const artifact: LabArtifact = { id: id(), type: "table", title: "저장된 전략", subtitle: `${rows.length}개`, columns: ["전략", "상태", "유니버스", "CAGR %", "벤치 CAGR %", "샤프", "판정"], rows: rows.map((row) => [row.name, row.statusLabel, row.universe.join(","), row.cagrPct, row.benchmarkCagrPct, row.sharpe, row.verdict ?? "—"]), notes: ["Backtest 화면과 동일한 데이터"] };
    return { result: rows, artifacts: rows.length ? [artifact] : [], trace: { name: "list_strategies", label: "저장된 전략", status: "complete", detail: `${rows.length}개` } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "전략 저장소 연결 실패";
    return { result: { ok: false, reason }, artifacts: [], trace: { name: "list_strategies", label: "저장된 전략", status: "failed", detail: reason } };
  }
}

export async function executeLabTool(name: string, input: unknown, context: ToolContext): Promise<ToolOutcome> {
  const args = (input && typeof input === "object" ? input : {}) as Input;
  switch (name) {
    case "resolve_symbols": {
      const resolved = await resolveSymbols((Array.isArray(args.queries) ? args.queries : []).map(String).slice(0, 10));
      return { result: resolved, artifacts: [], trace: { name, label: "심볼 해석", status: "complete", detail: resolved.map((item) => item.symbol ?? `${item.name}(미확인)`).join(", ") } };
    }
    case "get_price_history": return priceHistory(args, context);
    case "compare_assets": return compareAssets(args, context);
    case "technical_indicators": return technicalIndicators(args, context);
    case "event_study": return runEventStudy(args, context);
    case "backtest_strategy": return runBacktest(args, context);
    case "risk_profile": return riskTable(args, context);
    case "seasonality": return seasonalityTool(args, context);
    case "largest_moves_with_news": return largestMovesWithNews(args, context);
    case "search_news": return newsSearch(args, context);
    case "get_quote": return quote(args, context);
    case "market_calendar": return calendar(args, context);
    case "news_sentiment_tests": return sentimentTests(args, context);
    case "show_chart": return showChart(args);
    case "propose_strategy": return proposeStrategy(args, context);
    case "save_strategy": return saveStrategyTool(args, context);
    case "run_strategy_backtest": return runStrategyTool(args, context);
    case "list_strategies": return listStrategiesTool(context);
    default: return { result: { error: `알 수 없는 도구 ${name}` }, artifacts: [], trace: { name, label: name, status: "failed", detail: "알 수 없는 도구" } };
  }
}

export const TOOL_LABELS: Record<string, string> = {
  resolve_symbols: "심볼 해석", get_price_history: "가격 이력", compare_assets: "자산 비교", technical_indicators: "기술 지표", event_study: "이벤트 스터디", backtest_strategy: "백테스트", risk_profile: "리스크 프로파일", seasonality: "계절성", largest_moves_with_news: "급등락·뉴스", search_news: "뉴스 검색", get_quote: "현재가", market_calendar: "경제 일정", news_sentiment_tests: "뉴스 감성 Test", show_chart: "TradingView 차트", propose_strategy: "전략 제안", save_strategy: "전략 저장", run_strategy_backtest: "전략 백테스트", list_strategies: "저장된 전략", web_search: "웹 검색",
};
