import { pool } from '../../db/index.js';
import { cosineSimilarity } from '../vectorUtils.js';
import { weightedCentroidUpdate } from './storyCluster.js';
import { representativeScore } from './storyScoring.js';

export async function updateStoryKeywords(storyId: number): Promise<string[]> {
  const result = await pool.query<{
    api_keywords: string[] | null;
    importance_score: number | null;
  }>(
    'SELECT api_keywords, importance_score FROM articles WHERE story_id = $1 ORDER BY importance_score DESC NULLS LAST',
    [storyId]
  );
  const articles = result.rows;

  if (articles.length === 0) return [];

  let keywords: string[];

  if (articles.length <= 2) {
    // 1-2 articles: use representative article's keywords (avoids cold start)
    const rep = articles.sort((a, b) =>
      (b.importance_score ?? 0) - (a.importance_score ?? 0)
    )[0];
    keywords = (rep.api_keywords ?? []).slice(0, 20);
  } else if (articles.length <= 5) {
    // 3-5 articles: union of all keywords, cap 20
    const allKw = articles.flatMap(a => a.api_keywords ?? []);
    keywords = [...new Set(allKw)].slice(0, 20);
  } else {
    // 6+ articles: keywords appearing in 2+ articles, cap 20
    const freq = new Map<string, number>();
    for (const a of articles) {
      for (const kw of (a.api_keywords ?? [])) {
        freq.set(kw, (freq.get(kw) ?? 0) + 1);
      }
    }
    keywords = [...freq.entries()]
      .filter(([_, count]) => count >= 2)
      .sort(([_, a], [__, b]) => b - a)
      .slice(0, 20)
      .map(([kw]) => kw);
  }

  await pool.query(
    'UPDATE stories SET keyword_set = $1 WHERE id = $2',
    [keywords, storyId]
  );

  return keywords;
}
