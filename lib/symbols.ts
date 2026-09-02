/**
 * Turns company names, Korean nicknames, and tickers into tradable symbols.
 * Anything Yahoo Finance cannot find is reported as unresolved rather than
 * being silently replaced with a proxy.
 */

export type ResolvedSymbol = {
  input: string;
  symbol: string | null;
  name: string;
  exchange: string | null;
  quoteType: string | null;
  public: boolean;
  tradingView: string | null;
  note: string | null;
};

const PRIVATE_COMPANIES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /^space\s*x$/i, name: "SpaceX" },
  { pattern: /^open\s*ai$/i, name: "OpenAI" },
  { pattern: /^anthropic$/i, name: "Anthropic" },
  { pattern: /^stripe$/i, name: "Stripe" },
  { pattern: /^databricks$/i, name: "Databricks" },
  { pattern: /^bytedance|틱톡|tiktok$/i, name: "ByteDance" },
  { pattern: /^shein$/i, name: "Shein" },
  { pattern: /^x\.?ai$/i, name: "xAI" },
];

const ALIASES: Array<{ pattern: RegExp; symbol: string; name: string; exchange?: string; tradingView?: string }> = [
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

const cache = new Map<string, ResolvedSymbol>();

function tradingViewFor(symbol: string, exchange: string | null) {
  if (!exchange) return null;
  const code = YAHOO_EXCHANGE_TO_TRADINGVIEW[exchange] ?? exchange;
  const clean = symbol.replace(/\.(KS|KQ)$/i, "").replace(/-USD$/i, "USD");
  return `${code}:${clean}`;
}

type YahooSearch = { quotes?: Array<{ symbol?: string; shortname?: string; longname?: string; quoteType?: string; exchange?: string; exchDisp?: string; score?: number }> };

async function searchYahoo(query: string) {
  const url = new URL("https://query2.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", query);
  url.searchParams.set("quotesCount", "8");
  url.searchParams.set("newsCount", "0");
  url.searchParams.set("listsCount", "0");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36", accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return [];
    const payload = await response.json() as YahooSearch;
    return (payload.quotes ?? []).filter((quote) => quote.symbol && ["EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY", "FUTURE", "CURRENCY", "MUTUALFUND"].includes(quote.quoteType ?? ""));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveSymbol(input: string): Promise<ResolvedSymbol> {
  const clean = input.trim().replace(/\s+/g, " ");
  const key = clean.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const privateCompany = PRIVATE_COMPANIES.find((item) => item.pattern.test(clean));
  if (privateCompany) {
    const resolved: ResolvedSymbol = { input: clean, symbol: null, name: privateCompany.name, exchange: null, quoteType: null, public: false, tradingView: null, note: `${privateCompany.name}는 비상장사라 검증 가능한 공개 주가 시계열이 없습니다.` };
    cache.set(key, resolved);
    return resolved;
  }
  const alias = ALIASES.find((item) => item.pattern.test(clean));
  if (alias) {
    const resolved: ResolvedSymbol = { input: clean, symbol: alias.symbol, name: alias.name, exchange: alias.exchange ?? null, quoteType: null, public: true, tradingView: alias.tradingView ?? tradingViewFor(alias.symbol, alias.exchange ?? null), note: null };
    cache.set(key, resolved);
    return resolved;
  }

  const looksLikeTicker = /^[A-Z0-9.^=-]{1,12}$/i.test(clean) && !/^[가-힣]+$/.test(clean);
  const quotes = await searchYahoo(clean);
  const exact = looksLikeTicker ? quotes.find((quote) => quote.symbol?.toUpperCase() === clean.toUpperCase()) : undefined;
  const best = exact ?? quotes[0];
  if (best?.symbol) {
    const exchange = best.exchange ?? null;
    const resolved: ResolvedSymbol = {
      input: clean, symbol: best.symbol, name: best.longname || best.shortname || best.symbol, exchange: best.exchDisp ?? exchange, quoteType: best.quoteType ?? null, public: true,
      tradingView: tradingViewFor(best.symbol, exchange), note: exact || !looksLikeTicker ? null : `'${clean}'와 정확히 일치하는 티커가 없어 ${best.symbol}(${best.shortname ?? ""})로 해석했습니다.`,
    };
    cache.set(key, resolved);
    return resolved;
  }
  if (looksLikeTicker) {
    // Yahoo search can be throttled; a ticker-shaped input is still worth a price lookup.
    const symbol = clean.toUpperCase();
    return { input: clean, symbol, name: symbol, exchange: null, quoteType: null, public: true, tradingView: null, note: "심볼 검색이 응답하지 않아 입력값을 티커로 그대로 사용했습니다." };
  }
  return { input: clean, symbol: null, name: clean, exchange: null, quoteType: null, public: false, tradingView: null, note: `'${clean}'에 해당하는 상장 종목을 찾지 못했습니다. 티커를 직접 지정해주세요.` };
}

export async function resolveSymbols(inputs: string[]) {
  return Promise.all(inputs.map((input) => resolveSymbol(input)));
}
