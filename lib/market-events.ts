/**
 * The event spine.
 *
 * `eventRoot` was already the de-facto domain key — the static calendar builds
 * ids as `${root}-${date}` and the News planner re-derives it with
 * `startsWith("cpi-")` — but it lived only inside a string, so nothing could
 * join on it. Promoting it to a column is what lets a News measurement, a Lab
 * finding and a strategy rule all refer to the same thing.
 *
 * Surprise is the other half. No free source publishes an economist consensus
 * (Toss serves session hours only, Yahoo exposes no economic calendar, and
 * TradingView is a widget), so `consensus` stays nullable for manual entry and
 * the default surprise basis is a naive-forecast deviation computed from FRED's
 * own point-in-time history. That is weaker than a true consensus surprise and
 * every row says which basis produced it.
 */

import { mean, round, standardDeviation } from "./quant.ts";

/** Mirrors `MarketEventCategory` in `app/market-calendar-data.ts` without importing the calendar itself. */
export type EventCategory = "fed" | "inflation" | "labor" | "growth" | "business" | "market";

export type SurpriseBasis = "consensus" | "naive_previous" | "naive_trailing" | "manual" | "none";

export const SURPRISE_BASIS_LABELS: Record<SurpriseBasis, string> = {
  consensus: "이코노미스트 컨센서스 대비",
  naive_previous: "직전 발표치 대비 (컨센서스 없음)",
  naive_trailing: "직전 12회 평균 대비 (컨센서스 없음)",
  manual: "수동 입력",
  none: "서프라이즈 없음",
};

export type MarketEventRow = {
  id: string;
  eventRoot: string;
  eventDate: string;
  eventTimeEt: string;
  releasedBeforeClose: boolean;
  category: string;
  importance: string;
  title: string;
  unit: string;
  actualInitial: number | null;
  actualRevised: number | null;
  consensus: number | null;
  previous: number | null;
  surprise: number | null;
  surpriseZ: number | null;
  surpriseBasis: string;
  source: string;
};

/**
 * The controlled vocabulary. Everything that references an event — News tests,
 * findings, strategy operands — must use one of these roots, so a single typo
 * cannot silently sever the join. `fredSeries` is null where FRED has no matching
 * series (market holidays, options expiry), which simply means those events carry
 * a schedule but never a value.
 */
/**
 * How the market-watched *headline* number is derived from the raw FRED series.
 *
 * This matters more than it looks. CPIAUCSL is an index level (317, 319, 321…),
 * so comparing a print to its own trailing mean measures the trend, not news —
 * the "surprise" then rises monotonically forever and is worthless as a signal.
 * The headline everyone actually trades is the month-over-month percent change.
 * PAYEMS is a level in thousands whose headline is the month-over-month *diff*
 * ("payrolls +150K"), and UNRATE is already a rate, so its level is the headline.
 */
export type EventTransform = "level" | "diff" | "pct_change";

export const EVENT_ROOTS: Array<{ root: string; label: string; category: EventCategory; fredSeries: string | null; unit: string; transform: EventTransform }> = [
  { root: "cpi", label: "소비자물가지수 (CPI)", category: "inflation", fredSeries: "CPIAUCSL", unit: "index", transform: "pct_change" },
  { root: "core-cpi", label: "근원 CPI", category: "inflation", fredSeries: "CPILFESL", unit: "index", transform: "pct_change" },
  { root: "ppi", label: "생산자물가지수 (PPI)", category: "inflation", fredSeries: "PPIACO", unit: "index", transform: "pct_change" },
  { root: "pce", label: "개인소비지출 물가 (PCE)", category: "inflation", fredSeries: "PCEPI", unit: "index", transform: "pct_change" },
  { root: "core-pce", label: "근원 PCE", category: "inflation", fredSeries: "PCEPILFE", unit: "index", transform: "pct_change" },
  { root: "nfp", label: "비농업 고용 (NFP)", category: "labor", fredSeries: "PAYEMS", unit: "thousands", transform: "diff" },
  { root: "payrolls", label: "고용보고서", category: "labor", fredSeries: "PAYEMS", unit: "thousands", transform: "diff" },
  { root: "unemployment", label: "실업률", category: "labor", fredSeries: "UNRATE", unit: "percent", transform: "level" },
  { root: "jobless-claims", label: "주간 신규 실업수당 청구", category: "labor", fredSeries: "ICSA", unit: "count", transform: "level" },
  { root: "adp", label: "ADP 민간 고용", category: "labor", fredSeries: null, unit: "thousands", transform: "diff" },
  { root: "gdp", label: "국내총생산 (GDP)", category: "growth", fredSeries: "GDPC1", unit: "billions", transform: "pct_change" },
  { root: "retail-sales", label: "소매판매", category: "growth", fredSeries: "RSAFS", unit: "millions", transform: "pct_change" },
  { root: "ism-manufacturing", label: "ISM 제조업 PMI", category: "business", fredSeries: null, unit: "index", transform: "level" },
  { root: "ism-services", label: "ISM 서비스업 PMI", category: "business", fredSeries: null, unit: "index", transform: "level" },
  { root: "fomc", label: "FOMC 정책결정", category: "fed", fredSeries: "DFEDTARU", unit: "percent", transform: "level" },
  { root: "consumer-sentiment", label: "미시간대 소비자심리", category: "growth", fredSeries: "UMCSENT", unit: "index", transform: "level" },
  { root: "jolts", label: "구인·이직 보고서 (JOLTS)", category: "labor", fredSeries: "JTSJOL", unit: "thousands", transform: "level" },
  // Market-structure days carry a schedule but never a released value.
  { root: "nyse-holiday", label: "NYSE 휴장", category: "market", fredSeries: null, unit: "", transform: "level" },
  { root: "nyse-early-close", label: "NYSE 조기 폐장", category: "market", fredSeries: null, unit: "", transform: "level" },
];

