import { Router } from 'express';
import { pool } from '../db/index.js';

const router = Router();

// GET /api/follows — list all followed stories
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.id, f.story_id, f.followed_at, f.last_seen_at,
              s.title, s.article_count, s.last_updated_at
       FROM follows f
       JOIN stories s ON f.story_id = s.id
       ORDER BY s.last_updated_at DESC`
    );
    res.json({ follows: result.rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch follows' });
  }
});

// POST /api/stories/:id/follow
router.post('/:id/follow', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      `INSERT INTO follows (story_id) VALUES ($1)
       ON CONFLICT (story_id, user_id) DO NOTHING`,
      [id]
    );
    res.json({ followed: true });
  } catch {
    res.status(500).json({ error: 'Failed to follow story' });
  }
});

// DELETE /api/stories/:id/follow
router.delete('/:id/follow', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM follows WHERE story_id = $1', [id]);
    res.json({ followed: false });
  } catch {
    res.status(500).json({ error: 'Failed to unfollow story' });
  }
});

// GET /api/follows/updates — check for updates on followed stories
router.get('/updates', async (req, res) => {
  try {
    // Find new articles on followed stories since last_seen_at
    const result = await pool.query(
      `SELECT f.story_id, s.title,
              COUNT(a.id) as new_article_count,
              ARRAY_AGG(a.title) as new_titles
       FROM follows f
       JOIN stories s ON f.story_id = s.id
       LEFT JOIN articles a ON a.story_id = f.story_id
         AND a.published_at > COALESCE(f.last_seen_at, f.followed_at)
       GROUP BY f.story_id, s.title`
    );
    res.json({ updates: result.rows });
  } catch {
    res.status(500).json({ error: 'Failed to fetch updates' });
  }
});

export default router;
