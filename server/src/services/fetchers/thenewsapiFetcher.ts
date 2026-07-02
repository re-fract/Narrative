/**
 * thenewsapiFetcher.ts — TheNewsAPI fetcher + normalizer
 *
 * Fetches articles from TheNewsAPI using /top and /all endpoints with
 * search queries (activating relevance_score for F9 pre-filtering).
 * Returns NormalizedArticle[] ready for the structural filter pipeline (F1–F7).
 *
 * ═══════════════════════════════════════════════════════════════════
 *  SLOT BUDGET ACCOUNTING  (100 calls/day, 3 articles/call = 300 max)
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Group A — India `/top` + `locale=in` + search     27 calls
 *  Group B — India `/top` + `locale=in` (no search)   6 calls
 *  Group C — Global `/all` + search                  50 calls
 *  Group D — Global `/top` + search                   10 calls
 *  Group E — Global `/top` (no search)                5 calls
 *  Group F — Baseline `/top` (no search)              5 calls
 *                                                     ─────────
 *                                             TOTAL: 100 calls
 *
 * ═══════════════════════════════════════════════════════════════════
 *  CRITICAL DISCREPANCY  (API docs vs. implementation plan)
 * ═══════════════════════════════════════════════════════════════════
 *
 *  The implementation plan (§4.3.2) says: "Use `/all` endpoint with
 *  `search` param" and expects `locale=in` for India queries.
 *
 *  Per API documentation (highest priority source):
 *    - `/top` endpoint HAS `locale` parameter ✅
 *    - `/all` endpoint does NOT have `locale` parameter ❌
 *
 *  Resolution: India-targeted queries (Groups A, B) use `/top` with
 *  `locale=in` instead of `/all`. This GIVES us BOTH `locale` geo-
 *  targeting AND `relevance_score` (when search is used on `/top`).
 *  Global breadth queries (Group C) use `/all` for maximum coverage.
 *
 *  The implementation plan's second claim — "`/top` gives no
 *  relevance_score" — is also incorrect: `/top` returns `relevance_score`
 *  whenever the `search` parameter is used, identical to `/all`.
 *
 * ═══════════════════════════════════════════════════════════════════
 *  KEY CONSTRAINTS
 * ═══════════════════════════════════════════════════════════════════
 *
 *  - 100 req/day × 3 articles = 300 articles/day (free tier)
 *  - `limit=3` per request (free tier max; change ARTICLES_PER_CALL
 *    if TheNewsAPI increases the free-tier limit)
 *  - 1.5s minimum interval between calls (observational rate limit)
 *  - `search` activates `relevance_score` on BOTH `/top` and `/all`
 *  - F9 pre-filter: `relevance_score < 25` → reject inside normalizer
 *  - `exclude_categories=sports,entertainment,food,travel` on EVERY call
 *  - `search_fields=title,description,keywords` on every search call
 *    (no `main_text` access on free tier; avoids default `title,main_text`)
 *  - `description` (~120 chars) → `content` (main text on free tier)
 *  - `snippet` (60 chars) → discard
 *  - `source` → domain string, use directly as sourceDomain
 *  - `keywords` → comma-separated, split into array
 *  - Date format: ISO 8601 with Z suffix, already UTC
 *  - Pagination: `page` + `limit` → stop when `meta.returned < limit`
 *  - HTTP 402 (usage_limit_reached) → stop immediately
 *  - HTTP 429 (rate_limit_reached) → exponential backoff, max 3 retries
 *  - Monitor `X-UsageLimit-Limit` / `X-RateLimit-Limit` headers
 *
 * ═══════════════════════════════════════════════════════════════════
 *  NORMALIZATION RULES
 * ═══════════════════════════════════════════════════════════════════
 *
 *  - `uuid`                   → externalId
 *  - `title`                  → title
 *  - `description` (~120c)    → content  (main text field on free tier)
 *  - `snippet` (60c)          → DISCARD  (too short to be useful)
 *  - `url`                    → url
 *  - `image_url`              → imageUrl
 *  - `source`                 → sourceDomain (is a domain string)
 *  - `source`                 → sourceName (reuse domain)
 *  - `published_at`           → publishedAt (already UTC with Z suffix)
 *  - `language`               → apiLanguage
 *  - `categories[]`           → apiCategory (joined), apiIptcCategory
 *  - `keywords`               → apiKeywords (split by comma, trimmed)
 *  - `relevance_score`        → apiRelevanceScore
 *  - `locale` (/top only)     → apiCountry
 *  - No author field          → author: null
 *  - No sentiment field       → apiSentiment: null
 *  - No entities field         → apiEntities: []
 *  - Compute dedup hashes      → titleHash, normalizedUrlHash, domainTitleHash
 *  - F9: relevance_score < 25 → REJECT (log count, article not emitted)
 */

