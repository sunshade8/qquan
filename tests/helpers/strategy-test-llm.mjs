export const generationAvailability=()=>({ready:true,missing:[]});
// Counted so a test can prove a refused run never reached the first provider call (the model-access check precedes every paid call).
export const checkGenerationModels=async()=>{globalThis.__modelAccessChecks=(globalThis.__modelAccessChecks??0)+1;};
export const generationCall=async(owner,role,schema,prompt,options={})=>{
 // Opt-in: run the real provider layer against a test's fake fetch stream (never the network).
 if (globalThis.__strategyTestHooks.realLlm) return (await import("../../lib/strategy-generation-llm.ts")).generationCall(owner,role,schema,prompt,options);
 await globalThis.__strategyTestHooks.usage?.(role, options);
 return {data:schema.parse(await globalThis.__strategyTestHooks.call(role,prompt,options)),costUsd:0.01};
};
export const designerTurn=async(owner,role,request,options={})=>{
 if (globalThis.__strategyTestHooks.realLlm) return (await import("../../lib/strategy-generation-llm.ts")).designerTurn(owner,role,request,options);
 await globalThis.__strategyTestHooks.usage?.(role, options);
 const data=await globalThis.__strategyTestHooks.turn(role,request,options);
 return {data,costUsd:globalThis.__strategyTestHooks.turnCost??0.02,usage:data.usage??{}};
};
