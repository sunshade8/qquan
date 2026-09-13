import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const HERE=path.dirname(fileURLToPath(import.meta.url));
export const OOS='2026-03-04';
export const SYMBOLS=['AMD','COIN','NVDA','PLTR','TSLA'];
export const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
export const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),i=Math.floor(b.length/2);return b.length%2?b[i]:(b[i-1]+b[i])/2;};
export const pct=(a,b)=>(a/b-1)*100;
export const min=a=>Math.min(...a),max=a=>Math.max(...a);
export const round=(x,d=4)=>x===null||!Number.isFinite(x)?null:+x.toFixed(d);
export function loadData(){
 const data={};
 for(const symbol of [...SYMBOLS,'QQQ','SPY']){
  const rows=JSON.parse(fs.readFileSync(path.join(HERE,'../cache',`intraday-${symbol}-5m-2024-09-09-2026-09-04.json`),'utf8'));
  const days=new Map();for(const b of rows){if(b.time<'09:30'||b.time>='16:00')continue;if(!days.has(b.date))days.set(b.date,[]);days.get(b.date).push(b);}
  let previous=null;const priorVolumes=[];const sessions=new Map();
  for(const [date,bars] of [...days].sort(([a],[b])=>a.localeCompare(b))){
   bars.sort((a,b)=>a.timestamp-b.timestamp);
   const complete=bars.length===78&&bars[0].time==='09:30'&&bars.at(-1).time==='15:55'&&bars.every((b,i)=>!i||b.timestamp-bars[i-1].timestamp===300);
   let size=0,notional=0;const vwap=bars.map(b=>{size+=b.volume;notional+=(b.high+b.low+b.close)/3*b.volume;return size?notional/size:b.close;});
   const ov=bars.slice(0,6).reduce((s,b)=>s+b.volume,0),baseline=priorVolumes.length>=20?median(priorVolumes.slice(-20)):null;
   sessions.set(date,{date,bars,complete,vwap,previous,rv30:baseline?ov/baseline:null});
   previous={close:bars.at(-1).close,high:max(bars.map(b=>b.high)),low:min(bars.map(b=>b.low))};if(complete)priorVolumes.push(ov);
  }
  data[symbol]=sessions;
 }
 return data;
}
export function netPct(entry,exit,slip=.03){const side=.002+slip/200;return (exit*(1-side)/(entry*(1+side))-1)*100;}
export function finish(signal,session,{delay=0,targetScale=1,slip=.03}={}){
 const bs=session.bars,idx=signal.signalIndex+1+delay,b=bs[idx];
 if(!b||idx>=77||b.timestamp!==bs[signal.signalIndex].timestamp+(1+delay)*300)return null;
 const entry=b.open,stop=signal.stop,risk=pct(entry,stop); // enforce signal and actual fill admissibility
 const distance=(entry-stop)/entry*100;if(distance<.6||distance>2.5)return null;
 // Target uses actual entry price, known when the order fills; stop was fixed at signal.
 const target=entry+(entry-stop)*signal.reward*targetScale;
 const deadline=Math.min(78,idx+signal.holdBars);
 let exit=bs[deadline-1].close,exitTs=bs[deadline-1].timestamp+300,reason='time';
 for(let j=idx;j<deadline;j++){
  const q=bs[j];
  if(q.open<=stop){exit=q.open;exitTs=q.timestamp+300;reason='gap-stop';break;}
  if(q.low<=stop){exit=stop;exitTs=q.timestamp+300;reason='stop';break;}
  if(q.high>=target){exit=target;exitTs=q.timestamp+300;reason='target';break;}
 }
 return {...signal,entryTs:b.timestamp,exitTs,entry,exit,stop,target,grossPct:pct(exit,entry),netPct:netPct(entry,exit,slip),exitReason:reason};
}
function rng(seed){let s=seed;return()=>{s=(s+0x6D2B79F5)|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
export function dateBootstrap(trades){
 if(!trades.length)return null;const by=new Map();for(const t of trades){if(!by.has(t.date))by.set(t.date,[]);by.get(t.date).push(t.netPct);}
 const groups=[...by.values()],rand=rng(20260909),values=[];
 for(let run=0;run<1200;run++){let sum=0,n=0;for(let j=0;j<groups.length;j++){const g=groups[Math.floor(rand()*groups.length)];for(const x of g){sum+=x;n++;}}values.push(sum/n);}
 values.sort((a,b)=>a-b);return [round(values[30]),round(values[1169])];
}
export function tradeStats(trades){return {n:trades.length,days:new Set(trades.map(t=>t.date)).size,grossMeanPct:round(mean(trades.map(t=>t.grossPct))),netMeanPct:round(mean(trades.map(t=>t.netPct))),medianNetPct:round(median(trades.map(t=>t.netPct))),grossWinPct:trades.length?round(trades.filter(t=>t.grossPct>0).length/trades.length*100):null,netWinPct:trades.length?round(trades.filter(t=>t.netPct>0).length/trades.length*100):null,dateBootstrap95Mean:dateBootstrap(trades),worstTradePct:trades.length?round(min(trades.map(t=>t.netPct))):null};}
export function account(trades,data,{from='2024-09-09',to='2026-09-04',slots=3,slip=.03,capital=1000}={}){
 const side=.002+slip/200,byEntry=new Map();
 for(const t of trades.filter(t=>t.date>=from&&t.date<=to)){if(!byEntry.has(t.entryTs))byEntry.set(t.entryTs,[]);byEntry.get(t.entryTs).push(t);}
 for(const list of byEntry.values())list.sort((a,b)=>a.strategy.localeCompare(b.strategy)||a.symbol.localeCompare(b.symbol));
 let cash=capital,peak=capital,mdd=0;const active=[],marks=new Map(),daily=[],executed=[],skipped={capacity:0,sameSymbol:0,unaffordable:0};
 const dates=[...data.SPY.keys()].filter(d=>d>=from&&d<=to).sort();
 let priorEquity=capital;
 for(const date of dates){
  const spy=data.SPY.get(date).bars,clock=[...new Set([...spy.map(b=>b.timestamp),spy.at(-1).timestamp+300])].sort((a,b)=>a-b);
  let dayTrades=0;
  for(const ts of clock){
   // Only completed bars can mark holdings for a new order at this timestamp.
   for(const symbol of new Set([...SYMBOLS,...active.map(x=>x.symbol)])){
    const bars=data[symbol]?.get(date)?.bars;const b=bars?.find(b=>b.timestamp+300===ts);if(b)marks.set(symbol,b.close);
   }
   for(let j=active.length-1;j>=0;j--){const t=active[j];if(t.exitTs<=ts){cash+=t.qty*t.exit*(1-side);active.splice(j,1);}}
   for(const t of byEntry.get(ts)||[]){
    if(active.some(a=>a.symbol===t.symbol)){skipped.sameSymbol++;continue;}if(active.length>=slots){skipped.capacity++;continue;}
    const equity=cash+active.reduce((s,p)=>s+p.qty*(marks.get(p.symbol)??p.entry),0);
    const budget=Math.min(cash,equity/slots),qty=Math.floor((budget+1e-9)/(t.entry*(1+side)));
    if(qty<1){skipped.unaffordable++;continue;}
    cash-=qty*t.entry*(1+side);if(cash < -1e-7)throw Error('negative cash');
    const position={...t,qty,allocatedUsd:qty*t.entry*(1+side),pnlUsd:qty*(t.exit*(1-side)-t.entry*(1+side))};active.push(position);executed.push(position);dayTrades++;
   }
   const equity=cash+active.reduce((s,p)=>s+p.qty*(marks.get(p.symbol)??p.entry),0);
   peak=Math.max(peak,equity);mdd=Math.max(mdd,(peak-equity)/peak);
  }
  if(active.length)throw Error(`unclosed positions ${date}`);
  daily.push({date,equity:cash,returnPct:pct(cash,priorEquity),trades:dayTrades});priorEquity=cash;
 }
 const n=daily.length,rets=daily.map(d=>d.returnPct);
 return {startingUsd:capital,endingUsd:round(cash,2),totalPct:round(pct(cash,capital)),geometricDailyPct:n?round(((cash/capital)**(1/n)-1)*100):null,meanDailyPct:round(mean(rets)),medianDailyPct:round(median(rets)),sessions:n,trades:executed.length,activeDays:daily.filter(d=>d.trades).length,noTradeDays:daily.filter(d=>!d.trades).length,lossDays:daily.filter(d=>d.returnPct< -1e-9).length,hit1Days:daily.filter(d=>d.returnPct>=1).length,hit2Days:daily.filter(d=>d.returnPct>=2).length,hit1Pct:n?round(daily.filter(d=>d.returnPct>=1).length/n*100):null,hit2Pct:n?round(daily.filter(d=>d.returnPct>=2).length/n*100):null,worstDayPct:round(min(rets)),maxDrawdown5mPct:round(mdd*100),skipped,daily,executed};
}
export function compactAccount(x){const {daily,executed,...rest}=x;return rest;}
