import assert from "node:assert/strict";
import test from "node:test";
import { runSurge } from "../lib/surge-engine.ts";
import { compileSurgeStrategy, parseSurgeSpec, breakEvenWinRatePct, dayFeatureValue, sessionPrefix, surgeReach } from "../lib/surge-spec.ts";
import { observeSurgeDay, SURGE_OBSERVATION } from "../lib/surge-observation.ts";
import { surgeHalfSpreadPct, minimumViableStopPct } from "../lib/surge-costs.ts";
import { toMarketRows, tradableTicker, observationUniverse } from "../lib/surge-universe.ts";
import { rollUp } from "../lib/bar-rollup.ts";
import { surgeEvidenceProblems, SURGE_POLICY } from "../lib/surge-validation.ts";

const DATE = "2026-03-03";
const time = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Regular-session five-minute bars 09:30–15:55, flat at `price` unless a time is overridden. */
function day(date, price, overrides = {}) {
  const bars = [];
  for (let minute = 9 * 60 + 30; minute < 16 * 60; minute += 5) {
    const at = time(minute);
    const override = overrides[at] ?? {};
    const close = override.close ?? price;
    const open = override.open ?? close;
    bars.push({
      date, time: at, open,
      high: override.high ?? Math.max(open, close),
      low: override.low ?? Math.min(open, close),
      close, volume: override.volume ?? 10_000,
    });
  }
  return bars;
}

/** A same-day event: first seen at `observedAt` (a minute's close) at `changePct` over a $10 previous close. */
const event = (symbol, changePct, observedAt = "10:02", observedPrice = 10 * (1 + changePct / 100)) => ({
  symbol, rank: 0, changePct, prevClose: 10, observedAt, observedPrice, sessionOpen: 10.2,
  dollarVolume: 2_000_000, volume: 200_000, priorDollarVolume: 100_000_000, rankedOn: DATE,
});

const RULE = {
  name: "급등 관측 후 추세 지속",
  hypothesis: "당일 +10% 이상 급등이 관측된 종목은 관측 후 전일 종가 위를 지키면 한 시간 안에 추세가 이어진다.",
  pool: "gainers",
  minEventMovePct: 10,
  maxEventMovePct: 500,
  minPrice: 1,
  maxPrice: 100,
  entryFrom: "09:40",
  entryTo: "15:00",
  minMinutesSinceEvent: 0,
  maxMinutesSinceEvent: 120,
  maxHoldMinutes: 60,
  maxTradesPerDay: 1,
  barInterval: "5m",
  barConditions: [],
  dayConditions: [{ feature: "fromPrevClosePct", operator: "gte", value: 1 }],
  rankBy: "eventChangePct",
  rankDirection: "desc",
  rankLookback: 2,
  stopPct: 5,
  rewardRisk: 2,
  minBarDollarVolume: 50_000,
  maxSpreadPct: 0.5,
  cautions: ["모형 스프레드 가정", "갭 하락 시 손절 미보장"],
};

const strategyOf = (overrides = {}) =>
  compileSurgeStrategy({ version: 2, id: "surge-test", candidate: { ...RULE, ...overrides }, evidence: "test" });

const sessionOf = (bars, events = [event("SURG", 40)]) => ({
  date: bars[0]?.date ?? DATE,
  candidates: events,
  bars: Object.fromEntries(events.map((row) => [row.symbol, bars.map((bar) => ({ ...bar }))])),
});

