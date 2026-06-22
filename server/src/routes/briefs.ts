import { Router, Response } from 'express';
import { generateNimSummary } from '../services/nimClient.js';
import { pool } from '../db/index.js';
import { fetchAllFeeds, getActiveSourceMetadata } from '../services/rssFetcher.js';
import { fetchArticleText } from '../services/articleScraper.js';
import { generateEmbedding } from '../services/geminiClient.js';
import { cosineSimilarity, averageVectors } from '../services/vectorUtils.js';
import { findSimilarStoryWithScore, weightedCentroidUpdate, SIMILARITY_THRESHOLD } from '../services/storyCluster.js';
import { prepareCandidates, type CandidateArticle } from '../services/candidateFilter.js';
import { scoreStory, selectBalancedStories, type StoryArticleForScoring } from '../services/storyScoring.js';
import { buildTimelineEvents } from '../services/timelineBuilder.js';
import type { ArticleRow, StoryRow } from '../types/index.js';

const MERGE_WINDOW_DAYS = 14;
const MAX_BRIEF_STORIES = 14;

type ArticleWithEmbedding = ArticleRow & {
  embedding: number[];
  main_genre: 'india' | 'global' | null;
  sub_genre: string | null;
  importance_score: number | null;
  is_low_signal: boolean;
};

