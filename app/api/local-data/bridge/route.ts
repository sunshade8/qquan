import { env } from "cloudflare:workers";
import { claimBridgeRequest, finishBridgeRequest, putBridgeChunk } from "@/lib/local-bridge-store";
export const dynamic = "force-dynamic";
export async function POST(request:Request) {
  const secret = (env as unknown as Record<string,string|undefined>).LOCAL_DATA_BRIDGE_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return Response.json({error:'로컬 저장소 연결 인증 필요'},{status:403});
  try {
    if (Number(request.headers.get('content-length') || 0) > 600_000) throw Error('입력 크기 초과');
    const body = await request.json() as Record<string,unknown>;
    if (body.action === 'poll') {
      const task = await claimBridgeRequest(body.heartbeatOnly === true, Array.isArray(body.capabilities) && body.capabilities.includes("ct-control-v1"));
      return Response.json({task:task ? {...task,input:JSON.parse(task.input)} : null},{headers:{'cache-control':'no-store'}});
    }
    if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id) || typeof body.lease !== 'string' || !/^[a-f0-9-]{36}$/.test(body.lease)) throw Error('잘못된 작업 ID');
    if (body.action === 'chunk' && Number.isInteger(body.page) && Number(body.page)>=0 && Number(body.page)<200 && typeof body.payload==='string' && body.payload.length<=400_000)
      await putBridgeChunk(body.id,body.lease,Number(body.page),body.payload);
    else if (body.action === 'complete' && Number.isInteger(body.chunks) && Number(body.chunks)>=0 && Number(body.chunks)<=200 && (body.error===null || (typeof body.error==='string' && body.error.length<2000)))
      await finishBridgeRequest(body.id,body.lease,Number(body.chunks),body.error as string|null);
    else throw Error('허용되지 않은 연결 작업');
    return Response.json({ok:true});
  } catch(e) {
    return Response.json({error:e instanceof Error?e.message:'로컬 연결 실패'},{status:409});
  }
}
