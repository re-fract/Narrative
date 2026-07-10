import { Agent, fetch as undiFetch } from 'undici';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { pool } from '../db/index.js';
import {
  SCRAPE_CONCURRENCY,
  SCRAPE_DOMAIN_COOLDOWN_HOURS,
  SCRAPE_FAILURE_THRESHOLD,
  SCRAPE_THIN_CONTENT_CHARS,
  TITLE_SIMILARITY_LOOKUP,
} from '../config/constants.js';

// ── Custom undici Agent for scraping ──
// Default undici maxHeaderSize is ~16KB; CDN-heavy sites (Cloudflare etc.)
// send massive Set-Cookie/security headers that overflow that limit.
// Bumping to 64KB resolves HeadersOverflowError on those sites.
const scrapeAgent = new Agent({ maxHeaderSize: 65536 });

// ── Module-level quota exhaustion flag ──
// Set on HTTP 402 or missing env key; reset at start of each enrichArticles() call
let quotaExhausted = false;

// ── WorldNewsAPI circuit breaker ──
// If N consecutive lookup calls fail, stop trying for the rest of the pipeline run.
const WN_CIRCUIT_BREAKER_THRESHOLD = 3;
let wnConsecutiveFailures = 0;
let wnCircuitOpen = false;

export function resetEnrichmentQuota(): void {
  quotaExhausted = false;
  wnConsecutiveFailures = 0;
  wnCircuitOpen = false;
}

// ── Trigram similarity (Jaccard on character trigrams) ──
// Reuses the same pattern as filters/deduplicator.ts

function trigrams(s: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < s.length - 2; i++) result.push(s.slice(i, i + 3));
  return result;
}

function trigramSim(a: string, b: string): number {
  const triA = new Set(trigrams(a.toLowerCase()));
  const triB = new Set(trigrams(b.toLowerCase()));
  let intersection = 0;
  for (const t of triA) {
    if (triB.has(t)) intersection++;
  }
  return intersection / (triA.size + triB.size - intersection);
}

// ── WorldNewsAPI text lookup ──

async function lookupFullText(
  title: string,
  sourceApi: string,
): Promise<{ text: string | null; source: string }> {
  // Skip if article already came from WorldNewsAPI (has its own text)
  if (sourceApi === 'worldnews') {
    return { text: null, source: 'already_has_text' };
  }

  const apiKey = process.env.WORLDNEWS_API_KEY;
  if (!apiKey) {
    quotaExhausted = true;
    return { text: null, source: 'quota_exhausted' };
  }

  // Circuit breaker: skip if too many consecutive failures this run
  if (wnCircuitOpen) {
    return { text: null, source: 'circuit_open' };
  }

  try {
    const params = new URLSearchParams({
      'api-key': apiKey,
      text: title.substring(0, 100),
      language: 'en',
      number: '3',
      sort: 'publish-time',
      sort_direction: 'DESC',
    });

    const resp = await undiFetch(
      `https://api.worldnewsapi.com/search-news?${params}`,
      {
        signal: AbortSignal.timeout(15_000),
        dispatcher: scrapeAgent,
      },
    );

    if (resp.status === 402) {
      quotaExhausted = true;
      console.warn('[LOOKUP] WorldNewsAPI quota exhausted (402)');
      return { text: null, source: 'quota_exhausted' };
    }

    const data = (await resp.json()) as {
      news?: Array<{ title?: string; text?: string }>;
    };

    if (data.news && data.news.length > 0) {
      // Find best match by title trigram similarity
      const best = data.news.find(
        (n) =>
          n.title &&
          trigramSim(n.title, title) > TITLE_SIMILARITY_LOOKUP &&
          n.text &&
          n.text.length >= SCRAPE_THIN_CONTENT_CHARS,
      );
      if (best?.text) {
        wnConsecutiveFailures = 0; // success resets the breaker
        return { text: best.text, source: 'lookup' };
      }
    }
  } catch (err: unknown) {
    wnConsecutiveFailures++;
    if (wnConsecutiveFailures >= WN_CIRCUIT_BREAKER_THRESHOLD) {
      wnCircuitOpen = true;
      console.warn(`[LOOKUP] WorldNewsAPI circuit breaker opened after ${wnConsecutiveFailures} consecutive failures`);
    } else {
      const code = (err as { cause?: { code?: string } })?.cause?.code ?? '';
      const label = code === 'UND_ERR_CONNECT_TIMEOUT' ? 'timeout' : 'error';
      console.warn(`[LOOKUP] WorldNewsAPI ${label} (${wnConsecutiveFailures}/${WN_CIRCUIT_BREAKER_THRESHOLD}):`, (err as Error).message ?? err);
    }
  }

  return { text: null, source: 'not_found' };
}

// ── Text normalization helpers (unchanged) ──

