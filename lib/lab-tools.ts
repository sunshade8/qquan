import type Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { newsTests } from "@/db/schema";
import { MARKET_EVENT_CALENDAR, MARKET_EVENT_CATEGORY_LABELS } from "@/app/market-calendar-data";
import { findCompanyNews, searchNews } from "@/lib/company-news";
import type { LabArtifact, LabToolTrace } from "@/lib/lab-types";
import { fetchTossSnapshot, fetchYahooIntradayWindow, type IntradayInterval, type PriceRow } from "@/lib/market-data";
import { calculateIntradayReaction, summarizeIntradayStudy } from "@/lib/intraday-study";
import { runFvgBacktest, type FvgOptions } from "@/lib/intraday-fvg";
import { deterministicTestSummary, type ResearchTest } from "@/lib/news-research-agents";
import { loadDailyRows } from "@/lib/price-cache";
import {
  alignSeries, backtestStrategy, bollinger, correlation, dailyReturns, ema, eventStudy, findLargestMoves, macd, normalizeTo100, riskProfile, round, rsi, seasonality, sma, STRATEGY_LABELS, summaryStats, trailingReturns,
  type EventFeature, type EventOperator, type StrategyId, EVENT_FEATURE_LABELS,
} from "@/lib/quant";
import { resolveSymbol, resolveSymbols, type ResolvedSymbol } from "@/lib/symbols";
import { describeUniverses, resolveUniverse, UNIVERSE_IDS } from "@/lib/universe";
import {
  eventReactionStudy, pooledConditionalStudy, screenUniverse, sweepConditions, SCREEN_METRIC_LABELS, SCREEN_METRICS,
  type PooledCondition, type ScreenCandidate, type ScreenFilter, type ScreenMetric, type ScreenRank,
} from "@/lib/screener";
import { auditResult, interpretSweep, AUDIT_RISK_LABELS, AUDIT_VERDICT_LABELS } from "@/lib/lab-specialists";
import { challengeStrategy, describeChallengerPairing, RISK_LABELS, STRATEGY_VERDICT_LABELS, type StrategyChallenge } from "@/lib/challenger";
import { FINDING_CONFIDENCE_LABELS, FINDING_STATUS_LABELS } from "@/lib/findings";
import { EVENT_ROOTS, knownEventRoots, SURPRISE_BASIS_LABELS } from "@/lib/market-events";
import { listMarketEvents } from "@/lib/market-events-store";
import { listFindings, saveFinding } from "@/lib/findings-store";
import { describeSpec, normalizeSpec, presetConditions, type BacktestResult, type StrategySpec } from "@/lib/strategy";
import { backtestSpec, getStrategy, listStrategies, runAndRecord, saveStrategy, STRATEGY_STATUS_LABELS } from "@/lib/strategy-store";

export type ToolContext = { ownerId: string; today: string; conversationId?: string | null };
export type ToolOutcome = { result: unknown; artifacts: LabArtifact[]; trace: Omit<LabToolTrace, "id" | "startedAt" | "durationMs"> };

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Later of two ISO dates. Used to keep an intraday request inside the provider's window. */
function maxDate(left: string, right: string) {
  return left >= right ? left : right;
}

