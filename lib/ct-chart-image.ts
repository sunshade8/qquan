/**
 * Candle chart images for the CT designer (stage 3): what a day trader sees, not a list of bp integers.
 *
 * One image per decision time ("anchor"), three panels side by side:
 *   left   the last 5 days of 1-hour bars with the previous day's high and low
 *   middle today's 5-minute bars with VWAP, the opening range (first 30 minutes) and the previous
 *          day's high / low / close
 *   right  the 90 minutes before the anchor in 1-minute bars with volume
 * A contract on 5/15/60-minute bars draws the middle panel in max(5, bar)-minute bars and the right
 * panel as the last 90 base bars (2026-10-16); one-minute charts are unchanged byte for byte.
 *
 * Rules that keep the picture honest:
 *   - nothing after the anchor is drawn (only bars COMPLETED by the anchor's close)
 *   - the axes show percent relative to the anchor's close, never a price level, and no date: the
 *     picture carries no hint of when it was or how high the market stood; only the time of day
 *   - everything is computed from training bars handed in by the caller
 *
 * SVG → PNG by @resvg/resvg-wasm (WebAssembly: no native binary, the same bytes on every machine and
 * in Node or Workers). resvg-wasm has no text support, so labels are drawn as vector paths from the
 * vendored Noto Sans with @pdf-lib/fontkit: no system fonts involved.
 */
import { buildHigherSeries, prevDailyBar } from "./ct-timeframes.ts";
import { ctDayStartMs, ctDayEndMs, type CTBar } from "./ct-engine.ts";
import type { CTContract } from "./ct-spec.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const CT_CHART_WIDTH = 1420;
export const CT_CHART_HEIGHT = 456;

/* ------------------------------------------------------------------ data */

export type ChartBar = CTBar;
export type CTChartData = {
  symbol: string;
  at: number;
  /** Close of the anchor bar: the 0% line of every axis. */
  anchorClose: number;
  dayStart: number;
  dayEnd: number;
  /** Largest bar end used anywhere in the picture (never past `at`). */
  maxEndMs: number;
  h1: ChartBar[];
  m5: ChartBar[];
  m1: ChartBar[];
  /** Base bar minutes when the contract trades 5/15/60-minute bars (m5 then holds max(5, barMinutes)-minute bars, m1 the base bars); absent for one-minute data. */
  barMinutes?: number;
  /** VWAP at the end of each 5m / 1m bar, same length as m5 / m1. */
  vwap5: number[];
  vwap1: number[];
  openingRange: { high: number; low: number; endMs: number } | null;
  prevDay: { high: number; low: number; close: number } | null;
  prevDayH1: { high: number; low: number } | null;
};

const indexOfEnd = (rows: ChartBar[], ms: number) => {
  let lo = 0,
    hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].endMs === ms) return mid;
    if (rows[mid].endMs < ms) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
};

