import { z } from "zod";
import { shiftDate } from "./market-clock.ts";
import { SLOT_IDS, universeSchema } from "./strategy-generation-spec.ts";
import { isExcludedInstrument } from "./trade-slots.ts";
import type { StrategyResearch } from "./strategy-generation-types.ts";

export const researchRequestSchema = z.object({
  goal: z.enum(["discover", "complement", "idea"]).default("discover"),
  brief: z.string().trim().max(1500).default(""),
  universe: universeSchema.optional(),
  slot: z.enum(SLOT_IDS).optional(),
  budgetUsd: z.union([z.literal(8), z.literal(16), z.literal(24)]).default(8),
  requestId: z.string().uuid(),
}).strict().refine(request => request.goal !== "idea" || request.brief.length >= 5, {
  message: "검증할 아이디어를 5자 이상 적어주세요.", path: ["brief"],
});

export const discoveryPlanSchema = z.object({
  summary: z.string().min(10).max(1200),
  options: z.array(z.object({
    title: z.string().min(3).max(80),
    hypothesis: z.string().min(20).max(1200),
    rationale: z.string().min(10).max(800),
    slot: z.enum(SLOT_IDS),
    universe: universeSchema.refine(symbols => symbols.length <= 3, "후보당 최대 3종목"),
  }).strict()).min(1).max(3),
}).strict();

/** Partition calendar dates before discovery; symbol availability cannot move a test boundary. */
export function researchCalendar(from: string, to: string) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const trainDays = Math.floor(days * 0.6);
  const remaining = days - trainDays;
  const windows = Array.from({ length: 3 }, (_, index) => {
    const start = trainDays + Math.floor(remaining * index / 3);
    const end = trainDays + Math.floor(remaining * (index + 1) / 3);
    const middle = start + Math.floor((end - start) / 2);
    return { validationFrom: shiftDate(from, start), validationTo: shiftDate(from, middle - 1),
      holdoutFrom: shiftDate(from, middle), holdoutTo: shiftDate(from, end - 1) };
  });
  return { trainingTo: shiftDate(from, trainDays - 1), windows };
}

export function validateDiscoveryPlan(
  plan: z.infer<typeof discoveryPlanSchema>,
  candidates: string[],
  slots: string[],
  constraints: StrategyResearch["constraints"],
) {
  const scopes = new Set<string>();
  for (const option of plan.options) {
    if (!slots.includes(option.slot) || (constraints.slot && option.slot !== constraints.slot))
      throw new Error("탐색 계획이 허용된 시간대를 벗어났습니다.");
    if (option.universe.some(symbol => !candidates.includes(symbol) || isExcludedInstrument(symbol) ||
      (constraints.universe && !constraints.universe.includes(symbol))))
      throw new Error("탐색 계획에 데이터로 확인되지 않은 종목이 있습니다.");
    const scope = `${option.slot}:${[...option.universe].sort().join(",")}:${option.hypothesis}`;
    if (scopes.has(scope)) throw new Error("탐색 계획에 중복된 가설이 있습니다.");
    scopes.add(scope);
  }
  return plan;
}
