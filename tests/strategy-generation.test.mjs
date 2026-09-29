import test from "node:test";
import assert from "node:assert/strict";
import { candidate, spec, day, sessions } from "./helpers/strategy-fixture.mjs";
import { compileStrategy, parseSpec, featureValue } from "../lib/strategy-generation-spec.ts";
import { GENERATION_MODELS, assertDifferentProvider } from "../lib/strategy-generation-models.ts";
import { auditDataset, splitSessions, evidenceProblems, sliceEvidence, validateFrozen } from "../lib/strategy-generation-validation.ts";
import { runRelay, sliceSession } from "../lib/relay-engine.ts";
import { slotById } from "../lib/trade-slots.ts";
const slot=slotById("trend");
function context(price=100){const d=day(undefined,price),cut=sliceSession(d.bars,["NVDA"],slot);cut.window.NVDA=cut.window.NVDA.filter(b=>b.time<="10:00");return {date:d.date,slot,asOf:"10:00",...cut,history:{},equityUsd:1000};}

test("exact frontier models and cross-company review cannot silently fall back",()=>{
 assert.equal(GENERATION_MODELS.orchestrator.model,"gpt-6-astra");assert.equal(GENERATION_MODELS.evidenceReviewer.model,"claude-opus-5");
 assert.doesNotThrow(()=>assertDifferentProvider("designer","riskReviewer"));assert.throws(()=>assertDifferentProvider("orchestrator","designer"));
});
test("the bounded language rejects executable payloads, unsupported products and invalid stop risk",()=>{
 assert.throws(()=>parseSpec({...spec,code:"process.exit()"}));assert.throws(()=>parseSpec({...spec,universe:["../INVALID"]}));assert.throws(()=>parseSpec({...spec,candidate:{...candidate,stopPct:0}}));
});
test("no entry when one whole share plus fees exceeds available cash",()=>{
 const strategy=compileStrategy(spec);assert.ok(strategy.scan(context()));assert.equal(strategy.scan(context(1001)),null);assert.equal(strategy.scan({...context(),equityUsd:0}),null);
});
test("stale, future, gapped, invalid or zero-volume candles fail closed",()=>{
 const strategy=compileStrategy(spec);
 for(const change of [c=>{c.asOf="10:05";},c=>{c.window.NVDA[0].time="10:05";},c=>{c.earlier.NVDA.pop();},c=>{c.window.NVDA[0].volume=0;},c=>{c.window.NVDA[0].high=NaN;}]){const c=context();change(c);assert.equal(strategy.scan(c),null);}
});
test("feature warmup does not fabricate a zero value from missing history",()=>{assert.equal(featureValue([],"returnPct",2),null);});
test("compiled strategy executes in the real engine, next bar, whole shares, reserves and doubled costs",()=>{
 const strategy=compileStrategy(spec),data=sessions();const base=runRelay([strategy],data,{capitalUsd:1000});
 assert.equal(base.days[0].slots.find(s=>s.traded).entryTime,"10:05");assert.equal(base.days[0].slots.find(s=>s.traded).quantity,9);
 const stress=runRelay([strategy],data,{capitalUsd:1000,costMultiplier:2});assert.ok(stress.endingEquityUsd<base.endingEquityUsd);assert.ok(base.metrics.totalTrades>100);
});
test("volume participation caps the executable number of shares",()=>{
 const strategy=compileStrategy({...spec,candidate:{...candidate,minBarDollarVolume:100000}}),d=day();d.bars.NVDA.forEach(b=>{b.volume=1000;});
 const r=runRelay([strategy],[d],{capitalUsd:100000});assert.equal(r.days[0].slots.find(s=>s.traded).quantity,10);
});
test("learning, validation and holdout are chronological and disjoint",()=>{
 const split=splitSessions(sessions());assert.equal(split.train.length,120);assert.equal(split.validation.length,40);assert.equal(split.holdout.length,40);
 assert.ok(split.train.at(-1).date<split.validation[0].date);assert.ok(split.validation.at(-1).date<split.holdout[0].date);assert.throws(()=>splitSessions(sessions(100)));
});
test("frozen validation produces actual replay evidence and code-owned rejection reasons",()=>{
 const data=sessions(),split=splitSessions(data),training=sliceEvidence(runRelay([compileStrategy(spec)],split.train,{capitalUsd:1000}));
 const evidence=validateFrozen(spec,data,1000,training,"frozen");assert.ok(evidence.passed, evidence.reasons.join(";"));
 const bad=structuredClone(evidence);bad.holdout.metrics.totalTrades=0;bad.stress.metrics.totalReturnPct=-1;
 const reasons=evidenceProblems(bad);assert.ok(reasons.some(r=>r.includes("표본")));assert.ok(reasons.some(r=>r.includes("비용 2배")));
});
test("duplicate, missing symbol and malformed OHLC datasets cannot be silently accepted",()=>{
 const d=day();d.bars.NVDA.push(d.bars.NVDA[0]);assert.throws(()=>auditDataset([d],["NVDA"],slot));
 assert.ok(auditDataset([day()],["MSFT"],slot).length);
});
test("missing exit bar is a validation failure, not a fabricated successful liquidation",()=>{
 const d=day(),strategy=compileStrategy({...spec,candidate:{...candidate,targetPct:null}});d.bars.NVDA=d.bars.NVDA.filter(b=>b.time!=="11:25");
 const r=runRelay([strategy],[d],{capitalUsd:1000});const trade=r.days[0].slots.find(s=>s.traded);assert.ok(trade.violations.some(v=>v.includes("검증 불가")));
});

