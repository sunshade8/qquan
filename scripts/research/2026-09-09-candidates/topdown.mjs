import fs from 'node:fs';
import path from 'node:path';
import {HERE,OOS,SYMBOLS,loadData,mean,median,min,max,pct,finish,tradeStats,account,compactAccount} from './core.mjs';
export function signalsFor(data){
 const out=[];
 for(const symbol of SYMBOLS)for(const [date,s] of data[symbol]){
  const q=data.QQQ.get(date);if(!s.complete||!q?.complete)continue;const bs=s.bars,qb=q.bars;
  const push=(strategy,i,stop,reward,holdBars,score)=>{const dist=(bs[i].close-stop)/bs[i].close*100;if(dist>=.6&&dist<=2.5)out.push({strategy,symbol,date,signalIndex:i,signalTs:bs[i].timestamp+300,stop,reward,holdBars,score});};
  // P1: previous-session reference low is already known at today's open.
  if(s.previous){let swept=false;for(let i=3;i<24;i++){
   const low=min(bs.slice(0,i+1).map(b=>b.low));if(low<=s.previous.low*.998)swept=true;
   if(swept&&bs[i].close>=s.previous.low*1.001&&bs[i].close>bs[i-1].high&&pct(qb[i].close,qb[i-3].close)>0){push('P1',i,low*.999,2,18,pct(bs[i].close,s.previous.low));break;}
  }}
  const opening=bs.slice(0,6),oh=max(opening.map(b=>b.high)),ol=min(opening.map(b=>b.low)),range=oh-ol;
  // P2: complete first 30 minutes and historical volume required.
  if(s.rv30>=1.5&&pct(bs[5].close,bs[0].open)>=1&&(bs[5].close-ol)/range>=.7&&qb[5].close>=qb[0].open){
   for(let i=6;i<30;i++){
    const pullLow=min(bs.slice(6,i+1).map(b=>b.low)),pull=(oh-pullLow)/range;
    if(pull>.6)break;
    if(pull>=.25&&pullLow>ol+range*.5&&bs[i].close>bs[i-1].high&&bs[i].close>s.vwap[i]){push('P2',i,pullLow*.999,2.5,24,s.rv30);break;}
   }
  }
  // P3: 13:30 decisions only use bars through 13:25.
  const morning=bs.slice(0,30),lunch=bs.slice(30,48),lh=max(lunch.map(b=>b.high)),ll=min(lunch.map(b=>b.low));
  if(pct(bs[47].close,bs[0].open)>=1&&qb[47].close>=qb[0].open&&(lh-ll)<=.45*(max(morning.map(b=>b.high))-min(morning.map(b=>b.low)))&&bs[47].close>s.vwap[47]){
   for(let i=48;i<63;i++)if(bs[i].close>lh&&bs[i].volume>=1.5*median(bs.slice(i-12,i).map(b=>b.volume))){push('P3',i,ll*.999,2,78,pct(bs[i].close,lh));break;}
  }
 }
 return out;
}
const data=loadData(),signals=signalsFor(data);
function replay(opts={}){return signals.map(s=>finish(s,data[s.symbol].get(s.date),opts)).filter(Boolean);}
const base=replay(),report={protocol:'protocol.md',generatedAt:new Date().toISOString(),cost:{commissionEachSidePct:.2,executionRoundTripPct:.03,stressExecutionRoundTripPct:.10},allSignals:signals.length,rows:[]};
for(const strategy of ['P1','P2','P3']){
 const ts=base.filter(t=>t.strategy===strategy),is=ts.filter(t=>t.date<OOS),os=ts.filter(t=>t.date>=OOS);
 const ac=account(ts,data,{from:OOS,slots:1});
 const row={strategy,is:tradeStats(is),oos:tradeStats(os),oosAccount1000:compactAccount(ac),robustness:{}};
 for(const [label,opts] of Object.entries({stress:{slip:.10},target80:{targetScale:.8},target120:{targetScale:1.2},delay5m:{delay:1}}))row.robustness[label]=tradeStats(replay(opts).filter(t=>t.strategy===strategy&&t.date>=OOS));
 report.rows.push(row);
}
report.allRulesOos3Slots=compactAccount(account(base,data,{from:OOS,slots:3}));
report.allRulesOos1Slot=compactAccount(account(base,data,{from:OOS,slots:1}));
report.dataQuality=Object.fromEntries(Object.entries(data).map(([sym,s])=>[sym,{sessions:s.size,fullSessions:[...s.values()].filter(x=>x.complete).length,from:[...s.keys()][0],to:[...s.keys()].at(-1)}]));
fs.writeFileSync(path.join(HERE,'signals.json'),JSON.stringify(signals,null,2));
fs.writeFileSync(path.join(HERE,'trades.json'),JSON.stringify(base,null,2));
fs.writeFileSync(path.join(HERE,'results.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(HERE,'portfolio.json'),JSON.stringify({oneSlot:account(base,data,{from:OOS,slots:1}),threeSlots:account(base,data,{from:OOS,slots:3})},null,2));
console.log(JSON.stringify(report,null,2));
