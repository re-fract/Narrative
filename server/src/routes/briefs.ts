import { Router, Response } from 'express';
import { generateNimSummary } from '../services/nimClient.js';
import { pool } from '../db/index.js';
import { fetchAllFeeds } from '../services/rssFetcher.js';
import { trackAPICall } from '../services/budgetTracker.js';
import type { ArticleRow, StoryRow } from '../types/index.js';

function parseBullets(summary: string): string[] {
  return summary
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[•\-\*]\s*/, ''))
    .filter(l => l.length > 0);
}

const router = Router();


function getTodayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

async function getOrCreateBrief() {
  const today = getTodayUTC();

  // 1. Check if brief exists
  const existing = await pool.query(
    'SELECT * FROM briefs WHERE brief_date = $1',
    [today]
  );

  if (existing.rows.length > 0) {
    const storyIds: number[] = existing.rows[0].story_ids;
    const stories = await pool.query(
      'SELECT id, title, summary, article_count FROM stories WHERE id = ANY($1)',
      [storyIds]
    );
    const articles = await pool.query(
      `SELECT a.story_id, s.name as source_name
       FROM articles a
       JOIN sources s ON a.source_id = s.id
       WHERE a.story_id = ANY($1)`,
      [storyIds]
    );

    const sourceMap = new Map<number, Set<string>>();
    for (const row of articles.rows) {
      const set = sourceMap.get(row.story_id) || new Set<string>();
      set.add(row.source_name);
      sourceMap.set(row.story_id, set);
    }

    return {
      date: today,
      stories: storyIds.map((id: number) => {
        const s = stories.rows.find((r: StoryRow) => r.id === id);
        return {
          id: s?.id ?? id,
          title: s?.title ?? 'Untitled',
          bullets: parseBullets(s?.summary ?? ''),
          sourceCount: sourceMap.get(id)?.size ?? 1,
          category: 'News',
          timeAgo: 'Today',
        };
      }),
    };
  }

  // 2. No brief — generate
  let aiState = { available: true };

  // Fetch feeds
  const rawArticles = await fetchAllFeeds();
  rawArticles.splice(15);

  if (rawArticles.length === 0) {
    return { date: today, stories: [] };
  }

  // Insert articles into DB
  const articleIds: number[] = [];
  for (const a of rawArticles) {
    const res = await pool.query(
      `INSERT INTO articles (source_id, url, title, body, published_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body
       RETURNING id`,
      [a.sourceId, a.url, a.title, stripHtml(a.body), a.publishedAt]
    );
    articleIds.push(res.rows[0].id);
  }

  // Create one story per article (no clustering)
  const storyIdsForBrief: number[] = [];

  for (let i = 0; i < rawArticles.length; i++) {
    const articleId = articleIds[i];

    // Create a new story for this article
    const storyRes = await pool.query<{ id: number }>(
      `INSERT INTO stories (title, summary, article_count, status, first_seen_at, last_updated_at)
       VALUES ($1, $2, $3, 'active', NOW(), NOW())
       RETURNING id`,
      ['Untitled', '', 1]
    );
    const storyId = storyRes.rows[0].id;
    storyIdsForBrief.push(storyId);

    // Link article to its story
    await pool.query(
      'UPDATE articles SET story_id = $1 WHERE id = $2',
      [storyId, articleId]
    );

    // Build summary for this single-article story
    const members = await pool.query<ArticleRow>(
      'SELECT * FROM articles WHERE id = $1',
      [articleId]
    );
    const summary = await buildSummary(members.rows, aiState);

    // Update the story with the generated summary
    await pool.query(
      'UPDATE stories SET title = $1, summary = $2 WHERE id = $3',
      [summary.title, summary.text, storyId]
    );
  }

  // Store brief
  await pool.query(
    `INSERT INTO briefs (brief_date, story_ids) VALUES ($1, $2)`,
    [today, storyIdsForBrief]
  );

  // Return the brief
  const stories = await pool.query(
    'SELECT id, title, summary, article_count FROM stories WHERE id = ANY($1)',
    [storyIdsForBrief]
  );

  const artSources = await pool.query(
    `SELECT a.story_id, s.name as source_name
     FROM articles a
     JOIN sources s ON a.source_id = s.id
     WHERE a.story_id = ANY($1)`,
    [storyIdsForBrief]
  );
  const sourceMap = new Map<number, Set<string>>();
  for (const row of artSources.rows) {
    const set = sourceMap.get(row.story_id) || new Set<string>();
    set.add(row.source_name);
    sourceMap.set(row.story_id, set);
  }

  return {
    date: today,
    stories: storyIdsForBrief.map((id: number) => {
      const s = stories.rows.find((r: StoryRow) => r.id === id);
      return {
        id: s?.id ?? id,
        title: s?.title ?? 'Untitled',
        bullets: parseBullets(s?.summary ?? ''),
        sourceCount: sourceMap.get(id)?.size ?? 1,
        category: 'News',
        timeAgo: 'Just now',
      };
    }),
  };
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function generateFallbackSummary(article: ArticleRow): { title: string; text: string } {
  const title = article.title ?? 'Untitled';
  const body = stripHtml(article.body ?? '');
  const sentences = body.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0);
  const bullets: string[] = [];
  for (let i = 0; i < Math.min(2, sentences.length); i++) {
    let s = sentences[i].slice(0, 140);
    if (sentences[i].length > 140) s += '...';
    bullets.push(`• ${s}`);
  }
  if (sentences.length > 2) {
    bullets.push('• ...');
  }
  return { title, text: bullets.join('\n') };
}

