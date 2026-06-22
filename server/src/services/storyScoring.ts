import { genrePriorityScore, type MainGenre, type SubGenre } from './classifier.js';
import { titleQualityScore } from './titleNormalizer.js';

export interface StoryArticleForScoring {
  id: number;
  title: string;
  body?: string | null;
  published_at: Date | string | null;
  source_id: number;
  source_priority: number | null;
  main_genre: MainGenre | null;
  sub_genre: SubGenre | null;
  importance_score: number | string | null;
  is_low_signal?: boolean | null;
}

export interface StoryScoreResult {
  mainGenre: MainGenre;
  subGenre: SubGenre;
  sourceCount: number;
  representativeArticleId: number;
  importanceScore: number;
  components: {
    coverage: number;
    sourceQuality: number;
    momentum: number;
    freshness: number;
    genrePriority: number;
    lowSignalPenalty: number;
  };
  representativeRanks: Map<number, number>;
}

function asDate(value: Date | string | null): Date {
  return value ? new Date(value) : new Date(0);
}

function coverageScore(sourceCount: number): number {
  if (sourceCount <= 1) return 0.35;
  if (sourceCount === 2) return 0.65;
  if (sourceCount === 3) return 0.85;
  return 1;
}

function weightedVote<T extends string>(
  articles: StoryArticleForScoring[],
  key: 'main_genre' | 'sub_genre',
  fallback: T,
): T {
  const scores = new Map<T, number>();
  for (const article of articles) {
    const value = article[key] as T | null;
    if (!value) continue;
    const articleScore = Number(article.importance_score ?? 0);
    const weight = Math.max(0.4, Number(article.source_priority ?? 1)) + Math.max(0, articleScore) / 4;
    scores.set(value, (scores.get(value) ?? 0) + weight);
  }
  let best = fallback;
  let bestScore = -Infinity;
  for (const [value, score] of scores.entries()) {
    if (score > bestScore) {
      best = value;
      bestScore = score;
    }
  }
  return best;
}

function chooseRepresentative(articles: StoryArticleForScoring[]): { id: number; ranks: Map<number, number> } {
  const ranks = new Map<number, number>();
  for (const article of articles) {
    const rank =
      Number(article.source_priority ?? 1) * 4 +
      Number(article.importance_score ?? 0) * 1.5 +
      asDate(article.published_at).getTime() / 8.64e13 +
      titleQualityScore(article.title);
    ranks.set(article.id, Number(rank.toFixed(4)));
  }
  const sorted = [...articles].sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0));
  return { id: sorted[0].id, ranks };
}

export function scoreStory(articles: StoryArticleForScoring[], now = new Date()): StoryScoreResult | null {
  if (articles.length === 0) return null;

  const sourceIds = new Set(articles.map(a => a.source_id));
  const sourceCount = sourceIds.size;
  const representative = chooseRepresentative(articles);
  const representativeArticle = articles.find(a => a.id === representative.id) ?? articles[0];

  const mainGenre = weightedVote<MainGenre>(articles, 'main_genre', representativeArticle.main_genre ?? 'global');
  const subGenre = weightedVote<SubGenre>(articles, 'sub_genre', representativeArticle.sub_genre ?? 'others');

  const topPriorities = [...new Map(articles.map(a => [a.source_id, Number(a.source_priority ?? 1)])).values()]
    .sort((a, b) => b - a)
    .slice(0, 3);
  const sourceQuality = topPriorities.reduce((sum, p) => sum + Math.max(0, Math.min(3, p)), 0) / 9;

  const sixHoursAgo = now.getTime() - 6 * 36e5;
  const recent = articles.filter(a => asDate(a.published_at).getTime() >= sixHoursAgo);
  const recentSources = new Set(recent.map(a => a.source_id)).size;
  const momentum = Math.min(1, recent.length / 4 * 0.55 + recentSources / 3 * 0.45);

  const newest = Math.max(...articles.map(a => asDate(a.published_at).getTime()));
  const hoursOld = Math.max(0, (now.getTime() - newest) / 36e5);
  const freshness = Math.max(0, Math.min(1, 1 - hoursOld / 24));
  const lowSignalPenalty = articles.some(a => a.is_low_signal) ? 0.7 : 0;
  const genrePriority = genrePriorityScore(subGenre);
  const coverage = coverageScore(sourceCount);

  const importanceScore =
    0.35 * coverage +
    0.25 * sourceQuality +
    0.15 * momentum +
    0.10 * freshness +
    0.10 * genrePriority -
    0.15 * lowSignalPenalty;

  return {
    mainGenre,
    subGenre,
    sourceCount,
    representativeArticleId: representative.id,
    importanceScore: Number(importanceScore.toFixed(4)),
    components: {
      coverage: Number(coverage.toFixed(4)),
      sourceQuality: Number(sourceQuality.toFixed(4)),
      momentum: Number(momentum.toFixed(4)),
      freshness: Number(freshness.toFixed(4)),
      genrePriority: Number(genrePriority.toFixed(4)),
      lowSignalPenalty: Number(lowSignalPenalty.toFixed(4)),
    },
    representativeRanks: representative.ranks,
  };
}

export function selectBalancedStories<T extends { id: number; main_genre: string | null; sub_genre: string | null; importance_score: number | string | null }>(
  stories: T[],
  limit = 14,
  minScore = 0.2,
): T[] {
  const ranked = [...stories].sort((a, b) => Number(b.importance_score ?? 0) - Number(a.importance_score ?? 0));
  const selected: T[] = [];
  const regionCounts = new Map<string, number>();
  const subGenreCounts = new Map<string, number>();

  const trySelect = (subGenreCap: number, enforceRegion: boolean, threshold: number) => {
    for (const story of ranked) {
      if (selected.length >= limit) break;
      if (selected.some(s => s.id === story.id)) continue;
      const score = Number(story.importance_score ?? 0);
      if (score < threshold) continue;
      const region = story.main_genre ?? 'global';
      const subGenre = story.sub_genre ?? 'others';
      if ((subGenreCounts.get(subGenre) ?? 0) >= subGenreCap) continue;
      if (enforceRegion) {
        const regionCount = regionCounts.get(region) ?? 0;
        if (regionCount >= 6 && selected.length < 12) continue;
      }
      selected.push(story);
      regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
      subGenreCounts.set(subGenre, (subGenreCounts.get(subGenre) ?? 0) + 1);
    }
  };

  trySelect(3, true, minScore);
  if (selected.length < limit) trySelect(4, false, minScore);
  if (selected.length < limit) trySelect(99, false, -Infinity);

  return selected.slice(0, limit);
}
