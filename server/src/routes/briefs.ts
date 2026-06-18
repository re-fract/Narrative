import { Router, Response } from 'express';
import { generateNimSummary } from '../services/nimClient.js';
import { pool } from '../db/index.js';
import { fetchAllFeeds } from '../services/rssFetcher.js';
import { fetchArticleText } from '../services/articleScraper.js';
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

// Serialize brief generation per day to prevent race conditions
// where two concurrent requests both start generating, steal article
// links, and leave the stored brief pointing to orphaned stories.
const briefGenerationLocks = new Map<string, Promise<void>>();

function getTodayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

async function formatBriefFromRow(row: { brief_date: string; story_ids: number[] }) {
  const today = row.brief_date;
  const storyIds: number[] = row.story_ids;

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

async function getOrCreateBrief() {
  const today = getTodayUTC();

  // 1. Fast path: brief already exists
  const existing = await pool.query('SELECT * FROM briefs WHERE brief_date = $1', [today]);
  if (existing.rows.length > 0) {
    return formatBriefFromRow(existing.rows[0]);
  }

  // 2. Someone else is generating — wait for them
  const lock = briefGenerationLocks.get(today);
  if (lock) {
    await lock;
    // Retry — brief should now exist (or the other attempt failed)
    const afterWait = await pool.query('SELECT * FROM briefs WHERE brief_date = $1', [today]);
    if (afterWait.rows.length > 0) {
      return formatBriefFromRow(afterWait.rows[0]);
    }
    throw new Error('Brief generation failed or race condition occurred');
  }

  // 3. We're responsible for generating
  let resolveLock!: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    resolveLock = resolve;
  });
  briefGenerationLocks.set(today, lockPromise);

  try {
    // Double-check inside the serialized section
    const recheck = await pool.query('SELECT * FROM briefs WHERE brief_date = $1', [today]);
    if (recheck.rows.length > 0) {
      return formatBriefFromRow(recheck.rows[0]);
    }

    // === GENERATION (same as before) ===
  let aiState = { available: true };

  // Fetch feeds
  const rawArticles = await fetchAllFeeds();
  rawArticles.splice(15);

  if (rawArticles.length === 0) {
    return { date: today, stories: [] };
  }

  // Insert articles into DB
  const articleIds: number[] = [];
  console.log(`[BRIEF] Inserting ${rawArticles.length} articles into DB...`);
  for (const a of rawArticles) {
    const res = await pool.query(
      `INSERT INTO articles (source_id, url, title, body, published_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body
       RETURNING id, story_id, source_id`,
      [a.sourceId, a.url, a.title, stripHtml(a.body), a.publishedAt]
    );
    if (!res.rows?.[0]?.id) {
      console.error(`[BRIEF FAIL] Insert returned no ID for article URL=${a.url}, rowCount=${res.rowCount}`);
      continue;
    }
    articleIds.push(res.rows[0].id);
    console.log(`[BRIEF ARTICLE] Inserted/updated: id=${res.rows[0].id}, url="${a.url}", sourceId=${res.rows[0].source_id}, prevStoryId=${res.rows[0].story_id}`);
  }
  console.log(`[BRIEF] articleIds collected: [${articleIds.join(', ')}] (count:${articleIds.length})`);

  // Fetch full text for articles in parallel
  await Promise.all(
    rawArticles.map(async (a) => {
      try {
        const text = await fetchArticleText(a.url);
        if (text) {
          await pool.query('UPDATE articles SET full_text = $1 WHERE url = $2', [text, a.url]);
        }
      } catch (err) {
        console.warn('Failed to fetch full text for', a.url, err);
      }
    })
  );

  // Create one story per article (no clustering)
  // Step 1: Create all stories and link articles (fast DB ops, can stay sequential)
  const storyIdsForBrief: number[] = [];
  const articleStoryPairs: { storyId: number; articleId: number }[] = [];

  for (let i = 0; i < rawArticles.length; i++) {
    let updateRowCount = 0;
    const articleId = articleIds[i];
    const a = rawArticles[i];

    console.log(`[BRIEF LINK-START] i=${i} articleId=${articleId} (url="${a.url}") => about to create story`);

    const storyRes = await pool.query<{ id: number }>(
      `INSERT INTO stories (title, summary, article_count, status, first_seen_at, last_updated_at)
       VALUES ($1, $2, $3, 'active', NOW(), NOW())
       RETURNING id`,
      ['Untitled', '', 1]
    );
    const storyId = storyRes.rows[0].id;
    storyIdsForBrief.push(storyId);
    console.log(`[BRIEF LINK-STORY] i=${i} created storyId=${storyId}`);

    const updateRes = await pool.query(
      'UPDATE articles SET story_id = $1 WHERE id = $2',
      [storyId, articleId]
    );
    updateRowCount = updateRes.rowCount ?? 0;
    console.log(`[BRIEF LINK-ARTICLE] UPDATED articleId=${articleId} -> storyId=${storyId}, rowCount=${updateRowCount}`);

    if (updateRowCount === 0) {
      console.warn(`[BRIEF WARN] UPDATE affected 0 rows for articleId=${articleId} -> storyId=${storyId}`);
    }

    articleStoryPairs.push({ storyId, articleId });
  }

  // Step 2: Generate all summaries in parallel with stagger (slow NIM calls)
  await Promise.all(
    articleStoryPairs.map(async ({ storyId, articleId }, index) => {
      // Stagger starts by 500ms per article to avoid rate-limiting NIM
      await new Promise(resolve => setTimeout(resolve, index * 500));

      try {
        const members = await pool.query<ArticleRow>(
          'SELECT * FROM articles WHERE id = $1',
          [articleId]
        );
        // Each article gets its own aiState so failures are independent
        const summary = await buildSummary(members.rows, { available: true });

        await pool.query(
          'UPDATE stories SET title = $1, summary = $2 WHERE id = $3',
          [summary.title, summary.text, storyId]
        );
      } catch (err) {
        console.error(`Failed to build summary for story ${storyId}:`, err);
      }
    })
  );

  // Verification query to confirm linkage
  if (articleIds.length > 0) {
    const verifyRes = await pool.query<{ id: number; story_id: number | null; url: string }>(
      'SELECT id, story_id, url FROM articles WHERE id = ANY($1)',
      [articleIds]
    );
    console.log(`[BRIEF VERIFY] Post-linkage check for ${verifyRes.rows.length} articles:`);
    for (const row of verifyRes.rows) {
      console.log(`  ARTICLE id=${row.id} story_id=${row.story_id} url="${row.url}"`);
    }
  } else {
    console.log(`[BRIEF VERIFY] No articleIds to verify (rawArticles was empty)`);
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
  } finally {
    briefGenerationLocks.delete(today);
    resolveLock();
  }
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
      const articleText = article.full_text || article.body || '';
      const promptText = `Summarize the following article in exactly 3 concise bullet points.\nRules:\n- Each bullet must be one sentence only (under 140 characters).\n- Do not add any preamble, explanation, or labels.\n- Return ONLY the bullet points.\n\n${article.title}. ${articleText}`;
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
      const articleText = a.full_text || a.body || '';
      const promptText = `Summarize this article in 2-3 sentences:\n\n${a.title}. ${articleText}`;
      const result = await generateNimSummary(promptText);

      if (result) {
        perArticle.push(result);
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
