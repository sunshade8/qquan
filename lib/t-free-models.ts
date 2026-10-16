/**
 * T — the free-tier research lane. Which model plays which role.
 *
 * Models come from a local freellmapi router (an OpenAI/Anthropic-compatible proxy that pools free provider tiers).
 * What it can serve changes daily (keys, quotas, upstream removals), so placement is decided at run time from
 * its live catalog; this file holds the ranking knowledge that decision uses.
 *
 * Scores: LiveBench 2.0, release 2026-10-14 (https://livebench.ai). Only models that appear on that board and that
 * freellmapi can route are listed; anything else the router offers is ranked after them by `FALLBACK_ORDER`.
 */

export type FreeRole = "ctOrchestrator" | "ctAnalyst" | "ctDesigner" | "ctLessons" | "ctRiskReviewer" | "ctEvidenceReviewer";

export type LiveBenchRow = {
  /** freellmapi catalog ids that are this model (aliases included). */
  ids: string[];
  name: string;
  family: string;
  overall: number;
  agentic: number;
  reasoning: number;
  coding: number;
  data: number;
  research: number;
};

export const LIVEBENCH_RELEASE = "2026-10-14";

export const LIVEBENCH: LiveBenchRow[] = [
  { ids: ["deepseek-v4-flash", "deepseek-v4-flash-0731"], name: "DeepSeek V4.1 Flash", family: "DeepSeek", overall: 77.3, agentic: 43.8, reasoning: 86.7, coding: 85.4, data: 79.3, research: 85.3 },
  { ids: ["glm-5.3-flash"], name: "GLM-5.3 Flash", family: "Z.AI", overall: 70.6, agentic: 28.4, reasoning: 77.6, coding: 80.6, data: 76.4, research: 70.1 },
  { ids: ["qwen3.8-flash", "qwen3.8-flash-next"], name: "Qwen3.8 Flash", family: "Alibaba", overall: 68.8, agentic: 37.1, reasoning: 87.4, coding: 87.4, data: 74.2, research: 74.6 },
  { ids: ["gemini-3.8-flash"], name: "Gemini 3.8 Flash", family: "Google", overall: 67.3, agentic: 30.1, reasoning: 89.3, coding: 82.2, data: 54.0, research: 79.1 },
  { ids: ["gemini-3.7-flash"], name: "Gemini 3.7 Flash", family: "Google", overall: 67.2, agentic: 28.3, reasoning: 87.8, coding: 80.5, data: 68.0, research: 76.5 },
  { ids: ["gpt-5.6-luna"], name: "GPT-5.6 Luna", family: "OpenAI", overall: 66.1, agentic: 30.4, reasoning: 85.6, coding: 73.6, data: 78.0, research: 51.0 },
  { ids: ["qwen3.8-27b", "qwen-3.8-27b"], name: "Qwen3.8 27B", family: "Alibaba", overall: 62.7, agentic: 27.9, reasoning: 80.0, coding: 86.8, data: 76.6, research: 59.4 },
  { ids: ["glm-5.3"], name: "GLM-5.3", family: "Z.AI", overall: 60.7, agentic: 35.9, reasoning: 85.8, coding: 82.8, data: 70.2, research: 73.2 },
  { ids: ["minimax-m3"], name: "MiniMax M3", family: "MiniMax", overall: 53.7, agentic: 12.4, reasoning: 74.5, coding: 70.9, data: 76.2, research: 68.0 },
  { ids: ["gemma-4-31b-it", "gemma-4-31b"], name: "Gemma 4 31B", family: "Google", overall: 41.5, agentic: 13.3, reasoning: 68.3, coding: 49.0, data: 53.3, research: 44.4 },
  { ids: ["nemotron-3-ultra", "nemotron-3-ultra-550b"], name: "Nemotron 3 Ultra", family: "NVIDIA", overall: 40.8, agentic: 11.2, reasoning: 74.7, coding: 43.6, data: 54.5, research: 43.2 },
  { ids: ["nemotron-3.5-lightning", "nemotron-3.5-lightning-30b", "nemotron-3.5-lightning-30b-a3b"], name: "Nemotron 3.5 Lightning", family: "NVIDIA", overall: 28.7, agentic: 8.3, reasoning: 42.9, coding: 22.6, data: 43.1, research: 40.0 },
];

/**
 * What each role needs, as LiveBench weights (sum 1). The designer runs a long tool loop and writes executable
 * specifications, so agentic and coding dominate; reviewers judge statistics and leakage, so reasoning and data
 * analysis dominate; the planner searches and reads; the cheap summarisers only need a sound overall score.
 */
export const ROLE_WEIGHTS: Record<FreeRole, Partial<Record<"agentic" | "reasoning" | "coding" | "data" | "research" | "overall", number>>> = {
  ctDesigner: { agentic: 0.4, coding: 0.25, reasoning: 0.25, data: 0.1 },
  ctRiskReviewer: { reasoning: 0.5, data: 0.3, research: 0.2 },
  ctEvidenceReviewer: { reasoning: 0.45, data: 0.4, research: 0.15 },
  ctOrchestrator: { research: 0.4, reasoning: 0.3, data: 0.3 },
  ctAnalyst: { overall: 0.5, data: 0.5 },
  ctLessons: { overall: 0.6, reasoning: 0.4 },
};

