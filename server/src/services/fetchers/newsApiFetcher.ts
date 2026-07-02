// Dead code — kept for reference but not callable (depends on removed sources table)
// import { getActiveSourceMetadata, type RawArticle, type SourceRow } from './rssFetcher.js';

interface RawArticle {
  title: string;
  url: string;
  body: string;
  publishedAt: Date;
  sourceId: number;
}

interface SourceRow {
  id: number;
  name: string;
  base_url: string | null;
  feed_url: string;
  is_active: boolean;
  priority: number;
}

async function getActiveSourceMetadata(): Promise<Map<number, SourceRow>> {
  throw new Error('newsApiFetcher is dead code — sources table removed');
}

interface NewsApiArticle {
  source?: {
    id?: string | null;
    name?: string | null;
  };
  title?: string | null;
  description?: string | null;
  url?: string | null;
  publishedAt?: string | null;
  content?: string | null;
}

interface NewsApiResponse {
  status: 'ok' | 'error';
  totalResults?: number;
  articles?: NewsApiArticle[];
  code?: string;
  message?: string;
}

function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = value.startsWith('http://') || value.startsWith('https://')
      ? new URL(value)
      : new URL(`https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function buildSourceMatchers(sources: Map<number, SourceRow>) {
  const byDomain = new Map<string, SourceRow>();
  const byName = new Map<string, SourceRow>();

  for (const source of sources.values()) {
    const domains = [
      normalizeHostname(source.base_url),
      normalizeHostname(source.feed_url),
    ].filter((value): value is string => Boolean(value));

    for (const domain of domains) {
      if (!byDomain.has(domain)) {
        byDomain.set(domain, source);
      }
    }

    byName.set(source.name.trim().toLowerCase(), source);
  }

  return { byDomain, byName };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function previousDayRanges(lookbackDays: number): Array<{ from: string; to: string; label: string }> {
  const ranges: Array<{ from: string; to: string; label: string }> = [];
  const today = new Date();
  const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  for (let daysAgo = lookbackDays; daysAgo >= 1; daysAgo -= 1) {
    const start = new Date(todayStart);
    start.setUTCDate(start.getUTCDate() - daysAgo);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    ranges.push({
      from: start.toISOString(),
      to: end.toISOString(),
      label: start.toISOString().slice(0, 10),
    });
  }

  return ranges;
}

function toRawArticle(article: NewsApiArticle, sourceId: number): RawArticle | null {
  if (!article.url || !article.title || !article.publishedAt) return null;

  const publishedAt = new Date(article.publishedAt);
  if (Number.isNaN(publishedAt.getTime())) return null;

  const parts = [article.description?.trim(), article.content?.trim()].filter((value): value is string => Boolean(value));
  return {
    title: article.title.slice(0, 500),
    url: article.url.slice(0, 1000),
    body: parts.join(' ').slice(0, 5000),
    publishedAt,
    sourceId,
  };
}

async function fetchEverythingPage(
  apiKey: string,
  domains: string[],
  from: string,
  to: string,
  page: number,
): Promise<NewsApiResponse> {
  const params = new URLSearchParams({
    domains: domains.join(','),
    from,
    to,
    language: 'en',
    sortBy: 'publishedAt',
    pageSize: '100',
    page: String(page),
  });

  const response = await fetch(`https://newsapi.org/v2/everything?${params.toString()}`, {
    headers: {
      'X-Api-Key': apiKey,
    },
  });

  const data = await response.json() as NewsApiResponse;
  if (!response.ok || data.status !== 'ok') {
    throw new Error(data.message || `NewsAPI request failed with status ${response.status}`);
  }

  return data;
}

export async function fetchHistoricalArticlesFromNewsApi(options?: { lookbackDays?: number; maxPagesPerBatch?: number }) {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) {
    throw new Error('NEWSAPI_KEY is required to backfill historical articles');
  }

  const lookbackDays = Math.max(1, options?.lookbackDays ?? 14);
  const maxPagesPerBatch = Math.max(1, options?.maxPagesPerBatch ?? 1);
  const sources = await getActiveSourceMetadata();
  const eligibleSources = [...sources.values()].filter(source => source.is_active && source.priority > 0);
  const { byDomain, byName } = buildSourceMatchers(new Map(eligibleSources.map(source => [source.id, source])));
  const domains = [...new Set([...byDomain.keys()])];
  const domainBatches = chunk(domains, 5);
  const dateRanges = previousDayRanges(lookbackDays);
  const rawArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();
  let skippedUnmapped = 0;
  let saturatedQueries = 0;

  for (const range of dateRanges) {
    for (const domainBatch of domainBatches) {
      for (let page = 1; page <= maxPagesPerBatch; page += 1) {
        const response = await fetchEverythingPage(apiKey, domainBatch, range.from, range.to, page);
        const articles = response.articles ?? [];

        for (const article of articles) {
          if (!article.url || seenUrls.has(article.url)) continue;

          const articleDomain = normalizeHostname(article.url);
          const matchedSource = (articleDomain ? byDomain.get(articleDomain) : null)
            ?? (article.source?.name ? byName.get(article.source.name.trim().toLowerCase()) : null);

          if (!matchedSource) {
            skippedUnmapped += 1;
            continue;
          }

          const mapped = toRawArticle(article, matchedSource.id);
          if (!mapped) continue;

          seenUrls.add(mapped.url);
          rawArticles.push(mapped);
        }

        if (articles.length >= 100) {
          saturatedQueries += 1;
        }

        if (articles.length < 100) break;
      }
    }
  }

  return {
    rawArticles,
    stats: {
      fetchedCount: rawArticles.length,
      skippedUnmapped,
      domainBatchCount: domainBatches.length,
      dayCount: dateRanges.length,
      saturatedQueries,
      maxPagesPerBatch,
    },
  };
}
