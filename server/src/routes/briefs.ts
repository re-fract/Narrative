import { Router, Response } from 'express';
import { generateNimSummary } from '../services/nimClient.js';
import { pool } from '../db/index.js';
import { fetchAllFeeds } from '../services/rssFetcher.js';
import { fetchArticleText } from '../services/articleScraper.js';
import { generateEmbedding } from '../services/geminiClient.js';
import { cosineSimilarity, averageVectors } from '../services/vectorUtils.js';
import { findSimilarStoryWithScore, weightedCentroidUpdate, SIMILARITY_THRESHOLD } from '../services/storyCluster.js';
import type { ArticleRow, StoryRow } from '../types/index.js';

const MERGE_WINDOW_DAYS = 7; // Stories older than this won't absorb new articles

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

    // === GENERATION ===
    let aiState = { available: true };

    // Fetch feeds
    const rawArticles = await fetchAllFeeds();

    if (rawArticles.length === 0) {
      return { date: today, stories: [] };
    }

    // Insert articles into DB and generate embeddings
    console.log(`[BRIEF] Processing ${rawArticles.length} articles...`);
    const insertedArticles: (ArticleRow & { embedding: number[] })[] = [];

    for (const a of rawArticles) {
      try {
        // Get embedding based on title and snippet
        const combinedText = a.title + '\n' + stripHtml(a.body);
        const embedding = await generateEmbedding(combinedText);
        
        const res = await pool.query(
          `INSERT INTO articles (source_id, url, title, body, published_at, embedding)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, embedding = EXCLUDED.embedding
           RETURNING id, story_id, source_id, url, title, body, full_text, published_at`,
          [a.sourceId, a.url, a.title, stripHtml(a.body), a.publishedAt, embedding ? JSON.stringify(embedding) : null]
        );
        if (res.rows?.[0]?.id) {
          if (embedding) {
            insertedArticles.push({ ...res.rows[0], embedding });
          } else {
            // If embedding fails, log it. It will be skipped from clustering.
            console.warn(`[BRIEF WARN] No embedding generated for ${a.url}`);
          }
        }
      } catch (err) {
        console.error(`[BRIEF FAIL] Insert/Embed failed for ${a.url}`, err);
      }
    }

    console.log(`[BRIEF] articleIds with embeddings collected: ${insertedArticles.length}`);

    // Fetch full text for articles in parallel
    await Promise.all(
      insertedArticles.map(async (a) => {
        try {
          const text = await fetchArticleText(a.url);
          if (text) {
            await pool.query('UPDATE articles SET full_text = $1 WHERE url = $2', [text, a.url]);
            a.full_text = text; // update in memory for summarization
          }
        } catch (err) {
          console.warn('Failed to fetch full text for', a.url, err);
        }
      })
    );

    // ───────────────────────────────────────────────────
    // Phase 1: Load recent existing stories (last 7 days)
    // ───────────────────────────────────────────────────
    const existingStoriesResult = await pool.query<{
      id: number;
      centroid: string;
      article_count: number;
      title: string | null;
      summary: string | null;
    }>(
      `SELECT id, centroid, article_count, title, summary
       FROM stories
       WHERE centroid IS NOT NULL
         AND status = 'active'
         AND frozen_at IS NULL
         AND last_updated_at >= NOW() - INTERVAL '${MERGE_WINDOW_DAYS} days'`
    );

    // Build in-memory story list with parsed centroids
    type ExistingStory = {
      id: number;
      centroid: number[];
      articleCount: number;
      title: string | null;
      summary: string | null;
    };
    const existingStories: ExistingStory[] = existingStoriesResult.rows.map(r => ({
      id: r.id,
      centroid: typeof r.centroid === 'string' ? JSON.parse(r.centroid) : (r.centroid as unknown as number[]),
      articleCount: r.article_count,
      title: r.title,
      summary: r.summary,
    }));

    console.log(`[BRIEF] Found ${existingStories.length} existing active stories within ${MERGE_WINDOW_DAYS} days`);

    // Track which existing stories gained new articles (for centroid/cache updates)
    const mergedStoryNewEmbeddings = new Map<number, number[][]>(); // storyId → new embeddings
    const mergedStoryArticleIds = new Map<number, number[]>(); // storyId → new article ids

    // ───────────────────────────────────────────────────────────────
    // Phase 2: For each article, try to match against existing stories
    // ───────────────────────────────────────────────────────────────
    const unmatchedArticles: (ArticleRow & { embedding: number[] })[] = [];

    for (const article of insertedArticles) {
      // Skip articles that already have a story_id (they were assigned on a previous run)
      if (article.story_id) {
        console.log(`[BRIEF] Article ${article.id} already has story_id=${article.story_id}, skipping merge check`);
        continue;
      }

      const match = findSimilarStoryWithScore(article.embedding, existingStories);

      if (match) {
        const { story: matchedStory, score } = match;
        console.log(`[BRIEF] Merged article ${article.id} into existing story ${matchedStory.id} (score: ${score.toFixed(3)})`);

        // Assign story_id in the DB
        await pool.query('UPDATE articles SET story_id = $1 WHERE id = $2', [matchedStory.id, article.id]);

        // Track embeddings for centroid update
        const embList = mergedStoryNewEmbeddings.get(matchedStory.id) ?? [];
        embList.push(article.embedding);
        mergedStoryNewEmbeddings.set(matchedStory.id, embList);

        const artList = mergedStoryArticleIds.get(matchedStory.id) ?? [];
        artList.push(article.id);
        mergedStoryArticleIds.set(matchedStory.id, artList);

        // Update the in-memory centroid immediately so subsequent articles in
        // this batch can match against the already-evolved centroid
        const storyInMemory = existingStories.find(s => s.id === matchedStory.id);
        if (storyInMemory) {
          storyInMemory.centroid = weightedCentroidUpdate(
            storyInMemory.centroid,
            storyInMemory.articleCount,
            [article.embedding]
          );
          storyInMemory.articleCount += 1;
        }
      } else {
        unmatchedArticles.push(article);
      }
    }

    console.log(`[BRIEF] ${unmatchedArticles.length} articles unmatched — will form new clusters`);

    // ─────────────────────────────────────────────────────────────
    // Phase 3: Cluster unmatched articles among themselves
    // ─────────────────────────────────────────────────────────────
    interface Cluster {
      articles: typeof insertedArticles;
      centroid: number[];
    }
    const newClusters: Cluster[] = [];

    for (const a of unmatchedArticles) {
      let bestCluster: Cluster | null = null;
      let bestScore = -Infinity;

      for (const c of newClusters) {
        const score = cosineSimilarity(a.embedding, c.centroid);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = c;
        }
      }

      if (bestCluster && bestScore >= SIMILARITY_THRESHOLD) {
        bestCluster.articles.push(a);
        bestCluster.centroid = averageVectors(bestCluster.articles.map(art => art.embedding));
      } else {
        newClusters.push({
          articles: [a],
          centroid: a.embedding
        });
      }
    }

    // Sort clusters by size (most articles first)
    newClusters.sort((a, b) => b.articles.length - a.articles.length);
    const topNewClusters = newClusters.slice(0, 15);

    console.log(`[BRIEF CLUSTERS] Formed ${newClusters.length} new clusters, keeping top ${topNewClusters.length}`);

    // ─────────────────────────────────────────────────────────────
    // Phase 4: Create new stories for truly new clusters
    // ─────────────────────────────────────────────────────────────
    const storyIdsForBrief: number[] = [];
    const storyTasks: { storyId: number; articles: typeof insertedArticles; isNew: boolean }[] = [];

    for (let i = 0; i < topNewClusters.length; i++) {
      const cluster = topNewClusters[i];
      
      const storyRes = await pool.query<{ id: number }>(
        `INSERT INTO stories (title, summary, article_count, status, centroid, first_seen_at, last_updated_at)
         VALUES ($1, $2, $3, 'active', $4, NOW(), NOW())
         RETURNING id`,
        ['Untitled', '', cluster.articles.length, JSON.stringify(cluster.centroid)]
      );
      const storyId = storyRes.rows[0].id;
      storyIdsForBrief.push(storyId);
      
      const articleIdsInCluster = cluster.articles.map(a => a.id);
      await pool.query(
        'UPDATE articles SET story_id = $1 WHERE id = ANY($2)',
        [storyId, articleIdsInCluster]
      );

      storyTasks.push({ storyId, articles: cluster.articles, isNew: true });
      console.log(`[BRIEF STORY] created storyId=${storyId} with ${cluster.articles.length} articles`);
    }

    // ─────────────────────────────────────────────────────────────
    // Phase 5: Update merged existing stories in DB
    // ─────────────────────────────────────────────────────────────
    for (const [storyId, newEmbeddings] of mergedStoryNewEmbeddings.entries()) {
      const original = existingStoriesResult.rows.find(r => r.id === storyId);
      if (!original) continue;

      const oldCount = original.article_count;
      const oldCentroid: number[] = typeof original.centroid === 'string'
        ? JSON.parse(original.centroid)
        : (original.centroid as unknown as number[]);
      const newCentroid = weightedCentroidUpdate(oldCentroid, oldCount, newEmbeddings);
      const newCount = oldCount + newEmbeddings.length;

      await pool.query(
        `UPDATE stories
         SET centroid = $1, article_count = $2, last_updated_at = NOW()
         WHERE id = $3`,
        [JSON.stringify(newCentroid), newCount, storyId]
      );

      // Invalidate cached summaries so they'll be regenerated with new articles
      await pool.query('DELETE FROM simplifications WHERE story_id = $1', [storyId]);
      await pool.query('UPDATE stories SET expansion_json = NULL WHERE id = $1', [storyId]);

      // Collect articles for summary regeneration
      const allArticlesResult = await pool.query<ArticleRow>(
        'SELECT id, title, body, full_text, source_id, url, published_at, story_id FROM articles WHERE story_id = $1 ORDER BY published_at DESC',
        [storyId]
      );

      storyTasks.push({
        storyId,
        articles: allArticlesResult.rows as (ArticleRow & { embedding: number[] })[],
        isNew: false,
      });

      // Add merged story ID to the brief
      storyIdsForBrief.push(storyId);

      console.log(`[BRIEF] Updated existing story ${storyId}: article_count ${oldCount} → ${newCount}`);
    }

    // ─────────────────────────────────────────────────────────────
    // Phase 6 (de-dupe): storyIdsForBrief may have duplicates if a story
    // was merged but also appeared in a previous brief — deduplicate.
    // ─────────────────────────────────────────────────────────────
    const uniqueStoryIds = [...new Set(storyIdsForBrief)];

    // ─────────────────────────────────────────────────────────────
    // Phase 7: Generate/regenerate summaries for all affected stories
    // ─────────────────────────────────────────────────────────────
    await Promise.all(
      storyTasks.map(async ({ storyId, articles }, index) => {
        // Stagger starts by 500ms per story to avoid rate-limiting NIM
        await new Promise(resolve => setTimeout(resolve, index * 500));

        try {
          const summary = await buildSummary(articles, { available: true });

          await pool.query(
            'UPDATE stories SET title = $1, summary = $2 WHERE id = $3',
            [summary.title, summary.text, storyId]
          );
        } catch (err) {
          console.error(`Failed to build summary for story ${storyId}:`, err);
        }
      })
    );

  // Store brief
  await pool.query(
    `INSERT INTO briefs (brief_date, story_ids) VALUES ($1, $2)`,
    [today, uniqueStoryIds]
  );

  // Return the brief
  const stories = await pool.query(
    'SELECT id, title, summary, article_count FROM stories WHERE id = ANY($1)',
    [uniqueStoryIds]
  );

  const artSources = await pool.query(
    `SELECT a.story_id, s.name as source_name
     FROM articles a
     JOIN sources s ON a.source_id = s.id
     WHERE a.story_id = ANY($1)`,
    [uniqueStoryIds]
  );
  const sourceMap = new Map<number, Set<string>>();
  for (const row of artSources.rows) {
    const set = sourceMap.get(row.story_id) || new Set<string>();
    set.add(row.source_name);
    sourceMap.set(row.story_id, set);
  }

    return {
      date: today,
      stories: uniqueStoryIds.map((id: number) => {
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
