import { Router } from 'express';
import { pool } from '../db/index.js';

const router = Router();
const TIMELINE_WINDOW_DAYS = 14;

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

// GET /api/stories/:id/timeline — 1-2 best articles per day, ROW_NUMBER by importance_score
router.get('/:id/timeline', async (req, res) => {
  try {
    const { id } = req.params;
    const storyId = Number(id);

    const storyCheck = await pool.query('SELECT id FROM stories WHERE id = $1', [storyId]);
    if (storyCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const result = await pool.query(
      `SELECT * FROM (
         SELECT a.id, a.story_id, a.title, a.url, a.published_at, a.source_name,
                ROW_NUMBER() OVER (
                  PARTITION BY DATE(a.published_at)
                  ORDER BY a.importance_score DESC NULLS LAST, a.published_at DESC
                ) AS day_rank
         FROM articles a
         WHERE a.story_id = $1
           AND a.published_at >= NOW() - INTERVAL '${TIMELINE_WINDOW_DAYS} days'
       ) sub
       WHERE sub.day_rank <= 2
       ORDER BY sub.published_at DESC`,
      [storyId]
    );

    res.json({ articles: result.rows });
  } catch (err) {
    console.error('Timeline error:', err);
    res.status(500).json({ error: 'Failed to build timeline' });
  }
});

export default router;