function daysBetween(from: string, to: string) {
  return Math.floor((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
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
    name: "intraday_event_study",
    description: "경제지표·실적·뉴스 이벤트의 정확한 날짜와 미국 동부시각(ET)을 기준으로 여러 자산의 발표 전/후 분봉 수익률을 계산한다. 기본 자산은 기술주 QQQ와 가치주 IWD, 기본 구간은 발표 전 30분·후 30분이다. 5분/15분 종가 경계로 계산하며 현재 Yahoo 공급 범위상 최근 약 60일만 보장한다. 이벤트 날짜·시각을 market_calendar 또는 web_search로 먼저 확인한 뒤 호출한다.",
    input_schema: {
      type: "object",
      properties: {
        events: {
          type: "array", minItems: 1, maxItems: 24,
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "YYYY-MM-DD" },
              timeET: { type: "string", description: "HH:mm 미국 동부시각" },
              label: { type: "string", description: "이벤트 이름" },
              actual: { type: "string", description: "실제 발표값(확인된 경우)" },
              consensus: { type: "string", description: "컨센서스(확인된 경우)" },
              surprise: { type: "string", enum: ["above", "below", "inline", "unknown"], description: "실제치의 예상 대비 분류" },
            },
            required: ["date", "timeET"],
          },
        },
        symbols: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4, description: "비교 자산. 기본 QQQ,IWD" },
        interval: { type: "string", enum: ["5m", "15m"], description: "분봉 주기. 기본 5m" },
        preMinutes: { type: "integer", minimum: 15, maximum: 120, description: "발표 전 계산 구간. 기본 30분" },
        postMinutes: { type: "integer", minimum: 15, maximum: 240, description: "발표 후 계산 구간. 기본 30분" },
      },
      required: ["events"],
    },
  },
  {
    name: "intraday_fvg_backtest",
    description: "분봉 OHLC로 '시가 레인지 돌파 + FVG(공정가치 갭) 되돌림' 인트라데이 규칙을 실제로 백테스트한다. 09:30 ET부터 anchorMinutes 동안의 고가·저가를 기준선으로 잡고, windowMinutes 안에서 상승 캔들의 몸통이 기준선을 상향 돌파하며 FVG가 형성되면, 그 FVG로 되돌림이 올 때 매수해 직전 캔들 저점을 손절, 손익비 rewardRisk를 익절로 삼는다(하루 1회, 롱 전용). FVG는 다음 봉이 마감돼야 확정되므로 진입은 그 이후 봉부터만 허용하고, 한 봉이 손절과 익절을 모두 덮으면 손절로 처리한다. 같은 실행에서 'FVG 조건 없이 돌파 확인봉 종가에 진입'하는 대조군도 함께 계산하므로, FVG가 실제 알파인지 장식인지 두 결과를 비교해 판정한다. 공급 한계상 최근 약 59일(거래일 약 40개)만 가능하므로 표본이 작다는 점을 반드시 함께 보고한다.",
    input_schema: {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "티커 1~3개" },
        interval: { type: "string", enum: ["5m", "15m"], description: "매매 분봉. 기본 5m" },
        anchorMinutes: { type: "integer", description: "09:30 ET부터 기준선을 만드는 시간(분). 기본 15" },
        windowMinutes: { type: "integer", description: "진입을 허용하는 오픈 이후 구간(분). 기본 90" },
        rewardRisk: { type: "number", description: "손익비. 기본 2 (1:2)" },
        holdUntil: { type: "string", enum: ["window", "session_close"], description: "익절·손절 미도달 시 청산 시점. 기본 session_close" },
        costBps: { type: "number", description: "편도 비용(bps). 왕복으로 반영. 기본 5" },
        lookbackDays: { type: "integer", description: "조회 기간(달력일). 기본 55, 최대 59" },
      },
      required: ["symbols"],
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
    description: `탑다운 가설에서 출발한 백테스트 전략 사양을 만든다. 순서: thesis(거시·구조적 논제) → mechanism(초과수익이 생기는 이유) → prediction(규칙이 맞다면 관측될 것) → falsification(무엇이 나오면 기각) → 기계적 entry/exit 규칙. 사용자가 전략을 만들어 달라고 하거나 대화가 매매 규칙으로 수렴하면 호출한다. 결과는 Canvas 카드로 표시되고, 사용자가 원하면 save_strategy로 Backtest 화면에 저장한다. 조건의 left/right는 {kind, period} 또는 {kind:'value', value}. kind: close, open, high, low, volume, sma, ema, rsi, macd_hist, macd_line, return(N일 %), drawdown(%), volume_ratio, bb_pos(0~1), atr_pct, highest_close, lowest_close, volatility, gap(당일 시가 갭 %), range(당일 고저 변동폭 %). gap과 range는 conditional_stats·sweep_conditions와 같은 정의이므로, 그 도구로 검증한 조건을 그대로 전략 규칙으로 옮길 수 있다. op: >, <, >=, <=, cross_above, cross_below.

이벤트 드리븐 규칙: News에서 찾은 경제지표 패턴을 전략으로 만들 때는 캘린더 오퍼랜드를 쓴다. kind에 sessions_to_event(다음 발표까지 거래일 수), sessions_since_event(직전 발표 이후 거래일 수), event_surprise(직전 발표 서프라이즈), event_surprise_z(z 정규화)를 지정하고 event 필드에 이벤트 루트를 반드시 넣는다. 예: 'CPI 발표 2거래일 전 진입, 발표 다음날 청산' → entry [{left:{kind:'sessions_to_event',event:'cpi'}, op:'<=', right:{kind:'value',value:2}}], exit [{left:{kind:'sessions_since_event',event:'cpi'}, op:'>=', right:{kind:'value',value:1}}]. event 없이 캘린더 오퍼랜드를 쓰면 사양이 거부된다. 사용 가능 루트는 market_events 도구로 확인한다.`,
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
        sourceFindingId: { type: "string", description: "이 전략이 기계화하는 연구 노트 id. 노트에서 출발했다면 반드시 넣는다 — 노트가 나중에 반증되면 이 전략도 함께 표시된다." },
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
  {
    name: "screen_universe",
    description: `종목을 '발견'하는 유일한 도구. 유니버스 전체를 훑어 조건에 맞는 종목을 지표 기준으로 순위 매긴다. 사용자가 종목을 지정하지 않고 "어떤 종목이", "~한 종목 찾아줘", "상위/하위", "가장 ~한" 같이 물으면 반드시 이 도구를 먼저 쓴다. 다른 모든 도구는 종목을 이미 알고 있어야 동작하므로, 후보 발굴은 여기서 시작한다.
사용 가능한 유니버스: ${describeUniverses().map((item) => `${item.id}(${item.label} ${item.count}종목)`).join(", ")}.
symbols로 티커를 직접 줄 수도 있다(반드시 티커여야 하며, 한국어 종목명이면 resolve_symbols로 먼저 변환한다).
지표: ${SCREEN_METRICS.map((metric) => `${metric}=${SCREEN_METRIC_LABELS[metric]}`).join(", ")}. period는 return/volatility/sharpe/drawdown 계열에서는 거래일 룩백, sma_distance·rsi14·volume_ratio에서는 지표 길이다.`,
    input_schema: {
      type: "object",
      properties: {
        universe: { type: "string", enum: [...UNIVERSE_IDS], description: "미리 정의된 유니버스 id. symbols를 주지 않으면 필수." },
        symbols: { type: "array", items: { type: "string" }, description: "티커 직접 지정 (최대 40). universe 대신 사용." },
        rankBy: {
          type: "object",
          properties: { metric: { type: "string", enum: [...SCREEN_METRICS] }, period: { type: "integer" }, direction: { type: "string", enum: ["desc", "asc"] } },
          required: ["metric"],
          description: "순위 기준. direction 기본 desc(높은 값 우선).",
        },
        filters: {
          type: "array", maxItems: 4,
          items: {
            type: "object",
            properties: { metric: { type: "string", enum: [...SCREEN_METRICS] }, period: { type: "integer" }, op: { type: "string", enum: ["gt", "lt", "gte", "lte"] }, value: { type: "number" } },
            required: ["metric", "op", "value"],
          },
          description: "선택 조건. 모두 만족하는 종목만 남는다.",
        },
        limit: { type: "integer", description: "반환 종목 수. 기본 15, 최대 40." },
        lookbackDays: { type: "integer", description: "불러올 일봉 기간(달력일). 기본 500. 긴 period를 쓰면 늘린다." },
      },
      required: ["rankBy"],
    },
  },
  {
    name: "conditional_stats",
    description: "유니버스 전체에 대해 '조건 X가 성립한 날 이후 N거래일 수익률'을 모아, 같은 기간의 무조건 수익률(베이스라인)과 비교한다. 단일 종목 event_study와 달리 여러 종목의 표본을 풀링하므로, 한 종목에서 3번 나온 패턴처럼 표본이 부족해 판단할 수 없는 경우를 해결한다. 가설을 숫자로 검증할 때 쓴다. t값도 함께 주지만 관측 구간이 겹치므로 참고용이다.",
    input_schema: {
      type: "object",
      properties: {
        universe: { type: "string", enum: [...UNIVERSE_IDS] },
        symbols: { type: "array", items: { type: "string" }, description: "티커 직접 지정 (최대 40)" },
        condition: {
          type: "object",
          properties: {
            metric: { type: "string", enum: ["return", "rsi14", "volatility", "volume_ratio", "drawdown", "sma_distance", "gap", "range"] },
            period: { type: "integer" },
            op: { type: "string", enum: ["gt", "lt"] },
            value: { type: "number" },
          },
          required: ["metric", "op", "value"],
        },
        horizonDays: { type: "integer", description: "이후 거래일 수. 기본 5" },
        lookbackDays: { type: "integer", description: "기본 1095 (3년)" },
      },
      required: ["condition"],
    },
  },
  {
    name: "save_finding",
    description: "검증된 리서치 결론을 연구 노트에 영구 저장한다. 대화는 사라지지만 노트는 다음 대화에 자동으로 다시 불려온다. 도구로 숫자를 확인해 의미 있는 결론에 도달했을 때 호출한다. claim은 숫자를 포함한 완결된 문장, evidence는 어떤 도구가 어떤 값을 냈는지, falsification은 이 결론이 틀렸다면 무엇이 관측될지를 적는다. 기존 노트를 갱신하려면 id를 함께 준다(반증됐으면 status를 refuted로).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "기존 노트 갱신 시에만" },
        title: { type: "string", description: "짧은 제목" },
        claim: { type: "string", description: "숫자와 기간을 포함한 결론 문장" },
        evidence: {
          type: "array",
          description: "근거. 나중에 재검증할 수 있도록 도구와 입력을 함께 남긴다. 형식: {kind:'tool_run', tool:'conditional_stats', input:{...}, summary:'...'} 또는 {kind:'news_test', ref:'<testId>', summary:'...'} 또는 {kind:'note', summary:'...'}",
          items: { type: "object" },
        },
        eventRoots: { type: "array", items: { type: "string", enum: [...knownEventRoots()] }, description: "이 결론이 어떤 경제 이벤트에 대한 것인지. News·전략과 조인되는 키다." },
        symbols: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        status: { type: "string", enum: ["open", "confirmed", "refuted", "stale"] },
        falsification: { type: "string", description: "어떤 결과가 나오면 이 결론을 버리는가" },
      },
      required: ["title", "claim", "evidence"],
    },
  },
  {
    name: "list_findings",
    description: "저장된 연구 노트를 최신순으로 불러온다. 매 턴 시작 시 관련 노트가 자동 주입되지만, 전체 목록을 보거나 과거 결론을 재확인할 때 호출한다.",
    input_schema: { type: "object", properties: { limit: { type: "integer", description: "기본 20" } } },
  },
  {
    name: "sweep_conditions",
    description: "하나의 조건을 임계값 × 기간 그리드 전체에 대해 돌려, 효과가 실재하는지 아니면 한 칸의 우연인지 본다. conditional_stats가 셀 하나를 주는 반면 이 도구는 표면 전체를 준다. 유망한 conditional_stats 결과가 나왔거나, 전략 규칙의 파라미터를 정하기 전에 반드시 호출한다. 결과 해석은 별도 분석가 모델(balanced 티어)이 담당하며 과최적화 여부를 판정한다.",
    input_schema: {
      type: "object",
      properties: {
        universe: { type: "string", enum: [...UNIVERSE_IDS] },
        symbols: { type: "array", items: { type: "string" } },
        metric: { type: "string", enum: ["return", "rsi14", "volatility", "volume_ratio", "drawdown", "sma_distance", "gap", "range"] },
        period: { type: "integer", description: "지표 길이 또는 룩백" },
        op: { type: "string", enum: ["gt", "lt"] },
        thresholds: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 6, description: "테스트할 임계값들. 예: [25, 30, 35]" },
        horizons: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 5, description: "이후 거래일 수들. 예: [1, 5, 10, 20]" },
        lookbackDays: { type: "integer", description: "기본 1095 (3년)" },
      },
      required: ["metric", "op", "thresholds"],
    },
  },
  {
    name: "audit_result",
    description: "도출한 결론을 별도의 감사관 모델(balanced 티어, 독립 컨텍스트)에게 넘겨 반증을 시도하게 한다. 자기가 만든 결론을 자기가 검토하면 동의하게 되므로, 다른 모델이 공격한다. save_finding으로 저장하기 직전, 그리고 사용자에게 의미 있는 결론을 보고하기 직전에 호출한다. 감사 결과(표본 적정성, 교란 변수, 반대 가설, 데이터 스누핑 위험, 결정적 검증)를 답변에 반영한다.",
    input_schema: {
      type: "object",
      properties: {
        claim: { type: "string", description: "검증할 결론. 숫자와 기간을 포함한 완결된 문장." },
        evidence: { type: "object", description: "그 결론을 뒷받침하는 도구 결과 데이터. conditional_stats/sweep_conditions/screen_universe 결과를 그대로 넣는다." },
        question: { type: "string", description: "사용자의 원래 질문" },
      },
      required: ["claim", "evidence"],
    },
  },
  {
    name: "market_events",
    description: `경제 이벤트 캘린더를 실제치·서프라이즈와 함께 조회한다. 발표 일정만 있는 market_calendar와 달리 여기에는 발표 당시 원본 실제치(actualInitial), 개정치(actualRevised), 서프라이즈가 들어 있다. 이벤트 드리븐 전략을 만들거나 "지난 1년 CPI 발표 때 어땠나" 류의 질문에 쓴다.
사용 가능한 이벤트 루트: ${EVENT_ROOTS.map((item) => `${item.root}(${item.label})`).join(", ")}.
전략 규칙에서 sessions_to_event/sessions_since_event/event_surprise 오퍼랜드를 쓸 때 이 루트 이름을 그대로 쓴다.`,
    input_schema: {
      type: "object",
      properties: {
        roots: { type: "array", items: { type: "string", enum: [...knownEventRoots()] }, description: "비우면 전체" },
        from: { type: "string" },
        to: { type: "string" },
      },
    },
  },
  {
    name: "event_reaction",
    description: "저장된 경제 이벤트 날짜를 기준으로 자산의 발표 전/후 수익률을 집계하고, 서프라이즈 상회·하회로 나눠서 비교한다. \"지난 1년간 고용지표 발표 전후 추이\" 같은 질문의 정답 도구다. 일봉 기준이라 분봉 60일 제한을 받지 않고 캘린더가 덮는 전 기간을 볼 수 있다. 발표일이 휴장이면 다음 거래일에 앵커된다. 같은 기간의 무조건 N일 수익률(베이스라인)과 함께 반환한다.",
    input_schema: {
      type: "object",
      properties: {
        eventRoot: { type: "string", enum: [...knownEventRoots()], description: "이벤트 종류" },
        symbols: { type: "array", items: { type: "string" }, description: "분석할 자산. 기본 SPY, QQQ" },
        preSessions: { type: "integer", description: "발표 전 거래일 수. 기본 2" },
        postSessions: { type: "integer", description: "발표 후 거래일 수. 기본 1" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["eventRoot"],
    },
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

type IntradayEventInput = {
  date: string;
  timeET: string;
  label: string;
  actual: string | null;
  consensus: string | null;
  surprise: "above" | "below" | "inline" | "unknown";
};

async function intradayEventStudy(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const events = (Array.isArray(input.events) ? input.events : []).flatMap((value): IntradayEventInput[] => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const date = String(row.date ?? "");
    const timeET = String(row.timeET ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(timeET)) return [];
    const surprise = ["above", "below", "inline"].includes(String(row.surprise)) ? String(row.surprise) as IntradayEventInput["surprise"] : "unknown";
    return [{ date, timeET, label: String(row.label ?? "시장 이벤트").slice(0, 120), actual: row.actual ? String(row.actual).slice(0, 80) : null, consensus: row.consensus ? String(row.consensus).slice(0, 80) : null, surprise }];
  }).slice(0, 24);
  if (!events.length) return { result: { available: false, reason: "유효한 이벤트 날짜와 ET 시각이 필요합니다." }, artifacts: [], trace: { name: "intraday_event_study", label: "분봉 이벤트 스터디", status: "failed", detail: "이벤트 날짜·시각 없음" } };

  const requestedSymbols = (Array.isArray(input.symbols) && input.symbols.length ? input.symbols : ["QQQ", "IWD"]).map(String).slice(0, 4);
  const resolved = await resolveSymbols(requestedSymbols);
  const interval = (input.interval === "15m" ? "15m" : "5m") as IntradayInterval;
  const intervalMinutes = interval === "15m" ? 15 : 5;
  const preMinutes = Math.min(120, Math.max(15, Number(input.preMinutes) || 30));
  const postMinutes = Math.min(240, Math.max(15, Number(input.postMinutes) || 30));
  const rows: Array<IntradayEventInput & { symbol: string; name: string; reaction: Omit<NonNullable<ReturnType<typeof calculateIntradayReaction>>, "normalizedPath"> | null; unavailable: string | null }> = [];

  // One fetch per symbol across the whole span, not one per event. Fetching per
  // event turned 24 events x 4 symbols into 96 sequential Yahoo round trips for a
  // single tool call: slow, redundant (each pulled an overlapping 3-day window),
  // and far enough into rate limiting that later symbols came back empty.
  const eventDates = events.map((event) => event.date).sort();
  const spanFrom = maxDate(shiftDate(eventDates[0], -1), shiftDate(context.today, -59));
  const spanTo = shiftDate(eventDates.at(-1)!, 1);
  const series = new Map<string, { points: Awaited<ReturnType<typeof fetchYahooIntradayWindow>> | null; error: string | null }>();
  await Promise.all(resolved.map(async (asset) => {
    if (!asset.public || !asset.symbol) return;
    try {
      series.set(asset.symbol, { points: await fetchYahooIntradayWindow(asset.symbol, spanFrom, spanTo, interval), error: null });
    } catch (error) {
      series.set(asset.symbol, { points: null, error: error instanceof Error ? error.message : "분봉 데이터를 가져오지 못했습니다." });
    }
  }));

  for (const event of events) {
    const age = daysBetween(event.date, context.today);
    for (const asset of resolved) {
      const symbol = asset.symbol ?? asset.input;
      const base = { ...event, symbol, name: asset.name };
      if (!asset.public || !asset.symbol) { rows.push({ ...base, reaction: null, unavailable: asset.note ?? "거래 가능 종목을 확인하지 못했습니다." }); continue; }
      if (age < 0) { rows.push({ ...base, reaction: null, unavailable: "아직 지나지 않은 이벤트입니다." }); continue; }
      if (age > 59) { rows.push({ ...base, reaction: null, unavailable: `${interval} 공급 범위(최근 약 60일)를 벗어났습니다.` }); continue; }
      const loaded = series.get(asset.symbol);
      if (!loaded?.points) { rows.push({ ...base, reaction: null, unavailable: loaded?.error ?? "분봉 데이터를 가져오지 못했습니다." }); continue; }
      const calculated = calculateIntradayReaction(loaded.points, event.date, event.timeET, intervalMinutes, preMinutes, postMinutes);
      if (!calculated) { rows.push({ ...base, reaction: null, unavailable: "발표 시각 직전·직후의 완결 분봉이 없습니다." }); continue; }
      rows.push({ ...base, reaction: {
        baseTime: calculated.baseTime, basePrice: calculated.basePrice, preTime: calculated.preTime, preReturnPct: calculated.preReturnPct,
        postTime: calculated.postTime, postReturnPct: calculated.postReturnPct, toRegularClosePct: calculated.toRegularClosePct,
      }, unavailable: null });
    }
  }

  const summaries = summarizeIntradayStudy(rows.map((row) => ({ symbol: row.symbol, surprise: row.surprise, reaction: row.reaction ? { ...row.reaction, normalizedPath: [] } : null })));
  const available = rows.filter((row) => row.reaction).length;
  const artifact: LabArtifact = {
    id: id(), type: "table", title: `분봉 이벤트 스터디 · ${interval}`, subtitle: `${events.length}개 이벤트 · ${available}/${rows.length}개 자산-이벤트 관측 가능`,
    columns: ["발표일·시각 ET", "이벤트", "실제/예상", "Surprise", "자산", `발표 전 ${preMinutes}분 %`, `발표 후 ${postMinutes}분 %`, "정규장 종가까지 %", "상태"],
    rows: rows.map((row) => [
      `${row.date} ${row.timeET}`, row.label, row.actual || row.consensus ? `${row.actual ?? "?"} / ${row.consensus ?? "?"}` : "—", row.surprise, row.symbol,
      row.reaction?.preReturnPct ?? null, row.reaction?.postReturnPct ?? null, row.reaction?.toRegularClosePct ?? null, row.unavailable ?? "완료",
    ]),
    notes: [
      `발표 직전 완결 ${interval} 봉을 기준가로 사용 · 미국 동부시각(ET)`,
      `현재 공급자: Yahoo Finance · ${interval}은 최근 약 60일 범위만 보장`,
      "Surprise는 입력된 실제치·컨센서스 분류를 그대로 사용하며 임의 추정하지 않음",
    ],
  };
  return {
    result: { methodology: { timezone: "America/New_York", interval, preMinutes, postMinutes, base: "last completed bar at or before release time", provider: "Yahoo Finance", guaranteedLookbackDays: 59 }, coverage: { events: events.length, symbols: resolved.length, requested: rows.length, available, unavailable: rows.length - available }, rows, summaries },
    artifacts: [artifact],
    trace: { name: "intraday_event_study", label: "분봉 이벤트 스터디", status: available ? "complete" : "failed", detail: `${available}/${rows.length}개 관측 · ${interval} · 전후 ${preMinutes}/${postMinutes}분` },
  };
}

async function intradayFvgBacktest(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const failed = (reason: string): ToolOutcome => ({ result: { available: false, reason }, artifacts: [], trace: { name: "intraday_fvg_backtest", label: "분봉 FVG 백테스트", status: "failed", detail: reason } });
  const requested = (Array.isArray(input.symbols) ? input.symbols : []).map(String).filter(Boolean).slice(0, 3);
  if (!requested.length) return failed("티커가 필요합니다.");

  const interval = (input.interval === "15m" ? "15m" : "5m") as IntradayInterval;
  const intervalMinutes = interval === "15m" ? 15 : 5;
  // The reference candle is built from the trading bars themselves, so its length
  // has to land on a bar boundary.
  const anchorMinutes = Math.max(intervalMinutes, Math.round((Number(input.anchorMinutes) || 15) / intervalMinutes) * intervalMinutes);
  const windowMinutes = Math.min(390, Math.max(anchorMinutes + intervalMinutes * 2, Math.round(Number(input.windowMinutes) || 90)));
  const rewardRisk = Math.min(5, Math.max(0.5, Number(input.rewardRisk) || 2));
  const costBps = input.costBps === undefined ? 5 : Math.max(0, Number(input.costBps) || 0);
  const holdUntil = input.holdUntil === "window" ? "window" : "session_close";
  // 59 days is the provider's guaranteed intraday window; asking for more returns
  // nothing rather than an error, which would read as "no setups".
  const lookbackDays = Math.min(59, Math.max(7, Math.round(Number(input.lookbackDays) || 55)));
  const options: FvgOptions = { intervalMinutes, anchorMinutes, windowMinutes, rewardRisk, costBps, holdUntil };

  const from = shiftDate(context.today, -lookbackDays);
  const resolved = await resolveSymbols(requested);
  const results = await Promise.all(resolved.map(async (asset) => {
    const symbol = asset.symbol ?? asset.input;
    if (!asset.public || !asset.symbol) return { symbol, name: asset.name, error: asset.note ?? "거래 가능 종목을 확인하지 못했습니다.", result: null };
    try {
      const points = await fetchYahooIntradayWindow(asset.symbol, from, context.today, interval);
      if (!points.length) return { symbol, name: asset.name, error: "해당 구간의 분봉 데이터가 없습니다.", result: null };
      return { symbol, name: asset.name, error: null, result: runFvgBacktest(asset.symbol, asset.name, points, options) };
    } catch (error) {
      return { symbol, name: asset.name, error: error instanceof Error ? error.message : "분봉 데이터를 가져오지 못했습니다.", result: null };
    }
  }));

  const usable = results.flatMap((item) => item.result ? [item.result] : []);
  if (!usable.length) return failed(results.map((item) => `${item.symbol}: ${item.error}`).join(" · "));

  const rows = usable.flatMap((item) => item.summaries.map((summary) => [
    item.symbol, summary.label, summary.sessions, summary.trades, summary.winRatePct, summary.breakevenWinRatePct,
    summary.averageR, summary.medianR, summary.totalR, summary.totalRExcludingBest, summary.targetHits, summary.stopHits, summary.timeExits,
  ]));
  const artifact: LabArtifact = {
    id: id(), type: "table", title: `분봉 FVG 백테스트 · ${interval}`,
    subtitle: `기준선 ${anchorMinutes}분 · 매매 창 ${windowMinutes}분 · 손익비 1:${rewardRisk} · 비용 ${costBps}bps 편도`,
    columns: ["종목", "규칙", "세션", "거래", "승률 %", "손익분기 승률 %", "평균 R", "중앙 R", "누적 R", "최고거래 제외 누적 R", "익절", "손절", "시간청산"],
    rows,
    notes: [
      `데이터 ${usable[0]?.from ?? from} ~ ${usable.at(-1)?.to ?? context.today} · Yahoo Finance ${interval} · 최근 약 59일만 공급`,
      "FVG는 다음 봉 마감 후 확정 · 진입은 그 이후 봉부터만 허용 (룩어헤드 차단)",
      "한 봉이 손절가와 익절가를 모두 덮으면 손절로 처리 (분봉은 선후를 알려주지 않음)",
      "롱 전용 · 하루 최대 1거래 · 슬리피지와 호가 스프레드는 미반영이므로 실제 승률 기준은 더 높음",
      "대조군과 원문 규칙의 성적이 비슷하면 FVG 조건이 아무것도 더하지 못한 것",
    ],
  };

  const bySymbol = usable.map((item) => ({
    symbol: item.symbol, name: item.name, sessions: item.sessions, from: item.from, to: item.to,
    summaries: item.summaries,
    sampleTrades: item.trades.filter((trade) => trade.variant === "fvg_pullback").slice(-8),
  }));
  const headline = usable[0]?.summaries.find((summary) => summary.variant === "fvg_pullback");
  return {
    result: {
      methodology: {
        timezone: "America/New_York", interval, anchorMinutes, windowMinutes, rewardRisk, costBps, holdUntil,
        direction: "long_only", entryConfirmation: "FVG는 다음 봉 마감 후 확정, 진입은 그 이후 봉부터",
        sameBarTie: "손절 우선", provider: "Yahoo Finance", guaranteedLookbackDays: 59,
      },
      unavailable: results.flatMap((item) => item.error ? [{ symbol: item.symbol, reason: item.error }] : []),
      bySymbol,
    },
    artifacts: [artifact],
    trace: {
      name: "intraday_fvg_backtest", label: `분봉 FVG 백테스트 · ${usable.map((item) => item.symbol).join(", ")}`, status: "complete",
      detail: headline ? `${headline.sessions}세션 · 거래 ${headline.trades}건 · 승률 ${headline.winRatePct ?? "—"}% (손익분기 ${headline.breakevenWinRatePct}%) · 누적 ${headline.totalR ?? "—"}R` : `${usable.length}종목 계산`,
    },
  };
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

/**
 * Independent review of a strategy spec, rendered as an artifact.
 *
 * The strategist and the orchestrator are the same frontier model, so this runs
 * on the `counter` tier to guarantee a different reviewer than the author.
 */
async function strategyChallengeArtifact(spec: StrategySpec, backtest: BacktestResult | null, ownerId: string): Promise<{ artifact: LabArtifact; challenge: StrategyChallenge } | { skipped: string }> {
  const review = await challengeStrategy({ spec, backtest, ownerId });
  if (!review.ok) return { skipped: review.reason };
  const challenge = review.data;
  return {
    challenge,
    artifact: {
      id: id(), type: "table", title: `전략 심사 · ${STRATEGY_VERDICT_LABELS[challenge.verdict]}`,
      subtitle: describeChallengerPairing(review.independent),
      columns: ["항목", "심사 결과"],
      rows: [
        ["판정", `${STRATEGY_VERDICT_LABELS[challenge.verdict]} — ${challenge.headline}`],
        ["메커니즘 정합성", challenge.mechanismMatch],
        ["통과 기준 공정성", challenge.criteriaFairness],
        ["반증 가능성", challenge.falsifiabilityCheck],
        ["과최적화 위험", RISK_LABELS[challenge.overfittingRisk]],
        ["누락된 리스크", challenge.missingRisks.join(" / ") || "—"],
        ["결정적 검증", challenge.decisiveTest],
      ],
      notes: ["전략을 작성한 모델과 다른 모델이 독립 컨텍스트에서 검토했습니다."],
    },
  };
}

async function proposeStrategy(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const { spec, errors } = specFromToolInput(input, context);
  if (!spec) return { result: { ok: false, errors }, artifacts: [], trace: { name: "propose_strategy", label: "전략 제안", status: "failed", detail: errors.join(" ") } };
  const artifacts: LabArtifact[] = [{ id: id(), type: "strategy-proposal", title: `전략 제안 · ${spec.name}`, spec: spec as unknown as Record<string, unknown>, summary: describeSpec(spec), strategyId: null, status: null, notes: ["Backtest 화면에 저장하려면 카드의 버튼을 누르거나 JARVIS에게 저장을 요청", "가설 → 규칙 → 백테스트 → 반증 순서로 검증"] }];
  let run: ReturnType<typeof compactResult> | null = null;
  let result: BacktestResult | null = null;
  if (input.runNow) {
    const outcome = await backtestSpec(spec);
    if (outcome.result) { result = outcome.result; artifacts.push(backtestArtifact(outcome.result, null)); run = compactResult(outcome.result); }
  }
  const review = await strategyChallengeArtifact(spec, result, context.ownerId);
  if ("artifact" in review) artifacts.push(review.artifact);
  return {
    result: {
      ok: true, spec, summary: describeSpec(spec), backtest: run,
      challenge: "challenge" in review ? review.challenge : null,
      challengeSkipped: "skipped" in review ? review.skipped : null,
      nextStep: "심사 결과를 사용자에게 전달하고, 결함이 지적됐으면 사양을 고친 뒤 저장 여부를 묻는다. 동의하면 save_strategy를 호출",
    },
    artifacts,
    trace: { name: "propose_strategy", label: `전략 제안 · ${spec.name}`, status: "complete", detail: `${spec.universe.join(", ")} · ${describeSpec(spec).entry}` },
  };
}

async function saveStrategyTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const { spec, errors } = specFromToolInput(input, context);
  if (!spec) return { result: { ok: false, errors }, artifacts: [], trace: { name: "save_strategy", label: "전략 저장", status: "failed", detail: errors.join(" ") } };
  try {
    let stored = await saveStrategy(context.ownerId, spec, {
      sourceConversationId: context.conversationId ?? null,
      sourceFindingId: typeof input.sourceFindingId === "string" && input.sourceFindingId.trim() ? input.sourceFindingId.trim() : null,
    });
    const artifacts: LabArtifact[] = [];
    let run: ReturnType<typeof compactResult> | null = null;
    let ran: BacktestResult | null = null;
    if (input.runNow) {
      const outcome = await runAndRecord(context.ownerId, stored);
      if (outcome.result) { ran = outcome.result; stored = outcome.strategy ?? stored; artifacts.push(backtestArtifact(outcome.result, stored.id)); run = compactResult(outcome.result); }
    }
    artifacts.unshift({ id: id(), type: "strategy-proposal", title: `저장됨 · ${spec.name}`, spec: spec as unknown as Record<string, unknown>, summary: describeSpec(spec), strategyId: stored.id, status: stored.status, notes: ["Backtest 화면에서 기간·비용을 바꿔 다시 실행하고 실거래 시그널을 확인할 수 있음"] });
    const review = await strategyChallengeArtifact(spec, ran, context.ownerId);
    if ("artifact" in review) artifacts.push(review.artifact);
    return {
      result: {
        ok: true, strategyId: stored.id, status: stored.status, statusLabel: STRATEGY_STATUS_LABELS[stored.status], backtest: run,
        challenge: "challenge" in review ? review.challenge : null,
        challengeSkipped: "skipped" in review ? review.skipped : null,
        instruction: "심사 판정이 flawed 또는 unfalsifiable이면 저장됐다는 사실과 함께 지적된 결함을 사용자에게 반드시 전달한다.",
      },
      artifacts,
      trace: { name: "save_strategy", label: `전략 저장 · ${spec.name}`, status: "complete", detail: `Backtest에 저장 (${STRATEGY_STATUS_LABELS[stored.status]})` },
    };
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

/**
 * Loads daily bars for a whole universe. Bars come from the D1 cache first
 * (`loadDailyRows`), so only the first screen of a universe pays the upstream
 * cost; the pool bounds concurrency because Yahoo throttles bursts from the
 * Worker's shared egress IP and a Worker has a finite subrequest budget.
 */
async function loadUniverseBars(symbols: string[], from: string, to: string, concurrency = 6) {
  const candidates: ScreenCandidate[] = [];
  const failed: Array<{ symbol: string; reason: string }> = [];
  const queue = [...symbols];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let symbol = queue.shift(); symbol; symbol = queue.shift()) {
      try {
        const load = await loadDailyRows(symbol, from, to);
        if (load.rows.length < 30) failed.push({ symbol, reason: load.reason ?? `일봉 ${load.rows.length}개로 부족합니다.` });
        else candidates.push({ symbol, name: symbol, rows: load.rows });
      } catch (error) {
        failed.push({ symbol, reason: error instanceof Error ? error.message : "일봉 로드 실패" });
      }
    }
  });
  await Promise.all(workers);
  candidates.sort((left, right) => symbols.indexOf(left.symbol) - symbols.indexOf(right.symbol));
  return { candidates, failed };
}

function normalizeMetric(value: unknown): ScreenMetric | null {
  return typeof value === "string" && (SCREEN_METRICS as string[]).includes(value) ? value as ScreenMetric : null;
}

function optionalPeriod(value: unknown) {
  const period = Number(value);
  return Number.isFinite(period) && period >= 2 ? Math.round(period) : undefined;
}

async function screenUniverseTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const rankInput = (input.rankBy && typeof input.rankBy === "object" ? input.rankBy : {}) as Input;
  const rankMetric = normalizeMetric(rankInput.metric);
  if (!rankMetric) {
    const reason = `rankBy.metric이 필요합니다. 사용 가능: ${SCREEN_METRICS.join(", ")}`;
    return { result: { available: false, reason }, artifacts: [], trace: { name: "screen_universe", label: "종목 스크리닝", status: "failed", detail: reason } };
  }
  const rank: ScreenRank = { metric: rankMetric, period: optionalPeriod(rankInput.period), direction: rankInput.direction === "asc" ? "asc" : "desc" };
  const filters: ScreenFilter[] = (Array.isArray(input.filters) ? input.filters : []).flatMap((item) => {
    const filter = (item && typeof item === "object" ? item : {}) as Input;
    const metric = normalizeMetric(filter.metric);
    const value = Number(filter.value);
    const op = filter.op === "lt" || filter.op === "gte" || filter.op === "lte" ? filter.op : "gt";
    return metric && Number.isFinite(value) ? [{ metric, period: optionalPeriod(filter.period), op, value } as ScreenFilter] : [];
  }).slice(0, 4);

  const { symbols, label, note } = resolveUniverse(input, 40);
  const { from, to } = windowFor({ lookbackDays: input.lookbackDays }, context.today, 500);
  const { candidates, failed } = await loadUniverseBars(symbols, from, to);
  if (!candidates.length) {
    const reason = `${label}의 일봉을 하나도 불러오지 못했습니다. ${failed[0]?.reason ?? ""}`.trim();
    return { result: { available: false, reason, failed }, artifacts: [limitation("스크리닝 불가", reason, ["잠시 후 다시 시도", "symbols로 종목 수를 줄여 지정"])], trace: { name: "screen_universe", label: "종목 스크리닝", status: "failed", detail: reason } };
  }

  const limit = Math.min(40, Math.max(1, Number(input.limit) || 15));
  const screen = screenUniverse(candidates, rank, filters, limit);
  const columns = ["종목", "종가", ...screen.columns.map((column) => column.label)];
  const rows = screen.rows.map((row) => [row.symbol, row.close, ...screen.columns.map((column) => row.values[column.key] ?? null)]);
  const notes = [
    `${label} · ${candidates.length}종목 스캔 · ${from} → ${to}`,
    `정렬: ${screen.rankLabel} ${rank.direction === "desc" ? "높은 순" : "낮은 순"}`,
    filters.length ? `필터 ${filters.length}개 적용 후 ${screen.rows.length}종목` : `상위 ${screen.rows.length}종목`,
    note,
    failed.length ? `데이터 실패 ${failed.length}종목: ${failed.slice(0, 5).map((item) => item.symbol).join(", ")}` : null,
    "고정 표본이라 지수 실제 편입 종목과 다를 수 있고, 상장폐지 종목이 빠져 생존편향이 있습니다.",
  ].filter((item): item is string => Boolean(item));

  const artifact: LabArtifact = { id: id(), type: "table", title: `스크리닝 · ${screen.rankLabel}`, subtitle: `${label} · 상위 ${screen.rows.length}종목`, columns, rows, notes };
  return {
    result: {
      universe: label, scanned: candidates.length, matched: screen.rows.length, period: { from, to },
      rankBy: { metric: rank.metric, period: rank.period, direction: rank.direction, label: screen.rankLabel },
      filters, rows: screen.rows, excluded: screen.excluded.slice(0, 10), failed: failed.slice(0, 10),
      caveat: "고정 표본 · 생존편향 있음",
    },
    artifacts: [artifact],
    trace: { name: "screen_universe", label: `스크리닝 · ${label}`, status: "complete", detail: `${candidates.length}종목 중 ${screen.rows.length}개 · ${screen.rankLabel}` },
  };
}

