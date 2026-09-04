import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectionStudy, classifyRows, priorRelativeVolume, summarizeBucket } from "../lib/direction-study.ts";

function row(date, open, high, low, close, gapPct = 0, relativeVolume = 1) {
  return { date, open, high, low, close, gapPct, relativeVolume };
}

test("a session is decisive only when exactly one side reached the target", () => {
  const rows = classifyRows([
    row("d1", 100, 103, 99.5, 102),   // up only
    row("d2", 100, 100.5, 97, 98),    // down only
    row("d3", 100, 103, 97, 100),     // both — order unknown, so not decisive
    row("d4", 100, 100.5, 99.5, 100), // neither
  ], 2);
  assert.deepEqual(rows.map((item) => item.resolution), ["up", "down", "both", "neither"]);
  const bucket = summarizeBucket("t", rows);
  assert.equal(bucket.decisive, 2);
  assert.equal(bucket.upShareOfDecisivePct, 50);
  assert.equal(bucket.whipsawRatePct, 25);
});

test("whipsaws are excluded from the directional rate rather than split between sides", () => {
  // Nine clean ups and ninety whipsaws must not read as a 99% up rate.
  const rows = classifyRows([
    ...Array.from({ length: 9 }, (_, i) => row(`u${i}`, 100, 103, 99.5, 102)),
    ...Array.from({ length: 90 }, (_, i) => row(`b${i}`, 100, 103, 97, 100)),
  ], 2);
  const bucket = summarizeBucket("t", rows);
  assert.equal(bucket.decisive, 9);
  assert.equal(bucket.upShareOfDecisivePct, 100);
  assert.equal(bucket.whipsawRatePct, 90.91);
});

test("a real directional edge in the gap is detected", () => {
  // Gap-up sessions resolve up 40 of 44; gap-down sessions resolve down 40 of 44.
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => row(`gu${i}`, 100, 103, 99.5, 102, 2)),
    ...Array.from({ length: 4 }, (_, i) => row(`gud${i}`, 100, 100.5, 97, 98, 2)),
    ...Array.from({ length: 40 }, (_, i) => row(`gd${i}`, 100, 100.5, 97, 98, -2)),
    ...Array.from({ length: 4 }, (_, i) => row(`gdu${i}`, 100, 103, 99.5, 102, -2)),
  ];
  const study = buildDirectionStudy(rows, "TEST", { targetPct: 2, gapThresholdPct: 1, volumeThreshold: null });
  const [gapTest] = study.tests;
  assert.equal(gapTest.leftUpSharePct, 90.91);
  assert.equal(gapTest.rightUpSharePct, 9.09);
  assert.ok(gapTest.pValue < 0.001);
  assert.equal(gapTest.significant, true);
  assert.equal(gapTest.verdict, "차이 있음");
});

test("a null result carries the effect size the sample could have detected", () => {
  // Even split both ways: no edge, and the verdict has to say how big an edge
  // this sample would have caught rather than claiming none exists.
  const half = (prefix, gap) => [
    ...Array.from({ length: 30 }, (_, i) => row(`${prefix}u${i}`, 100, 103, 99.5, 102, gap)),
    ...Array.from({ length: 30 }, (_, i) => row(`${prefix}d${i}`, 100, 100.5, 97, 98, gap)),
  ];
  const study = buildDirectionStudy([...half("a", 2), ...half("b", -2)], "TEST", { targetPct: 2, gapThresholdPct: 1, volumeThreshold: null });
  const [gapTest] = study.tests;
  assert.equal(gapTest.spreadPts, 0);
  assert.equal(gapTest.significant, false);
  assert.ok(gapTest.minimumDetectableEffectPts > 0);
  assert.ok(gapTest.verdict.includes("잡아냈을 크기"));
  assert.ok(gapTest.marginOfErrorPts > 0);
});

test("a bigger sample can detect a smaller effect", () => {
  const build = (count) => buildDirectionStudy([
    ...Array.from({ length: count }, (_, i) => row(`u${i}`, 100, 103, 99.5, 102, 2)),
    ...Array.from({ length: count }, (_, i) => row(`d${i}`, 100, 100.5, 97, 98, -2)),
  ], "TEST", { targetPct: 2, gapThresholdPct: 1, volumeThreshold: null });
  const small = build(20).tests[0].minimumDetectableEffectPts;
  const large = build(500).tests[0].minimumDetectableEffectPts;
  assert.ok(large < small / 4);
});

test("volume can be silent on direction and loud on whipsaws", () => {
  // Heavy-volume sessions chop; light-volume sessions resolve. Direction is a
  // coin flip in both, which is the pattern the real data showed.
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => row(`hb${i}`, 100, 103, 97, 100, 2, 2)),
    ...Array.from({ length: 15 }, (_, i) => row(`hu${i}`, 100, 103, 99.5, 102, 2, 2)),
    ...Array.from({ length: 15 }, (_, i) => row(`hd${i}`, 100, 100.5, 97, 98, -2, 2)),
    ...Array.from({ length: 60 }, (_, i) => row(`lu${i}`, 100, 103, 99.5, 102, 2, 1)),
    ...Array.from({ length: 60 }, (_, i) => row(`ld${i}`, 100, 100.5, 97, 98, -2, 1)),
  ];
  const study = buildDirectionStudy(rows, "TEST", { targetPct: 2, gapThresholdPct: 1, volumeThreshold: 1.5 });
  const whipsaw = study.tests.find((item) => item.metric === "whipsaw");
  assert.ok(whipsaw.leftUpSharePct > whipsaw.rightUpSharePct);
  assert.equal(whipsaw.rightUpSharePct, 0);
  assert.equal(whipsaw.significant, true);
});

test("multiple testing is corrected across the tests one call runs", () => {
  const rows = [
    ...Array.from({ length: 60 }, (_, i) => row(`u${i}`, 100, 103, 99.5, 102, 2, i < 20 ? 2 : 1)),
    ...Array.from({ length: 60 }, (_, i) => row(`d${i}`, 100, 100.5, 97, 98, -2, i < 20 ? 2 : 1)),
  ];
  const study = buildDirectionStudy(rows, "TEST", { targetPct: 2, gapThresholdPct: 1, volumeThreshold: 1.5 });
  const tested = study.tests.filter((item) => item.sufficientSample);
  assert.ok(tested.length > 1);
  // Every tested comparison gets a threshold, and it tightens with the family size.
  assert.ok(tested.every((item) => item.correctedThreshold !== null && item.correctedThreshold <= 0.05));
  assert.ok(study.notes.some((note) => note.includes("Benjamini-Hochberg")));
});

test("prior relative volume never reads the session it judges", () => {
  const volumes = [100, 100, 100, 100, 100, 100, 100, 500, 9999];
  // Index 8 is judged by index 7's volume (500) against the median before it.
  assert.equal(priorRelativeVolume(volumes, 8, 20), 5);
  // Too little history to trust a baseline.
  assert.equal(priorRelativeVolume(volumes, 3, 20), null);
  assert.equal(priorRelativeVolume(volumes, 0, 20), null);
});
