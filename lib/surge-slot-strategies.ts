/**
 * Published 급등주 rules, in the shape the live trading engine runs.
 *
 * Each rule owns the regular session as its window (so it reads the session
 * from 09:30, as its session features assume), decides on its own bar size,
 * takes up to `maxTradesPerDay` sequential entries and holds each at most
 * `maxHoldMinutes` — the same clock `runSurge` replays. Its universe is today's
 * observed events it could still enter, rebuilt every tick.
 */

import { compileSurgeStrategy, SURGE_DAY_FROM, SURGE_EXIT_BY, type SurgePool } from "./surge-spec.ts";
import { registeredSurgeSpecs } from "@/lib/surge-store";
import { readIntradaySurgePool } from "./surge-intraday-live.ts";
import { easternParts } from "./market-clock.ts";
import { isExcludedInstrument } from "./trade-slots.ts";
import type { SlotStrategy } from "./relay-engine.ts";

export type SurgeLiveRule = {
  id: string;
  name: string;
  pool: SurgePool;
  interval: string;
  /** "관측 후 5–60분 · 09:45–15:00 ET 결정 · 최대 30분 보유" */
  timing: string;
  stopPct: number;
  targetPct: number;
  rewardRisk: number;
  maxTradesPerDay: number;
  /** Today's events this rule may still enter. Empty means nothing to do right now. */
  universe: string[];
  /** Today's events of this rule's side, whether or not it may enter them. */
  observed: number;
  checkedAt: string | null;
  /** Null when the rule can run; otherwise why it is withheld from execution. */
  withheld: string | null;
};

const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

async function build(nowMs = Date.now()) {
  const specs = await registeredSurgeSpecs();
  const observation = await readIntradaySurgePool(nowMs);
  const now = easternParts(nowMs).time;
  const rules: Array<{ rule: SurgeLiveRule; strategy: SlotStrategy | null }> = [];
  const claimed = new Set<SurgePool>();

  for (const row of specs) {
    const surge = compileSurgeStrategy(row.spec);
    // One rule per side: the newest published one trades, older ones are kept for the record.
    const shadowed = claimed.has(surge.pool);
    const events = observation.candidates[surge.pool];
    // Only events still inside the rule's entry reach are worth a candle fetch every tick.
    const reachable = events.filter((event) => surge.eligible(event) && !isExcludedInstrument(event.symbol) &&
      minute(now) - minute(event.observedAt!) <= surge.maxMinutesSinceEvent + 2 * surge.step &&
      minute(event.observedAt!) + surge.minMinutesSinceEvent <= minute(surge.entryTo));
    const withheld = shadowed ? `같은 ${surge.pool === "gainers" ? "급상승" : "급하락"} 쪽에 더 최근 규칙이 있습니다.`
      : observation.error ?? (!reachable.length ? "진입 가능한 당일 급등락 사건을 기다리는 중입니다." : null);

    const rule: SurgeLiveRule = {
      id: surge.id,
      name: surge.name,
      pool: surge.pool,
      interval: surge.interval,
      timing: `관측 후 ${surge.minMinutesSinceEvent}–${surge.maxMinutesSinceEvent}분 · ${surge.entryFrom}–${surge.entryTo} ET 결정 · 최대 ${surge.maxHoldMinutes}분 보유 · ${SURGE_EXIT_BY} 청산`,
      stopPct: surge.stopPct,
      targetPct: surge.targetPct,
      rewardRisk: surge.rewardRisk,
      maxTradesPerDay: surge.maxTradesPerDay,
      universe: observation.error ? [] : reachable.map((event) => event.symbol),
      observed: events.length,
      checkedAt: observation.checkedAt,
      withheld,
    };

    if (shadowed) {
      rules.push({ rule, strategy: null });
      continue;
    }
    claimed.add(surge.pool);
    rules.push({
      rule,
      strategy: {
        barMinutes: surge.step as 1 | 3 | 5,
        id: surge.id,
        name: surge.name,
        // A nominal slot for the dashboard's bookkeeping; the rule's clock is `window`.
        slot: "open",
        window: { from: SURGE_DAY_FROM, to: SURGE_EXIT_BY },
        maxEntriesPerDay: surge.maxTradesPerDay,
        maxHoldMinutes: surge.maxHoldMinutes,
        universe: rule.universe,
        summary: surge.summary,
        rules: surge.rules,
        evidence: `급등주 · 당일 ${surge.pool === "gainers" ? "급상승" : "급하락"} 사건 ${observation.date} 관측`,
        cautions: surge.cautions,
        warmupSessions: 0,
        execution: { ...surge.execution, maxSpreadPct: surge.maxSpreadPct },
        scan(context) {
          if (observation.error) return null;
          const rows = events.filter((event) => event.symbol in context.window)
            .map((candidate) => ({ candidate, bars: context.window[candidate.symbol] ?? [] }));
          return surge.scan({ date: context.date, asOf: context.asOf, rows, equityUsd: context.equityUsd });
        },
      },
    });
  }
  return rules;
}

/** What the live engine may trade right now. */
export async function todaysSurgeStrategies(): Promise<SlotStrategy[]> {
  return (await build()).map((entry) => entry.strategy).filter((strategy): strategy is SlotStrategy => strategy !== null);
}

/** Every published rule with today's reachable events and, when it cannot run, why. */
export async function todaysSurgeRules(): Promise<SurgeLiveRule[]> {
  return (await build()).map((entry) => entry.rule);
}