async function conditionalStatsTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const conditionInput = (input.condition && typeof input.condition === "object" ? input.condition : {}) as Input;
  const metric = normalizeMetric(conditionInput.metric);
  const value = Number(conditionInput.value);
  if (!metric || !Number.isFinite(value)) {
    const reason = "condition.metric과 condition.value가 필요합니다.";
    return { result: { available: false, reason }, artifacts: [], trace: { name: "conditional_stats", label: "조건부 통계", status: "failed", detail: reason } };
  }
  const condition: PooledCondition = { metric, period: optionalPeriod(conditionInput.period), op: conditionInput.op === "lt" ? "lt" : "gt", value };
  const horizon = Math.min(60, Math.max(1, Number(input.horizonDays) || 5));

  const { symbols, label, note } = resolveUniverse(input, 40);
  const { from, to } = windowFor({ lookbackDays: input.lookbackDays }, context.today, 1095);
  const { candidates, failed } = await loadUniverseBars(symbols, from, to);
  if (!candidates.length) {
    const reason = `${label}의 일봉을 불러오지 못했습니다. ${failed[0]?.reason ?? ""}`.trim();
    return { result: { available: false, reason }, artifacts: [limitation("조건부 통계 불가", reason, ["잠시 후 다시 시도", "symbols로 종목을 직접 지정"])], trace: { name: "conditional_stats", label: "조건부 통계", status: "failed", detail: reason } };
  }

  // "rsi14" already carries its length in the label, so only append a period for
  // metrics whose label does not name one (return, volatility, sma_distance, ...).
  const namesPeriod = /\(\d+\)/.test(SCREEN_METRIC_LABELS[metric]);
  const conditionLabel = `${SCREEN_METRIC_LABELS[metric]}${condition.period && !namesPeriod ? `(${condition.period})` : ""} ${condition.op === "gt" ? ">" : "<"} ${value}`;
  const study = pooledConditionalStudy(candidates, condition, horizon, conditionLabel);
  if (!study.conditional.samples) {
    const reason = `${candidates.length}종목 ${from}~${to} 구간에서 '${conditionLabel}'을 만족하는 날이 없습니다.`;
    return { result: { available: false, reason, symbolsScanned: candidates.length }, artifacts: [limitation("표본 없음", reason, ["임계값을 완화", "lookbackDays를 늘려 기간 확대"])], trace: { name: "conditional_stats", label: "조건부 통계", status: "failed", detail: "조건 충족 표본 0건" } };
  }

  const artifact: LabArtifact = {
    id: id(), type: "event-study", title: `조건부 통계 · ${conditionLabel}`, symbol: label, period: { from, to },
    condition: conditionLabel, horizon,
    stats: {
      "발생": study.conditional.samples,
      "조건부 승률": study.conditional.positiveRatePct,
      "조건부 평균": study.conditional.averagePct,
      "베이스라인 평균": study.baseline.averagePct,
      "평균 초과": study.edge.averageDiffPct,
      "조건부 중앙값": study.conditional.medianPct,
      "표준편차": study.conditional.stdDevPct,
    },
    distribution: study.distribution,
    events: [],
    notes: [
      `${label} · ${study.symbolsWithSamples}/${study.symbolsScanned}종목에서 표본 발생 · ${from} → ${to}`,
      `조건부 n=${study.conditional.samples} vs 베이스라인 n=${study.baseline.samples} · 승률 차이 ${study.edge.positiveRateDiffPct ?? "—"}%p · t=${study.edge.tStat ?? "—"}`,
      "관측 구간이 겹치므로 t값은 참고용이며, 실효 표본은 n보다 작습니다.",
      note,
      failed.length ? `데이터 실패 ${failed.length}종목` : null,
    ].filter((item): item is string => Boolean(item)),
  };

  return {
    result: {
      universe: label, period: { from, to }, condition: conditionLabel, horizon,
      conditional: study.conditional, baseline: study.baseline, edge: study.edge,
      symbolsWithSamples: study.symbolsWithSamples, symbolsScanned: study.symbolsScanned,
      perSymbol: study.perSymbol.slice(0, 15),
      caveat: "겹치는 관측 구간 · 고정 표본 생존편향",
    },
    artifacts: [artifact],
    trace: { name: "conditional_stats", label: `조건부 통계 · ${conditionLabel}`, status: "complete", detail: `n=${study.conditional.samples} · 평균 ${study.conditional.averagePct ?? "—"}% vs 기준 ${study.baseline.averagePct ?? "—"}%` },
  };
}

