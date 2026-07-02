/**
 * newsdataFetcher.ts — NewsData.io fetcher + normalizer
 *
 * Fetches articles from the NewsData.io /api/1/latest endpoint using 20
 * category-first query slots (8 India, 12 global) with nextPage token
 * pagination. Returns NormalizedArticle[] ready for the structural filter
 * pipeline (F1–F7).
 *
 * Key constraints:
 *   - 200 credits/day budget; 1 credit per call
 *   - 10 results/call max on free tier (size param)
 *   - Rate limit: 30 credits per 15-minute window
 *   - Pagination via nextPage token (pass as page=<token>)
 *   - `content` field paywalled — returns "ONLY AVAILABLE IN PAID PLANS"
 *   - Free tier has ~12-hour indexing delay — no articles in last 12h
 *   - `timeframe` param is NOT available on free tier (verified from plan
 *     comparison table: "Timeframe | No" for Free tier)
 *   - `q` (keyword search) available with 100-char limit on free tier
 *   - AND/OR/NOT operators in `q` likely paid-only ("Advance Search | No"
 *     for Free tier) — use single-keyword `q` values only
 *   - Client-side staleness filter: uses STALENESS_CUTOFF_HOURS from shared constants
 *   - Per-API description floor for F3 filter: >= 200 chars
 *   - source_priority > 10000 rejected at normalizer level (pre-filter)
 *   - removeduplicate=1 on all calls
 *   - language=en on all calls
 *
 * Slot budget accounting:
 *   India:   8 calls  (politics, business, technology, science+health+env,
 *                       world, corruption-q, economy-q, top)
 *   Global: 12 calls  (politics×2pg, business, technology, sci+health+env,
 *                       world, corruption-q, governance-q, investigation-q,
 *                       cybersecurity-q, inflation-q, health, top)
 *   Total:  20 calls  = 200 credits (full daily budget)
 *
 * Normalization rules (from §4.2 + task constraints):
 *   - `description` → content (longest available text on free tier, ~1,017
 *     chars avg)
 *   - `description: null` in NormalizedArticle (no separate short summary)
 *   - source_priority > 10000 → skip at normalizer, count separately
 *   - content/image_url/sentime_gpt/ai_tag/ai_region/ai_org may contain
 *     "ONLY AVAILABLE IN PAID PLANS" sentinel → detect and nullify
 *   - keywords: filter usn:*, vguid:*, 2026:newsml*, I/* patterns and
 *     keywords > 60 chars; clean sentinel values
 *   - source_url → domain extraction for sourceDomain; source_id is NOT a
 *     domain (it's an internal identifier)
 *   - Date format: "YYYY-MM-DD HH:MM:SS" with separate pubDateTZ
 *     (typically "UTC")
 *   - `duplicate` flag → apiDuplicateFlag
 *   - source_priority → apiSourcePriority (lower = more authoritative)
 *
 * Free-tier enhancement opportunities (verified available but outside
 * explicit parameter list — add to slotParams if desired):
 *   - prioritydomain=top — filter to top 10% authority domains
 *   - sort=source — sort by source_priority (highest authority first)
 *   - datatype=news,analysis — filter to news/analysis articles only
 *   - excludecategory=sports,food,travel,entertainment — reject noise
 */

import type { NormalizedArticle } from '../../types/index.js';
import { computeTitleHash, computeNormalizedUrlHash, computeDomainTitleHash } from '../titleNormalizer.js';
import { STALENESS_CUTOFF_HOURS } from '../../config/constants.js';

// ── Query Definitions ──
// 20 query slots (8 India, 12 global) totaling 20 API calls = 200 credits.
// Every call includes: language=en, removeduplicate=1, size=10, apikey=KEY.
// nextPage token pagination: pages > 1 means follow nextPage tokens.

interface QuerySlot {
  label: string;
  region: 'india' | 'global';
  category?: string;          // comma-separated categories (max 5 on free tier)
  country?: string;           // include country (e.g. 'in' for India)
  excludecountry?: string;    // exclude country (e.g. 'in' for global slots)
  q?: string;                 // single-keyword search (no AND/OR/NOT on free tier)
  pages: number;              // nextPage pagination depth (1 page = 1 API call)
}

