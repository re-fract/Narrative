import type { BriefCandidate } from '../../types/index.js';

// ── Scoring constants ──
const GENRE_PRIORITY: Record<string, number> = {
  economics: 1.0,
  policy: 1.0,
  accountability: 0.8,
  science: 0.8,
  business: 0.6,
  none: 0.2,
};

const TIER_BONUS: Record<string, number> = {
  A: 0.15,
  B: 0.0,
};

/**
 * Scores an individual article as a brief candidate.
 *
 * Components:
 *   - Source quality (source priority, log-scaled)
 *   - Genre priority (importance of topic category)
 *   - Content depth (description length + scrape status)
 *   - Story boost (story importance score if article belongs to a story)
 *   - Tier bonus (Tier A articles get a modest lift)
 */
function scoreCandidate(article: BriefCandidate): number {
  // Source quality: lower api_source_priority = better (log-scaled 0–1)
  const priority = article.api_source_priority ?? 1;
  const sourceQuality = priority <= 1 ? 1.0
    : Math.max(0, 1 - Math.log10(priority) / Math.log10(15000));

  // Genre priority
  const genreScore = GENRE_PRIORITY[article.llm_category ?? 'none'] ?? 0.5;

  // Content depth: description richness + full text available
  const descLen = article.description?.length ?? 0;
  const descScore = Math.min(descLen / 400, 1.0);
  const depthBonus = article.scrape_status === 'full' ? 0.2 : 0;
  const contentScore = Math.min(descScore + depthBonus, 1.0);

  // Story boost: if this article is part of a known story, use its importance
  // as a signal that the topic has been corroborated across multiple sources.
  const storyBoost = article.story_importance ?? 0;

  // Tier bonus
  const tierBonus = TIER_BONUS[article.llm_tier ?? 'B'] ?? 0;

  return (
    0.30 * sourceQuality +
    0.20 * genreScore +
    0.15 * contentScore +
    0.25 * storyBoost +
    tierBonus          // flat additive bonus, not weighted (max 0.15)
  );
}

export interface BriefSelection {
  articleId: number;
  score: number;
}

/**
 * Selects today's best articles for the daily brief.
 *
 * The brief is article-centric: we rank today's accepted articles by quality
 * and pick the top N. Stories provide a corroboration boost but are not the
 * selection unit. Only one article per story is ever shown on the homepage,
 * preventing redundant coverage of the same topic.
 */
export function selectBriefArticles(
  candidates: BriefCandidate[],
  options: { totalSlots?: number; maxPerCategory?: number; maxPerRegion?: number } = {},
): BriefSelection[] {
  const totalSlots = options.totalSlots ?? 14;
  const maxPerCategory = options.maxPerCategory ?? 4;
  const maxPerRegion = options.maxPerRegion ?? 8;

  // Score and sort all candidates
  const scored = candidates
    .map(a => ({ article: a, score: scoreCandidate(a) }))
    .sort((a, b) => b.score - a.score);

  const selected: BriefSelection[] = [];
  const seenStoryIds = new Set<number>();   // max 1 per story
  const catCounts = new Map<string, number>();
  const regionCounts = new Map<string, number>();

  // Pass 1: apply caps
  for (const { article, score } of scored) {
    if (selected.length >= totalSlots) break;

    // Enforce 1 article per story (prevents 3 articles about the same topic)
    if (article.story_id !== null && seenStoryIds.has(article.story_id)) continue;

    const cat = article.llm_category ?? 'none';
    const region = article.main_genre ?? 'global';
    if ((catCounts.get(cat) ?? 0) >= maxPerCategory) continue;
    if ((regionCounts.get(region) ?? 0) >= maxPerRegion) continue;

    selected.push({ articleId: article.id, score });
    if (article.story_id !== null) seenStoryIds.add(article.story_id);
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
    regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
  }

  // Pass 2: wildcard fill if we're short (ignores category/region caps but still
  // enforces the 1-per-story constraint)
  if (selected.length < totalSlots) {
    const selectedIds = new Set(selected.map(s => s.articleId));
    for (const { article, score } of scored) {
      if (selected.length >= totalSlots) break;
      if (selectedIds.has(article.id)) continue;
      if (article.story_id !== null && seenStoryIds.has(article.story_id)) continue;
      selected.push({ articleId: article.id, score });
      if (article.story_id !== null) seenStoryIds.add(article.story_id);
    }
  }

  return selected;
}
