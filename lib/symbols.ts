/**
 * Turns company names, Korean nicknames, and tickers into tradable symbols.
 *
 * Static aliases are only candidate hints. Listing status is determined from
 * live Yahoo Finance metadata so a company that later goes public is not
 * permanently trapped in a stale "private company" list.
 */

export type ListingStatus = "listed" | "candidate" | "unresolved";

export type ResolvedSymbol = {
  input: string;
  symbol: string | null;
  name: string;
  exchange: string | null;
  quoteType: string | null;
  public: boolean;
  listingStatus: ListingStatus;
  listingDate: string | null;
  source: string;
  checkedAt: string;
  confidence: "high" | "medium" | "low";
  tradingView: string | null;
  note: string | null;
};

const ALIASES: Array<{ pattern: RegExp; symbol: string; name: string; exchange?: string; tradingView?: string }> = [
  { pattern: /^(?:space\s*x|스페이스\s*x|spcx)$/i, symbol: "SPCX", name: "Space Exploration Technologies Corp.", exchange: "NASDAQ" },
  { pattern: /^(?:nvidia|엔비디아|nvda)$/i, symbol: "NVDA", name: "NVIDIA", exchange: "NASDAQ" },
  { pattern: /^(?:apple|애플|aapl)$/i, symbol: "AAPL", name: "Apple", exchange: "NASDAQ" },
  { pattern: /^(?:microsoft|마이크로소프트|msft)$/i, symbol: "MSFT", name: "Microsoft", exchange: "NASDAQ" },
  { pattern: /^(?:amazon|아마존|amzn)$/i, symbol: "AMZN", name: "Amazon", exchange: "NASDAQ" },
  { pattern: /^(?:google|alphabet|구글|알파벳|googl|goog)$/i, symbol: "GOOGL", name: "Alphabet", exchange: "NASDAQ" },
  { pattern: /^(?:meta|meta platforms|메타|페이스북|facebook)$/i, symbol: "META", name: "Meta Platforms", exchange: "NASDAQ" },
  { pattern: /^(?:tesla|테슬라|tsla)$/i, symbol: "TSLA", name: "Tesla", exchange: "NASDAQ" },
  { pattern: /^(?:rocket\s*lab|로켓랩|rklb)$/i, symbol: "RKLB", name: "Rocket Lab", exchange: "NASDAQ" },
  { pattern: /^(?:ast\s*spacemobile|asts)$/i, symbol: "ASTS", name: "AST SpaceMobile", exchange: "NASDAQ" },
  { pattern: /^(?:palantir|팔란티어|pltr)$/i, symbol: "PLTR", name: "Palantir", exchange: "NASDAQ" },
  { pattern: /^(?:amd|에이엠디)$/i, symbol: "AMD", name: "Advanced Micro Devices", exchange: "NASDAQ" },
  { pattern: /^(?:tsmc|tsm|대만반도체)$/i, symbol: "TSM", name: "Taiwan Semiconductor", exchange: "NYSE" },
  { pattern: /^(?:broadcom|브로드컴|avgo)$/i, symbol: "AVGO", name: "Broadcom", exchange: "NASDAQ" },
  { pattern: /^(?:netflix|넷플릭스|nflx)$/i, symbol: "NFLX", name: "Netflix", exchange: "NASDAQ" },
  { pattern: /^(?:coinbase|코인베이스|coin)$/i, symbol: "COIN", name: "Coinbase", exchange: "NASDAQ" },
  { pattern: /^(?:삼성전자|samsung electronics|samsung)$/i, symbol: "005930.KS", name: "삼성전자", exchange: "KRX", tradingView: "KRX:005930" },
  { pattern: /^(?:sk하이닉스|sk hynix|하이닉스)$/i, symbol: "000660.KS", name: "SK하이닉스", exchange: "KRX", tradingView: "KRX:000660" },
  { pattern: /^(?:s&p\s*500|sp500|s&p|spx|에스앤피)$/i, symbol: "^GSPC", name: "S&P 500", exchange: "INDEX", tradingView: "SP:SPX" },
  { pattern: /^(?:nasdaq|나스닥|nasdaq composite|ixic)$/i, symbol: "^IXIC", name: "NASDAQ Composite", exchange: "INDEX", tradingView: "NASDAQ:IXIC" },
  { pattern: /^(?:nasdaq\s*100|나스닥\s*100|ndx)$/i, symbol: "^NDX", name: "NASDAQ 100", exchange: "INDEX", tradingView: "NASDAQ:NDX" },
  { pattern: /^(?:dow|다우|dow jones|dji)$/i, symbol: "^DJI", name: "Dow Jones Industrial Average", exchange: "INDEX", tradingView: "DJ:DJI" },
  { pattern: /^(?:vix|빅스|변동성지수)$/i, symbol: "^VIX", name: "CBOE Volatility Index", exchange: "INDEX", tradingView: "CBOE:VIX" },
  { pattern: /^(?:kospi|코스피)$/i, symbol: "^KS11", name: "KOSPI", exchange: "INDEX", tradingView: "KRX:KOSPI" },
  { pattern: /^(?:kosdaq|코스닥)$/i, symbol: "^KQ11", name: "KOSDAQ", exchange: "INDEX", tradingView: "KRX:KOSDAQ" },
  { pattern: /^(?:spy)$/i, symbol: "SPY", name: "SPDR S&P 500 ETF", exchange: "AMEX" },
  { pattern: /^(?:qqq)$/i, symbol: "QQQ", name: "Invesco QQQ", exchange: "NASDAQ" },
  { pattern: /^(?:iwm)$/i, symbol: "IWM", name: "iShares Russell 2000", exchange: "AMEX" },
  { pattern: /^(?:tlt)$/i, symbol: "TLT", name: "iShares 20+ Year Treasury", exchange: "NASDAQ" },
  { pattern: /^(?:gld|금|gold)$/i, symbol: "GLD", name: "SPDR Gold Shares", exchange: "AMEX" },
  { pattern: /^(?:bitcoin|비트코인|btc)$/i, symbol: "BTC-USD", name: "Bitcoin", exchange: "CRYPTO", tradingView: "BITSTAMP:BTCUSD" },
  { pattern: /^(?:ethereum|이더리움|eth)$/i, symbol: "ETH-USD", name: "Ethereum", exchange: "CRYPTO", tradingView: "BITSTAMP:ETHUSD" },
  { pattern: /^(?:wti|crude|원유|유가)$/i, symbol: "CL=F", name: "WTI Crude Oil", exchange: "NYMEX", tradingView: "NYMEX:CL1!" },
  { pattern: /^(?:us10y|10년물|미국채\s*10년|tnx)$/i, symbol: "^TNX", name: "US 10Y Treasury Yield", exchange: "INDEX", tradingView: "TVC:US10Y" },
  { pattern: /^(?:dxy|달러인덱스|달러 인덱스)$/i, symbol: "DX-Y.NYB", name: "US Dollar Index", exchange: "INDEX", tradingView: "TVC:DXY" },
];

