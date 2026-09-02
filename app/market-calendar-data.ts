export type MarketEventCategory = "fed" | "inflation" | "labor" | "growth" | "business" | "market";

export type MarketEvent = {
  id: string;
  date: string;
  time: string;
  title: string;
  note: string;
  category: MarketEventCategory;
  source: string;
  sourceUrl: string;
  importance: "high" | "medium";
};

type SeriesOptions = Omit<MarketEvent, "id" | "date"> & { id: string };

const series = (dates: string[], event: SeriesOptions): MarketEvent[] => dates.map((date) => ({
  ...event,
  id: `${event.id}-${date}`,
  date,
}));

const bls = "https://www.bls.gov/schedule/2026/";
const bls2025 = "https://www.bls.gov/schedule/2025/";
const bea = "https://www.bea.gov/news/schedule/full";
const fed = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const ism = "https://www.ismworld.org/supply-management-news-and-reports/reports/rob-report-calendar/";
const nyse = "https://www.nyse.com/markets/hours-calendars";
const adp = "https://adpemploymentreport.com/";

const MARKET_CALENDAR_2025_RESEARCH: MarketEvent[] = [
  ...series([
    "2025-01-15", "2025-02-12", "2025-03-12", "2025-04-10", "2025-05-13", "2025-06-11",
    "2025-07-15", "2025-08-12", "2025-09-11", "2025-10-24", "2025-12-18",
  ], {
    id: "cpi", time: "08:30", title: "미국 소비자물가지수 (CPI)", note: "소비자 물가 · 연준 금리 경로", category: "inflation", source: "BLS", sourceUrl: bls2025, importance: "high",
  }),
];

export const MARKET_CALENDAR_2026: MarketEvent[] = [
  ...series([
    "2026-01-13", "2026-02-13", "2026-03-11", "2026-04-10", "2026-05-12", "2026-06-10",
    "2026-07-14", "2026-08-12", "2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10",
  ], {
    id: "cpi", time: "08:30", title: "미국 소비자물가지수 (CPI)", note: "소비자 물가 · 연준 금리 경로", category: "inflation", source: "BLS", sourceUrl: bls, importance: "high",
  }),
  ...series([
    "2026-01-14", "2026-01-30", "2026-02-27", "2026-03-18", "2026-04-14", "2026-05-13", "2026-06-11",
    "2026-07-15", "2026-08-13", "2026-09-10", "2026-10-15", "2026-11-13", "2026-12-15",
  ], {
    id: "ppi", time: "08:30", title: "미국 생산자물가지수 (PPI)", note: "생산단계 물가 · 마진 압력", category: "inflation", source: "BLS", sourceUrl: bls, importance: "high",
  }),
  ...series([
    "2026-01-09", "2026-02-11", "2026-03-06", "2026-04-03", "2026-05-08", "2026-06-05",
    "2026-07-02", "2026-08-07", "2026-09-04", "2026-10-02", "2026-11-06", "2026-12-04",
  ], {
    id: "nfp", time: "08:30", title: "미국 고용보고서 (NFP)", note: "비농업 고용 · 실업률 · 임금", category: "labor", source: "BLS", sourceUrl: bls, importance: "high",
  }),
  ...series([
    "2026-01-07", "2026-02-05", "2026-03-13", "2026-03-31", "2026-05-05", "2026-06-02",
    "2026-06-30", "2026-08-04", "2026-09-01", "2026-09-29", "2026-11-03", "2026-12-01",
  ], {
    id: "jolts", time: "10:00", title: "미국 JOLTS 구인·이직 보고서", note: "구인건수 · 채용 · 퇴직", category: "labor", source: "BLS", sourceUrl: bls, importance: "medium",
  }),
  ...series([
    "2026-01-07", "2026-02-04", "2026-03-04", "2026-04-01", "2026-05-06", "2026-06-03",
    "2026-07-01", "2026-08-05", "2026-09-02", "2026-09-30", "2026-11-04", "2026-12-02",
  ], {
    id: "adp", time: "08:15", title: "ADP 민간고용 보고서", note: "민간부문 고용 변화", category: "labor", source: "ADP", sourceUrl: adp, importance: "medium",
  }),
  ...series([
    "2026-01-05", "2026-02-02", "2026-03-02", "2026-04-01", "2026-05-01", "2026-06-01",
    "2026-07-01", "2026-08-03", "2026-09-01", "2026-10-01", "2026-11-02", "2026-12-01",
  ], {
    id: "ism-manufacturing", time: "10:00", title: "ISM 제조업 PMI", note: "신규주문 · 고용 · 투입물가", category: "business", source: "ISM", sourceUrl: ism, importance: "high",
  }),
  ...series([
    "2026-01-07", "2026-02-04", "2026-03-04", "2026-04-06", "2026-05-05", "2026-06-03",
    "2026-07-06", "2026-08-05", "2026-09-03", "2026-10-05", "2026-11-04", "2026-12-03",
  ], {
    id: "ism-services", time: "10:00", title: "ISM 서비스업 PMI", note: "서비스 경기 · 고용 · 가격", category: "business", source: "ISM", sourceUrl: ism, importance: "high",
  }),
  ...series([
    "2026-01-22", "2026-02-20", "2026-03-13", "2026-04-09", "2026-04-30", "2026-05-28",
    "2026-06-25", "2026-07-30", "2026-08-26", "2026-09-30", "2026-10-29", "2026-11-25", "2026-12-23",
  ], {
    id: "pce", time: "08:30", title: "개인소득·소비지출 (PCE)", note: "연준 선호 물가지표 · 소비", category: "inflation", source: "BEA", sourceUrl: bea, importance: "high",
  }),
  ...series([
    "2026-01-22", "2026-02-20", "2026-03-13", "2026-04-09", "2026-04-30", "2026-05-28",
    "2026-06-25", "2026-07-30", "2026-08-26", "2026-09-30", "2026-10-29", "2026-11-25", "2026-12-23",
  ], {
    id: "gdp", time: "08:30", title: "미국 GDP 발표", note: "성장률 추정치 · 기업이익", category: "growth", source: "BEA", sourceUrl: bea, importance: "high",
  }),
  ...series([
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
  ], {
    id: "fomc", time: "14:00", title: "FOMC 금리 결정", note: "성명 · 기자회견 · 금리 경로", category: "fed", source: "Federal Reserve", sourceUrl: fed, importance: "high",
  }),
  ...series([
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
    "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  ], {
    id: "nyse-holiday", time: "종일", title: "NYSE 휴장", note: "미국 주식시장 정규장 휴장", category: "market", source: "NYSE", sourceUrl: nyse, importance: "high",
  }),
  ...series(["2026-07-02", "2026-11-27", "2026-12-24"], {
    id: "nyse-early-close", time: "13:00", title: "NYSE 조기 종료", note: "미국 주식시장 오후 1시 종료", category: "market", source: "NYSE", sourceUrl: nyse, importance: "medium",
  }),
].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.title.localeCompare(b.title));

// Research spans years, while the visual calendar remains the curated 2026 view.
export const MARKET_EVENT_CALENDAR: MarketEvent[] = [...MARKET_CALENDAR_2025_RESEARCH, ...MARKET_CALENDAR_2026]
  .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.title.localeCompare(b.title));

export const MARKET_EVENT_CATEGORY_LABELS: Record<MarketEventCategory, string> = {
  fed: "연준",
  inflation: "물가",
  labor: "고용",
  growth: "성장",
  business: "경기",
  market: "시장",
};
