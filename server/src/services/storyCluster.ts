import { cosineSimilarity } from './vectorUtils.js';

export interface Story {
  id: number;
  title: string | null;
  summary: string | null;
  centroid: number[];
  articleCount: number;
}

export interface ArticleWithEmbedding {
  id: number;
  title: string;
  url: string;
  body: string;
  publishedAt: Date;
  sourceId: number;
  embedding: number[];
}

export const SIMILARITY_THRESHOLD = 0.75; // Must match briefs.ts clustering threshold and stories.ts timeline threshold

/**
 * Returns the best matching story AND its score.
 * Callers can log merge decisions with scores for diagnostics.
 */
export function findSimilarStoryWithScore(
  embedding: number[],
  stories: Story[]
): { story: Story; score: number } | null {
  let best: Story | null = null;
  let bestScore = -Infinity;

  for (const story of stories) {
    const score = cosineSimilarity(embedding, story.centroid);
    if (score > bestScore) {
      bestScore = score;
      best = story;
    }
  }

  if (best && bestScore >= SIMILARITY_THRESHOLD) {
    return { story: best, score: bestScore };
  }
  return null;
}

/**
 * Convenience wrapper that returns only the matched story (no score).
 */
export function findSimilarStory(
  embedding: number[],
  stories: Story[]
): Story | null {
  const result = findSimilarStoryWithScore(embedding, stories);
  return result ? result.story : null;
}

/**
 * Computes a weighted centroid after merging new articles into an existing story.
 * new_centroid = (old_centroid × old_count + sum(new_embeddings)) / (old_count + new_count)
 *
 * More stable than recomputing from scratch; doesn't require loading all
 * historical embeddings.
 */
export function weightedCentroidUpdate(
  oldCentroid: number[],
  oldCount: number,
  newEmbeddings: number[][]
): number[] {
  if (newEmbeddings.length === 0) return oldCentroid;

  const dim = oldCentroid.length;
  const newCount = newEmbeddings.length;
  const totalCount = oldCount + newCount;

  const result = new Array<number>(dim).fill(0);

  // Add weighted old centroid
  for (let i = 0; i < dim; i++) {
    result[i] += oldCentroid[i] * oldCount;
  }

  // Add sum of new embeddings
  for (const emb of newEmbeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += emb[i];
    }
  }

  // Divide by total count
  for (let i = 0; i < dim; i++) {
    result[i] /= totalCount;
  }

  return result;
}

export function clusterArticles(
  articles: ArticleWithEmbedding[],
  existingStories: Story[]
): { stories: Map<number, number[]>; newArticles: ArticleWithEmbedding[] } {
  const storyToArticles = new Map<number, number[]>();
  const newArticlesList: ArticleWithEmbedding[] = [];

  for (const article of articles) {
    const matched = findSimilarStory(article.embedding, existingStories);
    if (matched) {
      const existing = storyToArticles.get(matched.id) || [];
      existing.push(article.id);
      storyToArticles.set(matched.id, existing);
    } else {
      newArticlesList.push(article);
    }
  }

  return { stories: storyToArticles, newArticles: newArticlesList };
}