const ROOT_INDEX = new Map(EVENT_ROOTS.map((item) => [item.root, item]));

export function eventRootInfo(root: string) {
  return ROOT_INDEX.get(root) ?? null;
}

export function knownEventRoots() {
  return EVENT_ROOTS.map((item) => item.root);
}

/**
 * Splits a static calendar id (`cpi-2025-09-11`) into its root and date. The
 * date suffix is always a full ISO date, so the root is everything before it.
 */
export function parseCalendarId(id: string): { root: string; date: string } | null {
  const match = id.match(/^(.+)-(\d{4}-\d{2}-\d{2})$/);
  return match ? { root: match[1], date: match[2] } : null;
}

/** US equity sessions close at 16:00 ET, so a release before then is priced into that day's close. */
export function releasedBeforeClose(timeEt: string) {
  const match = timeEt.match(/(\d{1,2}):(\d{2})/);
  if (!match) return true;
  return Number(match[1]) * 60 + Number(match[2]) < 16 * 60;
}


export type Vintage = { observationDate: string; realtimeStart: string; value: number; latest: number | null };

/**
 * Turns raw series vintages into the headline numbers a release actually prints.
 *
 * `diff` and `pct_change` need the prior observation period, and that prior value
 * must itself be the one available at the time — so the previous *initial* print
 * is used, never a later revision of it.
 */
export function applyTransform(vintages: Vintage[], transform: EventTransform): Array<Vintage & { headline: number | null; headlineLatest: number | null }> {
  const ordered = [...vintages].sort((left, right) => left.observationDate.localeCompare(right.observationDate));
  return ordered.map((row, index) => {
    const prior = index > 0 ? ordered[index - 1] : null;
    if (transform === "level") return { ...row, headline: round(row.value, 4), headlineLatest: row.latest === null ? null : round(row.latest, 4) };
    if (!prior) return { ...row, headline: null, headlineLatest: null };
    if (transform === "diff") {
      return {
        ...row,
        headline: round(row.value - prior.value, 4),
        headlineLatest: row.latest === null || prior.latest === null ? null : round(row.latest - prior.latest, 4),
      };
    }
    return {
      ...row,
      headline: prior.value ? round((row.value / prior.value - 1) * 100, 4) : null,
      headlineLatest: row.latest === null || prior.latest === null || !prior.latest ? null : round((row.latest / prior.latest - 1) * 100, 4),
    };
  });
}

export type SurpriseInput = { eventDate: string; actualInitial: number | null; previous: number | null; consensus: number | null };

/**
 * Surprise per event, plus a z-score so different units are comparable.
 *
 * Preference order is consensus → deviation from the trailing mean → deviation
 * from the previous print. Only prior observations feed the trailing mean, so
 * the value at event *i* never depends on anything released after it.
 */
export function computeSurprises(rows: SurpriseInput[], trailing = 12): Array<{ eventDate: string; surprise: number | null; surpriseZ: number | null; basis: SurpriseBasis }> {
  const ordered = [...rows].sort((left, right) => left.eventDate.localeCompare(right.eventDate));
  const history: number[] = [];
  const out: Array<{ eventDate: string; surprise: number | null; surpriseZ: number | null; basis: SurpriseBasis }> = [];
  const deviations: number[] = [];

  for (const row of ordered) {
    if (row.actualInitial === null) {
      out.push({ eventDate: row.eventDate, surprise: null, surpriseZ: null, basis: "none" });
      continue;
    }
    let surprise: number | null = null;
    let basis: SurpriseBasis = "none";
    if (row.consensus !== null) {
      surprise = row.actualInitial - row.consensus;
      basis = "consensus";
    } else if (history.length >= 3) {
      surprise = row.actualInitial - mean(history.slice(-trailing))!;
      basis = "naive_trailing";
    } else if (row.previous !== null) {
      surprise = row.actualInitial - row.previous;
      basis = "naive_previous";
    }
    // The z-score uses only deviations already observed, so it is point-in-time safe.
    const deviation = standardDeviation(deviations.slice(-Math.max(trailing, 24)));
    const z = surprise !== null && deviations.length >= 4 && deviation ? round(surprise / deviation, 3) : null;
    out.push({ eventDate: row.eventDate, surprise: surprise === null ? null : round(surprise, 4), surpriseZ: z, basis });
    if (surprise !== null) deviations.push(surprise);
    history.push(row.actualInitial);
  }
  return out;
}
