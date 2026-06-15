import { Router, Response } from 'express';
import genAI from '../services/geminiClient.js';
import { pool } from '../db/index.js';
import { fetchAllFeeds } from '../services/rssFetcher.js';
import { trackAPICall } from '../services/budgetTracker.js';
import { averageVectors } from '../services/vectorUtils.js';
import { summarizeSingle, synthesizeClusterSummary } from '../services/summarizer.js';
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

const DEFAULT_SOURCES = [
  { feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml', id: 1, name: 'BBC News' },
  { feedUrl: 'https://www.theguardian.com/world/rss', id: 2, name: 'The Guardian' },
  { feedUrl: 'https://feeds.reuters.com/reuters/worldNews', id: 3, name: 'Reuters' },
  { feedUrl: 'https://rss.cnn.com/rss/edition.rss', id: 4, name: 'CNN' },
];

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
  if (!genAI) {
    throw new Error('Gemini API key not configured');
  }

  // Fetch feeds
  const rawArticles = await fetchAllFeeds(DEFAULT_SOURCES);

  if (rawArticles.length === 0) {
    return { date: today, stories: [] };
  }

  // Insert sources if not exist
  for (const s of DEFAULT_SOURCES) {
    await pool.query(
      `INSERT INTO sources (id, name, feed_url, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (feed_url) DO NOTHING`,
      [s.id, s.name, s.feedUrl]
    );
  }

  // Insert articles into DB
  const articleIds: number[] = [];
  for (const a of rawArticles) {
    const res = await pool.query(
      `INSERT INTO articles (source_id, url, title, body, published_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body
       RETURNING id`,
      [a.sourceId, a.url, a.title, a.body, a.publishedAt]
    );
    articleIds.push(res.rows[0].id);
  }

  // Batch embed
  const texts = rawArticles.map((a) => `${a.title}. ${a.body}`);
  const embedResp = await genAI.models.embedContent({
    model: 'text-embedding-004',
    contents: texts.map((t) => ({ parts: [{ text: t }] })),
  });
  await trackAPICall();

  const embeddings = (embedResp.embeddings ?? []).map((e: { values?: number[] }) => e.values ?? []);

  // Get active stories from last 7 days
  const activeStories = await pool.query<StoryRow>(
    `SELECT * FROM stories
     WHERE last_updated_at > NOW() - INTERVAL '7 days'
     AND status = 'active'`
  );

  // Cluster articles
  const storyCentroids = new Map<number, number[][]>(); // story_id -> array of embeddings
  const newArticleClusters: number[][][] = [];
  const newArticleIds: number[][] = [];

  for (let i = 0; i < rawArticles.length; i++) {
    const embedding = embeddings[i];
    const articleId = articleIds[i];
    let matched = false;

    for (const story of activeStories.rows) {
      if (!story.centroid) continue;
      const sim = cosineSimilarity(embedding, story.centroid);
      if (sim > 0.82) {
        const existing = storyCentroids.get(story.id) || [];
        existing.push(embedding);
        storyCentroids.set(story.id, existing);
        await pool.query('UPDATE articles SET story_id = $1 WHERE id = $2', [story.id, articleId]);
        matched = true;
        break;
      }
    }

    if (!matched) {
      newArticleClusters.push([embedding]);
      newArticleIds.push([articleId]);
    }
  }

  // Summarize each story
  const storyIdsForBrief: number[] = [];

  // Process existing stories
  for (const [storyId] of storyCentroids) {
    const members = await pool.query<ArticleRow>(
      'SELECT * FROM articles WHERE story_id = $1 ORDER BY published_at DESC',
      [storyId]
    );
    const summary = await buildSummary(members.rows, genAI);
    const newCentroid = averageVectors(storyCentroids.get(storyId) ?? []);
    await pool.query(
      `UPDATE stories
       SET title = $1, summary = $2, centroid = $3, article_count = article_count + $4, last_updated_at = NOW()
       WHERE id = $5`,
      [summary.title, summary.text, JSON.stringify(newCentroid), members.rows.length, storyId]
    );
    storyIdsForBrief.push(storyId);
  }

  // Process new stories (clusters)
  for (let i = 0; i < newArticleClusters.length; i++) {
    const clusterIds = newArticleIds[i];
    if (clusterIds.length === 0) continue;

    const members = await pool.query<ArticleRow>(
      'SELECT * FROM articles WHERE id = ANY($1)',
      [clusterIds]
    );
    const summary = await buildSummary(members.rows, genAI);
    const centroid = averageVectors(newArticleClusters[i]);

    const storyRes = await pool.query<{ id: number }>(
      `INSERT INTO stories (title, summary, centroid, article_count, status, first_seen_at, last_updated_at)
       VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
       RETURNING id`,
      [summary.title, summary.text, JSON.stringify(centroid), members.rows.length]
    );
    const newStoryId = storyRes.rows[0].id;
    await pool.query(
      'UPDATE articles SET story_id = $1 WHERE id = ANY($2)',
      [newStoryId, clusterIds]
    );
    storyIdsForBrief.push(newStoryId);
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

async function buildSummary(articles: ArticleRow[], genAI: NonNullable<typeof import('../services/geminiClient.js').default>) {
  if (articles.length === 1) {
    const text = `${articles[0].title}. ${articles[0].body?.slice(0, 3000) ?? ''}`;
    const result = await genAI.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Summarize the following article in exactly 3 concise bullet points (one line each). Return only the bullet points, no preamble:' },
            { text },
          ],
        },
      ],
    });
    const summaryText = result.text ?? '';
    const title = summaryText.split('\n')[0].replace(/^[•\-\*]\s*/, '').slice(0, 500);
    return { title, text: summaryText };
  }

  // Map-reduce for multi-article stories
  const perArticle: string[] = [];
  for (const a of articles) {
    const text = `${a.title}. ${a.body?.slice(0, 3000) ?? ''}`;
    const result = await genAI.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Summarize this article in 2-3 sentences:' },
            { text },
          ],
        },
      ],
    });
    perArticle.push(result.text ?? '');
    await trackAPICall();
  }

  const combined = perArticle.join('\n\n');
  const result = await genAI.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'You are given summaries of related news articles. Synthesize them into exactly 3 concise bullet points that capture the key facts and angles. Return only the bullet points, no preamble.' },
          { text: combined },
        ],
      },
    ],
  });
  const summaryText = result.text ?? '';
  const title = summaryText.split('\n')[0].replace(/^[•\-\*]\s*/, '').slice(0, 500);
  return { title, text: summaryText };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
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

export default router;
