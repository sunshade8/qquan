import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { writeFileSync } from "node:fs";
import { candidate, sessions } from "./helpers/strategy-fixture.mjs";
register("./helpers/strategy-test-loader.mjs",import.meta.url);
const sqlite=new DatabaseSync(":memory:");
class Statement {
 constructor(sql,values=[]){this.sql=sql;this.values=values;}
 bind(...values){return new Statement(this.sql,values);}
 _run(){return {meta:{changes:Number(sqlite.prepare(this.sql).run(...this.values).changes)}};}
 async run(){return this._run();}
 async first(){return sqlite.prepare(this.sql).get(...this.values)??null;}
 async all(){return {results:sqlite.prepare(this.sql).all(...this.values)};}
}
globalThis.__strategyTestEnv={DB:{prepare:sql=>new Statement(sql),async batch(statements){sqlite.exec("BEGIN");try{const result=statements.map(s=>s._run());sqlite.exec("COMMIT");return result;}catch(e){sqlite.exec("ROLLBACK");throw e;}}}};
const calls=[];
const approve={approved:true,summary:"합성 fixture를 이용한 연결 테스트 승인입니다.",blockers:[],cautions:["합성 데이터"]};
const defaultCall=async(role,prompt)=>{calls.push({role,prompt});if(role==="orchestrator")return {thesis:"합성 fixture에서 추세 규칙의 전체 연결을 검증하는 연구입니다.",universe:["NVDA"],hypotheses:["검증용 가설"],failureModes:["유동성","슬리피지","과최적화","낙폭","표본"]};if(role==="designer")return {candidates:[candidate]};if(role.endsWith("Reviewer"))return approve;return {summary:"합성 데이터로 코드 연결을 검증합니다. 실전 성과가 아닙니다.",issues:[]};};
globalThis.__strategyTestHooks={sessions:sessions(260,1),call:defaultCall};
const store=await import("../lib/strategy-generation-store.ts");
const workflow=await import("../lib/strategy-generation.ts");
const owner="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const create=()=>workflow.createGeneration(owner,{slot:"trend",universe:["NVDA"],requestId:crypto.randomUUID(),brief:"test"});

test("durable workflow: idempotency, concurrent leases, cancellation, replay, publication and owner isolation",async()=>{
 const cancelled=await create();assert.equal((await workflow.createGeneration(owner,{slot:"trend",universe:["NVDA"],requestId:cancelled.id,brief:"test"})).id,cancelled.id);
 await assert.rejects(create,/이미 전략 생성/);
 let release,entered;const started=new Promise(resolve=>{entered=resolve;});
 globalThis.__strategyTestHooks.call=async(role,prompt)=>{if(role==="orchestrator"){entered();await new Promise(resolve=>{release=resolve;});}return defaultCall(role,prompt);};
 let prepared=await store.getGenerationJob(cancelled.id);
 while(prepared.stageIndex===0) prepared=await workflow.advanceGeneration(cancelled.id);
 const first=workflow.advanceGeneration(cancelled.id);await started;
 const concurrent=await workflow.advanceGeneration(cancelled.id);assert.equal(concurrent.status,"running");assert.equal(concurrent.stageIndex,1);
 await store.cancelGenerationJob(await store.getGenerationJob(cancelled.id));release();
 assert.equal((await first).status,"cancelled");assert.equal((await store.registeredRelayStrategies()).length,0);
 globalThis.__strategyTestHooks.call=defaultCall;
 let job=await create();let steps=0;
 while(job.status==="running"&&steps++<50)job=await workflow.advanceGeneration(job.id);
 assert.equal(job.status,"completed",job.error);assert.ok(job.evidence.passed);assert.ok(job.training.trades.length);
 assert.equal((await store.registeredRelayStrategies()).length,1);assert.equal((await store.getGenerationJob(job.id)).status,"completed");
 await store.cancelGenerationJob(job);assert.equal((await store.getGenerationJob(job.id)).status,"completed");
 await workflow.advanceGeneration(job.id);assert.equal((await store.registeredRelayStrategies()).length,1);
 assert.equal((await store.listGenerationJobs("other-owner")).length,0);
 assert.equal(calls.filter(c=>c.role==="designer").length,1);
 assert.ok(calls.filter(c=>c.role==="designer").every(c=>!c.prompt.includes('"holdout":')));
 await assert.rejects(create,/이미 전략이 등록/);
});

