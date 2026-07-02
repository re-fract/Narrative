/**
 * deduplicator.ts — F8 6-layer dedup system
 *
 * Layer 5: NewsData duplicate flag (incoming articles)
 * Layer 6: Batch-internal URL cross-check
 * Layer 1-3: Exact-match DB checks (cross-day, last 7 days)
 * Layer 4: In-memory trigram fuzzy same-batch
 */

import type { NormalizedArticle, FilterRejection } from '../../types/index.js';
import { pool } from '../../db/index.js';
import { DEDUP_SIMILARITY_THRESHOLD } from '../../config/constants.js';

// ── In-memory trigram similarity (Jaccard on character trigrams) ──

function trigrams(s: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < s.length - 2; i++) result.push(s.slice(i, i + 3));
  return result;
}

function trigramSim(a: string, b: string): number {
  const triA = new Set(trigrams(a.toLowerCase()));
  const triB = new Set(trigrams(b.toLowerCase()));
  let intersection = 0;
  for (const t of triA) {
    if (triB.has(t)) intersection++;
  }
  return intersection / (triA.size + triB.size - intersection);
}

// ── Main entry point ──

export async function deduplicateArticles(
  articles: NormalizedArticle[],
): Promise<{ unique: NormalizedArticle[]; duplicates: FilterRejection[] }> {
  if (articles.length === 0) return { unique: [], duplicates: [] };

  const isDup = new Set<number>(); // indices marked as duplicates
  const duplicates: FilterRejection[] = [];

  // ── Layer 5: NewsData duplicate flag ──
  for (let i = 0; i < articles.length; i++) {
    if (articles[i].apiDuplicateFlag === true) {
      isDup.add(i);
      duplicates.push({
        url: articles[i].url,
        title: articles[i].title,
        sourceApi: articles[i].sourceApi,
        sourceDomain: articles[i].sourceDomain,
        rejectionStage: 'filter',
        rejectionRule: 'dedup_newsdata_flag',
        contextLen: (articles[i].description?.length ?? 0) + (articles[i].content?.length ?? 0),
      });
    }
  }

  // ── Layer 6: Batch-internal URL cross-check ──
  const seenUrlHashes = new Map<string, number>(); // hash → first index
  for (let i = 0; i < articles.length; i++) {
    if (isDup.has(i)) continue;
    const hash = articles[i].normalizedUrlHash;
    const firstIdx = seenUrlHashes.get(hash);
    if (firstIdx !== undefined) {
      isDup.add(i);
      duplicates.push({
        url: articles[i].url,
        title: articles[i].title,
        sourceApi: articles[i].sourceApi,
        sourceDomain: articles[i].sourceDomain,
        rejectionStage: 'filter',
        rejectionRule: 'dedup_batch_url',
        contextLen: (articles[i].description?.length ?? 0) + (articles[i].content?.length ?? 0),
      });
    } else {
      seenUrlHashes.set(hash, i);
    }
  }

  // ── Layer 1-3: Exact-match DB checks (cross-day, last 7 days) ──
  const surviving = articles
    .map((a, i) => ({ article: a, index: i }))
    .filter(({ index }) => !isDup.has(index));

  if (surviving.length > 0) {
    const titleHashes = surviving.map(({ article }) => article.titleHash);
    const normalizedUrlHashes = surviving.map(({ article }) => article.normalizedUrlHash);
    const domainTitleHashes = surviving.map(({ article }) => article.domainTitleHash);

    const dbResult = await pool.query<{
      normalized_url_hash: string | null;
      domain_title_hash: string | null;
      title_hash: string;
    }>(
      `SELECT id, normalized_url_hash, domain_title_hash, title_hash
       FROM articles
       WHERE published_at > NOW() - INTERVAL '7 days'
         AND (
           normalized_url_hash = ANY($1)
           OR domain_title_hash = ANY($2)
           OR title_hash = ANY($3)
         )`,
      [normalizedUrlHashes, domainTitleHashes, titleHashes],
    );

    // Build sets of matching hashes
    const matchedUrlHashes = new Set<string>();
    const matchedDomainTitleHashes = new Set<string>();
    const matchedTitleHashes = new Set<string>();

    for (const row of dbResult.rows) {
      if (row.normalized_url_hash) matchedUrlHashes.add(row.normalized_url_hash);
      if (row.domain_title_hash) matchedDomainTitleHashes.add(row.domain_title_hash);
      matchedTitleHashes.add(row.title_hash);
    }

    // Mark duplicates
    for (const { article, index } of surviving) {
      if (isDup.has(index)) continue;
      if (
        matchedUrlHashes.has(article.normalizedUrlHash) ||
        matchedDomainTitleHashes.has(article.domainTitleHash) ||
        matchedTitleHashes.has(article.titleHash)
      ) {
        isDup.add(index);
        duplicates.push({
          url: article.url,
          title: article.title,
          sourceApi: article.sourceApi,
          sourceDomain: article.sourceDomain,
          rejectionStage: 'filter',
          rejectionRule: 'dedup_exact',
          contextLen: (article.description?.length ?? 0) + (article.content?.length ?? 0),
        });
      }
    }
  }

  // ── Layer 4: In-memory fuzzy same-batch ──
  const fuzzyCandidates = articles
    .map((a, i) => ({ article: a, index: i }))
    .filter(({ index }) => !isDup.has(index));

  for (let i = 0; i < fuzzyCandidates.length; i++) {
    if (isDup.has(fuzzyCandidates[i].index)) continue;
    for (let j = i + 1; j < fuzzyCandidates.length; j++) {
      if (isDup.has(fuzzyCandidates[j].index)) continue;
      const sim = trigramSim(
        fuzzyCandidates[i].article.title,
        fuzzyCandidates[j].article.title,
      );
      if (sim > DEDUP_SIMILARITY_THRESHOLD) {
        const dupIdx = fuzzyCandidates[j].index;
        isDup.add(dupIdx);
        duplicates.push({
          url: articles[dupIdx].url,
          title: articles[dupIdx].title,
          sourceApi: articles[dupIdx].sourceApi,
          sourceDomain: articles[dupIdx].sourceDomain,
          rejectionStage: 'filter',
          rejectionRule: 'dedup_fuzzy',
          contextLen: (articles[dupIdx].description?.length ?? 0) + (articles[dupIdx].content?.length ?? 0),
        });
      }
    }
  }

  const unique = articles.filter((_, i) => !isDup.has(i));
  return { unique, duplicates };
}
