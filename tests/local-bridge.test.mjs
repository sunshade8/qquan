import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {LocalDatabase} from '../lib/runtime/local-sqlite.ts';
import {dataRPC} from '../lib/market-data-rpc.ts';
import {validateInput} from '../scripts/data/bridge-input.mjs';
register('./helpers/strategy-test-loader.mjs',import.meta.url);
const dir=mkdtempSync(tmpdir()+'/qquan-bridge-');
process.env.QQUAN_DATA_DIR=dir;
process.env.QQUAN_DENY_MARKET_NETWORK='1';
const db=new LocalDatabase();
globalThis.__strategyTestEnv={DB:db,LOCAL_DATA_BRIDGE_SECRET:'test-secret'};
const bridge=await import('../lib/local-bridge-store.ts');
const api=await import('../app/api/local-data/bridge/route.ts');
const send=(body,secret='test-secret')=>api.POST(new Request('https://example.chatgpt.site/api/local-data/bridge',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${secret}`},body:JSON.stringify(body)}));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function deliver(input) {
 const pending=bridge.hostedDataRPC(input);
 let task;
 for(let i=0;i<50 && !task;i++){await wait(10);task=await bridge.claimBridgeRequest();}
 assert.ok(task);
 const result=await dataRPC(JSON.parse(task.input));
 const payload=JSON.stringify(result);
 // Exercise multiple transport chunks and ordering, including a repeated chunk.
 const chunks=[payload.slice(0,100),payload.slice(100)];
 await bridge.putBridgeChunk(task.id,task.lease,1,chunks[1]);
 await bridge.putBridgeChunk(task.id,task.lease,0,chunks[0]);
 await bridge.putBridgeChunk(task.id,task.lease,0,chunks[0]);
 await bridge.finishBridgeRequest(task.id,task.lease,2,null);
 assert.deepEqual(await pending,result);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM local_bridge_requests').first()).n,0);
 return result;
}
test('hosted requests detect disconnection without spawning or reporting missing data',async()=>{
 await assert.rejects(()=>bridge.hostedDataRPC({action:'status'}),/연결이 끊겼습니다.*데이터가 없는 뜻은 아닙니다/);
 assert.equal(await bridge.bridgeOnline(),false);
});
test('bridge endpoint refuses wrong credentials and invalid result inputs',async()=>{
 assert.equal((await send({action:'poll'},'wrong')).status,403);
 assert.equal((await send({action:'chunk',id:'../bad'})).status,409);
 assert.equal((await send({action:'poll',heartbeatOnly:true})).status,200);
 assert.equal(await bridge.bridgeOnline(),true);
});
test('stock and crypto traverse the hosted queue and reuse real immutable local files with market network disabled',async()=>{
 const start=Date.UTC(2025,0,1),end=Date.UTC(2025,0,4),at=Date.UTC(2025,0,2,15);
 const seed=`import sys;sys.path.insert(0,'scripts/data');import store;db=store.connect();[store.publish(db,name,${start},${end},[[${at},${at+60000},100,102,99,101,20,None]],'fixture') for name in ('stock','btc')]`;
 const r=spawnSync('.venv/bin/python',['-c',seed],{env:process.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 for(const dataset of ['stock','btc']){
  const input={action:'query',dataset,from:start,to:end,minutes:1};validateInput(input);
  const first=await deliver(input),repeat=await deliver({...input,snapshot:first.snapshot});
  assert.equal(first.bars.length,1);assert.equal(first.externalRequestCount,0);assert.deepEqual(first.bars,repeat.bars);assert.equal(first.snapshot,repeat.snapshot);
 }
});
test('stale leases and incomplete results cannot complete a request',async()=>{
 const id=crypto.randomUUID(),now=Date.now();
 await db.prepare('INSERT INTO local_bridge_requests (id,input,created,expires) VALUES (?,?,?,?)').bind(id,'{}',now,now+120000).run();
 const task=await bridge.claimBridgeRequest();assert.equal(task.id,id);
 await assert.rejects(()=>bridge.putBridgeChunk(id,crypto.randomUUID(),0,'{}'),/만료/);
 await assert.rejects(()=>bridge.finishBridgeRequest(id,task.lease,1,null),/불완전/);
 await bridge.putBridgeChunk(id,task.lease,0,'{}');
 await bridge.finishBridgeRequest(id,task.lease,1,null);
 await db.prepare('DELETE FROM local_bridge_requests WHERE id=?').bind(id).run();
});
test('transport propagates actual missing coverage and rejects arbitrary local commands',async()=>{
 const pending=bridge.hostedDataRPC({action:'query',dataset:'btc',from:1,to:60000});
 let task;while(!task){await wait(10);task=await bridge.claimBridgeRequest();}
 await bridge.finishBridgeRequest(task.id,task.lease,0,'데이터 준비 필요: Missing [[1,60000]]');
 await assert.rejects(()=>pending,/데이터 준비 필요/);
 for(const input of [{action:'exec',cmd:'touch file'},{action:'query',dataset:'btc',from:1,to:2,url:'https://bad'},{action:'enqueue',dataset:'btc',from:1,to:2}]) assert.throws(()=>validateInput(input));
 await db.prepare("UPDATE local_bridge_runtime SET heartbeat=0").run();assert.equal(await bridge.bridgeOnline(),false);
 db.db.close();rmSync(dir,{recursive:true,force:true});delete process.env.QQUAN_DATA_DIR;delete process.env.QQUAN_DENY_MARKET_NETWORK;
});
