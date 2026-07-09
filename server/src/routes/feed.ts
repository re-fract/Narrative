import { Router } from 'express';
import { pool } from '../db/index.js';

const router = Router();

const VALID_CATEGORIES = new Set([
  'economics', 'policy', 'science', 'accountability', 'business',
]);

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

// GET /api/feed — recent accepted articles, optionally filtered by category.
// Unlike /api/briefs/today (which is a curated 14-article pipeline output),
// this queries the live articles table directly so single-source headlines
// that weren't clustered into a story still appear.
//
// Query params:
//   category  — one of: economics, policy, science, accountability, business
//               omit for all categories
//   limit     — max articles to return (default 30, max 50)
router.get('/', async (req, res) => {
  try {
    const rawCategory = typeof req.query.category === 'string' ? req.query.category : null;
    const category = rawCategory && VALID_CATEGORIES.has(rawCategory) ? rawCategory : null;
    const limit = Math.min(Number(req.query.limit ?? 30), 50);

    const params: (string | number)[] = [];
    let categoryClause = '';
    if (category) {
      params.push(category);
      categoryClause = `AND a.llm_category = $${params.length}`;
    }

    // Fetch recent accepted articles, one per story (DISTINCT ON prevents
    // multiple articles about the same topic). articles.importance_score is
    // not populated, so we rank by the signals we do have:
    //   1. llm_tier      — A before B (CHAR sort: 'A' < 'B')
    //   2. api_source_priority — lower integer = more prestigious source
    //   3. published_at  — freshest first
    const result = await pool.query<{
      id: number;
      title: string;
      summary: string | null;
      story_id: number | null;
      source_name: string | null;
      llm_category: string | null;
      published_at: Date | null;
      llm_tier: string | null;
      api_source_priority: number | null;
    }>(
      `SELECT DISTINCT ON (COALESCE(a.story_id::text, a.id::text))
              a.id, a.title, a.summary, a.story_id, a.source_name,
              a.llm_category, a.published_at, a.llm_tier, a.api_source_priority
         FROM articles a
        WHERE a.filter_status = 'accepted'
          AND a.published_at >= NOW() - INTERVAL '48 hours'
          ${categoryClause}
        ORDER BY COALESCE(a.story_id::text, a.id::text),
                 a.llm_tier ASC NULLS LAST,
                 a.api_source_priority ASC NULLS LAST,
                 a.published_at DESC`,
      params,
    );

    // Re-rank the deduped rows by the same signals across groups, then apply limit
    const rows = result.rows
      .sort((a, b) => {
        const tierA = a.llm_tier ?? 'Z';
        const tierB = b.llm_tier ?? 'Z';
        if (tierA !== tierB) return tierA < tierB ? -1 : 1;
        const priA = a.api_source_priority ?? Infinity;
        const priB = b.api_source_priority ?? Infinity;
        if (priA !== priB) return priA - priB;
        return new Date(b.published_at ?? 0).getTime() - new Date(a.published_at ?? 0).getTime();
      })
      .slice(0, limit);

    const articles = rows.map(a => ({
      id: a.id,
      title: a.title ?? 'Untitled',
      bullets: parseBullets(a.summary ?? null),
      storyId: a.story_id ?? null,
      sourceName: a.source_name ?? 'Unknown',
      category: a.llm_category ?? 'News',
      timeAgo: formatTimeAgo(a.published_at ?? null),
    }));

    res.json({ articles });
  } catch (err) {
    console.error('Feed fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

export default router;