test("failed deterministic validation cannot publish even when an LLM says approved",async()=>{
 const job=(await store.listGenerationJobs(owner)).find(j=>j.status==="completed");
 const forged=structuredClone(job);forged.id=crypto.randomUUID();forged.slot="open";forged.selected.slot="open";forged.selected.id="bad";forged.status="running";forged.evidence.passed=false;
 await store.createGenerationJob(forged);assert.ok(await store.claimGenerationJob(forged.id,"test"));
 await assert.rejects(()=>store.publishGeneration(forged,"test"),/검증 승인/);
 await store.cancelGenerationJob(forged);
});

test("cancelled lease cannot commit a previously approved strategy",async()=>{
 const template=(await store.listGenerationJobs(owner)).find(j=>j.status==="completed"),job=structuredClone(template);
 job.id=crypto.randomUUID();job.slot="open";job.selected.slot="open";job.selected.id="cancelled-rule";job.status="running";
 await store.createGenerationJob(job);assert.ok(await store.claimGenerationJob(job.id,"old-worker"));await store.cancelGenerationJob(job);
 await assert.rejects(()=>store.publishGeneration(job,"old-worker"));assert.equal((await store.registeredRelayStrategies()).length,1);
});

async function freshResearch(call=defaultCall) {
 sqlite.exec("DELETE FROM generated_relay_strategies; DELETE FROM strategy_generation_data; DELETE FROM strategy_generation_runs;");
 calls.length=0;
 globalThis.__strategyTestHooks.call=call;
 globalThis.__strategyTestHooks.to="2026-09-17";
 globalThis.__strategyTestHooks.sessions=sessions(260,1);
 return create();
}
async function finishResearch(job) {
 let steps=0;
 while(job.status==="running" && steps++<100) job=await workflow.advanceGeneration(job.id);
 assert.ok(steps<100,"workflow must make progress");
 return job;
}
test("risk rejection repairs the same persisted research with shared constraints and no extra click",async()=>{
 let reviews=0;
 const job=await finishResearch(await freshResearch(async(role,prompt)=>{
  if(role==="riskReviewer" && reviews++===0) return {...approve,approved:false,blockers:["CHANGE_ENTRY: require a different completed-bar hypothesis"]};
  return defaultCall(role,prompt);
 }));
 assert.equal(job.status,"completed",job.error);
 assert.equal(job.attempt,2);assert.equal(job.attempts.length,1);
 const designs=calls.filter(c=>c.role==="designer");
 assert.equal(designs.length,2);
 assert.ok(designs[1].prompt.includes("CHANGE_ENTRY"));
 assert.ok(designs.every(c=>c.prompt.includes('"capitalUsd":1000') && c.prompt.includes('"minWholeShares"') && c.prompt.includes('"assumedRoundTripPct"')));
 assert.ok(calls.filter(c=>c.role==="orchestrator").every(c=>c.prompt.includes('"trainingData"')));
 assert.equal((await store.registeredRelayStrategies()).length,1);
});
test("zero-trade training feeds measured failure back before freezing another candidate",async()=>{
 let designs=0;
 const job=await finishResearch(await freshResearch(async(role,prompt)=>{
  if(role==="designer" && designs++===0) return {candidates:[{...candidate,name:"No signals",conditions:candidate.conditions.map(c=>({...c,value:99}))}]};
  return defaultCall(role,prompt);
 }));
 assert.equal(job.status,"completed",job.error);
 assert.equal(job.attempts[0].stage,"training");
 assert.equal(job.attempts[0].trials[0].metrics.totalTrades,0);
 assert.ok(calls.find(c=>c.role==="designer").prompt.includes('"totalTrades":0'));
 assert.equal(job.validationWindow,0);
});
test("final rejection consumes its test dates and next attempt uses a later untouched block",async()=>{
 let reviews=0;
 const job=await finishResearch(await freshResearch(async(role,prompt)=>{
  if(role==="evidenceReviewer" && reviews++===0) return {...approve,approved:false,blockers:["Independent final review requires a different hypothesis"]};
  return defaultCall(role,prompt);
 }));
 assert.equal(job.status,"completed",job.error);
 assert.equal(job.validationWindow,1);
 assert.ok(job.attempts[0].evidence.holdout.to < job.evidence.validation.from);
 assert.ok(job.attempts[0].evidence.holdout.to <= job.evidence.training.to);
});
test("exhausted unseen data never becomes false approval or another reused holdout",async()=>{
 const job=await finishResearch(await freshResearch(async(role,prompt)=>role==="evidenceReviewer"?{...approve,approved:false,blockers:["Test remains unconvincing"]}:defaultCall(role,prompt)));
 assert.equal(job.status,"paused");assert.equal(job.pauseReason,"data");
 assert.equal(job.attempts.length,2);
 assert.equal((await store.registeredRelayStrategies()).length,0);
 assert.equal(job.selected,undefined);assert.equal(job.evidence,undefined);
});
test("budget pause preserves stage and explicit budget extension is idempotent",async()=>{
 let job=await freshResearch();
 while(job.stageIndex===0) job=await workflow.advanceGeneration(job.id);
 assert.ok(await store.claimGenerationJob(job.id,"budget-test"));job.budgetUsd=0;await store.saveGenerationJob(job,"budget-test");
 job=await workflow.advanceGeneration(job.id);
 assert.equal(job.status,"paused");assert.equal(job.pauseReason,"budget");assert.equal(job.stageIndex,1);
 assert.equal(calls.length,0);
 await Promise.all([store.resumeGenerationBudget(structuredClone(job)),store.resumeGenerationBudget(structuredClone(job))]);
 job=await store.getGenerationJob(job.id);assert.equal(job.budgetUsd,8);
 job=await finishResearch(job);assert.equal(job.status,"completed",job.error);
});
test("missing user ticker scope is rejected before any model call",async()=>{
 await freshResearch();
 await assert.rejects(()=>workflow.createGeneration(owner,{slot:"open",requestId:crypto.randomUUID()}));
 assert.equal(calls.length,0);
});

