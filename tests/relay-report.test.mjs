import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runRelay } from "../lib/relay-engine.ts";
import { buildRelayReport, generateRelayPdf } from "../lib/relay-report.ts";

function session(date, price, overrides = {}) {
  const bars = [];
  for (let index = 0; index < 78; index += 1) {
    const minute = 9 * 60 + 30 + index * 5;
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const bar = overrides[time] ?? {};
    const close = bar.close ?? price;
    bars.push({ date, time, open: bar.open ?? close, high: bar.high ?? Math.max(bar.open ?? close, close), low: bar.low ?? Math.min(bar.open ?? close, close), close, volume: 1_000 });
  }
  return bars;
}

const strategy = (id, slot, signalAt, stopPct) => ({
  id, name: `규칙 ${id}`, slot, summary: "", universe: ["RKLB"], rules: [], evidence: "", cautions: [], warmupSessions: 0,
  scan: ({ asOf }) => asOf >= signalAt ? { symbol: "RKLB", stopPct, targetPct: null, reason: "테스트 신호" } : null,
});

function fixture() {
  const sessions = [
    { date: "2026-03-02", bars: { RKLB: session("2026-03-02", 100, { "09:35": { open: 100, close: 100 }, "09:55": { open: 102, high: 102, close: 102 } }) } },
    { date: "2026-03-03", bars: { RKLB: session("2026-03-03", 100, { "09:35": { open: 100, close: 100 }, "09:40": { open: 96, high: 96, low: 95, close: 95 } }) } },
    { date: "2026-03-04", bars: { RKLB: session("2026-03-04", 100) } },
  ];
  const strategies = [strategy("a", "open", "09:30", 2), strategy("b", "close", "15:55", 1)];
  const result = runRelay(strategies, sessions, { capitalUsd: 1_000 });
  return buildRelayReport({ result, strategies, from: "2026-03-02", to: "2026-03-04", sources: [{ symbol: "RKLB", provider: "Massive", bars: 234, firstDate: "2026-03-02", lastDate: "2026-03-04", fallbackReason: null }], generatedAt: "2026-03-05T00:00:00Z" });
}

test("the report carries per-strategy P&L, adherence, and the daily series", () => {
  const report = fixture();
  const [open, close] = report.strategies;
  assert.equal(report.daily.length, 3);
  assert.equal(open.trades, 3);
  assert.equal(open.deviations, 1, "the 03-03 gap through the stop is a deviation");
  assert.equal(open.adherencePct, 66.67);
  assert.equal(open.exits.stop, 1);
  assert.equal(close.signals, 3, "a signal on the slot's last bar still counts");
  assert.equal(close.trades, 0);
  assert.equal(close.missedSignals, 3);
  assert.equal(close.fillRatePct, 0);
  assert.equal(report.totals.pnlUsd, Number((report.totals.endingEquityUsd - 1_000).toFixed(2)));
  assert.ok(Math.abs(report.daily.at(-1).cumulativeReturnPct - report.totals.returnPct) < 1e-3);
  assert.equal(report.trades.filter((trade) => !trade.traded).length, 3);
});

test("the PDF renders Korean text with the bundled font", async () => {
  const fontBytes = new Uint8Array(await readFile(new URL("../public/fonts/NanumGothic-Regular.ttf", import.meta.url)));
  const bytes = await generateRelayPdf(fixture(), { fontBytes });
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  assert.ok(bytes.length > 5_000 && bytes.length < 2_000_000, `subset font keeps the file small, got ${bytes.length} bytes`);
});
