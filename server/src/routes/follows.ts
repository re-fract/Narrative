import { Router } from 'express';
import { pool } from '../db/index.js';
import { buildStoryTimeline } from '../services/stories/timelineBuilder.js';
import { generateStoryTitle } from '../services/llm/cerebrasClient.js';

const router = Router();

// GET /api/follows — list all followed stories (includes story_ids array for client toggle state)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.id, f.story_id, f.followed_at, f.last_seen_at,
              s.title, s.article_count, s.last_updated_at, s.llm_category
       FROM follows f
       JOIN stories s ON f.story_id = s.id
       WHERE f.user_id IS NULL
       ORDER BY s.last_updated_at DESC`,
    );

    const storyIds = result.rows.map(r => r.story_id);
    res.json({ follows: result.rows, story_ids: storyIds });
  } catch {
    res.status(500).json({ error: 'Failed to fetch follows' });
  }
});

// GET /api/follows/check?storyId=N — check if a single story is followed
router.get('/check', async (req, res) => {
  try {
    const storyId = Number(req.query.storyId);
    if (!storyId || isNaN(storyId)) {
      return res.status(400).json({ error: 'Invalid storyId' });
    }
    const result = await pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM follows WHERE story_id = $1 AND user_id IS NULL
       ) AS followed`,
      [storyId],
    );
    res.json({ followed: result.rows[0].followed });
  } catch {
    res.status(500).json({ error: 'Failed to check follow' });
  }
});

// GET /api/follows/updates — full feed: all followed stories with their deduped timelines
router.get('/updates', async (req, res) => {
  try {
    // 1. Fetch all followed stories for the global (no-auth) user
    const followsResult = await pool.query(
      `SELECT f.story_id, f.followed_at, f.last_seen_at,
              s.title, s.llm_category, s.article_count, s.last_updated_at
       FROM follows f
       JOIN stories s ON f.story_id = s.id
       WHERE f.user_id IS NULL
       ORDER BY s.last_updated_at DESC`,
    );

    if (followsResult.rows.length === 0) {
      return res.json({ stories: [] });
    }

    // 2. For each followed story, build its deduped timeline (same logic as article page)
    const stories = await Promise.all(
      followsResult.rows.map(async (follow) => {
        const articles = await buildStoryTimeline(follow.story_id, {
          includeSummary: true,
        });

        // Count articles published after the last time the user saw this story
        const lastSeen: Date | null = follow.last_seen_at
          ? new Date(follow.last_seen_at)
          : null;

        const newSinceLastSeen = lastSeen
          ? articles.filter(a => new Date(a.published_at) > lastSeen).length
          : articles.length;

        return {
          storyId: follow.story_id,
          // stories.title is always set by generateStoryTitle on follow; fall back gracefully
          storyTitle: follow.title?.trim() || (articles[0]?.title ?? 'Untitled Story'),
          storyCategory: follow.llm_category ?? 'news',
          followedAt: follow.followed_at,
          articleCount: follow.article_count ?? 0,
          lastUpdatedAt: follow.last_updated_at,
          newSinceLastSeen,
          articles,
        };
      }),
    );

    res.json({ stories });
  } catch (err) {
    console.error('Follows updates error:', err);
    res.status(500).json({ error: 'Failed to fetch follow updates' });
  }
});

// POST /api/follows/:id/follow — follow a story and trigger async title generation
router.post('/:id/follow', async (req, res) => {
  try {
    const storyId = Number(req.params.id);

    await pool.query(
      `INSERT INTO follows (story_id, user_id) VALUES ($1, NULL)
       ON CONFLICT (story_id, user_id) DO NOTHING`,
      [storyId],
    );

    // Respond immediately — don't make the user wait for the LLM
    res.json({ followed: true });

    // Fire-and-forget: generate (or confirm existing) story title in the background.
    // generateStoryTitle() is a no-op if stories.title is already set.
    generateStoryTitle(storyId, pool).catch(err =>
      console.error(`[FOLLOWS] Background title generation failed for story ${storyId}:`, err),
    );
  } catch {
    res.status(500).json({ error: 'Failed to follow story' });
  }
});

// DELETE /api/follows/:id/follow
router.delete('/:id/follow', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM follows WHERE story_id = $1 AND user_id IS NULL', [id]);
    res.json({ followed: false });
  } catch {
    res.status(500).json({ error: 'Failed to unfollow story' });
  }
});

// PATCH /api/follows/:storyId/seen — update last_seen_at for a story
router.patch('/:storyId/seen', async (req, res) => {
  try {
    const { storyId } = req.params;
    await pool.query(
      `UPDATE follows SET last_seen_at = NOW()
       WHERE story_id = $1 AND user_id IS NULL`,
      [storyId],
    );
    res.json({ updated: true });
  } catch {
    res.status(500).json({ error: 'Failed to update last_seen_at' });
  }
});

export default router;
