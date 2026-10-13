import { easternWallTimeToEpoch } from "./market-clock.ts";
import { dataRPC } from "./market-data-rpc.ts";
export { dataRPC } from "./market-data-rpc.ts";
import type { CTBar } from "./ct-engine.ts";
export type LocalQuery = {
  dataset: "stock" | "btc" | "eth" | "sol";
  from: number;
  to: number;
  minutes?: number;
  session?: "regular" | "all";
  snapshot?: string;
  instrument?: string;
  venue?: string;
  quoteCurrency?: string;
  adjustmentPolicy?: string;
  networkPolicy?: "local-only";
  maxBars?: number;
  metadataOnly?: boolean;
};
export type LocalHistory = {
  bars: CTBar[];
  snapshot: string;
  datasetVersion: string;
  provenance: Record<string, string>;
  coverage: number[][];
  missingRanges: number[][];
  qualityReport: unknown[];
  localReadCount: number;
  externalRequestCount: number;
};
export const queryLocalMarket = (query: LocalQuery) =>
  dataRPC<LocalHistory>({ action: "query", ...query });
export async function localStockPoints(
  symbol: string,
  from: string,
  to: string,
  interval: string,
  session: "regular" | "all" = "all",
  snapshot?: string,
) {
  const end = Math.min(
    easternWallTimeToEpoch(to, "20:00"),
    Math.floor(Date.now() / 86400000) * 86400000,
  );
  const start = easternWallTimeToEpoch(from, "04:00");
  const result = await queryLocalMarket({
    dataset: "stock",
    instrument: symbol,
    from: start,
    to: end,
    minutes: 60,
    session,
    snapshot,
    metadataOnly: true,
  });
  const bars: CTBar[] = [];
  for (let cursor = start; cursor < end; cursor += 31 * 86400000) {
    const page = await queryLocalMarket({
      dataset: "stock",
      instrument: symbol,
      from: cursor,
      to: Math.min(end, cursor + 31 * 86400000),
      minutes: parseInt(interval),
      session,
      snapshot: result.snapshot,
    });
    bars.push(...page.bars);
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.assign(
    bars.map((b) => {
      const parts = formatter.formatToParts(b.startMs);
      const p = (key: string) => parts.find((x) => x.type === key)!.value;
      return {
        ...b,
        timestamp: b.startMs / 1000,
        date: `${p("year")}-${p("month")}-${p("day")}`,
        time: `${p("hour")}:${p("minute")}`,
      };
    }),
    { snapshot: result.snapshot, datasetVersion: result.datasetVersion },
  );
}

export async function localDailyRows(symbol: string, from: string, to: string) {
  const rows = [];
  let start = Date.parse(from + "T00:00:00Z");
  const end = Math.min(
    Date.parse(to + "T00:00:00Z") + 86400000,
    Math.floor(Date.now() / 86400000) * 86400000,
  );
  const pinned = await queryLocalMarket({
    dataset: "stock",
    instrument: symbol,
    from: start,
    to: end,
    minutes: 1440,
    session: "regular",
    metadataOnly: true,
  });
  while (start < end) {
    const stop = Math.min(end, start + 31 * 86400000);
    const result = await queryLocalMarket({
      dataset: "stock",
      instrument: symbol,
      from: start,
      to: stop,
      snapshot: pinned.snapshot,
      minutes: 1440,
      session: "regular",
    });
    rows.push(
      ...result.bars.map((b) => ({
        date: new Date(b.startMs).toISOString().slice(0, 10),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
    );
    start = stop;
  }
  return rows;
}

export async function localMinutePage(
  symbol: string,
  before: number,
  count = 200,
) {
  const result = await queryLocalMarket({
    dataset: "stock",
    instrument: symbol,
    from: before - 7 * 86400000,
    to: before,
    minutes: 1,
    session: "all",
  });
  return result.bars.slice(-Math.max(1, Math.min(count, 200))).reverse();
}
