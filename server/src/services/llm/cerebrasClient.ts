/**
 * cerebrasClient.ts — Cerebras LLM client
 *
 * Two models:
 *   - gpt-oss-120b: Classification (batch of 5, tier A/B/C/D)
 *   - zai-glm-4.7: Summarization + Simplification (per-article)
 *
 * Uses OpenAI SDK with custom baseURL (Cerebras is OpenAI-compatible).
 *
 * ⚠️ Critical: Do NOT use response_format: { type: 'json_object' }
 *   gpt-oss-120b returns clean JSON arrays natively.
 *   json_object mode wraps in {type:"array",items:[...]} — harder to parse.
 *
 * ⚠️ Critical: zai-glm-4.7 MUST use max_tokens: 4096 (summaries) or 8192 (simplify).
 *   The model uses 1000+ reasoning tokens before producing content.
 *   Lower values produce truncated/garbage output.
 */

import OpenAI from 'openai';
import { CLASSIFICATION_SYSTEM_PROMPT } from '../../config/classificationPrompt.js';
import { SUMMARY_SYSTEM_PROMPT, SIMPLIFY_SYSTEM_PROMPT } from '../../config/summarizationPrompt.js';
import {
  CLASSIFICATION_BATCH_SIZE,
  CLASSIFICATION_MODEL,
  CLASSIFICATION_TEMPERATURE,
  SUMMARIZATION_MODEL,
  SUMMARIZATION_TEMPERATURE,
  SUMMARIZATION_MAX_TOKENS,
  SIMPLIFICATION_MAX_TOKENS,
  CEREBRAS_RPM,
  CEREBRAS_RPD,
  VALID_LLM_CATEGORIES,
  VALID_LLM_TIERS,
} from '../../config/constants.js';
import type { NormalizedArticle, ClassificationResult, ScoredArticle } from '../../types/index.js';
import type { Pool } from 'pg';

// ── OpenAI Clients ──

const classifier = new OpenAI({
  apiKey: process.env.CEREBRAS_API_KEY,
  baseURL: 'https://api.cerebras.ai/v1',  // ✅ VERIFIED Phase 0 — NOT inference.cerebras.ai
});

const summarizer = new OpenAI({
  apiKey: process.env.CEREBRAS_API_KEY,
  baseURL: 'https://api.cerebras.ai/v1',  // ✅ VERIFIED Phase 0
});

// ── Rate Limiter ──

class CerebrasRateLimiter {
  private rpmCount: Map<string, number> = new Map();    // per model (Cerebras limits per model, not per key)
  private rpdCount: Map<string, number> = new Map();
  private minuteStart: number = Date.now();
  private lastResetDate: string = new Date().toISOString().slice(0, 10);
  private lastRequestTime: number = 0;                   // inter-request spacing
  private readonly RPM = CEREBRAS_RPM;
  private readonly RPD = CEREBRAS_RPD;
  private readonly MIN_REQUEST_GAP_MS = 2_000;          // 2s gap — prevents burst that exhausts 30K tok/min quota

