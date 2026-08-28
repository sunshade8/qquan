import { getDb } from "@/db";
import { backtestRuns } from "@/db/schema";
import { runIllustrativeBacktest, type BacktestInput } from "@/lib/backtesting";

export async function POST(request: Request) {
  const input = (await request.json()) as BacktestInput;
  if (!input.hypothesisId || !Number.isFinite(input.years) || input.years < 1 || input.years > 20 || !Number.isFinite(input.initialCapital) || input.initialCapital < 1000) {
    return Response.json({ error: "Invalid backtest parameters" }, { status: 400 });
  }
  const result = runIllustrativeBacktest(input);
  let persisted = false;
  try {
    await getDb().insert(backtestRuns).values({
      id: result.id, hypothesisId: input.hypothesisId, periodStart: result.periodStart,
      periodEnd: result.periodEnd, initialCapital: input.initialCapital,
      annualReturn: result.annualReturn, maxDrawdown: result.maxDrawdown,
      sharpe: result.sharpe, winRate: result.winRate, payload: JSON.stringify(result), createdAt: new Date(),
    });
    persisted = true;
  } catch {
    // The deterministic result remains usable before a local/deployed D1 migration is applied.
  }
  return Response.json({ result, persisted });
}
