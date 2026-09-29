export const lastCompleteDate=()=>globalThis.__strategyTestHooks.to ?? "2026-09-17";
export async function loadRelaySessions(symbols,from,to){
 const sessions=globalThis.__strategyTestHooks.sessions.filter(s=>s.date>=from&&s.date<=to).map(s=>({date:s.date,bars:Object.fromEntries(symbols.map(symbol=>[symbol,s.bars[symbol]??[]]))}));
 return {sessions,warmup:0,sources:symbols.map(symbol=>({symbol,provider:"Massive",bars:sessions.reduce((n,d)=>n+d.bars[symbol].length,0)})),warnings:[]};
}
