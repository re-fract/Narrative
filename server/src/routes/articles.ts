import { Router } from 'express';
import { pool } from '../db/index.js';
import { fetchArticleText } from '../services/articleScraper.js';

const router = Router();

// GET /api/articles/:id — fetch a single article by article ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const articleResult = await pool.query<{
      id: number;
      title: string;
      url: string;
      body: string | null;
      full_text: string | null;
      published_at: Date | null;
      story_id: number | null;
      source_name: string;
    }>(
      `SELECT a.id, a.title, a.url, a.body, a.full_text, a.published_at, a.story_id, s.name as source_name
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.id = $1`,
      [id]
    );

    if (articleResult.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const article = articleResult.rows[0];
    const currentText = article.full_text?.trim() ?? '';
    const rssText = article.body?.trim() ?? '';

    if (currentText.length < 500 || currentText.length < rssText.length) {
      try {
        const scrapedText = await fetchArticleText(article.url);
        if (scrapedText && scrapedText.length > currentText.length) {
          article.full_text = scrapedText;
          await pool.query('UPDATE articles SET full_text = $1 WHERE id = $2', [scrapedText, article.id]);
        }
      } catch (err) {
        console.warn(`On-demand article scrape failed for ${article.url}:`, err);
      }
    }

    return res.json({
      article,
    });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch article' });
  }
});

export default router;
