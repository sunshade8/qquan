/**
 * Named symbol universes for the cross-sectional screener.
 *
 * Every other Lab tool takes a symbol the user already named. Research also
 * needs the opposite direction — "which symbols satisfy X" — and that needs a
 * candidate set. These lists are curated and static on purpose: an index's real
 * membership drifts, so a screen run today and the same screen run next month
 * must be comparable. Each list therefore says what it is (a fixed liquid
 * sample) rather than claiming to be the index itself.
 */

export type UniverseId =
  | "megacap"
  | "nasdaq_tech"
  | "semis"
  | "software"
  | "financials"
  | "energy"
  | "healthcare"
  | "consumer"
  | "industrials"
  | "sector_etfs"
  | "broad_etfs";

export type Universe = { id: UniverseId; label: string; note: string; symbols: string[] };

const UNIVERSES: Universe[] = [
  {
    id: "megacap",
    label: "미국 메가캡 30",
    note: "시가총액 상위권 대형주 고정 표본 30종목",
    symbols: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "BRK-B", "JPM", "LLY", "V", "XOM", "UNH", "MA", "COST", "HD", "PG", "JNJ", "WMT", "NFLX", "ABBV", "BAC", "CRM", "ORCL", "CVX", "KO", "AMD", "PEP", "MRK"],
  },
  {
    id: "nasdaq_tech",
    label: "나스닥 기술주 40",
    note: "나스닥 상장 대형 기술주 고정 표본 40종목",
    symbols: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "NFLX", "AMD", "ADBE", "CSCO", "INTC", "QCOM", "TXN", "AMAT", "MU", "INTU", "BKNG", "PANW", "LRCX", "KLAC", "SNPS", "CDNS", "MRVL", "ADI", "CRWD", "ABNB", "WDAY", "TEAM", "DDOG", "ZS", "MDB", "NET", "SNOW", "PLTR", "SHOP", "UBER", "MELI", "ASML"],
  },
  {
    id: "semis",
    label: "반도체",
    note: "반도체 설계·제조·장비 20종목",
    symbols: ["NVDA", "AMD", "AVGO", "INTC", "QCOM", "TXN", "MU", "AMAT", "LRCX", "KLAC", "ADI", "MRVL", "NXPI", "ON", "MCHP", "SWKS", "TER", "ASML", "TSM", "ARM"],
  },
  {
    id: "software",
    label: "소프트웨어·SaaS",
    note: "엔터프라이즈 소프트웨어·클라우드 20종목",
    symbols: ["MSFT", "ORCL", "CRM", "ADBE", "INTU", "NOW", "WDAY", "TEAM", "DDOG", "ZS", "CRWD", "PANW", "MDB", "NET", "SNOW", "HUBS", "VEEV", "DOCU", "OKTA", "TWLO"],
  },
  {
    id: "financials",
    label: "금융",
    note: "은행·카드·자산운용 18종목",
    symbols: ["JPM", "BAC", "WFC", "C", "GS", "MS", "SCHW", "BLK", "AXP", "V", "MA", "PYPL", "USB", "PNC", "TFC", "COF", "BK", "SPGI"],
  },
  {
    id: "energy",
    label: "에너지",
    note: "석유·가스·정유·서비스 15종목",
    symbols: ["XOM", "CVX", "COP", "EOG", "SLB", "PSX", "MPC", "VLO", "OXY", "PXD", "WMB", "KMI", "HAL", "DVN", "HES"],
  },
  {
    id: "healthcare",
    label: "헬스케어",
    note: "제약·바이오·의료기기·보험 18종목",
    symbols: ["LLY", "UNH", "JNJ", "ABBV", "MRK", "TMO", "ABT", "DHR", "PFE", "AMGN", "BMY", "GILD", "CVS", "ISRG", "VRTX", "REGN", "MDT", "SYK"],
  },
  {
    id: "consumer",
    label: "소비재",
    note: "필수·경기소비재 18종목",
    symbols: ["AMZN", "WMT", "COST", "HD", "PG", "KO", "PEP", "MCD", "NKE", "SBUX", "TGT", "LOW", "TJX", "CL", "MDLZ", "MO", "KMB", "GIS"],
  },
  {
    id: "industrials",
    label: "산업재",
    note: "항공·방산·기계·운송 16종목",
    symbols: ["CAT", "DE", "HON", "GE", "BA", "LMT", "RTX", "UNP", "UPS", "FDX", "ETN", "EMR", "ITW", "NOC", "GD", "CSX"],
  },
  {
    id: "sector_etfs",
    label: "S&P 섹터 ETF",
    note: "SPDR 11개 섹터 ETF",
    symbols: ["XLK", "XLF", "XLV", "XLY", "XLP", "XLE", "XLI", "XLB", "XLU", "XLRE", "XLC"],
  },
  {
    id: "broad_etfs",
    label: "대표 지수·자산 ETF",
    note: "지수·채권·원자재·해외 14종목",
    symbols: ["SPY", "QQQ", "IWM", "DIA", "IWD", "IWF", "EFA", "EEM", "TLT", "IEF", "HYG", "GLD", "SLV", "USO"],
  },
];

export const UNIVERSE_IDS = UNIVERSES.map((universe) => universe.id);

export function universeById(id: string): Universe | null {
  return UNIVERSES.find((universe) => universe.id === id) ?? null;
}

export function describeUniverses() {
  return UNIVERSES.map((universe) => ({ id: universe.id, label: universe.label, note: universe.note, count: universe.symbols.length }));
}

/**
 * Resolves a screen request into a concrete symbol list. Explicit symbols win
 * over a named universe; both are de-duplicated and capped so one screen cannot
 * fan out into an unbounded number of price fetches.
 */
export function resolveUniverse(input: { universe?: unknown; symbols?: unknown }, cap = 40): { symbols: string[]; label: string; note: string | null } {
  const explicit = Array.isArray(input.symbols) ? input.symbols.map((value) => String(value).trim().toUpperCase()).filter(Boolean) : [];
  if (explicit.length) {
    const unique = [...new Set(explicit)].slice(0, cap);
    return { symbols: unique, label: `지정 종목 ${unique.length}개`, note: explicit.length > cap ? `${explicit.length}개 중 상위 ${cap}개만 사용했습니다.` : null };
  }
  const named = typeof input.universe === "string" ? universeById(input.universe.trim()) : null;
  const universe = named ?? universeById("megacap")!;
  const symbols = universe.symbols.slice(0, cap);
  return {
    symbols,
    label: universe.label,
    note: [named ? null : `universe를 인식하지 못해 기본값 '${universe.label}'로 실행했습니다.`, universe.symbols.length > cap ? `${universe.symbols.length}개 중 상위 ${cap}개만 사용했습니다.` : null, universe.note].filter(Boolean).join(" ") || null,
  };
}
