export const generationAvailability=()=>({ready:true,missing:[]});
export const checkGenerationModels=async()=>{};
export const generationCall=async(owner,role,schema,prompt,options={})=>{
 // Opt-in: run the real provider layer against a test's fake fetch stream (never the network).
 if (globalThis.__strategyTestHooks.realLlm) return (await import("../../lib/strategy-generation-llm.ts")).generationCall(owner,role,schema,prompt,options);
 await globalThis.__strategyTestHooks.usage?.(role, options);
 return {data:schema.parse(await globalThis.__strategyTestHooks.call(role,prompt,options)),costUsd:0.01};
};
