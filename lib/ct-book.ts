import {
  ctDataAt,
  ctHigherSets,
  ctLevelSets,
  ctHistoryBars,
  detectCT,
  replayCT,
  type CTBar,
  type CTResult,
  type CTSignal,
} from "./ct-engine.ts";
import {
  ctHash,
  executableCT,
  type CTContract,
  type CTSpec,
} from "./ct-spec.ts";
import type { CTComponentRecord } from "./ct-components.ts";
export const CT_BOOK_ENGINE = "ct-book-1";
export type CTBookRule =
  | { kind: "vote"; k: number }
  | { kind: "confluence"; pair: [string, string] };
export type CTBookState = {
  active: Record<string, number>;
  day: string;
  target: boolean;
};
export type CTBookRecord = {
  id: string;
  hash: string;
  componentIds: string[];
  rule: CTBookRule;
  spec: CTSpec;
  frozenAt: string;
  training: CTResult;
  development?: CTResult;
  stress?: CTResult;
  delayed?: CTResult;
  reasons: string[];
  overlap?: Record<string,Record<string,number>>;
  contribution?: Array<{componentId:string;netPnlDelta:number;sharePct:number|null}>;
  costSharePct?: number|null;
  computationVariants?: number;
};
/** First signal fixes expiry. Repeats cannot extend it or count twice. */
export function ctBookStep(
  state: CTBookState,
  event: {
    at: number;
    day: string;
    signals: Array<{ id: string; expiresAt: number }>;
  },
  rule: CTBookRule,
) {
  const active = event.day === state.day ? { ...state.active } : {};
  for (const [id, expiry] of Object.entries(active))
    if (expiry <= event.at) delete active[id];
  for (const s of event.signals)
    if (active[s.id] === undefined && s.expiresAt > event.at)
      active[s.id] = s.expiresAt;
  const score = Object.keys(active).length,
    target =
      rule.kind === "vote"
        ? score >= rule.k
        : rule.pair.every((id) => active[id] !== undefined);
  return {
    state: { active, day: event.day, target },
    score,
    intent:
      target && !state.target
        ? "enter"
        : !target && state.target
          ? "exit"
          : "hold",
  } as const;
}
export function assertCTBookRegistration(b: CTBookRecord) {
  if (
    b.componentIds.length < 2 ||
    b.componentIds.length > 8 ||
    b.reasons.length ||
    !b.development
  )
    throw new Error("검증된 2–8개 부품 북만 등록할 수 있습니다");
}
/** Book signal aggregation plugs into the original fill/exit/risk loop. No duplicate fill engine. */
export function replayCTBook(
  book: Pick<CTBookRecord, "componentIds" | "rule" | "spec" | "hash">,
  components: CTComponentRecord[],
  raw: Record<string, CTBar[]>,
  c: CTContract,
  from: number,
  to: number,
  options: {
    costMultiplier?: number;
    delayBars?: number;
    deadline?: number;
  } = {},
) {
  const rows = components.filter((r) => book.componentIds.includes(r.id));
  if(rows.length===1&&book.rule.kind==="vote"&&book.rule.k===1&&JSON.stringify(executableCT(book.spec))===JSON.stringify(executableCT(rows[0].candidate.spec)))return replayCT(rows[0].candidate.spec,raw,c,from,to,book.hash,options);
  if (rows.length !== book.componentIds.length) throw new Error("북 부품 누락");
  const policy = createCTBookPolicy(book, components, raw, c, from, to);

  return replayCT(book.spec, raw, c, from, to, book.hash, {
    ...options,
    policy,
  });
}
export async function ctFreezeBooks(
  components: CTComponentRecord[],
  raw: Record<string, CTBar[]>,
  c: CTContract,
  deadline?: number,
) {
  if (components.length < 2) return [];
  const ids = components.map((r) => r.id),
    base = structuredClone(components[0].candidate.spec),
    factor = base.minutes;
  base.minutes = 1;
  base.exit.maxHoldBars *= factor;
  base.sizing.cooldownBars *= factor;
  const rules: CTBookRule[] = [
    ...new Set([1, Math.max(2, Math.ceil(ids.length / 2))]),
  ].map((k) => ({ kind: "vote", k }));
  rules.push({ kind: "confluence", pair: [ids[0], ids[1]] });
  const candidates: CTBookRecord[] = [];
  for (const rule of rules) {
    const hash = await ctHash({
        engine: CT_BOOK_ENGINE,
        accounting: "ct-accounting-1",
        components: components.map((r) => r.hash),
        rule,
        spec: executableCT(base),
      }),
      b = {
        id: `book:${hash.slice(0, 16)}`,
        hash,
        componentIds: ids,
        rule,
        spec: base,
        frozenAt: new Date().toISOString(),
        training: null as unknown as CTResult,
        reasons: [],
      } satisfies CTBookRecord;
    b.training = replayCTBook(b, components, raw, c, c.fromMs, c.trainingToMs, {
      deadline,
    });
    candidates.push(b);
  }
  return candidates
    .sort(
      (a, b) =>
        (b.training.meanDailyReturnPct ?? 0) -
          (a.training.meanDailyReturnPct ?? 0) || a.hash.localeCompare(b.hash),
    )
    .slice(0, 3);
}