function normalizeArticleText(text: string): string {
  if (!text) return text;

  let normalized = text
    // Collapse runs of whitespace (newlines, tabs, multiple spaces)
    .replace(/\s+/g, ' ')
    .trim();

  // Fix missing spaces between words that were concatenated when
  // inline HTML elements were stripped (e.g. <span>one</span><span>Two</span>)
  // 1. lowercase letter followed by uppercase letter + lowercase (e.g. "agoRachel" -> "ago Rachel")
  normalized = normalized.replace(/([a-z])([A-Z][a-z])/g, '$1 $2');

  // 2. letter immediately followed by a comma/semicolon and then uppercase (e.g. "Murphy,BBC" -> "Murphy, BBC")
  normalized = normalized.replace(/([a-zA-Z])([,;])([A-Z])/g, '$1$2 $3');

  return normalized;
}

function stripLeadingBylines(text: string, byline?: string): string {
  if (!text) return text;
  if (!byline || byline.trim().length < 2) return text;

  const blocks = text.split('\n\n');
  const cleaned: string[] = [];
  let count = 0;
  const bl = byline.trim().toLowerCase();

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (count >= 3) {
      cleaned.push(block);
      continue;
    }

    const lower = trimmed.toLowerCase();
    let isByline = false;

    // Exact match with byline
    if (lower === bl) {
      isByline = true;
    }
    // Paragraph contains the byline and is short enough to be a byline
    else if (lower.includes(bl)) {
      const ratio = bl.length / trimmed.length;
      if (ratio > 0.5 || trimmed.length < bl.length + 40) {
        isByline = true;
      }
    }
    // Byline contains this short paragraph (partial match, e.g. "BBC News" in a longer byline)
    else if (trimmed.length > 0 && trimmed.length < bl.length && bl.includes(lower)) {
      isByline = true;
    }

    if (isByline) {
      count++;
      continue;
    }

    // Additional metadata paragraph right after a byline (date, time, etc.)
    if (count > 0 && trimmed.length < 80 && !trimmed.endsWith('.')) {
      const metaRe = /(ago$|hour|minute|published|updated|correspondent|reporter|editor|analyst|staff)/i;
      if (metaRe.test(trimmed)) {
        count++;
        continue;
      }
    }

    cleaned.push(block);
  }

  const result = cleaned.join('\n\n');
  // Safety: don't remove more than 60% of the article
  if (result.length < text.length * 0.4) return text;
  return result;
}

function withCssWarningsSuppressed<T>(fn: () => T): T {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('Could not parse CSS stylesheet')
    ) {
      return;
    }
    original.apply(console, args as [string, ...unknown[]]);
  };
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

// ── Public scraping API (unchanged) ──

export async function scrapeArticleWithStatus(url: string): Promise<{ text: string | null; status: 'failed' | 'thin' | 'full' }> {
  const text = await fetchArticleText(url);
  if (!text || text.length < 50) {
    return { text, status: 'failed' };
  }
  if (text.length < 300) {
    return { text, status: 'thin' };
  }
  return { text, status: 'full' };
}

