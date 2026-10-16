import { FREE_ROUTER_AUTO, familyOf, placeModels, type CatalogEntry, type FreeRole, type Placement } from "./t-free-models.ts";

/**
 * T roles. Same role names and meaning as CT's, but every call goes to a free-tier model through freellmapi.
 * `model` is the live placement (lib/t-free-models.ts) and `provider` the model's company, so "independent reviewer"
 * can still be reported honestly. Prices are VIRTUAL: actual spend is $0; the nominal rate only keeps the budget
 * a bound on how much a run may think, exactly like CT's dollar budget (a run's `budgetUsd` is a token allowance).
 */
export const T_VIRTUAL_RATE = { input: 0.15, output: 0.6 } as const;

type Row = { provider: string; model: string; label: string; input: number; output: number; effort: "low" | "medium" | "high" };
const row = (label: string, effort: Row["effort"]): Row => ({ provider: "Router", model: FREE_ROUTER_AUTO, label, input: T_VIRTUAL_RATE.input, output: T_VIRTUAL_RATE.output, effort });

export const CT_MODELS: Record<FreeRole, Row> = {
  ctOrchestrator: row("T 총괄", "medium"),
  ctAnalyst: row("T 자료 분석 · 원리 추출", "low"),
  ctDesigner: row("T 연구 · 설계 · 수정", "high"),
  ctLessons: row("T 교훈 증류", "low"),
  ctRiskReviewer: row("T 독립 위험 검토", "high"),
  ctEvidenceReviewer: row("T 독립 최종 검토", "high"),
};
export const GENERATION_MODELS = CT_MODELS;
export const RESEARCH_MODELS: Record<FreeRole, Row> = CT_MODELS;
export type GenerationRole = FreeRole;
export type CTRole = FreeRole;
export const CT_ROLES = Object.keys(CT_MODELS) as CTRole[];

let placements: Placement[] = [];
/** Installs the placement chosen from the live catalog; rows keep their label and virtual rate. */
export function applyPlacements(next: Placement[]) {
  placements = next;
  for (const p of next) RESEARCH_MODELS[p.role] = { ...RESEARCH_MODELS[p.role], model: p.model, provider: p.family };
}
export function currentPlacements() { return placements; }
export function placementChain(role: GenerationRole) {
  const p = placements.find((x) => x.role === role);
  return p ? [p.model, ...p.chain] : [FREE_ROUTER_AUTO];
}
export function placeFromCatalog(catalog: CatalogEntry[]) {
  const next = placeModels(catalog);
  applyPlacements(next);
  return next;
}

export function researchModel(role: GenerationRole, _failures = 0) {
  void _failures;
  return RESEARCH_MODELS[role];
}
/** Free-tier models cap output well below frontier ones; the designer's turn carries thinking plus one tool call. */
export const CT_DESIGNER_TURN_MAX_TOKENS = 16000;
export const CT_DESIGNER_RETRY_MAX_TOKENS = 16000;
export const CT_DESIGNER_TURN_RETRY_MAX_TOKENS = 24000;
export function researchMaxTokens(role: GenerationRole) {
  if (role === "ctDesigner") return CT_DESIGNER_TURN_MAX_TOKENS;
  if (role === "ctLessons") return 6000;
  return role === "ctAnalyst" ? 4000 : 12000;
}
export type ResearchEffort = "low" | "medium" | "high" | "xhigh";
export function researchCallLimits(role: GenerationRole, options: { ct?: boolean; truncated?: boolean } = {}) {
  const primary = RESEARCH_MODELS[role];
  const base = { maxOutputTokens: researchMaxTokens(role), effort: primary.effort as ResearchEffort };
  if (!options.ct || !options.truncated) return base;
  const lower: Record<ResearchEffort, ResearchEffort> = { xhigh: "high", high: "medium", medium: "low", low: "low" };
  return { maxOutputTokens: role === "ctDesigner" ? CT_DESIGNER_TURN_RETRY_MAX_TOKENS : base.maxOutputTokens, effort: lower[base.effort] };
}
/**
 * Free tiers often have a single usable company, so T cannot always demand a different one. It always demands a different
 * model, and reports whether the company differs so the screen can say how independent the review really was.
 */
export function assertDifferentProvider(author: GenerationRole, reviewer: GenerationRole) {
  if (RESEARCH_MODELS[author].model === RESEARCH_MODELS[reviewer].model && RESEARCH_MODELS[author].model !== FREE_ROUTER_AUTO)
    throw new Error("검증자는 작성자와 다른 모델이어야 합니다.");
}
export function reviewIndependence() {
  const a = RESEARCH_MODELS.ctDesigner, r = RESEARCH_MODELS.ctRiskReviewer, e = RESEARCH_MODELS.ctEvidenceReviewer;
  const sameCompany = familyOf(a.model) === familyOf(r.model) || familyOf(a.model) === familyOf(e.model);
  return { sameCompany, models: { designer: a.model, risk: r.model, evidence: e.model } };
}
export const MODEL_SOURCES = ["https://livebench.ai", "https://github.com/tashfeenahmed/freellmapi"];
/** No provider web-search tool exists on the free lane; CT's optional source phase is skipped. */
export const RESEARCH_WEB_SEARCH = { maxCalls: 0, usdPerCall: 0, source: "" } as const;
