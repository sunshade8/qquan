/**
 * D1 and Toss for the 급등락 사례 the owner hands over.
 *
 * `recordSurgeCases` stores the list exactly as given. `collectSurgeCases` then
 * fetches each case's own session — one-minute Toss candles 04:00–20:00 ET, raw
 * prices, plus the previous regular close — once that session is over, and
 * decides which US session the written date meant: the stated date, or the one
 * before it if the owner wrote the KST date. The session whose recomputed move
 * at the snapshot minute agrees with the board's number wins; if neither does,
 * the case is kept but marked `mismatch` so it is looked at, not trusted.
 *
 * Nothing else is downloaded. No screen, no reconstruction — the owner's cases only.
 */

import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db/ensure";
import { fetchTossMinuteCandles, MarketProviderError } from "./market-data.ts";
import { parseTossCandle, type MinuteCandle } from "./live-bars.ts";
import { easternParts, easternWallTimeToEpoch, isWeekday, shiftDate } from "./market-clock.ts";
import { agreesWithBoard, parseCaseList, profileCase, sessionCandidates, sessionComplete, type CaseMinute, type CaseProfile } from "./surge-cases.ts";
import { surgeAgentStatus, SURGE_AGENT_GATES } from "./surge-agent.ts";

function db() {
  return (env as unknown as { DB: D1Database }).DB;
}

type CaseRow = {
  id: string; stated_date: string; symbol: string; board: string; reported_pct: number; rank: number; line: string;
  status: "pending" | "collected" | "mismatch" | "failed"; session_date: string | null; attempts: number; error: string | null;
  profile: string | null; received_at: number; collected_at: number | null;
};

export async function recordSurgeCases(text: string) {
  await ensureSchema();
  const { cases, errors } = parseCaseList(text, easternParts(Date.now()).date);
  const now = Date.now();
  let added = 0;
  for (const item of cases) {
    const result = await db().prepare(
      "INSERT INTO surge_cases (id,stated_date,symbol,board,reported_pct,rank,line,status,received_at) VALUES (?,?,?,?,?,?,?,'pending',?) " +
      // Re-sending the same night corrects the number and rank; an already collected case is re-checked against it.
      "ON CONFLICT(id) DO UPDATE SET reported_pct=excluded.reported_pct, rank=excluded.rank, line=excluded.line, board=excluded.board, status=CASE WHEN surge_cases.reported_pct<>excluded.reported_pct THEN 'pending' ELSE surge_cases.status END",
    ).bind(`${item.statedDate}|${item.symbol}`, item.statedDate, item.symbol, item.board, item.reportedPct, item.rank, item.line, now).run();
    added += result.meta.changes ?? 0;
  }
  return { parsed: cases, errors, stored: added };
}

// ------------------------------------------------------------------ Toss

