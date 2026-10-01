import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
register("./helpers/strategy-test-loader.mjs", import.meta.url);
const sqlite = new DatabaseSync(":memory:");
class Statement {
 constructor(sql, args = []) { this.sql = sql; this.args = args; }
 bind(...args) { return new Statement(this.sql, args); }
 async run() { return {meta:{changes:Number(sqlite.prepare(this.sql).run(...this.args).changes)}}; }
 async all() { return {results:sqlite.prepare(this.sql).all(...this.args)}; }
 async raw() { return sqlite.prepare(this.sql).all(...this.args).map(Object.values); }
}
globalThis.__strategyTestEnv = {
 ANTHROPIC_API_KEY:"test-anthropic", OPENAI_API_KEY:"test-openai",
 DB:{prepare:sql=>new Statement(sql),batch:statements=>Promise.all(statements.map(statement=>statement.run()))},
};
const { generationCall } = await import("../lib/strategy-generation-llm.ts");
const { researchFailure } = await import("../lib/research-recovery.ts");
const schema = z.object({summary:z.string()});
const originalFetch = globalThis.fetch;
let mockFetch;
globalThis.fetch = (...args) => mockFetch(...args);
test.after(() => { globalThis.fetch = originalFetch; });
function sse(events) {
 return new Response(new ReadableStream({
  start(controller) {
   for(const event of events) controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
   controller.close();
  },
 }), {headers:{"content-type":"text/event-stream"}});
}
test("Anthropic SDK streams token estimates before its final authoritative usage, including cache", async () => {
 const usage=[];
 let request;
 mockFetch=async(url,options)=>{
  request=JSON.parse(options.body);
  const content='{"summary":"검증 완료"}';
  return sse([
   {type:"message_start",message:{id:"msg_test",type:"message",role:"assistant",model:"claude-opus-5",content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:1,cache_creation_input_tokens:20,cache_read_input_tokens:50}}},
   {type:"content_block_start",index:0,content_block:{type:"text",text:""}},
   {type:"content_block_delta",index:0,delta:{type:"text_delta",text:content}},
   {type:"content_block_stop",index:0},
   {type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:42}},
   {type:"message_stop"},
  ]);
 };
 try {
  const result=await generationCall("owner","riskReviewer",schema,"test",{onUsage:async(u,estimated)=>usage.push({u,estimated})});
  assert.equal(request.stream,true); assert.equal(request.model,"claude-opus-5");
  assert.equal(result.data.summary,"검증 완료");
  assert.ok(usage.some(item=>item.estimated));
  assert.equal(usage.at(-1).estimated,false);
  assert.deepEqual(result.usage,{input_tokens:100,output_tokens:42,cache_creation_input_tokens:20,cache_read_input_tokens:50});
  assert.ok(Math.abs(result.costUsd-0.00170)<1e-8);
 } finally { mockFetch=originalFetch; }
});
test("OpenAI SDK streams and replaces estimates with final usage including reasoning", async () => {
 const usage=[];
 let request;
 const text='{"summary":"완료"}';
 const part={type:"output_text",text,annotations:[],logprobs:[]};
 const item={id:"msg_o",type:"message",role:"assistant",status:"completed",content:[part]};
 const response={id:"resp_test",object:"response",created_at:1,status:"completed",model:"gpt-6.1-sol",output:[item],usage:{input_tokens:120,output_tokens:84,total_tokens:204,input_tokens_details:{cached_tokens:20},output_tokens_details:{reasoning_tokens:60}}};
 mockFetch=async(url,options)=>{
  request=JSON.parse(options.body);
  return sse([
   {type:"response.created",response:{...response,status:"in_progress",output:[],usage:null}},
   {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}},
   {type:"response.content_part.added",item_id:item.id,output_index:0,content_index:0,part:{...part,text:""}},
   {type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:text,logprobs:[]},
   {type:"response.output_text.done",item_id:item.id,output_index:0,content_index:0,text},
   {type:"response.content_part.done",item_id:item.id,output_index:0,content_index:0,part},
   {type:"response.output_item.done",output_index:0,item},
   {type:"response.completed",response},
  ].map((event,sequence_number)=>({...event,sequence_number})));
 };
 try {
  const result=await generationCall("owner","orchestrator",schema,"test",{onUsage:async(u,estimated)=>usage.push({u,estimated})});
  assert.equal(request.stream,true); assert.equal(request.store,false);
  assert.equal(result.data.summary,"완료");
  assert.equal(result.usage.output_tokens,84); assert.equal(result.usage.input_tokens,100); assert.equal(result.usage.cache_read_input_tokens,20);
  assert.equal(usage.at(-1).estimated,false); assert.ok(usage[0].estimated);
 } finally { mockFetch=originalFetch; }
});
test("524 is a retryable timeout, never a credit error; SDK does not hide extra paid retries",async()=>{
 let requests=0;
 mockFetch=async()=>{requests++;return new Response("524 error code: 524",{status:524});};
 try {
  await assert.rejects(()=>generationCall("owner","riskReviewer",schema,"test"),error=>{
   assert.equal(error.status,524); assert.ok(researchFailure(error).transient); assert.doesNotMatch(error.message,/크레딧|잔액/);return true;
  });
  assert.equal(requests,1);
 }finally{mockFetch=originalFetch;}
});
test("fallback request uses the documented secondary Anthropic model",async()=>{
 mockFetch=async(url,options)=>{assert.equal(JSON.parse(options.body).model,"claude-sonnet-5");return new Response("unavailable",{status:529});};
 try {await assert.rejects(()=>generationCall("owner","evidenceReviewer",schema,"test",{failures:2}));}
 finally{mockFetch=originalFetch;}
});
