export const generationAvailability=()=>({ready:true,missing:[]});
export const checkGenerationModels=async()=>{};
export const generationCall=async(owner,role,schema,prompt,options={})=>{
 await globalThis.__strategyTestHooks.usage?.(role, options);
 return {data:schema.parse(await globalThis.__strategyTestHooks.call(role,prompt,options)),costUsd:0.01};
};
