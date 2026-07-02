import { pool } from '../../db/index.js';

// Genre priority from LLM categories (replaces genreMapping.ts — §7)
const GENRE_PRIORITY_SCORE: Record<string, number> = {
  economics: 1.0,
  policy: 1.0,
  science: 0.8,
  accountability: 0.8,
  business: 0.6,
  none: 0.2,
};

export interface StoryForScoring {
  sourceCount: number;
  llmCategory: string;
  mainGenre: string;
  lastUpdated: Date;
  articles: Array<{
    api_source_priority: number;
    publishedAt: Date;
    description: string | null;
    full_text: string | null;
    scrape_status: string;
    source_domain: string;
  }>;
}

export function scoreStory(story: StoryForScoring): number {
  // Coverage: distinct sources covering this story
  const coverageScore = story.sourceCount <= 1 ? 0.2 :
                        story.sourceCount === 2 ? 0.55 :
                        story.sourceCount === 3 ? 0.8 : 1.0;

  // Source quality: log-scale from source_priority (lower = better)
  const priorities = story.articles.map(a => a.api_source_priority).filter(p => p > 0);
  const bestPriority = priorities.length > 0 ? Math.min(...priorities) : 1;
  const sourceQualityScore = bestPriority <= 1 ? 1.0 :
    1 - Math.log10(bestPriority) / Math.log10(15000);

  // Corroboration bonus: distinct domains, not just article count (§8.4)
  const distinctDomains = new Set(story.articles.map(a => a.source_domain)).size;
  const corroborationBonus = distinctDomains >= 3 ? 1.15    // +15% if 3+ distinct sources
                             : distinctDomains >= 2 ? 1.05  // +5% if 2 distinct sources
                             : 1.0;                         // no bonus for single-source
  const adjustedSourceQualityScore = sourceQualityScore * corroborationBonus;

  // Momentum: articles added in last 6 hours
  const recentCount = story.articles.filter(a =>
    (Date.now() - a.publishedAt.getTime()) < 6 * 3600000
  ).length;
  const momentumScore = Math.min(recentCount / 4, 1.0);

  // Freshness: hours since last update
  const hoursSinceUpdate = (Date.now() - story.lastUpdated.getTime()) / 3600000;
  const freshnessScore = Math.max(0, 1 - hoursSinceUpdate / 24);

  // Genre priority
  const genrePriorityScore = GENRE_PRIORITY_SCORE[story.llmCategory] ?? 0.5;

  // Impact: BOTH india and global = 1.0 (neutral, no preference)
  const impactScore = 1.0;

  // Content quality: description richness + scrape rate + description length
  const avgDescLen = story.articles.reduce((sum, a) => sum + (a.description?.length ?? 0), 0) / story.articles.length;
  const descRichness = Math.min(avgDescLen / 400, 1.0);
  const scrapeRate = story.articles.filter(a => a.scrape_status === 'full').length / story.articles.length;
  const contentQualityScore = (descRichness * 0.5) + (scrapeRate * 0.3) + (avgDescLen > 100 ? 0.2 : 0);

  return (
    0.24 * coverageScore +
    0.18 * adjustedSourceQualityScore +
    0.10 * momentumScore +
    0.08 * freshnessScore +
    0.08 * genrePriorityScore +
    0.15 * impactScore +
    0.17 * contentQualityScore
  );
}

export function representativeScore(article: {
  api_source_priority: number;
  publishedAt: Date;
  full_text: string | null;
}): number {
  const sourceScore = article.api_source_priority <= 0 ? 1.0 :
    1 - Math.log10(article.api_source_priority) / Math.log10(15000);

  const ageHours = (Date.now() - article.publishedAt.getTime()) / 3600000;
  const freshnessScore = ageHours < 2 ? 0.5 :
                         ageHours < 8 ? 1.0 :
                         ageHours < 16 ? 0.8 : 0.5;

  const depthScore = Math.min((article.full_text?.length ?? 0), 3000) / 3000;

  return (sourceScore * 0.5) + (freshnessScore * 0.3) + (depthScore * 0.2);
}

export async function scoreAllActiveStories(): Promise<void> {
  // Fetch all active stories with their articles
  const storyResult = await pool.query(
    `SELECT s.id, s.llm_category, s.main_genre, s.last_updated_at, s.source_count
     FROM stories s
     WHERE s.status = 'active'`
  );

  for (const storyRow of storyResult.rows) {
    const articleResult = await pool.query(
      `SELECT a.id, a.api_source_priority, a.published_at, a.description, a.full_text, a.scrape_status, a.source_domain
       FROM articles a
       WHERE a.story_id = $1`,
      [storyRow.id]
    );

    const articles = articleResult.rows.map((row: any) => ({
      api_source_priority: row.api_source_priority ?? 1,
      publishedAt: new Date(row.published_at),
      description: row.description ?? null,
      full_text: row.full_text ?? null,
      scrape_status: row.scrape_status ?? 'partial',
      source_domain: row.source_domain ?? '',
    }));

    const story: StoryForScoring = {
      sourceCount: storyRow.source_count ?? 0,
      llmCategory: storyRow.llm_category ?? 'none',
      mainGenre: storyRow.main_genre ?? 'global',
      lastUpdated: new Date(storyRow.last_updated_at),
      articles,
    };

    const score = scoreStory(story);

    // Find representative article
    let bestRepId: number | null = null;
    let bestRepScore = -Infinity;

    for (let i = 0; i < articleResult.rows.length; i++) {
      const row = articleResult.rows[i];
      const repScore = representativeScore({
        api_source_priority: row.api_source_priority ?? 1,
        publishedAt: new Date(row.published_at),
        full_text: row.full_text ?? null,
      });
      if (repScore > bestRepScore) {
        bestRepScore = repScore;
        bestRepId = row.id;
      }
    }

    await pool.query(
      `UPDATE stories SET importance_score = $1, representative_article_id = $2 WHERE id = $3`,
      [score, bestRepId, storyRow.id]
    );
  }
}
