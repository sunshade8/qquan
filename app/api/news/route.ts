type NewsTopic = "macro" | "fed" | "inflation" | "labor" | "markets";

type TrustedSource = {
  id: string;
  name: string;
  domains: string[];
  queryDomain: string;
};

const topicQueries: Record<NewsTopic, string> = {
  macro: '("Federal Reserve" OR inflation OR employment OR GDP OR recession OR "economic growth" OR "bond yields" OR "stock market")',
  fed: '("Federal Reserve" OR FOMC OR "interest rates" OR Powell OR "rate cut" OR "rate hike")',
  inflation: '(inflation OR CPI OR PCE OR PPI OR prices OR tariffs)',
  labor: '(employment OR jobs OR payrolls OR unemployment OR wages OR JOLTS)',
  markets: '("stock market" OR S&P OR Nasdaq OR "bond yields" OR Treasury OR dollar)',
};

const trustedSources: TrustedSource[] = [
  { id: "reuters", name: "Reuters", queryDomain: "reuters.com", domains: ["reuters.com"] },
  { id: "ap", name: "AP News", queryDomain: "apnews.com", domains: ["apnews.com"] },
  { id: "bloomberg", name: "Bloomberg", queryDomain: "bloomberg.com", domains: ["bloomberg.com"] },
  { id: "ft", name: "Financial Times", queryDomain: "ft.com", domains: ["ft.com"] },
  { id: "wsj", name: "The Wall Street Journal", queryDomain: "wsj.com", domains: ["wsj.com"] },
  { id: "cnbc", name: "CNBC", queryDomain: "cnbc.com", domains: ["cnbc.com"] },
  { id: "bbc", name: "BBC", queryDomain: "bbc.com", domains: ["bbc.com", "bbc.co.uk"] },
  { id: "nyt", name: "The New York Times", queryDomain: "nytimes.com", domains: ["nytimes.com"] },
  { id: "washpost", name: "The Washington Post", queryDomain: "washingtonpost.com", domains: ["washingtonpost.com"] },
  { id: "guardian", name: "The Guardian", queryDomain: "theguardian.com", domains: ["theguardian.com"] },
];

const topicTitlePatterns: Record<NewsTopic, RegExp> = {
  fed: /\bfed(?:eral reserve)?\b|\bfomc\b|\bpowell\b|interest rates?|rate cuts?|rate hikes?|central bank/i,
  inflation: /inflation|\bcpi\b|\bpce\b|\bppi\b|consumer prices?|price pressures?|tariffs?/i,
  labor: /employment|payrolls?|unemployment|labor market|jobs? (?:report|data|growth|market|numbers|openings|cuts)|jobless claims?|hiring|layoffs?|wages? (?:growth|pressure|data|rise|rises|fall|falls|increase|increases|decline|declines)/i,
  markets: /stock markets?|wall street|s&p|nasdaq|dow jones|bond yields?|treasur(?:y|ies)|\bdollar\b|equities|shares|oil prices?|gold prices?|market rally|market selloff/i,
  macro: /\bfed(?:eral reserve)?\b|\bfomc\b|\bpowell\b|interest rates?|rate cuts?|rate hikes?|central bank|inflation|\bcpi\b|\bpce\b|\bppi\b|consumer prices?|tariffs?|employment|payrolls?|unemployment|labor market|jobs? (?:report|data|growth|market|numbers|openings|cuts)|jobless claims?|hiring|layoffs?|wages? (?:growth|pressure|data|rise|rises|fall|falls|increase|increases|decline|declines)|stock markets?|wall street|s&p|nasdaq|bond yields?|treasur(?:y|ies)|\bdollar\b|equities|\bgdp\b|recession|economic growth|\beconom(?:y|ic)\b/i,
};

const topicKeywords: Array<[NewsTopic, RegExp]> = [
  ["fed", topicTitlePatterns.fed],
  ["inflation", topicTitlePatterns.inflation],
  ["labor", topicTitlePatterns.labor],
  ["markets", topicTitlePatterns.markets],
];

