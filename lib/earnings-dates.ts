/**
 * Earnings announcement dates from SEC EDGAR 8-K filings.
 *
 * Free earnings calendars give four quarters and no timestamp, which is useless
 * for a study that needs five years and needs to know whether the market could
 * have traded the news that day. EDGAR gives both: every earnings release is an
 * 8-K carrying item 2.02 ("Results of Operations and Financial Condition"), and
 * the acceptance timestamp says when it landed.
 *
 * The timestamp is the point of this module. A release accepted at 16:21 ET is
 * not tradable until the next session's open, and a study that anchors it to the
 * filing date measures the day *before* the news — a half-day look-ahead that
 * silently reverses the sign of anything it touches. Each release is therefore
 * classified by when it landed relative to regular hours, and the reaction date
 * is shifted forward for after-close releases.
 *
 * Two honest limits. EDGAR acceptance is when the filing was accepted, minutes
 * after the press release rather than at it; that gap is small next to the
 * session boundaries being tested but it is not zero. And item 2.02 is
 * occasionally used for preliminary results or a mid-quarter update, so a few
 * dates are financial announcements that are not the quarterly report.
 */

const EDGAR_SUBMISSIONS = "https://data.sec.gov/submissions";
const SEC_TICKER_MAP = "https://www.sec.gov/files/company_tickers.json";

/** SEC fair-access asks every caller to declare itself. Override per deployment. */
function userAgent() {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SEC_USER_AGENT
    ?? "QQuant Research Lab (contact via site owner)";
}

export type ReleaseTiming = "before_open" | "during_session" | "after_close";

export const RELEASE_TIMING_LABELS: Record<ReleaseTiming, string> = {
  before_open: "장 시작 전",
  during_session: "장중",
  after_close: "장 마감 후",
};

export type EarningsRelease = {
  /** EDGAR filing date, as an ET calendar date. */
  filedDate: string;
  acceptedEt: string;
  timing: ReleaseTiming;
  /**
   * The first calendar date whose session could trade the news from its open.
   * Callers anchor this forward to the next actual trading session, so a Friday
   * after-close release resolves to Monday without this module owning a holiday
   * calendar.
   */
  reactionDate: string;
  accession: string;
  items: string;
};

type EdgarRecent = {
  form: string[];
  items: Array<string | null>;
  filingDate: string[];
  acceptanceDateTime: string[];
  accessionNumber: string[];
};

const RTH_OPEN_MINUTE = 9 * 60 + 30;
const RTH_CLOSE_MINUTE = 16 * 60;

const etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

/** UTC instant -> {date, minutes} in New York, DST included. */
export function toEasternParts(iso: string) {
  const parsed = Date.parse(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  if (!Number.isFinite(parsed)) return null;
  const parts = Object.fromEntries(etParts.formatToParts(new Date(parsed)).map((part) => [part.type, part.value]));
  // Intl renders midnight as "24" in some ICU builds; normalise before arithmetic.
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + Number(parts.minute),
    label: `${parts.year}-${parts.month}-${parts.day} ${String(hour).padStart(2, "0")}:${parts.minute}`,
  };
}

function nextCalendarDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function classifyRelease(acceptanceIso: string, filingDate: string): Omit<EarningsRelease, "accession" | "items"> | null {
  const eastern = toEasternParts(acceptanceIso);
  if (!eastern) return null;
  const timing: ReleaseTiming = eastern.minutes < RTH_OPEN_MINUTE ? "before_open"
    : eastern.minutes >= RTH_CLOSE_MINUTE ? "after_close" : "during_session";
  return {
    filedDate: filingDate,
    acceptedEt: eastern.label,
    timing,
    // Only an after-close release moves to the following date. A pre-open release
    // is priced into that same session's open, which is where the study measures.
    reactionDate: timing === "after_close" ? nextCalendarDate(eastern.date) : eastern.date,
  };
}

let tickerMap: Map<string, string> | null = null;

