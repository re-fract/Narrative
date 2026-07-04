import { pool } from '../../db/index.js';

const TIMELINE_WINDOW_DAYS = 14;
const TIMELINE_DEDUP_THRESHOLD = 0.85;

// Cosine similarity between two vectors
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Helper: parse an embedding field safely
function parseEmb(raw: string | null): number[] | null {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

export interface TimelineArticle {
  id: number;
  story_id: number;
  title: string;
  url: string;
  published_at: string;
  source_name: string | null;
  summary?: string | null;
  llm_category?: string | null;
}

interface BuildOptions {
  windowDays?: number;       // default 14
  maxPerDay?: number;        // default 2
  candidatesPerDay?: number; // default 4
  pinnedArticleId?: number;  // always include this article first
  includeSummary?: boolean;  // also fetch summary + llm_category columns
}

/**
 * Builds a deduped, quality-ranked timeline of articles for a story.
 *
 * Logic (identical to the original inline code in stories.ts GET /:id/timeline):
 *  1. Fetch up to `candidatesPerDay` articles per day, ranked by importance_score
 *  2. Pin `pinnedArticleId` first (always included)
 *  3. Walk remaining candidates; skip near-duplicates (cosine sim >= threshold)
 *     and days that have hit `maxPerDay` quota
 *  4. Re-sort by published_at DESC
 */
export async function buildStoryTimeline(
  storyId: number,
  options: BuildOptions = {},
): Promise<TimelineArticle[]> {
  const windowDays      = options.windowDays      ?? TIMELINE_WINDOW_DAYS;
  const maxPerDay       = options.maxPerDay        ?? 2;
  const candidatesPerDay = options.candidatesPerDay ?? 4;
  const pinnedArticleId = options.pinnedArticleId  ?? null;
  const includeSummary  = options.includeSummary   ?? false;

  const extraColumns = includeSummary ? ', a.summary, a.llm_category' : '';

  const candidatesRes = await pool.query<{
    id: number;
    story_id: number;
    title: string;
    url: string;
    published_at: string;
    source_name: string | null;
    embedding: string | null;
    day_rank: number;
    summary?: string | null;
    llm_category?: string | null;
  }>(
    `SELECT * FROM (
       SELECT a.id, a.story_id, a.title, a.url, a.published_at, a.source_name,
              a.embedding${extraColumns},
              ROW_NUMBER() OVER (
                PARTITION BY DATE(a.published_at AT TIME ZONE 'UTC')
                ORDER BY a.importance_score DESC NULLS LAST, a.published_at DESC
              ) AS day_rank
       FROM articles a
       WHERE a.story_id = $1
         AND a.published_at >= NOW() - INTERVAL '${windowDays} days'
     ) sub
     WHERE sub.day_rank <= ${candidatesPerDay}
     ORDER BY sub.published_at DESC`,
    [storyId],
  );

  const selectedPerDay = new Map<string, number>(); // day → count kept
  const selectedEmbeddings: number[][] = [];
  const result: TimelineArticle[] = [];

  // Pin the specified article first — it must always appear.
  // Register its embedding so the dedup loop below can suppress near-duplicates.
  if (pinnedArticleId !== null) {
    const pinned = candidatesRes.rows.find(r => r.id === pinnedArticleId);
    if (pinned) {
      const emb = parseEmb(pinned.embedding);
      if (emb !== null) selectedEmbeddings.push(emb);
      const day = pinned.published_at.toString().substring(0, 10);
      selectedPerDay.set(day, (selectedPerDay.get(day) ?? 0) + 1);
      const { embedding: _e, day_rank: _r, ...clean } = pinned;
      result.push(clean as TimelineArticle);
    }
  }

  // Walk remaining candidates; skip pinned, near-duplicates, and full-day quotas.
  for (const row of candidatesRes.rows) {
    if (row.id === pinnedArticleId) continue;

    const day = row.published_at.toString().substring(0, 10);
    const dayCount = selectedPerDay.get(day) ?? 0;
    if (dayCount >= maxPerDay) continue;

    const emb = parseEmb(row.embedding);
    if (emb !== null && selectedEmbeddings.length > 0) {
      const isDuplicate = selectedEmbeddings.some(
        sel => cosineSim(emb!, sel) >= TIMELINE_DEDUP_THRESHOLD,
      );
      if (isDuplicate) continue;
    }

    if (emb !== null) selectedEmbeddings.push(emb);
    selectedPerDay.set(day, dayCount + 1);

    const { embedding: _emb, day_rank: _rank, ...clean } = row;
    result.push(clean as TimelineArticle);
  }

  // Re-sort chronologically (pinning may have disturbed order)
  result.sort((a, b) =>
    new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
  );

  return result;
}
