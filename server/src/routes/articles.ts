import { Router } from 'express';
import { pool } from '../db/index.js';
import { simplifyArticle } from '../services/llm/cerebrasClient.js';

const router = Router();

// GET /api/articles/:id — fetch a single article by article ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const articleResult = await pool.query(
      `SELECT id, title, url, description, content, full_text, summary,
              published_at, story_id, source_name, llm_category, importance_score
       FROM articles
       WHERE id = $1`,
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

// GET /api/articles/:id/simplify — simplify an article via Cerebras
// Results cached in `simplifications` table (article_id, level).
router.get('/:id/simplify', async (req, res) => {
  try {
    const articleId = Number(req.params.id);

    const artResult = await pool.query(
      `SELECT id, title, full_text FROM articles WHERE id = $1`,
      [articleId]
    );
    if (artResult.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const content = (artResult.rows[0].full_text || '').trim();
    if (!content) {
      return res.status(422).json({ error: 'Article has no content to simplify' });
    }

    const text = await simplifyArticle(articleId, content, pool);
    res.json({ text });
  } catch {
    res.status(500).json({ error: 'Failed to simplify article' });
  }
});

export default router;