async function buildSummary(
  articles: ArticleRow[],
  aiState: { available: boolean },
) {
  if (articles.length === 1) {
    const article = articles[0];

    if (aiState.available) {
      const promptText = `Summarize the following article in exactly 3 concise bullet points.\nRules:\n- Each bullet must be one sentence only (under 140 characters).\n- Do not add any preamble, explanation, or labels.\n- Return ONLY the bullet points.\n\n${article.title}. ${article.body}`;
      const result = await generateNimSummary(promptText);

      if (result) {
        const summaryText = result;
        const title = summaryText.split('\n')[0].replace(/^[•\-\*]\s*/, '').slice(0, 500);
        return { title, text: summaryText };
      }

      aiState.available = false;
    }

    return generateFallbackSummary(article);
  }

  // Map-reduce for multi-article stories
  const perArticle: string[] = [];

  if (aiState.available) {
    for (const a of articles) {
      const promptText = `Summarize this article in 2-3 sentences:\n\n${a.title}. ${a.body}`;
      const result = await generateNimSummary(promptText);

      if (result) {
        perArticle.push(result);
        await trackAPICall();
      } else {
        aiState.available = false;
        break;
      }
    }
  }

  if (aiState.available && perArticle.length === articles.length) {
    const combined = perArticle.join('\n\n');
    const promptText = `You are given summaries of related news articles. Synthesize them into exactly 3 concise bullet points.\nRules:\n- Each bullet must be one sentence only (under 140 characters).\n- Do not add any preamble, explanation, or labels.\n- Return ONLY the bullet points.\n\n${combined}`;
    const result = await generateNimSummary(promptText);

    if (result) {
      const summaryText = result;
      const title = summaryText.split('\n')[0].replace(/^[•\-\*]\s*/, '').slice(0, 500);
      return { title, text: summaryText };
    }

    aiState.available = false;
  }

  // Multi-article fallback
  const title = articles[0].title ?? 'Untitled';
  const bullets: string[] = [];
  for (const a of articles) {
    const body = a.body ?? '';
    const sentences = body
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (sentences.length > 0) bullets.push(`• ${sentences[0]}`);
    if (sentences.length > 1) bullets.push(`• ${sentences[1]}`);
  }

  const text = bullets.length > 0
    ? bullets.join('\n')
    : `• ${articles[0].body?.slice(0, 200) ?? 'No content'}`;

  return { title, text };
}

// GET /api/briefs/today
router.get('/today', async (req, res: Response) => {
  try {
    const brief = await getOrCreateBrief();
    res.json(brief);
  } catch (err) {
    console.error('Brief error:', err);
    res.status(500).json({ error: 'Failed to generate brief' });
  }
});

// DELETE /api/briefs/today
router.delete('/today', async (req, res: Response) => {
  try {
    const today = getTodayUTC();
    await pool.query('DELETE FROM briefs WHERE brief_date = $1', [today]);
    res.json({ cleared: true });
  } catch (err) {
    console.error('Brief clear error:', err);
    res.status(500).json({ cleared: false, error: 'Failed to clear brief' });
  }
});

export default router;
