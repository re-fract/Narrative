/**
 * worldnewsFetcher.ts — WorldNewsAPI fetcher + normalizer
 *
 * Fetches articles from the WorldNewsAPI /search-news endpoint using 18
 * category-first query slots (6 India, 12 global) with offset pagination.
 * Returns NormalizedArticle[] ready for the structural filter pipeline (F1–F7).
 *
 * Key constraints:
 *   - 50 pts/day budget; 1pt base + 0.01pt/result per call
 *   - Reserve 5 pts for enrichment lookups → 45 pts for fetching = 36 calls
 *   - 25 results/call via `number` param
 *   - 60 req/min + 1 concurrent request (serial execution)
 *   - `text` param: max 100 chars (per API docs)
 *   - `categories` param: comma-separated OR filter (politics, business, etc.)
 *   - `earliestPublishDate` in `YYYY-MM-DD HH:MM:SS` format, UTC (no TZ suffix)
 *   - Quota headers (`X-API-Quota-Left`, `X-API-Quota-Consumed`) — stop at ≤ 5
 *
 * Normalization rules (from §4.2):
 *   - `text` field → content (often 500+ chars of full article body)
 *   - `summary` → description
 *   - `sentiment` is -1 to 1 float → use directly
 *   - `source_country` → apiCountry
 *   - Extract domain from URL (source field unreliable)
 *   - Strip boilerplate lines from text (Also Read, Subscribe, etc.)
 *   - Compute dedup hashes (titleHash, normalizedUrlHash, domainTitleHash)
 */

import type { NormalizedArticle } from '../../types/index.js';
import { computeTitleHash, computeNormalizedUrlHash, computeDomainTitleHash } from '../titleNormalizer.js';

// ── Query Definitions ──
// 18 query slots (6 India, 12 global) totaling 36 API calls.
// Every call includes: language=en, sort=publish-time, sortDirection=DESC,
// number=25, earliest-publish-date=24h ago, api-key=KEY

interface QuerySlot {
  label: string;
  region: 'india' | 'global';
  categories?: string;      // comma-separated categories filter
  text?: string;            // search text (max 100 chars)
  sourceCountry?: string;   // ISO 3166 code (only 'in' for India queries)
  pages: number;            // offset-pagination depth (1 page = 1 API call, 25 results)
}

const QUERIES: QuerySlot[] = [
  // ── India (11 calls, 6 slots) — source-country=in on all ──
  {
    label: 'IN Politics',
    categories: 'politics',
    sourceCountry: 'in',
    region: 'india',
    pages: 3,
  },
  {
    label: 'IN Business',
    categories: 'business',
    sourceCountry: 'in',
    region: 'india',
    pages: 2,
  },
  {
    label: 'IN Technology',
    categories: 'technology',
    sourceCountry: 'in',
    region: 'india',
    pages: 1,
  },
  {
    label: 'IN Sci Health Edu Env',
    categories: 'science,health,education,environment',
    sourceCountry: 'in',
    region: 'india',
    pages: 2,
  },
  {
    label: 'IN Accountability',
    categories: 'politics',
    text: 'corruption OR fraud',
    sourceCountry: 'in',
    region: 'india',
    pages: 1,
  },
  {
    label: 'IN Broad',
    sourceCountry: 'in',
    region: 'india',
    pages: 2,
  },

  // ── Global (25 calls, 12 slots) ──
  {
    label: 'Global Politics',
    categories: 'politics',
    region: 'global',
    pages: 5,
  },
  {
    label: 'Global Business',
    categories: 'business',
    region: 'global',
    pages: 4,
  },
  {
    label: 'Global Technology',
    categories: 'technology',
    region: 'global',
    pages: 2,
  },
  {
    label: 'Global Environment',
    categories: 'environment',
    region: 'global',
    pages: 2,
  },
  {
    label: 'Global Sci Health Edu',
    categories: 'science,health,education',
    region: 'global',
    pages: 2,
  },
  {
    label: 'Global Science',
    categories: 'science',
    region: 'global',
    pages: 1,
  },
  {
    label: 'Global Health',
    categories: 'health',
    region: 'global',
    pages: 2,
  },
  {
    label: 'Global Accountability Pol',
    categories: 'politics',
    text: 'corruption OR fraud OR investigation',
    region: 'global',
    pages: 2,
  },
  {
    label: 'Global Accountability Biz',
    categories: 'business',
    text: 'investigation OR misconduct',
    region: 'global',
    pages: 1,
  },
  {
    label: 'Global AI Cyber',
    categories: 'technology',
    text: 'AI OR cybersecurity',
    region: 'global',
    pages: 1,
  },
  {
    label: 'Global Broad',
    region: 'global',
    pages: 3,
  },
];