const QUERIES: QuerySlot[] = [
  // ── India (8 calls, 8 slots) — country=in on all ──
  {
    label: 'IN Politics',
    category: 'politics',
    country: 'in',
    region: 'india',
    pages: 1,
  },
  {
    label: 'IN Business',
    category: 'business',
    country: 'in',
    region: 'india',
    pages: 1,
  },
  {
    label: 'IN Technology',
    category: 'technology',
    country: 'in',
    region: 'india',
    pages: 1,
  },
  {
    label: 'IN Sci+Health+Env',
    category: 'science,health,environment',
    country: 'in',
    region: 'india',
    pages: 1,
  },
  {
    label: 'IN World',
    category: 'world',
    country: 'in',
    region: 'india',
    pages: 1,
  },
  {
    label: 'IN Accountability',
    category: 'politics',
    country: 'in',
    region: 'india',
    q: 'corruption',
    pages: 1,
  },
  {
    label: 'IN Economy Focus',
    category: 'business',
    country: 'in',
    region: 'india',
    q: 'economy',
    pages: 1,
  },
  {
    label: 'IN Top/Breaking',
    category: 'top',
    country: 'in',
    region: 'india',
    pages: 1,
  },

  // ── Global (12 calls, 11 slots) — excludecountry=in on all ──
  {
    label: 'Global Politics',
    category: 'politics',
    excludecountry: 'in',
    region: 'global',
    pages: 2,  // 2 calls — politics has highest useful-news volume
  },
  {
    label: 'Global Business',
    category: 'business',
    excludecountry: 'in',
    region: 'global',
    pages: 1,
  },
  {
    label: 'Global Technology',
    category: 'technology',
    excludecountry: 'in',
    region: 'global',
    pages: 1,
  },
  {
    label: 'Global Sci+Health+Env',
    category: 'science,health,environment',
    excludecountry: 'in',
    region: 'global',
    pages: 1,
  },
  {
    label: 'Global World',
    category: 'world',
    excludecountry: 'in',
    region: 'global',
    pages: 1,
  },
  {
    label: 'Global Accountability',
    category: 'politics',
    excludecountry: 'in',
    region: 'global',
    q: 'corruption',
    pages: 1,
  },
  {
    label: 'Global Policy',
    category: 'politics',
    excludecountry: 'in',
    region: 'global',
    q: 'governance',
    pages: 1,
  },
  {
    label: 'Global Biz Investigation',
    category: 'business',
    excludecountry: 'in',
    region: 'global',
    q: 'investigation',
    pages: 1,
  },
  {
    label: 'Global Cybersecurity',
    category: 'technology',
    excludecountry: 'in',
    region: 'global',
    q: 'cybersecurity',
    pages: 1,
  },
  {
    label: 'Global Inflation',
    category: 'business',
    excludecountry: 'in',
    region: 'global',
    q: 'inflation',
    pages: 1,
  },
  {
    label: 'Global Health',
    category: 'health',
    excludecountry: 'in',
    region: 'global',
    pages: 1,
  },
  {
    label: 'Global Top/Breaking',
    category: 'top',
    excludecountry: 'in',
    region: 'global',
    pages: 1,
  },
];

const ENDPOINT = 'https://newsdata.io/api/1/latest';
const RESULTS_PER_CALL = 10;          // Free tier max
const DAILY_CREDIT_BUDGET = 200;
const SOURCE_PRIORITY_REJECT = 10000;  // source_priority > 10000 → reject
const DESCRIPTION_FLOOR = 200;        // F3 per-API minimum description chars
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

// ── Sentinel Detection ──
// NewsData.io returns "ONLY AVAILABLE IN PAID PLANS" for paywalled fields.
// On some responses the substring is truncated to "ONLY AVAILABLE IN".

function isGatedSentinel(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.includes('ONLY AVAILABLE IN PAID PLANS') ||
         value.includes('ONLY AVAILABLE IN');
}

// ── Keyword Cleaning ──
// Filter out Reuters-style internal IDs (usn:, vguid:, 2026:newsml, I/)
// and any keyword > 60 chars. Clean sentinel values.

const KEYWORD_NOISE_PATTERNS = /^(usn:|vguid:|2026:newsml|I\/)/;

function cleanKeywords(keywords: unknown): string[] {
  if (!Array.isArray(keywords)) return [];
  return keywords
    .filter((kw): kw is string => typeof kw === 'string' && kw.length > 0)
    .filter(kw => !isGatedSentinel(kw))
    .filter(kw => !KEYWORD_NOISE_PATTERNS.test(kw))
    .filter(kw => kw.length <= 60);
}

