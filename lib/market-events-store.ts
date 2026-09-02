/**
 * D1 persistence and seeding for the event spine. The taxonomy, id parsing and
 * surprise arithmetic live in `lib/market-events.ts` so they stay unit-testable
 * without a database, matching `strategy.ts` / `strategy-store.ts`.
 */

import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { ensureSchema } from "@/db/ensure";
import { marketEvents } from "@/db/schema";
import { MARKET_EVENT_CALENDAR } from "@/app/market-calendar-data";
import { eventRootInfo, parseCalendarId, releasedBeforeClose, type MarketEventRow } from "@/lib/market-events";

/** Seeds the event table from the hand-maintained static calendar (schedule only, no values). */
export function calendarSeedRows(today: string) {
  const now = new Date();
  return MARKET_EVENT_CALENDAR.flatMap((event) => {
    const parsed = parseCalendarId(event.id);
    if (!parsed) return [];
    return [{
      id: event.id,
      eventRoot: parsed.root,
      eventDate: event.date,
      eventTimeEt: event.time,
      releasedBeforeClose: releasedBeforeClose(event.time),
      category: event.category,
      importance: event.importance,
      title: event.title,
      unit: eventRootInfo(parsed.root)?.unit ?? "",
      actualInitial: null, actualRevised: null, consensus: null, previous: null,
      surprise: null, surpriseZ: null,
      surpriseBasis: event.date > today ? "none" : "",
      source: event.source,
      updatedAt: now,
    }];
  });
}

export async function upsertMarketEvents(rows: Array<Omit<MarketEventRow, "id"> & { id: string; updatedAt?: Date }>) {
  if (!rows.length) return 0;
  await ensureSchema();
  const db = getDb();
  const now = new Date();
  // D1 caps bound parameters per statement; these rows are wide, so keep chunks small.
  for (let index = 0; index < rows.length; index += 5) {
    const chunk = rows.slice(index, index + 5).map((row) => ({ ...row, updatedAt: row.updatedAt ?? now }));
    await db.insert(marketEvents).values(chunk).onConflictDoUpdate({
      target: [marketEvents.eventRoot, marketEvents.eventDate],
      set: {
        eventTimeEt: chunk[0].eventTimeEt, title: chunk[0].title, category: chunk[0].category, importance: chunk[0].importance,
        updatedAt: now,
      },
    });
  }
  return rows.length;
}

export async function listMarketEvents(roots: string[], from: string, to: string): Promise<MarketEventRow[]> {
  await ensureSchema();
  const where = roots.length
    ? and(inArray(marketEvents.eventRoot, roots), gte(marketEvents.eventDate, from), lte(marketEvents.eventDate, to))
    : and(gte(marketEvents.eventDate, from), lte(marketEvents.eventDate, to));
  const rows = await getDb().select().from(marketEvents).where(where).orderBy(asc(marketEvents.eventDate));
  return rows.map((row) => ({ ...row, releasedBeforeClose: Boolean(row.releasedBeforeClose) }));
}

export async function updateEventValues(eventRoot: string, eventDate: string, values: Partial<Pick<MarketEventRow, "actualInitial" | "actualRevised" | "consensus" | "previous" | "surprise" | "surpriseZ" | "surpriseBasis">>) {
  await ensureSchema();
  await getDb().update(marketEvents).set({ ...values, updatedAt: new Date() })
    .where(and(eq(marketEvents.eventRoot, eventRoot), eq(marketEvents.eventDate, eventDate)));
}