/** Catalog ids the router lists without a LiveBench row, best guess first (newer flash tiers before lite tiers). */
export const FALLBACK_ORDER = [
  "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite-preview", "gemini-flash", "gemini-flash-lite", "gemma-4-26b-it",
];

export const FREE_ROUTER_AUTO = "auto";

export function familyOf(modelId: string) {
  const row = LIVEBENCH.find((r) => r.ids.includes(modelId));
  if (row) return row.family;
  if (/^(gemini|gemma)/.test(modelId)) return "Google";
  if (/^deepseek/.test(modelId)) return "DeepSeek";
  if (/^(qwen|qwq)/.test(modelId)) return "Alibaba";
  if (/^glm/.test(modelId)) return "Z.AI";
  if (/^(gpt|o\d)/.test(modelId)) return "OpenAI";
  if (/^(llama)/.test(modelId)) return "Meta";
  if (/^(mistral|ministral|codestral|devstral)/.test(modelId)) return "Mistral AI";
  if (/^(nemotron)/.test(modelId)) return "NVIDIA";
  if (modelId === FREE_ROUTER_AUTO) return "Router";
  return modelId.split("-")[0] ?? "Unknown";
}

export function liveBenchOf(modelId: string) {
  return LIVEBENCH.find((r) => r.ids.includes(modelId)) ?? null;
}

export function roleScore(role: FreeRole, modelId: string): number | null {
  const row = liveBenchOf(modelId);
  if (!row) return null;
  let total = 0;
  for (const [key, weight] of Object.entries(ROLE_WEIGHTS[role]) as Array<[keyof typeof row, number]>) total += (row[key] as number) * weight;
  return total;
}

export type CatalogEntry = { id: string; available: boolean; tools: boolean; contextWindow: number | null };

export type Placement = {
  role: FreeRole;
  model: string;
  family: string;
  score: number | null;
  /** Ordered fallbacks tried for this role when the placed model fails; always ends with the router's own `auto`. */
  chain: string[];
};

const ROLE_ORDER: FreeRole[] = ["ctDesigner", "ctRiskReviewer", "ctEvidenceReviewer", "ctOrchestrator", "ctAnalyst", "ctLessons"];

/**
 * Greedy placement over the live catalog, designer first. Free quotas are per model and per day, so a model that already
 * holds a role is penalised for the next one (spreads load); reviewers must differ from the designer in family when any
 * other family is available, otherwise in model. Pure and deterministic for a given catalog.
 */
export function placeModels(catalog: CatalogEntry[], locked: Partial<Record<FreeRole, string>> = {}): Placement[] {
  const usable = catalog.filter((m) => m.available && m.id !== FREE_ROUTER_AUTO && m.id !== "fusion" && !/^claude-/.test(m.id));
  const toolCapable = usable.filter((m) => m.tools);
  const rank = (role: FreeRole, pool: CatalogEntry[]) => {
    const scored = pool.map((m) => ({ id: m.id, score: roleScore(role, m.id) }));
    const known = scored.filter((m) => m.score != null).sort((a, b) => (b.score as number) - (a.score as number));
    const rest = scored.filter((m) => m.score == null).sort((a, b) => {
      const ia = FALLBACK_ORDER.indexOf(a.id), ib = FALLBACK_ORDER.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    return [...known, ...rest];
  };
  const placed: Placement[] = [];
  const holders = new Map<string, number>();
  for (const role of ROLE_ORDER) {
    const pool = role === "ctDesigner" ? toolCapable : usable;
    const ranked = rank(role, pool);
    const designer = placed.find((p) => p.role === "ctDesigner");
    const reviewer = role === "ctRiskReviewer" || role === "ctEvidenceReviewer";
    const taken = placed.filter((p) => p.role === "ctRiskReviewer" || p.role === "ctEvidenceReviewer").map((p) => p.model);
    const adjust = (m: { id: string; score: number | null }) => {
      let s = (m.score ?? 20) - (holders.get(m.id) ?? 0) * 6;
      if (reviewer && designer) {
        if (familyOf(m.id) === designer.family) s -= 25;
        if (m.id === designer.model) s -= 200;
        if (taken.includes(m.id)) s -= 8;
      }
      return s;
    };
    const pick = locked[role] && pool.some((m) => m.id === locked[role])
      ? ranked.find((m) => m.id === locked[role])!
      : [...ranked].sort((a, b) => adjust(b) - adjust(a))[0];
    const chain = ranked.map((m) => m.id).filter((id) => id !== pick?.id).slice(0, 4);
    placed.push({ role, model: pick?.id ?? FREE_ROUTER_AUTO, family: pick ? familyOf(pick.id) : "Router", score: pick?.score ?? null, chain: [...chain, FREE_ROUTER_AUTO] });
    if (pick) holders.set(pick.id, (holders.get(pick.id) ?? 0) + 1);
  }
  return placed;
}
