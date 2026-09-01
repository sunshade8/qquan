import { MARKET_CALENDAR_2026 } from "../../market-calendar-data";

type NewsTopic = "macro" | "forecast" | "fed" | "inflation" | "labor" | "markets";

type TrustedSource = {
  id: string;
  name: string;
  domains: string[];
  queryDomain: string;
};

type Article = {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  sourceUrl: string;
  url: string;
  publishedAt: string;
  topic: NewsTopic;
  eventId?: string;
  eventTitle?: string;
  eventDate?: string;
  eventTimeET?: string;
  stage?: "pre_release_forecast";
};

type AttemptStatus = "ok" | "empty" | "error";

type Attempt = {
  sourceId: string;
  provider: string;
  strategy: string;
  status: AttemptStatus;
  error: string | null;
  items: number;
  kept: number;
  articles: Article[];
};

const topicQueries: Record<NewsTopic, string> = {
  macro: '("Federal Reserve" OR inflation OR employment OR GDP OR recession OR "economic growth" OR "bond yields" OR "stock market")',
  forecast: '(US OR "U.S." OR "United States" OR "Federal Reserve" OR Fed) (CPI OR PCE OR PPI OR payrolls OR "jobs report" OR unemployment OR GDP OR ISM OR PMI OR FOMC OR "retail sales") (forecast OR consensus OR expected OR expectations OR economists OR estimate OR preview OR "what to expect" OR "ahead of")',
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
  forecast: /^(?=.*(?:\bcpi\b|consumer prices?|\bpce\b|personal consumption expenditures?|\bppi\b|producer prices?|nonfarm payrolls?|\bnfp\b|jobs? report|unemployment|\bgdp\b|\bism\b|\bpmi\b|fomc|fed (?:decision|meeting)|retail sales))(?=.*(?:forecast|consensus|expect(?:ed|ation|ations)?|economists? (?:see|expect|predict|estimate)|estimated?|preview|what to expect|ahead of|likely|seen(?: at)?|projected?)).*$/i,
  fed: /\bfed(?:eral reserve)?\b|\bfomc\b|\bpowell\b|interest rates?|rate cuts?|rate hikes?|central bank/i,
  inflation: /inflation|\bcpi\b|\bpce\b|\bppi\b|consumer prices?|price pressures?|tariffs?/i,
  labor: /employment|payrolls?|unemployment|labor market|jobs? (?:report|data|growth|market|numbers|openings|cuts)|jobless claims?|hiring|layoffs?|wages? (?:growth|pressure|data|rise|rises|fall|falls|increase|increases|decline|declines)/i,
  markets: /stock markets?|wall street|s&p|nasdaq|dow jones|bond yields?|treasur(?:y|ies)|\bdollar\b|equities|shares|oil prices?|gold prices?|market rally|market selloff/i,
  macro: /\bfed(?:eral reserve)?\b|\bfomc\b|\bpowell\b|interest rates?|rate cuts?|rate hikes?|central bank|inflation|\bcpi\b|\bpce\b|\bppi\b|consumer prices?|tariffs?|employment|payrolls?|unemployment|labor market|jobs? (?:report|data|growth|market|numbers|openings|cuts)|jobless claims?|hiring|layoffs?|wages? (?:growth|pressure|data|rise|rises|fall|falls|increase|increases|decline|declines)|stock markets?|wall street|s&p|nasdaq|bond yields?|treasur(?:y|ies)|\bdollar\b|equities|\bgdp\b|recession|economic growth|\beconom(?:y|ic)\b/i,
};

const topicKeywords: Array<[NewsTopic, RegExp]> = [
  ["forecast", topicTitlePatterns.forecast],
  ["fed", topicTitlePatterns.fed],
  ["inflation", topicTitlePatterns.inflation],
  ["labor", topicTitlePatterns.labor],
  ["markets", topicTitlePatterns.markets],
];

const forecastSearches = [
  "US inflation forecast",
  "US jobs report forecast",
  "US economic data preview",
  "FOMC preview",
] as const;

const googleSourceNames: Record<string, string> = {
  reuters: "Reuters",
  ap: "Associated Press",
  bloomberg: "Bloomberg",
  ft: "Financial Times",
  wsj: "The Wall Street Journal",
  cnbc: "CNBC",
  bbc: "BBC",
  nyt: "The New York Times",
  washpost: "The Washington Post",
  guardian: "The Guardian",
};

