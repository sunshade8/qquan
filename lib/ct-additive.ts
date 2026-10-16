/** Preregistered research estimator. Fitting never receives validation labels. */
import type { CTBar } from './ct-engine.ts';
import type { DayInfo, MoveFeatureTable, MoveLabels } from './ct-moves.ts';
export const CT_ADDITIVE_VERSION = 'ct-additive-1';
const mean = (xs: number[]) => xs.reduce((a,b)=>a+b,0)/Math.max(1,xs.length);
const quantile = (xs: number[], q: number) => { const s=xs.filter(Number.isFinite).sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.floor(q*s.length))]??0; };
export function fitAdditive(cols: Float32Array[], rows: number[], labels: Int8Array, model: 'sign'|'logistic') {
  const stats=cols.map(c=>{const x=rows.map(i=>c[i]).filter(Number.isFinite), m=mean(x), sd=Math.sqrt(mean(x.map(v=>(v-m)**2)));return {lo:quantile(x,.25),hi:quantile(x,.75),median:quantile(x,.5),m,sd};});
  const normalize=(f:number,i:number)=>{const s=stats[f];return s.sd>0?Math.max(-8,Math.min(8,((Number.isFinite(cols[f][i])?cols[f][i]:s.median)-s.m)/s.sd)):0;};
  if(model==='sign') {
    const dirs=cols.map((c,f)=>{const s=stats[f];if(s.hi<=s.lo)return 0;const lo=rows.filter(i=>c[i]<=s.lo),hi=rows.filter(i=>c[i]>=s.hi);return Math.sign(mean(hi.map(i=>labels[i]))-mean(lo.map(i=>labels[i])));});
    return (i:number)=>cols.reduce((sum,c,f)=>sum+dirs[f]*(Number.isFinite(c[i])?(c[i]>=stats[f].hi?1:c[i]<=stats[f].lo?-1:0):0),0);
  }
  const w=new Float64Array(cols.length), x=cols.map((_,f)=>Float64Array.from(rows,i=>normalize(f,i)));
  let intercept=0;
  for(let iter=0;iter<80;iter++) {
    const grad=new Float64Array(cols.length);let b=0;
    for(let j=0;j<rows.length;j++){let z=intercept;for(let f=0;f<w.length;f++)z+=w[f]*x[f][j];const error=1/(1+Math.exp(-Math.max(-40,Math.min(40,z))))-labels[rows[j]];b+=error;for(let f=0;f<w.length;f++)grad[f]+=error*x[f][j];}
    intercept-=.1*b/Math.max(1,rows.length);for(let f=0;f<w.length;f++)w[f]-=.1*(grad[f]/Math.max(1,rows.length)+.01*w[f]);
  }
  return (i:number)=>{let z=intercept;for(let f=0;f<w.length;f++)z+=w[f]*normalize(f,i);return z;};
}
export function additiveWalkForward(input:{bars:CTBar[];day:DayInfo;labels:MoveLabels;features:MoveFeatureTable;costPct:number;hold:number;model:'sign'|'logistic'}) {
  const {bars,day,labels,features,costPct,hold,model}=input;
  const days=[...new Set(Array.from(day.key).filter(k=>k>=0))].sort((a,b)=>a-b);
  if(days.length<50)throw new Error('일자 표본 부족');
  const block=new Map(days.map((k,i)=>[k,Math.min(4,Math.floor(i*5/days.length))]));
  const outputs=[.05,.1,.2].map(tail=>({tail,trades:0,gross:0,baseline:0,daily:[] as number[],daily2:[] as number[],folds:[] as number[]}));
  for(let f=0;f<4;f++) {
    const start=bars.findIndex((_,i)=>block.get(day.key[i])===f+1), validationDays=days.filter(k=>block.get(k)===f+1);
    if(start<0)throw new Error('워크포워드 구간 없음');
    const train:number[]=[];for(let i=0;i<start;i+=15)if(labels.label[i]>=0&&labels.exitIndex[i]<start&&day.key[i]>=0)train.push(i);
    if(train.length<100)throw new Error('학습 표본 부족');
    const score=fitAdditive(features.cols,train,labels.label,model), scores=train.map(score);
    // Per-hour unconditional baseline is estimated on validation events for reporting only; never used by the estimator.
    const byHour=new Map<number,number[]>();
    for(let i=start;i<bars.length&&block.get(day.key[i])===f+1;i++)if(labels.label[i]>=0){const hour=Math.floor((bars[i].endMs-day.startMs[i])/3600000);const xs=byHour.get(hour)??[];xs.push(labels.grossPct[i]);byHour.set(hour,xs);}
    for(const out of outputs) {
      const threshold=quantile(scores,1-out.tail), daily=new Map(validationDays.map(k=>[k,0])),daily2=new Map(daily);
      let free=-1;
      for(let i=start;i<bars.length&&block.get(day.key[i])===f+1;i++) {
        if(i<=free||labels.label[i]<0||labels.exitIndex[i]<i||block.get(day.key[labels.exitIndex[i]])!==f+1)continue;
        if(hold===Infinity?day.key[i]===validationDays[0]:bars[i].startMs<bars[start].startMs+hold*60000)continue;
        if(score(i)<threshold)continue;
        const gross=labels.grossPct[i],key=day.key[i];out.trades++;out.gross+=gross;out.baseline+=mean(byHour.get(Math.floor((bars[i].endMs-day.startMs[i])/3600000))??[]);
        daily.set(key,daily.get(key)!+gross-costPct);daily2.set(key,daily2.get(key)!+gross-2*costPct);free=labels.exitIndex[i];
      }
      out.folds.push(mean([...daily.values()]));out.daily.push(...daily.values());out.daily2.push(...daily2.values());
    }
  }
  return outputs.map(o=>({model,tail:o.tail,trades:o.trades,days:o.daily.length,tradesPerDay:o.trades/Math.max(1,o.daily.length),dailyMeanPct:mean(o.daily),dailyMean2xPct:mean(o.daily2),grossMinusBaselinePct:(o.gross-o.baseline)/Math.max(1,o.trades),positiveFolds:o.folds.filter(x=>x>0).length,folds:o.folds}));
}