test("a 3m surge rule exits on the last complete bar before 15:55 without a false missing-bar violation", () => {
  const bars = Array.from({ length: 130 }, (_, i) => {
    const minute = 570 + i * 3;
    return { date: DATE, time: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`, open: 10.5, high: 10.5, low: 10.5, close: 10.5, volume: 100000 };
  });
  const strategy = strategyOf({ barInterval: "3m", maxHoldMinutes: 385 });
  const result = runSurge(strategy, [sessionOf(bars, [event("SURG", 40, "14:52")])], { capitalUsd: 1000 });
  const trade = result.days[0].slots.find(s => s.traded);
  assert.equal(trade.entryTime, "14:54");
  assert.equal(trade.exitTime, "15:51", "the 15:51 bar closes at 15:54; 15:54 would close too late");
  assert.equal(trade.exit, "time");
  assert.deepEqual(trade.violations, []);
});

test("a target hit returns the rule's reward:risk minus modelled cost, in R", () => {
  // The event is seen at 10:02; the 10:00 bar closes at 10:05, the first decision it can inform.
  const result = runSurge(strategyOf(), [sessionOf(day(DATE, 10.5, { "10:30": { close: 11.5, high: 11.6 } }))], { capitalUsd: 1000 });

  const trade = result.days[0].slots[0];
  assert.equal(trade.traded, true);
  assert.equal(trade.exit, "target");
  assert.equal(trade.signalTime, "10:00", "the first completed bar after the event decides");
  assert.equal(trade.entryTime, "10:05", "the fill is the next bar's open, never the signal bar");
  assert.equal(trade.observedAt, "10:02");
  assert.ok(trade.rMultiple > 1.8 && trade.rMultiple < 2, `2:1 minus cost, got ${trade.rMultiple}R`);
  assert.equal(result.expectancy.targetExits, 1);
});

test("an event is invisible before the minute it was observed, however true the condition already was", () => {
  const result = runSurge(strategyOf(), [sessionOf(day(DATE, 10.5), [event("SURG", 40, "11:03")])], { capitalUsd: 1000 });
  const trade = result.days[0].slots[0];
  assert.equal(trade.signalTime, "11:00", "the 11:00 bar closes at 11:05, the first close after 11:03");
  assert.equal(trade.entryTime, "11:05");
});

test("timing is measured from the event, not from a slot", () => {
  const result = runSurge(strategyOf({ minMinutesSinceEvent: 30 }), [sessionOf(day(DATE, 10.5))], { capitalUsd: 1000 });
  assert.equal(result.days[0].slots[0].signalTime, "10:30", "10:02 + 30 minutes: the first bar closing at or after 10:32 is 10:30–10:35");

  const late = runSurge(strategyOf({ minMinutesSinceEvent: 0, maxMinutesSinceEvent: 20 }), [sessionOf(day(DATE, 10.5, { "10:00": { close: 9.9 }, "10:05": { close: 9.9 }, "10:10": { close: 9.9 }, "10:15": { close: 9.9 } }))], { capitalUsd: 1000 });
  assert.equal(late.days[0].slots[0].traded, false, "past 20 minutes after the event the rule no longer looks at it");
});

test("a bar covering both the stop and the target is scored as the stop", () => {
  const result = runSurge(strategyOf(), [sessionOf(day(DATE, 10.5, {
    "10:30": { open: 10.5, close: 10.5, high: 11.6, low: 9.9 },
  }))], { capitalUsd: 1000 });
  const trade = result.days[0].slots[0];
  assert.equal(trade.exit, "stop", "the bar does not say which came first; the optimistic reading is the bug");
  assert.ok(trade.rMultiple < -1 && trade.rMultiple > -1.2, `−1R plus cost, got ${trade.rMultiple}R`);
});

test("a position is closed after maxHoldMinutes, and every position is flat by 15:55", () => {
  const held = runSurge(strategyOf({ maxHoldMinutes: 60 }), [sessionOf(day(DATE, 10.5))], { capitalUsd: 1000 });
  assert.equal(held.days[0].slots[0].exit, "time");
  assert.equal(held.days[0].slots[0].exitTime, "11:00", "entry at 10:05 plus twelve bars ends at the 11:00 bar's close (11:05)");
  assert.deepEqual(held.days[0].slots[0].violations, []);

  const late = runSurge(strategyOf({ maxHoldMinutes: 385 }), [sessionOf(day(DATE, 10.5), [event("SURG", 40, "14:52")])], { capitalUsd: 1000 });
  assert.equal(late.days[0].slots[0].entryTime, "14:55");
  assert.equal(late.days[0].slots[0].exitTime, "15:50", "the last bar held closes at 15:55");
});

test("the rule's event band rejects an event before any bar is read", () => {
  const narrow = runSurge(strategyOf({ maxEventMovePct: 30 }), [sessionOf(day(DATE, 10.5))], { capitalUsd: 1000 });
  assert.equal(narrow.days[0].slots[0].traded, false);
  assert.match(narrow.days[0].slots[0].reason, /조건에 맞는 당일 사건 없음/);

  const quiet = runSurge(strategyOf(), [sessionOf(day(DATE, 10.5), [])], { capitalUsd: 1000 });
  assert.match(quiet.days[0].slots[0].reason, /당일 관측 사건 없음/);
});

test("sequential trades: after an exit the search resumes, never re-entering the same name", () => {
  const bars = day(DATE, 10.5, { "10:30": { close: 11.5, high: 11.6 } });
  const session = sessionOf(bars, [event("SURG", 40), event("JUMP", 20)]);
  // JUMP stays flat, so only the time exit ends it.
  session.bars.JUMP = day(DATE, 10.5);
  const result = runSurge(strategyOf({ maxTradesPerDay: 2 }), [session], { capitalUsd: 1000 });
  const trades = result.days[0].slots;
  assert.deepEqual(trades.map((trade) => trade.symbol), ["SURG", "JUMP"], "the bigger event first, then the next one");
  assert.equal(trades[0].exitTime, "10:30");
  assert.equal(trades[1].signalTime, "10:35", "the second decision is on the first bar after the first exit");
  assert.equal(result.metrics.totalTrades, 2);

  const once = runSurge(strategyOf({ maxTradesPerDay: 1 }), [session], { capitalUsd: 1000 });
  assert.equal(once.days[0].slots.length, 1);
});

test("doubling the cost multiplier lowers realised R without changing the rule", () => {
  const session = sessionOf(day(DATE, 10.5, { "10:30": { close: 11.5, high: 11.6 } }));
  const base = runSurge(strategyOf(), [session], { capitalUsd: 1000 });
  const stressed = runSurge(strategyOf(), [session], { capitalUsd: 1000, costMultiplier: 2 });
  assert.ok(stressed.days[0].slots[0].rMultiple < base.days[0].slots[0].rMultiple);
});

test("a one-bar entry delay moves the fill one bar later", () => {
  const session = sessionOf(day(DATE, 10.5, { "10:30": { close: 11.5, high: 11.6 } }));
  const delayed = runSurge(strategyOf(), [session], { capitalUsd: 1000, entryDelayBars: 1 });
  assert.equal(delayed.days[0].slots[0].entryTime, "10:10");
});

test("expectancy reports the realised payoff, not the intended one", () => {
  const win = sessionOf(day(DATE, 10.5, { "10:30": { close: 11.5, high: 11.6 } }));
  // Opens above the stop and trades through it, so the fill is the stop itself: exactly −1R.
  const loss = sessionOf(day("2026-03-04", 10.5, { "10:30": { open: 10.4, close: 10, low: 9.9 } }), [{ ...event("SURG", 40), rankedOn: "2026-03-04" }]);
  const result = runSurge(strategyOf(), [win, loss], { capitalUsd: 1000 });

  assert.equal(result.expectancy.trades, 2);
  assert.equal(result.expectancy.winRatePct, 50);
  assert.ok(result.expectancy.avgLossR < -1 && result.expectancy.avgLossR > -1.1, `${result.expectancy.avgLossR}R`);
  assert.ok(result.expectancy.payoffRatio > 1.7 && result.expectancy.payoffRatio < 2, `${result.expectancy.payoffRatio}`);
  assert.ok(result.expectancy.expectancyR > 0.3, `two trades at −1R and +2R, got ${result.expectancy.expectancyR}`);
  assert.equal(result.expectancy.breakEvenWinRatePct < 40, true);
});

test("the rule language refuses clocks with no room to trade", () => {
  const parse = (overrides) => parseSurgeSpec({ version: 2, id: "x", candidate: { ...RULE, ...overrides }, evidence: "" });
  assert.throws(() => parse({ entryTo: "15:50" }), /15:40/);
  assert.throws(() => parse({ entryFrom: "09:30" }), /09:35/, "no five-minute bar has closed at 09:30");
  assert.doesNotThrow(() => parse({ entryFrom: "09:31", barInterval: "1m" }));
  assert.throws(() => parse({ minMinutesSinceEvent: 60, maxMinutesSinceEvent: 30 }));
  assert.throws(() => parse({ minEventMovePct: 5 }), "an event is at least a 10% move");
  assert.throws(() => parseSurgeSpec({ version: 1, id: "x", candidate: RULE, evidence: "" }), "prior-day rules are not in this language");
});

test("an event is the first regular-session minute with the move, the price and $1M of tape behind it", () => {
  const minute = (at, close, volume, open = close) => ({ date: DATE, time: at, open, high: close, low: Math.min(open, close), close, volume });
  const minutes = [
    minute("09:25", 15, 500_000),             // premarket: never an event
    minute("09:30", 10.2, 30_000, 10.1),      // the session open
    minute("09:31", 11.2, 50_000),            // +12%, but $ tape so far ≈ $0.87M
    minute("09:32", 10.8, 10_000),            // tape passes $1M, but the move is +8%
    minute("09:33", 11.1, 10_000),            // +11% with ≈ $1.09M behind it: the event
    minute("09:34", 13, 90_000),
  ];
  const seen = observeSurgeDay({ symbol: "SURG", prevClose: 10, priorDollarVolume: 5_000_000 }, minutes, "gainers");
  assert.equal(seen.observedAt, "09:34", "the 09:33 minute's close");
  assert.equal(seen.observedPrice, 11.1);
  assert.equal(seen.sessionOpen, 10.1);
  assert.ok(seen.dollarVolume >= SURGE_OBSERVATION.minSessionDollarVolume);
  assert.equal(seen.priorDollarVolume, 5_000_000);

  assert.equal(observeSurgeDay({ symbol: "SURG", prevClose: 10 }, minutes, "losers"), null);
  const crash = observeSurgeDay({ symbol: "DUMP", prevClose: 20 }, [minute("09:30", 17.5, 80_000)], "losers");
  assert.equal(crash.changePct, -12.5);
});

test("the download envelope keeps every name that could have an event and drops splits", () => {
  const rows = toMarketRows([
    { T: "RVRS", o: 10, h: 10.5, l: 9.8, c: 10, v: 2_000_000 }, // a 1:10 reverse split: a fake +900%
    { T: "REAL", o: 9, h: 13, l: 9, c: 12, v: 2_000_000 },
    { T: "FADE", o: 10.5, h: 11.5, l: 9.9, c: 10, v: 200_000 },  // +15% high, a small but real tape
    { T: "THIN", o: 10, h: 12, l: 10, c: 11.5, v: 20_000 },      // high × volume < $1M: no event possible
    { T: "DUMP", o: 9, h: 9, l: 8, c: 8.2, v: 500_000 },
  ], true);
  const previous = [["RVRS", 1, 1_000_000], ["REAL", 10, 1_000_000], ["FADE", 10, 1_000_000], ["THIN", 10, 1_000], ["DUMP", 10, 1_000_000]];
  const pools = observationUniverse(DATE, rows, previous, new Set(["RVRS"]));
  assert.deepEqual(pools.gainers.map((row) => row.symbol).sort(), ["FADE", "REAL"]);
  assert.deepEqual(pools.losers.map((row) => row.symbol), ["DUMP"]);
  assert.equal(pools.gainers.find((row) => row.symbol === "REAL").priorDollarVolume, 10_000_000);
});

test("trimmed bars plus their prefix give the same session features as the whole session", () => {
  const bars = day(DATE, 10.5, { "09:30": { open: 10.2, close: 10.4, high: 12, low: 10.1, volume: 90_000 }, "10:45": { close: 11 } });
  const candidate = event("SURG", 40);
  const reach = surgeReach({ barInterval: "5m", maxMinutesSinceEvent: 60, maxHoldMinutes: 30 }, "11:30");
  const kept = bars.filter((bar) => bar.time >= reach.from && bar.time < reach.to);
  const prefix = sessionPrefix(bars.filter((bar) => bar.time < reach.from));
  assert.ok(kept.length < bars.length && kept.length > 24, "at least the lookback is kept before the event");
  const upTo = (list) => list.filter((bar) => bar.time <= "12:00");
  for (const feature of ["sessionHighDistancePct", "sessionVwapDistancePct", "sessionRangePct", "sessionDollarVolumeM", "openGapPct"]) {
    const whole = dayFeatureValue(feature, upTo(bars), candidate, "12:05");
    const trimmed = dayFeatureValue(feature, upTo(kept), candidate, "12:05", prefix);
    assert.ok(Math.abs(whole - trimmed) < 1e-9, `${feature}: ${whole} vs ${trimmed}`);
  }
  assert.equal(dayFeatureValue("minutesSinceEvent", upTo(kept), candidate, "12:05"), 123);
});

test("one minute download, three resolutions: roll-ups keep OHLC and sum volume", () => {
  const minutes = [
    { date: DATE, time: "10:00", open: 10, high: 11, low: 9.5, close: 10.5, volume: 100 },
    { date: DATE, time: "10:01", open: 10.5, high: 12, low: 10.4, close: 11.5, volume: 200 },
    { date: DATE, time: "10:02", open: 11.5, high: 11.8, low: 11, close: 11.2, volume: 300 },
    { date: DATE, time: "10:03", open: 11.2, high: 11.3, low: 10.9, close: 11, volume: 400 },
  ];
  const three = rollUp(minutes, 3);
  assert.equal(three.length, 2, "10:00–10:02 and 10:03, aligned to the hour");
  assert.deepEqual(
    { time: three[0].time, open: three[0].open, high: three[0].high, low: three[0].low, close: three[0].close, volume: three[0].volume },
    { time: "10:00", open: 10, high: 12, low: 9.5, close: 11.2, volume: 600 },
  );
  assert.equal(rollUp(minutes, 5)[0].volume, 1000);
  assert.equal(rollUp(minutes, 1).length, 4, "one minute is returned untouched");
});

test("cost rises as price falls: one cent of tick is 0.5% of a dollar stock", () => {
  assert.ok(surgeHalfSpreadPct(1, 50_000_000) > surgeHalfSpreadPct(50, 50_000_000));
  assert.ok(surgeHalfSpreadPct(2, 5_000_000) > surgeHalfSpreadPct(2, 500_000_000));
  // A stop tighter than this hands the whole risk budget to the spread.
  assert.ok(minimumViableStopPct("PENNY", 1.2, 8_000_000) > 1);
});

test("break-even win rate is the number a reward:risk claim has to survive", () => {
  assert.equal(breakEvenWinRatePct(2), 33.33);
  assert.ok(breakEvenWinRatePct(2, 0.3) > breakEvenWinRatePct(2));
});

test("the market filter drops test tickers, warrants, penny prices and thin tape", () => {
  const rows = toMarketRows([
    { T: "ZVZZT", o: 12, c: 29, v: 700_000 },
    { T: "ABCDW", o: 5, c: 9, v: 2_000_000 },
    { T: "PENNY", o: 0.4, c: 0.6, v: 90_000_000 },
    { T: "THIN", o: 10, c: 12, v: 1_000 },
    { T: "REAL", o: 9, c: 12, v: 1_000_000 },
  ]);
  assert.deepEqual(rows.map((row) => row.symbol), ["REAL"]);
  assert.equal(tradableTicker("ZBZX"), false);
  assert.equal(tradableTicker("AAPL"), true);
});

test("the gates refuse a block whose expectancy is not positive, however good the percentage looks", () => {
  const slice = (expectancyR, lower95) => ({
    from: "2026-01-02", to: "2026-03-02",
    metrics: {
      sessions: 40, tradingDays: 30, flatDays: 10, totalTrades: 30, signals: 30, missedSignals: 0,
      compliantTrades: 30, adherencePct: 100, winRatePct: 50, meanDailyPct: 0.2, medianDailyPct: 0.1,
      positiveDayPct: 55, daysAbove1PctShare: 10, daysAbove2PctShare: 2, worstDayPct: -2, bestDayPct: 3,
      worstIntradayPct: -3, maxDrawdownPct: 8, endOfDayMaxDrawdownPct: 6, totalReturnPct: 8,
      costPaidUsd: 20, impliedAnnualPct: 60,
    },
    expectancy: {
      trades: 30, wins: 15, losses: 15, winRatePct: 50, expectancyR, avgWinR: 1.8, avgLossR: -1,
      payoffRatio: 1.8, breakEvenWinRatePct: 35, expectancyLower95R: lower95,
      totalRiskedUsd: 1500, stopExits: 15, targetExits: 10, timeExits: 5,
    },
    meanDailyLower95Pct: 0.05,
    daily: Array.from({ length: 40 }, (_, index) => ({ date: `2026-01-${index + 1}`, returnPct: 0.2 })),
    trades: [],
  });

  const healthy = {
    training: slice(0.4, 0.2), validation: slice(0.4, 0.2), holdout: slice(0.4, 0.2),
    stress: slice(0.3, 0.1), delayed: slice(0.3, 0.1),
  };
  assert.deepEqual(surgeEvidenceProblems(healthy), []);

  const flat = { ...healthy, holdout: slice(SURGE_POLICY.minExpectancyR - 0.01, 0.2) };
  assert.ok(surgeEvidenceProblems(flat).some((reason) => reason.includes("기대값")));

  const unproven = { ...healthy, holdout: slice(0.4, -0.01) };
  assert.ok(surgeEvidenceProblems(unproven).some((reason) => reason.includes("엣지 미확립")));
});
