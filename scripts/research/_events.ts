/**
 * Macro event dates for the calendar hypotheses.
 *
 * The local D1 only carries 2026, so FOMC announcement dates come from the
 * Federal Reserve's own calendar pages and CPI / employment release dates from
 * the FRED releases API. Both are cached to disk.
 *
 * Sources
 * - FOMC: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm and
 *   /monetarypolicy/fomchistorical{YYYY}.htm — the date of the policy statement,
 *   which is the second day of a two-day meeting, released at 14:00 ET.
 * - CPI (release 10) and Employment Situation (release 50):
 *   https://api.stlouisfed.org/fred/release/dates
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache");

/**
 * Statement releases that were *not* scheduled meetings, hand-checked against the
 * Fed's historical pages. Leaving them in would put a study of "the day before a
 * scheduled meeting" on top of an emergency intermeeting cut.
 */
const UNSCHEDULED = new Set([
  "2019-10-11", // repo / T-bill purchase announcement
  "2020-03-03", // emergency intermeeting cut
  "2020-03-15", // emergency Sunday cut (replaced the cancelled Mar 17-18 meeting)
  "2020-03-23", // notation vote, unlimited QE
  "2020-03-31", // notation vote, FIMA repo facility
  "2020-08-27", // Statement on Longer-Run Goals (Jackson Hole), not a meeting
  "2025-08-22", // framework statement, not a meeting
]);

function fredKey() {
  const raw = readFileSync(join(HERE, "..", "..", ".dev.vars"), "utf8");
  const line = raw.split("\n").find((l) => l.startsWith("FRED_API_KEY="));
  const key = line?.slice("FRED_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
  if (!key) throw new Error("FRED_API_KEY missing from .dev.vars");
  return key;
}

export async function fomcDates(): Promise<string[]> {
  const path = join(CACHE, "fomc-dates.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const pages = ["https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"];
  for (let year = 2015; year <= 2020; year += 1) pages.push(`https://www.federalreserve.gov/monetarypolicy/fomchistorical${year}.htm`);
  const found = new Set<string>();
  for (const page of pages) {
    const response = await fetch(page, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`Fed calendar ${page}: HTTP ${response.status}`);
    const html = await response.text();
    for (const match of html.matchAll(/monetary(\d{4})(\d{2})(\d{2})a\.htm/g)) {
      found.add(`${match[1]}-${match[2]}-${match[3]}`);
    }
  }
  const dates = [...found].filter((date) => !UNSCHEDULED.has(date)).sort();
  writeFileSync(path, JSON.stringify(dates));
  return dates;
}

async function fredReleaseDates(releaseId: number, label: string): Promise<string[]> {
  const path = join(CACHE, `fred-release-${releaseId}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const url = `https://api.stlouisfed.org/fred/release/dates?release_id=${releaseId}&api_key=${fredKey()}&file_type=json&realtime_start=2015-01-01&realtime_end=2026-09-05&limit=1000`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`FRED ${label}: HTTP ${response.status}`);
  const payload = await response.json() as { release_dates?: Array<{ date: string }> };
  const dates = [...new Set((payload.release_dates ?? []).map((entry) => entry.date))].sort();
  writeFileSync(path, JSON.stringify(dates));
  return dates;
}

export const cpiDates = () => fredReleaseDates(10, "CPI");
export const nfpDates = () => fredReleaseDates(50, "Employment Situation");
