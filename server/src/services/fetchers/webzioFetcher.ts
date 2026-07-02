/**
 * webzioFetcher.ts — Webz.io Lite fetcher + normalizer
 *
 * Fetches articles from the Webz.io News API Lite endpoint using 18
 * validated queries (10 India, 8 global). Returns NormalizedArticle[]
 * ready for the structural filter pipeline (F1–F7).
 *
 * Key constraints:
 *   - 100-char query limit (hard, verified)
 *   - 10 results per call max
 *   - ~1,000 calls/month budget → ~30 calls/day
 *   - No sorting on Lite tier — results by relevancy only
 *   - `ts` GET param (zero char cost) for crawl-time recency
 *   - `site_category` non-functional on Lite — use alternatives
 *   - `trust.top_news:top_news_in` works for India; global variant leaks non-English
 *
 * Normalization rules (from §4.2):
 *   - Map sentiment: positive→0.5, negative→-0.5, neutral→0
 *   - Flatten entities to [{name, type, sentiment}]
 *   - Extract domain from thread.site
 *   - Compute dedup hashes (titleHash, normalizedUrlHash, domainTitleHash)
 */

import type { NormalizedArticle } from '../../types/index.js';
import { computeTitleHash, computeNormalizedUrlHash, computeDomainTitleHash } from '../titleNormalizer.js';

// ── Query Definitions ──
// All 18 queries validated against live API (2026-06-29).
// Char counts confirmed ≤ 100. No `sort`/`order` (not supported on Lite).

interface QueryDef {
  q: string;         // The `q` param value (≤ 100 chars)
  calls: number;     // Max pagination depth (next-url pages to follow)
  region: 'india' | 'global';
  label: string;    // Human-readable for logging
}

const QUERIES: QueryDef[] = [
  // ── India (17 calls) ──
  {
    q: 'site_type:news language:english thread.country:IN trust.top_news:top_news_in -category:Sport',
    calls: 3,
    region: 'india',
    label: 'India Top News',
  },
  {
    q: 'site_type:news language:english thread.country:IN trust.category:trusted_news',
    calls: 2,
    region: 'india',
    label: 'India Trusted',
  },
  {
    q: 'site_type:news language:english thread.country:IN category:Politics -category:Sport',
    calls: 2,
    region: 'india',
    label: 'India Politics',
  },
  {
    q: 'site_type:news language:english thread.country:IN category:"Economy, Business and Finance"',
    calls: 2,
    region: 'india',
    label: 'India Economy',
  },
  {
    q: 'site_type:news language:english thread.country:IN (category:Health OR category:Environment)',
    calls: 2,
    region: 'india',
    label: 'India Health+Env',
  },
  {
    q: 'site_type:news language:english thread.country:IN category:"Science and Technology"',
    calls: 1,
    region: 'india',
    label: 'India Science+Tech',
  },
  {
    q: 'site_type:news language:english thread.country:IN (topic:corruption OR topic:fraud)',
    calls: 1,
    region: 'india',
    label: 'India Accountability',
  },
  {
    q: 'site_type:news language:english thread.country:IN topic:employment',
    calls: 1,
    region: 'india',
    label: 'India Employment',
  },
  {
    q: 'site_type:news language:english thread.country:IN topic:"government policy"',
    calls: 2,
    region: 'india',
    label: 'India Govt Policy',
  },
  {
    q: 'site_type:news language:english thread.country:IN category:"War, Conflict and Unrest"',
    calls: 1,
    region: 'india',
    label: 'India Conflict',
  },

  // ── Global (13 calls) ──
  {
    q: 'site_type:news language:english domain_rank:<1000 -category:Sport -category:Weather',
    calls: 3,
    region: 'global',
    label: 'Global Top News',
  },
  {
    q: 'site_type:news language:english trust.category:trusted_news domain_rank:<5000',
    calls: 2,
    region: 'global',
    label: 'Global Trusted+Rank',
  },
  {
    q: 'site_type:news language:english category:Politics domain_rank:<5000',
    calls: 2,
    region: 'global',
    label: 'Global Politics',
  },
  {
    q: 'site_type:news language:english category:"Economy, Business and Finance" domain_rank:<5000',
    calls: 2,
    region: 'global',
    label: 'Global Economy',
  },
  {
    q: 'site_type:news language:english (category:Health OR category:Environment) domain_rank:<5000',
    calls: 1,
    region: 'global',
    label: 'Global Health+Env',
  },
  {
    q: 'site_type:news language:english category:"Science and Technology" domain_rank:<5000',
    calls: 1,
    region: 'global',
    label: 'Global Science+Tech',
  },
  {
    q: 'site_type:news language:english (topic:corruption OR topic:fraud) domain_rank:<5000',
    calls: 1,
    region: 'global',
    label: 'Global Accountability',
  },
  {
    q: 'site_type:news language:english category:"War, Conflict and Unrest" domain_rank:<5000',
    calls: 1,
    region: 'global',
    label: 'Global Conflict',
  },
];