/** Ticker -> zero-padded CIK. Cached for the life of the isolate; the file is ~1MB. */
export async function resolveCik(symbol: string): Promise<string | null> {
  const ticker = symbol.trim().toUpperCase();
  if (!ticker) return null;
  if (!tickerMap) {
    const response = await fetch(SEC_TICKER_MAP, { headers: { "user-agent": userAgent(), accept: "application/json" } });
    if (!response.ok) throw new Error(`SEC 티커 목록을 가져오지 못했습니다 (HTTP ${response.status}).`);
    const payload = await response.json() as Record<string, { cik_str: number; ticker: string }>;
    tickerMap = new Map(Object.values(payload).map((entry) => [entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0")]));
  }
  return tickerMap.get(ticker) ?? null;
}

function collectReleases(recent: EdgarRecent, from: string, to: string) {
  const releases: EarningsRelease[] = [];
  for (let index = 0; index < recent.form.length; index += 1) {
    if (recent.form[index] !== "8-K") continue;
    const items = recent.items[index] ?? "";
    // Item 2.02 is the earnings release itself. 9.01 (exhibits) rides along with
    // it and must not be matched on its own.
    if (!items.split(",").some((item) => item.trim() === "2.02")) continue;
    const filingDate = recent.filingDate[index];
    if (filingDate < from || filingDate > to) continue;
    const classified = classifyRelease(recent.acceptanceDateTime[index], filingDate);
    if (!classified) continue;
    releases.push({ ...classified, accession: recent.accessionNumber[index], items });
  }
  return releases;
}

export type EarningsHistory = {
  symbol: string;
  cik: string;
  releases: EarningsRelease[];
  timingCounts: Record<ReleaseTiming, number>;
  oldestFilingSeen: string | null;
  /** True when the archive was not walked far enough to cover `from`. */
  truncated: boolean;
};

/**
 * Every item-2.02 8-K between `from` and `to`, newest first in EDGAR's own order
 * and returned oldest first.
 *
 * EDGAR splits a company's filing index once it exceeds a thousand entries, and
 * the overflow files are only fetched when `recent` does not already reach back
 * past `from`. A frequent filer would otherwise return four years of a five-year
 * request and look like a company that stopped reporting.
 */
export async function fetchEarningsHistory(symbol: string, from: string, to: string): Promise<EarningsHistory> {
  const cik = await resolveCik(symbol);
  if (!cik) throw new Error(`${symbol}의 SEC CIK를 찾지 못했습니다. 미국 상장 발행인이 아닐 수 있습니다.`);
  const headers = { "user-agent": userAgent(), accept: "application/json" };

  const response = await fetch(`${EDGAR_SUBMISSIONS}/CIK${cik}.json`, { headers });
  if (!response.ok) throw new Error(`EDGAR 제출 이력을 가져오지 못했습니다 (HTTP ${response.status}).`);
  const payload = await response.json() as { filings: { recent: EdgarRecent; files?: Array<{ name: string; filingFrom: string }> } };

  const releases = collectReleases(payload.filings.recent, from, to);
  let oldest = payload.filings.recent.filingDate.at(-1) ?? null;
  let truncated = false;

  if (oldest !== null && oldest > from) {
    const archives = (payload.filings.files ?? []).filter((file) => file.filingFrom <= oldest!);
    if (!archives.length) truncated = true;
    for (const file of archives) {
      const archive = await fetch(`${EDGAR_SUBMISSIONS}/${file.name}`, { headers });
      if (!archive.ok) { truncated = true; continue; }
      const older = await archive.json() as EdgarRecent;
      releases.push(...collectReleases(older, from, to));
      const archiveOldest = older.filingDate.at(-1);
      if (archiveOldest && archiveOldest < oldest!) oldest = archiveOldest;
      if (oldest <= from) break;
    }
    if (oldest !== null && oldest > from) truncated = true;
  }

  releases.sort((left, right) => left.filedDate.localeCompare(right.filedDate));
  const timingCounts: Record<ReleaseTiming, number> = { before_open: 0, during_session: 0, after_close: 0 };
  for (const release of releases) timingCounts[release.timing] += 1;
  return { symbol: symbol.toUpperCase(), cik, releases, timingCounts, oldestFilingSeen: oldest, truncated };
}
