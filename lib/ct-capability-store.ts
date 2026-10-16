import { ctDb } from './ct-data.ts';
import { ctCapabilities,type CTCapability } from './ct-capabilities.ts';
export const CT_CAPABILITY_SCHEMA='CREATE TABLE IF NOT EXISTS ct_capability_checks(product TEXT PRIMARY KEY,payload TEXT NOT NULL,checked_at TEXT NOT NULL)';
export async function ctStoredCapabilities():Promise<CTCapability[]>{await ctDb().prepare(CT_CAPABILITY_SCHEMA).run();const rows=await ctDb().prepare('SELECT product,payload FROM ct_capability_checks').all<{product:string;payload:string}>();return ctCapabilities().map(base=>{const row=rows.results.find(r=>r.product===base.product);return row?{...base,...JSON.parse(row.payload),liveReady:false}:base;});}
export async function ctRecordReadCapabilities(report:{at:string;checks:Array<{product:string;op:string;status:string;canTrade?:boolean;enableReading?:boolean;enableMargin?:boolean;enableSpotAndMarginTrading?:boolean;enableFutures?:boolean}>}){
 await ctDb().prepare(CT_CAPABILITY_SCHEMA).run();const permissions=report.checks.find(c=>c.op==='permissions');
 for(const c of ctCapabilities().filter(c=>c.product!=='stock')){
  const checks=report.checks.filter(r=>r.product===c.product),publicOk=checks.some(r=>r.op==='exchangeInfo'&&r.status==='ok'),account=checks.find(r=>r.op==='account');
  const flag=c.product.startsWith('margin')?permissions?.enableMargin:c.product==='spot'?permissions?.enableSpotAndMarginTrading:['usdm','coinm'].includes(c.product)?permissions?.enableFutures:undefined;
  const permission=flag===false?false:flag===true&&account?.status==='ok'?true:'unknown';
  const payload={...c,exchangeSupported:publicOk?true:'unknown',accountPermission:permission,checkedAt:report.at,reason:[...(permission===false?['상품 거래 권한 비활성']:[]),...c.reason],connections:{publicData:publicOk,signedAccount:account?.status==='ok',productPermission:permission,userStream:'unknown',runner:'local-only',ordersEnabled:false}};
  await ctDb().prepare('INSERT INTO ct_capability_checks VALUES (?,?,?) ON CONFLICT(product) DO UPDATE SET payload=excluded.payload,checked_at=excluded.checked_at').bind(c.product,JSON.stringify(payload),report.at).run();
 }
}
