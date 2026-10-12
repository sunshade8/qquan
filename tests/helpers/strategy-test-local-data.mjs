export async function queryLocalMarket(){return {bars:globalThis.__strategyTestHooks.sessions.map(d=>({startMs:Date.parse(d.date),close:100,high:105,low:99,volume:1000000})),externalRequestCount:0};}
