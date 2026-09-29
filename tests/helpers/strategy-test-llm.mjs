export const generationAvailability=()=>({ready:true,missing:[]});
export const checkGenerationModels=async()=>{};
export const generationCall=async(owner,role,schema,prompt)=>({data:schema.parse(await globalThis.__strategyTestHooks.call(role,prompt)),costUsd:0.01});
