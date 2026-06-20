import { Router } from 'express';
import { pool } from '../db/index.js';

const router = Router();

// GET /api/articles/:id — fetch a single article by article ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const articleResult = await pool.query(
      `SELECT a.id, a.title, a.url, a.body, a.full_text, a.published_at, a.story_id, s.name as source_name
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.id = $1`,
      [id]
    );

    if (articleResult.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }

    return res.json({
      article: articleResult.rows[0],
    });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch article' });
  }
});

export default router;
