import { Router } from 'express';
import { pool } from '../db/index.js';

const router = Router();
const TIMELINE_WINDOW_DAYS = 14;

// Cosine similarity between two vectors (inline — avoids import dependency)
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Near-duplicate threshold: articles with embedding similarity above this are
// considered the same event covered from different sources.
const TIMELINE_DEDUP_THRESHOLD = 0.85;

// GET /api/stories/:id — fetch a story and its articles
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const storyResult = await pool.query(
      `SELECT id, title, article_count, first_seen_at, last_updated_at,
              importance_score, source_count, main_genre, llm_category
       FROM stories WHERE id = $1`,
      [id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const articlesResult = await pool.query(
      `SELECT id, title, url, full_text, published_at, story_id, source_name,
              llm_category, importance_score
       FROM articles
       WHERE story_id = $1
       ORDER BY published_at DESC`,
      [id]
    );

    return res.json({
      story: storyResult.rows[0],
      articles: articlesResult.rows,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch story' });
  }
});

// GET /api/stories/:id/timeline — up to 2 distinct articles per day, with
// embedding-similarity dedup to remove same-event coverage from different sources.
// Optional query param: ?currentArticleId=N — the article the user is viewing is
// always included regardless of ranking, and its embedding seeds the dedup so
// near-duplicates of it are suppressed from the rest of the timeline.
router.get('/:id/timeline', async (req, res) => {
  try {
    const { id } = req.params;
    const storyId = Number(id);
    const currentArticleId = req.query.currentArticleId
      ? Number(req.query.currentArticleId)
      : null;

    const storyCheck = await pool.query('SELECT id FROM stories WHERE id = $1', [storyId]);
    if (storyCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Fetch up to 4 candidates per day (more candidates so dedup has room to
    // filter near-duplicates and still yield 2 distinct articles per day).
    // Also fetch embedding for dedup; it is stripped before the response.
    const candidatesRes = await pool.query<{
      id: number;
      story_id: number;
      title: string;
      url: string;
      published_at: string;
      source_name: string | null;
      embedding: string | null;
      day_rank: number;
    }>(
      `SELECT * FROM (
         SELECT a.id, a.story_id, a.title, a.url, a.published_at, a.source_name,
                a.embedding,
                ROW_NUMBER() OVER (
                  PARTITION BY DATE(a.published_at AT TIME ZONE 'UTC')
                  ORDER BY a.importance_score DESC NULLS LAST, a.published_at DESC
                ) AS day_rank
         FROM articles a
         WHERE a.story_id = $1
           AND a.published_at >= NOW() - INTERVAL '${TIMELINE_WINDOW_DAYS} days'
       ) sub
       WHERE sub.day_rank <= 4
       ORDER BY sub.published_at DESC`,
      [storyId]
    );

    const selectedPerDay = new Map<string, number>(); // day → count kept
    const selectedEmbeddings: number[][] = [];
    const result: Array<Omit<typeof candidatesRes.rows[0], 'embedding' | 'day_rank'>> = [];

    // Helper: parse an embedding field safely
    function parseEmb(raw: string | null): number[] | null {
      if (!raw) return null;
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
    }

    // Pin the current article first — it must always appear in its own timeline.
    // Register its embedding so the dedup loop below suppresses near-duplicates of it.
    if (currentArticleId !== null) {
      const pinned = candidatesRes.rows.find(r => r.id === currentArticleId);
      if (pinned) {
        const emb = parseEmb(pinned.embedding);
        if (emb !== null) selectedEmbeddings.push(emb);
        const day = pinned.published_at.toString().substring(0, 10);
        selectedPerDay.set(day, (selectedPerDay.get(day) ?? 0) + 1);
        const { embedding: _e, day_rank: _r, ...clean } = pinned;
        result.push(clean);
      }
    }

    // Embedding-similarity dedup: walk through remaining candidates in order.
    // Skip the already-pinned current article, near-duplicates of selected articles,
    // and days that have already filled their 2-article quota.
    for (const row of candidatesRes.rows) {
      if (row.id === currentArticleId) continue; // already pinned above

      const day = row.published_at.toString().substring(0, 10);
      const dayCount = selectedPerDay.get(day) ?? 0;
      if (dayCount >= 2) continue;

      const emb = parseEmb(row.embedding);

      if (emb !== null && selectedEmbeddings.length > 0) {
        const isDuplicate = selectedEmbeddings.some(
          sel => cosineSim(emb!, sel) >= TIMELINE_DEDUP_THRESHOLD
        );
        if (isDuplicate) continue;
      }

      if (emb !== null) selectedEmbeddings.push(emb);
      selectedPerDay.set(day, dayCount + 1);

      const { embedding: _emb, day_rank: _rank, ...clean } = row;
      result.push(clean);
    }

    // Re-sort chronologically (pinning may have disturbed order)
    result.sort((a, b) =>
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
    );

    res.json({ articles: result });
  } catch (err) {
    console.error('Timeline error:', err);
    res.status(500).json({ error: 'Failed to build timeline' });
  }
});

export default router;