const ENDPOINT = 'https://api.webz.io/newsApiLite';
const CALLS_PER_MONTH = 1000;

// ── Rate Limiting ──

const MIN_REQUEST_INTERVAL_MS = 1200; // ~1 req/sec with margin

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<Response> {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
  }
  lastRequestTime = Date.now();
  return fetch(url, { signal: AbortSignal.timeout(20000) });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Normalizer ──

function mapSentiment(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s === 'positive') return 0.5;
  if (s === 'negative') return -0.5;
  if (s === 'neutral') return 0;
  return null;
}

function flattenEntities(raw: unknown): Array<{ name: string; type: string; sentiment: number | null }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map(e => ({
      name: String(e.name ?? ''),
      type: String(e.type ?? ''),
      sentiment: mapSentiment(e.sentiment as string | undefined),
    }))
    .filter(e => e.name.length > 0);
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalize(raw: Record<string, unknown>): NormalizedArticle | null {
  const thread = (raw.thread ?? {}) as Record<string, unknown>;
  const url = (raw.url as string) ?? (thread.site_full as string) ?? '';
  const title = (raw.title as string) ?? '';
  if (!url || !title) return null;

  const domain = (thread.site as string) ?? extractDomain(url);
  const publishedStr = (raw.published as string) ?? '';
  const publishedAt = new Date(publishedStr);

  // Sentiment mapping: positive→0.5, negative→-0.5, neutral→0
  const sentiment = mapSentiment(raw.sentiment as string | undefined);

  // Entities flattening
  const entities = flattenEntities(raw.entities);

  // Text is the short snippet (~200 chars) — goes in description
  const text = (raw.text as string) ?? '';

  // Social signals from thread
  const social = (thread.social ?? null) as Record<string, unknown> | null;

  // Categories (IPTC) — array of strings
  const categories = (raw.categories as string[]) ?? [];
  const iptcCategory = categories.length > 0 ? categories.join(', ') : null;

  // Dedup hashes
  const titleHash = computeTitleHash(title);
  const normalizedUrlHash = computeNormalizedUrlHash(url);
  const domainTitleHash = computeDomainTitleHash(domain, title);

  return {
    externalId:        null,
    sourceApi:         'webzio',
    url,

    title,
    description:       text || null,
    content:           null, // Webz.io Lite doesn't provide full text
    imageUrl:          (raw.main_image as string) ?? (thread.main_image as string) ?? null,

    author:            (raw.author as string) ?? (thread.author as string) ?? null,
    sourceName:         domain || null,
    sourceDomain:       domain,

    publishedAt,
    fetchedAt:          new Date(),

    apiCategory:        iptcCategory,
    apiIptcCategory:    iptcCategory,
    apiSentiment:       sentiment,
    apiLanguage:        (raw.language as string) ?? null,
    apiCountry:         (thread.country as string) ?? null,
    apiKeywords:        categories,
    apiEntities:        entities,
    apiSourcePriority:  null,
    apiRelevanceScore:  null,
    apiDomainRank:      typeof thread.domain_rank === 'number' ? thread.domain_rank : null,
    apiPerformance:     typeof thread.performance_score === 'number' ? thread.performance_score : null,
    apiSocial:          social,
    apiDuplicateFlag:   null,

    titleHash,
    normalizedUrlHash,
    domainTitleHash,
  };
}

// ── API Fetch ──

interface FetchPageResult {
  articles: Record<string, unknown>[];
  next: string | null;
  totalResults: number;
}