import type { NormalizedArticle } from '../../types/index.js';
import { computeTitleHash, computeNormalizedUrlHash, computeDomainTitleHash } from '../titleNormalizer.js';

// ── Query Slot Definitions ──
// 100 request slots across 6 groups. Every call includes:
//   language=en, exclude_categories=sports,entertainment,food,travel
//   limit=3, published_after=<24h ago>
// Search calls also include: search_fields=title,description,keywords

interface QuerySlot {
  label: string;
  endpoint: 'top' | 'all';
  region: 'india' | 'global';
  search?: string;          // Activates relevance_score. URL-encoded by fetchPage.
  categories?: string;      // Comma-separated category filter.
  domains?: string;         // Comma-separated domain filter.
  locale?: string;         // Only valid on /top endpoint.
  calls: number;            // Pagination depth (1 page = 1 API call = 3 articles).
}

const QUERIES: QuerySlot[] = [
  // ── Group A: India `/top` + `locale=in` + search (24 calls) ──

  {
    label: 'IN Politics',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'politics',
    search: 'politics',
    calls: 3,
  },
  {
    label: 'IN Business',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'business',
    search: 'economy',
    calls: 3,
  },
  {
    label: 'IN Technology',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'tech',
    search: 'technology',
    calls: 2,
  },
  {
    label: 'IN Science',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'science',
    search: 'science',
    calls: 2,
  },
  {
    label: 'IN Health',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'health',
    search: 'health',
    calls: 2,
  },
  {
    label: 'IN Broad',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    search: 'India',
    calls: 3,
  },
  {
    label: 'IN Accountability',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'politics',
    // 2026-07-02: Changed OR→| — TNA search uses | (pipe) for OR, not the word "OR".
    // search=corruption+OR+investigation was parsed as "corruption AND OR AND investigation"
    // (a nonsensical literal search), causing pool:0. Fix verified via API diagnostics.
    search: 'corruption | investigation',
    calls: 2,
  },
  {
    label: 'IN Biz Accountability',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'business',
    search: 'fraud | investigation',
    calls: 1,
  },
  {
    label: 'IN Environment',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'science',
    search: 'environment | climate',
    calls: 1,
  },
  {
    label: 'IN Policy',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'politics',
    search: 'policy | reform',
    calls: 2,
  },
  {
    label: 'IN Education',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    search: 'education',
    calls: 1,
  },
  {
    label: 'IN Economy',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'business',
    search: 'economy | markets',
    calls: 2,
  },
  {
    label: 'IN Security',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    search: 'security',
    calls: 1,
  },
  {
    label: 'IN AI Tech',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'tech',
    search: 'AI | cybersecurity',
    calls: 1,
  },

  // ── Group B: India `/top` + `locale=in` (no search, no relevance_score) (6 calls) ──

  {
    label: 'IN Top General',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'general',
    calls: 2,
  },
  {
    label: 'IN Top Mixed',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    categories: 'general,politics,business',
    calls: 3,
  },
  {
    label: 'IN Domains',
    endpoint: 'top',
    region: 'india',
    locale: 'in',
    domains: 'thehindu.com,indianexpress.com,theprint.in,scroll.in',
    calls: 1,
  },

  // ── Group C: Global `/all` + search (50 calls) ──

  {
    label: 'G Politics',
    endpoint: 'all',
    region: 'global',
    categories: 'politics',
    search: 'politics',
    calls: 5,
  },
  {
    label: 'G Business',
    endpoint: 'all',
    region: 'global',
    categories: 'business',
    search: 'business',
    calls: 5,
  },
  {
    label: 'G Technology',
    endpoint: 'all',
    region: 'global',
    categories: 'tech',
    search: 'technology',
    calls: 3,
  },
  {
    label: 'G Science',
    endpoint: 'all',
    region: 'global',
    categories: 'science',
    search: 'science',
    calls: 3,
  },
  {
    label: 'G Health',
    endpoint: 'all',
    region: 'global',
    categories: 'health',
    search: 'health',
    calls: 3,
  },
  {
    label: 'G Environment',
    endpoint: 'all',
    region: 'global',
    categories: 'science',
    search: 'environment | climate',
    calls: 2,
  },
  {
    label: 'G Accountability Pol',
    endpoint: 'all',
    region: 'global',
    categories: 'politics',
    search: 'corruption | investigation',
    calls: 3,
  },
  {
    label: 'G Accountability Biz',
    endpoint: 'all',
    region: 'global',
    categories: 'business',
    search: 'fraud | misconduct',
    calls: 2,
  },
  {
    label: 'G Conflict',
    endpoint: 'all',
    region: 'global',
    search: 'conflict | war',
    calls: 2,
  },
  {
    label: 'G AI Tech',
    endpoint: 'all',
    region: 'global',
    categories: 'tech',
    search: 'AI | cybersecurity',
    calls: 2,
  },
  {
    label: 'G Broad',
    endpoint: 'all',
    region: 'global',
    search: 'news',
    calls: 4,
  },
  {
    label: 'G Education',
    endpoint: 'all',
    region: 'global',
    search: 'education',
    calls: 2,
  },
  {
    label: 'G Policy',
    endpoint: 'all',
    region: 'global',
    categories: 'politics',
    search: 'policy | reform',
    calls: 2,
  },
  {
    label: 'G Economy',
    endpoint: 'all',
    region: 'global',
    categories: 'business',
    search: 'economy | fiscal',
    calls: 2,
  },
  {
    label: 'G Quality Sources',
    endpoint: 'all',
    region: 'global',
    domains: 'reuters.com,apnews.com,bbc.com,aljazeera.com,theguardian.com',
    search: 'world',
    calls: 4,
  },
  {
    label: 'G Sci+Health',
    endpoint: 'all',
    region: 'global',
    categories: 'science,health',
    search: 'research',
    calls: 2,
  },
  {
    label: 'G Innovation',
    endpoint: 'all',
    region: 'global',
    categories: 'tech,science',
    search: 'innovation',
    calls: 2,
  },

  // ── Group D: Global `/top` + search (10 calls) ──

  {
    label: 'GTop Politics',
    endpoint: 'top',
    region: 'global',
    categories: 'politics',
    search: 'politics',
    calls: 2,
  },
  {
    label: 'GTop Business',
    endpoint: 'top',
    region: 'global',
    categories: 'business',
    search: 'business',
    calls: 2,
  },
  {
    label: 'GTop Tech',
    endpoint: 'top',
    region: 'global',
    categories: 'tech',
    search: 'technology',
    calls: 1,
  },
  {
    label: 'GTop Sci+Health',
    endpoint: 'top',
    region: 'global',
    categories: 'science,health',
    search: 'science',
    calls: 2,
  },
  {
    label: 'GTop Accountability',
    endpoint: 'top',
    region: 'global',
    search: 'corruption | investigation',
    calls: 2,
  },
  {
    label: 'GTop Environment',
    endpoint: 'top',
    region: 'global',
    categories: 'science',
    search: 'environment',
    calls: 1,
  },

  // ── Group E: Global `/top` (no search, curated) (5 calls) ──

  {
    label: 'GTop Mixed',
    endpoint: 'top',
    region: 'global',
    categories: 'general,politics,business',
    calls: 3,
  },
  {
    label: 'GTop General',
    endpoint: 'top',
    region: 'global',
    categories: 'general',
    calls: 2,
  },

  // ── Group F: Baseline `/top` (no search, no categories) (5 calls) ──

  {
    label: 'Baseline Headlines',
    endpoint: 'top',
    region: 'global',
    calls: 5,
  },
];