export function createCTBookPolicy(
  book: Pick<CTBookRecord, "componentIds" | "rule" | "spec" | "hash">,
  components: CTComponentRecord[],
  raw: Record<string, CTBar[]>,
  c: CTContract,
  from: number,
  to: number,
) {
  const rows = components.filter((r) => book.componentIds.includes(r.id));
  const prepared = rows.map((r) => {
    const data = ctDataAt(raw, r.candidate.spec.minutes);
    return {
      r,
      data,
      first: Object.fromEntries(
        Object.entries(data).map(([s, bs]) => [
          s,
          bs.findIndex((b) => b.startMs >= from),
        ]),
      ),
      index: Object.fromEntries(
        Object.entries(data).map(([s, bs]) => [
          s,
          new Map(bs.map((b, i) => [b.endMs, i])),
        ]),
      ),
      higher: Object.fromEntries(
        Object.entries(data).map(([s, bs]) => [
          s,
          ctHigherSets(
            r.candidate.spec,
            bs.filter((b) => b.startMs >= from && b.endMs <= to),
            s,
          ),
        ]),
      ),
      levels: Object.fromEntries(
        Object.entries(data).map(([s, bs]) => [
          s,
          ctLevelSets(
            r.candidate.spec,
            bs.filter((b) => b.startMs >= from && b.endMs <= to),
          ),
        ]),
      ),
    };
  });
  let state: CTBookState = { active: {}, day: "", target: false },
    last: CTSignal | null = null;
  const update = (at: number) => {
    const day = new Date(at - 1).toISOString().slice(0, 10),
      signals: Array<{ id: string; expiresAt: number }> = [];
    for (const p of prepared)
      for (const symbol of book.spec.symbols) {
        const i = p.index[symbol]?.get(at);
        if (i === undefined) continue;
        const spec = p.r.candidate.spec,
          bs = p.data[symbol],
          signal = detectCT(
            spec,
            symbol,
            bs.slice(
              Math.max(p.first[symbol], i - ctHistoryBars(spec), 0),
              i + 1,
            ),
            at,
            undefined,
            p.higher[symbol],
            p.levels[symbol],
          );
        if (signal) {
          last = signal;
          signals.push({
            id: p.r.id,
            expiresAt: at + spec.exit.maxHoldBars * spec.minutes * 60000,
          });
        }
      }
    state = ctBookStep(state, { at, day, signals }, book.rule).state;
  };
  return {
    observe: update,
    signal: (symbol: string, at: number) =>
      state.target && last?.symbol === symbol
        ? { ...last, decidedAt: at, validUntil: at + 60000 }
        : null,
    exit: () => !state.target,
    target: () => state.target,
  };
}
export function ctBookRuntime(
  book: CTBookRecord,
  components: CTComponentRecord[],
  data: Record<string, CTBar[]>,
  c: CTContract,
  at: number,
) {
  const from = Math.max(c.fromMs, Math.floor((at - 1) / 86400000) * 86400000),
    p = createCTBookPolicy(book, components, data, c, from, at);
  const times = [
    ...new Set(
      Object.values(data).flatMap((bs) =>
        bs.filter((b) => b.endMs <= at && b.endMs > from).map((b) => b.endMs),
      ),
    ),
  ].sort((a, b) => a - b);
  for (const t of times) p.observe(t);
  return { target: p.target(), signal: p.signal(book.spec.symbols[0], at) };
}
