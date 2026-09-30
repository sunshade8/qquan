import test from "node:test";
import assert from "node:assert/strict";
import { agreesWithBoard, parseCaseList, profileCase, sessionCandidates, snapshotClock } from "../lib/surge-cases.ts";
import { surgeAgentStatus, SURGE_AGENT_GATES } from "../lib/surge-agent.ts";

test("the owner's 날짜/종목/등락폭 lines parse in the forms they are likely to arrive in", () => {
  const { cases, errors } = parseCaseList([
    "2026-09-30/ABCD/+45.2%",
    "2026.09.30 / wxyz / -31%",
    "9/30/EFGH/12.5",
    "2026-10-01",
    "1 IJKL +88.1%",
    "2 MNOP −22,",
    "no date here",
    "2026-10-01/QRST/",
  ].join("\n"), "2026-10-01");
  assert.deepEqual(cases.map((c) => [c.statedDate, c.symbol, c.reportedPct, c.board, c.rank]), [
    ["2026-09-30", "ABCD", 45.2, "gainers", 1],
    ["2026-09-30", "WXYZ", -31, "losers", 1],
    ["2026-09-30", "EFGH", 12.5, "gainers", 2],
    ["2026-10-01", "IJKL", 88.1, "gainers", 1],
    ["2026-10-01", "MNOP", -22, "losers", 2],
  ]);
  assert.equal(errors.length, 2);
});

test("a December list read in January belongs to the previous year", () => {
  assert.equal(parseCaseList("12/31/ABCD/+20", "2027-01-01").cases[0].statedDate, "2026-12-31");
});

test("00:00 KST is 11:00 ET in summer and 10:00 ET in winter", () => {
  assert.equal(snapshotClock("2026-09-30"), "11:00");
  assert.equal(snapshotClock("2026-12-15"), "10:00");
});

test("a stated date may be the US session or the KST date after it", () => {
  assert.deepEqual(sessionCandidates("2026-10-01"), ["2026-10-01", "2026-09-30"]);
  assert.deepEqual(sessionCandidates("2026-09-28"), ["2026-09-28", "2026-09-25"]); // Monday → previous Friday
  assert.deepEqual(sessionCandidates("2026-09-27"), ["2026-09-25"]); // a Sunday KST date means Friday's session
});

test("the profile splits the day at the snapshot: the board saw only minutes that closed by it", () => {
  const minutes = [];
  const bar = (hhmm, price, volume = 1000) => minutes.push([hhmm, price, price * 1.01, price * 0.99, price, volume]);
  bar(800, 11); // premarket
  for (let m = 570; m < 960; m++) {
    const hhmm = Math.floor(m / 60) * 100 + (m % 60);
    bar(hhmm, m < 660 ? 12 + (m - 570) * 0.01 : m < 700 ? 13 : 11);
  }
  const profile = profileCase("2026-09-30", 10, minutes);
  assert.equal(profile.snapshotEt, "11:00");
  // Bar 10:59 closes at 11:00 at 12.89 — the 11:00 bar itself is after the snapshot.
  assert.equal(profile.snapshotPrice, 12 + 89 * 0.01);
  assert.equal(profile.changeAtSnapshotPct, 28.9);
  assert.equal(profile.afterSnapshot.toClosePct, Number(((11 / 12.89 - 1) * 100).toFixed(2)));
  assert.equal(profile.premarket.last, 11);
  assert.equal(profile.regularMinutes, 390);
  assert.ok(agreesWithBoard(27.5, profile));
  assert.ok(!agreesWithBoard(60, profile));
  assert.ok(!agreesWithBoard(-28.9, profile));
});

test("model stages stay closed until enough of the owner's cases are collected", () => {
  const status = (collected) => Object.fromEntries(surgeAgentStatus({ recorded: collected, collected, pending: 0, failed: 0, nights: 5 }).map((s) => [s.id, s.state]));
  assert.equal(status(20).similarity, "waiting");
  assert.equal(status(SURGE_AGENT_GATES.similarity).similarity, "ready");
  assert.equal(status(SURGE_AGENT_GATES.similarity).design, "waiting");
  assert.equal(status(SURGE_AGENT_GATES.design).design, "ready");
  assert.equal(status(SURGE_AGENT_GATES.design).backtest, "waiting");
});