async function tossPage(symbol: string, before: string, count = 200) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchTossMinuteCandles(symbol, { count, before, adjusted: false });
    } catch (error) {
      if (error instanceof MarketProviderError && error.code === "not_found") return { candles: [], nextBefore: null };
      if (!(error instanceof MarketProviderError) || error.code !== "rate_limit" || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

const toMinute = (candle: MinuteCandle): { date: string; bar: CaseMinute } => {
  const et = easternParts(candle.endMs - 60_000);
  return { date: et.date, bar: [Number(et.time.replace(":", "")), candle.open, candle.high, candle.low, candle.close, candle.volume] };
};

/** 04:00–20:00 ET of one session. Toss skips minutes with no trades, so pages are followed by time, not count. */
async function sessionMinutes(symbol: string, date: string) {
  const floor = easternWallTimeToEpoch(date, "04:00");
  let before: string | null = new Date(easternWallTimeToEpoch(date, "20:00")).toISOString();
  const bars = new Map<number, CaseMinute>();
  for (let page = 0; page < 8 && before; page++) {
    const result = await tossPage(symbol, before);
    const parsed = result.candles.map(parseTossCandle).filter((c): c is MinuteCandle => c !== null);
    for (const candle of parsed) {
      const { date: day, bar } = toMinute(candle);
      if (day === date && bar[0] >= 400) bars.set(bar[0], bar);
    }
    if (!parsed.length) break;
    const oldest = Math.min(...parsed.map((c) => c.endMs));
    if (oldest <= floor + 60_000) break;
    before = result.nextBefore;
  }
  return [...bars.values()].sort((a, b) => a[0] - b[0]);
}

/** The last regular-session minute close before `date` — the reference every move is measured from. */
async function previousClose(symbol: string, date: string) {
  for (let cursor = shiftDate(date, -1), tries = 0; tries < 7; cursor = shiftDate(cursor, -1), tries++) {
    if (!isWeekday(cursor)) continue;
    const result = await tossPage(symbol, new Date(easternWallTimeToEpoch(cursor, "16:00")).toISOString(), 5);
    const last = result.candles.map(parseTossCandle).filter((c): c is MinuteCandle => c !== null).map(toMinute)
      .filter(({ date: day, bar }) => day === cursor && bar[0] >= 930 && bar[0] < 1600)
      .sort((a, b) => b.bar[0] - a.bar[0])[0];
    if (last) return last.bar[4];
  }
  return null;
}

// ------------------------------------------------------------------ collect

async function collectOne(row: CaseRow) {
  const candidates = sessionCandidates(row.stated_date);
  // Resolve only when every session the date could mean is over; otherwise yesterday can look like a match for a multi-day runner.
  if (!candidates.every((date) => sessionComplete(date))) return "waiting" as const;
  let fallback: { date: string; profile: CaseProfile; minutes: CaseMinute[] } | null = null;
  for (const date of candidates) {
    const prevClose = await previousClose(row.symbol, date);
    if (!prevClose) continue;
    const minutes = await sessionMinutes(row.symbol, date);
    if (!minutes.length) continue;
    const profile = profileCase(date, prevClose, minutes);
    fallback ??= { date, profile, minutes };
    if (agreesWithBoard(row.reported_pct, profile)) {
      await save(row, "collected", date, profile, minutes, date === row.stated_date ? null : `${row.stated_date}은(는) 한국 날짜로 보고 미국 ${date} 세션으로 해석`);
      return "collected" as const;
    }
  }
  if (fallback) {
    await save(row, "mismatch", fallback.date, fallback.profile, fallback.minutes,
      `토스 분봉으로 다시 계산한 스냅샷(${fallback.profile.snapshotEt} ET) 등락률 ${fallback.profile.changeAtSnapshotPct}%가 받은 값 ${row.reported_pct}%와 맞지 않습니다 — 날짜나 종목코드를 확인하세요`);
    return "mismatch" as const;
  }
  throw new Error("토스에서 해당 날짜의 분봉이나 전일 종가를 찾지 못했습니다");
}

async function save(row: CaseRow, status: CaseRow["status"], date: string, profile: CaseProfile, minutes: CaseMinute[], note: string | null) {
  await db().prepare("UPDATE surge_cases SET status=?, session_date=?, profile=?, minutes=?, error=?, collected_at=?, attempts=attempts+1 WHERE id=?")
    .bind(status, date, JSON.stringify(profile), JSON.stringify(minutes), note, Date.now(), row.id).run();
}

/** Fetches every pending case whose session is over. Returns what happened, per case. */
export async function collectSurgeCases(limit = 40) {
  await ensureSchema();
  const rows = (await db().prepare("SELECT * FROM surge_cases WHERE status='pending' ORDER BY stated_date, board, rank LIMIT ?").bind(limit).all<CaseRow>()).results;
  const outcome = { collected: 0, mismatch: 0, waiting: 0, failed: 0, errors: [] as string[] };
  for (const row of rows) {
    try {
      outcome[await collectOne(row)]++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof MarketProviderError && (error.code === "ip_allowlist" || error.code === "auth" || error.code === "not_configured")) {
        outcome.errors.push(message);
        break;
      }
      const attempts = row.attempts + 1;
      await db().prepare("UPDATE surge_cases SET attempts=?, error=?, status=? WHERE id=?").bind(attempts, message, attempts >= 3 ? "failed" : "pending", row.id).run();
      outcome.failed++;
      outcome.errors.push(`${row.id}: ${message}`);
    }
  }
  return outcome;
}

// ------------------------------------------------------------------ read

export async function listSurgeCases() {
  await ensureSchema();
  const rows = (await db().prepare(
    "SELECT id,stated_date,symbol,board,reported_pct,rank,line,status,session_date,attempts,error,profile,received_at,collected_at FROM surge_cases ORDER BY stated_date DESC, board, rank",
  ).all<CaseRow>()).results;
  const cases = rows.map((row) => ({
    id: row.id, statedDate: row.stated_date, symbol: row.symbol, board: row.board, reportedPct: row.reported_pct, rank: row.rank,
    status: row.status, sessionDate: row.session_date, note: row.error, profile: row.profile ? JSON.parse(row.profile) as CaseProfile : null,
  }));
  const counts = {
    recorded: cases.length,
    collected: cases.filter((c) => c.status === "collected").length,
    pending: cases.filter((c) => c.status === "pending").length,
    failed: cases.filter((c) => c.status === "failed" || c.status === "mismatch").length,
    nights: new Set(cases.map((c) => c.statedDate)).size,
  };
  return { cases, counts, agent: surgeAgentStatus(counts), gates: SURGE_AGENT_GATES };
}
