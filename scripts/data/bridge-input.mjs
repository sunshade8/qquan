// Never accept shell, file paths, arbitrary URLs, or a download range from the Site.
export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('잘못된 로컬 작업');
  if (input.action==='status' && Object.keys(input).length===1) return;
  if (input.action==='query' && ['stock','btc'].includes(input.dataset) && Number.isFinite(input.from) && Number.isFinite(input.to) && input.to>input.from && Object.keys(input).every(k=>['action','dataset','from','to','minutes','session','snapshot','instrument','venue','quoteCurrency','adjustmentPolicy','networkPolicy','maxBars','metadataOnly'].includes(k))) return;
  if (input.action==='enqueue' && ['stock','btc'].includes(input.dataset) && Object.keys(input).length===2) return;
  if (['cancel','resume'].includes(input.action) && typeof input.id==='string' && /^[a-f0-9-]{36}$/.test(input.id) && Object.keys(input).length===2) return;
  throw Error('허용되지 않은 로컬 작업');
}
