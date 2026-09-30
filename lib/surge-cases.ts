/**
 * 급등락 사례 — the owner's own record of Toss TOP_GAINERS / TOP_LOSERS.
 *
 * Toss ranks surges live only (no as-of), and the ranking changes hour by hour,
 * so a past ranking cannot be rebuilt from daily bars — a "+10% on the day"
 * screen is not what Toss showed and is too small a move to call a surge. The
 * owner therefore captures the top 10 of each board every night at 00:00 KST
 * and hands it over as `날짜/종목/등락폭` lines. Those cases, and only those, are
 * the dataset.
 *
 * What a case means in time: 00:00 KST is 11:00 ET in summer (EDT) and 10:00 ET
 * in winter (EST) — inside the US regular session. So each case is "this name
 * was on the board at that minute, with this move". Everything before that
 * minute is context the ranking already reflected; everything after it is what
 * a rule triggered by the ranking could trade. `profileCase` keeps the two apart.
 *
 * Pure: imported by the Node test runner.
 */

import { easternParts, easternWallTimeToEpoch, isWeekday, shiftDate, timeMinutes } from "./market-clock.ts";

export type SurgeBoard = "gainers" | "losers";

export type ParsedCase = {
  /** The date as written, YYYY-MM-DD. Which US session it names is resolved against the minutes (`resolveSession`). */
  statedDate: string;
  symbol: string;
  /** Change the board showed, percent (signed). */
  reportedPct: number;
  board: SurgeBoard;
  /** Position within its board as given, or by order of appearance. */
  rank: number;
  line: string;
};

const pad = (value: number) => String(value).padStart(2, "0");

function inferYear(month: number, reference: string) {
  const year = Number(reference.slice(0, 4));
  // A December list sent in early January belongs to the year before.
  return month > Number(reference.slice(5, 7)) + 1 ? year - 1 : year;
}

function readDate(tokens: string[], reference: string): { date: string; used: number } | null {
  const [a, b, c] = tokens;
  let match = a?.match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/) ?? a?.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return { date: `${match[1]}-${pad(+match[2])}-${pad(+match[3])}`, used: 1 };
  if (/^\d{4}$/.test(a ?? "") && /^\d{1,2}$/.test(b ?? "") && /^\d{1,2}$/.test(c ?? "")) return { date: `${a}-${pad(+b)}-${pad(+c)}`, used: 3 };
  match = a?.match(/^(\d{1,2})[-.](\d{1,2})$/) ?? null;
  if (match) return { date: `${inferYear(+match[1], reference)}-${pad(+match[1])}-${pad(+match[2])}`, used: 1 };
  // "9/30/SYM/+25" splits into 9, 30, SYM, +25: two small integers followed by a ticker.
  if (/^\d{1,2}$/.test(a ?? "") && /^\d{1,2}$/.test(b ?? "") && /^[A-Za-z]/.test(c ?? "") && +a >= 1 && +a <= 12 && +b >= 1 && +b <= 31) {
    return { date: `${inferYear(+a, reference)}-${pad(+a)}-${pad(+b)}`, used: 2 };
  }
  return null;
}

/**
 * Reads the owner's list. One case per line as `날짜/종목/등락폭`; `/`, `,`, tabs
 * and spaces all separate. A line holding only a date sets the date for the
 * lines after it. A leading integer before the ticker is taken as the rank.
 */
export function parseCaseList(text: string, reference = new Date().toISOString().slice(0, 10)) {
  const cases: ParsedCase[] = [];
  const errors: Array<{ line: string; reason: string }> = [];
  const seen = new Map<string, number>();
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const normal = line.replace(/[−–—]/g, "-").replace(/[％%]/g, "").replace(/[：:]/g, " ");
    let tokens = normal.split(/[/,\t|]+|\s+/).filter(Boolean);
    const date = readDate(tokens, reference);
    if (date) {
      current = date.date;
      tokens = tokens.slice(date.used);
      if (!tokens.length) continue;
    }
    if (!current) { errors.push({ line, reason: "날짜가 없습니다" }); continue; }
    const symbolAt = tokens.findIndex((token) => /^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(token));
    if (symbolAt < 0) { errors.push({ line, reason: "종목코드를 찾지 못했습니다" }); continue; }
    const symbol = tokens[symbolAt].toUpperCase();
    const pct = tokens.slice(symbolAt + 1).find((token) => /^[+-]?\d+(\.\d+)?$/.test(token));
    if (pct === undefined) { errors.push({ line, reason: "등락폭을 찾지 못했습니다" }); continue; }
    const reportedPct = Number(pct);
    if (!Number.isFinite(reportedPct) || reportedPct === 0) { errors.push({ line, reason: "등락폭이 0이거나 숫자가 아닙니다" }); continue; }
    const board: SurgeBoard = reportedPct > 0 ? "gainers" : "losers";
    const given = tokens.slice(0, symbolAt).find((token) => /^\d{1,3}$/.test(token));
    const key = `${current}|${board}`;
    const order = (seen.get(key) ?? 0) + 1;
    seen.set(key, order);
    cases.push({ statedDate: current, symbol, reportedPct, board, rank: given ? Number(given) : order, line });
  }
  return { cases, errors };
}

/** 00:00 KST on the night after US session `date`, as an ET clock: "11:00" (EDT) or "10:00" (EST). */
export function snapshotClock(date: string) {
  return easternParts(Date.parse(`${shiftDate(date, 1)}T00:00:00+09:00`)).time;
}

