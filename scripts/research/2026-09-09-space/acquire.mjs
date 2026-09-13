import fs from 'node:fs';
const dir = new URL('./', import.meta.url);
const root = new URL('../../../', import.meta.url);
const vars=fs.readFileSync(new URL('.dev.vars',root),'utf8');
const pick=(name)=>vars.split('\n').find(x=>x.startsWith(name+'='))?.slice(name.length+1).trim().replace(/^["']|["']$/g,'');
const key=pick('MASSIVE_API_KEY')||pick('POLYGON_API_KEY');
if(!key) throw new Error('missing market-data credential');
let last=0;
async function call(path){let delay=13000-(Date.now()-last);if(delay>0)await new Promise(r=>setTimeout(r,delay));last=Date.now();const res=await fetch('https://api.massive.com'+path,{headers:{authorization:'Bearer '+key,accept:'application/json'}});if(!res.ok)throw new Error('market-data request HTTP '+res.status);return res.json()}
let refFile=new URL('spcx-reference.json',dir);
const m=fs.existsSync(refFile)?JSON.parse(fs.readFileSync(refFile,'utf8')):(await call('/v3/reference/tickers/SPCX?date=2026-09-04')).results||{};fs.writeFileSync(new URL('spcx-reference.json',dir),JSON.stringify(m,null,2));
console.log(JSON.stringify({symbol:m.ticker,name:m.name,type:m.type,primary_exchange:m.primary_exchange,list_date:m.list_date,cik:m.cik}));
if(!/space exploration|spacex/i.test(m.name||''))throw new Error('SPCX issuer not verified by provider');
for(const sym of ['SPCX','RKLB','ASTS']){
 const path=new URL('intraday-'+sym+'.json',dir);
 if(fs.existsSync(path)){console.log(sym+' existing file');continue}
 let next='/v2/aggs/ticker/'+sym+'/range/5/minute/2026-06-12/2026-09-04?adjusted=true&sort=asc&limit=50000';
 const points=[];let pages=0;
 while(next){
  if(++pages>4)throw new Error('bounded page count exceeded');
  const payload=await call(next);points.push(...(payload.results||[]));
  if(payload.next_url){const u=new URL(payload.next_url);if(!['api.massive.com','api.polygon.io'].includes(u.hostname))throw new Error('unexpected pagination host');u.searchParams.delete('apiKey');next=u.pathname+u.search;}else next=null;
 }
 fs.writeFileSync(path,JSON.stringify(points));
 console.log(JSON.stringify({symbol:sym,bars:points.length,first:points[0]?.t,last:points.at(-1)?.t}));
}

const fresh=await call('/v2/aggs/ticker/NVDA/range/5/minute/2026-03-02/2026-03-02?adjusted=true&sort=asc&limit=50000');
fs.writeFileSync(new URL('audit-NVDA-2026-03-02.json',dir),JSON.stringify(fresh.results||[]));
console.log(JSON.stringify({audit:'NVDA',bars:(fresh.results||[]).length}));