function parseBullets(summary: string): string[] {
  return summary
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[\u2022\-\*]\s*/, ''))
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

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function getTodayUTC(): string {
  return new Date().toISOString().split('T')[0];
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

const router = Router();
const briefGenerationLocks = new Map<string, Promise<void>>();

async function formatBriefFromRow(row: { brief_date: string; story_ids: number[]; article_ids: number[] | null }) {
  const today = row.brief_date;

  if (row.article_ids && row.article_ids.length > 0) {
    const articlesResult = await pool.query<{
      id: number;
      title: string;
      summary: string | null;
      story_id: number | null;
      source_id: number;
      published_at: Date | null;
      source_name: string;
      category: string | null;
      sub_genre: string | null;
      main_genre: string | null;
    }>(
      `SELECT a.id, a.title, a.summary, a.story_id, a.source_id, a.published_at,
              src.name as source_name, src.category, a.sub_genre, a.main_genre
       FROM articles a
       JOIN sources src ON a.source_id = src.id
       WHERE a.id = ANY($1)`,
      [row.article_ids]
    );

    const articleMap = new Map(articlesResult.rows.map(r => [r.id, r]));
    return {
      date: today,
      articles: row.article_ids.map((id: number) => {
        const a = articleMap.get(id);
        return {
          id: a?.id ?? id,
          title: a?.title ?? 'Untitled',
          bullets: parseBullets(a?.summary ?? ''),
          storyId: a?.story_id,
          sourceName: a?.source_name ?? 'Unknown',
          category: a?.sub_genre ?? a?.category ?? 'News',
          mainGenre: a?.main_genre ?? null,
          subGenre: a?.sub_genre ?? null,
          timeAgo: formatTimeAgo(a?.published_at ?? null),
        };
      }),
    };
  }

  const storyIds: number[] = row.story_ids;
  const stories = await pool.query(
    'SELECT id, title, summary, article_count, source_count, main_genre, sub_genre FROM stories WHERE id = ANY($1)',
    [storyIds]
  );

  return {
    date: today,
    stories: storyIds.map((id: number) => {
      const s = stories.rows.find((r: StoryRow) => r.id === id);
      return {
        id: s?.id ?? id,
        title: s?.title ?? 'Untitled',
        bullets: parseBullets(s?.summary ?? ''),
        sourceCount: s?.source_count ?? 1,
        category: s?.sub_genre ?? 'News',
        mainGenre: s?.main_genre ?? null,
        subGenre: s?.sub_genre ?? null,
        timeAgo: 'Today',
      };
    }),
  };
}

async function insertCandidate(candidate: CandidateArticle, embedding: number[] | null): Promise<ArticleWithEmbedding | null> {
  const result = await pool.query<ArticleWithEmbedding>(
    `INSERT INTO articles (
       source_id, url, title, normalized_title, body, published_at, embedding,
       main_genre, sub_genre, importance_score, is_low_signal, low_signal_reason,
       region_confidence, genre_confidence
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, NULL, $11, $12)
     ON CONFLICT (url) DO UPDATE SET
       title = EXCLUDED.title,
       normalized_title = EXCLUDED.normalized_title,
       body = EXCLUDED.body,
       published_at = EXCLUDED.published_at,
       embedding = COALESCE(EXCLUDED.embedding, articles.embedding),
       main_genre = EXCLUDED.main_genre,
       sub_genre = EXCLUDED.sub_genre,
       importance_score = EXCLUDED.importance_score,
       is_low_signal = false,
       low_signal_reason = NULL,
       region_confidence = EXCLUDED.region_confidence,
       genre_confidence = EXCLUDED.genre_confidence
     RETURNING id, story_id, source_id, url, title, body, full_text, embedding,
               published_at, fetched_at, main_genre, sub_genre, importance_score, is_low_signal`,
    [
      candidate.sourceId,
      candidate.url,
      candidate.title,
      candidate.normalizedTitle,
      stripHtml(candidate.body),
      candidate.publishedAt,
      embedding ? JSON.stringify(embedding) : null,
      candidate.mainGenre,
      candidate.subGenre,
      candidate.importanceScore,
      candidate.regionConfidence,
      candidate.genreConfidence,
    ]
  );

  const row = result.rows[0];
  if (!row || !embedding) return null;
  return { ...row, embedding };
}

async function loadRecentStories() {
  const existingStoriesResult = await pool.query<{
    id: number;
    centroid: string | number[];
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

  const stories = existingStoriesResult.rows.map(r => ({
    id: r.id,
    centroid: typeof r.centroid === 'string' ? JSON.parse(r.centroid) : r.centroid,
    articleCount: r.article_count,
    title: r.title,
    summary: r.summary,
  }));

  return { result: existingStoriesResult, stories };
}

async function fetchStoryArticles(storyId: number): Promise<StoryArticleForScoring[]> {
  const result = await pool.query<StoryArticleForScoring>(
    `SELECT a.id, a.title, a.body, a.published_at, a.source_id,
            COALESCE(src.priority, 1) as source_priority,
            a.main_genre, a.sub_genre, a.importance_score, a.is_low_signal
     FROM articles a
     JOIN sources src ON a.source_id = src.id
     WHERE a.story_id = $1
     ORDER BY a.published_at DESC NULLS LAST`,
    [storyId]
  );
  return result.rows;
}

async function updateStoryAggregates(storyId: number) {
  const articles = await fetchStoryArticles(storyId);
  const score = scoreStory(articles);
  if (!score) return null;

  await pool.query(
    `UPDATE stories
     SET main_genre = $1,
         sub_genre = $2,
         importance_score = $3,
         source_count = $4,
         representative_article_id = $5
     WHERE id = $6`,
    [score.mainGenre, score.subGenre, score.importanceScore, score.sourceCount, score.representativeArticleId, storyId]
  );

  for (const [articleId, rank] of score.representativeRanks.entries()) {
    await pool.query('UPDATE articles SET representative_rank = $1 WHERE id = $2', [rank, articleId]);
  }

  return score;
}

async function generateTimelineEntries(storyId: number) {
  const articlesResult = await pool.query<{
    id: number;
    story_id: number;
    title: string;
    body: string | null;
    published_at: Date | null;
    importance_score: number | string | null;
    representative_rank: number | string | null;
  }>(
    `SELECT id, story_id, title, body, published_at, importance_score, representative_rank
     FROM articles
     WHERE story_id = $1
       AND published_at >= NOW() - INTERVAL '${MERGE_WINDOW_DAYS} days'
     ORDER BY published_at ASC NULLS LAST`,
    [storyId]
  );

  const events = buildTimelineEvents(articlesResult.rows);
  await pool.query('DELETE FROM timeline_entries WHERE story_id = $1', [storyId]);
  for (const event of events) {
    await pool.query(
      `INSERT INTO timeline_entries (
         story_id, triggered_by_article_id, representative_article_id,
         classification, text, event_date, importance_score
       )
       VALUES ($1, $2, $2, $3, $4, $5, $6)`,
      [
        storyId,
        event.representativeArticleId,
        event.classification,
        event.text,
        event.eventDate,
        event.importanceScore,
      ]
    );
  }
  await pool.query('UPDATE stories SET event_count = $1 WHERE id = $2', [events.length, storyId]);
}

async function summarizeStories(storyIds: number[]) {
  await runWithConcurrency(
    storyIds,
    3,
    async (storyId, index) => {
      await new Promise(resolve => setTimeout(resolve, index * 500));
      try {
        const articlesResult = await pool.query<ArticleRow>(
          `SELECT id, story_id, source_id, url, title, body, full_text, embedding, published_at, fetched_at
           FROM articles
           WHERE story_id = $1
           ORDER BY published_at DESC NULLS LAST`,
          [storyId]
        );
        const summary = await buildSummary(articlesResult.rows, { available: true });
        await pool.query(
          'UPDATE stories SET title = $1, summary = $2 WHERE id = $3',
          [summary.title, summary.text, storyId]
        );
      } catch (err) {
        console.error(`Failed to build summary for story ${storyId}:`, err);
      }
    }
  );
}

async function summarizeBriefArticles(articleIds: number[]) {
  const briefArticlesResult = await pool.query<ArticleRow & { summary: string | null }>(
    `SELECT id, story_id, source_id, url, title, body, full_text, embedding, published_at, fetched_at, summary
     FROM articles
     WHERE id = ANY($1)`,
    [articleIds]
  );

  await runWithConcurrency(
    briefArticlesResult.rows,
    3,
    async (article, index) => {
      if (article.summary) return;
      await new Promise(resolve => setTimeout(resolve, index * 500));
      try {
        const result = await buildSummary([article], { available: true });
        await pool.query('UPDATE articles SET summary = $1 WHERE id = $2', [result.text, article.id]);
      } catch (err) {
        console.error(`Failed to build summary for article ${article.id}:`, err);
      }
    }
  );
}

async function chooseTodayRepresentativeArticleIds(storyIds: number[]): Promise<number[]> {
  const articleIds: number[] = [];

  for (const storyId of storyIds) {
    const result = await pool.query<{ id: number }>(
      `SELECT a.id
       FROM articles a
       JOIN sources src ON src.id = a.source_id
       WHERE a.story_id = $1
         AND a.published_at >= CURRENT_DATE
         AND a.published_at < CURRENT_DATE + INTERVAL '1 day'
         AND COALESCE(a.is_low_signal, false) = false
       ORDER BY COALESCE(a.representative_rank, 0) DESC,
                COALESCE(src.priority, 1) DESC,
                COALESCE(a.importance_score, 0) DESC,
                a.published_at DESC NULLS LAST
       LIMIT 1`,
      [storyId]
    );

    if (result.rows[0]?.id) {
      articleIds.push(result.rows[0].id);
      await pool.query(
        'UPDATE stories SET representative_article_id = $1 WHERE id = $2',
        [result.rows[0].id, storyId]
      );
    }
  }

  return articleIds;
}

async function getOrCreateBrief() {
  const today = getTodayUTC();

  const existing = await pool.query('SELECT * FROM briefs WHERE brief_date = $1 ORDER BY created_at DESC LIMIT 1', [today]);
  if (existing.rows.length > 0) {
    return formatBriefFromRow(existing.rows[0]);
  }

  const lock = briefGenerationLocks.get(today);
  if (lock) {
    await lock;
    const afterWait = await pool.query('SELECT * FROM briefs WHERE brief_date = $1 ORDER BY created_at DESC LIMIT 1', [today]);
    if (afterWait.rows.length > 0) {
      return formatBriefFromRow(afterWait.rows[0]);
    }
    throw new Error('Brief generation failed or race condition occurred');
  }

  let resolveLock!: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    resolveLock = resolve;
  });
  briefGenerationLocks.set(today, lockPromise);

  try {
    const recheck = await pool.query('SELECT * FROM briefs WHERE brief_date = $1 ORDER BY created_at DESC LIMIT 1', [today]);
    if (recheck.rows.length > 0) {
      return formatBriefFromRow(recheck.rows[0]);
    }

    const [rawArticles, sourceMetadata] = await Promise.all([
      fetchAllFeeds(),
      getActiveSourceMetadata(),
    ]);
    const { candidates, report } = prepareCandidates(rawArticles, sourceMetadata);
    console.log('[BRIEF QUALITY]', {
      totalFetchedCandidates: report.totalFetched,
      filteredOutCounts: report.filteredByReason,
      keptCandidateCountBeforeEmbeddings: report.keptBeforeEmbeddings,
    });

    if (candidates.length === 0) {
      return { date: today, articles: [] };
    }

    const insertedArticles: ArticleWithEmbedding[] = [];
    for (const candidate of candidates) {
      try {
        const combinedText = `${candidate.title}\n${stripHtml(candidate.body)}`;
        const embedding = await generateEmbedding(combinedText);
        const inserted = await insertCandidate(candidate, embedding);
        if (inserted) insertedArticles.push(inserted);
      } catch (err) {
        console.error(`[BRIEF FAIL] Insert/Embed failed for ${candidate.url}`, err);
      }
    }

    await runWithConcurrency(
      insertedArticles,
      3,
      async (a) => {
        try {
          const text = await fetchArticleText(a.url);
          if (text) {
            await pool.query('UPDATE articles SET full_text = $1 WHERE url = $2', [text, a.url]);
            a.full_text = text;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`Failed to store full text for ${a.url}: ${message}`);
        }
      }
    );

    const { result: existingStoriesResult, stories: existingStories } = await loadRecentStories();
    const mergedStoryNewEmbeddings = new Map<number, number[][]>();
    const affectedStoryIds = new Set<number>();
    const unmatchedArticles: ArticleWithEmbedding[] = [];

    for (const article of insertedArticles) {
      if (article.story_id) {
        affectedStoryIds.add(article.story_id);
        continue;
      }

      const match = findSimilarStoryWithScore(article.embedding, existingStories);
      if (match) {
        const { story: matchedStory, score } = match;
        await pool.query('UPDATE articles SET story_id = $1 WHERE id = $2', [matchedStory.id, article.id]);
        article.story_id = matchedStory.id;
        affectedStoryIds.add(matchedStory.id);

        const embList = mergedStoryNewEmbeddings.get(matchedStory.id) ?? [];
        embList.push(article.embedding);
        mergedStoryNewEmbeddings.set(matchedStory.id, embList);

        const storyInMemory = existingStories.find(s => s.id === matchedStory.id);
        if (storyInMemory) {
          storyInMemory.centroid = weightedCentroidUpdate(storyInMemory.centroid, storyInMemory.articleCount, [article.embedding]);
          storyInMemory.articleCount += 1;
        }
        console.log(`[BRIEF] Merged article ${article.id} into story ${matchedStory.id} (${score.toFixed(3)})`);
      } else {
        unmatchedArticles.push(article);
      }
    }

    interface Cluster {
      articles: ArticleWithEmbedding[];
      centroid: number[];
    }
    const newClusters: Cluster[] = [];
    for (const article of unmatchedArticles) {
      let bestCluster: Cluster | null = null;
      let bestScore = -Infinity;
      for (const cluster of newClusters) {
        const score = cosineSimilarity(article.embedding, cluster.centroid);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = cluster;
        }
      }
      if (bestCluster && bestScore >= SIMILARITY_THRESHOLD) {
        bestCluster.articles.push(article);
        bestCluster.centroid = averageVectors(bestCluster.articles.map(a => a.embedding));
      } else {
        newClusters.push({ articles: [article], centroid: article.embedding });
      }
    }

    for (const cluster of newClusters) {
      const storyRes = await pool.query<{ id: number }>(
        `INSERT INTO stories (title, summary, article_count, status, centroid, first_seen_at, last_updated_at)
         VALUES ($1, $2, $3, 'active', $4, NOW(), NOW())
         RETURNING id`,
        ['Untitled', '', cluster.articles.length, JSON.stringify(cluster.centroid)]
      );
      const storyId = storyRes.rows[0].id;
      const articleIds = cluster.articles.map(a => a.id);
      await pool.query('UPDATE articles SET story_id = $1 WHERE id = ANY($2)', [storyId, articleIds]);
      for (const article of cluster.articles) article.story_id = storyId;
      affectedStoryIds.add(storyId);
      console.log(`[BRIEF STORY] Created story ${storyId} with ${cluster.articles.length} articles`);
    }

    for (const [storyId, newEmbeddings] of mergedStoryNewEmbeddings.entries()) {
      const original = existingStoriesResult.rows.find(r => r.id === storyId);
      if (!original) continue;
      const oldCount = original.article_count;
      const oldCentroid: number[] = typeof original.centroid === 'string' ? JSON.parse(original.centroid) : original.centroid;
      const newCentroid = weightedCentroidUpdate(oldCentroid, oldCount, newEmbeddings);
      const newCount = oldCount + newEmbeddings.length;
      await pool.query(
        `UPDATE stories
         SET centroid = $1, article_count = $2, last_updated_at = NOW(),
             expansion_json = NULL
         WHERE id = $3`,
        [JSON.stringify(newCentroid), newCount, storyId]
      );
      await pool.query('DELETE FROM simplifications WHERE story_id = $1', [storyId]);
    }

    const scoreLogs = [];
    for (const storyId of affectedStoryIds) {
      const score = await updateStoryAggregates(storyId);
      await generateTimelineEntries(storyId);
      if (score) {
        scoreLogs.push({
          storyId,
          mainGenre: score.mainGenre,
          subGenre: score.subGenre,
          sourceCount: score.sourceCount,
          importanceScore: score.importanceScore,
          representativeArticleId: score.representativeArticleId,
          components: score.components,
        });
      }
    }
    console.log('[BRIEF SCORES updated]', scoreLogs);

    await summarizeStories([...affectedStoryIds]);

    const candidateStoriesResult = await pool.query<{
      id: number;
      title: string | null;
      main_genre: 'india' | 'global' | null;
      sub_genre: string | null;
      importance_score: number | string | null;
      source_count: number;
      representative_article_id: number | null;
    }>(
      `SELECT DISTINCT st.id, st.title, st.main_genre, st.sub_genre, st.importance_score,
              st.source_count, st.representative_article_id
       FROM stories st
       JOIN articles a ON a.story_id = st.id
       WHERE a.published_at >= CURRENT_DATE
         AND a.published_at < CURRENT_DATE + INTERVAL '1 day'
         AND st.status = 'active'
         AND st.representative_article_id IS NOT NULL
       ORDER BY st.importance_score DESC NULLS LAST
       LIMIT 60`
    );

    const selectedStories = selectBalancedStories(candidateStoriesResult.rows, MAX_BRIEF_STORIES);
    const storyIds = selectedStories.map(story => story.id);
    const articleIds = await chooseTodayRepresentativeArticleIds(storyIds);

    console.log('[BRIEF FINAL]', selectedStories.map(story => ({
      storyId: story.id,
      title: story.title,
      mainGenre: story.main_genre,
      subGenre: story.sub_genre,
      sourceCount: story.source_count,
      importanceScore: story.importance_score,
      representativeArticleId: articleIds[storyIds.indexOf(story.id)] ?? story.representative_article_id,
    })));

    await summarizeBriefArticles(articleIds);

    await pool.query(
      `INSERT INTO briefs (brief_date, story_ids, article_ids)
       VALUES ($1, $2, $3)`,
      [today, storyIds, articleIds]
    );

    return formatBriefFromRow({ brief_date: today, story_ids: storyIds, article_ids: articleIds });
  } finally {
    briefGenerationLocks.delete(today);
    resolveLock();
  }
}

