import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSpec, signalSeries, specEventRoots, warmupDays } from "../lib/strategy.ts";
import { applyTransform, computeSurprises, parseCalendarId, releasedBeforeClose } from "../lib/market-events.ts";

/** Ten consecutive weekday sessions starting Monday 2026-01-05. */
function sessions(count = 10, start = "2026-01-05") {
  const rows = [];
  const day = new Date(`${start}T00:00:00Z`);
  while (rows.length < count) {
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      rows.push({ date: day.toISOString().slice(0, 10), open: 100, high: 101, low: 99, close: 100, volume: 1_000_000 });
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return rows;
}

function spec(entry, exit = []) {
  return normalizeSpec({
    name: "이벤트 전략",
    hypothesis: { thesis: "t", mechanism: "m", prediction: "p", falsification: "f" },
    universe: ["SPY"], entry, exit,
  }, "2026-12-31").spec;
}

test("sessions_to_event counts trading sessions, not calendar days", () => {
  const rows = sessions(10); // 2026-01-05 .. 2026-01-16, weekends skipped
  const events = { cpi: [{ date: "2026-01-09", releasedBeforeClose: true, surprise: null, surpriseZ: null }] };
  const built = spec([{ left: { kind: "sessions_to_event", event: "cpi" }, op: "<=", right: { kind: "value", value: 2 } }]);
  const { signals } = signalSeries(rows, built, events);
  // 01-09 is index 4; the rule turns on two sessions earlier (01-07, index 2).
  assert.equal(signals[1], false);
  assert.equal(signals[2], true);
  assert.equal(signals[4], true);
});

test("an event landing on a weekend attaches to the next session that traded", () => {
  const rows = sessions(10);
  // 2026-01-10 is a Saturday; the next session is Monday 2026-01-12 (index 5).
  const events = { cpi: [{ date: "2026-01-10", releasedBeforeClose: true, surprise: null, surpriseZ: null }] };
  const built = spec([{ left: { kind: "sessions_to_event", event: "cpi" }, op: "<=", right: { kind: "value", value: 0 } }]);
  const { signals } = signalSeries(rows, built, events);
  assert.equal(signals[4], false);
  assert.equal(signals[5], true);
});

test("a release before the close is readable that day; a late one only the next session", () => {
  const rows = sessions(6);
  const early = { fomc: [{ date: rows[2].date, releasedBeforeClose: true, surprise: 1.5, surpriseZ: 2 }] };
  const late = { fomc: [{ date: rows[2].date, releasedBeforeClose: false, surprise: 1.5, surpriseZ: 2 }] };
  const built = spec([{ left: { kind: "event_surprise", event: "fomc" }, op: ">", right: { kind: "value", value: 1 } }]);
  assert.equal(signalSeries(rows, built, early).signals[2], true);
  assert.equal(signalSeries(rows, built, late).signals[2], false);
  assert.equal(signalSeries(rows, built, late).signals[3], true);
});

test("an unknown event root yields nulls so the condition never fires", () => {
  const rows = sessions(6);
  const built = spec([{ left: { kind: "sessions_to_event", event: "does-not-exist" }, op: "<=", right: { kind: "value", value: 5 } }]);
  const { signals } = signalSeries(rows, built, { cpi: [{ date: rows[1].date, releasedBeforeClose: true, surprise: null, surpriseZ: null }] });
  assert.equal(signals.some(Boolean), false);
});

test("a calendar operand without an event root is rejected instead of silently defaulted", () => {
  const { spec: built, errors } = normalizeSpec({
    name: "x", hypothesis: { thesis: "t", mechanism: "m", prediction: "p", falsification: "f" },
    universe: ["SPY"], entry: [{ left: { kind: "sessions_to_event" }, op: "<=", right: { kind: "value", value: 2 } }],
  }, "2026-12-31");
  assert.equal(built, null);
  assert.match(errors.join(" "), /entry 조건/);
});

test("specEventRoots reports every root a rule depends on, de-duplicated", () => {
  const built = spec(
    [{ left: { kind: "sessions_to_event", event: "cpi" }, op: "<=", right: { kind: "value", value: 2 } }],
    [{ left: { kind: "sessions_since_event", event: "cpi" }, op: ">=", right: { kind: "value", value: 1 } },
     { left: { kind: "event_surprise_z", event: "nfp" }, op: "<", right: { kind: "value", value: 0 } }],
  );
  assert.deepEqual(specEventRoots(built).sort(), ["cpi", "nfp"]);
});

test("calendar operands do not inflate the indicator warm-up window", () => {
  const built = spec([{ left: { kind: "sessions_to_event", event: "cpi" }, op: "<=", right: { kind: "value", value: 2 } }]);
  assert.equal(warmupDays(built), 60);
});

test("parseCalendarId splits the static calendar's root-date ids", () => {
  assert.deepEqual(parseCalendarId("cpi-2025-09-11"), { root: "cpi", date: "2025-09-11" });
  assert.deepEqual(parseCalendarId("ism-services-2026-02-04"), { root: "ism-services", date: "2026-02-04" });
  assert.equal(parseCalendarId("no-date-here"), null);
});

test("releasedBeforeClose follows the 16:00 ET equity close", () => {
  assert.equal(releasedBeforeClose("08:30"), true);
  assert.equal(releasedBeforeClose("14:00"), true);
  assert.equal(releasedBeforeClose("16:30"), false);
});

test("computeSurprises prefers consensus and falls back without look-ahead", () => {
  const rows = [
    { eventDate: "2026-01-01", actualInitial: 10, previous: 9, consensus: null },
    { eventDate: "2026-02-01", actualInitial: 12, previous: 10, consensus: null },
    { eventDate: "2026-03-01", actualInitial: 11, previous: 12, consensus: null },
    { eventDate: "2026-04-01", actualInitial: 20, previous: 11, consensus: null },
    { eventDate: "2026-05-01", actualInitial: 13, previous: 20, consensus: 15 },
  ];
  const out = computeSurprises(rows);
  // First row has no history and no consensus, so it falls back to the previous print.
  assert.equal(out[0].basis, "naive_previous");
  assert.equal(out[0].surprise, 1);
  // Once enough history exists it uses the trailing mean of *earlier* prints only.
  assert.equal(out[3].basis, "naive_trailing");
  assert.equal(out[3].surprise, 9); // 20 - mean(10,12,11)
  // A supplied consensus always wins.
  assert.equal(out[4].basis, "consensus");
  assert.equal(out[4].surprise, -2);
});

test("computeSurprises reports no surprise when the actual has not been released", () => {
  const out = computeSurprises([{ eventDate: "2026-09-10", actualInitial: null, previous: 5, consensus: 6 }]);
  assert.equal(out[0].basis, "none");
  assert.equal(out[0].surprise, null);
});

test("applyTransform derives the month-over-month percent for an index series", () => {
  const out = applyTransform([
    { observationDate: "2026-01-01", realtimeStart: "2026-02-11", value: 100, latest: 100 },
    { observationDate: "2026-02-01", realtimeStart: "2026-03-11", value: 101, latest: 100.5 },
  ], "pct_change");
  assert.equal(out[0].headline, null, "the first period has no prior to compare against");
  assert.equal(out[1].headline, 1);
  assert.equal(out[1].headlineLatest, 0.5);
});

test("applyTransform derives the month-over-month change for a level series", () => {
  const out = applyTransform([
    { observationDate: "2026-01-01", realtimeStart: "2026-02-06", value: 150_000, latest: 150_000 },
    { observationDate: "2026-02-01", realtimeStart: "2026-03-06", value: 150_180, latest: 150_120 },
  ], "diff");
  assert.equal(out[1].headline, 180);
  assert.equal(out[1].headlineLatest, 120);
});

test("applyTransform leaves an already-rate series alone", () => {
  const out = applyTransform([
    { observationDate: "2026-01-01", realtimeStart: "2026-02-06", value: 4.1, latest: 4.2 },
  ], "level");
  assert.equal(out[0].headline, 4.1);
  assert.equal(out[0].headlineLatest, 4.2);
});

test("an index level compared to its own trailing mean measures trend, not surprise", () => {
  // This is the bug the transform exists to prevent: a rising index produces a
  // monotonically growing "surprise" that carries no information.
  const rising = Array.from({ length: 10 }, (_, index) => ({
    eventDate: `2026-${String(index + 1).padStart(2, "0")}-10`,
    actualInitial: 300 + index * 2,
    previous: index ? 300 + (index - 1) * 2 : null,
    consensus: null,
  }));
  const raw = computeSurprises(rising).flatMap((row) => row.surprise === null ? [] : [row.surprise]);
  assert.ok(raw.every((value) => value > 0), "levels: every surprise is positive — the trend, not news");

  // The same series expressed as its period-over-period change oscillates instead.
  const transformed = applyTransform(
    rising.map((row) => ({ observationDate: row.eventDate, realtimeStart: row.eventDate, value: row.actualInitial, latest: null })),
    "pct_change",
  );
  const headlines = transformed.flatMap((row) => row.headline === null ? [] : [row.headline]);
  assert.ok(Math.max(...headlines) - Math.min(...headlines) < 0.2, "changes stay in a narrow band rather than trending away");
});