test("data-wait research automatically resumes on new dates without rerunning consumed test periods",async()=>{
 let job=await finishResearch(await freshResearch(async(role,prompt)=>role==="evidenceReviewer"?{...approve,approved:false,blockers:["Independent test rejected"]}:defaultCall(role,prompt)));
 assert.equal(job.pauseReason,"data");
 const initialCount=job.researchSessions,oldEnd=job.attempts.at(-1).evidence.holdout.to;
 globalThis.__strategyTestHooks.sessions=sessions(300,1);
 globalThis.__strategyTestHooks.to=sessions(300,1).at(-1).date;
 globalThis.__strategyTestHooks.call=defaultCall;
 job=await workflow.advanceGeneration(job.id);
 job=await finishResearch(job);
 assert.equal(job.status,"paused");
 assert.equal(job.pauseReason,"data");
 globalThis.__strategyTestHooks.sessions=sessions(301,1);
 globalThis.__strategyTestHooks.to=sessions(301,1).at(-1).date;
 job=await workflow.advanceGeneration(job.id);
 job=await finishResearch(job);
 assert.equal(job.status,"completed",job.error);
 assert.equal(job.researchSessions,initialCount);
 assert.ok(job.evidence.validation.from>oldEnd);
 assert.equal(job.validationWindow,2);
});