function generateFallbackSummary(article: ArticleRow): { title: string; text: string } {
  const title = article.title ?? 'Untitled';
  const body = stripHtml(article.body ?? '');
  const sentences = body.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0);
  const bullets: string[] = [];
  for (let i = 0; i < Math.min(2, sentences.length); i++) {
    let sentence = sentences[i].slice(0, 140);
    if (sentences[i].length > 140) sentence += '...';
    bullets.push(`- ${sentence}`);
  }
  if (sentences.length > 2) bullets.push('- ...');
  return { title, text: bullets.join('\n') };
}

async function buildSummary(
  articles: ArticleRow[],
  aiState: { available: boolean },
) {
  if (articles.length === 0) {
    return { title: 'Untitled', text: '' };
  }

  if (articles.length === 1) {
    const article = articles[0];

    if (aiState.available) {
      const articleText = article.full_text || article.body || '';
      const promptText = `Summarize the following article in exactly 3 concise bullet points.
Rules:
- Each bullet must be one sentence only (under 140 characters).
- Do not add any preamble, explanation, or labels.
- Return ONLY the bullet points.

${article.title}. ${articleText}`;
      const result = await generateNimSummary(promptText);

      if (result) {
        const summaryText = result;
        const title = summaryText.split('\n')[0].replace(/^[\u2022\-\*]\s*/, '').slice(0, 500);
        return { title, text: summaryText };
      }

      aiState.available = false;
    }

    return generateFallbackSummary(article);
  }

  const perArticle: string[] = [];

  if (aiState.available) {
    for (const article of articles) {
      const articleText = article.full_text || article.body || '';
      const promptText = `Summarize this article in 2-3 sentences:\n\n${article.title}. ${articleText}`;
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
    const promptText = `You are given summaries of related news articles. Synthesize them into exactly 3 concise bullet points.
Rules:
- Each bullet must be one sentence only (under 140 characters).
- Do not add any preamble, explanation, or labels.
- Return ONLY the bullet points.

${combined}`;
    const result = await generateNimSummary(promptText);

    if (result) {
      const summaryText = result;
      const title = summaryText.split('\n')[0].replace(/^[\u2022\-\*]\s*/, '').slice(0, 500);
      return { title, text: summaryText };
    }

    aiState.available = false;
  }

  const title = articles[0].title ?? 'Untitled';
  const bullets: string[] = [];
  for (const article of articles) {
    const body = article.body ?? '';
    const sentences = body
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (sentences.length > 0) bullets.push(`- ${sentences[0].slice(0, 160)}`);
    if (bullets.length >= 3) break;
  }

  const text = bullets.length > 0
    ? bullets.join('\n')
    : `- ${articles[0].body?.slice(0, 200) ?? 'No content'}`;

  return { title, text };
}

router.get('/today', async (req, res: Response) => {
  try {
    const brief = await getOrCreateBrief();
    res.json(brief);
  } catch (err) {
    console.error('Brief error:', err);
    res.status(500).json({ error: 'Failed to generate brief' });
  }
});

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
