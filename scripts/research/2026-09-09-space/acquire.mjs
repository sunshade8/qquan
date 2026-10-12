/** Archived study: acquisition now obeys shared local-only identity and coverage checks. */
import { localStockPoints } from "../../../lib/local-market-data.ts";
for (const symbol of ["SPCX", "RKLB", "ASTS"]) {
  const points = await localStockPoints(
    symbol,
    "2026-06-12",
    "2026-09-04",
    "5m",
  );
  console.log(
    JSON.stringify({ symbol, bars: points.length, snapshot: points.snapshot }),
  );
}