// ── Verify slot count at module load time ──

const TOTAL_CALLS = QUERIES.reduce((sum, q) => sum + q.calls, 0);
if (TOTAL_CALLS !== 100) {
  console.error(
    `[TNA] FATAL: Slot budget mismatch — expected 100 calls, got ${TOTAL_CALLS}. ` +
    `Adjust QUERIES array before deploying.`
  );
}

// ── Constants ──
// Change ARTICLES_PER_CALL if TheNewsAPI increases the free-tier limit.
// Everything else (pagination logic, yield estimates) adjusts automatically.

const ENDPOINT_TOP = 'https://api.thenewsapi.com/v1/news/top';
const ENDPOINT_ALL  = 'https://api.thenewsapi.com/v1/news/all';
const ARTICLES_PER_CALL  = 3;          // Free-tier limit per request
const REQUESTS_PER_DAY   = 100;         // Free-tier daily request budget
const F9_RELEVANCE_THRESHOLD = 25;      // relevance_score < 25 → reject (F9)
const DEFAULT_EXCLUDE_CATEGORIES = 'sports,entertainment,food,travel';
const DEFAULT_SEARCH_FIELDS = 'title,description,keywords'; // no main_text on free tier
const MIN_REQUEST_INTERVAL_MS = 1500;  // 1.5s between calls (observational)
const MAX_429_RETRIES = 3;             // Max retries on HTTP 429

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

