import { GoogleGenAI } from '@google/genai';
import { pool } from '../../db/index.js';
import { EMBED_BATCH_SIZE, EMBED_MAX_TEXT_CHARS } from '../../config/constants.js';
import type { ArticleRow } from '../../types/index.js';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn('GEMINI_API_KEY not set. AI features will fail.');
}

const genAI = apiKey ? new GoogleGenAI({ apiKey }) : null;

// ---------------------------------------------------------------------------
// buildEmbeddingInput — Full text priority chain (§9.2.2)
// ---------------------------------------------------------------------------

/**
 * Build the text input for embedding from the richest available content.
 * Priority: full_text (≥300 chars) → content (≥80 chars) → description fallback.
 * Title is always prepended. Text is truncated to EMBED_MAX_TEXT_CHARS.
 */
export function buildEmbeddingInput(article: ArticleRow): string {
  if (article.full_text && article.full_text.length >= 300) {
    return `${article.title}\n${article.full_text.slice(0, EMBED_MAX_TEXT_CHARS)}`;
  }
  if (article.content && article.content.length >= 80) {
    return `${article.title}\n${article.content.slice(0, EMBED_MAX_TEXT_CHARS)}`;
  }
  return `${article.title}\n${article.description ?? ''}`;
}

// ---------------------------------------------------------------------------
// batchEmbedArticles — Main pipeline entry point (§9.2.3)
// ---------------------------------------------------------------------------

/**
 * Batch-embed a list of article IDs that don't yet have embeddings.
 * Queries articles from DB, builds inputs via buildEmbeddingInput,
 * calls Gemini batch embed in chunks of EMBED_BATCH_SIZE, and stores
 * results via bulk UPDATE.
 *
 * Idempotent: only embeds articles WHERE embedding IS NULL.
 * On error in a batch, logs and continues to the next batch (partial success OK).
 */
export async function batchEmbedArticles(articleIds: number[]): Promise<void> {
  if (!genAI || articleIds.length === 0) return;

  // Fetch articles needing embedding (idempotency: skip already-embedded)
  const res = await pool.query<
    Pick<ArticleRow, 'id' | 'title' | 'description' | 'content' | 'full_text' | 'scrape_status'>
  >(
    `SELECT id, title, description, content, full_text, scrape_status
     FROM articles
     WHERE id = ANY($1) AND embedding IS NULL
     ORDER BY id`,
    [articleIds]
  );

  const articles = res.rows;
  if (articles.length === 0) return;

  let embedded = 0;
  const totalBatches = Math.ceil(articles.length / EMBED_BATCH_SIZE);

  for (let i = 0; i < articles.length; i += EMBED_BATCH_SIZE) {
    const batch = articles.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(a => buildEmbeddingInput(a as ArticleRow));

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        const result = await genAI.models.embedContent({
          model: 'gemini-embedding-2',
          contents: texts,
        });

        const ids = batch.map(a => a.id);
        const embeddings = (result.embeddings ?? []).map(e =>
          JSON.stringify(e.values ?? [])
        );

        await pool.query(
          `UPDATE articles SET embedding = data.emb::jsonb
           FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::text[]) AS emb) AS data
           WHERE articles.id = data.id`,
          [ids, embeddings]
        );

        embedded += batch.length;
        break;  // success — exit retry loop
      } catch (err: unknown) {
        attempt++;
        const is429 = err instanceof Error && /429|RESOURCE_EXHAUSTED/i.test(err.message);
        if (is429 && attempt < maxRetries) {
          const backoffMs = 30_000 * attempt;  // 30s, 60s
          console.warn(`[EMBED] Batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1}/${totalBatches} 429 — retry ${attempt}/${maxRetries} in ${backoffMs / 1000}s`);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        console.error(`[EMBED] Batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1}/${totalBatches} failed:`, err);
      }
    }
  }

  console.log(`[EMBED] Embedded ${embedded}/${articles.length} articles in ${totalBatches} batch(es)`);
}

// ---------------------------------------------------------------------------
// generateSingleEmbedding — Ad-hoc single-text embedding (non-pipeline use)
// ---------------------------------------------------------------------------

/**
 * Generate an embedding for a single text string.
 * Used for ad-hoc queries, chat, manual operations — NOT the main pipeline.
 */
export async function generateSingleEmbedding(text: string): Promise<number[] | null> {
  if (!genAI) return null;
  try {
    const response = await genAI.models.embedContent({
      model: 'gemini-embedding-2',
      contents: text,
    });
    return response.embeddings?.[0]?.values ?? null;
  } catch (err) {
    console.error('[EMBED] Single embed failed:', err);
    return null;
  }
}

export default genAI;
