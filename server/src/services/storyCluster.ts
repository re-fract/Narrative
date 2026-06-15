import { cosineSimilarity, averageVectors } from './vectorUtils.js';

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

const SIMILARITY_THRESHOLD = 0.82;

export function findSimilarStory(
  embedding: number[],
  stories: Story[]
): Story | null {
  let best: Story | null = null;
  let bestScore = -Infinity;

  for (const story of stories) {
    const score = cosineSimilarity(embedding, story.centroid);
    if (score > bestScore) {
      bestScore = score;
      best = story;
    }
  }

  if (best && bestScore > SIMILARITY_THRESHOLD) {
    return best;
  }
  return null;
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