const {researchSplit,summarizeResearch}=await import("../lib/strategy-generation-research.ts");
test("all planned research blocks are chronological, disjoint and large enough for confidence checks",()=>{
 const data=sessions(500),windows=researchSplit(data).windows;
 assert.equal(windows,3);
 let last=data[299].date;
 for(let w=0;w<windows;w++){
  const s=researchSplit(data,w);
  assert.ok(s.validation.length>=20&&s.holdout.length>=20);
  assert.ok(last<s.validation[0].date);assert.ok(s.validation.at(-1).date<s.holdout[0].date);
  assert.ok(s.train.at(-1).date<s.validation[0].date);last=s.holdout.at(-1).date;
 }
 assert.throws(()=>researchSplit(data,windows),/미사용/);
});
test("user-specified valid tickers replace the old hardcoded 14-name candidate scope",()=>{
 assert.deepEqual(parseSpec({...spec,universe:["BRK.B","DIA"]}).universe,["BRK.B","DIA"]);
});
test("upfront affordability uses actual price, reserve and costs",()=>{
 const job={slot:"trend",universe:["NVDA"],capitalUsd:1000};
 const summary=summarizeResearch(job,sessions());assert.equal(summary.symbols[0].maxWholeShares,9);
 assert.ok(summary.symbols[0].assumedRoundTripPct>0);
 const expensive=sessions().map(s=>day(s.date,1001));
 assert.equal(summarizeResearch(job,expensive).symbols[0].affordableBars,0);
});
test("appending new data preserves every old test boundary and allocates only fresh 40-session blocks",()=>{
 const initial=sessions(260),extended=sessions(300);
 const before=researchSplit(initial,1,260),after=researchSplit(extended,1,260);
 assert.deepEqual(after.validation,before.validation);assert.deepEqual(after.holdout,before.holdout);
 const fresh=researchSplit(extended,2,260);
 assert.equal(fresh.validation.length,20);assert.equal(fresh.holdout.length,20);
 assert.ok(before.holdout.at(-1).date<fresh.validation[0].date);
 assert.throws(()=>researchSplit(sessions(299),2,260),/미사용/);
});