async function saveFindingTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  try {
    const saved = await saveFinding(context.ownerId, context.conversationId ?? null, {
      id: typeof input.id === "string" ? input.id : undefined,
      title: String(input.title ?? ""),
      claim: String(input.claim ?? ""),
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
      eventRoots: Array.isArray(input.eventRoots) ? input.eventRoots.map(String) : [],
      symbols: Array.isArray(input.symbols) ? input.symbols.map(String) : [],
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      confidence: typeof input.confidence === "string" ? input.confidence : undefined,
      status: typeof input.status === "string" ? input.status : undefined,
      falsification: typeof input.falsification === "string" ? input.falsification : "",
    });
    if (!saved.ok) return { result: { ok: false, errors: saved.errors }, artifacts: [], trace: { name: "save_finding", label: "연구 노트 저장", status: "failed", detail: saved.errors.join(" ") } };
    const finding = saved.finding;
    const artifact: LabArtifact = {
      id: id(), type: "table", title: `연구 노트 ${saved.created ? "저장" : "갱신"} · ${finding.title}`,
      subtitle: `${FINDING_STATUS_LABELS[finding.status]} · 신뢰도 ${FINDING_CONFIDENCE_LABELS[finding.confidence]}`,
      columns: ["항목", "내용"],
      rows: [
        ["결론", finding.claim],
        ["근거", finding.evidence.map((item) => item.kind === "tool_run" ? `${item.tool}: ${item.summary}` : item.summary).join(" / ")],
        ["이벤트", finding.eventRoots.join(", ") || "—"],
        ["종목", finding.symbols.join(", ") || "—"],
        ["반증 조건", finding.falsification || "—"],
        ["노트 id", finding.id.slice(0, 8)],
      ],
      notes: ["다음 대화에서 관련 질문을 하면 이 노트가 자동으로 다시 불려옵니다."],
    };
    return { result: { ok: true, created: saved.created, finding }, artifacts: [artifact], trace: { name: "save_finding", label: `연구 노트 ${saved.created ? "저장" : "갱신"}`, status: "complete", detail: finding.title } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "연구 노트 저장 실패";
    return { result: { ok: false, reason }, artifacts: [], trace: { name: "save_finding", label: "연구 노트 저장", status: "failed", detail: reason } };
  }
}

