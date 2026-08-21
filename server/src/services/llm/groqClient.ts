/**
 * groqClient.ts — Groq LLM client
 *
 * Models (via Groq OpenAI-compatible API):
 *   - openai/gpt-oss-120b: Classification (batch of 5, tier A/B/C/D)
 *   - openai/gpt-oss-20b: Summarization, Simplification, Story Titles, Chat
 *
 * ⚠️ Critical: Do NOT use response_format: { type: 'json_object' } for classification.
 *   openai/gpt-oss-120b returns clean JSON arrays natively.
 *   json_object mode wraps in {type:"array",items:[...]} — harder to parse.
 *
 * ⚠️ Reasoning model note: openai/gpt-oss-20b uses reasoning tokens internally.
 *   max_tokens must be set high enough (≥512 for titles, ≥1024 for summaries) so that
 *   thinking tokens don't exhaust the budget before output is generated.
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
  GROQ_RPM,
  GROQ_RPD,
  VALID_LLM_CATEGORIES,
  VALID_LLM_TIERS,
} from '../../config/constants.js';
import type { NormalizedArticle, ClassificationResult, ScoredArticle } from '../../types/index.js';
import type { Pool } from 'pg';

// ── Groq Client ──

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || '',
  baseURL: 'https://api.groq.com/openai/v1',
});

// ── Rate Limiter (Groq) ──

class GroqRateLimiter {
  private rpmCount: Map<string, number> = new Map();
  private rpdCount: Map<string, number> = new Map();
  private minuteStart: number = Date.now();
  private lastResetDate: string = new Date().toISOString().slice(0, 10);
  private lastRequestTime: number = 0;
  private readonly RPM = GROQ_RPM;
  private readonly RPD = GROQ_RPD;
  // 2s gap between requests avoids burst token exhaustion
  private readonly MIN_REQUEST_GAP_MS = 2_000;

  private checkDayReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.rpdCount.clear();
      this.lastResetDate = today;
    }
  }

  async waitForSlot(model: string = CLASSIFICATION_MODEL): Promise<void> {
    this.checkDayReset();

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
    this.rpmCount.set(model, rpm + 1);
    this.rpdCount.set(model, rpd + 1);
    this.lastRequestTime = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Singleton rate limiter used by all Groq functions */
export const groqRateLimiter = new GroqRateLimiter();

// ── Classification (openai/gpt-oss-120b via Groq) ──

/**
 * Classify a batch of up to 5 articles using openai/gpt-oss-120b on Groq.
 * Returns ScoredArticle[] with llmTier, llmCategory, llmReason, filterStatus.
 */
export async function classifyArticleBatch(
  articles: NormalizedArticle[],
): Promise<ScoredArticle[]> {
  if (articles.length === 0) return [];

  await groqRateLimiter.waitForSlot(CLASSIFICATION_MODEL);

  let retried = false;

  const attempt = async (): Promise<ScoredArticle[]> => {
    try {
      const response = await groq.chat.completions.create({
        model: CLASSIFICATION_MODEL,
        messages: [
          { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
          { role: 'user', content: buildClassificationUserMessage(articles) },
        ],
        temperature: CLASSIFICATION_TEMPERATURE,
        // ⚠️ NO response_format — gpt-oss-120b returns clean JSON arrays natively.
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
          await groqRateLimiter.waitForSlot(CLASSIFICATION_MODEL);
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
          await groqRateLimiter.waitForSlot(CLASSIFICATION_MODEL);
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

// ── Summarization (openai/gpt-oss-20b via Groq) ──

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
      await groqRateLimiter.waitForSlot(SUMMARIZATION_MODEL);

      const response = await groq.chat.completions.create({
        model: SUMMARIZATION_MODEL,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Summarize this article in exactly 3 concise bullet points:\n\nTitle: ${title}\n\n${text}`,
          },
        ],
        temperature: SUMMARIZATION_TEMPERATURE,
        max_tokens: SUMMARIZATION_MAX_TOKENS,
      });

      return response.choices[0]?.message?.content ?? '';
    } catch (err: unknown) {
      const httpErr = err as { status?: number };
      if (httpErr.status === 429 && attempt < MAX_RETRIES - 1) {
        const backoffMs = 15_000 * (attempt + 1);
        console.warn(`[GROQ] Summary 429 for "${title.slice(0, 40)}" — retry ${attempt + 1}/${MAX_RETRIES} in ${backoffMs / 1000}s`);
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }
  return '';
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
  await groqRateLimiter.waitForSlot(SUMMARIZATION_MODEL);

  const response = await groq.chat.completions.create({
    model: SUMMARIZATION_MODEL,
    messages: [
      { role: 'system', content: SIMPLIFY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Simplify for a general reader — 2-3 paragraphs, 120-180 words, essay format, no bullet points:\n\n${text}`,
      },
    ],
    temperature: SUMMARIZATION_TEMPERATURE,
    max_tokens: SIMPLIFICATION_MAX_TOKENS,
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
 * story to openai/gpt-oss-20b and asks for a 4–8 word headline-style title.
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

  // 2. Fetch up to 10 articles for context
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
    await groqRateLimiter.waitForSlot(SUMMARIZATION_MODEL);

    const response = await groq.chat.completions.create({
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
      max_tokens: 512,
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
    console.error(`[GROQ] generateStoryTitle failed for story ${storyId}:`, err);
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

  if (article.apiIptcCategory) signals.push(`IPTC Category: ${article.apiIptcCategory}`);

  if (article.apiEntities?.length) {
    const entities = article.apiEntities
      .map(e => `${e.name} (${e.type})`).slice(0, 5).join(', ');
    signals.push(`Entities: ${entities}`);
  }

  if (article.apiSentiment != null) signals.push(`Sentiment: ${article.apiSentiment}`);
  if (article.apiRelevanceScore != null) signals.push(`API Relevance Score: ${article.apiRelevanceScore}`);
  if (article.apiSourcePriority != null) signals.push(`Source Authority Rank: ${article.apiSourcePriority}`);
  if (article.apiKeywords?.length) signals.push(`Keywords: ${article.apiKeywords.slice(0, 8).join(', ')}`);
  if (article.apiCategory && !article.apiIptcCategory) signals.push(`API Category: ${article.apiCategory}`);
  if (article.apiCountry) signals.push(`Country: ${article.apiCountry}`);

  const totalContext = (article.description?.length ?? 0) + (article.content?.length ?? 0);
  if (totalContext < 200) {
    signals.push(`Short API snippet only (${totalContext} chars) — apply Rule 13 before assigning Tier A`);
  }

  return signals.length ? `API Signals: { ${signals.join(' | ')} }` : '';
}
