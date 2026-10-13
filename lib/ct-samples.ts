import { ctDate, type CTBar } from "./ct-engine.ts";
import type { CTContract } from "./ct-spec.ts";

/** Bars per window: one full regular US session, or the same span of continuous crypto. */
export const CT_SAMPLE_BARS = 390;
export const CT_SAMPLE_WINDOWS = 3;

export type CTSampleWindow = { symbol: string; from: number; to: number };

/** Deterministic PRNG so a resumed design step draws the same windows (mulberry32). */
function random(seed: string) {
  let a = Number.parseInt(seed.slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random training-only windows of consecutive 1-minute bars. Stocks draw whole sessions
 * (by exchange date); crypto draws contiguous 390-minute spans. Nothing after
 * trainingToMs can be selected.
 */
export function sampleCTWindows(
  data: Record<string, CTBar[]>,
  contract: CTContract,
  seed: string,
  count = CT_SAMPLE_WINDOWS,
): CTSampleWindow[] {
  const next = random(seed);
  const candidates: CTSampleWindow[] = [];
  for (const symbol of contract.symbols) {
    const rows = (data[symbol] ?? []).filter(
      (b) => b.startMs >= contract.fromMs && b.endMs <= contract.trainingToMs,
    );
    if (contract.market === "stock") {
      const days = new Map<string, CTBar[]>();
      for (const b of rows) {
        const day = ctDate(b.startMs, "stock");
        days.set(day, [...(days.get(day) ?? []), b]);
      }
      for (const bars of days.values())
        if (bars.length >= 60)
          candidates.push({
            symbol,
            from: bars[0].startMs,
            to: bars.at(-1)!.endMs,
          });
    } else {
      for (let i = 0; i + CT_SAMPLE_BARS <= rows.length; i += CT_SAMPLE_BARS) {
        const span = rows.slice(i, i + CT_SAMPLE_BARS);
        if (span.every((b, j) => !j || b.startMs === span[j - 1].endMs))
          candidates.push({ symbol, from: span[0].startMs, to: span.at(-1)!.endMs });
      }
    }
  }
  const picked: CTSampleWindow[] = [];
  while (picked.length < count && candidates.length)
    picked.push(candidates.splice(Math.floor(next() * candidates.length), 1)[0]);
  return picked.sort((a, b) => a.from - b.from || a.symbol.localeCompare(b.symbol));
}

const clock = (timezone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
const num = (n: number) => String(Number(n.toPrecision(7)));

/** Compact CSV the designer reads: time,open,high,low,close,volume in the contract timezone. */
export function formatCTWindow(
  window: CTSampleWindow,
  data: Record<string, CTBar[]>,
  contract: CTContract,
) {
  const bars = (data[window.symbol] ?? []).filter(
    (b) => b.startMs >= window.from && b.endMs <= window.to,
  );
  const time = clock(contract.timezone);
  return {
    ...window,
    date: ctDate(window.from, contract.market, contract.timezone),
    timezone: contract.timezone,
    bars: bars.length,
    csv: [
      "time,open,high,low,close,volume",
      ...bars.map((b) =>
        [time.format(new Date(b.startMs)), num(b.open), num(b.high), num(b.low), num(b.close), num(b.volume)].join(","),
      ),
    ].join("\n"),
  };
}