const noisyHeadlinePattern = /\bjob with\b|company announcement|newsletter(?: signup)?|print edition|trending news, latest updates, analysis|sector & industry performance|^(?:interviews|economics?|business|shows|style(?:\s*-\s*page \d+)?|united states|ap|minute by minute|bonds headlines|opinion \+ politics|us news \+ business|business \+ economics|economics \+ business)$/i;
const releasedResultPattern = /(?:meets?|met|beat|beats|missed?|above|below|tops?|topped|rose|fell|increased|decreased).{0,48}(?:expectations?|forecast|consensus)|(?:expectations?|forecast|consensus).{0,48}(?:met|beat|missed?|above|below|topped)/i;

// Google and Bing answer datacenter egress differently when no browser-shaped
// headers are present: an empty channel instead of results. Sending a real
// user agent keeps the deployed Worker on the same code path as local dev.
const feedHeaders = {
  accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const feedTimeoutMs = 8_000;

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

function forecastEventRoot(title: string) {
  if (/\bcpi\b|consumer prices?/i.test(title)) return "cpi";
  if (/\bpce\b|personal consumption expenditures?/i.test(title)) return "pce";
  if (/\bppi\b|producer prices?/i.test(title)) return "ppi";
  if (/\bjolts\b|job openings?/i.test(title)) return "jolts";
  if (/\badp\b/i.test(title)) return "adp";
  if (/nonfarm payrolls?|\bnfp\b|jobs? report|payrolls?|unemployment/i.test(title)) return "nfp";
  if (/ism.*services|services.*(?:ism|pmi)/i.test(title)) return "ism-services";
  if (/\bism\b|manufacturing.*pmi|pmi.*manufacturing/i.test(title)) return "ism-manufacturing";
  if (/\bgdp\b/i.test(title)) return "gdp";
  if (/fomc|fed (?:decision|meeting)/i.test(title)) return "fomc";
  return null;
}

function forecastMetadata(title: string, publishedAt: string) {
  const root = forecastEventRoot(title);
  if (!root) return {};
  const publishedDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(publishedAt));
  const latest = shiftDate(publishedDate, 14);
  const event = MARKET_CALENDAR_2026.find((item) => item.id.startsWith(`${root}-`) && item.date >= publishedDate && item.date <= latest);
  return event ? { eventId: root, eventTitle: event.title, eventDate: event.date, eventTimeET: event.time, stage: "pre_release_forecast" as const } : { eventId: root, stage: "pre_release_forecast" as const };
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

async function fetchFeed(feedUrl: URL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), feedTimeoutMs);
  try {
    const response = await fetch(feedUrl, { headers: feedHeaders, signal: controller.signal });
    if (!response.ok) return { xml: "", error: `HTTP ${response.status}` };
    return { xml: await response.text(), error: null as string | null };
  } catch (error) {
    return { xml: "", error: error instanceof Error ? `${error.name}: ${error.message}` : "Unknown fetch error" };
  } finally {
    clearTimeout(timeout);
  }
}

function keepArticle(title: string, topic: NewsTopic, publishedDate: string, start: string, end: string) {
  if (!title) return false;
  if (noisyHeadlinePattern.test(title)) return false;
  if (!topicTitlePatterns[topic].test(title)) return false;
  if (topic === "forecast" && !/(?:\bU\.S\.\b|\bUS\b|United States|American?|Federal Reserve|\bFed\b|FOMC|nonfarm|\bNFP\b|jobs? report|payrolls?)/i.test(title)) return false;
  if (topic === "forecast" && releasedResultPattern.test(title)) return false;
  return publishedDate >= start && publishedDate <= end;
}

function googleFeedUrl(query: string) {
  const feedUrl = new URL("https://news.google.com/rss/search");
  feedUrl.searchParams.set("q", query);
  feedUrl.searchParams.set("hl", "en-US");
  feedUrl.searchParams.set("gl", "US");
  feedUrl.searchParams.set("ceid", "US:en");
  return feedUrl;
}