// ── Domain Extraction ──

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ── Keywords Splitter ──
// TheNewsAPI returns keywords as comma-separated string, ~33% populated.

function splitKeywords(raw: string | null | undefined): string[] {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0);
}

// ── F9 Pre-Filter ──
// Articles with relevance_score < 25 are pre-rejected inside the normalizer.
// This prevents low-relevance articles from entering the pipeline at all,
// saving Cerebras LLM tokens. Only applies when relevance_score is non-null
// (i.e., when search parameter was used on the API call).

let f9RejectedCount = 0;

function shouldF9Reject(relevanceScore: number | null): boolean {
  if (relevanceScore === null) return false; // No score → can't reject
  return relevanceScore < F9_RELEVANCE_THRESHOLD;
}

// ── Normalizer ──

/**
 * Parse a TheNewsAPI date string.
 * Format: `2026-06-29T04:05:19.000000Z` — already UTC with Z suffix.
 */
function parseTnaDate(raw: string): Date {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return new Date(); // last resort — staleness filter will catch
  return d;
}

function normalize(raw: Record<string, unknown>): NormalizedArticle | null {
  const url = (raw.url as string) ?? '';
  const title = (raw.title as string) ?? '';
  if (!url || !title) return null;

  // ── F9 pre-filter: reject low-relevance articles ──
  const relevanceScore = typeof raw.relevance_score === 'number' ? raw.relevance_score : null;
  if (shouldF9Reject(relevanceScore)) {
    f9RejectedCount++;
    return null;
  }

  const uuid = (raw.uuid as string) ?? null;
  const description = (raw.description as string) ?? null;
  const publishedAt = parseTnaDate((raw.published_at as string) ?? '');
  const source = (raw.source as string) ?? '';  // Domain string (e.g. "apnews.com")
  const domain = source || extractDomain(url);
  const language = (raw.language as string) ?? null;
  const locale = (raw.locale as string) ?? null;  // Only present on /top responses
  const categories = Array.isArray(raw.categories) ? (raw.categories as string[]) : [];
  const imageUrl = (raw.image_url as string) ?? null;
  const keywords = splitKeywords(raw.keywords as string | null | undefined);

  // Category mapping
  const apiCategory = categories.length > 0 ? categories.join(', ') : null;

  // Description → content (main text field on free tier, ~120 chars)
  // snippet (60 chars) is discarded per design constraint.
  const content = description && description.trim().length > 0 ? description.trim() : null;

  // Dedup hashes
  const titleHash = computeTitleHash(title);
  const normalizedUrlHash = computeNormalizedUrlHash(url);
  const domainTitleHash = computeDomainTitleHash(domain, title);

  return {
    externalId:        uuid,
    sourceApi:         'thenewsapi',
    url,

    title,
    description:       null,  // No separate short summary; snippet discarded
    content,                   // description (~120 chars) → content
    imageUrl,

    author:            null,  // TheNewsAPI doesn't provide author
    sourceName:         domain || null,
    sourceDomain:       domain,

    publishedAt,
    fetchedAt:          new Date(),

    apiCategory,
    apiIptcCategory:    apiCategory,  // TheNewsAPI categories overlap with IPTC
    apiSentiment:       null,         // TheNewsAPI doesn't provide sentiment
    apiLanguage:        language,
    apiCountry:         locale?.toLowerCase() ?? null,
    apiKeywords:        keywords,
    apiEntities:        [],           // TheNewsAPI doesn't provide entities
    apiSourcePriority:  null,        // Not applicable
    apiRelevanceScore:  relevanceScore,
    apiDomainRank:      null,         // Not applicable
    apiPerformance:     null,         // Not applicable
    apiSocial:          null,         // Not applicable
    apiDuplicateFlag:   null,         // Not applicable

    titleHash,
    normalizedUrlHash,
    domainTitleHash,
  };
}

