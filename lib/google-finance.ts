import type { PriceRow } from "./market-data";

const GOOGLE_FINANCE_QUOTES: Record<string, string> = {
  SPY: "SPY:NYSEARCA",
  QQQ: "QQQ:NASDAQ",
  "^IXIC": ".IXIC:INDEXNASDAQ",
  "^NYA": "NYA:INDEXNYSEGIS",
};

const GOOGLE_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function dataBlocks(html: string, quote: string) {
  const [ticker, exchange] = quote.split(":");
  const needle = `[[["${ticker}","${exchange}"]`;
  const blocks: string[] = [];
  let position = -1;
  while ((position = html.indexOf(needle, position + 1)) >= 0) {
    const start = html.lastIndexOf("AF_initDataCallback", position);
    const end = html.indexOf("</script>", position);
    if (start >= 0 && end > position) blocks.push(html.slice(start, end));
  }
  return blocks;
}

function rowsFromBlock(block: string) {
  const rows: PriceRow[] = [];
  for (const match of block.matchAll(/\[(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),"(20\d{2}-\d{2}-\d{2})T[^"]+",(\d+)\]/g)) {
    rows.push({ date: match[5], open: Number(match[1]), close: Number(match[2]), high: Number(match[3]), low: Number(match[4]), volume: Number(match[6]) });
  }
  if (rows.length) return rows;

  // Index history is supplied as date + close pairs. This fallback is used
  // only for close-to-close research returns, never intraday calculations.
  for (const match of block.matchAll(/\[\[(\d{4}),(\d{1,2}),(\d{1,2}),.{0,100}?\],\[(-?[\d.]+)/g)) {
    const close = Number(match[4]);
    rows.push({
      date: `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`,
      open: close, high: close, low: close, close, volume: 0,
    });
  }
  return rows;
}

/** Close-history fallback used when Yahoo throttles the shared Worker IP. */
export async function fetchGoogleFinanceWindow(symbol: string, from: string, to: string) {
  const quote = GOOGLE_FINANCE_QUOTES[symbol];
  if (!quote) throw new Error("Google Finance에서 이 심볼을 지원하지 않습니다.");
  const url = new URL(`https://www.google.com/finance/quote/${encodeURIComponent(quote)}`);
  url.searchParams.set("window", "1Y");
  url.searchParams.set("hl", "en");
  const response = await fetch(url, { headers: GOOGLE_HEADERS });
  if (!response.ok) throw new Error(`Google Finance HTTP ${response.status}`);
  const html = await response.text();
  const candidates = dataBlocks(html, quote)
    .filter((block) => block.includes(",86400,"))
    .map(rowsFromBlock)
    .filter((rows) => rows.length)
    .sort((left, right) => right.length - left.length);
  const seen = new Map<string, PriceRow>();
  for (const row of candidates[0] ?? []) if (row.date >= from && row.date <= to) seen.set(row.date, row);
  const rows = [...seen.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (!rows.length) throw new Error("Google Finance에 해당 구간 데이터가 없습니다.");
  return rows;
}