/** The US sessions a stated date can mean: the date itself, or — if it was written as the KST date — the session before. */
export function sessionCandidates(statedDate: string) {
  let previous = shiftDate(statedDate, -1);
  while (!isWeekday(previous)) previous = shiftDate(previous, -1);
  return isWeekday(statedDate) ? [statedDate, previous] : [previous];
}

/** A session's minutes can be read once its after-hours session is over (20:00 ET). */
export function sessionComplete(date: string, now = Date.now()) {
  return now >= easternWallTimeToEpoch(date, "20:00");
}

/** One-minute bar keyed by its ET start: [HHMM, open, high, low, close, volume]. */
export type CaseMinute = [number, number, number, number, number, number];

export type CaseProfile = {
  date: string;
  snapshotEt: string;
  prevClose: number;
  /** Move vs the previous regular close at the snapshot minute — what the board showed, recomputed. */
  changeAtSnapshotPct: number | null;
  snapshotPrice: number | null;
  premarket: { high: number; low: number; last: number; volume: number } | null;
  regular: { open: number; high: number; low: number; close: number; volume: number; highAt: string; lowAt: string } | null;
  /** Before the snapshot: what put the name on the board. */
  beforeSnapshot: { highPct: number; lowPct: number; volume: number } | null;
  /** After the snapshot to 16:00: what a rule triggered by the board could have traded. */
  afterSnapshot: { toClosePct: number; maxUpPct: number; maxDownPct: number; maxUpAt: string; maxDownAt: string; volume: number } | null;
  dayChangePct: number | null;
  regularMinutes: number;
};

const hhmm = (value: number) => `${pad(Math.floor(value / 100))}:${pad(value % 100)}`;
const minutesOf = (value: number) => Math.floor(value / 100) * 60 + (value % 100);
const round = (value: number, digits = 3) => Number(value.toFixed(digits));

/** Pre-session, session and post-snapshot facts from a case's minutes. */
export function profileCase(date: string, prevClose: number, minutes: CaseMinute[]): CaseProfile {
  const snapshotEt = snapshotClock(date);
  const snapshot = timeMinutes(snapshotEt);
  const pre = minutes.filter((m) => minutesOf(m[0]) >= 240 && minutesOf(m[0]) < 570);
  const regular = minutes.filter((m) => minutesOf(m[0]) >= 570 && minutesOf(m[0]) < 960);
  // A bar starting at 10:59 closes at 11:00 — the last price the 11:00 board could have seen.
  const before = regular.filter((m) => minutesOf(m[0]) + 1 <= snapshot);
  const after = regular.filter((m) => minutesOf(m[0]) >= snapshot);
  const pct = (price: number) => round((price / prevClose - 1) * 100, 2);
  const extreme = (rows: CaseMinute[], pick: "max" | "min") => rows.reduce((best, m) => (pick === "max" ? (m[2] > best[2] ? m : best) : (m[3] < best[3] ? m : best)), rows[0]);
  const snapshotPrice = before.at(-1)?.[4] ?? null;
  const high = regular.length ? extreme(regular, "max") : null;
  const low = regular.length ? extreme(regular, "min") : null;
  const afterHigh = after.length ? extreme(after, "max") : null;
  const afterLow = after.length ? extreme(after, "min") : null;
  const sum = (rows: CaseMinute[]) => rows.reduce((total, m) => total + m[5], 0);
  return {
    date, snapshotEt, prevClose,
    changeAtSnapshotPct: snapshotPrice === null ? null : pct(snapshotPrice),
    snapshotPrice,
    premarket: pre.length ? { high: Math.max(...pre.map((m) => m[2])), low: Math.min(...pre.map((m) => m[3])), last: pre.at(-1)![4], volume: sum(pre) } : null,
    regular: regular.length && high && low ? {
      open: regular[0][1], high: high[2], low: low[3], close: regular.at(-1)![4], volume: sum(regular), highAt: hhmm(high[0]), lowAt: hhmm(low[0]),
    } : null,
    beforeSnapshot: before.length ? { highPct: pct(Math.max(...before.map((m) => m[2]))), lowPct: pct(Math.min(...before.map((m) => m[3]))), volume: sum(before) } : null,
    afterSnapshot: after.length && snapshotPrice && afterHigh && afterLow ? {
      toClosePct: round((after.at(-1)![4] / snapshotPrice - 1) * 100, 2),
      maxUpPct: round((afterHigh[2] / snapshotPrice - 1) * 100, 2),
      maxDownPct: round((afterLow[3] / snapshotPrice - 1) * 100, 2),
      maxUpAt: hhmm(afterHigh[0]), maxDownAt: hhmm(afterLow[0]), volume: sum(after),
    } : null,
    dayChangePct: regular.length ? pct(regular.at(-1)![4]) : null,
    regularMinutes: regular.length,
  };
}

/**
 * Does a session's recomputed snapshot move agree with what the board showed?
 * Toss's own feed and ours differ by a tick or two, and the owner may copy the
 * number a minute late, so agreement is loose: same sign and within 3 points or
 * 30% of the move, whichever is wider.
 */
export function agreesWithBoard(reportedPct: number, profile: CaseProfile) {
  const seen = profile.changeAtSnapshotPct;
  if (seen === null || Math.sign(seen) !== Math.sign(reportedPct)) return false;
  return Math.abs(seen - reportedPct) <= Math.max(3, Math.abs(reportedPct) * 0.3);
}