const ENDPOINT = 'https://api.worldnewsapi.com/search-news';
const RESULTS_PER_CALL = 25;
const QUOTA_RESERVE = 5;          // Reserve 5 pts for enrichment lookups
const MIN_REQUEST_INTERVAL_MS = 1200;  // ~1 req/sec with margin

// ── Rate Limiting ──

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

// ── Boilerplate Stripper ──
// Remove common boilerplate lines from WorldNewsAPI text field

const BOILERPLATE_PATTERNS = [
  /^also read\b/i,
  /^subscribe\b/i,
  /^read more\b/i,
  /^sign up\b/i,
  /^download our app\b/i,
  /^follow us\b/i,
  /^click here\b/i,
  /^share this\b/i,
  /^related articles?\b/i,
  /^©/i,
  /^all rights reserved\b/i,
];

function stripBoilerplate(text: string): string {
  const lines = text.split('\n');
  const cleaned = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true; // keep blank lines for structure
    return !BOILERPLATE_PATTERNS.some(pat => pat.test(trimmed));
  });
  // Collapse multiple consecutive blank lines into one
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Domain Extraction ──

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ── Normalizer ──

/**
 * Parse a WorldNewsAPI date string in `YYYY-MM-DD HH:MM:SS` format (UTC).
 * The API returns dates without timezone suffix but values are UTC.
 */
function parseWorldnewsDate(raw: string): Date {
  // Append 'Z' to treat as UTC
  const utcStr = raw.trim().replace(' ', 'T') + 'Z';
  const d = new Date(utcStr);
  if (isNaN(d.getTime())) {
    // Fallback: try parsing the space-separated format manually
    const parsed = new Date(raw.trim() + '+00:00');
    if (!isNaN(parsed.getTime())) return parsed;
    return new Date(); // last resort — will be caught by staleness filter
  }
  return d;
}

