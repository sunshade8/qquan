/**
 * Idea families (stage 5): the fixed list and the DETERMINISTIC classifier the lessons and the coverage map share.
 * Pure (no database), so the CT screen can import it. docs/ct.md「연구 교훈」.
 *
 * Nothing is stored for a family: it is computed whenever a row is read, so it applies to old rows too.
 */
import { CT_BASE_FEATURES, CT_LEVEL_FEATURES, CT_VOLATILITY_FEATURES, type CTSpec } from "./ct-spec.ts";

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** "return_pct(1m) · volume_ratio(1m)" of a spec's conditions; thresholds excluded. */
export function structureOf(spec: CTSpec) {
  const names = spec.stages.map((s) => [...new Set(s.conditions.map((c) => `${c.feature}(${c.timeframe}m${c.unit === "atr" ? ",ATR" : ""})`))].join(" + "));
  return clip(names.join(" → ") + (spec.entry.entryWindows?.length ? " · 시간 창" : "") + (spec.exit && "stop" in spec.exit ? " · 관리형 청산" : ""), 300);
}
/** The mechanism and structure text a candidate files in the playbook (the family classifier reads exactly these). */
export const ctCandidateIdea = (name: string, mechanism: string, spec: CTSpec) => ({ mechanism: clip(`${name} — ${mechanism}`, 400), structure: structureOf(spec) });

/**
 * Changing this list: add values freely, never change what an existing value means (stored lessons name them).
 * Reasons are in docs/ct.md「연구 교훈」.
 */
export const CT_FAMILIES = [
  "mean_reversion",
  "breakout",
  "trend_following",
  "volatility_regime",
  "time_seasonality",
  "liquidation_cascade",
  "levels_gaps",
  "multi_timeframe_context",
  "holding_overnight",
  "other",
] as const;
export type CTFamily = (typeof CT_FAMILIES)[number];
export const CT_FAMILY_TEXT: Record<CTFamily, string> = {
  mean_reversion: "평균 회귀 · 급락·과매도 반등",
  breakout: "돌파 · 범위·고점·저점",
  trend_following: "추세 추종 · 모멘텀 · 추세 속 눌림",
  volatility_regime: "변동성 수축·확대·국면",
  time_seasonality: "시간대 · 요일 계절성",
  liquidation_cascade: "청산 연쇄",
  levels_gaps: "기준 가격 · 갭 (VWAP·전일 고저·시가 범위)",
  multi_timeframe_context: "상위 시간대 조건",
  holding_overnight: "전일 → 다음 날 보유",
  other: "기타",
};

export type CTFeatureUse = { feature: string; timeframe: number; op?: "gte" | "lte"; unit?: string };

/** "return_pct(1m) · sma_distance_pct(60m,ATR)" → the features a playbook structure names. */
export function ctStructureFeatures(structure: string) {
  const out: Array<{ feature: string; timeframe: number; atr: boolean }> = [];
  for (const m of structure.matchAll(/([a-z_]+)\((\d+)m(,ATR)?\)/g)) out.push({ feature: m[1], timeframe: Number(m[2]), atr: Boolean(m[3]) });
  return out;
}

const LEVEL_FEATURES: readonly string[] = CT_LEVEL_FEATURES;
const VOL_FEATURES = ["atr_pct", "atr_percentile", "contraction_ratio"];
const split = (mechanism: string) => {
  const i = mechanism.indexOf(" — ");
  return i < 0 ? { head: mechanism, tail: "" } : { head: mechanism.slice(0, i), tail: mechanism.slice(i + 3) };
};

/**
 * Keyword rules on the idea's HEAD (the hypothesis or candidate name; the tail is the designer's why and often names the
 * cause of another family), first match wins. Order matters and is part of the definition: the specific families first
 * (overnight, a hypothesis about "features that predict" the moves, liquidations, levels, clock), the pattern families next.
 */
const HEAD_RULES: Array<[CTFamily, RegExp]> = [
  ["holding_overnight", /(다음|익)\s?(UTC\s?)?(날|일)(?![가-힣])|하루\s?보유|일\s?시작에\s?매수|오버나이트|overnight|종가\s?매수/i],
  ["other", /(사건\s?)?직전\s?특징|미리\s?(고를|가를)/],
  ["liquidation_cascade", /청산|캐스케이드|cascade|liquidat|셀링\s?클라이맥스/i],
  ["levels_gaps", /VWAP|전일\s?(고|저|종)|갭|시초|오프닝\s?레인지|opening|당일\s?시가|시가\s?(대비|회복|범위)|일중\s?공정/i],
  ["time_seasonality", /계절성|요일|펀딩|(?<!상위\s)시간대|미국장|세션\s?(별|시작)|UTC\s?\d|\d{1,2}\s?[~-]\s?\d{1,2}\s?UTC|월말|월초/i],
  ["volatility_regime", /변동성\s?(수축|압축|확장|국면)|수축|압축|(?<!숏\s)스퀴즈|squeeze|ATR\s?(상위|하위|백분위|압축)|빌드업|contraction/i],
  ["breakout", /돌파|breakout|2B|실패한?\s?붕괴|이탈\s?(후|뒤)|저점\s?이탈|고점\s?이탈|false\s?break/i],
  ["trend_following", /추세|모멘텀|눌림|눌리|풀백|추종|점화|상승\s?지속|연장\s?매수|드라이브|드리프트|지속/],
  ["mean_reversion", /급락|과매도|반등|평균\s?회귀|되돌림|투매|하단|저점|지지|반전|하락\s?(뒤|후)|바닥|V자|회복|저가\s?매수/],
  ["multi_timeframe_context", /상위\s?시간|일봉|다일|시간봉|다중\s?시간/],
];

