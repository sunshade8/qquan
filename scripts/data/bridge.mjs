/** Outbound-only connection from the existing local catalog to the owner's private Site. */
import { validateInput } from './bridge-input.mjs';
import { loadEnvFile } from 'node:process';
import { dataRPC } from '../../lib/market-data-rpc.ts';
import { startDataWorker } from '../../lib/local-data-worker.ts';
try { loadEnvFile('.dev.vars'); } catch {}
const base = process.env.LOCAL_DATA_SITE_URL;
const secret = process.env.LOCAL_DATA_BRIDGE_SECRET;
const access = process.env.LOCAL_DATA_SITES_AUTHORIZATION;
if (!base || !secret || !access) throw Error('로컬 연결 설정 필요: LOCAL_DATA_SITE_URL / LOCAL_DATA_BRIDGE_SECRET / LOCAL_DATA_SITES_AUTHORIZATION');
const url = new URL(base);
if (url.protocol !== 'https:' || !url.hostname.endsWith('.chatgpt.site') || url.username || url.password || url.search || url.hash) throw Error('기존 HTTPS Sites URL만 허용합니다.');
url.pathname = '/api/local-data/bridge';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let stopping = false;
for (const event of ['SIGINT','SIGTERM']) process.on(event,()=>{stopping=true;});
async function send(body) {
  const r = await fetch(url, {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${secret}`,'OAI-Sites-Authorization':`Bearer ${access}`},body:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
  const result = await r.json().catch(()=>({}));
  if (!r.ok) throw Error(`로컬 연결 HTTP ${r.status}: ${result.error || '인증·사이트 설정 확인'}`);
  return result;
}
async function work(task) {
  let output, error=null;
  try {
    validateInput(task.input);
    if(task.input.action==='ct_control') {
      if(!process.env.QQUAN_OWNER_ID || task.input.owner!==process.env.QQUAN_OWNER_ID)throw Error('로컬·Sites 연구 소유자 불일치 · 연결 설정 확인 필요');
      const target=new URL('/api/invest/ct/experiments',process.env.LOCAL_CONTROL_URL||'http://127.0.0.1:3000');
      if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname))throw Error('로컬 제어 API만 허용');
      const method=['list','get'].includes(task.input.operation)?'GET':'POST';
      if(method==='GET')for(const [k,v]of Object.entries(task.input.body))if(['id','market'].includes(k))target.searchParams.set(k,String(v));
      const result=await fetch(target,{method,headers:{'content-type':'application/json',cookie:`qquant_research_device=${task.input.owner}`},...(method==='POST'?{body:JSON.stringify({...task.input.body,action:task.input.operation})}:{}),signal:AbortSignal.timeout(90000)});
      const packet=await result.json();if(!result.ok)throw Error(packet.error||'로컬 CT 제어 실패');output=JSON.stringify(packet);
    }else output=JSON.stringify(await dataRPC(task.input));
    if (output.length>60_000_000) throw Error('조회 결과가 큽니다. 기간을 줄이세요.');
    if (['enqueue','resume'].includes(task.input.action)) startDataWorker();
  } catch(e) { error=e.message.slice(0,1900); }
  let chunks=0;
  if (!error) {
    for(let offset=0;offset<output.length;offset+=300_000) {
      await send({action:'chunk',id:task.id,lease:task.lease,page:chunks,payload:output.slice(offset,offset+300_000)});
      chunks++;
    }
  }
  await send({action:'complete',id:task.id,lease:task.lease,chunks,error});
}
// Keep connectivity visible while Python verifies a large catalog.
const heartbeat=setInterval(()=>{ void send({action:'poll',heartbeatOnly:true}).catch(()=>{}); },10_000);
console.log(`로컬 저장소 연결 → ${url.origin} (시장 데이터 재다운로드 없음)`);
while (!stopping) {
  try {
    const {task}=await send({action:'poll',capabilities:['ct-control-v1']});
    if (task) await work(task);
  } catch(e) { console.error(e.message); await sleep(5000); }
  if (!stopping) await sleep(1000);
}
clearInterval(heartbeat);
