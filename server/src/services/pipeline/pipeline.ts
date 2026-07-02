/**
 * pipeline.ts — Pipeline Orchestrator (5-phase / 18-step)
 *
 * Phase 1: Ingestion   (fetch 4 APIs → F1-F7 → F8 dedup)
 * Phase 2: Classification (Cerebras gpt-oss-120b → store Tier A+B → log C+D)
 * Phase 3: Enrichment  (scrape + WorldNewsAPI lookup → Gemini embeddings)
 * Phase 4: Story Intelligence (match → cluster → dedup → metadata → score)
 * Phase 5: Brief Assembly (select → summarize → persist)
 */

import { pool } from '../../db/index.js';
import { fetchWorldnews } from '../fetchers/worldnewsFetcher.js';
import { fetchTheNewsApi } from '../fetchers/thenewsapiFetcher.js';
import { fetchNewsdata } from '../fetchers/newsdataFetcher.js';
import { fetchWebzio } from '../fetchers/webzioFetcher.js';
import { runStructuralFilters, classifyRegion } from '../filters/structuralFilters.js';
import { deduplicateArticles } from '../filters/deduplicator.js';
import { classifyArticleBatch, generateArticleSummary } from '../llm/cerebrasClient.js';
import { enrichArticles } from '../articleScraper.js';
import { batchEmbedArticles } from '../llm/geminiClient.js';
import { storyMatchScore, weightedCentroidUpdate, SIMILARITY_THRESHOLD_EXISTING, SIMILARITY_THRESHOLD_NEW } from '../stories/storyCluster.js';
import { cosineSimilarity, averageVectors } from '../vectorUtils.js';
import { dedupTodaysArticles } from '../stories/storyDedup.js';
import { updateStoryKeywords } from '../stories/storyKeywords.js';
import { scoreAllActiveStories } from '../stories/storyScoring.js';
import { selectBriefStories } from '../stories/briefSelection.js';
import { aggregateDailyMetrics } from './metrics.js';
import { CLASSIFICATION_BATCH_SIZE } from '../../config/constants.js';
import type { NormalizedArticle, ScoredArticle, FilterRejection, ScoredStory } from '../../types/index.js';

// ── Exported result type ──

export interface PipelineResult {
  success: boolean;
  articlesFetched: number;
  articlesFiltered: number;
  articlesDeduplicated: number;
  articlesClassified: number;
  articlesStored: number;
  storiesMatched: number;
  storiesCreated: number;
  storiesSummarized: number;
  briefId: number | null;
}

// ── Pipeline logging helpers ──

