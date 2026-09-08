/**
 * Runs the adopted H2 rule through `lib/strategy.ts` exactly as a
 * `propose_strategy` spec would arrive, so the pseudocode in
 * docs/research/adopted-rules-2026-09.md is known to be executable rather than
 * merely plausible. The engine has no per-day position cap, so this run is the
 * uncapped version of the rule; the capped numbers stay in h2b.json.
 */

import { loadDailyMany, writeOut } from "./_load.ts";
import { runStrategyBacktest, applyCriteriaFloors, type StrategySpec } from "../../lib/strategy.ts";
import { costBps } from "../../lib/broker-costs.ts";
import { universeById } from "../../lib/universe.ts";

const symbols = [...new Set([...universeById("megacap")!.symbols, ...universeById("nasdaq_tech")!.symbols])];
const data = await loadDailyMany(symbols, "11y");
const market = data.get("SPY") ?? (await loadDailyMany(["SPY"], "11y")).get("SPY") ?? null;

const { criteria, adjustments } = applyCriteriaFloors({ minSharpe: 0.5, minExcessCagrPct: 0, maxDrawdownPct: 40, minTrades: 100 });

const spec: StrategySpec = {
  version: 1,
  name: "H2 3일 급락 단기 반전",
  hypothesis: {
    thesis: "대형주의 3일 급락은 정보보다 유동성·리밸런싱·마진 압력이 만든다.",
    mechanism: "강제 매도가 끝나면 호가가 되돌아오고, 5거래일 안에 낙폭의 일부가 회복된다.",
    prediction: "3일 −6% 이하 종목의 5일 순수익이 같은 기간 무조건 5일 보유보다 +0.3%p 이상 높다.",
    falsification: "초과분이 +0.3%p 미만이거나 임계값 이웃 칸에서 부호가 뒤집히면 기각.",
  },
  universe: [...data.keys()],
  benchmark: "SPY",
  entry: [{ left: { kind: "return", period: 3 }, op: "<=", right: { kind: "value", value: -6 } }],
  exit: [],
  holding: { maxSessions: 5, stopLossPct: 6, takeProfitPct: null },
  sizing: { mode: "equal_weight", positionPct: null },
  costBps: costBps(),
  period: { from: "2015-09-07", to: "2026-09-04" },
  successCriteria: criteria,
  notes: ["엔진에 하루 종목 수 상한이 없어 용량 제한 없는 버전이다. 실제 채택 규칙은 하루 3종목 상한.", ...adjustments],
};

const result = runStrategyBacktest(spec, Object.fromEntries(data), market);
if (!result) throw new Error("backtest returned null");
// Only the verdict-bearing parts: the full result carries every trade and an
// equity curve per symbol, which is 13MB of noise for a checked-in artefact.
writeOut("h2-spec.json", { spec: result.spec, period: result.period, metrics: result.metrics, robustness: result.robustness, verdict: result.verdict, missingSymbols: result.missingSymbols });
console.log(JSON.stringify({ metrics: result.metrics, verdict: result.verdict, robustness: result.robustness }, null, 1));
