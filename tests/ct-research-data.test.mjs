import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { contract } from './helpers/ct-fixture.mjs';
register('./helpers/slot-test-loader.mjs',import.meta.url);
globalThis.__strategyTestEnv={};
const {ctDataPage,ctResearchPageStart}=await import('../lib/ct-data.ts');
test('CT common query reads verified Parquet without Toss auth or any historical network',async()=>{
 const dir=mkdtempSync(tmpdir()+'/qquan-ct-data-');process.env.QQUAN_DATA_DIR=dir;process.env.QQUAN_DENY_MARKET_NETWORK='1';
 const start=Date.UTC(2025,0,1),end=Date.UTC(2025,0,4),timestamp=Date.UTC(2025,0,2,15);
 const seed=`import sys;sys.path.insert(0,'scripts/data');import store;store.publish(store.connect(),'stock',${start},${end},[[${timestamp},${timestamp+60000},100,102,99,101,20,None]],'fixture')`;
 const seeded=spawnSync('.venv/bin/python',['-c',seed],{env:process.env,encoding:'utf8'});assert.equal(seeded.status,0,seeded.stderr);
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('No network');};
 try{
  const c={...contract('stock'),symbols:['NVDA']};
  const one=await ctDataPage(c,'NVDA',c.toMs),two=await ctDataPage(c,'NVDA',c.toMs);
  assert.deepEqual(one,two);assert.deepEqual(one,[{startMs:timestamp,endMs:timestamp+60000,open:100,high:102,low:99,close:101,volume:20}]);assert.equal(calls,0);
  await assert.rejects(()=>ctDataPage({...c,symbols:['SPY']},'SPY',c.toMs),/identity/);
 }finally{globalThis.fetch=original;delete process.env.QQUAN_DATA_DIR;delete process.env.QQUAN_DENY_MARKET_NETWORK;rmSync(dir,{recursive:true,force:true});}
});
test('empty historical weeks advance by bounded time and do not imply exhausted history',()=>{
 const c={...contract('stock'),toMs:Date.UTC(2025,1,1)};
 assert.equal(ctResearchPageStart(c,c.toMs),c.toMs-7*86400000);
 assert.equal(ctResearchPageStart(c,c.fromMs+86400000),c.fromMs);
});
