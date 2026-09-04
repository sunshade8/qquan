import assert from "node:assert/strict";
import test from "node:test";
import { buildEventDayProfile, fisherExactTwoSided, profileSessions, summarizeProfiles } from "../lib/event-day-profile.ts";

/** Builds daily bars from [open, high, low, close] tuples on consecutive weekdays. */
function bars(rows, start = "2026-01-05") {
  const date = new Date(`${start}T00:00:00Z`);
  return rows.map(([open, high, low, close]) => {
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
    const entry = { date: date.toISOString().slice(0, 10), open, high, low, close, volume: 1000 };
    date.setUTCDate(date.getUTCDate() + 1);
    return entry;
  });
}

test("excursions are measured from the open, in both directions", () => {
  const [session] = profileSessions(bars([[100, 103, 98, 101]]), 2);
  assert.equal(session.upExcursionPct, 3);
  assert.equal(session.downExcursionPct, 2);
  assert.equal(session.openToClosePct, 1);
  assert.equal(session.rangePct, 5);
  assert.ok(session.reachedUp && session.reachedDown);
});

test("a whipsaw counts as both sides reached and is excluded from the clean rate", () => {
  const stats = summarizeProfiles("test", profileSessions(bars([
    [100, 103, 99.5, 102],  // up only
    [100, 100.5, 97, 98],   // down only
    [100, 103, 97, 100.5],  // both sides — a stop-and-target trader loses this one
    [100, 100.5, 99.5, 100], // neither
  ]), 2));
  assert.equal(stats.sessions, 4);
  assert.equal(stats.reachUpRatePct, 50);
  assert.equal(stats.reachDownRatePct, 50);
  assert.equal(stats.reachEitherRatePct, 75);
  assert.equal(stats.bothSidesRatePct, 25);
  assert.equal(stats.cleanReachRatePct, 50);
  // The whipsaw closed up and did reach up, so it still counts as close-aligned.
  assert.equal(stats.closeAlignedRatePct, 75);
});

test("event sessions are removed from the baseline they are compared against", () => {
  // Ten quiet sessions and two 4% event sessions, alternating so anchoring is exercised.
  const quiet = Array.from({ length: 10 }, () => [100, 100.4, 99.6, 100]);
  const rows = bars([...quiet.slice(0, 5), [100, 104.5, 99.9, 104], ...quiet.slice(5), [100, 104.5, 99.9, 104]]);
  const eventDates = [rows[5].date, rows[11].date];
  const profile = buildEventDayProfile(rows, "TEST", "Test", [{ label: "이벤트", dates: eventDates }], 2);

  assert.equal(profile.baseline.sessions, 10);
  assert.equal(profile.baseline.cleanReachRatePct, 0);
  assert.equal(profile.groups[0].sessions, 2);
  assert.equal(profile.groups[0].cleanReachRatePct, 100);
  const clean = profile.comparisons.find((item) => item.metric === "cleanReach");
  assert.equal(clean.differencePts, 100);
  assert.ok(clean.zScore > 0);
  assert.ok(clean.pValue !== null);
  assert.equal(clean.sufficientSample, false); // two event days is not a sample
});

test("a date on a holiday anchors forward, and a date past the data is reported unmatched", () => {
  const rows = bars(Array.from({ length: 6 }, () => [100, 101, 99, 100]));
  const profile = buildEventDayProfile(rows, "TEST", "Test", [
    { label: "휴장 발표", dates: ["2026-01-10"] },   // a Saturday -> the next session
    { label: "구간 밖", dates: ["2030-01-01"] },
  ], 2);
  assert.equal(profile.groups[0].sessions, 1);
  assert.equal(profile.groups[1].sessions, 0);
  assert.deepEqual(profile.unmatched, [{ label: "구간 밖", dates: ["2030-01-01"] }]);
});

test("fisher's exact matches the hypergeometric by hand", () => {
  // 1 hit in a 1-session group against 0 hits in 40 baseline sessions: the only
  // table as extreme is the observed one, so p = 1/41. The normal approximation
  // reports z > 6 here, which is why it is not the test being used.
  assert.ok(Math.abs(fisherExactTwoSided(1, 1, 0, 40) - 1 / 41) < 1e-9);
  // No difference at all must not be significant. The sum over every table is 1
  // up to the log-gamma approximation, so this is a tolerance, not an equality.
  assert.ok(Math.abs(fisherExactTwoSided(5, 10, 50, 100) - 1) < 1e-9);
  // Degenerate tables return 1 rather than dividing by zero.
  assert.equal(fisherExactTwoSided(0, 10, 0, 100), 1);
});

test("a lift from too few sessions is left unpromoted whatever its p-value", () => {
  const quiet = Array.from({ length: 40 }, () => [100, 100.4, 99.6, 100]);
  const rows = bars([...quiet, [100, 104.5, 99.9, 104]]);
  const profile = buildEventDayProfile(rows, "TEST", "Test", [{ label: "한 번뿐", dates: [rows[40].date] }], 2);
  const clean = profile.comparisons.find((item) => item.metric === "cleanReach");
  assert.equal(clean.ratePct, 100);
  assert.equal(clean.baselineRatePct, 0);
  assert.ok(clean.pValue < 0.05);        // the exact test does clear the threshold
  assert.equal(clean.sufficientSample, false);
  assert.equal(clean.significant, false); // one observation is still not a finding
  assert.ok(profile.notes.some((note) => note.includes("표본 10개 미만")));
});

test("a genuine effect over an adequate sample is promoted", () => {
  // 12 event sessions that all travel 2%, against 60 quiet ones that never do.
  const quiet = Array.from({ length: 60 }, () => [100, 100.4, 99.6, 100]);
  const loud = Array.from({ length: 12 }, () => [100, 104.5, 99.9, 104]);
  const rows = bars([...quiet, ...loud]);
  const profile = buildEventDayProfile(rows, "TEST", "Test", [{ label: "이벤트", dates: rows.slice(60).map((row) => row.date) }], 2);
  const clean = profile.comparisons.find((item) => item.metric === "cleanReach");
  assert.equal(clean.sessions, 12);
  assert.equal(clean.ratePct, 100);
  assert.ok(clean.pValue < 0.001);
  assert.equal(clean.sufficientSample, true);
  assert.equal(clean.significant, true);
});
