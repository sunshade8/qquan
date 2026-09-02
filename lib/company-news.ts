export type CompanyNewsItem = { title: string; source: string; url: string; publishedAt: string };

const headers = {
  accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
};

function decodeXml(value: string) {
  return value.replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").trim();
}

function tag(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function shiftDate(date: string, days: number) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export async function findCompanyNews(company: string, date: string, windowDays = 2): Promise<CompanyNewsItem[]> {
  const from = shiftDate(date, -Math.max(1, windowDays));
  const to = shiftDate(date, Math.max(1, windowDays) + 1);
  return searchNews(`"${company}"`, from, to, 8);
}

/** Google News RSS headline search bounded to a date range (inclusive of `from`, exclusive of `to`). */
export async function searchNews(query: string, from: string, to: string, limit = 12): Promise<CompanyNewsItem[]> {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", `${query} after:${from} before:${to}`);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`Google News RSS HTTP ${response.status}`);
    const xml = await response.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, Math.max(1, limit)).flatMap((match) => {
      const item = match[1];
      const rawTitle = tag(item, "title");
      const link = tag(item, "link");
      const publishedAt = tag(item, "pubDate");
      const source = tag(item, "source") || rawTitle.split(" - ").at(-1) || "Google News";
      const title = rawTitle.endsWith(` - ${source}`) ? rawTitle.slice(0, -(source.length + 3)).trim() : rawTitle;
      return title && link ? [{ title, source, url: link, publishedAt: publishedAt ? new Date(publishedAt).toISOString() : `${from}T00:00:00.000Z` }] : [];
    });
  } finally {
    clearTimeout(timeout);
  }
}