function normalize(raw: Record<string, unknown>): NormalizedArticle | null {
  const url = (raw.url as string) ?? '';
  const title = (raw.title as string) ?? '';
  if (!url || !title) return null;

  // Handle both camelCase and snake_case field names
  const sourceCountry = (raw.sourceCountry ?? raw.source_country ?? null) as string | null;
  const publishDateStr = (raw.publishDate ?? raw.publish_date ?? null) as string | null;
  const id = raw.id != null ? String(raw.id) : null;

  const domain = extractDomain(url);
  const publishedAt = publishDateStr ? parseWorldnewsDate(publishDateStr) : new Date();

  // Text field → content (primary value of WorldNewsAPI — often has full article body)
  let textContent: string | null = (raw.text as string) ?? null;
  if (textContent) {
    textContent = stripBoilerplate(textContent);
    // Drop if entirely boilerplate (= nothing meaningful left)
    if (textContent.trim().length < 20) textContent = null;
  }

  // Summary → description
  const summary = (raw.summary as string) ?? null;

  // Sentiment: already -1 to 1 float
  const sentiment = typeof raw.sentiment === 'number' ? raw.sentiment : null;

  // Authors
  const authors = Array.isArray(raw.authors) ? (raw.authors as string[]) : [];

  // Dedup hashes
  const titleHash = computeTitleHash(title);
  const normalizedUrlHash = computeNormalizedUrlHash(url);
  const domainTitleHash = computeDomainTitleHash(domain, title);

  return {
    externalId:        id,
    sourceApi:         'worldnews',
    url,

    title,
    description:       summary,
    content:           textContent,
    imageUrl:          (raw.image as string) ?? null,

    author:            authors.length > 0 ? authors[0] : null,
    sourceName:         domain || null,
    sourceDomain:       domain,

    publishedAt,
    fetchedAt:          new Date(),

    apiCategory:        (raw.category as string) ?? null,
    apiIptcCategory:    null,                                // WorldNewsAPI doesn't provide IPTC
    apiSentiment:       sentiment,
    apiLanguage:        (raw.language as string) ?? 'en',
    apiCountry:         sourceCountry?.toLowerCase() ?? null,
    apiKeywords:        [],                                  // No keyword field on search endpoint
    apiEntities:        [],                                  // No entities on search endpoint
    apiSourcePriority:  null,                                // NewsData-only
    apiRelevanceScore:  null,                                // TheNewsAPI-only
    apiDomainRank:      null,                                // Webz.io-only
    apiPerformance:     null,                               // Webz.io-only
    apiSocial:          null,                                // Webz.io-only
    apiDuplicateFlag:   null,                                // NewsData-only

    titleHash,
    normalizedUrlHash,
    domainTitleHash,
  };
}

// ── API Fetch ──

interface FetchPageResult {
  articles: Record<string, unknown>[];
  available: number;
  quotaUsed: number;
  quotaRemaining: number;
}

async function fetchPage(
  params: Record<string, string>,
  offset: number,
): Promise<FetchPageResult> {
  const urlParams = new URLSearchParams(params);
  urlParams.set('offset', String(offset));
  urlParams.set('number', String(RESULTS_PER_CALL));

  const url = `${ENDPOINT}?${urlParams.toString()}`;
  const res = await rateLimitedFetch(url);

  if (!res.ok) {
    if (res.status === 402) {
      // Quota exhausted
      return { articles: [], available: 0, quotaUsed: -1, quotaRemaining: 0 };
    }
    const body = await res.text().catch(() => '');
    console.error(`[WORLDNEWS] API error ${res.status}: ${body.slice(0, 200)}`);
    return { articles: [], available: 0, quotaUsed: 0, quotaRemaining: 0 };
  }

  // Read quota headers
  const quotaUsed = parseFloat(res.headers.get('X-API-Quota-Consumed') ?? '0');
  const quotaRemaining = parseFloat(res.headers.get('X-API-Quota-Left') ?? '999');

  const data = await res.json() as {
    news?: Record<string, unknown>[];
    available?: number;
  };

  return {
    articles: data.news ?? [],
    available: data.available ?? 0,
    quotaUsed,
    quotaRemaining,
  };
}

// ── Main Export ──

export interface WorldnewsFetchResult {
  articles: NormalizedArticle[];
  stats: {
    querySlotsRun: number;
    apiCallsUsed: number;
    totalRawArticles: number;
    normalizedCount: number;
    duplicateUrlsDropped: number;
    quotaUsed: number;
    quotaRemaining: number;
    quotaExhausted: boolean;
  };
}

/**
 * Fetch articles from all 18 WorldNewsAPI query slots.
 * Uses ~36 API calls/day of the 45 pt fetch budget (5 pts reserved for enrichment).
 *
 * Pipeline calls this as: `const wn = await fetchWorldnews();`
 */
