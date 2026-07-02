import { pool } from '../../db/index.js';
import { averageVectors } from '../vectorUtils.js';

export async function dedupTodaysArticles(
  todaysArticleIds: number[],
): Promise<{ totalEvicted: number }> {
  if (todaysArticleIds.length === 0) return { totalEvicted: 0 };

  // 1. Find which stories received new articles today
  const storyResult = await pool.query<{
    story_id: number;
    id: number;
    source_name: string;
    importance_score: number | null;
    normalized_url_hash: string | null;
  }>(
    `SELECT story_id, id, source_name, importance_score, normalized_url_hash
     FROM articles
     WHERE id = ANY($1) AND story_id IS NOT NULL`,
    [todaysArticleIds],
  );

  // 2. Group by story_id, then by source_name
  const storySourceMap = new Map<number, Map<string, number[]>>();
  // Also group by story_id → normalized_url_hash → article IDs
  const storyUrlHashMap = new Map<number, Map<string, number[]>>();
  // Track importance scores per article for both passes
  const articleScores = new Map<number, number>();

  for (const row of storyResult.rows) {
    if (!row.story_id) continue;
    articleScores.set(row.id, row.importance_score ?? 0);

    // Source name grouping
    let sourceMap = storySourceMap.get(row.story_id);
    if (!sourceMap) {
      sourceMap = new Map();
      storySourceMap.set(row.story_id, sourceMap);
    }
    let ids = sourceMap.get(row.source_name);
    if (!ids) {
      ids = [];
      sourceMap.set(row.source_name, ids);
    }
    ids.push(row.id);

    // URL hash grouping
    if (row.normalized_url_hash) {
      let hashMap = storyUrlHashMap.get(row.story_id);
      if (!hashMap) {
        hashMap = new Map();
        storyUrlHashMap.set(row.story_id, hashMap);
      }
      let hashIds = hashMap.get(row.normalized_url_hash);
      if (!hashIds) {
        hashIds = [];
        hashMap.set(row.normalized_url_hash, hashIds);
      }
      hashIds.push(row.id);
    }
  }

  // 3. Pass 1: per-source_name dedup — keep highest importance, evict rest
  let sourceNameEvicted = 0;
  const storiesToRecompute = new Set<number>();

  for (const [storyId, sourceMap] of storySourceMap.entries()) {
    for (const [sourceName, articleIds] of sourceMap.entries()) {
      if (articleIds.length <= 1) continue;

      // Sort by importance_score DESC, keep the best
      const sorted = articleIds
        .map((id) => ({ id, score: articleScores.get(id) ?? 0 }))
        .sort((a, b) => b.score - a.score);
      const evictIds = sorted.slice(1).map((r) => r.id);

      if (evictIds.length > 0) {
        await pool.query(
          'UPDATE articles SET story_id = NULL WHERE id = ANY($1)',
          [evictIds],
        );
        console.log(
          `[DEDUP] Story ${storyId}: evicted ${evictIds.length} articles from ${sourceName}`,
        );
        sourceNameEvicted += evictIds.length;
        storiesToRecompute.add(storyId);
      }
    }
  }

  // 4. Pass 2: per-normalized_url_hash dedup within each story
  let urlHashEvicted = 0;

  for (const [storyId, hashMap] of storyUrlHashMap.entries()) {
    for (const [urlHash, articleIds] of hashMap.entries()) {
      if (articleIds.length <= 1) continue;

      // Sort by importance_score DESC, keep the best
      const sorted = articleIds
        .map((id) => ({ id, score: articleScores.get(id) ?? 0 }))
        .sort((a, b) => b.score - a.score);
      const evictIds = sorted.slice(1).map((r) => r.id);

      if (evictIds.length > 0) {
        await pool.query(
          'UPDATE articles SET story_id = NULL WHERE id = ANY($1)',
          [evictIds],
        );
        console.log(
          `[DEDUP] Story ${storyId}: evicted ${evictIds.length} articles with same URL hash ${urlHash.substring(0, 8)}...`,
        );
        urlHashEvicted += evictIds.length;
        storiesToRecompute.add(storyId);
      }
    }
  }

  // 5. Recompute centroid for affected stories
  for (const storyId of storiesToRecompute) {
    const remaining = await pool.query<{ embedding: string | null }>(
      'SELECT embedding FROM articles WHERE story_id = $1 AND embedding IS NOT NULL ORDER BY published_at DESC',
      [storyId],
    );
    if (remaining.rows.length > 0) {
      const embeddings = remaining.rows.map((r) => {
        const emb = r.embedding;
        return typeof emb === 'string' ? JSON.parse(emb) : emb;
      }) as number[][];
      const newCentroid = averageVectors(embeddings);
      await pool.query(
        'UPDATE stories SET centroid = $1, article_count = $2, last_updated_at = NOW() WHERE id = $3',
        [JSON.stringify(newCentroid), remaining.rows.length, storyId],
      );
    }
  }

  const totalEvicted = sourceNameEvicted + urlHashEvicted;
  console.log(
    `[DEDUP] Source-name evicted: ${sourceNameEvicted}, URL-hash evicted: ${urlHashEvicted}, total: ${totalEvicted}`,
  );
  return { totalEvicted };
}
