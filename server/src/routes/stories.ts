import { Router } from 'express';
import { pool } from '../db/index.js';
import { generateNimSummary } from '../services/nimClient.js';

const router = Router();
const TIMELINE_WINDOW_DAYS = 14;

// GET /api/stories/:id — fetch a story and all of its articles by story ID
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
      `SELECT a.id, a.title, a.url, a.body, a.full_text, a.published_at, a.story_id, s.name as source_name
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.story_id = $1
       ORDER BY a.published_at DESC`,
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
    const articleId = req.query.articleId ? Number(req.query.articleId) : null;

    const prompt = `Simplify this news article for a general reader.

Rules:
- Write 2-3 concise paragraphs in essay format (NOT bullet points).
- Cover the key facts, context, and why it matters.
- Use plain language but don't oversimplify — this is for the full article view, not a headline overview.
- Aim for about 120-180 words. Do NOT go below 100 words.
- No preamble, labels, or meta-text.

`;

    // ── Article-specific path ──────────────────────────────────────────────
    // When articleId is provided, simplify THAT article's own content.
    // This ensures each timeline item (different source/date) gets a unique
    // simplification rather than sharing the story-level summary.
    if (articleId) {
      const artResult = await pool.query(
        'SELECT title, body, full_text FROM articles WHERE id = $1',
        [articleId]
      );
      if (artResult.rows.length === 0) {
        return res.status(404).json({ error: 'Article not found' });
      }
      const art = artResult.rows[0];
      const content = (art.full_text || art.body || '').trim();
      if (!content) {
        return res.status(422).json({ error: 'Article has no content to simplify' });
      }
      const result = await generateNimSummary(`${prompt}${art.title}\n\n${content}`);
      return res.json({ text: result ?? '' });
    }

    // ── Story-level path (cached) ─────────────────────────────────────────
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

// GET /api/stories/:id/timeline — O(1) DB query using story_id FK
//
// Accepts a story ID. Returns one article per source per day (deduped via
// DISTINCT ON), so the timeline reads as a progression rather than a wall of
// same-day reports.
router.get('/:id/timeline', async (req, res) => {
  try {
    const { id } = req.params;
    const storyId = Number(id);

    const storyCheck = await pool.query('SELECT id FROM stories WHERE id = $1', [storyId]);
    if (storyCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Deduplicate: one article per source per day (keep the latest per group).
    // The frontend groups results by date for visual day-headers.
    const result = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (s.name, DATE(a.published_at))
                a.id, a.story_id, a.title, a.url, a.published_at, s.name as source_name
         FROM articles a
         JOIN sources s ON a.source_id = s.id
         WHERE a.story_id = $1
           AND a.published_at >= NOW() - INTERVAL '${TIMELINE_WINDOW_DAYS} days'
         ORDER BY s.name, DATE(a.published_at), a.published_at DESC
       ) sub
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
