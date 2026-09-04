import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyStatus, FinnhubError, mapEarningsCalendar, mapInsiderTransactions, mapMarketStatus,
  mapMetrics, mapPeers, mapQuote, mapRecommendations,
} from "../lib/finnhub-shapes.ts";

test("403 is classified as a permanent plan limit, not a transient error", () => {
  // The distinction drives behaviour: a caller may retry a 429 or a 502 and must
  // never retry a 403, because the plan will keep saying no.
  assert.equal(classifyStatus(403), "forbidden");
  assert.equal(classifyStatus(429), "rate_limited");
  assert.equal(classifyStatus(500), "upstream");
  assert.equal(classifyStatus(200), null);
  assert.equal(classifyStatus(204), null);
});

test("an unknown ticker returns zeros with HTTP 200 and must be rejected", () => {
  // Finnhub answers 200 with c=0 for a symbol it does not price. Passing that
  // through would put a $0 quote into a position-sizing calculation.
  assert.throws(() => mapQuote("NOPE", { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }), FinnhubError);
  const quote = mapQuote("RKLB", { c: 64.26, d: 0.45, dp: 0.7052, h: 65, l: 63.2, o: 64.76, pc: 63.81, t: 1788552000 });
  assert.equal(quote.current, 64.26);
  assert.equal(quote.previousClose, 63.81);
  assert.equal(quote.asOf, new Date(1788552000 * 1000).toISOString());
});

test("the queried symbol is stripped from its own peer list", () => {
  assert.deepEqual(mapPeers("RKLB", ["NOC", "RKLB", "LHX", "rklb"]), ["NOC", "LHX"]);
  assert.deepEqual(mapPeers("RKLB", []), []);
});

test("metrics pick named fields and leave missing ones null rather than zero", () => {
  const metrics = mapMetrics("RKLB", { metric: { beta: 2.1, peTTM: null, "52WeekHigh": 80, "52WeekHighDate": "2026-07-01", "10DayAverageTradingVolume": 14.86 } });
  assert.equal(metrics.beta, 2.1);
  assert.equal(metrics.peRatio, null);          // a loss-making company has no PE; 0 would be a lie
  assert.equal(metrics.week52High, 80);
  assert.equal(metrics.week52HighDate, "2026-07-01");
  assert.equal(metrics.averageVolume10Day, 14.86);
  assert.equal(metrics.psRatio, null);
  assert.throws(() => mapMetrics("RKLB", {}), FinnhubError);
});

test("the earnings calendar keeps the session-timing flag and drops rows without one", () => {
  const rows = mapEarningsCalendar({ earningsCalendar: [
    { symbol: "AAPL", date: "2026-10-30", hour: "amc", quarter: 4, year: 2026, epsEstimate: 2.1 },
    { symbol: "MSFT", date: "2026-10-28", hour: "", quarter: 1, year: 2027 },
    { symbol: "", date: "2026-10-28" },
    { symbol: "NVDA" },
  ] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hour, "amc");
  assert.equal(rows[1].hour, null);   // an empty string is "unknown", not a timing
  assert.equal(rows[0].epsActual, null);
});

test("net bullish collapses the analyst panel into one signed number", () => {
  const [row] = mapRecommendations("RKLB", [{ period: "2026-09-01", strongBuy: 7, buy: 14, hold: 5, sell: 0, strongSell: 0 }]);
  assert.equal(row.total, 26);
  // (7 + 14 - 0 - 0) / 26
  assert.equal(row.netBullishPct, 80.77);
  const [flat] = mapRecommendations("X", [{ period: "2026-09-01", strongBuy: 0, buy: 2, hold: 0, sell: 2, strongSell: 0 }]);
  assert.equal(flat.netBullishPct, 0);
  const [none] = mapRecommendations("X", [{ period: "2026-09-01" }]);
  assert.equal(none.netBullishPct, null);
});

test("insider rows keep both dates because only the filing date is knowable in time", () => {
  const [row] = mapInsiderTransactions("RKLB", { data: [
    { name: "Klein Frank", share: 925737, change: -458, filingDate: "2026-08-28", transactionDate: "2026-08-26", transactionCode: "S", transactionPrice: 44.1 },
  ] });
  assert.equal(row.filingDate, "2026-08-28");
  assert.equal(row.transactionDate, "2026-08-26");
  assert.equal(row.change, -458);
  assert.equal(mapInsiderTransactions("RKLB", {}).length, 0);
});

test("market status carries the holiday field that the intraday engines lack", () => {
  const open = mapMarketStatus("US", { exchange: "US", isOpen: true, session: "regular", holiday: null, timezone: "America/New_York", t: 1788555979 });
  assert.equal(open.isOpen, true);
  assert.equal(open.holiday, null);
  const shut = mapMarketStatus("US", { isOpen: false, session: null, holiday: "Thanksgiving Day", timezone: "America/New_York" });
  assert.equal(shut.exchange, "US");
  assert.equal(shut.holiday, "Thanksgiving Day");
  assert.equal(shut.session, null);
  assert.ok(shut.asOf); // a missing timestamp falls back to now rather than 1970
});
