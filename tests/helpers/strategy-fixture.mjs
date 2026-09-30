export const candidate={barInterval:"5m",name:"검증용 추세",hypothesis:"테스트 전용 합성 데이터에서 완성 봉 추세를 판정합니다.",conditions:[{feature:"returnPct",lookback:2,operator:"gte",value:0},{feature:"relativeVolume",lookback:2,operator:"gte",value:0.5}],rankBy:"returnPct",rankDirection:"desc",rankLookback:2,stopPct:1,targetPct:1,minMinutesAfterOpen:5,maxSpreadPct:0.2,minBarDollarVolume:100000,cautions:["테스트 합성 데이터입니다.","실제 성과를 의미하지 않습니다."]};
export const spec={version:1,id:"test-rule",slot:"trend",universe:["NVDA"],candidate,evidence:"test only"};
export function day(date="2026-01-05",price=100,step=5) {
  const bars=[];
  for(let m=570;m<960;m+=step){const time=`${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;const close=m<605?price:price*(1+(m-600)/5000);bars.push({date,time,open:close,close,high:close+0.02,low:close-0.02,volume:100000});}
  return {date,bars:{NVDA:bars,SPY:bars.map(b=>({...b}))}};
}
export function sessions(count=200,step=5) {const rows=[];for(let n=0;rows.length<count;n++){const d=new Date(Date.UTC(2025,8,18+n));if(d.getUTCDay()>0&&d.getUTCDay()<6)rows.push(day(d.toISOString().slice(0,10),100,step));}return rows;}