// ── Domain Extraction ──
// source_url is the domain-level URL of the source (e.g. "https://www.bbc.co.uk").
// Fallback: extract domain from the article link URL.
// source_id is NOT a domain — it's an internal NewsData.io identifier.

function extractDomain(sourceUrl: unknown, fallbackUrl: string): string {
  // Try source_url first
  if (typeof sourceUrl === 'string' && sourceUrl.length > 0) {
    try {
      return new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, '');
    } catch { /* fall through */ }
  }
  // Fallback: extract from article link
  try {
    return new URL(fallbackUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ── Date Parsing ──
// NewsData.io returns pubDate as "YYYY-MM-DD HH:MM:SS" with a separate
// pubDateTZ field (typically "UTC"). Both fields are always present on the
// latest endpoint (10/10 population in §18).

function parseNewsdataDate(raw: string, tz: string | null): Date {
  const trimmed = raw.trim();
  // Replace space with T for ISO-like format
  const isoStr = trimmed.replace(' ', 'T');

  // If timezone is explicitly UTC (or not provided), treat as UTC
  if (!tz || tz.toUpperCase() === 'UTC') {
    const d = new Date(isoStr + 'Z');
    if (!isNaN(d.getTime())) return d;
  }

  // If timezone is a named tz, try parsing with that offset
  // Most common case is UTC; others are rare but handled by Date fallback
  const d = new Date(isoStr);
  if (!isNaN(d.getTime())) return d;

  // Last resort — will be caught by staleness filter
  return new Date();
}

// ── Normalizer ──

function normalize(raw: Record<string, unknown>): NormalizedArticle | null {
  const url = (raw.link as string) ?? '';
  const title = (raw.title as string) ?? '';
  const articleId = (raw.article_id as string) ?? null;
  if (!url || !title) return null;

  // ── source_priority pre-filter ──
  // source_priority > 10000 → reject at normalizer (design constraint #5)
  const sourcePriority = typeof raw.source_priority === 'number'
    ? raw.source_priority
    : null;
  // Note: caller checks sourcePriority and counts rejections separately,
  // because returning null doesn't let us distinguish rejection reasons.
  // We flag it here; the caller checks and logs.

  // ── Domain extraction ──
  const domain = extractDomain(raw.source_url, url);

  // ── Date parsing ──
  const pubDateStr = (raw.pubDate as string) ?? '';
  const pubDateTz = (raw.pubDateTZ as string) ?? null;
  const publishedAt = pubDateStr
    ? parseNewsdataDate(pubDateStr, pubDateTz)
    : new Date();

  // ── Text fields ──
  // description → content (longest free-tier text, ~1,017 chars avg)
  // description field in NormalizedArticle = null (no separate short summary)
  let content: string | null = (raw.description as string) ?? null;
  if (content && isGatedSentinel(content)) content = null;

  // content field is paywalled — detect sentinel and set to null
  const rawContent = (raw.content as string) ?? null;
  if (rawContent && isGatedSentinel(rawContent)) {
    // Leave as null — paywalled content
  }

  // ── Other sentinel-prone fields ──
  const imageUrl = isGatedSentinel(raw.image_url) ? null : (raw.image_url as string | null) ?? null;
  const sentimeGpt = isGatedSentinel(raw.sentime_gpt) ? null : (raw.sentime_gpt as string | null) ?? null;
  const aiTag = isGatedSentinel(raw.ai_tag) ? null : (raw.ai_tag as string | null) ?? null;
  const aiRegion = isGatedSentinel(raw.ai_region) ? null : (raw.ai_region as string | null) ?? null;
  const aiOrg = isGatedSentinel(raw.ai_org) ? null : (raw.ai_org as string | null) ?? null;

  // ── Keywords ──
  const keywords = cleanKeywords(raw.keywords);

  // ── Creator → author ──
  const creators = Array.isArray(raw.creator) ? (raw.creator as string[]) : [];
  const author = creators.length > 0 ? creators[0] : null;

  // ── Country ──
  const countries = Array.isArray(raw.country) ? (raw.country as string[]) : [];
  const apiCountry = countries.length > 0 ? countries.join(',').toLowerCase() : null;

  // ── Category ──
  const categories = Array.isArray(raw.category) ? (raw.category as string[]) : [];
  const apiCategory = categories.length > 0 ? categories.join(', ') : null;

  // ── Duplicate flag ──
  const duplicateFlag = typeof raw.duplicate === 'boolean' ? raw.duplicate : null;

  // ── Datatype ──
  // (Not mapped to NormalizedArticle — not in the shared interface)

  // ── Dedup hashes ──
  const titleHash = computeTitleHash(title);
  const normalizedUrlHash = computeNormalizedUrlHash(url);
  const domainTitleHash = computeDomainTitleHash(domain, title);

  return {
    externalId:        articleId,
    sourceApi:         'newsdata',
    url,

    title,
    description:       null,  // No separate short summary from NewsData.io
    content,                      // description field → content
    imageUrl,

    author,
    sourceName:         ((raw.source_name as string) ?? null) || domain || null,
    sourceDomain:       domain,

    publishedAt,
    fetchedAt:          new Date(),

    apiCategory,
    apiIptcCategory:    null,                            // NewsData.io doesn't provide IPTC
    apiSentiment:       null,                            // sentiment is paid-only
    apiLanguage:        (raw.language as string) ?? 'en',
    apiCountry,
    apiKeywords:        keywords,
    apiEntities:        [],                              // No entities on free tier
    apiSourcePriority:  sourcePriority,
    apiRelevanceScore:  null,                            // TheNewsAPI-only
    apiDomainRank:      null,                            // Webz.io-only
    apiPerformance:     null,                            // Webz.io-only
    apiSocial:          null,                            // Webz.io-only
    apiDuplicateFlag:   duplicateFlag,

    titleHash,
    normalizedUrlHash,
    domainTitleHash,
  };
}

// ── API Fetch ──

interface FetchPageResult {
  articles: Record<string, unknown>[];
  nextPage: string | null;
  totalResults: number;
}

async function fetchPage(
  params: Record<string, string>,
  pageToken?: string,
): Promise<FetchPageResult> {
  const urlParams = new URLSearchParams(params);
  urlParams.set('size', String(RESULTS_PER_CALL));
  if (pageToken) urlParams.set('page', pageToken);

  const url = `${ENDPOINT}?${urlParams.toString()}`;
  const res = await rateLimitedFetch(url);

  if (!res.ok) {
    // 429 = rate limit exceeded — stop immediately
    if (res.status === 429) {
      console.warn('[NEWSDATA] ⚠ Rate limit exceeded (429) — stopping');
      return { articles: [], nextPage: null, totalResults: -1 };  // -1 = rate limit hit
    }
    const body = await res.text().catch(() => '');
    console.error(`[NEWSDATA] API error ${res.status}: ${body.slice(0, 200)}`);
    return { articles: [], nextPage: null, totalResults: 0 };
  }

  const data = await res.json() as {
    status?: string;
    results?: Record<string, unknown>[];
    nextPage?: string;
    totalResults?: number;
  };

  // Check for error status in response body (can happen even on HTTP 200)
  if (data.status === 'error') {
    console.error(`[NEWSDATA] API returned error status in response body`);
    return { articles: [], nextPage: null, totalResults: 0 };
  }

  return {
    articles: data.results ?? [],
    nextPage: data.nextPage ?? null,
    totalResults: data.totalResults ?? 0,
  };
}

// ── Main Export ──

export interface NewsdataFetchResult {
  articles: NormalizedArticle[];
  stats: {
    querySlotsRun: number;
    apiCallsUsed: number;
    creditsConsumed: number;
    totalRawArticles: number;
    normalizedCount: number;
    duplicateUrlsDropped: number;
    sourcePriorityRejected: number;
    rateLimitHit: boolean;
  };
}

/**
 * Fetch articles from all 20 NewsData.io query slots.
 * Uses 20 API calls/day of the 200 credit budget.
 *
 * Pipeline calls this as: `const nd = await fetchNewsdata();`
 */
export async function fetchNewsdata(): Promise<NewsdataFetchResult> {
  const apiKey = process.env.NEWSDATA_API_KEY;
  if (!apiKey) {
    console.warn('[NEWSDATA] No NEWSDATA_API_KEY set — skipping NewsData.io fetch');
    return {
      articles: [],
      stats: {
        querySlotsRun: 0, apiCallsUsed: 0, creditsConsumed: 0,
        totalRawArticles: 0, normalizedCount: 0, duplicateUrlsDropped: 0,
        sourcePriorityRejected: 0, rateLimitHit: false,
      },
    };
  }

  // Client-side staleness cutoff (uses shared STALENESS_CUTOFF_HOURS from constants)
  const stalenessCutoff = new Date(Date.now() - STALENESS_CUTOFF_HOURS * 3600000);

  // Base params for every call
  const baseParams: Record<string, string> = {
    apikey: apiKey,
    language: 'en',
    removeduplicate: '1',
  };

  const allArticles: NormalizedArticle[] = [];
  const seenUrls = new Set<string>();   // Dedup within this fetch run
  let querySlotsRun = 0;
  let apiCallsUsed = 0;
  let totalRawArticles = 0;
  let duplicateUrlsDropped = 0;
  let sourcePriorityRejected = 0;
  let rateLimitHit = false;

  for (const slot of QUERIES) {
    // Build slot-specific params
    const params: Record<string, string> = { ...baseParams };
    if (slot.category) params.category = slot.category;
    if (slot.country) params.country = slot.country;
    if (slot.excludecountry) params.excludecountry = slot.excludecountry;
    if (slot.q) params.q = slot.q;

    querySlotsRun++;
    let nextPageToken: string | null = null;
    let slotArticles = 0;

    for (let page = 0; page < slot.pages; page++) {
      const result = await fetchPage(params, nextPageToken || undefined);
      apiCallsUsed++;

      // Rate limit hit — stop all fetching
      if (result.totalResults < 0) {
        rateLimitHit = true;
        break;
      }

      totalRawArticles += result.articles.length;

      if (page === 0) {
        const countryLabel = slot.country ?? `ex:${slot.excludecountry ?? ''}`;
        const qLabel = slot.q ? ` q="${slot.q}"` : '';
        console.log(
          `[NEWSDATA] ${slot.label} [${slot.region}] pg 1/${slot.pages} — ` +
          `${result.articles.length} results (pool: ${result.totalResults}) ` +
          `cat=${slot.category ?? 'all'} ${countryLabel}${qLabel}`
        );
      }

      for (const rawArticle of result.articles) {
        // ── source_priority pre-filter (normalizer level) ──
        const sp = typeof rawArticle.source_priority === 'number'
          ? rawArticle.source_priority
          : null;
        if (sp !== null && sp > SOURCE_PRIORITY_REJECT) {
          sourcePriorityRejected++;
          continue;  // Don't even normalize — too low authority
        }

        const article = normalize(rawArticle);
        if (!article) continue;

        // ── Client-side staleness filter ──
        // (timeframe param is paid-only, so we filter here)
        if (article.publishedAt < stalenessCutoff) continue;

        // ── Description floor (F3 per-API) ──
        if (article.content && article.content.length < DESCRIPTION_FLOOR) continue;

        // ── Within-run dedup by normalized URL hash ──
        if (seenUrls.has(article.normalizedUrlHash)) {
          duplicateUrlsDropped++;
          continue;
        }
        seenUrls.add(article.normalizedUrlHash);

        allArticles.push(article);
        slotArticles++;
      }

      // Next page token for pagination
      nextPageToken = result.nextPage;

      // No point paginating if no nextPage or no results
      if (!nextPageToken || result.articles.length === 0) break;
    }

    if (slotArticles > 0) {
      console.log(`[NEWSDATA]   → ${slotArticles} unique articles from "${slot.label}"`);
    }

    if (rateLimitHit) break;
  }

  // Log summary
  if (sourcePriorityRejected > 0) {
    console.log(`[NEWSDATA] source_priority > ${SOURCE_PRIORITY_REJECT} rejected: ${sourcePriorityRejected}`);
  }
  if (rateLimitHit) {
    console.warn(`[NEWSDATA] ⚠ Rate limit hit after ${apiCallsUsed} calls — stopped early`);
  } else {
    console.log(`[NEWSDATA] Credits: ${apiCallsUsed}/${DAILY_CREDIT_BUDGET} used`);
  }
  console.log(`[NEWSDATA] Complete: ${allArticles.length} normalized articles from ${apiCallsUsed} API calls`);

  return {
    articles: allArticles,
    stats: {
      querySlotsRun,
      apiCallsUsed,
      creditsConsumed: apiCallsUsed,
      totalRawArticles,
      normalizedCount: allArticles.length,
      duplicateUrlsDropped,
      sourcePriorityRejected,
      rateLimitHit,
    },
  };
}
