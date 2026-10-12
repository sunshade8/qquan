import { easternWallTimeToEpoch } from "./market-clock.ts";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { CTBar } from "./ct-engine.ts";
export type LocalQuery = {
  dataset: "stock" | "btc";
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
export function dataRPC<T>(input: object): Promise<T> {
  return new Promise((accept, reject) => {
    const child = spawn(
      process.env.QQUAN_PYTHON || resolve(".venv/bin/python"),
      [resolve("scripts/data/store.py"), "rpc"],
      { stdio: ["pipe", "pipe", "pipe"], env: process.env },
    );
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 80_000_000) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", () =>
      reject(new Error("로컬 데이터 런타임 설치 필요: npm run data:setup")),
    );
    child.on("close", (code) => {
      try {
        const result = JSON.parse(output);
        if (code || result.error)
          reject(new Error(result.error || "Local data failed"));
        else accept(result);
      } catch {
        reject(
          new Error(
            "로컬 데이터 실행 오류: npm run data:setup 확인. " +
              errors.slice(-300),
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
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
