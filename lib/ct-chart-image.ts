/**
 * Candle chart images for the CT designer (stage 3): what a day trader sees, not a list of bp integers.
 *
 * One image per decision time ("anchor"), three panels side by side:
 *   left   the last 5 days of 1-hour bars with the previous day's high and low
 *   middle today's 5-minute bars with VWAP, the opening range (first 30 minutes) and the previous
 *          day's high / low / close
 *   right  the 90 minutes before the anchor in 1-minute bars with volume
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
  const m5: ChartBar[] = [],
    vwap5: number[] = [];
  const groups = new Map<number, number[]>();
  today.forEach((b, k) => {
    const g = Math.floor((b.startMs - dayStart) / (5 * MINUTE));
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(k);
  });
  for (const [g, ks] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (ks.length !== 5) continue;
    const bars = ks.map((k) => today[k]);
    if (bars.some((b, n) => n > 0 && b.startMs !== bars[n - 1].endMs)) continue;
    m5.push({
      startMs: dayStart + g * 5 * MINUTE,
      endMs: dayStart + (g + 1) * 5 * MINUTE,
      open: bars[0].open,
      close: bars[4].close,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
    vwap5.push(vwapAt[ks[4]]);
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
    if (or.length === 30 && or[0].startMs === dayStart) openingRange = { high: Math.max(...or.map((b) => b.high)), low: Math.min(...or.map((b) => b.low)), endMs: orEnd };
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

export function ctChartSvg(data: CTChartData, font: Font, number: number, contract: Pick<CTContract, "market" | "timezone">) {
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
  svg += p.text(`${data.symbol}   decision at ${clock(data.at, tz)} ${zone}   (axes: % vs the decision bar's close, no dates)`, 70, 26, 13, C.axis);
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
    "5m · today",
    data.m5,
    base,
    data.dayStart,
    data.at,
    lines5,
    { vwap: data.vwap5, band: data.openingRange ? { ...data.openingRange, fromMs: data.dayStart, toMs: data.openingRange.endMs, color: C.or } : null },
    timeTicks(data.dayStart, data.at, tz),
    null,
  );
  // 1 minute panel with volume.
  const m1From = data.m1[0]?.startMs ?? data.at - 90 * MINUTE;
  svg += candlePanel(
    p,
    { ...panels[2], h: 290 },
    "1m · last 90 min",
    data.m1,
    base,
    m1From,
    data.at,
    [],
    { vwap: data.vwap1 },
    timeTicks(m1From, data.at, tz),
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
export async function ctRenderChart(rows: ChartBar[], at: number, contract: Pick<CTContract, "market" | "timezone" | "trainingToMs" | "fromMs">, symbol: string, number: number): Promise<CTChartImage> {
  const data = ctChartData(rows, at, contract, symbol);
  const font = await loadFont();
  const { svg, labels } = ctChartSvg(data, font, number, contract);
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