/** The family of one playbook idea: keyword rules on its text, then the shape of its feature list; `other` when neither says. */
export function ctIdeaFamily(idea: { mechanism: string; structure: string }): CTFamily {
  const { head } = split(idea.mechanism);
  for (const [family, re] of HEAD_RULES) if (re.test(head)) return family;
  const features = ctStructureFeatures(idea.structure);
  const names = new Set(features.map((f) => f.feature));
  if ([...names].some((n) => LEVEL_FEATURES.includes(n))) return "levels_gaps";
  if ([...names].some((n) => VOL_FEATURES.includes(n))) return "volatility_regime";
  if (names.has("prior_high_distance_pct") || names.has("swing_high_distance_pct")) return "breakout";
  if (names.has("prior_low_distance_pct") || names.has("swing_low_distance_pct")) return "mean_reversion";
  const frames = features.map((f) => f.timeframe);
  if (frames.some((t) => t >= 60) && frames.some((t) => t <= 3)) return "multi_timeframe_context";
  return "other";
}

/**
 * The family from the conditions alone (no text): used for ledger signatures, which carry only features, timeframes,
 * directions and units, and as a second opinion on a submitted candidate (a name cannot move it).
 */
export function ctStructuralFamily(uses: CTFeatureUse[]): CTFamily {
  const names = new Set(uses.map((u) => u.feature));
  if ([...names].some((n) => LEVEL_FEATURES.includes(n))) return "levels_gaps";
  if ([...names].some((n) => VOL_FEATURES.includes(n))) return "volatility_regime";
  if (uses.some((u) => (u.feature === "prior_high_distance_pct" || u.feature === "swing_high_distance_pct") && u.op !== "lte")) return "breakout";
  const directional = uses.filter((u) => ["return_pct", "sma_distance_pct", "range_position", "prior_low_distance_pct", "swing_low_distance_pct", "prior_high_distance_pct", "swing_high_distance_pct"].includes(u.feature));
  const down = directional.filter((u) => u.op === "lte").length;
  const up = directional.filter((u) => u.op === "gte").length;
  if (down > up) return "mean_reversion";
  if (up > 0) return "trend_following";
  const frames = uses.map((u) => u.timeframe);
  if (frames.some((t) => t >= 60) && frames.some((t) => t <= 3)) return "multi_timeframe_context";
  return "other";
}

/** The conditions of a spec as feature uses. */
export const ctSpecUses = (spec: Pick<CTSpec, "stages">): CTFeatureUse[] =>
  spec.stages.flatMap((s) => s.conditions.map((c) => ({ feature: c.feature, timeframe: c.timeframe, op: c.op, unit: c.unit ?? "pct" })));

/**
 * The families a submitted candidate belongs to: the one its playbook row will carry (text + structure, exactly the
 * strings the row is built from) and the structural one. The dead-family check applies if EITHER is dead.
 */
export function ctCandidateFamilies(candidate: { spec: CTSpec; hypothesis: { mechanism: string } }) {
  const idea = ctCandidateIdea(candidate.spec.name, candidate.hypothesis.mechanism, candidate.spec);
  const primary = ctIdeaFamily(idea);
  const structural = ctStructuralFamily(ctSpecUses(candidate.spec));
  return { primary, structural, all: [...new Set([primary, structural])] as CTFamily[] };
}

/* ----------------------------------------------------------------------- ledger signatures */

const FEATURES: readonly string[] = [...CT_BASE_FEATURES, ...CT_LEVEL_FEATURES, ...CT_VOLATILITY_FEATURES];
function parseConditions(body: string) {
  const uses: CTFeatureUse[] = [];
  for (const stage of body.split(">"))
    for (const cond of stage.split("&")) {
      const [feature, timeframe, op, unit] = cond.split("|");
      if (!FEATURES.includes(feature) || !Number.isFinite(Number(timeframe))) continue;
      uses.push({ feature, timeframe: Number(timeframe), op: op === "lte" ? "lte" : "gte", unit: unit || "pct" });
    }
  return uses;
}
export type CTParsedSignature =
  | { kind: "conditions"; uses: CTFeatureUse[]; window: boolean }
  | { kind: "contrast"; uses: CTFeatureUse[] }
  | { kind: "diagnose"; uses: CTFeatureUse[]; window: boolean }
  | { kind: "label" | "blind"; uses: [] };
/** A ledger signature (ctTestSignature, contrast / diagnose / label / blind cells) as the features it examined. */
export function ctParseSignature(sig: string): CTParsedSignature {
  if (sig.startsWith("label|")) return { kind: "label", uses: [] };
  if (sig.startsWith("blind|")) return { kind: "blind", uses: [] };
  if (sig.startsWith("contrast|")) {
    const [, feature, timeframe, unit] = sig.split("|");
    return { kind: "contrast", uses: FEATURES.includes(feature) ? [{ feature, timeframe: Number(timeframe), unit }] : [] };
  }
  if (sig.startsWith("diagnose|")) {
    const parts = sig.split("|");
    const rule = parts.slice(1, -2).join("|");
    const window = rule.endsWith("|W");
    return { kind: "diagnose", uses: parseConditions(window ? rule.slice(0, -2) : rule), window };
  }
  const window = sig.endsWith("|W");
  return { kind: "conditions", uses: parseConditions(window ? sig.slice(0, -2) : sig), window };
}

