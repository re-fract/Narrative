import { cosineSimilarity } from '../vectorUtils.js';
import { SIMILARITY_THRESHOLD_EXISTING, SIMILARITY_THRESHOLD_NEW } from '../../config/constants.js';

// Re-export thresholds so pipeline.ts can still import them from here until step 22 rewrite
export { SIMILARITY_THRESHOLD_EXISTING, SIMILARITY_THRESHOLD_NEW } from '../../config/constants.js';

// ── Inline types for storyMatchScore parameter shapes ──

// ── Core similarity functions (used by pipeline.ts and storyKeywords.ts) ──

export function maxArticleSimilarity(
  articleEmbedding: number[],
  storyArticleEmbeddings: number[][]
): number {
  const embeddingsToCompare = storyArticleEmbeddings.slice(-10); // up to 10 most recent
  let maxSim = -Infinity;
  for (const emb of embeddingsToCompare) {
    const sim = cosineSimilarity(articleEmbedding, emb);
    if (sim > maxSim) {
      maxSim = sim;
    }
  }
  return maxSim === -Infinity ? 0 : maxSim;
}

export function storyMatchScore(
  article: { embedding: number[]; keywords: string[] },
  story: { keywordSet: string[]; recentEmbeddings: number[][] }
): number {
  const embSim = maxArticleSimilarity(article.embedding, story.recentEmbeddings);

  // When keywords are absent on either side, use pure embedding similarity.
  // Without this guard, the 35% keyword component evaluates to 0, making the
  // effective embedding threshold 0.72 / 0.65 ≈ 1.108 — mathematically
  // impossible, so no articles would ever match existing stories.
  if (article.keywords.length === 0 || story.keywordSet.length === 0) {
    return embSim;
  }

  const topKeywords = article.keywords.slice(0, 8);
  const overlap = topKeywords.filter(kw => story.keywordSet.includes(kw)).length;
  const keywordScore = Math.min(overlap / 4, 1.0);

  return (embSim * 0.65) + (keywordScore * 0.35);
}

/**
 * Computes a weighted centroid after merging new articles into an existing story.
 * new_centroid = (old_centroid × old_count + sum(new_embeddings)) / (old_count + new_count)
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

  for (let i = 0; i < dim; i++) {
    result[i] += oldCentroid[i] * oldCount;
  }

  for (const emb of newEmbeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += emb[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    result[i] /= totalCount;
  }

  return result;
}