const YAHOO_EXCHANGE_TO_TRADINGVIEW: Record<string, string> = {
  NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ", NAS: "NASDAQ", NYQ: "NYSE", PCX: "AMEX", ASE: "AMEX", BTS: "AMEX", KSC: "KRX", KOE: "KRX", TAI: "TWSE", JPX: "TSE", LSE: "LSE", HKG: "HKEX", CCC: "CRYPTO",
};

const LISTED_CACHE_MS = 6 * 60 * 60 * 1000;
const RETRY_CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: ResolvedSymbol; expiresAt: number }>();

function tradingViewFor(symbol: string, exchange: string | null) {
  if (!exchange) return null;
  const code = YAHOO_EXCHANGE_TO_TRADINGVIEW[exchange] ?? exchange;
  const clean = symbol.replace(/\.(KS|KQ)$/i, "").replace(/-USD$/i, "USD");
  return `${code}:${clean}`;
}

type YahooQuote = { symbol?: string; shortname?: string; longname?: string; quoteType?: string; exchange?: string; exchDisp?: string; score?: number };
type YahooSearch = { quotes?: YahooQuote[] };
type YahooChartMeta = {
  symbol?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  firstTradeDate?: number;
  longName?: string;
  shortName?: string;
};
type YahooChart = { chart?: { result?: Array<{ meta?: YahooChartMeta }>; error?: unknown } };

async function yahooJson<T>(url: URL): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36", accept: "application/json" }, signal: controller.signal });
    return response.ok ? await response.json() as T : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function searchYahoo(query: string) {
  const url = new URL("https://query2.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", query);
  url.searchParams.set("quotesCount", "8");
  url.searchParams.set("newsCount", "0");
  url.searchParams.set("listsCount", "0");
  const payload = await yahooJson<YahooSearch>(url);
  return (payload?.quotes ?? []).filter((quote) => quote.symbol && ["EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY", "FUTURE", "CURRENCY", "MUTUALFUND"].includes(quote.quoteType ?? ""));
}

async function yahooMeta(symbol: string) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", "5d");
  url.searchParams.set("interval", "1d");
  const payload = await yahooJson<YahooChart>(url);
  return payload?.chart?.result?.[0]?.meta ?? null;
}