async function fetchPage(query: string, ts: number, nextUrl?: string): Promise<FetchPageResult> {
  let url: string;
  if (nextUrl) {
    // Webz.io returns relative next URLs (e.g. "/newsApiLite?token=...") — prepend base
    url = nextUrl.startsWith('http') ? nextUrl : `https://api.webz.io${nextUrl}`;
  } else {
    url = `${ENDPOINT}?token=${process.env.WEBZ_API_KEY}&q=${encodeURIComponent(query)}&ts=${ts}&size=10&format=json`;
  }

  const res = await rateLimitedFetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`[WEBZIO] API error ${res.status} for "${query.slice(0, 50)}": ${body.slice(0, 200)}`);
    return { articles: [], next: null, totalResults: 0 };
  }

  const data = await res.json() as {
    posts?: Record<string, unknown>[];
    results?: Record<string, unknown>[];
    next?: string;
    totalResults?: number;
  };

  return {
    articles: (data.posts ?? data.results ?? []) as Record<string, unknown>[],
    next: data.next ?? null,
    totalResults: data.totalResults ?? 0,
  };
}

// ── Main Export ──

export interface WebzioFetchResult {
  articles: NormalizedArticle[];
  stats: {
    queriesRun: number;
    apiCallsUsed: number;
    totalRawPosts: number;
    normalizedCount: number;
    duplicateUrlsDropped: number;
  };
}

/**
 * Fetch articles from all 18 Webz.io queries.
 * Uses ~30 API calls/day of the ~33 daily budget.
 *
 * Pipeline calls this as: `const webzio = await fetchWebzio();`
 */
export async function fetchWebzio(): Promise<WebzioFetchResult> {
  const apiKey = process.env.WEBZ_API_KEY;
  if (!apiKey) {
    console.warn('[WEBZIO] No WEBZ_API_KEY set — skipping Webz.io fetch');
    return {
      articles: [],
      stats: { queriesRun: 0, apiCallsUsed: 0, totalRawPosts: 0, normalizedCount: 0, duplicateUrlsDropped: 0 },
    };
  }

  // ts = 30h ago in milliseconds
  const ts = Date.now() - 24 * 60 * 60 * 1000;

  // Char limit safety check (dev-time guard — should never fire in production)
  for (const q of QUERIES) {
    if (q.q.length > 100) {
      console.error(`[WEBZIO] FATAL: Query "${q.label}" exceeds 100-char limit (${q.q.length} chars): ${q.q}`);
      // Don't crash — just skip this query. The API would return 0 results anyway.
    }
  }

  const allArticles: NormalizedArticle[] = [];
  const seenUrls = new Set<string>();  // Dedup within this fetch run
  let queriesRun = 0;
  let apiCallsUsed = 0;
  let totalRawPosts = 0;
  let duplicateUrlsDropped = 0;

  for (const qdef of QUERIES) {
    // Skip queries that exceed char limit
    if (qdef.q.length > 100) {
      console.warn(`[WEBZIO] Skipping "${qdef.label}" — query too long (${qdef.q.length} chars)`);
      continue;
    }

    queriesRun++;
    const maxPages = qdef.calls;
    let nextUrl: string | null = null;
    let queryArticles = 0;

    for (let page = 0; page < maxPages; page++) {
      const result = await fetchPage(qdef.q, ts, nextUrl || undefined);
      apiCallsUsed++;
      totalRawPosts += result.articles.length;

      if (page === 0) {
        console.log(`[WEBZIO] ${qdef.label} [${qdef.region}] — ${result.articles.length} results (pool: ${result.totalResults})`);
      }

      for (const rawPost of result.articles) {
        const article = normalize(rawPost);
        if (!article) continue;

        // Within-run dedup by normalized URL hash
        if (seenUrls.has(article.normalizedUrlHash)) {
          duplicateUrlsDropped++;
          continue;
        }
        seenUrls.add(article.normalizedUrlHash);

        allArticles.push(article);
        queryArticles++;
      }

      nextUrl = result.next;
      if (!nextUrl || result.articles.length === 0) break;
    }

    if (queryArticles > 0) {
      console.log(`[WEBZIO]   → ${queryArticles} unique articles from "${qdef.label}"`);
    }
  }

  console.log(`[WEBZIO] Complete: ${allArticles.length} normalized articles from ${apiCallsUsed} API calls`);

  return {
    articles: allArticles,
    stats: {
      queriesRun,
      apiCallsUsed,
      totalRawPosts,
      normalizedCount: allArticles.length,
      duplicateUrlsDropped,
    },
  };
}
