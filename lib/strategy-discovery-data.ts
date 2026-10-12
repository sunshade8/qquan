import { queryLocalMarket } from "./local-market-data.ts";
import type {
  GenerationJob,
  StrategyResearch,
} from "./strategy-generation-types.ts";
/** Single-instrument chart research; no whole-market API scan. */
export async function discoverResearchUniverse(
  job: GenerationJob,
  progress: (message: string) => void,
): Promise<NonNullable<StrategyResearch["discovery"]>> {
  const research = job.research!;
  const symbols = research.constraints.universe ?? ["NVDA"];
  if (symbols.some((s) => s !== "NVDA"))
    throw new Error(
      "데이터 준비 필요: 기본 로컬 주식 데이터셋은 NVDA입니다. 다른 종목으로 대체하지 않습니다.",
    );
  progress("NVDA 로컬 데이터 범위 확인");
  const result = await queryLocalMarket({
    dataset: "stock",
    instrument: "NVDA",
    from: Date.parse(job.from + "T00:00:00Z"),
    to: Date.parse(research.trainingTo + "T00:00:00Z") + 86400000,
    minutes: 60,
  });
  const last = result.bars.at(-1);
  if (!last) throw new Error("데이터 준비 필요: 설정 → 주식 1분봉 다운로드");
  return {
    asOf: new Date(last.startMs).toISOString().slice(0, 10),
    source: "로컬 Massive NVDA · 단일 종목 결과는 타 종목 검증 아님",
    candidates: [
      {
        symbol: "NVDA",
        price: last.close,
        dollarVolume: Math.round(last.close * last.volume),
        rangePct: ((last.high - last.low) / last.close) * 100,
        cachedSessions: new Set(
          result.bars.map((b) =>
            new Date(b.startMs).toISOString().slice(0, 10),
          ),
        ).size,
      },
    ],
  };
}
