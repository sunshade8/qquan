/** Cash-equity calendar, checked against NYSE's published calendars. Unknown years fail closed. */
export const CT_CALENDAR_VERSION = "nyse-2025-2028-20261012";
export const CT_CALENDAR_SOURCES = [
  "https://www.nyse.com/trade/hours-calendars",
  "https://www.nyse.com/publicdocs/ICE_NYSE_2025_Yearly_Trading_Calendar.pdf",
];
const holidays = new Set([
  "2025-01-01",
  "2025-01-09",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
  "2028-01-17",
  "2028-02-21",
  "2028-04-14",
  "2028-05-29",
  "2028-06-19",
  "2028-07-04",
  "2028-09-04",
  "2028-11-23",
  "2028-12-25",
]);
const early = new Set([
  "2025-07-03",
  "2025-11-28",
  "2025-12-24",
  "2026-11-27",
  "2026-12-24",
  "2027-11-26",
  "2028-07-03",
  "2028-11-24",
]);
export function ctStockSession(date: string) {
  if (!/^202[5-8]-\d\d-\d\d$/.test(date))
    throw new Error("검증된 CT 주식 캘린더 범위(2025–2028) 밖");
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  if (weekday === 0 || weekday === 6 || holidays.has(date)) return null;
  return { open: "09:30", close: early.has(date) ? "13:00" : "16:00" };
}
