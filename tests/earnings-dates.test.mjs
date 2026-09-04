import assert from "node:assert/strict";
import test from "node:test";
import { classifyRelease, toEasternParts } from "../lib/earnings-dates.ts";

test("EDGAR's UTC acceptance time converts to Eastern across the DST boundary", () => {
  // 20:21Z in August is 16:21 EDT (UTC-4).
  const summer = toEasternParts("2026-08-26T20:21:19.000Z");
  assert.equal(summer.date, "2026-08-26");
  assert.equal(summer.minutes, 16 * 60 + 21);
  // The same wall clock in UTC lands an hour earlier in January (UTC-5).
  const winter = toEasternParts("2026-01-15T20:21:19.000Z");
  assert.equal(winter.minutes, 15 * 60 + 21);
  assert.equal(toEasternParts("not a date"), null);
});

test("an after-close release is anchored to the next date, not the filing date", () => {
  // The single most damaging error this module exists to prevent: a release
  // accepted at 16:21 ET could not be traded until the following session, so
  // scoring the filing date measures the day before the news.
  const release = classifyRelease("2026-08-26T20:21:19.000Z", "2026-08-26");
  assert.equal(release.timing, "after_close");
  assert.equal(release.filedDate, "2026-08-26");
  assert.equal(release.reactionDate, "2026-08-27");
  assert.equal(release.acceptedEt, "2026-08-26 16:21");
});

test("a pre-open release is priced into that same session's open", () => {
  const release = classifyRelease("2026-07-02T13:01:00.000Z", "2026-07-02"); // 09:01 EDT
  assert.equal(release.timing, "before_open");
  assert.equal(release.reactionDate, "2026-07-02");
});

test("a mid-session release is labelled rather than quietly bucketed", () => {
  const release = classifyRelease("2026-07-02T15:30:00.000Z", "2026-07-02"); // 11:30 EDT
  assert.equal(release.timing, "during_session");
  assert.equal(release.reactionDate, "2026-07-02");
});

test("the session boundaries are inclusive at the open and at the close", () => {
  assert.equal(classifyRelease("2026-07-02T13:30:00.000Z", "2026-07-02").timing, "during_session"); // 09:30 exactly
  assert.equal(classifyRelease("2026-07-02T13:29:00.000Z", "2026-07-02").timing, "before_open");
  assert.equal(classifyRelease("2026-07-02T20:00:00.000Z", "2026-07-02").timing, "after_close");    // 16:00 exactly
  assert.equal(classifyRelease("2026-07-02T19:59:00.000Z", "2026-07-02").timing, "during_session");
});

test("an after-close release on a Friday rolls to the weekend for the caller to anchor forward", () => {
  // The module owns no trading calendar; it hands Saturday to the profile
  // builder, which maps a date to the first session on or after it.
  const release = classifyRelease("2026-08-28T20:30:00.000Z", "2026-08-28"); // a Friday
  assert.equal(release.reactionDate, "2026-08-29");
});
