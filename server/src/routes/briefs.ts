import { Router } from 'express';
import { pool } from '../db/index.js';

const router = Router();

function parseBullets(summary: string | null): string[] {
  if (!summary) return [];
  return summary
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[•\-\*]\s*/, ''))
    .filter(l => l.length > 0);
}

function formatTimeAgo(date: Date | string | null): string {
  if (!date) return '';
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// GET /api/briefs/today
router.get('/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Try today's brief first
    let briefResult = await pool.query(
      'SELECT * FROM briefs WHERE brief_date = $1',
      [today]
    );

    // Fallback: yesterday's brief (stale but better than empty)
    if (briefResult.rows.length === 0) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      briefResult = await pool.query(
        'SELECT * FROM briefs WHERE brief_date = $1',
        [yesterday]
      );
    }

    if (briefResult.rows.length === 0) {
      return res.json({ date: today, articles: [] });
    }

    const brief = briefResult.rows[0];
    const articleIds: number[] = brief.article_ids ?? [];

    if (articleIds.length === 0) {
      return res.json({ date: brief.brief_date, articles: [] });
    }

    // Fetch article details — use the CURRENT schema columns (no body, no sub_genre, no story summary join)
    const articlesResult = await pool.query<{
      id: number;
      title: string;
      summary: string | null;
      story_id: number | null;
      source_name: string | null;
      llm_category: string | null;
      published_at: Date | null;
    }>(
      `SELECT a.id, a.title, a.summary, a.story_id, a.source_name, a.llm_category, a.published_at
       FROM articles a
       WHERE a.id = ANY($1)`,
      [articleIds]
    );

    // Preserve order from article_ids
    const articleMap = new Map(articlesResult.rows.map(r => [r.id, r]));

    const articles = articleIds.map(id => {
      const a = articleMap.get(id);
      return {
        id: a?.id ?? id,
        title: a?.title ?? 'Untitled',
        bullets: parseBullets(a?.summary ?? null),
        storyId: a?.story_id ?? null,
        sourceName: a?.source_name ?? 'Unknown',
        category: a?.llm_category ?? 'News',
        timeAgo: formatTimeAgo(a?.published_at ?? null),
      };
    });

    res.json({ date: brief.brief_date, articles });
  } catch (err) {
    console.error('Brief fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch brief' });
  }
});

// DELETE /api/briefs/today — cache busting for dev
router.delete('/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    await pool.query('DELETE FROM briefs WHERE brief_date = $1', [today]);
    res.json({ cleared: true });
  } catch (err) {
    console.error('Brief clear error:', err);
    res.status(500).json({ cleared: false, error: 'Failed to clear brief' });
  }
});

export default router;