// ── API Fetch ──

interface FetchPageResult {
  articles: Record<string, unknown>[];
  metaFound: number;
  metaReturned: number;
  usageLimitRemaining: number | null;
}

/**
 * Fetch a single page from TheNewsAPI.
 * Handles HTTP 429 with exponential backoff (up to MAX_429_RETRIES).
 * Returns empty on HTTP 402 (usage limit reached).
 */
async function fetchPage(
  baseUrl: string,
  params: Record<string, string>,
  page: number,
): Promise<FetchPageResult> {
  const urlParams = new URLSearchParams(params);
  urlParams.set('limit', String(ARTICLES_PER_CALL));
  urlParams.set('page', String(page));

  const url = `${baseUrl}?${urlParams.toString()}`;

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await rateLimitedFetch(url);

    if (res.status === 402) {
      // usage_limit_reached — stop entirely
      console.warn('[TNA] ⚠ Usage limit reached (HTTP 402) — stopping');
      return { articles: [], metaFound: 0, metaReturned: 0, usageLimitRemaining: 0 };
    }

    if (res.status === 429) {
      // rate_limit_reached — exponential backoff
      if (attempt < MAX_429_RETRIES) {
        const backoffMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
        console.warn(`[TNA] ⚠ Rate limited (HTTP 429) — retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_429_RETRIES})`);
        await sleep(backoffMs);
        continue;
      }
      console.error('[TNA] Rate limit persisted after max retries — giving up on this page');
      return { articles: [], metaFound: 0, metaReturned: 0, usageLimitRemaining: null };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[TNA] API error ${res.status}: ${body.slice(0, 200)}`);
      return { articles: [], metaFound: 0, metaReturned: 0, usageLimitRemaining: null };
    }

    // Read usage limit headers (defensive — check both naming patterns)
    const usageLimitRemaining =
      parseFloat(res.headers.get('X-UsageLimit-Remaining') ?? '') ||
      parseFloat(res.headers.get('x-usagelimit-remaining') ?? '') ||
      null;

    const data = await res.json() as {
      meta?: { found?: number; returned?: number; limit?: number; page?: number };
      data?: Record<string, unknown>[];
    };

    const meta = data.meta ?? {};

    return {
      articles: Array.isArray(data.data) ? data.data : [],
      metaFound: meta.found ?? 0,
      metaReturned: meta.returned ?? 0,
      usageLimitRemaining,
    };
  }

  // Should not reach here, but just in case
  return { articles: [], metaFound: 0, metaReturned: 0, usageLimitRemaining: null };
}

// ── Main Export ──

export interface ThenewsapiFetchResult {
  articles: NormalizedArticle[];
  stats: {
    querySlotsRun: number;
    apiCallsUsed: number;
    totalRawArticles: number;
    normalizedCount: number;
    f9RejectedCount: number;
    duplicateUrlsDropped: number;
    usageLimitRemaining: number | null;
    usageExhausted: boolean;
  };
}

/**
 * Fetch articles from all TheNewsAPI query slots.
 * Uses 100 API calls/day of the free-tier budget (3 articles/call).
 *
 * Pipeline calls this as: `const tna = await fetchTheNewsApi();`
 */
export async function fetchTheNewsApi(): Promise<ThenewsapiFetchResult> {
  const apiKey = process.env.THENEWS_API_KEY;
  if (!apiKey) {
    console.warn('[TNA] No THENEWS_API_KEY set — skipping TheNewsAPI fetch');
    return {
      articles: [],
      stats: {
        querySlotsRun: 0, apiCallsUsed: 0, totalRawArticles: 0,
        normalizedCount: 0, f9RejectedCount: 0, duplicateUrlsDropped: 0,
        usageLimitRemaining: null, usageExhausted: false,
      },
    };
  }

  // Compute 30h ago in `Y-m-d\TH:i:s` format (UTC)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const publishedAfter = cutoff.toISOString().replace(/\.\d{3}Z$/, '');

  // Base params for every call
  const baseParams: Record<string, string> = {
    api_token: apiKey,
    language: 'en',
    exclude_categories: DEFAULT_EXCLUDE_CATEGORIES,
    published_after: publishedAfter,
  };

  const allArticles: NormalizedArticle[] = [];
  const seenUrls = new Set<string>();   // Dedup within this fetch run
  let querySlotsRun = 0;
  let apiCallsUsed = 0;
  let totalRawArticles = 0;
  let duplicateUrlsDropped = 0;
  let usageLimitRemaining: number | null = null;
  let usageExhausted = false;

  // Reset F9 counter for this run
  f9RejectedCount = 0;

  for (const slot of QUERIES) {
    // Build slot-specific params
    const params: Record<string, string> = { ...baseParams };
    const baseUrl = slot.endpoint === 'top' ? ENDPOINT_TOP : ENDPOINT_ALL;

    if (slot.search) {
      params.search = slot.search;
      params.search_fields = DEFAULT_SEARCH_FIELDS;
    }
    if (slot.categories) params.categories = slot.categories;
    if (slot.domains) params.domains = slot.domains;
    if (slot.locale) params.locale = slot.locale;

    querySlotsRun++;
    let slotArticles = 0;
    let slotRaw = 0;

    for (let page = 1; page <= slot.calls; page++) {
      const result = await fetchPage(baseUrl, params, page);
      apiCallsUsed++;

      // Check usage exhaustion (HTTP 402 returns empty with remaining=0)
      if (result.usageLimitRemaining === 0) {
        console.warn('[TNA] ⚠ Usage limit exhausted — stopping early');
        usageExhausted = true;
        usageLimitRemaining = 0;
        break;
      }

      // Track remaining usage
      if (result.usageLimitRemaining !== null) {
        usageLimitRemaining = result.usageLimitRemaining;
      }

      totalRawArticles += result.articles.length;
      slotRaw += result.articles.length;

      if (page === 1) {
        console.log(
          `[TNA] ${slot.label} [${slot.region}] pg 1/${slot.calls} ` +
          `— ${result.articles.length} results (pool: ${result.metaFound})` +
          (slot.search ? ' [relevance_score active]' : '')
        );
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

      // Pagination: stop if fewer results returned than requested
      if (result.metaReturned < ARTICLES_PER_CALL) break;

      // Safety: stop if zero results — no point paginating
      if (result.articles.length === 0) break;
    }

    if (slotArticles > 0) {
      console.log(`[TNA]   → ${slotArticles} unique articles from "${slot.label}"`);
    }

    if (usageExhausted) break;
  }

  // Log F9 summary
  if (f9RejectedCount > 0) {
    console.log(`[TNA] F9 pre-filter rejected ${f9RejectedCount} articles (relevance_score < ${F9_RELEVANCE_THRESHOLD})`);
  }

  // Log quota summary
  if (!usageExhausted) {
    // Estimate remaining calls from apiCallsUsed vs budget
    const callsRemaining = Math.max(0, REQUESTS_PER_DAY - apiCallsUsed);
    console.log(
      `[TNA] Quota: ~${callsRemaining} calls remaining after ${apiCallsUsed} calls` +
      (usageLimitRemaining !== null ? ` (API reports ${usageLimitRemaining} remaining)` : '')
    );
  }

  console.log(
    `[TNA] Complete: ${allArticles.length} normalized articles from ${apiCallsUsed} API calls ` +
    `(${f9RejectedCount} F9-rejected, ${duplicateUrlsDropped} duplicates dropped)`
  );

  return {
    articles: allArticles,
    stats: {
      querySlotsRun,
      apiCallsUsed,
      totalRawArticles,
      normalizedCount: allArticles.length,
      f9RejectedCount,
      duplicateUrlsDropped,
      usageLimitRemaining,
      usageExhausted,
    },
  };
}