export async function fetchWorldnews(): Promise<WorldnewsFetchResult> {
  const apiKey = process.env.WORLDNEWS_API_KEY;
  if (!apiKey) {
    console.warn('[WORLDNEWS] No WORLDNEWS_API_KEY set — skipping WorldNewsAPI fetch');
    return {
      articles: [],
      stats: {
        querySlotsRun: 0, apiCallsUsed: 0, totalRawArticles: 0,
        normalizedCount: 0, duplicateUrlsDropped: 0,
        quotaUsed: 0, quotaRemaining: 50, quotaExhausted: false,
      },
    };
  }

  // Compute 24h ago in UTC as `YYYY-MM-DD HH:MM:SS`
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const earliestPublishDate = cutoff.toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');

  // Base params for every call
  const baseParams: Record<string, string> = {
    'api-key': apiKey,
    language: 'en',
    sort: 'publish-time',
    sortDirection: 'DESC',
    'earliest-publish-date': earliestPublishDate,
  };

  const allArticles: NormalizedArticle[] = [];
  const seenUrls = new Set<string>();   // Dedup within this fetch run
  let querySlotsRun = 0;
  let apiCallsUsed = 0;
  let totalRawArticles = 0;
  let duplicateUrlsDropped = 0;
  let quotaUsed = 0;
  let quotaRemaining = 50;
  let quotaExhausted = false;

  for (const slot of QUERIES) {
    // Build slot-specific params
    const params: Record<string, string> = { ...baseParams };
    if (slot.categories) params.categories = slot.categories;
    if (slot.text) params.text = slot.text;
    if (slot.sourceCountry) params['source-country'] = slot.sourceCountry;

    querySlotsRun++;
    let slotArticles = 0;

    for (let page = 0; page < slot.pages; page++) {
      const offset = page * RESULTS_PER_CALL;
      const result = await fetchPage(params, offset);
      apiCallsUsed++;

      // Check quota exhaustion (402 response)
      if (result.quotaUsed < 0) {
        console.warn('[WORLDNEWS] ⚠ Quota exhausted (HTTP 402) — stopping early');
        quotaExhausted = true;
        break;
      }

      // Update quota tracking from response headers
      quotaUsed = result.quotaUsed || quotaUsed;
      quotaRemaining = result.quotaRemaining || quotaRemaining;

      // Check quota reserve — stop if ≤ 5 pts remaining
      if (quotaRemaining <= QUOTA_RESERVE) {
        console.warn(`[WORLDNEWS] ⚠ Quota near exhaustion (${quotaRemaining.toFixed(2)} ≤ ${QUOTA_RESERVE} pts) — stopping early`);
        quotaExhausted = true;
        if (page === 0) {
          console.log(`[WORLDNEWS] ${slot.label} [${slot.region}] pg ${page + 1}/${slot.pages} — quota exhausted before start`);
        }
        break;
      }

      totalRawArticles += result.articles.length;

      if (page === 0) {
        console.log(`[WORLDNEWS] ${slot.label} [${slot.region}] pg 1/${slot.pages} — ${result.articles.length} results (pool: ${result.available})`);
      }

      for (const rawArticle of result.articles) {
        const article = normalize(rawArticle);
        if (!article) continue;

        // Within-run dedup by normalized URL hash
        if (seenUrls.has(article.normalizedUrlHash)) {
          duplicateUrlsDropped++;
          continue;
        }
        seenUrls.add(article.normalizedUrlHash);

        allArticles.push(article);
        slotArticles++;
      }

      // No point paginating if this page returned fewer results than requested
      if (result.articles.length < RESULTS_PER_CALL) break;
    }

    if (slotArticles > 0) {
      console.log(`[WORLDNEWS]   → ${slotArticles} unique articles from "${slot.label}"`);
    }

    if (quotaExhausted) break;
  }

  // Log quota summary
  if (!quotaExhausted) {
    console.log(`[WORLDNEWS] Quota: ${quotaRemaining.toFixed(2)} pts remaining after ${apiCallsUsed} calls`);
  }

  console.log(`[WORLDNEWS] Complete: ${allArticles.length} normalized articles from ${apiCallsUsed} API calls`);

  return {
    articles: allArticles,
    stats: {
      querySlotsRun,
      apiCallsUsed,
      totalRawArticles,
      normalizedCount: allArticles.length,
      duplicateUrlsDropped,
      quotaUsed,
      quotaRemaining,
      quotaExhausted,
    },
  };
}