function cacheResult(key: string, value: ResolvedSymbol) {
  const ttl = value.listingStatus === "listed" ? LISTED_CACHE_MS : RETRY_CACHE_MS;
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

function fromMeta(input: string, meta: YahooChartMeta, fallback: { symbol: string; name: string; exchange?: string; tradingView?: string }): ResolvedSymbol {
  const symbol = meta.symbol ?? fallback.symbol;
  const exchangeCode = meta.exchangeName ?? fallback.exchange ?? null;
  return {
    input,
    symbol,
    name: meta.longName || meta.shortName || fallback.name,
    exchange: meta.fullExchangeName || exchangeCode,
    quoteType: meta.instrumentType ?? null,
    public: true,
    listingStatus: "listed",
    listingDate: meta.firstTradeDate ? new Date(meta.firstTradeDate * 1000).toISOString().slice(0, 10) : null,
    source: "Yahoo Finance live market metadata",
    checkedAt: new Date().toISOString(),
    confidence: "high",
    tradingView: fallback.tradingView ?? tradingViewFor(symbol, exchangeCode),
    note: null,
  };
}

function quoteScore(quote: YahooQuote, query: string) {
  const symbol = quote.symbol?.toLowerCase() ?? "";
  const name = `${quote.longname ?? ""} ${quote.shortname ?? ""}`.toLowerCase();
  const clean = query.toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
  const normalizedName = name.replace(/[^a-z0-9가-힣]/g, "");
  const typeScore: Record<string, number> = { EQUITY: 500, ETF: 300, INDEX: 250, MUTUALFUND: 200, FUTURE: 100, CURRENCY: 80, CRYPTOCURRENCY: 50 };
  return (typeScore[quote.quoteType ?? ""] ?? 0)
    + (symbol === query.toLowerCase() ? 1_000 : 0)
    + (clean && normalizedName.includes(clean) ? 350 : 0)
    + Math.min(100, Number(quote.score) || 0);
}

export async function resolveSymbol(input: string): Promise<ResolvedSymbol> {
  const clean = input.trim().replace(/\s+/g, " ");
  const key = clean.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) cache.delete(key);

  const alias = ALIASES.find((item) => item.pattern.test(clean));
  if (alias) {
    const meta = await yahooMeta(alias.symbol);
    if (meta?.symbol) return cacheResult(key, fromMeta(clean, meta, alias));
    return cacheResult(key, {
      input: clean, symbol: alias.symbol, name: alias.name, exchange: alias.exchange ?? null, quoteType: null, public: true,
      listingStatus: "candidate", listingDate: null, source: "Static symbol alias; live validation unavailable", checkedAt: new Date().toISOString(), confidence: "medium",
      tradingView: alias.tradingView ?? tradingViewFor(alias.symbol, alias.exchange ?? null), note: "실시간 상장 상태 확인이 응답하지 않아 등록된 심볼 후보로 가격 조회를 계속합니다.",
    });
  }

  const looksLikeTicker = /^[A-Z0-9.^=-]{1,12}$/i.test(clean) && !/^[가-힣]+$/.test(clean);
  if (looksLikeTicker) {
    const symbol = clean.toUpperCase();
    const meta = await yahooMeta(symbol);
    if (meta?.symbol) return cacheResult(key, fromMeta(clean, meta, { symbol, name: symbol }));
  }

  const quotes = await searchYahoo(clean);
  const exact = looksLikeTicker ? quotes.find((quote) => quote.symbol?.toUpperCase() === clean.toUpperCase()) : undefined;
  const best = exact ?? [...quotes].sort((a, b) => quoteScore(b, clean) - quoteScore(a, clean))[0];
  if (best?.symbol) {
    const meta = await yahooMeta(best.symbol);
    if (meta?.symbol) return cacheResult(key, fromMeta(clean, meta, { symbol: best.symbol, name: best.longname || best.shortname || best.symbol, exchange: best.exchange }));
    const exchange = best.exchange ?? null;
    return cacheResult(key, {
      input: clean, symbol: best.symbol, name: best.longname || best.shortname || best.symbol, exchange: best.exchDisp ?? exchange, quoteType: best.quoteType ?? null, public: true,
      listingStatus: "candidate", listingDate: null, source: "Yahoo Finance search; live chart validation unavailable", checkedAt: new Date().toISOString(), confidence: exact ? "medium" : "low",
      tradingView: tradingViewFor(best.symbol, exchange), note: exact ? "실시간 가격 메타데이터 확인이 지연되어 검색 결과 심볼로 조회를 계속합니다." : `'${clean}'와 정확히 일치하는 티커가 없어 ${best.symbol}(${best.shortname ?? ""}) 후보로 해석했습니다.`,
    });
  }

  if (looksLikeTicker) {
    const symbol = clean.toUpperCase();
    return cacheResult(key, {
      input: clean, symbol, name: symbol, exchange: null, quoteType: null, public: true,
      listingStatus: "candidate", listingDate: null, source: "User-supplied ticker; live validation unavailable", checkedAt: new Date().toISOString(), confidence: "low", tradingView: null,
      note: "심볼 조회가 응답하지 않아 입력한 티커로 가격 조회를 시도합니다.",
    });
  }

  return cacheResult(key, {
    input: clean, symbol: null, name: clean, exchange: null, quoteType: null, public: false,
    listingStatus: "unresolved", listingDate: null, source: "Yahoo Finance live search", checkedAt: new Date().toISOString(), confidence: "low", tradingView: null,
    note: `'${clean}'에 해당하는 거래 가능 종목을 현재 데이터 소스에서 확인하지 못했습니다. 비상장으로 단정할 수 없으므로 티커나 거래소를 지정해주세요.`,
  });
}

export async function resolveSymbols(inputs: string[]) {
  return Promise.all(inputs.map((input) => resolveSymbol(input)));
}