async function listFindingsTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  try {
    const findings = await listFindings(context.ownerId, Number(input.limit) || 20);
    const artifact: LabArtifact = {
      id: id(), type: "table", title: "연구 노트", subtitle: `${findings.length}건`,
      columns: ["제목", "결론", "종목", "신뢰도", "상태", "갱신"],
      rows: findings.map((finding) => [finding.title, finding.claim, finding.symbols.join(",") || "—", FINDING_CONFIDENCE_LABELS[finding.confidence], FINDING_STATUS_LABELS[finding.status], finding.updatedAt.slice(0, 10)]),
      notes: findings.length ? [] : ["아직 저장된 노트가 없습니다. 검증된 결론이 나오면 save_finding으로 남기세요."],
    };
    return { result: findings, artifacts: [artifact], trace: { name: "list_findings", label: "연구 노트", status: "complete", detail: `${findings.length}건` } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "연구 노트 조회 실패";
    return { result: { ok: false, reason }, artifacts: [], trace: { name: "list_findings", label: "연구 노트", status: "failed", detail: reason } };
  }
}

async function sweepConditionsTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const metric = normalizeMetric(input.metric);
  const thresholds = (Array.isArray(input.thresholds) ? input.thresholds : []).map(Number).filter(Number.isFinite).slice(0, 6);
  if (!metric || thresholds.length < 2) {
    const reason = "metric과 thresholds(2개 이상)가 필요합니다.";
    return { result: { available: false, reason }, artifacts: [], trace: { name: "sweep_conditions", label: "그리드 스윕", status: "failed", detail: reason } };
  }
  const horizons = (Array.isArray(input.horizons) ? input.horizons : [1, 5, 10, 20]).map(Number).filter((value) => Number.isFinite(value) && value >= 1).slice(0, 5);
  const op: "gt" | "lt" = input.op === "lt" ? "lt" : "gt";
  const period = optionalPeriod(input.period);

  const { symbols, label, note } = resolveUniverse(input, 40);
  const { from, to } = windowFor({ lookbackDays: input.lookbackDays }, context.today, 1095);
  const { candidates, failed } = await loadUniverseBars(symbols, from, to);
  if (!candidates.length) {
    const reason = `${label}의 일봉을 불러오지 못했습니다. ${failed[0]?.reason ?? ""}`.trim();
    return { result: { available: false, reason }, artifacts: [limitation("스윕 불가", reason, ["잠시 후 다시 시도", "symbols로 종목을 직접 지정"])], trace: { name: "sweep_conditions", label: "그리드 스윕", status: "failed", detail: reason } };
  }

  const namesPeriod = /\(\d+\)/.test(SCREEN_METRIC_LABELS[metric]);
  const conditionLabel = `${SCREEN_METRIC_LABELS[metric]}${period && !namesPeriod ? `(${period})` : ""} ${op === "gt" ? ">" : "<"} {임계값}`;
  const sweep = sweepConditions(candidates, metric, op, thresholds, horizons.length ? horizons : [5], period);
  const robustness = sweep.robustness;

  // The grid itself is deterministic; the balanced-tier analyst reads it for
  // overfitting, which is judgement the orchestrator should not make about its
  // own hypothesis.
  const interpretation = await interpretSweep({ sweep, conditionLabel, universeLabel: label, ownerId: context.ownerId });

  const artifact: LabArtifact = {
    id: id(), type: "table", title: `그리드 스윕 · ${conditionLabel}`,
    subtitle: `${label} · ${sweep.thresholds.length}개 임계값 × ${sweep.horizons.length}개 기간`,
    columns: ["임계값", "기간(일)", "표본 n", "조건부 (%)", "기준 (%)", "초과 (%p)", "승률차 (%p)"],
    rows: sweep.cells.map((cell) => [cell.threshold, cell.horizon, cell.samples, cell.conditionalAvgPct, cell.baselineAvgPct, cell.edgePct, cell.positiveRateDiffPct]),
    notes: [
      `${from} → ${to} · ${sweep.symbolsScanned}종목 스캔`,
      `초과분 양수 칸 ${robustness.positiveEdgeCells}/${robustness.cellsWithSamples} (${robustness.positiveEdgeRatePct ?? "—"}%) · 중앙값 ${robustness.medianEdgePct ?? "—"}%p · 범위 ${robustness.minEdgePct ?? "—"} ~ ${robustness.maxEdgePct ?? "—"}`,
      `부호 일관성 ${robustness.signConsistent ? "있음" : "없음"} · 극단으로 갈수록 강해짐: ${robustness.strengthensWithExtremity === null ? "판정 불가" : robustness.strengthensWithExtremity ? "그렇다" : "아니다"}`,
      interpretation.ok ? `분석가 판정: ${interpretation.data.split("\n")[0]}` : `분석가 해석 생략: ${interpretation.reason}`,
      "최고 성적 칸 하나를 결론으로 삼으면 과최적화입니다. 표면 전체를 보세요.",
      note,
    ].filter((item): item is string => Boolean(item)),
  };

  return {
    result: {
      universe: label, period: { from, to }, condition: conditionLabel, metric, op, thresholds: sweep.thresholds, horizons: sweep.horizons,
      cells: sweep.cells, robustness, symbolsScanned: sweep.symbolsScanned, symbolsWithSamples: sweep.symbolsWithSamples,
      analystReading: interpretation.ok ? interpretation.data : null,
      analystModel: interpretation.ok ? interpretation.model : null,
      analystSkipped: interpretation.ok ? null : interpretation.reason,
      caveat: "겹치는 관측 구간 · 고정 표본 생존편향 · 그리드 전체를 보고 판단할 것",
    },
    artifacts: [artifact],
    trace: {
      name: "sweep_conditions", label: `그리드 스윕 · ${conditionLabel}`, status: "complete",
      detail: `${robustness.cellsWithSamples}칸 중 ${robustness.positiveEdgeCells}칸 양수 · 중앙 초과 ${robustness.medianEdgePct ?? "—"}%p`,
    },
  };
}