  /** Reset RPD counters when the UTC day rolls over. */
  private checkDayReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.rpdCount.clear();
      this.lastResetDate = today;
    }
  }

  async waitForSlot(model: string): Promise<void> {
    this.checkDayReset();

    // Enforce minimum gap between requests (prevents burst token exhaustion)
    const gapNeeded = this.lastRequestTime + this.MIN_REQUEST_GAP_MS - Date.now();
    if (gapNeeded > 0) await sleep(gapNeeded);

    const now = Date.now();
    if (now - this.minuteStart > 60_000) {
      this.rpmCount.clear();
      this.minuteStart = now;
    }
    const rpm = this.rpmCount.get(model) ?? 0;
    if (rpm >= this.RPM) {
      const waitMs = this.minuteStart + 60_000 - now + 100;
      await sleep(waitMs);
      this.rpmCount.set(model, 0);
      this.minuteStart = Date.now();
    }
    const rpd = this.rpdCount.get(model) ?? 0;
    if (rpd >= this.RPD) throw new Error('RPD_EXHAUSTED');
    this.rpmCount.set(model, (this.rpmCount.get(model) ?? 0) + 1);
    this.rpdCount.set(model, rpd + 1);
    this.lastRequestTime = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Singleton rate limiter used by all LLM functions */
export const cerebrasRateLimiter = new CerebrasRateLimiter();

// ── Classification (gpt-oss-120b) ──

/**
 * Classify a batch of up to 5 articles using gpt-oss-120b.
 * Returns ScoredArticle[] with llmTier, llmCategory, llmReason, filterStatus.
 */
export async function classifyArticleBatch(
  articles: NormalizedArticle[],
): Promise<ScoredArticle[]> {
  if (articles.length === 0) return [];

  await cerebrasRateLimiter.waitForSlot(CLASSIFICATION_MODEL);

  let retried = false;

  const attempt = async (): Promise<ScoredArticle[]> => {
    try {
      const response = await classifier.chat.completions.create({
        model: CLASSIFICATION_MODEL,
        messages: [
          { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
          { role: 'user', content: buildClassificationUserMessage(articles) },
        ],
        temperature: CLASSIFICATION_TEMPERATURE,
        // ⚠️ NO response_format — gpt-oss-120b returns clean JSON arrays natively.
        // response_format: { type: 'json_object' } wraps in schema — DO NOT use it.
      });

      // Parse JSON from response
      let results: ClassificationResult[];
      try {
        const text = response.choices[0]?.message?.content ?? '';
        // Handle potential markdown code fences wrapping the JSON
        const jsonStr = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        results = JSON.parse(jsonStr);
      } catch {
        // JSON parse error — retry once, then all Tier C
        if (!retried) {
          retried = true;
          await cerebrasRateLimiter.waitForSlot(CLASSIFICATION_MODEL);
          return attempt();
        }
        return articles.map(a => ({
          ...a,
          llmTier: 'C' as const,
          llmCategory: 'none',
          llmReason: 'llm_parse_error',
          filterStatus: 'rejected' as const,
        }));
      }

      // Validate: must be array of same length as input
      if (!Array.isArray(results) || results.length !== articles.length) {
        return articles.map(a => ({
          ...a,
          llmTier: 'C' as const,
          llmCategory: 'none',
          llmReason: 'llm_count_mismatch',
          filterStatus: 'rejected' as const,
        }));
      }

      // Merge results with articles
      return articles.map((article, i) => {
        const r = results[i];
        const tier = (VALID_LLM_TIERS as readonly string[]).includes(r?.tier) ? r.tier : 'C';
        const category = (VALID_LLM_CATEGORIES as readonly string[]).includes(r?.category) ? r.category : 'none';
        const reason = typeof r?.reason === 'string' ? r.reason.substring(0, 200) : 'no_reason';

        return {
          ...article,
          llmTier: tier as 'A' | 'B' | 'C' | 'D',
          llmCategory: category,
          llmReason: reason,
          filterStatus: (tier === 'A' || tier === 'B') ? 'accepted' as const : 'rejected' as const,
        };
      });
    } catch (err: unknown) {
      const httpErr = err as { status?: number };

      // Rate limited — wait and retry
      if (httpErr.status === 429) {
        await sleep(12_000);  // Wait 12s for next RPM window
        return attempt();
      }

      // Server error — retry once, then all Tier C
      if (httpErr.status && httpErr.status >= 500) {
        if (!retried) {
          retried = true;
          await sleep(5_000);
          await cerebrasRateLimiter.waitForSlot(CLASSIFICATION_MODEL);
          return attempt();
        }
        return articles.map(a => ({
          ...a,
          llmTier: 'C' as const,
          llmCategory: 'none',
          llmReason: 'llm_server_error',
          filterStatus: 'rejected' as const,
        }));
      }

      throw err;
    }
  };

  return attempt();
}

// ── Summarization (zai-glm-4.7) ──

/**
 * Generate a 3-bullet summary for a single article.
 * Used by the pipeline for representative articles.
 */
export async function generateArticleSummary(
  title: string,
  text: string,
): Promise<string> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await cerebrasRateLimiter.waitForSlot(SUMMARIZATION_MODEL);

      const response = await summarizer.chat.completions.create({
        model: SUMMARIZATION_MODEL,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Summarize this article in exactly 3 concise bullet points:\n\nTitle: ${title}\n\n${text}`,
          },
        ],
        temperature: SUMMARIZATION_TEMPERATURE,
        max_tokens: SUMMARIZATION_MAX_TOKENS,  // ⚠️ MUST be 4096 — model uses 1000+ reasoning tokens
      });

      return response.choices[0]?.message?.content ?? '';
    } catch (err: unknown) {
      const httpErr = err as { status?: number };
      if (httpErr.status === 429 && attempt < MAX_RETRIES - 1) {
        const backoffMs = 15_000 * (attempt + 1);  // 15s, 30s, …
        console.warn(`[CEREBRAS] Summary 429 for "${title.slice(0, 40)}" — retry ${attempt + 1}/${MAX_RETRIES} in ${backoffMs / 1000}s`);
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }
  return '';  // unreachable, but TS needs it
}

/**
 * Simplify an article for general readers (request-time, cached in DB).
 * Checks simplifications cache first; generates and caches if not found.
 */
export async function simplifyArticle(
  articleId: number,
  text: string,
  dbPool: Pool,
): Promise<string> {
  // Check cache first
  const cached = await dbPool.query(
    'SELECT text FROM simplifications WHERE article_id = $1 AND level = $2',
    [articleId, 'simple'],
  );
  if (cached.rows.length > 0) {
    return cached.rows[0].text;
  }

  // Generate simplification
  await cerebrasRateLimiter.waitForSlot(SUMMARIZATION_MODEL);

  const response = await summarizer.chat.completions.create({
    model: SUMMARIZATION_MODEL,
    messages: [
      { role: 'system', content: SIMPLIFY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Simplify for a general reader — 2-3 paragraphs, 120-180 words, essay format, no bullet points:\n\n${text}`,
      },
    ],
    temperature: SUMMARIZATION_TEMPERATURE,
    max_tokens: SIMPLIFICATION_MAX_TOKENS,  // ⚠️ MUST be 8192 — simplify needs longer output
  });

  const simplified = response.choices[0]?.message?.content ?? '';

  // Cache result
  await dbPool.query(
    `INSERT INTO simplifications (article_id, level, text) VALUES ($1, 'simple', $2)
     ON CONFLICT (article_id, level) DO UPDATE SET text = $2`,
    [articleId, simplified],
  );

  return simplified;
}