export async function fetchArticleText(url: string): Promise<string | null> {
  try {
    const response = await undiFetch(url, {
      signal: AbortSignal.timeout(15000),
      dispatcher: scrapeAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    let article: any;
    withCssWarningsSuppressed(() => {
      const jsdom = new JSDOM(html, { url });
      const reader = new Readability(jsdom.window.document);
      article = reader.parse();
    });

    if (!article) {
      return null;
    }

    const bylineText = (article.byline || '').trim();
    let text: string;

    if (article.content) {
      // Parse Readability's cleaned HTML for better text extraction
      const articleDom = new JSDOM(article.content);
      const doc = articleDom.window.document;
      const body = doc.body;

      if (!body) {
        text = article.textContent?.trim() || '';
      } else {
        // Walk all relevant structural elements in order, preserving headings
        const elements = body.querySelectorAll('h2, h3, h4, h5, h6, p, blockquote');
        const parts: string[] = [];
        elements.forEach((el) => {
          const elText = el.textContent?.trim();
          if (!elText || elText.length === 0) return;

          const tag = el.tagName.toLowerCase();
          const normalized = normalizeArticleText(elText);

          if (tag.startsWith('h')) {
            // Mark headings so the frontend can render them distinctly
            parts.push(`###HEADING:###${normalized}`);
          } else if (tag === 'blockquote') {
            parts.push(normalized);
          } else {
            parts.push(normalized);
          }
        });
        text = parts.join('\n\n');
      }
    } else {
      text = normalizeArticleText(article.textContent?.trim() || '');
    }

    // Remove byline paragraphs that got included in the article body
    text = stripLeadingBylines(text, bylineText || undefined);

    if (!text || text.length < 50) return null;
    return text;
  } catch (err: unknown) {
    const code = (err as { cause?: { code?: string } })?.cause?.code ?? '';
    // Known-recoverable network errors: downgraded to warn, not error
    if (code === 'UND_ERR_HEADERS_OVERFLOW' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      console.warn(`fetchArticleText ${code}: ${url}`);
    } else {
      console.error('fetchArticleText failed:', err);
    }
    return null;
  }
}

// ── Main enrichment entry point ──

export async function enrichArticles(articleIds: number[]): Promise<void> {
  // Reset quota flag at start of each pipeline run
  quotaExhausted = false;

  if (articleIds.length === 0) return;

  // Query articles for enrichment
  const articlesRes = await pool.query<{
    id: number;
    url: string;
    title: string;
    source_api: string;
    content: string | null;
    full_text: string | null;
    scrape_status: string | null;
    source_domain: string | null;
  }>(
    `SELECT id, url, title, source_api, content, full_text, scrape_status, source_domain
     FROM articles
     WHERE id = ANY($1)`,
    [articleIds],
  );

  if (articlesRes.rows.length === 0) return;

  // Query domain cooldown: skip domains with ≥ SCRAPE_FAILURE_THRESHOLD consecutive failures
  // in the last SCRAPE_DOMAIN_COOLDOWN_HOURS hours
  const cooldownResult = await pool.query<{ source_domain: string }>(
    `SELECT source_domain
     FROM articles
     WHERE scrape_status = 'failed'
       AND fetched_at >= NOW() - INTERVAL '1 hour' * $1
     GROUP BY source_domain
     HAVING COUNT(*) >= $2`,
    [SCRAPE_DOMAIN_COOLDOWN_HOURS, SCRAPE_FAILURE_THRESHOLD],
  );
  const cooldownDomains = new Set(
    cooldownResult.rows.map((r) => r.source_domain).filter(Boolean),
  );

  const articles = articlesRes.rows.filter(
    (a) => !a.source_domain || !cooldownDomains.has(a.source_domain),
  );

  // Collect results in memory — avoid touching the DB during the long scrape
  // phase (can be 10-20 min for 150+ articles). Neon scales to zero during that
  // window; calling pool.connect() per-article fails once compute goes cold.
  const results: { id: number; fullText: string | null; scrapeStatus: string }[] = [];

  // Track stats
  let fullCount = 0;
  let thinCount = 0;
  let lookupCount = 0;
  let failedCount = 0;

  // Process in chunks of SCRAPE_CONCURRENCY
  for (let i = 0; i < articles.length; i += SCRAPE_CONCURRENCY) {
    const chunk = articles.slice(i, i + SCRAPE_CONCURRENCY);

    const chunkResults = await Promise.all(
      chunk.map(async (article) => {
        let fullText: string | null = article.full_text;
        let scrapeStatus: string = article.scrape_status ?? 'pending';

        // 1. WorldNewsAPI articles that already have content → set directly
        if (
          article.source_api === 'worldnews' &&
          article.content &&
          article.content.length >= SCRAPE_THIN_CONTENT_CHARS
        ) {
          fullText = article.content;
          scrapeStatus = 'lookup';
          lookupCount++;
        } else {
          // 2. Attempt JSDOM+Readability scrape
          try {
            const { text, status } = await scrapeArticleWithStatus(article.url);

            if (status === 'full') {
              fullText = text;
              scrapeStatus = 'full';
              fullCount++;
            } else if (status === 'thin') {
              fullText = text;
              scrapeStatus = 'thin';
              thinCount++;
            } else {
              // status === 'failed'
              scrapeStatus = 'failed';
              failedCount++;
            }
          } catch (err) {
            console.error(`[ENRICH] Scrape failed for article ${article.id}:`, err);
            scrapeStatus = 'failed';
            failedCount++;
          }

          // 3. If scrape failed/thin and quota not exhausted and circuit not open → try WorldNewsAPI lookup
          if (
            (scrapeStatus === 'failed' || scrapeStatus === 'thin') &&
            !quotaExhausted &&
            !wnCircuitOpen
          ) {
            const lookup = await lookupFullText(article.title, article.source_api);
            if (
              lookup.text &&
              lookup.text.length >= SCRAPE_THIN_CONTENT_CHARS
            ) {
              fullText = lookup.text;
              scrapeStatus = 'lookup';
              // Repurpose thin/failed counts — this article is now lookup
              if (scrapeStatus === 'thin') thinCount--;
              else if (scrapeStatus === 'failed') failedCount--;
              lookupCount++;
            }
          }
        }

        return { id: article.id, fullText, scrapeStatus };
      }),
    );

    results.push(...chunkResults);
  }

  // 4. Bulk-write all results in one DB roundtrip.
  // All scraping is done by this point, so we only need the DB alive for
  // a single moment — avoids Neon cold-start timeouts mid-scrape.
  if (results.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { id, fullText, scrapeStatus } of results) {
        await client.query(
          'UPDATE articles SET full_text = $1, scrape_status = $2 WHERE id = $3',
          [fullText, scrapeStatus, id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(
    `[ENRICH] Enriched ${articles.length} articles: ${fullCount} full, ${thinCount} thin, ${lookupCount} lookup, ${failedCount} failed` +
    (wnCircuitOpen ? ' [WN circuit OPEN]' : '') +
    (quotaExhausted ? ' [WN quota exhausted]' : ''),
  );
}