async function auditResultTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const claim = String(input.claim ?? "").trim();
  if (claim.length < 10) {
    const reason = "claim에 검증할 결론을 문장으로 적어야 합니다.";
    return { result: { ok: false, reason }, artifacts: [], trace: { name: "audit_result", label: "결론 감사", status: "failed", detail: reason } };
  }
  const audit = await auditResult({ claim, evidence: input.evidence ?? {}, question: typeof input.question === "string" ? input.question : undefined, ownerId: context.ownerId });
  if (!audit.ok) {
    return {
      result: { ok: false, reason: audit.reason },
      artifacts: [limitation("감사 생략", audit.reason, ["ANTHROPIC_API_KEY 연결 후 재시도"])],
      trace: { name: "audit_result", label: "결론 감사", status: "failed", detail: audit.reason },
    };
  }
  const report = audit.data;
  const artifact: LabArtifact = {
    id: id(), type: "table", title: `결론 감사 · ${AUDIT_VERDICT_LABELS[report.verdict]}`,
    subtitle: `${audit.model} · 데이터 스누핑 위험 ${AUDIT_RISK_LABELS[report.dataSnoopingRisk]}`,
    columns: ["항목", "감사 결과"],
    rows: [
      ["판정", `${AUDIT_VERDICT_LABELS[report.verdict]} — ${report.headline}`],
      ["표본 적정성", report.sampleAdequacy],
      ["교란 변수", report.confounders.join(" / ") || "—"],
      ["반대 가설", report.counterHypotheses.join(" / ") || "—"],
      ["데이터 스누핑", `${AUDIT_RISK_LABELS[report.dataSnoopingRisk]} — ${report.dataSnoopingReason}`],
      ["생존편향 영향", report.survivorshipImpact],
      ["결정적 검증", report.decisiveTest],
    ],
    notes: ["오케스트레이터와 다른 모델·다른 컨텍스트에서 독립적으로 실행된 감사입니다."],
  };
  return {
    result: { ok: true, audit: report, model: audit.model, instruction: "이 감사 결과를 답변에 반영하고, 판정이 weakens/refutes/insufficient면 결론을 그에 맞게 약화하거나 철회한다." },
    artifacts: [artifact],
    trace: { name: "audit_result", label: `결론 감사 · ${AUDIT_VERDICT_LABELS[report.verdict]}`, status: "complete", detail: report.headline.slice(0, 90) },
  };
}