test("one-minute source data persists, deduplicates overlaps and derives only complete strategy bars", async () => {
 const id=crypto.randomUUID();
 const data=sessions(2,1);
 const part=data.map(day=>({...day,barsByStep:{1:day.bars}}));
 await store.writeGenerationData(id,0,part);
 await store.writeGenerationData(id,1,part);
 const read=await store.readGenerationData(id);
 assert.equal((await store.readGenerationData(id,1))[0].barsByStep[1].NVDA.length,390);
 assert.equal((await store.readGenerationData(id,3))[0].barsByStep[3].NVDA.length,130);
 assert.equal(read[0].barsByStep[5].NVDA.length,78);
 assert.deepEqual(read[0].bars,read[0].barsByStep[5]);
 const missing=structuredClone(part);
 for (const day of missing) day.barsByStep[1].NVDA=day.barsByStep[1].NVDA.filter(b=>b.time!=="10:01");
 const missingId=crypto.randomUUID();
 await store.writeGenerationData(missingId,0,missing);
 const incomplete=await store.readGenerationData(missingId);
 assert.ok(!(await store.readGenerationData(missingId,3))[0].barsByStep[3].NVDA.some(b=>b.time==="10:00"));
 assert.ok(!incomplete[0].barsByStep[5].NVDA.some(b=>b.time==="10:00"));
});

test("legacy persisted five-minute research stays readable and cannot masquerade as minutes", async () => {
 const id=crypto.randomUUID(), data=sessions(2);
 sqlite.prepare("INSERT INTO strategy_generation_data (run_id,part,payload) VALUES (?,?,?)").run(id,0,JSON.stringify(data));
 assert.deepEqual((await store.readGenerationData(id))[0].bars,data[0].bars);
 await assert.rejects(()=>store.readGenerationData(id,1),/원본이 없습니다/);
});

test("a generated three-minute strategy remains three-minute through freeze, validation and registration", async () => {
 const job=await finishResearch(await freshResearch(async(role,prompt)=>role==="designer"?{candidates:[{...candidate,barInterval:"3m"}]}:defaultCall(role,prompt)));
 assert.equal(job.status,"completed",job.error);
 assert.equal(job.sourceBarMinutes,1);
 assert.equal(job.selected.candidate.barInterval,"3m");
 assert.equal((await store.registeredRelayStrategies())[0].barMinutes,3);
 assert.ok(job.training.trades.every(t=>t.entryTime==="10:06"));
 assert.ok(job.evidence.delayed.trades.every(t=>t.entryTime==="10:09"));
});

