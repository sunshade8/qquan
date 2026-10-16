// T (free research lane): LiveBench-ranked placement over a live freellmapi catalog.
import test from "node:test";
import assert from "node:assert/strict";
import { placeModels, roleScore, familyOf, liveBenchOf, FREE_ROUTER_AUTO } from "../lib/t-free-models.ts";
import { applyPlacements, assertDifferentProvider, placementChain, researchModel, CT_ROLES } from "../lib/t-generation-models.ts";

const entry = (id, tools = true, available = true) => ({ id, available, tools, contextWindow: 1_000_000 });
const GOOGLE_ONLY = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemma-4-31b-it"].map((id) => entry(id));
const MIXED = [...GOOGLE_ONLY, entry("deepseek-v4-flash"), entry("qwen3.8-flash"), entry("glm-5.3-flash")];

test("every role is placed on a model the catalog really offers", () => {
  for (const catalog of [GOOGLE_ONLY, MIXED]) {
    const ids = new Set(catalog.map((m) => m.id));
    const placed = placeModels(catalog);
    assert.deepEqual(placed.map((p) => p.role).sort(), [...CT_ROLES].sort());
    for (const p of placed) {
      assert.ok(ids.has(p.model), `${p.role} -> ${p.model}`);
      assert.equal(p.chain.at(-1), FREE_ROUTER_AUTO, "the router's auto is always the last resort");
      assert.ok(!p.chain.includes(p.model));
    }
  }
});

test("the designer takes the best tool-loop model; reviewers leave its company when another exists", () => {
  const placed = Object.fromEntries(placeModels(MIXED).map((p) => [p.role, p]));
  assert.equal(placed.ctDesigner.model, "deepseek-v4-flash"); // top LiveBench agentic + coding in the catalog
  for (const role of ["ctRiskReviewer", "ctEvidenceReviewer"]) {
    assert.notEqual(placed[role].family, placed.ctDesigner.family, role);
    assert.notEqual(placed[role].model, placed.ctDesigner.model);
  }
});

test("with a single company the reviewers still never reuse the designer's model", () => {
  const placed = Object.fromEntries(placeModels(GOOGLE_ONLY).map((p) => [p.role, p]));
  for (const role of ["ctRiskReviewer", "ctEvidenceReviewer"]) assert.notEqual(placed[role].model, placed.ctDesigner.model);
});

test("unavailable, claude slot, fusion and non-tool models are never placed as designer", () => {
  const catalog = [entry("gemini-3.8-flash", false), entry("claude-opus-4-5"), entry("fusion"), entry("deepseek-v4-flash", true, false), entry("gemini-3.7-flash")];
  const placed = Object.fromEntries(placeModels(catalog).map((p) => [p.role, p]));
  assert.equal(placed.ctDesigner.model, "gemini-3.7-flash");
  for (const p of Object.values(placed)) assert.ok(!/^claude-|^fusion$/.test(p.model));
});

test("an empty catalog falls back to the router's auto rather than throwing", () => {
  for (const p of placeModels([])) assert.equal(p.model, FREE_ROUTER_AUTO);
});

test("placement is deterministic and a lock is honoured", () => {
  assert.deepEqual(placeModels(MIXED), placeModels(MIXED));
  const locked = placeModels(MIXED, { ctDesigner: "qwen3.8-flash" }).find((p) => p.role === "ctDesigner");
  assert.equal(locked.model, "qwen3.8-flash");
});

test("scores come from LiveBench rows and unknown models are unscored", () => {
  assert.equal(liveBenchOf("deepseek-v4-flash").name, "DeepSeek V4.1 Flash");
  assert.ok(roleScore("ctDesigner", "deepseek-v4-flash") > roleScore("ctDesigner", "gemini-3.8-flash"));
  assert.ok(roleScore("ctRiskReviewer", "gemini-3.8-flash") > roleScore("ctRiskReviewer", "gemma-4-31b-it"));
  assert.equal(roleScore("ctDesigner", "gemini-3.6-flash"), null);
  assert.equal(familyOf("gemma-4-31b-it"), "Google");
});

test("installed placement drives researchModel, the failover chain and the independence check", () => {
  applyPlacements(placeModels(MIXED));
  const designer = researchModel("ctDesigner");
  assert.equal(designer.model, "deepseek-v4-flash");
  assert.equal(designer.provider, "DeepSeek");
  assert.equal(placementChain("ctDesigner")[0], "deepseek-v4-flash");
  assert.doesNotThrow(() => assertDifferentProvider("ctDesigner", "ctRiskReviewer"));
  applyPlacements(placeModels(MIXED, { ctRiskReviewer: "deepseek-v4-flash" }));
  assert.throws(() => assertDifferentProvider("ctDesigner", "ctRiskReviewer"));
});
