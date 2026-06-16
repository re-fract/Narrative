import { Router } from 'express';
import { pool } from '../db/index.js';
import { generateNimSummary } from '../services/nimClient.js';

const router = Router();

// GET /api/stories/:id — basic story info
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const storyResult = await pool.query(
      'SELECT id, title, summary, article_count, first_seen_at, last_updated_at FROM stories WHERE id = $1',
      [id]
    );
    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const articlesResult = await pool.query(
      `SELECT a.id, a.title, a.url, a.body, a.full_text, a.published_at, s.name as source_name
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.story_id = $1
       ORDER BY a.published_at DESC`,
      [id]
    );
    // Diagnostic: also fetch raw articles without the JOIN to detect source_id issues
    const rawArticlesDiag = await pool.query(
      `SELECT id, url, title, body, full_text, story_id, source_id, published_at FROM articles WHERE story_id = $1 ORDER BY published_at DESC`,
      [id]
    );
    console.log(`[STORY ${id}] Articles with JOIN: ${articlesResult.rows.length}, raw (no join): ${rawArticlesDiag.rows.length}`);
    if (rawArticlesDiag.rows.length > 0 && articlesResult.rows.length === 0) {
      console.log(`[STORY ${id}] JOIN dropped ALL articles — check source_id validity:`, rawArticlesDiag.rows.map(r => ({ id: r.id, source_id: r.source_id, url: r.url })));
    }
    if (rawArticlesDiag.rows.length === 0) {
      console.log(`[STORY ${id}] CRITICAL: No articles found with story_id=${id} at all. This story is orphaned.`);
    }
    console.log(`Story ${id} articles:`, articlesResult.rows.map(a => ({ id: a.id, title: a.title, bodyLength: a.body?.length, fullTextLength: a.full_text?.length, bodyPreview: a.body?.substring(0, 100) })));

    res.json({
      story: storyResult.rows[0],
      articles: articlesResult.rows,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch story' });
  }
});

// GET /api/stories/:id/expand — long-form synthesis (cached)
router.get('/:id/expand', async (req, res) => {
  try {
    const { id } = req.params;
    const storyResult = await pool.query(
      'SELECT id, title, summary, article_count, expansion_json, expansion_built_at_count FROM stories WHERE id = $1',
      [id]
    );
    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];

    // Return cached if valid
    if (story.expansion_json && story.expansion_built_at_count === story.article_count) {
      return res.json({ expansion: story.expansion_json });
    }

    const articlesResult = await pool.query(
      'SELECT title, body, full_text FROM articles WHERE story_id = $1 ORDER BY published_at DESC',
      [id]
    );

    const articles = articlesResult.rows;
    const combined = articles.map((a: { title: string; body: string | null; full_text: string | null }) => `${a.title}\n${a.full_text ?? a.body ?? ''}`).join('\n\n---\n\n');

    const prompt = `Synthesize the following related news articles into a comprehensive long-form summary with these sections: Background & Context, Key Players, What Happened, Differing Perspectives, What to Watch Next.\nRules: each section must be 2-3 sentences max. Keep it concise.\n\n${combined}`;
    const result = await generateNimSummary(prompt);
    const expansion = result ?? '';
    const expansionJson = JSON.stringify({ text: expansion });

    await pool.query(
      `UPDATE stories SET expansion_json = $1, expansion_built_at_count = $2 WHERE id = $3`,
      [expansionJson, story.article_count, id]
    );

    res.json({ expansion: { text: expansion } });
  } catch {
    res.status(500).json({ error: 'Failed to expand story' });
  }
});

// GET /api/stories/:id/simplify
router.get('/:id/simplify', async (req, res) => {
  try {
    const { id } = req.params;
    const level = String(req.query.level || 'simple');

    // Check cache
    const cached = await pool.query(
      'SELECT text FROM simplifications WHERE story_id = $1 AND level = $2',
      [id, level]
    );
    if (cached.rows.length > 0) {
      return res.json({ text: cached.rows[0].text });
    }

    const storyResult = await pool.query('SELECT title, summary FROM stories WHERE id = $1', [id]);
    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const { title, summary } = storyResult.rows[0];

    const prompt = `Simplify this news story for a general reader.

Rules:
- Write 2-3 concise paragraphs in essay format (NOT bullet points).
- Cover the key facts, context, and why it matters.
- Use plain language but don't oversimplify — this is for the full article view, not a headline overview.
- Aim for about 120-180 words. Do NOT go below 100 words.
- No preamble, labels, or meta-text.

`;

    const result = await generateNimSummary(`${prompt}${title}\n\n${summary}`);
    const text = result ?? '';

    await pool.query(
      `INSERT INTO simplifications (story_id, level, text) VALUES ($1, $2, $3)
       ON CONFLICT (story_id, level) DO UPDATE SET text = EXCLUDED.text`,
      [id, level, text]
    );

    res.json({ text });
  } catch {
    res.status(500).json({ error: 'Failed to simplify story' });
  }
});

export default router;
