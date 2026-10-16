import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { queryLocalMarket } from "../../lib/local-market-data.ts";
import { dayInfo, labelMoves, moveFeatures } from "../../lib/ct-moves.ts";
import { additiveWalkForward } from "../../lib/ct-additive.ts";
import { roundTripFromSamples } from "../../lib/ct-ceiling-features.ts";
import type { CTBar } from "../../lib/ct-engine.ts";
const file = "docs/research/ct-ceiling-2026-10-16-additive-results.json",
  DAY = 86400000,
  to = Date.parse("2026-10-16");
const db = new DatabaseSync(join(homedir(), ".qquan/state/research.sqlite"), {
  readOnly: true,
});
const snapshots = {
  btc: "6acdffd7e9c3a86732a654b44c4cbd78ef10f61da3cada44986ecc17a5679f76",
  eth: "db04820cbbe58313845f5d94b4828deb6cfbcec9e39f39c8454a590b355f377e",
  sol: "c3d68094cf2275f13896c8cdbef1da21f9eba893f5759cd9f433813325132be1",
};
const rows: unknown[] = [],
  errors: unknown[] = [],
  started = Date.now();
const checkpoint = () =>
  writeFileSync(
    file,
    JSON.stringify(
      {
        preregistration: "a7e5160",
        modelCostUsd: 0,
        dataCostUsd: 0,
        seconds: (Date.now() - started) / 1000,
        rows,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
for (const [dataset, instrument] of [
  ["btc", "BTCUSDT"],
  ["eth", "ETHUSDT"],
  ["sol", "SOLUSDT"],
  ["stock", "NVDA"],
] as const) {
  for (const years of dataset === "stock" ? [0] : [1, 3]) {
    const from = Date.parse(
        dataset === "stock"
          ? "2024-10-14"
          : years === 1
            ? "2025-10-16"
            : "2023-10-16",
      ),
      market = dataset === "stock" ? "stock" : "crypto";
    try {
      const meta = await queryLocalMarket({
        dataset,
        instrument,
        from,
        to,
        minutes: 1,
        session: market === "stock" ? "regular" : "all",
        metadataOnly: true,
        ...(dataset !== "stock" ? { snapshot: snapshots[dataset] } : {}),
      });
      const bars: CTBar[] = [];
      for (let t = from; t < to; t += 31 * DAY) {
        const p = await queryLocalMarket({
          dataset,
          instrument,
          from: t,
          to: Math.min(to, t + 31 * DAY),
          minutes: 1,
          session: market === "stock" ? "regular" : "all",
          snapshot: meta.snapshot,
        });
        bars.push(...p.bars);
      }
      const samples = db
        .prepare(
          "SELECT buy_bp,sell_bp FROM ct_orderbook_samples WHERE venue='binance' AND symbol=? AND notional_usd=1000",
        )
        .all(instrument) as Array<{
        buy_bp: number | null;
        sell_bp: number | null;
      }>;
      if (market === "crypto" && !samples.length)
        throw new Error("실측 비용 없음");
      const cost =
        market === "stock" ? 0.31 : roundTripFromSamples(samples, 0.1).costPct;
      const day = dayInfo(bars, market),
        features = moveFeatures(bars, day, market, instrument);
      for (const hold of [60, 240, 390, Infinity])
        for (const multiplier of [1, 2]) {
          const labels = labelMoves(bars, day, {
            costPct: cost * multiplier,
            k: 3,
            m: 1,
            holdBars: hold,
          });
          for (const model of ["sign", "logistic"] as const) {
            const results = additiveWalkForward({
              bars,
              day,
              labels,
              features,
              costPct: cost * multiplier,
              hold,
              model,
            });
            rows.push(
              ...results.map((r) => ({
                instrument,
                years,
                from,
                to,
                snapshot: meta.snapshot,
                costPct: cost,
                multiplier,
                hold: hold === Infinity ? "day_end" : hold,
                ...r,
              })),
            );
            checkpoint();
            console.log(
              instrument,
              years,
              hold,
              multiplier,
              model,
              results.map((r) => r.dailyMeanPct.toFixed(5)).join("/"),
            );
          }
        }
    } catch (e) {
      errors.push({
        instrument,
        years,
        error: e instanceof Error ? e.message : String(e),
      });
      checkpoint();
    }
  }
}
db.close();
checkpoint();
const report = "docs/research/ct-ceiling-2026-10-16-additive.md";
writeFileSync(
  report,
  readFileSync(report, "utf8").replace(
    "아직 측정하지 않음. 이 절은 사전 등록 커밋 이후 별도 결과 커밋으로 갱신한다.",
    `사전 등록 a7e5160 이후 실행. ${rows.length}개 평가, 실패/불가 ${errors.length}. 모델 $0, 데이터 $0, 계산 ${(Date.now() - started) / 1000}초. 상세 수치: [JSON](ct-ceiling-2026-10-16-additive-results.json). 기준 네 조건을 충족한 행은 별도 순열 검정 전까지 통과로 보고하지 않는다.`,
  ),
);