async function marketEventsTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const roots = (Array.isArray(input.roots) ? input.roots : []).map(String).filter(Boolean);
  const { from, to } = windowFor(input, context.today, 730);
  try {
    const events = await listMarketEvents(roots, from, to);
    if (!events.length) {
      const reason = `${from}~${to} 구간에 저장된 이벤트가 없습니다. POST /api/events {"action":"seed"} 로 캘린더를 적재한 뒤 {"action":"backfill","root":"cpi"} 로 실제치를 채우세요.`;
      return { result: { available: false, reason }, artifacts: [limitation("이벤트 없음", reason, ["/api/events seed 실행", "루트 이름 확인"])], trace: { name: "market_events", label: "경제 이벤트", status: "failed", detail: "저장된 이벤트 없음" } };
    }
    const withValues = events.filter((event) => event.actualInitial !== null);
    const artifact: LabArtifact = {
      id: id(), type: "table", title: "경제 이벤트", subtitle: `${events.length}건 · 실제치 있음 ${withValues.length}건`,
      columns: ["날짜", "루트", "ET", "실제치(원본)", "개정치", "컨센서스", "서프라이즈", "z", "기준"],
      rows: events.slice(0, 60).map((event) => [event.eventDate, event.eventRoot, event.eventTimeEt, event.actualInitial, event.actualRevised, event.consensus, event.surprise, event.surpriseZ, SURPRISE_BASIS_LABELS[event.surpriseBasis as keyof typeof SURPRISE_BASIS_LABELS] ?? event.surpriseBasis]),
      notes: [
        `${from} → ${to}`,
        "실제치(원본)는 발표 당시 값이고 개정치는 이후 수정된 값입니다. 백테스트는 원본만 사용합니다.",
        withValues.length < events.length ? `${events.length - withValues.length}건은 아직 실제치가 없습니다 (미래 일정이거나 backfill 미실행).` : "",
      ].filter(Boolean),
    };
    return {
      result: { period: { from, to }, count: events.length, withValues: withValues.length, events: events.slice(0, 60), roots: roots.length ? roots : "all" },
      artifacts: [artifact],
      trace: { name: "market_events", label: "경제 이벤트", status: "complete", detail: `${events.length}건 · 실제치 ${withValues.length}건` },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "이벤트 조회 실패";
    return { result: { available: false, reason }, artifacts: [], trace: { name: "market_events", label: "경제 이벤트", status: "failed", detail: reason } };
  }
}