async function logPipelineStart(): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO pipeline_runs (started_at, status) VALUES (NOW(), 'running') RETURNING id`,
  );
  return res.rows[0].id;
}

async function logPipelineSuccess(runId: number, result: PipelineResult): Promise<void> {
  await pool.query(
    `UPDATE pipeline_runs SET
       completed_at = NOW(),
       status = 'success',
       articles_fetched = $1,
       articles_filtered = $2,
       articles_deduped = $3,
       articles_classified = $4,
       articles_stored = $5,
       stories_matched = $6,
       stories_created = $7,
       articles_summarized = $8,
       brief_id = $9
     WHERE id = $10`,
    [
      result.articlesFetched,
      result.articlesFiltered,
      result.articlesDeduplicated,
      result.articlesClassified,
      result.articlesStored,
      result.storiesMatched,
      result.storiesCreated,
      result.storiesSummarized,
      result.briefId,
      runId,
    ],
  );
}

async function logPipelineFailure(runId: number, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await pool.query(
    `UPDATE pipeline_runs SET completed_at = NOW(), status = 'failed', error_message = $1 WHERE id = $2`,
    [message, runId],
  );
}

// ── Bulk rejection insert (UNNEST-based, single INSERT) ──

async function bulkInsertRejections(items: FilterRejection[], stage: 'filter' | 'llm'): Promise<void> {
  if (items.length === 0) return;

  const urls: string[] = [];
  const titles: (string | null)[] = [];
  const sourceApis: string[] = [];
  const sourceDomains: string[] = [];
  const rejectionStages: string[] = [];
  const rejectionRules: string[] = [];
  const llmTiers: (string | null)[] = [];
  const llmCategories: (string | null)[] = [];
  const llmReasons: (string | null)[] = [];
  const contextLens: (number | null)[] = [];

  for (const item of items) {
    urls.push(item.url);
    titles.push(item.title ?? null);
    sourceApis.push(item.sourceApi);
    sourceDomains.push(item.sourceDomain);
    rejectionStages.push(stage);
    rejectionRules.push(item.rejectionRule);
    llmTiers.push(item.llmTier ?? null);
    llmCategories.push(item.llmCategory ?? null);
    llmReasons.push(item.llmReason ?? null);
    contextLens.push(item.contextLen ?? null);
  }

  await pool.query(
    `INSERT INTO rejection_log (url, title, source_api, source_domain, rejection_stage, rejection_rule, llm_tier, llm_category, llm_reason, context_len)
     SELECT u.url, u.title, u.source_api, u.source_domain, u.rejection_stage, u.rejection_rule, u.llm_tier, u.llm_category, u.llm_reason, u.context_len
     FROM UNNEST(
       $1::text[], $2::text[], $3::varchar(20)[], $4::varchar(255)[],
       $5::varchar(20)[], $6::varchar(50)[], $7::char(1)[], $8::varchar(20)[], $9::text[], $10::integer[]
     ) AS u(url, title, source_api, source_domain, rejection_stage, rejection_rule, llm_tier, llm_category, llm_reason, context_len)`,
    [urls, titles, sourceApis, sourceDomains, rejectionStages, rejectionRules, llmTiers, llmCategories, llmReasons, contextLens],
  );
}

// ── Store accepted articles (UNNEST-based bulk INSERT) ──

async function storeAcceptedArticles(articles: ScoredArticle[]): Promise<number[]> {
  if (articles.length === 0) return [];

  // Build parallel arrays for each column
  const externalIds: (string | null)[] = [];
  const sourceApis: string[] = [];
  const urls: string[] = [];
  const titleHashes: string[] = [];
  const normalizedUrlHashes: (string | null)[] = [];
  const domainTitleHashes: (string | null)[] = [];
  const titles: string[] = [];
  const descriptions: (string | null)[] = [];
  const contents: (string | null)[] = [];
  const imageUrls: (string | null)[] = [];
  const authors: (string | null)[] = [];
  const sourceNames: (string | null)[] = [];
  const sourceDomains: string[] = [];
  const publishedAts: string[] = [];
  const mainGenres: string[] = [];
  const homepageEligibles: boolean[] = [];
  const llmTiers: string[] = [];
  const llmCategories: (string | null)[] = [];
  const llmReasons: (string | null)[] = [];
  const llmModels: string[] = [];
  const filterStatuses: string[] = [];
  const apiCategories: (string | null)[] = [];
  const apiIptcCategories: (string | null)[] = [];
  const apiSentiments: (number | null)[] = [];
  const apiLanguages: (string | null)[] = [];
  const apiCountries: (string | null)[] = [];
  const apiKeywords: (string | null)[] = [];
  const apiEntities: (string | null)[] = [];
  const apiSourcePriorities: (number | null)[] = [];
  const apiRelevanceScores: (number | null)[] = [];
  const apiDomainRanks: (number | null)[] = [];
  const apiPerformances: (number | null)[] = [];
  const apiSocials: (string | null)[] = [];
  const apiDuplicateFlags: (boolean | null)[] = [];

  for (const a of articles) {
    externalIds.push(a.externalId ?? null);
    sourceApis.push(a.sourceApi);
    urls.push(a.url);
    titleHashes.push(a.titleHash);
    normalizedUrlHashes.push(a.normalizedUrlHash ?? null);
    domainTitleHashes.push(a.domainTitleHash ?? null);
    titles.push(a.title);
    descriptions.push(a.description ?? null);
    contents.push(a.content ?? null);
    imageUrls.push(a.imageUrl ?? null);
    authors.push(a.author ?? null);
    sourceNames.push(a.sourceName ?? null);
    sourceDomains.push(a.sourceDomain);
    publishedAts.push(a.publishedAt.toISOString());
    mainGenres.push(classifyRegion(a));
    homepageEligibles.push(true);
    llmTiers.push(a.llmTier);
    llmCategories.push(a.llmCategory ?? null);
    llmReasons.push(a.llmReason ?? null);
    llmModels.push('gpt-oss-120b');
    filterStatuses.push(a.filterStatus);
    apiCategories.push(a.apiCategory ?? null);
    apiIptcCategories.push(a.apiIptcCategory ?? null);
    apiSentiments.push(a.apiSentiment ?? null);
    apiLanguages.push(a.apiLanguage ?? null);
    apiCountries.push(a.apiCountry ?? null);
    apiKeywords.push(a.apiKeywords ? JSON.stringify(a.apiKeywords) : null);
    apiEntities.push(a.apiEntities ? JSON.stringify(a.apiEntities) : null);
    apiSourcePriorities.push(a.apiSourcePriority ?? null);
    apiRelevanceScores.push(a.apiRelevanceScore ?? null);
    apiDomainRanks.push(a.apiDomainRank ?? null);
    apiPerformances.push(a.apiPerformance ?? null);
    apiSocials.push(a.apiSocial ? JSON.stringify(a.apiSocial) : null);
    apiDuplicateFlags.push(a.apiDuplicateFlag ?? null);
  }

  const res = await pool.query<{ id: number }>(
    `INSERT INTO articles (
      external_id, source_api, url, title_hash, normalized_url_hash, domain_title_hash,
      title, description, content, image_url,
      author, source_name, source_domain,
      published_at, main_genre, homepage_eligible,
      llm_tier, llm_category, llm_reason, llm_scored_at, llm_model, filter_status,
      api_category, api_iptc_category, api_sentiment, api_language, api_country,
      api_keywords, api_entities, api_source_priority, api_relevance_score,
      api_domain_rank, api_performance, api_social, api_duplicate_flag
    )
    SELECT
      u.external_id, u.source_api, u.url, u.title_hash, u.normalized_url_hash, u.domain_title_hash,
      u.title, u.description, u.content, u.image_url,
      u.author, u.source_name, u.source_domain,
      u.published_at::timestamptz, u.main_genre, u.homepage_eligible,
      u.llm_tier, u.llm_category, u.llm_reason, NOW(), u.llm_model, u.filter_status,
      u.api_category, u.api_iptc_category, u.api_sentiment, u.api_language, u.api_country,
      CASE WHEN u.api_keywords IS NOT NULL THEN ARRAY(SELECT jsonb_array_elements_text(u.api_keywords::jsonb)) ELSE NULL END, u.api_entities::jsonb, u.api_source_priority, u.api_relevance_score,
      u.api_domain_rank, u.api_performance, u.api_social::jsonb, u.api_duplicate_flag
    FROM UNNEST(
      $1::varchar(255)[], $2::varchar(20)[], $3::text[], $4::varchar(64)[], $5::varchar(64)[], $6::varchar(64)[],
      $7::text[], $8::text[], $9::text[], $10::text[],
      $11::text[], $12::varchar(255)[], $13::varchar(255)[],
      $14::text[], $15::varchar(20)[], $16::boolean[],
      $17::char(1)[], $18::varchar(20)[], $19::text[], $20::varchar(50)[], $21::varchar(15)[],
      $22::varchar(100)[], $23::varchar(100)[], $24::real[], $25::varchar(10)[], $26::varchar(10)[],
      $27::text[], $28::text[], $29::integer[], $30::real[],
      $31::integer[], $32::real[], $33::text[], $34::boolean[]
    ) AS u(
      external_id, source_api, url, title_hash, normalized_url_hash, domain_title_hash,
      title, description, content, image_url,
      author, source_name, source_domain,
      published_at, main_genre, homepage_eligible,
      llm_tier, llm_category, llm_reason, llm_model, filter_status,
      api_category, api_iptc_category, api_sentiment, api_language, api_country,
      api_keywords, api_entities, api_source_priority, api_relevance_score,
      api_domain_rank, api_performance, api_social, api_duplicate_flag
    )
    ON CONFLICT (url) DO NOTHING
    RETURNING id`,
    [
      externalIds, sourceApis, urls, titleHashes, normalizedUrlHashes, domainTitleHashes,
      titles, descriptions, contents, imageUrls,
      authors, sourceNames, sourceDomains,
      publishedAts, mainGenres, homepageEligibles,
      llmTiers, llmCategories, llmReasons, llmModels, filterStatuses,
      apiCategories, apiIptcCategories, apiSentiments, apiLanguages, apiCountries,
      apiKeywords, apiEntities, apiSourcePriorities, apiRelevanceScores,
      apiDomainRanks, apiPerformances, apiSocials, apiDuplicateFlags,
    ],
  );

  return res.rows.map(r => r.id);
}

// ── Ingestion run logging ──

async function logIngestionRun(
  apiName: string,
  fetchResult: { articles: unknown[]; stats: Record<string, unknown> },
): Promise<void> {
  const creditsUsed = (fetchResult.stats as Record<string, unknown>).creditsConsumed
    ?? (fetchResult.stats as Record<string, unknown>).creditsUsed
    ?? (fetchResult.stats as Record<string, unknown>).quotaUsed
    ?? null;
  const creditsRemaining = (fetchResult.stats as Record<string, unknown>).creditsRemaining
    ?? (fetchResult.stats as Record<string, unknown>).quotaRemaining
    ?? (fetchResult.stats as Record<string, unknown>).usageLimitRemaining
    ?? null;

  await pool.query(
    `INSERT INTO ingestion_runs (api_name, articles_fetched, status, started_at, completed_at, credits_used, credits_remaining)
     VALUES ($1, $2, 'success', NOW(), NOW(), $3, $4)`,
    [apiName, fetchResult.articles.length, creditsUsed, creditsRemaining],
  );
}

// ── PHASE 4 helpers ──

async function matchAgainstExistingStories(
  articleIds: number[],
): Promise<{ matchedStoryIds: number[]; unmatchedArticleIds: number[] }> {
  if (articleIds.length === 0) return { matchedStoryIds: [], unmatchedArticleIds: [] };

  // 1. Load active stories with centroid within 14-day window
  const storiesRes = await pool.query<{
    id: number;
    centroid: string | null;
    keyword_set: string[] | null;
  }>(
    `SELECT id, centroid, keyword_set
     FROM stories
     WHERE centroid IS NOT NULL
       AND last_updated_at >= NOW() - INTERVAL '14 days'
       AND status = 'active'`,
  );

  if (storiesRes.rows.length === 0) {
    return { matchedStoryIds: [], unmatchedArticleIds: articleIds };
  }

  const storyIds = storiesRes.rows.map(r => r.id);

  // 2. Load 10 most recent article embeddings per story
  const storyEmbeddingsRes = await pool.query<{
    story_id: number;
    embedding: string | null;
  }>(
    `SELECT story_id, embedding
     FROM articles
     WHERE story_id = ANY($1) AND embedding IS NOT NULL
     ORDER BY story_id, published_at DESC`,
    [storyIds],
  );

  // Group embeddings per story (up to 10 most recent)
  const storyRecentEmbeddings = new Map<number, number[][]>();
  const storyEmbeddingCounts = new Map<number, number>();
  for (const row of storyEmbeddingsRes.rows) {
    const count = storyEmbeddingCounts.get(row.story_id) ?? 0;
    if (count >= 10) continue;
    if (!row.embedding) continue;
    const emb: number[] = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
    let arr = storyRecentEmbeddings.get(row.story_id);
    if (!arr) { arr = []; storyRecentEmbeddings.set(row.story_id, arr); }
    arr.push(emb);
    storyEmbeddingCounts.set(row.story_id, count + 1);
  }

  // Build story map for match scoring
  const storyMap = new Map<number, { keywordSet: string[]; recentEmbeddings: number[][] }>();
  for (const row of storiesRes.rows) {
    const centroid: number[] | null = row.centroid
      ? (typeof row.centroid === 'string' ? JSON.parse(row.centroid) : row.centroid)
      : null;
    const recentEmbs = storyRecentEmbeddings.get(row.id) ?? [];
    // Include centroid as a comparison point if we have fewer than 10 embeddings
    const embeddings = centroid && recentEmbs.length < 10 ? [centroid, ...recentEmbs] : recentEmbs;

    storyMap.set(row.id, {
      keywordSet: row.keyword_set ?? [],
      recentEmbeddings: embeddings,
    });
  }

  // 3. Load incoming articles' embeddings and api_keywords
  const articlesRes = await pool.query<{
    id: number;
    embedding: string | null;
    api_keywords: string[] | null;
  }>(
    `SELECT id, embedding, api_keywords
     FROM articles
     WHERE id = ANY($1) AND embedding IS NOT NULL`,
    [articleIds],
  );

  const matchedStoryIdsSet = new Set<number>();
  const matchedArticleIds = new Set<number>();

  // Also track story article counts and embeddings for centroid updates
  const storyArticleCountRes = await pool.query<{ id: number; article_count: number }>(
    `SELECT id, article_count FROM stories WHERE id = ANY($1)`,
    [storyIds],
  );
  const storyCounts = new Map<number, number>();
  for (const row of storyArticleCountRes.rows) {
    storyCounts.set(row.id, row.article_count);
  }

  // 4. For each article, compute match score against every active story
  for (const article of articlesRes.rows) {
    if (!article.embedding) continue;

    const artEmb: number[] = typeof article.embedding === 'string' ? JSON.parse(article.embedding) : article.embedding;
    const artKeywords: string[] = article.api_keywords ?? [];

    let bestStoryId: number | null = null;
    let bestScore = -Infinity;

    for (const [storyId, story] of storyMap) {
      const score = storyMatchScore(
        { embedding: artEmb, keywords: artKeywords },
        { keywordSet: story.keywordSet, recentEmbeddings: story.recentEmbeddings },
      );
      if (score > bestScore) {
        bestScore = score;
        bestStoryId = storyId;
      }
    }

    if (bestStoryId !== null && bestScore >= SIMILARITY_THRESHOLD_EXISTING) {
      // Assign article to best story
      await pool.query(
        'UPDATE articles SET story_id = $1 WHERE id = $2',
        [bestStoryId, article.id],
      );
      matchedArticleIds.add(article.id);
      matchedStoryIdsSet.add(bestStoryId);

      // Update story centroid via weightedCentroidUpdate
      const oldCentroidRow = await pool.query<{ centroid: string | null }>(
        'SELECT centroid FROM stories WHERE id = $1',
        [bestStoryId],
      );
      const oldCentroid = oldCentroidRow.rows[0]?.centroid
        ? (typeof oldCentroidRow.rows[0].centroid === 'string'
          ? JSON.parse(oldCentroidRow.rows[0].centroid)
          : oldCentroidRow.rows[0].centroid)
        : artEmb;
      const oldCount = storyCounts.get(bestStoryId) ?? 0;
      const newCentroid = weightedCentroidUpdate(oldCentroid, oldCount, [artEmb]);
      await pool.query(
        'UPDATE stories SET centroid = $1, article_count = article_count + 1, last_updated_at = NOW() WHERE id = $2',
        [JSON.stringify(newCentroid), bestStoryId],
      );
      storyCounts.set(bestStoryId, oldCount + 1);

      // Also add this embedding to the story's recent embeddings for subsequent articles
      const storyData = storyMap.get(bestStoryId);
      if (storyData) {
        storyData.recentEmbeddings.push(artEmb);
        if (storyData.recentEmbeddings.length > 10) {
          storyData.recentEmbeddings.shift();
        }
      }
    }
  }

  // Articles without embeddings or that didn't match → unmatched
  const unmatchedArticleIds = articleIds.filter(id => !matchedArticleIds.has(id));

  return {
    matchedStoryIds: [...matchedStoryIdsSet],
    unmatchedArticleIds,
  };
}

async function clusterUnmatchedArticles(
  unmatchedArticleIds: number[],
): Promise<number[]> {
  if (unmatchedArticleIds.length === 0) return [];

  // Load embeddings for unmatched articles
  const articlesRes = await pool.query<{
    id: number;
    embedding: string | null;
  }>(
    `SELECT id, embedding FROM articles WHERE id = ANY($1) AND embedding IS NOT NULL`,
    [unmatchedArticleIds],
  );

  if (articlesRes.rows.length === 0) return [];

  const articleEmbeddings = new Map<number, number[]>();
  for (const row of articlesRes.rows) {
    if (!row.embedding) continue;
    const emb: number[] = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
    articleEmbeddings.set(row.id, emb);
  }

  // Greedy sequential clustering
  const clusters: { centroid: number[]; articleIds: number[] }[] = [];

  for (const [articleId, embedding] of articleEmbeddings) {
    let bestClusterIdx: number | null = null;
    let bestSim = -Infinity;

    for (let ci = 0; ci < clusters.length; ci++) {
      const sim = cosineSimilarity(embedding, clusters[ci].centroid);
      if (sim >= SIMILARITY_THRESHOLD_NEW && sim > bestSim) {
        bestSim = sim;
        bestClusterIdx = ci;
      }
    }

    if (bestClusterIdx !== null) {
      // Merge into existing cluster
      const cluster = clusters[bestClusterIdx];
      cluster.articleIds.push(articleId);
      cluster.centroid = averageVectors(cluster.articleIds.map(id => articleEmbeddings.get(id)!));
    } else {
      // Create new cluster
      clusters.push({ centroid: [...embedding], articleIds: [articleId] });
    }
  }

  // Insert new stories and assign articles
  const newStoryIds: number[] = [];

  for (const cluster of clusters) {
    const storyRes = await pool.query<{ id: number }>(
      `INSERT INTO stories (centroid, status, article_count, first_seen_at, last_updated_at)
       VALUES ($1, 'active', $2, NOW(), NOW())
       RETURNING id`,
      [JSON.stringify(cluster.centroid), cluster.articleIds.length],
    );
    const storyId = storyRes.rows[0].id;
    newStoryIds.push(storyId);

    await pool.query(
      'UPDATE articles SET story_id = $1 WHERE id = ANY($2)',
      [storyId, cluster.articleIds],
    );
  }

  return newStoryIds;
}

async function updateStoryMetadata(storyIds: number[]): Promise<void> {
  if (storyIds.length === 0) return;

  for (const storyId of storyIds) {
    // 1. Update keyword set
    await updateStoryKeywords(storyId);

    // 2. Update source_count, main_genre, llm_category, last_updated_at
    await pool.query(
      `UPDATE stories SET
         source_count = (SELECT COUNT(DISTINCT source_name) FROM articles WHERE story_id = $1),
         main_genre = (SELECT main_genre FROM articles WHERE story_id = $1 AND main_genre IS NOT NULL GROUP BY main_genre ORDER BY COUNT(*) DESC LIMIT 1),
         llm_category = (SELECT llm_category FROM articles WHERE story_id = $1 AND llm_category IS NOT NULL AND filter_status = 'accepted' GROUP BY llm_category ORDER BY COUNT(*) DESC LIMIT 1),
         last_updated_at = NOW()
       WHERE id = $1`,
      [storyId],
    );

    // 3. Update canonical_embedding and representative_article_id
    const repRes = await pool.query<{ id: number; embedding: string | null }>(
      `SELECT id, embedding FROM articles
       WHERE story_id = $1 AND embedding IS NOT NULL
       ORDER BY published_at DESC LIMIT 1`,
      [storyId],
    );
    if (repRes.rows.length > 0) {
      const rep = repRes.rows[0];
      const emb = rep.embedding
        ? (typeof rep.embedding === 'string' ? rep.embedding : JSON.stringify(rep.embedding))
        : null;
      await pool.query(
        'UPDATE stories SET canonical_embedding = $1::jsonb, representative_article_id = $2 WHERE id = $3',
        [emb, rep.id, storyId],
      );
    }
  }
}

// ── Summarize brief articles ──

async function summarizeBriefArticles(selected: ScoredStory[]): Promise<number> {
  let summarized = 0;

  for (const story of selected) {
    const repId = story.representative_article_id;
    if (!repId) continue;

    const artRes = await pool.query<{
      title: string;
      full_text: string | null;
      content: string | null;
      description: string | null;
    }>(
      'SELECT title, full_text, content, description FROM articles WHERE id = $1',
      [repId],
    );
    const art = artRes.rows[0];
    if (!art) continue;

    const text =
      (art.full_text && art.full_text.length >= 50) ? art.full_text
      : (art.content && art.content.length >= 50) ? art.content
      : (art.description && art.description.length >= 50) ? art.description
      : null;
    if (!text) continue;

    try {
      const summary = await generateArticleSummary(art.title, text);
      if (summary) {
        await pool.query('UPDATE articles SET summary = $1 WHERE id = $2', [summary, repId]);
        summarized++;
      }
    } catch (err) {
      console.error(`[PIPELINE] Summary failed for article ${repId}:`, err);
    }
  }

  return summarized;
}

// ══════════════════════════════════════════════════════
// MAIN PIPELINE
// ══════════════════════════════════════════════════════

export interface PipelineOptions {
  /** Test mode: cap raw articles after ingestion to limit API/LLM spend.
   *  Still runs all phases end-to-end, just on a small sample. */
  maxArticles?: number;
}

export async function runPipeline(opts?: PipelineOptions): Promise<PipelineResult> {
  const runId = await logPipelineStart();

  const result: PipelineResult = {
    success: false,
    articlesFetched: 0,
    articlesFiltered: 0,
    articlesDeduplicated: 0,
    articlesClassified: 0,
    articlesStored: 0,
    storiesMatched: 0,
    storiesCreated: 0,
    storiesSummarized: 0,
    briefId: null,
  };

  try {
    // ════════════════════════════════════════════════
    // PHASE 1: INGESTION
    // ════════════════════════════════════════════════

    // Step 1: Fetch from all 4 APIs in parallel
    // Use allSettled so one fetcher crashing (e.g. ConnectTimeoutError) doesn't kill the whole run
    const fetchResults = await Promise.allSettled([
      fetchWorldnews(),
      fetchTheNewsApi(),
      fetchNewsdata(),
      fetchWebzio(),
    ]);

    // Destructure with empty-array fallback for failed fetchers
    const worldNews = fetchResults[0].status === 'fulfilled' ? fetchResults[0].value : { articles: [] as NormalizedArticle[], stats: { querySlotsRun: 0, apiCallsUsed: 0, totalRawArticles: 0, normalizedCount: 0, duplicateUrlsDropped: 0, quotaUsed: 0, quotaRemaining: 50, quotaExhausted: false } };
    const theNewsApi = fetchResults[1].status === 'fulfilled' ? fetchResults[1].value : { articles: [] as NormalizedArticle[], stats: { querySlotsRun: 0, apiCallsUsed: 0, totalRawArticles: 0, normalizedCount: 0, f9RejectedCount: 0, duplicateUrlsDropped: 0, creditsConsumed: 0, creditsRemaining: 0 } };
    const newsData   = fetchResults[2].status === 'fulfilled' ? fetchResults[2].value : { articles: [] as NormalizedArticle[], stats: { querySlotsRun: 0, apiCallsUsed: 0, creditsConsumed: 0, totalRawArticles: 0, normalizedCount: 0, duplicateUrlsDropped: 0, creditsRemaining: 0 } };
    const webzio     = fetchResults[3].status === 'fulfilled' ? fetchResults[3].value : { articles: [] as NormalizedArticle[], stats: { queriesRun: 0, apiCallsUsed: 0, totalRawPosts: 0, normalizedCount: 0, duplicateUrlsDropped: 0 } };

    // Log which fetchers failed
    const fetcherNames = ['worldnews', 'thenewsapi', 'newsdata', 'webzio'] as const;
    for (let i = 0; i < fetchResults.length; i++) {
      const r = fetchResults[i];
      if (r.status === 'rejected') {
        console.error(`[PIPELINE] ⚠ ${fetcherNames[i]} fetch failed: ${r.reason?.message ?? r.reason}`);
      }
    }

    const rawArticles: NormalizedArticle[] = [
      ...worldNews.articles,    // ~500-2000 chars (full article body)
      ...webzio.articles,       // ~200 chars (snippet → description)
      ...theNewsApi.articles,   // ~120 chars (description → content)
      ...newsData.articles,     // 0-200 chars (often null, paywalled)
    ];

    result.articlesFetched = rawArticles.length;
    console.log(`[PIPELINE] Fetched ${rawArticles.length} raw articles (WN:${worldNews.articles.length} TNA:${theNewsApi.articles.length} ND:${newsData.articles.length} WZ:${webzio.articles.length})`);

    // Test mode: cap articles to limit downstream API/LLM spend
    if (opts?.maxArticles && rawArticles.length > opts.maxArticles) {
      console.log(`[PIPELINE] Test mode — capping at ${opts.maxArticles} articles (was ${rawArticles.length})`);
      rawArticles.length = opts.maxArticles;
    }

    // Step 2: Run structural filters F1-F7
    const { passed, rejected } = runStructuralFilters(rawArticles);

    // Step 3: Log structural rejections to rejection_log
    await bulkInsertRejections(rejected, 'filter');

    // Step 4: Dedup F8 (DB-dependent)
    const { unique, duplicates } = await deduplicateArticles(passed);
    await bulkInsertRejections(duplicates, 'filter');

    result.articlesFiltered = rejected.length;
    result.articlesDeduplicated = duplicates.length;
    console.log(`[PIPELINE] ${passed.length} passed filters, ${unique.length} after dedup (${rejected.length + duplicates.length} total rejected)`);

    // Log ingestion runs (one per fetcher)
    await Promise.allSettled([
      logIngestionRun('worldnews', worldNews),
      logIngestionRun('thenewsapi', theNewsApi),
      logIngestionRun('newsdata', newsData),
      logIngestionRun('webzio', webzio),
    ]);

    // ════════════════════════════════════════════════
    // PHASE 2: CLASSIFICATION
    // ════════════════════════════════════════════════

    // Step 5: Classify via Cerebras gpt-oss-120b (batch of CLASSIFICATION_BATCH_SIZE)
    const classified: ScoredArticle[] = [];
    for (let i = 0; i < unique.length; i += CLASSIFICATION_BATCH_SIZE) {
      const batch = unique.slice(i, i + CLASSIFICATION_BATCH_SIZE);
      const batchResult = await classifyArticleBatch(batch);
      classified.push(...batchResult);
    }

    result.articlesClassified = classified.length;
    console.log(`[PIPELINE] Classified ${classified.length} articles`);

    // Step 6: Store Tier A+B articles; log Tier C+D rejections
    const accepted = classified.filter(a => a.filterStatus === 'accepted');
    const llmRejected = classified.filter(a => a.filterStatus === 'rejected');

    const storedIds = await storeAcceptedArticles(accepted);
    result.articlesStored = storedIds.length;

    // Log LLM rejections
    const llmRejections: FilterRejection[] = llmRejected.map(a => ({
      url: a.url,
      title: a.title,
      sourceApi: a.sourceApi,
      sourceDomain: a.sourceDomain,
      rejectionStage: 'llm' as const,
      rejectionRule: `tier_${a.llmTier.toLowerCase()}`,
      llmTier: (a.llmTier === 'C' || a.llmTier === 'D') ? a.llmTier : undefined,
      llmCategory: a.llmCategory,
      llmReason: a.llmReason,
      contextLen: (a.description?.length ?? 0) + (a.content?.length ?? 0),
    }));
    await bulkInsertRejections(llmRejections, 'llm');

    console.log(`[PIPELINE] Stored ${storedIds.length} articles (Tier A+B), rejected ${llmRejected.length} (Tier C+D)`);

    // ════════════════════════════════════════════════
    // PHASE 3: ENRICHMENT
    // ════════════════════════════════════════════════

    // Step 7: Enrich full text
    await enrichArticles(storedIds);
    console.log(`[PIPELINE] Enriched articles (scrape + lookup fallback)`);

    // Step 8: Generate Gemini embeddings
    await batchEmbedArticles(storedIds);
    console.log(`[PIPELINE] Embeddings generated`);

    // ════════════════════════════════════════════════
    // PHASE 4: STORY INTELLIGENCE
    // ════════════════════════════════════════════════

    // Step 9: Match against existing stories
    const { matchedStoryIds, unmatchedArticleIds } = await matchAgainstExistingStories(storedIds);
    result.storiesMatched = matchedStoryIds.length;
    console.log(`[PIPELINE] Matched ${matchedStoryIds.length} articles to existing stories, ${unmatchedArticleIds.length} unmatched`);

    // Step 10: Cluster unmatched into new stories
    const newStoryIds = await clusterUnmatchedArticles(unmatchedArticleIds);
    result.storiesCreated = newStoryIds.length;
    console.log(`[PIPELINE] Created ${newStoryIds.length} new story clusters`);

    // Step 11: Dedup today's articles within stories
    const { totalEvicted } = await dedupTodaysArticles(storedIds);
    console.log(`[PIPELINE] Intra-story dedup evicted ${totalEvicted} articles`);

    // Step 12: Update story metadata
    const allAffectedStoryIds = [...matchedStoryIds, ...newStoryIds];
    await updateStoryMetadata(allAffectedStoryIds);
    console.log(`[PIPELINE] Updated metadata for ${allAffectedStoryIds.length} stories`);

    // Step 13: Score all active stories
    await scoreAllActiveStories();
    console.log(`[PIPELINE] Scored all active stories`);

    // ════════════════════════════════════════════════
    // PHASE 5: BRIEF ASSEMBLY
    // ════════════════════════════════════════════════

    // Step 14: Select stories for brief
    const allScoredRes = await pool.query<ScoredStory>(
      `SELECT id, title, main_genre, llm_category, importance_score, article_count, source_count, representative_article_id
       FROM stories
       WHERE status = 'active' AND importance_score IS NOT NULL
       ORDER BY importance_score DESC`,
    );
    const selected = selectBriefStories(allScoredRes.rows);

    // Step 15: Summarize today's brief articles
    const summarizedCount = await summarizeBriefArticles(selected);
    result.storiesSummarized = summarizedCount;
    console.log(`[PIPELINE] Summarized ${summarizedCount} brief articles`);

    // Step 16: Persist brief
    const today = new Date().toISOString().split('T')[0];
    const briefStoryIds = selected.map(s => s.id);
    const briefArtIds = selected.map(s => s.representative_article_id).filter((id): id is number => id !== null);

    const briefRes = await pool.query<{ id: number }>(
      `INSERT INTO briefs (brief_date, story_ids, article_ids, user_id)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (brief_date) WHERE user_id IS NULL
       DO UPDATE SET story_ids = EXCLUDED.story_ids, article_ids = EXCLUDED.article_ids
       RETURNING id`,
      [today, briefStoryIds, briefArtIds],
    );
    result.briefId = briefRes.rows[0]?.id ?? null;

    // ════════════════════════════════════════════════
    // POST-PIPELINE
    // ════════════════════════════════════════════════

    // Step 17: Log pipeline success
    result.success = true;
    await logPipelineSuccess(runId, result);
    console.log(`[PIPELINE] Pipeline completed successfully`);

    // Step 18: Aggregate daily metrics
    await aggregateDailyMetrics();

    return result;
  } catch (err) {
    await logPipelineFailure(runId, err);
    console.error(`[PIPELINE] Pipeline failed:`, err);
    throw err;
  }
}
