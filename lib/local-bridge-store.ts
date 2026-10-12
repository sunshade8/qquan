import { env } from "cloudflare:workers";

const db = () => (env as unknown as { DB: D1Database }).DB;
export const BRIDGE_OFFLINE = "로컬 저장소 연결이 끊겼습니다. 데이터가 없는 뜻은 아닙니다. 컴퓨터에서 npm run data:bridge를 실행하고 연결을 확인하세요.";
let initialized: Promise<void> | undefined;
export function ensureBridge() {
  return initialized ??= (async () => {
    await db().prepare("CREATE TABLE IF NOT EXISTS local_bridge_runtime (id TEXT PRIMARY KEY, heartbeat INTEGER NOT NULL)").run();
    await db().prepare("CREATE TABLE IF NOT EXISTS local_bridge_requests (id TEXT PRIMARY KEY,input TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',chunks INTEGER,error TEXT)").run();
    await db().prepare("CREATE INDEX IF NOT EXISTS local_bridge_pending ON local_bridge_requests(status,created)").run();
    await db().prepare("CREATE TABLE IF NOT EXISTS local_bridge_chunks (id TEXT NOT NULL,lease TEXT NOT NULL,page INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,lease,page))").run();
  })().catch(e => { initialized = undefined; throw e; });
}
export async function bridgeOnline() {
  await ensureBridge();
  const row = await db().prepare("SELECT heartbeat FROM local_bridge_runtime WHERE id='data'").first<{heartbeat:number}>();
  return Boolean(row && row.heartbeat > Date.now() - 45_000);
}
export async function claimBridgeRequest(heartbeatOnly = false) {
  await ensureBridge();
  const now = Date.now();
  await db().prepare("INSERT INTO local_bridge_runtime VALUES ('data',?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat").bind(now).run();
  if (heartbeatOnly) return null;
  // Results are transient transport, never a second market catalog.
  await db().prepare("DELETE FROM local_bridge_chunks WHERE id IN (SELECT id FROM local_bridge_requests WHERE expires<?)").bind(now - 60_000).run();
  await db().prepare("DELETE FROM local_bridge_requests WHERE expires<?").bind(now - 60_000).run();
  const lease = crypto.randomUUID();
  return db().prepare("UPDATE local_bridge_requests SET lease=?,lease_until=?,status='running' WHERE id=(SELECT id FROM local_bridge_requests WHERE expires>? AND (status='queued' OR (status='running' AND lease_until<?)) ORDER BY created LIMIT 1) RETURNING id,input,lease")
    .bind(lease,now+100_000,now,now).first<{id:string;input:string;lease:string}>();
}
export async function putBridgeChunk(id:string, lease:string, page:number, payload:string) {
  await ensureBridge();
  const result = await db().prepare("INSERT INTO local_bridge_chunks (id,lease,page,payload) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM local_bridge_requests WHERE id=? AND lease=? AND status='running' AND lease_until>? AND expires>?) ON CONFLICT(id,lease,page) DO UPDATE SET payload=excluded.payload")
    .bind(id,lease,page,payload,id,lease,Date.now(),Date.now()).run();
  if (!result.meta.changes) throw Error("로컬 연결 작업이 만료되었습니다.");
}
export async function finishBridgeRequest(id:string, lease:string, chunks:number, error:string|null) {
  await ensureBridge();
  const result = await db().prepare("UPDATE local_bridge_requests SET status='done',chunks=?,error=? WHERE id=? AND lease=? AND status='running' AND lease_until>? AND expires>? AND (? IS NOT NULL OR ?=(SELECT COUNT(*) FROM local_bridge_chunks WHERE id=? AND lease=?))")
    .bind(chunks,error,id,lease,Date.now(),Date.now(),error,chunks,id,lease).run();
  if (!result.meta.changes) throw Error("로컬 연결 결과가 불완전하거나 만료되었습니다.");
}
export async function hostedDataRPC<T>(input:object):Promise<T> {
  if (!await bridgeOnline()) throw Error(BRIDGE_OFFLINE);
  const id = crypto.randomUUID(), now=Date.now();
  await db().prepare("INSERT INTO local_bridge_requests (id,input,created,expires) VALUES (?,?,?,?)").bind(id,JSON.stringify(input),now,now+120_000).run();
  try {
    while (Date.now() < now+115_000) {
      const row = await db().prepare("SELECT status,lease,chunks,error FROM local_bridge_requests WHERE id=?").bind(id).first<{status:string;lease:string;chunks:number;error:string|null}>();
      if (row?.status === 'done') {
        if (row.error) throw Error(row.error);
        const pages = await db().prepare("SELECT page,payload FROM local_bridge_chunks WHERE id=? AND lease=? ORDER BY page").bind(id,row.lease).all<{page:number;payload:string}>();
        if (pages.results.length !== row.chunks || pages.results.some((p,i)=>p.page!==i)) throw Error("로컬 연결 결과 누락: 다시 시도하세요.");
        return JSON.parse(pages.results.map(p=>p.payload).join('')) as T;
      }
      await new Promise(r=>setTimeout(r,1000));
    }
    throw Error("로컬 저장소 조회 시간이 초과되었습니다. 컴퓨터의 연결과 실행기를 확인하세요.");
  } finally {
    await db().batch([
      db().prepare("DELETE FROM local_bridge_chunks WHERE id=?").bind(id),
      db().prepare("DELETE FROM local_bridge_requests WHERE id=?").bind(id),
    ]);
  }
}
