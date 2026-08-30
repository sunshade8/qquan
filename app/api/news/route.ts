type NewsTopic = "macro" | "fed" | "inflation" | "labor" | "markets";

const topicQueries: Record<NewsTopic, string> = {
  macro: '("Federal Reserve" OR inflation OR employment OR GDP OR recession OR "economic growth" OR "bond yields" OR "stock market")',
  fed: '("Federal Reserve" OR FOMC OR "interest rates" OR Powell OR "rate cut" OR "rate hike")',
  inflation: '(inflation OR CPI OR PCE OR PPI OR prices OR tariffs)',
  labor: '(employment OR jobs OR payrolls OR unemployment OR wages OR JOLTS)',
  markets: '("stock market" OR S&P OR Nasdaq OR "bond yields" OR Treasury OR dollar)',
};

const topicKeywords: Array<[NewsTopic, RegExp]> = [
  ["fed", /\bfed(?:eral reserve)?\b|\bfomc\b|powell|interest rate|rate cut|rate hike/i],
  ["inflation", /inflation|\bcpi\b|\bpce\b|\bppi\b|consumer prices?|tariffs?/i],
  ["labor", /employment|jobs?|payrolls?|unemployment|wages?|\bjolts\b/i],
  ["markets", /stock market|s&p|nasdaq|bond yields?|treasur(?:y|ies)|\bdollar\b/i],
];

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function decodeXml(value: string) {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .trim();
}

function tag(item: string, name: string) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function classify(title: string): NewsTopic {
  return topicKeywords.find(([, pattern]) => pattern.test(title))?.[0] ?? "macro";
}

function shortId(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `n_${(hash >>> 0).toString(36)}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const end = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const lookback = Math.min(7, Math.max(1, Number(url.searchParams.get("lookback") ?? 1)));
  const requestedTopic = url.searchParams.get("topic") as NewsTopic | null;
  const topic = requestedTopic && requestedTopic in topicQueries ? requestedTopic : "macro";
  if (!validDate(end)) return Response.json({ error: "날짜 형식이 올바르지 않습니다." }, { status: 400 });

  const start = shiftDate(end, -(lookback - 1));
  const query = `${topicQueries[topic]} after:${shiftDate(start, -1)} before:${shiftDate(end, 1)}`;
  const feedUrl = new URL("https://news.google.com/rss/search");
  feedUrl.searchParams.set("q", query);
  feedUrl.searchParams.set("hl", "en-US");
  feedUrl.searchParams.set("gl", "US");
  feedUrl.searchParams.set("ceid", "US:en");

  const response = await fetch(feedUrl, { headers: { "user-agent": "QQuant personal research feed/1.0" } });
  if (!response.ok) return Response.json({ error: "뉴스 피드를 가져오지 못했습니다." }, { status: 502 });
  const xml = await response.text();
  const rawItems = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  const seen = new Set<string>();
  const articles = rawItems.flatMap((item) => {
    const sourceMatch = item.match(/<source(?:\s+url="([^"]*)")?>([\s\S]*?)<\/source>/i);
    const source = sourceMatch ? decodeXml(sourceMatch[2]) : "Unknown";
    const sourceUrl = sourceMatch?.[1] ? decodeXml(sourceMatch[1]) : "";
    const rawTitle = tag(item, "title");
    const title = rawTitle.endsWith(` - ${source}`) ? rawTitle.slice(0, -(source.length + 3)).trim() : rawTitle;
    const published = new Date(tag(item, "pubDate"));
    const link = tag(item, "link");
    const key = title.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (!title || !link || Number.isNaN(published.getTime()) || seen.has(key)) return [];
    seen.add(key);
    return [{
      id: shortId(tag(item, "guid") || link),
      title,
      source,
      sourceUrl,
      url: link,
      publishedAt: published.toISOString(),
      topic: classify(title),
    }];
  }).filter((article) => {
    const kstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(article.publishedAt));
    return kstDate >= start && kstDate <= end;
  }).slice(0, 75);

  return Response.json(
    { provider: "Google News RSS", topic, start, end, articles },
    { headers: { "cache-control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600" } },
  );
}
