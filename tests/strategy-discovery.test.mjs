import test from "node:test";
import assert from "node:assert/strict";
import { researchRequestSchema, researchCalendar, discoveryPlanSchema, validateDiscoveryPlan } from "../lib/strategy-discovery.ts";
import { splitResearchJob } from "../lib/strategy-generation-research.ts";
import { sessions } from "./helpers/strategy-fixture.mjs";

test("automatic research needs no ticker or slot and validates explicit limits", () => {
  const request = researchRequestSchema.parse({requestId:crypto.randomUUID()});
  assert.equal(request.goal,"discover");assert.equal(request.budgetUsd,8);assert.equal(request.slot,undefined);
  assert.throws(()=>researchRequestSchema.parse({...request,goal:"idea"}));
  assert.throws(()=>researchRequestSchema.parse({...request,budgetUsd:1000}));
  assert.throws(()=>researchRequestSchema.parse({...request,universe:[]}));
});
test("discovery cannot invent ticker evidence or escape user scope", () => {
  const plan=discoveryPlanSchema.parse({summary:"실제 학습 자료로 가설을 비교합니다.",options:[{title:"오전 추세",hypothesis:"개장 직후 형성된 방향이 이후 시간대에도 유지되는지 측정합니다.",rationale:"실측 거래량과 가격이 자본 범위에 들어옵니다.",universe:["NVDA"],slot:"trend"}]});
  assert.equal(validateDiscoveryPlan(plan,["NVDA"],["trend"],{}),plan);
  assert.throws(()=>validateDiscoveryPlan(plan,["SPY"],["trend"],{}),/종목/);
  assert.throws(()=>validateDiscoveryPlan(plan,["NVDA"],["open"],{}),/시간대/);
  assert.throws(()=>validateDiscoveryPlan(plan,["NVDA"],["trend"],{universe:["SPY"]}),/종목/);
});
test("test dates stay fixed across symbols, missing sessions and changed scopes", () => {
  const calendar=researchCalendar("2024-09-17","2026-09-17");
  const research={...calendar,consumedWindows:0};
  const rows=sessions(260);
  const first=splitResearchJob({research},rows);
  const sparse=splitResearchJob({research},rows.filter((_,i)=>i%3));
  const consumed=splitResearchJob({research:{...research,consumedWindows:1}},rows);
  assert.ok(first.train.every(day=>day.date<=calendar.trainingTo));
  assert.ok(sparse.validation.every(day=>day.date>=calendar.windows[0].validationFrom&&day.date<=calendar.windows[0].validationTo));
  assert.ok(first.holdout.at(-1).date<consumed.validation[0].date);
  assert.ok(calendar.windows[0].holdoutTo<calendar.windows[1].validationFrom);
});