/** Builds the three panels from training rows ending at (or after) the anchor; bars after `at` are never read. */
export function ctChartData(rowsAll: ChartBar[], at: number, contract: Pick<CTContract, "market" | "timezone" | "trainingToMs" | "fromMs">, symbol: string): CTChartData {
  if (at > contract.trainingToMs) throw new Error("차트 기준 시각이 학습 구간을 넘었습니다");
  const i = indexOfEnd(rowsAll, at);
  if (i < 0) throw new Error("기준 시각에 마감하는 학습 봉이 없습니다");
  // Only bars closed by the anchor exist from here on.
  const rows = rowsAll.slice(Math.max(0, i + 1 - 9000), i + 1);
  const last = rows.length - 1;
  const anchorClose = rows[last].close;
  const dayStart = ctDayStartMs(contract.market, at) ?? Math.floor((at - 1) / DAY) * DAY;
  const dayEnd = ctDayEndMs(contract.market, at) ?? dayStart + DAY;
  // Today's 1-minute bars (contiguous run ending at the anchor).
  let first = last;
  while (first > 0 && rows[first - 1].endMs === rows[first].startMs && rows[first - 1].startMs >= dayStart) first--;
  const today = rows.slice(first).filter((b) => b.startMs >= dayStart);
  // VWAP: typical price × volume, cumulative from the day's first bar.
  let pv = 0,
    vol = 0;
  const vwapAt = today.map((b) => {
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    vol += b.volume;
    return vol > 0 ? pv / vol : b.close;
  });
  // 5-minute bars of today: only groups of five consecutive 1-minute bars all closed by the anchor.
  // Coarser research bars (5/15/60 minutes): the middle panel shows max(5, bar)-minute bars, the right one the base bars.
  const barMin = (rows[last].endMs - rows[last].startMs) / MINUTE,
    midMin = Math.max(5, barMin),
    perGroup = midMin / barMin;
  const m5: ChartBar[] = [],
    vwap5: number[] = [];
  const groups = new Map<number, number[]>();
  today.forEach((b, k) => {
    const g = Math.floor((b.startMs - dayStart) / (midMin * MINUTE));
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(k);
  });
  for (const [g, ks] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (ks.length !== perGroup) continue;
    const bars = ks.map((k) => today[k]);
    if (bars.some((b, n) => n > 0 && b.startMs !== bars[n - 1].endMs)) continue;
    m5.push({
      startMs: dayStart + g * midMin * MINUTE,
      endMs: dayStart + (g + 1) * midMin * MINUTE,
      open: bars[0].open,
      close: bars[perGroup - 1].close,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
    vwap5.push(vwapAt[ks[perGroup - 1]]);
  }
  const m1 = rows.slice(Math.max(0, last - 89));
  const m1Vwap = m1.map((b) => {
    const k = today.findIndex((t) => t.endMs === b.endMs);
    return k >= 0 ? vwapAt[k] : NaN;
  });
  // Opening range: the day's first 30 minutes, once they are all in.
  let openingRange: CTChartData["openingRange"] = null;
  const orEnd = dayStart + 30 * MINUTE;
  if (at >= orEnd) {
    const or = today.filter((b) => b.endMs <= orEnd);
    if (30 % barMin === 0 && or.length === 30 / barMin && or[0].startMs === dayStart) openingRange = { high: Math.max(...or.map((b) => b.high)), low: Math.min(...or.map((b) => b.low)), endMs: orEnd };
  }
  // Previous day from the completed daily series of the recent history.
  const recent = rows.slice(Math.max(0, last - 4320));
  const daily = buildHigherSeries(recent, 1440, contract.market, symbol);
  const pd = prevDailyBar(daily, contract.market, symbol, at);
  // 1-hour bars: crypto the last 5 UTC days, stocks the last 5 sessions.
  const hourly = buildHigherSeries(rows, 60, contract.market, symbol).bars.filter((b) => b.endMs <= at);
  const dayKey = (ms: number) => (contract.market === "crypto" ? Math.floor(ms / DAY) : new Date(ms - 5 * HOUR).toISOString().slice(0, 10));
  const keys = [...new Set(hourly.map((b) => dayKey(b.startMs)))];
  const keep = new Set(keys.slice(-5));
  const h1 = hourly.filter((b) => keep.has(dayKey(b.startMs)));
  let prevDayH1: CTChartData["prevDayH1"] = null;
  if (pd) prevDayH1 = { high: pd.high, low: pd.low };
  const vwap1 = m1Vwap;
  const maxEndMs = Math.max(...[...h1, ...m5, ...m1].map((b) => b.endMs));
  return {
    symbol,
    at,
    anchorClose,
    dayStart,
    dayEnd,
    maxEndMs,
    ...(barMin > 1 ? { barMinutes: barMin } : {}),
    h1,
    m5,
    m1,
    vwap5,
    vwap1,
    openingRange,
    prevDay: pd ? { high: pd.high, low: pd.low, close: pd.close } : null,
    prevDayH1,
  };
}

/**
 * Time-free blind charts (format ct-chart-3-blind, traderTools 6): every panel is the last N bars ENDING AT THE DECISION, so
 * nothing in the picture depends on the clock. Run 7a4354f4 (2026-10-16) showed why the stage-4 blind chart was not enough:
 * the designer picks the blind times itself and knows which are events, and the "today so far" panel (its length, the VWAP
 * reset, the opening-range box, the day separators of the hourly panel) told it how far into the day each chart was — with
 * 15-minute labels, a control from the same hour still sat 15–45 minutes away from its event.
 *
 *   left    the last 120 one-hour bars counted back from the decision (five days, no day separators)
 *   middle  the last 72 five-minute bars counted back from the decision (six hours, crossing midnight freely)
 *   right   the last 90 base bars with volume
 * Bars are built backwards from the decision (a 1-hour bar ends at the decision, the one before it an hour earlier, ...), only
 * from complete contiguous base bars; a group with a missing bar is not drawn. Bars are placed by their order, not by the clock
 * (a session gap or a missing bar closes up), so not even a gap tells where the day stood. Day-anchored overlays are replaced by
 * rolling ones that mean the same at every hour: VWAP since the middle panel's first bar (six hours), and the high / low of the
 * last 24 hours with the close 24 hours before the decision instead of the previous day's high / low / close. No opening range.
 */
const FREE_H1 = 120,
  FREE_MID = 72,
  FREE_BASE = 90;
function backBars(rows: ChartBar[], last: number, groupMin: number, count: number, baseMin: number): ChartBar[] {
  const per = groupMin / baseMin;
  const at = rows[last].endMs;
  const out: ChartBar[] = [];
  let j = last;
  for (let g = 0; g < count; g++) {
    const end = at - g * groupMin * MINUTE;
    while (j >= 0 && rows[j].endMs > end) j--;
    if (j < 0) break;
    if (rows[j].endMs !== end || j - per + 1 < 0) continue;
    const bars = rows.slice(j - per + 1, j + 1);
    if (bars[0].startMs !== end - groupMin * MINUTE || bars.some((b, n) => n > 0 && b.startMs !== bars[n - 1].endMs)) continue;
    out.push({
      startMs: end - groupMin * MINUTE,
      endMs: end,
      open: bars[0].open,
      close: bars[per - 1].close,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out.reverse();
}
/** Bars placed by order: bar k of n occupies the k-th slot of width `slotMs` ending at `at` (gaps close up). */
const byOrder = (bars: ChartBar[], at: number, slotMs: number) => bars.map((b, k) => ({ ...b, startMs: at - (bars.length - k) * slotMs, endMs: at - (bars.length - k - 1) * slotMs }));

/** The time-free blind picture's data; the same shape as `ctChartData` with rolling levels in place of the day's. */
export function ctChartDataTimeFree(rowsAll: ChartBar[], at: number, contract: Pick<CTContract, "market" | "timezone" | "trainingToMs" | "fromMs">, symbol: string): CTChartData {
  if (at > contract.trainingToMs) throw new Error("차트 기준 시각이 학습 구간을 넘었습니다");
  const i = indexOfEnd(rowsAll, at);
  if (i < 0) throw new Error("기준 시각에 마감하는 학습 봉이 없습니다");
  // Only bars closed by the anchor exist from here on (120 anchor-aligned stock hours can take 24 sessions of 390 minutes).
  const rows = rowsAll.slice(Math.max(0, i + 1 - 12000), i + 1);
  const last = rows.length - 1;
  const anchorClose = rows[last].close;
  const baseMin = (rows[last].endMs - rows[last].startMs) / MINUTE,
    midMin = Math.max(5, baseMin);
  const h1Real = 60 % baseMin === 0 ? backBars(rows, last, 60, FREE_H1, baseMin) : [];
  const m5Real = midMin % baseMin === 0 ? backBars(rows, last, midMin, FREE_MID, baseMin) : [];
  const m1Real = rows.slice(Math.max(0, last - (FREE_BASE - 1)));
  // Rolling VWAP from the middle window's start: typical price × volume over the base bars inside it.
  const vwapFrom = at - FREE_MID * midMin * MINUTE;
  const inWindow = rows.filter((b) => b.startMs >= vwapFrom);
  let pv = 0,
    vol = 0;
  const vwapByEnd = new Map<number, number>();
  for (const b of inWindow) {
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    vol += b.volume;
    vwapByEnd.set(b.endMs, vol > 0 ? pv / vol : b.close);
  }
  const vwap5 = m5Real.map((b) => vwapByEnd.get(b.endMs) ?? NaN),
    vwap1 = m1Real.map((b) => vwapByEnd.get(b.endMs) ?? NaN);
  // Rolling 24 hours: the high and low of the base bars that closed within it, and the close of the bar that closed 24 hours ago.
  const day = rows.filter((b) => b.startMs >= at - DAY);
  const ago = indexOfEnd(rows, at - DAY);
  const levels = day.length ? { high: Math.max(...day.map((b) => b.high)), low: Math.min(...day.map((b) => b.low)), close: ago >= 0 ? rows[ago].close : NaN } : null;
  const h1 = byOrder(h1Real, at, HOUR),
    m5 = byOrder(m5Real, at, midMin * MINUTE),
    m1 = byOrder(m1Real, at, baseMin * MINUTE);
  const maxEndMs = Math.max(...[...h1Real, ...m5Real, ...m1Real].map((b) => b.endMs));
  return {
    symbol,
    at,
    anchorClose,
    dayStart: at - FREE_MID * midMin * MINUTE,
    dayEnd: at,
    maxEndMs,
    ...(baseMin > 1 ? { barMinutes: baseMin } : {}),
    h1,
    m5,
    m1,
    vwap5,
    vwap1,
    openingRange: null,
    prevDay: levels,
    prevDayH1: levels ? { high: levels.high, low: levels.low } : null,
  };
}

/* ----------------------------------------------------------------- text */

type Font = { unitsPerEm: number; layout: (text: string) => { glyphs: Array<{ path: { toSVG: () => string } }>; positions: Array<{ xAdvance: number; xOffset: number }> } };
let fontPromise: Promise<Font> | null = null;
async function fileBytes(candidates: Array<URL | string>) {
  const { readFile } = await import("node:fs/promises");
  let last: unknown;
  for (const candidate of candidates)
    try {
      return await readFile(candidate);
    } catch (error) {
      last = error;
    }
  throw last instanceof Error ? last : new Error("파일을 읽을 수 없습니다");
}
async function loadFont(): Promise<Font> {
  fontPromise ??= (async () => {
    const [{ default: fontkit }, bytes] = await Promise.all([
      import("@pdf-lib/fontkit"),
      fileBytes([new URL("../assets/fonts/NotoSans-Regular.ttf", import.meta.url), `${process.cwd()}/assets/fonts/NotoSans-Regular.ttf`]),
    ]);
    return (fontkit as unknown as { create: (b: Uint8Array) => Font }).create(new Uint8Array(bytes));
  })();
  return fontPromise;
}

type Painter = {
  labels: string[];
  text: (str: string, x: number, y: number, size: number, fill: string, anchor?: "start" | "middle" | "end") => string;
};
function painter(font: Font): Painter {
  const labels: string[] = [];
  return {
    labels,
    text(str, x, y, size, fill, anchor = "start") {
      labels.push(str);
      const run = font.layout(str);
      const scale = size / font.unitsPerEm;
      const width = run.positions.reduce((s, p) => s + p.xAdvance, 0) * scale;
      let cx = anchor === "end" ? x - width : anchor === "middle" ? x - width / 2 : x;
      let out = "";
      run.glyphs.forEach((g, k) => {
        const p = run.positions[k];
        const d = g.path.toSVG();
        if (d) out += `<path fill="${fill}" transform="translate(${(cx + p.xOffset * scale).toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(5)} ${(-scale).toFixed(5)})" d="${d}"/>`;
        cx += p.xAdvance * scale;
      });
      return out;
    },
  };
}

/* ------------------------------------------------------------------ svg */

const C = {
  bg: "#ffffff",
  grid: "#e5e7eb",
  axis: "#6b7280",
  text: "#111827",
  up: "#0f9d58",
  down: "#d93025",
  vwap: "#f59e0b",
  level: "#7c3aed",
  or: "#2563eb",
  now: "#2563eb",
  vol: "#9ca3af",
};
const f1 = (n: number) => n.toFixed(1);
const NICE = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 50];
/** Percent move of a price against the anchor's close. */
const rel = (price: number, base: number) => (price / base - 1) * 100;
function niceTicks(min: number, max: number) {
  const span = Math.max(max - min, 1e-6);
  const raw = span / 5;
  const step = NICE.find((n) => n >= raw) ?? NICE.at(-1)!;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return { ticks: out, step };
}
const pctLabel = (v: number, step: number) => {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
};
const clock = (ms: number, timezone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

type Box = { x: number; y: number; w: number; h: number };
type Line = { price: number; color: string; dash?: string; label: string };

/** One candle panel. Returns its SVG and nothing else: the caller composes. */
function candlePanel(
  p: Painter,
  box: Box,
  title: string,
  bars: ChartBar[],
  base: number,
  t0: number,
  t1: number,
  lines: Line[],
  overlays: { vwap?: number[]; band?: { high: number; low: number; fromMs: number; toMs: number; color: string } | null },
  xTicks: Array<{ ms: number; label: string }>,
  volume: Box | null,
  separators: number[] = [],
) {
  let min = Infinity,
    max = -Infinity;
  for (const b of bars) {
    min = Math.min(min, rel(b.low, base));
    max = Math.max(max, rel(b.high, base));
  }
  if (!Number.isFinite(min)) {
    min = -0.5;
    max = 0.5;
  }
  min = Math.min(min, 0);
  max = Math.max(max, 0);
  const span = Math.max(max - min, 0.02);
  // VWAP widens the axis only where it runs near the candles; elsewhere it is clipped at the panel edge.
  for (const v of overlays.vwap ?? []) {
    if (!Number.isFinite(v)) continue;
    const r = rel(v, base);
    if (r >= min - 0.6 * span && r <= max + 0.6 * span) {
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
  }
  // Level lines far outside the candles would flatten them: keep the ones within 60% of the range, name the rest.
  const shown: Line[] = [],
    off: string[] = [];
  for (const l of lines) {
    const r = rel(l.price, base);
    if (r >= min - 0.6 * span && r <= max + 0.6 * span) {
      shown.push(l);
      min = Math.min(min, r);
      max = Math.max(max, r);
    } else off.push(`${l.label} ${r > 0 ? "+" : ""}${r.toFixed(1)}%`);
  }
  const pad = (max - min) * 0.06 + 1e-6;
  min -= pad;
  max += pad;
  const y = (v: number) => box.y + box.h - ((v - min) / (max - min)) * box.h;
  const x = (ms: number) => box.x + ((ms - t0) / Math.max(1, t1 - t0)) * box.w;
  const clip = `clip${Math.round(box.x)}`;
  let s = `<clipPath id="${clip}"><rect x="${f1(box.x)}" y="${f1(box.y)}" width="${f1(box.w)}" height="${f1(box.h)}"/></clipPath>`;
  s += `<rect x="${f1(box.x)}" y="${f1(box.y)}" width="${f1(box.w)}" height="${f1(box.h)}" fill="${C.bg}" stroke="${C.grid}"/>`;
  const { ticks, step } = niceTicks(min, max);
  for (const t of ticks) {
    s += `<line x1="${f1(box.x)}" x2="${f1(box.x + box.w)}" y1="${f1(y(t))}" y2="${f1(y(t))}" stroke="${t === 0 ? C.axis : C.grid}" stroke-width="${t === 0 ? 1 : 0.6}" ${t === 0 ? 'stroke-dasharray="4 3"' : ""}/>`;
    s += p.text(pctLabel(t, step), box.x - 5, y(t) + 4, 11, C.axis, "end");
  }
  for (const sep of separators) s += `<line x1="${f1(x(sep))}" x2="${f1(x(sep))}" y1="${f1(box.y)}" y2="${f1(box.y + box.h)}" stroke="${C.grid}" stroke-dasharray="2 3"/>`;
  if (overlays.band) {
    const b = overlays.band;
    s += `<rect x="${f1(x(b.fromMs))}" y="${f1(y(rel(b.high, base)))}" width="${f1(Math.max(1, x(b.toMs) - x(b.fromMs)))}" height="${f1(Math.max(1, y(rel(b.low, base)) - y(rel(b.high, base))))}" fill="${b.color}" fill-opacity="0.10" stroke="${b.color}" stroke-opacity="0.6" stroke-width="0.8"/>`;
  }
  for (const l of shown) {
    const yy = y(rel(l.price, base));
    s += `<line x1="${f1(box.x)}" x2="${f1(box.x + box.w)}" y1="${f1(yy)}" y2="${f1(yy)}" stroke="${l.color}" stroke-width="1" ${l.dash ? `stroke-dasharray="${l.dash}"` : ""}/>`;
    s += p.text(l.label, box.x + box.w - 3, yy - 3, 10, l.color, "end");
  }
  const slot = bars.length ? Math.max(1.2, (bars[0].endMs - bars[0].startMs) / Math.max(1, t1 - t0) * box.w) : 3;
  const body = Math.max(1, slot * 0.7);
  for (const b of bars) {
    const cx = x((b.startMs + b.endMs) / 2),
      up = b.close >= b.open,
      col = up ? C.up : C.down;
    const yo = y(rel(b.open, base)),
      yc = y(rel(b.close, base));
    s += `<line x1="${f1(cx)}" x2="${f1(cx)}" y1="${f1(y(rel(b.high, base)))}" y2="${f1(y(rel(b.low, base)))}" stroke="${col}" stroke-width="1"/>`;
    s += `<rect x="${f1(cx - body / 2)}" y="${f1(Math.min(yo, yc))}" width="${f1(body)}" height="${f1(Math.max(1, Math.abs(yc - yo)))}" fill="${col}"/>`;
  }
  if (overlays.vwap?.length) {
    const pts = bars
      .map((b, k) => ({ b, v: overlays.vwap![k] }))
      .filter((q) => Number.isFinite(q.v))
      .map((q) => `${f1(x((q.b.startMs + q.b.endMs) / 2))},${f1(y(rel(q.v, base)))}`);
    if (pts.length > 1) s += `<polyline clip-path="url(#${clip})" points="${pts.join(" ")}" fill="none" stroke="${C.vwap}" stroke-width="1.6"/>`;
  }
  // The decision time: the right edge of the plot.
  s += `<line x1="${f1(x(t1))}" x2="${f1(x(t1))}" y1="${f1(box.y)}" y2="${f1(box.y + box.h)}" stroke="${C.now}" stroke-width="1.2" stroke-dasharray="5 3"/>`;
  if (volume) {
    const vmax = Math.max(...bars.map((b) => b.volume), 1e-9);
    s += `<rect x="${f1(volume.x)}" y="${f1(volume.y)}" width="${f1(volume.w)}" height="${f1(volume.h)}" fill="${C.bg}" stroke="${C.grid}"/>`;
    for (const b of bars) {
      const h = (b.volume / vmax) * (volume.h - 4);
      s += `<rect x="${f1(x((b.startMs + b.endMs) / 2) - body / 2)}" y="${f1(volume.y + volume.h - h)}" width="${f1(body)}" height="${f1(h)}" fill="${C.vol}"/>`;
    }
    s += p.text("volume", volume.x + 4, volume.y + 12, 10, C.axis);
  }
  const axisY = (volume ?? box).y + (volume ?? box).h + 16;
  for (const tk of xTicks) {
    const xx = x(tk.ms);
    if (xx < box.x - 1 || xx > box.x + box.w + 1) continue;
    s += `<line x1="${f1(xx)}" x2="${f1(xx)}" y1="${f1(box.y + box.h)}" y2="${f1(box.y + box.h + 4)}" stroke="${C.axis}"/>`;
    s += p.text(tk.label, xx, axisY, 11, C.axis, "middle");
  }
  s += p.text(title, box.x, box.y - 8, 13, C.text);
  if (off.length) s += p.text(`off scale: ${off.join(" · ")}`, box.x + box.w, box.y - 8, 10, C.axis, "end");
  return s;
}

/** Hour ticks at a spacing that gives at most six labels. */
function timeTicks(from: number, to: number, timezone: string) {
  const span = to - from;
  const step = [15, 30, 60, 120, 240, 360].map((m) => m * MINUTE).find((st) => span / st <= 6) ?? 360 * MINUTE;
  const out: Array<{ ms: number; label: string }> = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push({ ms: t, label: clock(t, timezone) });
  return out;
}

/** Ticks at fixed offsets BEFORE the decision (−15m, −30m, ...), labelled relatively: a blind chart must not show where the decision stood on the clock. */
function relativeTicks(from: number, to: number) {
  const span = to - from;
  const step = [15, 30, 60, 120, 240, 360].map((m) => m * MINUTE).find((st) => span / st <= 6) ?? 360 * MINUTE;
  const out: Array<{ ms: number; label: string }> = [];
  for (let t = to - step; t >= from; t -= step) out.push({ ms: t, label: `-${Math.round((to - t) / MINUTE)}m` });
  return out.reverse();
}

/**
 * `blind: true` (calibration sets, stage 4): no decision time in the header and no clock-time ticks (relative minutes instead).
 * Run 42bd28a2 showed why: the designer chose the event and control times itself, so a chart that prints "decision at 14:37" can be
 * matched to its own list. What remains is the 5-minute panel's length (how far into the day), which controls share by construction
 * (they are drawn from the same hour of the day as their event).
 */
export function ctChartSvg(data: CTChartData, font: Font, number: number, contract: Pick<CTContract, "market" | "timezone">, options: { blind?: boolean } = {}) {
  const p = painter(font);
  const tz = contract.timezone === "UTC" ? "UTC" : contract.timezone;
  const zone = tz === "UTC" ? "UTC" : "ET";
  const base = data.anchorClose;
  const top = 62,
    plotH = 360;
  const pw = 400,
    gap = 62;
  const panels = [0, 1, 2].map((k) => ({ x: 56 + k * (pw + gap), y: top, w: pw, h: plotH }));
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CT_CHART_WIDTH}" height="${CT_CHART_HEIGHT}" viewBox="0 0 ${CT_CHART_WIDTH} ${CT_CHART_HEIGHT}"><rect width="100%" height="100%" fill="${C.bg}"/>`;
  svg += p.text(`#${number}`, 14, 26, 20, C.text);
  svg += p.text(
    options.blind
      ? `${data.symbol}   decision time hidden (blind set)   (axes: % vs the decision bar's close, no dates, no clock)`
      : `${data.symbol}   decision at ${clock(data.at, tz)} ${zone}   (axes: % vs the decision bar's close, no dates)`,
    70,
    26,
    13,
    C.axis,
  );
  const lg = [`VWAP`, `OR first 30m`, `PDH / PDL / PDC = previous day high / low / close`];
  svg += `<line x1="${CT_CHART_WIDTH - 560}" x2="${CT_CHART_WIDTH - 540}" y1="22" y2="22" stroke="${C.vwap}" stroke-width="2"/>` + p.text(lg[0], CT_CHART_WIDTH - 535, 26, 11, C.axis);
  svg += `<rect x="${CT_CHART_WIDTH - 480}" y="16" width="16" height="10" fill="${C.or}" fill-opacity="0.15" stroke="${C.or}"/>` + p.text(lg[1], CT_CHART_WIDTH - 460, 26, 11, C.axis);
  svg += p.text(lg[2], CT_CHART_WIDTH - 360, 26, 11, C.level);
  // 1 hour panel: day separators labelled D0, D-1, ...
  const firstMs = data.h1[0]?.startMs ?? data.at - 5 * DAY;
  const dayIndex = (ms: number) => (contract.market === "crypto" ? Math.floor(ms / DAY) : Math.floor((ms - 5 * HOUR) / DAY));
  const anchorDay = dayIndex(data.at - 1);
  const seen = new Map<number, number>();
  for (const b of data.h1) if (!seen.has(dayIndex(b.startMs))) seen.set(dayIndex(b.startMs), b.startMs);
  const seps = [...seen.values()].slice(1);
  const dayTicks = [...seen].map(([d, ms]) => ({ ms: ms + 2 * HOUR, label: `D${d - anchorDay === 0 ? "0" : d - anchorDay}` }));
  const prevLines: Line[] = data.prevDayH1
    ? [
        { price: data.prevDayH1.high, color: C.level, dash: "5 3", label: "PDH" },
        { price: data.prevDayH1.low, color: C.level, dash: "5 3", label: "PDL" },
      ]
    : [];
  svg += candlePanel(p, panels[0], "1h · last 5 days", data.h1, base, firstMs, data.at, prevLines, {}, dayTicks, null, seps);
  // 5 minute panel: the day so far.
  const lines5: Line[] = data.prevDay
    ? [
        { price: data.prevDay.high, color: C.level, dash: "5 3", label: "PDH" },
        { price: data.prevDay.low, color: C.level, dash: "5 3", label: "PDL" },
        { price: data.prevDay.close, color: C.level, dash: "1 3", label: "PDC" },
      ]
    : [];
  svg += candlePanel(
    p,
    panels[1],
    `${Math.max(5, data.barMinutes ?? 1)}m · today`,
    data.m5,
    base,
    data.dayStart,
    data.at,
    lines5,
    { vwap: data.vwap5, band: data.openingRange ? { ...data.openingRange, fromMs: data.dayStart, toMs: data.openingRange.endMs, color: C.or } : null },
    options.blind ? relativeTicks(data.dayStart, data.at) : timeTicks(data.dayStart, data.at, tz),
    null,
  );
  // 1 minute panel with volume.
  const m1From = data.m1[0]?.startMs ?? data.at - 90 * (data.barMinutes ?? 1) * MINUTE;
  svg += candlePanel(
    p,
    { ...panels[2], h: 290 },
    data.barMinutes ? `${data.barMinutes}m · last 90 bars` : "1m · last 90 min",
    data.m1,
    base,
    m1From,
    data.at,
    [],
    { vwap: data.vwap1 },
    options.blind ? relativeTicks(m1From, data.at) : timeTicks(m1From, data.at, tz),
    { x: panels[2].x, y: panels[2].y + 298, w: pw, h: 62 },
  );
  svg += `</svg>`;
  return { svg, labels: p.labels };
}

/** Ticks at fixed offsets before the decision for the time-free picture: minutes when the step is under an hour, hours otherwise. */
function freeTicks(from: number, to: number) {
  const span = to - from;
  const step = [15, 30, 60, 120, 240, 360, 720, 1440].map((m) => m * MINUTE).find((st) => span / st <= 6) ?? DAY;
  const out: Array<{ ms: number; label: string }> = [];
  for (let t = to - step; t >= from; t -= step) {
    const m = Math.round((to - t) / MINUTE);
    out.push({ ms: t, label: step < HOUR ? `-${m}m` : `-${Math.round(m / 60)}h` });
  }
  return out.reverse();
}

/** The time-free blind picture (ct-chart-3-blind): no clock, no day boundary, every panel ends at the decision. */
export function ctChartSvgTimeFree(data: CTChartData, font: Font, number: number) {
  const p = painter(font);
  const base = data.anchorClose;
  const top = 62,
    plotH = 360;
  const pw = 400,
    gap = 62;
  const panels = [0, 1, 2].map((k) => ({ x: 56 + k * (pw + gap), y: top, w: pw, h: plotH }));
  const midMin = Math.max(5, data.barMinutes ?? 1),
    baseMin = data.barMinutes ?? 1;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CT_CHART_WIDTH}" height="${CT_CHART_HEIGHT}" viewBox="0 0 ${CT_CHART_WIDTH} ${CT_CHART_HEIGHT}"><rect width="100%" height="100%" fill="${C.bg}"/>`;
  svg += p.text(`#${number}`, 14, 26, 20, C.text);
  svg += p.text(`${data.symbol}   blind set: every panel ends at the decision, no clock, no day boundary   (axes: % vs the decision bar's close)`, 70, 26, 13, C.axis);
  const lg = [`VWAP 6h`, `H24 / L24 / C24 = last 24h high / low, close 24h ago`];
  svg += `<line x1="${CT_CHART_WIDTH - 420}" x2="${CT_CHART_WIDTH - 400}" y1="22" y2="22" stroke="${C.vwap}" stroke-width="2"/>` + p.text(lg[0], CT_CHART_WIDTH - 395, 26, 11, C.axis);
  svg += p.text(lg[1], CT_CHART_WIDTH - 330, 26, 9.5, C.level);
  const at = data.at;
  const h1From = at - FREE_H1 * HOUR,
    midFrom = at - FREE_MID * midMin * MINUTE,
    baseFrom = at - FREE_BASE * baseMin * MINUTE;
  const lvl = data.prevDay;
  const lines24: Line[] = lvl
    ? [
        { price: lvl.high, color: C.level, dash: "5 3", label: "H24" },
        { price: lvl.low, color: C.level, dash: "5 3", label: "L24" },
      ]
    : [];
  svg += candlePanel(p, panels[0], `1h · last ${FREE_H1} bars`, data.h1, base, h1From, at, lines24, {}, freeTicks(h1From, at), null);
  const linesMid: Line[] = lvl && Number.isFinite(lvl.close) ? [...lines24, { price: lvl.close, color: C.level, dash: "1 3", label: "C24" }] : lines24;
  svg += candlePanel(p, panels[1], `${midMin}m · last ${FREE_MID} bars`, data.m5, base, midFrom, at, linesMid, { vwap: data.vwap5 }, freeTicks(midFrom, at), null);
  svg += candlePanel(
    p,
    { ...panels[2], h: 290 },
    `${baseMin}m · last ${FREE_BASE} bars`,
    data.m1,
    base,
    baseFrom,
    at,
    [],
    { vwap: data.vwap1 },
    freeTicks(baseFrom, at),
    { x: panels[2].x, y: panels[2].y + 298, w: pw, h: 62 },
  );
  svg += `</svg>`;
  return { svg, labels: p.labels };
}

/* ------------------------------------------------------------------ png */

let wasmReady: Promise<typeof import("@resvg/resvg-wasm")> | null = null;
async function resvg() {
  wasmReady ??= (async () => {
    const mod = await import("@resvg/resvg-wasm");
    const { createRequire } = await import("node:module");
    let wasmPath: string | undefined;
    try {
      wasmPath = createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm");
    } catch {
      wasmPath = undefined;
    }
    const bytes = await fileBytes([...(wasmPath ? [wasmPath] : []), `${process.cwd()}/node_modules/@resvg/resvg-wasm/index_bg.wasm`]);
    await mod.initWasm(bytes);
    return mod;
  })();
  return wasmReady;
}

export type CTChartImage = { png: Uint8Array; width: number; height: number; labels: string[]; data: CTChartData };
/** The picture for one anchor: training bars in, PNG bytes out. */
/** `timeFree: true` draws the time-free blind picture (ct-chart-3-blind, traderTools 6) instead of the day-anchored one. */
export async function ctRenderChart(rows: ChartBar[], at: number, contract: Pick<CTContract, "market" | "timezone" | "trainingToMs" | "fromMs">, symbol: string, number: number, options: { blind?: boolean; timeFree?: boolean } = {}): Promise<CTChartImage> {
  const data = options.timeFree ? ctChartDataTimeFree(rows, at, contract, symbol) : ctChartData(rows, at, contract, symbol);
  const font = await loadFont();
  const { svg, labels } = options.timeFree ? ctChartSvgTimeFree(data, font, number) : ctChartSvg(data, font, number, contract, options);
  const { Resvg } = await resvg();
  const image = new Resvg(svg, { fitTo: { mode: "original" }, background: "#ffffff" }).render();
  return { png: image.asPng(), width: image.width, height: image.height, labels, data };
}
/** Bytes → base64 without Buffer (works in Workers too). */
export function ctBase64(bytes: Uint8Array) {
  let s = "";
  for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(s);
}