async function freshAutomatic(options = {}, modelHook) {
 sqlite.exec("DELETE FROM generated_relay_strategies; DELETE FROM strategy_generation_data; DELETE FROM strategy_generation_runs; DELETE FROM surge_market_days;");
 calls.length=0;
 globalThis.__strategyTestHooks.to="2026-09-17";
 const fixture=sessions(520,1);
 for(const day of fixture) {
  const date=new Date(Date.parse(day.date)-365*86400000).toISOString().slice(0,10);
  day.date=date;
  for(const bars of Object.values(day.bars)) for(const bar of bars) bar.date=date;
 }
 globalThis.__strategyTestHooks.sessions=fixture;
 globalThis.__strategyTestHooks.call=async(role,prompt)=>{
  if(prompt.startsWith("RESEARCH_DISCOVERY:")) {
   calls.push({role,prompt});
   return {summary:"실측 시장 자료에서 오전과 오후의 서로 다른 가설을 검증합니다.",options:[
    {title:"오전 추세 가설",hypothesis:"개장 이후 형성된 상승 방향이 오전 거래 구간에 지속되는지 검증합니다.",rationale:"학습 시점 시장 데이터의 가격과 거래대금이 연구 범위에 적합합니다.",slot:"trend",universe:["NVDA"]},
    {title:"오후 추세 가설",hypothesis:"오후에 거래가 다시 활발해질 때 상승 방향의 지속 여부를 검증합니다.",rationale:"다른 시간대의 독립된 가설을 새로운 검증 기간에서 살펴봅니다.",slot:"afternoon",universe:["NVDA"]},
   ]};
  }
  return modelHook ? modelHook(role,prompt) : defaultCall(role,prompt);
 };
 const job=await workflow.createStrategyResearch(owner,{requestId:crypto.randomUUID(),...options});
 sqlite.prepare("INSERT INTO surge_market_days (trading_date,payload,tickers,created_at,basis) VALUES (?,?,?,?,?)")
  .run(job.research.trainingTo,JSON.stringify([["NVDA",100,100000000,105,99,100],["SPY",100,90000000,103,98,100]]),2,Date.now(),"raw-events-v2");
 return job;
}
test("automatic research discovers scopes, shares budget and test dates, and waits for explicit registration",async()=>{
 let job=await freshAutomatic();
 const id=job.id;
 const same=await workflow.createStrategyResearch(owner,{requestId:id});assert.equal(same.id,id);
 job=await finishResearch(job);
 assert.equal(job.status,"completed",job.error);
 assert.equal(job.research.options.length,2);
 assert.ok(job.research.options.every(option=>option.status==="passed"),JSON.stringify(job.research.options.map(option=>option.reasons)));
 assert.equal(job.budgetUsd,8);
 assert.equal((await store.registeredRelayStrategies()).length,0,"research must never auto-register");
 const [first,second]=job.research.options;
 assert.ok(first.evidence.holdout.to<second.evidence.validation.from);
 assert.equal(job.research.consumedWindows,2);
 assert.ok(Math.abs(job.costUsd - calls.length * 0.01) < 1e-9);
 if (process.env.STRATEGY_UI_FIXTURE) writeFileSync(process.env.STRATEGY_UI_FIXTURE, JSON.stringify({jobs:[workflow.publicJob(job)],availability:{ready:true,missing:[]},inventory:[],registeredIds:[]}));
 await store.registerResearchOption(job,first.id);
 await store.registerResearchOption(job,first.id);
 assert.equal((await store.registeredRelayStrategies()).length,1);
 await store.registerResearchOption(job,second.id);
 assert.equal((await store.registeredRelayStrategies()).length,2);
 assert.equal((await store.getGenerationJob(job.id)).status,"completed");
 const forged=structuredClone(job);forged.research.options[0].evidence.passed=false;
 await assert.rejects(()=>store.registerResearchOption(forged,first.id),/검증 통과/);
});
test("automatic discovery honors ticker restrictions and cannot call a fabricated scope evidence",async()=>{
 let job=await freshAutomatic({universe:["SPY"]});
 job=await workflow.advanceGeneration(job.id);
 assert.equal(job.status,"failed");assert.match(job.error,/종목/);
 assert.equal((await store.registeredRelayStrategies()).length,0);
});
test("automatic research retains failed options and changes scopes after bounded revisions",async()=>{
 let job=await freshAutomatic({},async(role,prompt)=>role==="riskReviewer"?{...approve,approved:false,blockers:["실행 가능한 진입 근거 부족"]}:defaultCall(role,prompt));
 job=await finishResearch(job);
 assert.equal(job.status,"completed",job.error);
 assert.ok(job.research.options.every(option=>option.status==="rejected"));
 assert.ok(job.research.options.every(option=>option.reasons.includes("실행 가능한 진입 근거 부족")));
 assert.equal(job.research.consumedWindows,0);
 assert.equal((await store.registeredRelayStrategies()).length,0);
});
test("automatic discovery budget pause preserves the snapshot and has no paid call",async()=>{
 let job=await freshAutomatic();
 assert.ok(await store.claimGenerationJob(job.id,"budget-auto"));job.budgetUsd=0;await store.saveGenerationJob(job,"budget-auto");
 job=await workflow.advanceGeneration(job.id);
 assert.equal(job.status,"paused");assert.equal(job.pauseReason,"budget");assert.equal(job.research.phase,"discovery");assert.equal(calls.length,0);
 await store.resumeGenerationBudget(job);
 job=await finishResearch(await store.getGenerationJob(job.id));
 assert.equal(job.status,"completed",job.error);assert.equal(job.budgetUsd,8);
});