async function fetchGoogle(source: TrustedSource, topic: NewsTopic, start: string, end: string, strategy: string, query: string): Promise<Attempt> {
  const base = { sourceId: source.id, provider: "Google News RSS", strategy };
  const { xml, error } = await fetchFeed(googleFeedUrl(query));
  if (error) {
    console.error("[news/retrieve] google failed", { source: source.id, strategy, error });
    return { ...base, status: "error", error, items: 0, kept: 0, articles: [] };
  }

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const articles = items.flatMap((match): Article[] => {
    const item = match[1];
    const sourceMatch = item.match(/<source(?:\s+url="([^"]*)")?>([\s\S]*?)<\/source>/i);
    const sourceUrl = sourceMatch?.[1] ? decodeXml(sourceMatch[1]) : "";
    if (!sourceMatches(sourceUrl, source)) return [];

    const rawTitle = tag(item, "title");
    const feedSourceName = sourceMatch ? decodeXml(sourceMatch[2]) : source.name;
    const title = rawTitle.endsWith(` - ${feedSourceName}`) ? rawTitle.slice(0, -(feedSourceName.length + 3)).trim() : rawTitle;
    const published = new Date(tag(item, "pubDate"));
    const link = tag(item, "link");
    if (!link || Number.isNaN(published.getTime())) return [];
    if (!keepArticle(title, topic, koreaDate(published), start, end)) return [];

    return [{
      id: shortId(tag(item, "guid") || link),
      title,
      source: source.name,
      sourceId: source.id,
      sourceUrl,
      url: link,
      publishedAt: published.toISOString(),
      topic: classify(title),
      ...(topic === "forecast" ? forecastMetadata(title, published.toISOString()) : {}),
    }];
  });

  return { ...base, status: articles.length ? "ok" : "empty", error: null, items: items.length, kept: articles.length, articles };
}

function bingTargetUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname.endsWith("bing.com") ? url.searchParams.get("url") ?? value : value;
  } catch {
    return value;
  }
}

async function fetchBing(source: TrustedSource, topic: NewsTopic, start: string, end: string): Promise<Attempt> {
  const base = { sourceId: source.id, provider: "Bing News RSS", strategy: "bing" };
  const feedUrl = new URL("https://www.bing.com/news/search");
  feedUrl.searchParams.set("q", `${topicQueries[topic]} site:${source.queryDomain}`);
  feedUrl.searchParams.set("format", "rss");
  feedUrl.searchParams.set("setlang", "en-US");
  feedUrl.searchParams.set("cc", "US");

  const { xml, error } = await fetchFeed(feedUrl);
  if (error) {
    console.error("[news/retrieve] bing failed", { source: source.id, error });
    return { ...base, status: "error", error, items: 0, kept: 0, articles: [] };
  }

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const articles = items.flatMap((match): Article[] => {
    const item = match[1];
    const title = tag(item, "title");
    const url = bingTargetUrl(tag(item, "link"));
    const published = new Date(tag(item, "pubDate"));
    if (!url || !sourceMatches(url, source) || Number.isNaN(published.getTime())) return [];
    if (!keepArticle(title, topic, koreaDate(published), start, end)) return [];
    return [{
      id: shortId(url),
      title,
      source: source.name,
      sourceId: source.id,
      sourceUrl: new URL(url).origin,
      url,
      publishedAt: published.toISOString(),
      topic: classify(title),
      ...(topic === "forecast" ? forecastMetadata(title, published.toISOString()) : {}),
    }];
  });

  return { ...base, status: articles.length ? "ok" : "empty", error: null, items: items.length, kept: articles.length, articles };
}

// Google honours `after:`/`before:` inconsistently depending on which serving
// region answers the request, so an empty range query is not evidence that no
// news exists. Each source walks the chain until one strategy returns rows.
function strategiesFor(source: TrustedSource, topic: NewsTopic, start: string, end: string) {
  const ranged = `${topicQueries[topic]} site:${source.queryDomain} after:${shiftDate(start, -1)} before:${shiftDate(end, 1)}`;
  const today = koreaDate(new Date());
  const windowDays = daysBetween(start, today) + 1;
  const recent = windowDays > 0 && windowDays <= 60 && end >= shiftDate(today, -2);

  const chain: Array<() => Promise<Attempt>> = [
    () => fetchGoogle(source, topic, start, end, "google-range", ranged),
  ];
  if (recent) {
    chain.push(() => fetchGoogle(source, topic, start, end, "google-when", `${topicQueries[topic]} site:${source.queryDomain} when:${windowDays}d`));
  }
  chain.push(() => fetchGoogle(source, topic, start, end, "google-plain", `${topicQueries[topic]} site:${source.queryDomain}`));
  chain.push(() => fetchBing(source, topic, start, end));
  return chain;
}

async function collectSource(source: TrustedSource, topic: NewsTopic, start: string, end: string) {
  if (topic === "forecast") return collectForecastSource(source, start, end);
  const attempts: Attempt[] = [];
  for (const run of strategiesFor(source, topic, start, end)) {
    const attempt = await run();
    attempts.push(attempt);
    if (attempt.status === "ok") break;
  }
  const winner = attempts.find((attempt) => attempt.status === "ok");
  const reachable = attempts.some((attempt) => attempt.status !== "error");
  return { source, attempts, winner, status: reachable ? ("ok" as const) : ("error" as const) };
}