async function eventReactionTool(input: Input, context: ToolContext): Promise<ToolOutcome> {
  const root = String(input.eventRoot ?? "").trim();
  if (!root) return { result: { available: false, reason: "eventRoot가 필요합니다." }, artifacts: [], trace: { name: "event_reaction", label: "이벤트 반응", status: "failed", detail: "eventRoot 없음" } };
  const symbols = (Array.isArray(input.symbols) && input.symbols.length ? input.symbols.map(String) : ["SPY", "QQQ"]).slice(0, 6);
  const pre = Math.max(0, Number(input.preSessions) || 2);
  const post = Math.max(1, Number(input.postSessions) || 1);
  const { from, to } = windowFor(input, context.today, 1095);

  const events = await listMarketEvents([root], from, to).catch(() => []);
  if (!events.length) {
    const reason = `${root} 이벤트가 ${from}~${to} 구간에 없습니다. /api/events 로 seed·backfill을 먼저 실행하세요.`;
    return { result: { available: false, reason }, artifacts: [limitation("이벤트 없음", reason, ["/api/events seed", "/api/events backfill"])], trace: { name: "event_reaction", label: "이벤트 반응", status: "failed", detail: "이벤트 없음" } };
  }
  const dates = events.map((event) => ({ date: event.eventDate, surprise: event.surprise, surpriseZ: event.surpriseZ }));
  const withSurprise = dates.filter((item) => item.surprise !== null).length;

  const studies = [];
  const failed: string[] = [];
  for (const query of symbols) {
    const loaded = await loadAsset(query, shiftDate(from, -30), to);
    if ("error" in loaded) { failed.push(`${query}: ${loaded.error}`); continue; }
    studies.push(eventReactionStudy(loaded.rows, loaded.asset.symbol!, dates, pre, post));
  }
  if (!studies.length) {
    const reason = failed.join(" / ") || "자산 일봉을 불러오지 못했습니다.";
    return { result: { available: false, reason }, artifacts: [limitation("가격 데이터 없음", reason, ["티커 확인"])], trace: { name: "event_reaction", label: "이벤트 반응", status: "failed", detail: reason } };
  }

  const rows = studies.flatMap((study) => study.buckets.map((bucket) => [
    study.symbol, bucket.label, bucket.samples, bucket.preReturnPct, bucket.postReturnPct, bucket.postMedianPct, bucket.postPositiveRatePct,
    study.baseline.averagePct, bucket.postReturnPct !== null && study.baseline.averagePct !== null ? Number((bucket.postReturnPct - study.baseline.averagePct).toFixed(3)) : null,
  ]));
  const artifact: LabArtifact = {
    id: id(), type: "table", title: `이벤트 반응 · ${root}`,
    subtitle: `${events.length}회 발표 · 발표 전 ${pre}일 / 후 ${post}일`,
    columns: ["자산", "구분", "표본", `전 ${pre}일 (%)`, `후 ${post}일 (%)`, "후 중앙값 (%)", "후 상승률 (%)", "베이스라인 (%)", "초과 (%p)"],
    rows,
    notes: [
      `${from} → ${to} · ${events.length}회 발표 중 서프라이즈 보유 ${withSurprise}회`,
      "발표일이 휴장이면 다음 거래일에 앵커됩니다. 후 수익률은 앵커 종가 기준입니다.",
      withSurprise < events.length ? `${events.length - withSurprise}회는 서프라이즈가 없어 상회/하회 분류에서 빠집니다 (backfill 미실행 또는 미래 일정).` : "",
      `표본이 ${events.length}회뿐입니다. 월간 지표 1년은 12회이므로 이 결과만으로 결론을 내리지 마세요.`,
      failed.length ? `실패: ${failed.join(" / ")}` : "",
    ].filter(Boolean),
  };
  return {
    result: { eventRoot: root, period: { from, to }, releases: events.length, withSurprise, preSessions: pre, postSessions: post, studies, failed },
    artifacts: [artifact],
    trace: { name: "event_reaction", label: `이벤트 반응 · ${root}`, status: "complete", detail: `${events.length}회 · ${studies.map((study) => study.symbol).join(", ")}` },
  };
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
    case "intraday_event_study": return intradayEventStudy(args, context);
    case "intraday_fvg_backtest": return intradayFvgBacktest(args, context);
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
    case "screen_universe": return screenUniverseTool(args, context);
    case "conditional_stats": return conditionalStatsTool(args, context);
    case "save_finding": return saveFindingTool(args, context);
    case "list_findings": return listFindingsTool(args, context);
    case "sweep_conditions": return sweepConditionsTool(args, context);
    case "audit_result": return auditResultTool(args, context);
    case "market_events": return marketEventsTool(args, context);
    case "event_reaction": return eventReactionTool(args, context);
    default: return { result: { error: `알 수 없는 도구 ${name}` }, artifacts: [], trace: { name, label: name, status: "failed", detail: "알 수 없는 도구" } };
  }
}

export const TOOL_LABELS: Record<string, string> = {
  resolve_symbols: "심볼 해석", get_price_history: "가격 이력", compare_assets: "자산 비교", technical_indicators: "기술 지표", event_study: "이벤트 스터디", intraday_event_study: "분봉 이벤트 스터디", backtest_strategy: "백테스트", risk_profile: "리스크 프로파일", seasonality: "계절성", largest_moves_with_news: "급등락·뉴스", search_news: "뉴스 검색", get_quote: "현재가", market_calendar: "경제 일정", news_sentiment_tests: "뉴스 감성 Test", show_chart: "TradingView 차트", intraday_fvg_backtest: "분봉 FVG 백테스트", propose_strategy: "전략 제안", save_strategy: "전략 저장", run_strategy_backtest: "전략 백테스트", list_strategies: "저장된 전략", web_search: "웹 검색",
  screen_universe: "종목 스크리닝", conditional_stats: "조건부 통계", save_finding: "연구 노트 저장", list_findings: "연구 노트",
  sweep_conditions: "그리드 스윕", audit_result: "결론 감사", market_events: "경제 이벤트", event_reaction: "이벤트 반응",
};