/**
 * Generate a concise human-readable title for a story cluster.
 *
 * Sends the titles (+ brief description excerpts) of up to 10 articles in the
 * story to zai-glm-4.7 and asks for a 4–8 word headline-style title.
 *
 * Caching strategy: the title is written directly into stories.title in the DB.
 * If stories.title is already non-null this function is a no-op (title is only
 * generated once, even if the user unfollows and re-follows the same story).
 *
 * @param storyId - The story's DB id
 * @param dbPool  - pg Pool for reading articles and writing the title back
 * @returns The generated (or pre-existing) title, or null on failure
 */
export async function generateStoryTitle(
  storyId: number,
  dbPool: Pool,
): Promise<string | null> {
  // 1. Check if a title already exists — if so, skip generation entirely
  const existing = await dbPool.query<{ title: string | null }>(
    'SELECT title FROM stories WHERE id = $1',
    [storyId],
  );
  if (existing.rows.length === 0) return null;
  if (existing.rows[0].title && existing.rows[0].title.trim().length > 0) {
    return existing.rows[0].title.trim();
  }

  // 2. Fetch up to 10 articles for context — titles + short description
  //    We use titles only (not full_text) to keep the prompt compact and fast.
  //    Titles are sufficient for a naming task; full_text would waste tokens.
  const articlesRes = await dbPool.query<{ title: string; description: string | null }>(
    `SELECT title, description
     FROM articles
     WHERE story_id = $1
       AND filter_status = 'accepted'
     ORDER BY importance_score DESC NULLS LAST, published_at DESC
     LIMIT 10`,
    [storyId],
  );
  if (articlesRes.rows.length === 0) return null;

  // Build a compact content block: "1. <title> — <first 150 chars of description>"
  const articleLines = articlesRes.rows.map((a, i) => {
    const desc = a.description ? ` — ${a.description.slice(0, 150).trim()}` : '';
    return `${i + 1}. ${a.title}${desc}`;
  }).join('\n');

  const userPrompt =
    `These articles all belong to the same ongoing news story. ` +
    `Write a concise, headline-style title (4–8 words) that captures the core topic of this story. ` +
    `Output ONLY the title — no quotes, no punctuation at the end, no explanation.\n\n` +
    `Articles:\n${articleLines}`;

  try {
    await cerebrasRateLimiter.waitForSlot(SUMMARIZATION_MODEL);

    const response = await summarizer.chat.completions.create({
      model: SUMMARIZATION_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a news editor. When given a list of article headlines from the same story cluster, ' +
            'you output a single short title (4–8 words) that best names the ongoing story. ' +
            'No quotes, no trailing punctuation, no explanation — just the title.',
        },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,  // ⚠️ MUST be 4096+ — zai-glm-4.7 uses reasoning tokens before output
    });

    const raw = (response.choices[0]?.message?.content ?? '').trim();
    // Strip any accidental surrounding quotes from the LLM output
    const title = raw.replace(/^["'"""'']+|["'"""'']+$/g, '').trim();

    if (!title) return null;

    // 3. Persist to stories.title so it is never regenerated
    await dbPool.query(
      'UPDATE stories SET title = $1 WHERE id = $2',
      [title, storyId],
    );

    return title;
  } catch (err) {
    console.error(`[CEREBRAS] generateStoryTitle failed for story ${storyId}:`, err);
    return null;
  }
}


