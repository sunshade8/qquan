/**
 * The board signature (stage 4, docs/ct.md「판 서명」): what makes two research runs "the same board".
 *
 * Three consecutive runs (bcf289ab, 450b45dd, 3ab2ad6c) had the same contract, costs, data and label
 * definition: nothing new was learned and only the cumulative test count grew. A run is refused BEFORE any
 * paid call when an earlier run of the same owner has the same signature and is still running. A board that ended
 * without a passing strategy is not refused: the run starts and its orchestrator picks a different direction
 * (ctResolveBoard). An owner-given repeatReason still reruns it as-is (kept on the contract, shown to reviewers).
 */
import { ctHash, type CTContract } from "./ct-spec.ts";

/** Whitespace-normalised brief: runs of spaces/newlines are one space. */
export const ctNormalizeBrief = (brief: string | undefined | null) => (brief ?? "").replace(/\s+/g, " ").trim();

/** Per-symbol data snapshot hashes of a contract (multi-symbol contracts keep a map; single-symbol ones the first snapshot). */
export function ctSnapshotsOf(contract: Pick<CTContract, "symbols" | "dataSnapshot" | "dataSnapshots">) {
  if (contract.dataSnapshots) return Object.fromEntries(Object.entries(contract.dataSnapshots).sort(([a], [b]) => a.localeCompare(b)));
  return contract.dataSnapshot ? { [contract.symbols[0]]: contract.dataSnapshot } : {};
}

/**
 * Everything that decides what a run can learn: market, sorted symbols, bar size, engine, the designer's tool
 * version (policy), cost profile and the frozen costs, the four time boundaries, the per-symbol data snapshot
 * hashes and the owner's research direction. Creation time, budget and request id are not part of it.
 */
export async function ctBoardSignature(contract: CTContract, brief: string | undefined | null) {
  return ctHash({
    v: 1,
    market: contract.market,
    symbols: [...contract.symbols].sort(),
    minutes: contract.minutes,
    engine: contract.engine,
    tools: contract.policy.traderTools ?? 0,
    costProfile: contract.costProfile ?? null,
    costs: contract.costs,
    bounds: [contract.fromMs, contract.trainingToMs, contract.developmentToMs, contract.toMs],
    snapshots: ctSnapshotsOf(contract),
    brief: ctNormalizeBrief(brief),
  });
}

export type CTBoardPrior = { id: string; at: string; status: string; endReason: string | null; phase: string };

/** HTTP 409 with the structured reason the CT screen shows (and the "run anyway" form needs). */
export class CTBoardRepeatError extends Error {
  status = 409;
  detail: { code: "board_repeat"; signature: string; previous: CTBoardPrior[] };
  constructor(signature: string, previous: CTBoardPrior[]) {
    const last = previous[0];
    const day = (iso: string) => iso.slice(0, 10);
    super(
      `같은 판입니다: 이전 연구 ${last.id.slice(0, 8)}(${day(last.at)})${last.status === "running" || last.status === "paused" ? "가 아직 진행 중입니다" : `가 같은 계약·비용·데이터·연구 방향으로 이미 끝났습니다 · ${last.endReason ?? "통과 전략 없음"}`}` +
        `${previous.length > 1 ? ` (같은 판 ${previous.length}회)` : ""}. 같은 판을 다시 돌려도 새로 알게 되는 것은 없고 누적 검정 수만 늘어납니다. ` +
        `새 판으로 만들려면 종목, 연구 기간, 연구 방향(brief)을 바꾸거나 새 데이터·비용 프로필 갱신이 있어야 합니다. 그래도 실행하려면 이유(10자 이상)를 적고 “그래도 실행”을 누르세요.`,
    );
    this.name = "CTBoardRepeatError";
    this.detail = { code: "board_repeat", signature, previous };
  }
}
