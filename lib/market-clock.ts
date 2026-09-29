/**
 * New York wall-clock helpers for the relay runner and backtest.
 *
 * Slots are defined in ET because that is where the sessions are, while the
 * server and the Toss API speak UTC and KST. Everything here goes through
 * `Intl` so daylight saving is never hand-coded. Pure: imported by Node tests.
 */

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
});

export type EasternParts = { date: string; time: string; minutes: number; seconds: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function easternParts(epochMs: number): EasternParts {
  const parts = partsFormatter.formatToParts(new Date(epochMs));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(pick("hour")) % 24;
  const minute = Number(pick("minute"));
  return {
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    time: `${String(hour).padStart(2, "0")}:${pick("minute")}`,
    minutes: hour * 60 + minute,
    seconds: hour * 3600 + minute * 60 + Number(pick("second")),
    weekday: WEEKDAYS[pick("weekday")] ?? 0,
  };
}

export const timeMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Epoch milliseconds of a New York wall-clock time on a date, DST included. */
export function easternWallTimeToEpoch(date: string, time: string) {
  const guess = Date.parse(`${date}T${time}:00Z`);
  // Two passes: the offset at the guess can differ from the offset at the answer
  // only across a DST switch, and the second pass settles it.
  let epoch = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = easternParts(epoch);
    const seenEpoch = Date.parse(`${seen.date}T${seen.time}:00Z`);
    epoch += guess - seenEpoch;
  }
  return epoch;
}

export function isWeekday(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

export function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