// ── Classification User Message Builder ──

/**
 * Build the user message for classification batches.
 * Formats articles as a numbered list with title, description, content excerpt,
 * source domain, published date, and API metadata signals.
 */
export function buildClassificationUserMessage(articles: NormalizedArticle[]): string {
  const articleTexts = articles.map((a, i) => {
    const parts: string[] = [];
    parts.push(`[${i + 1}]`);
    parts.push(`Title: ${a.title}`);
    if (a.description) parts.push(`Description: ${a.description.substring(0, 500)}`);
    if (a.content) parts.push(`Content (excerpt): ${a.content.substring(0, 1000)}`);
    parts.push(`Source: ${a.sourceDomain || 'unknown'}`);
    parts.push(`Published: ${a.publishedAt?.toISOString() || 'unknown'}`);
    const metadata = formatApiMetadata(a);
    if (metadata) parts.push(metadata);
    return parts.join('\n');
  });

  return `Classify these ${articles.length} articles:\n\n${articleTexts.join('\n\n')}`;
}

/**
 * Format API metadata signals for LLM context.
 * Only includes non-null fields to keep the prompt clean.
 */
export function formatApiMetadata(article: NormalizedArticle): string {
  const signals: string[] = [];

  // Webz.io IPTC category
  if (article.apiIptcCategory) signals.push(`IPTC Category: ${article.apiIptcCategory}`);

  // Webz.io entities
  if (article.apiEntities?.length) {
    const entities = article.apiEntities
      .map(e => `${e.name} (${e.type})`).slice(0, 5).join(', ');
    signals.push(`Entities: ${entities}`);
  }

  // WorldNewsAPI / Webz.io sentiment
  if (article.apiSentiment != null) signals.push(`Sentiment: ${article.apiSentiment}`);

  // TheNewsAPI relevance score
  if (article.apiRelevanceScore != null) signals.push(`API Relevance Score: ${article.apiRelevanceScore}`);

  // NewsData.io source priority
  if (article.apiSourcePriority != null) signals.push(`Source Authority Rank: ${article.apiSourcePriority}`);

  // API keywords
  if (article.apiKeywords?.length) signals.push(`Keywords: ${article.apiKeywords.slice(0, 8).join(', ')}`);

  // Non-IPTC API category
  if (article.apiCategory && !article.apiIptcCategory) signals.push(`API Category: ${article.apiCategory}`);

  // Country signal
  if (article.apiCountry) signals.push(`Country: ${article.apiCountry}`);

  // Thin-context note for very short snippets — tells LLM to apply Rule 13
  // Catches TheNewsAPI (~120 chars), near-stubs, but not 200-char Webz.io descriptions.
  const totalContext = (article.description?.length ?? 0) + (article.content?.length ?? 0);
  if (totalContext < 200) {
    signals.push(`Short API snippet only (${totalContext} chars) — apply Rule 13 before assigning Tier A`);
  }

  return signals.length ? `API Signals: { ${signals.join(' | ')} }` : '';
}
