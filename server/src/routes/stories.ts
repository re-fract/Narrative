import { Router } from 'express';
import { pool } from '../db/index.js';
import { buildStoryTimeline } from '../services/stories/timelineBuilder.js';

const router = Router();

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
      : undefined;

    const storyCheck = await pool.query('SELECT id FROM stories WHERE id = $1', [storyId]);
    if (storyCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const articles = await buildStoryTimeline(storyId, {
      pinnedArticleId: currentArticleId,
    });

    res.json({ articles });
  } catch (err) {
    console.error('Timeline error:', err);
    res.status(500).json({ error: 'Failed to build timeline' });
  }
});

export default router;