async function collectForecastSource(source: TrustedSource, start: string, end: string) {
  const attempts: Attempt[] = [];
  const sourceName = googleSourceNames[source.id] ?? source.name;
  const suffix = `source:${JSON.stringify(sourceName)}`;
  const today = koreaDate(new Date());
  const windowDays = daysBetween(start, today) + 1;
  const recent = windowDays > 0 && windowDays <= 60 && end >= shiftDate(today, -2);

  const runGoogleRound = async (strategy: string, dateClause: string) => {
    const round = await Promise.all(forecastSearches.map((query) =>
      fetchGoogle(source, "forecast", start, end, `${strategy}:${query}`, `${query} ${suffix} ${dateClause}`.trim())));
    attempts.push(...round);
    return round.flatMap((attempt) => attempt.articles);
  };

  let articles = await runGoogleRound("google-range", `after:${shiftDate(start, -1)} before:${shiftDate(end, 1)}`);
  if (!articles.length && recent) articles = await runGoogleRound("google-when", `when:${windowDays}d`);
  if (!articles.length) articles = await runGoogleRound("google-plain", "");
  if (!articles.length) {
    const bing = await fetchBing(source, "forecast", start, end);
    attempts.push(bing);
    articles = bing.articles;
  }

  const reachable = attempts.some((attempt) => attempt.status !== "error");
  const winningAttempt = attempts.find((attempt) => attempt.status === "ok");
  const winner = winningAttempt ? { ...winningAttempt, kept: articles.length, articles } : undefined;
  return { source, attempts, winner, status: reachable ? ("ok" as const) : ("error" as const) };
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
  const debug = url.searchParams.get("debug") === "1";

  if (!validDate(start) || !validDate(end)) return Response.json({ error: "날짜 형식이 올바르지 않습니다." }, { status: 400 });
  const rangeDays = daysBetween(start, end);
  if (rangeDays < 0) return Response.json({ error: "시작일은 종료일보다 늦을 수 없습니다." }, { status: 400 });
  if (rangeDays > 30) return Response.json({ error: "뉴스 수집 기간은 최대 31일까지 선택할 수 있습니다." }, { status: 400 });

  const collected = await Promise.all(trustedSources.map((source) => collectSource(source, topic, start, end)));

  const balancedArticles = collected.flatMap((result) => (result.winner?.articles ?? [])
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
  const sources = collected.map((result) => ({
    id: result.source.id,
    name: result.source.name,
    count: sourceCounts.get(result.source.id) ?? 0,
    status: result.status,
  }));

  const allAttempts = collected.flatMap((result) => result.attempts);
  const retrievalErrors = allAttempts
    .filter((attempt) => attempt.status === "error")
    .map((attempt) => ({ provider: attempt.provider, strategy: attempt.strategy, sources: [attempt.sourceId], error: attempt.error }));
  const providers = [...new Set(collected.flatMap((result) => (result.winner ? [result.winner.provider] : [])))];

  console.log("[news/retrieve] summary", {
    topic,
    start,
    end,
    articles: articles.length,
    strategies: allAttempts.reduce<Record<string, number>>((totals, attempt) => {
      const key = `${attempt.strategy}:${attempt.status}`;
      totals[key] = (totals[key] ?? 0) + 1;
      return totals;
    }, {}),
  });

  const diagnostics = debug
    ? allAttempts.map(({ sourceId, provider, strategy, status, error, items, kept }) => ({ sourceId, provider, strategy, status, error, items, kept }))
    : undefined;

  if (collected.every((result) => result.status === "error")) {
    return Response.json(
      { error: "뉴스 공급자 연결이 모두 실패했습니다. 잠시 후 다시 시도해 주세요.", provider: "Google News RSS + Bing News RSS", topic, start, end, sources, articles: [], retrievalErrors, diagnostics },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  const notice = articles.length
    ? null
    : retrievalErrors.length
      ? "뉴스 공급자 응답이 불안정합니다. 잠시 후 다시 시도해 주세요."
      : "선택한 범위에서 신뢰 매체의 해당 주제 기사를 찾지 못했습니다. 기간을 넓히거나 다른 주제를 선택해 보세요.";

  return Response.json(
    { provider: providers.join(" + ") || "Google News RSS", topic, start, end, sources, articles, retrievalErrors, notice, diagnostics },
    { headers: { "cache-control": "no-store" } },
  );
}