const noisyHeadlinePattern = /\bjob with\b|company announcement|newsletter(?: signup)?|print edition|trending news, latest updates, analysis|sector & industry performance|^(?:interviews|economics?|business|shows|style(?:\s*-\s*page \d+)?|united states|ap|minute by minute|bonds headlines|opinion \+ politics|us news \+ business|business \+ economics|economics \+ business)$/i;

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function daysBetween(start: string, end: string) {
  return Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000);
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

function sourceMatches(sourceUrl: string, source: TrustedSource) {
  try {
    const hostname = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
    return source.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function koreaDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

async function fetchGroup(sources: TrustedSource[], topic: NewsTopic, start: string, end: string) {
  const sourceQuery = sources.map((source) => `site:${source.queryDomain}`).join(" OR ");
  const query = `${topicQueries[topic]} (${sourceQuery}) after:${shiftDate(start, -1)} before:${shiftDate(end, 1)}`;
  const feedUrl = new URL("https://news.google.com/rss/search");
  feedUrl.searchParams.set("q", query);
  feedUrl.searchParams.set("hl", "en-US");
  feedUrl.searchParams.set("gl", "US");
  feedUrl.searchParams.set("ceid", "US:en");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(feedUrl, {
      headers: { accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error("[news/retrieve] Google News RSS failed", { sources: sources.map((source) => source.id), status: response.status });
      return { sourceIds: sources.map((source) => source.id), provider: "Google News RSS", status: "error" as const, error: `HTTP ${response.status}`, articles: [] };
    }
    const xml = await response.text();
    const articles = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap((match) => {
      const item = match[1];
      const sourceMatch = item.match(/<source(?:\s+url="([^"]*)")?>([\s\S]*?)<\/source>/i);
      const sourceUrl = sourceMatch?.[1] ? decodeXml(sourceMatch[1]) : "";
      const source = sources.find((candidate) => sourceMatches(sourceUrl, candidate));
      if (!source) return [];

      const rawTitle = tag(item, "title");
      const feedSourceName = sourceMatch ? decodeXml(sourceMatch[2]) : source.name;
      const title = rawTitle.endsWith(` - ${feedSourceName}`) ? rawTitle.slice(0, -(feedSourceName.length + 3)).trim() : rawTitle;
      if (noisyHeadlinePattern.test(title) || !topicTitlePatterns[topic].test(title)) return [];
      const published = new Date(tag(item, "pubDate"));
      const link = tag(item, "link");
      if (!title || !link || Number.isNaN(published.getTime())) return [];
      const publishedDate = koreaDate(published);
      if (publishedDate < start || publishedDate > end) return [];

      return [{
        id: shortId(tag(item, "guid") || link),
        title,
        source: source.name,
        sourceId: source.id,
        sourceUrl,
        url: link,
        publishedAt: published.toISOString(),
        topic: classify(title),
      }];
    });
    return {
      sourceIds: sources.map((source) => source.id),
      provider: "Google News RSS",
      status: "ok" as const,
      error: null,
      articles,
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown fetch error";
    console.error("[news/retrieve] Google News RSS threw", { sources: sources.map((source) => source.id), error: message });
    return { sourceIds: sources.map((source) => source.id), provider: "Google News RSS", status: "error" as const, error: message, articles: [] };
  } finally {
    clearTimeout(timeout);
  }
}

function bingTargetUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname.endsWith("bing.com") ? url.searchParams.get("url") ?? value : value;
  } catch {
    return value;
  }
}

async function fetchBingSource(source: TrustedSource, topic: NewsTopic, start: string, end: string) {
  const feedUrl = new URL("https://www.bing.com/news/search");
  feedUrl.searchParams.set("q", `${topicQueries[topic]} site:${source.queryDomain}`);
  feedUrl.searchParams.set("format", "rss");
  feedUrl.searchParams.set("setlang", "en-US");
  feedUrl.searchParams.set("cc", "US");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(feedUrl, { headers: { accept: "application/rss+xml, application/xml;q=0.9" }, signal: controller.signal });
    if (!response.ok) return { sourceIds: [source.id], provider: "Bing News RSS", status: "error" as const, error: `HTTP ${response.status}`, articles: [] };
    const xml = await response.text();
    const articles = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap((match) => {
      const item = match[1];
      const title = tag(item, "title");
      const url = bingTargetUrl(tag(item, "link"));
      const published = new Date(tag(item, "pubDate"));
      if (!title || !url || !sourceMatches(url, source) || Number.isNaN(published.getTime())) return [];
      const publishedDate = koreaDate(published);
      if (publishedDate < start || publishedDate > end || noisyHeadlinePattern.test(title) || !topicTitlePatterns[topic].test(title)) return [];
      return [{ id: shortId(url), title, source: source.name, sourceId: source.id, sourceUrl: new URL(url).origin, url, publishedAt: published.toISOString(), topic: classify(title) }];
    });
    return { sourceIds: [source.id], provider: "Bing News RSS", status: "ok" as const, error: null, articles };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown fetch error";
    console.error("[news/retrieve] Bing News RSS threw", { source: source.id, error: message });
    return { sourceIds: [source.id], provider: "Bing News RSS", status: "error" as const, error: message, articles: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const legacyEnd = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const parsedLookback = Number(url.searchParams.get("lookback") ?? 1);
  const legacyLookback = Number.isFinite(parsedLookback) ? Math.min(31, Math.max(1, parsedLookback)) : 1;
  const start = url.searchParams.get("start") ?? shiftDate(legacyEnd, -(legacyLookback - 1));
  const end = url.searchParams.get("end") ?? legacyEnd;
  const requestedTopic = url.searchParams.get("topic") as NewsTopic | null;
  const topic = requestedTopic && requestedTopic in topicQueries ? requestedTopic : "macro";

  if (!validDate(start) || !validDate(end)) return Response.json({ error: "날짜 형식이 올바르지 않습니다." }, { status: 400 });
  const rangeDays = daysBetween(start, end);
  if (rangeDays < 0) return Response.json({ error: "시작일은 종료일보다 늦을 수 없습니다." }, { status: 400 });
  if (rangeDays > 30) return Response.json({ error: "뉴스 수집 기간은 최대 31일까지 선택할 수 있습니다." }, { status: 400 });

  const googleResults = await Promise.all(trustedSources.map((source) => fetchGroup([source], topic, start, end)));
  const failedSources = trustedSources.filter((source) => googleResults.find((result) => result.sourceIds[0] === source.id)?.status === "error");
  const bingResults = await Promise.all(failedSources.map((source) => fetchBingSource(source, topic, start, end)));
  const results = trustedSources.map((source) => {
    const google = googleResults.find((result) => result.sourceIds[0] === source.id)!;
    return google.status === "ok" ? google : bingResults.find((result) => result.sourceIds[0] === source.id) ?? google;
  });
  const balancedArticles = trustedSources.flatMap((source) => results
    .flatMap((result) => result.articles)
    .filter((article) => article.sourceId === source.id)
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .slice(0, 10));
  const seen = new Set<string>();
  const articles = balancedArticles
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
    .filter((article) => {
      const key = article.title.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);

  const sourceCounts = new Map<string, number>();
  for (const article of articles) sourceCounts.set(article.sourceId, (sourceCounts.get(article.sourceId) ?? 0) + 1);
  const sources = trustedSources.map((source) => {
    const result = results.find((candidate) => candidate.sourceIds.includes(source.id));
    return { id: source.id, name: source.name, count: sourceCounts.get(source.id) ?? 0, status: result?.status ?? "error" };
  });
  const retrievalErrors = [...googleResults, ...bingResults].filter((result) => result.status === "error").map((result) => ({ provider: result.provider, sources: result.sourceIds, error: result.error }));
  const providers = [...new Set(results.filter((result) => result.status === "ok").map((result) => result.provider))];

  if (results.every((result) => result.status === "error")) {
    return Response.json(
      { error: "뉴스 공급자 연결이 모두 실패했습니다. 잠시 후 다시 시도해 주세요.", provider: "Google News RSS + Bing News RSS", topic, start, end, sources, articles: [], retrievalErrors },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    { provider: providers.join(" + ") || "Google News RSS", topic, start, end, sources, articles, retrievalErrors },
    { headers: { "cache-control": "no-store" } },
  );
}
