/**
 * backfill_recluster.mjs
 *
 * One-shot script: assigns story_id to articles that are currently NULL
 * but whose embedding is similar enough (>= 0.75) to an existing story centroid.
 *
 * This repairs the gap between the old clustering threshold (0.80) and the
 * timeline display threshold (0.75), where articles appeared in timelines but
 * couldn't be navigated to.
 *
 * Run with:  node server/backfill_recluster.mjs
 * (from the repo root, where server/.env lives)
 */

import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const SIMILARITY_THRESHOLD = 0.75;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ────────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function parseVector(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('=== Re-cluster backfill (threshold: 0.75) ===\n');

// 1. Load all stories that have a centroid
const storiesResult = await pool.query(
  'SELECT id, centroid FROM stories WHERE centroid IS NOT NULL'
);

const stories = storiesResult.rows.map(r => ({
  id: r.id,
  centroid: parseVector(r.centroid),
}));

console.log(`Loaded ${stories.length} stories with centroids.`);

if (stories.length === 0) {
  console.log('No stories to match against. Exiting.');
  await pool.end();
  process.exit(0);
}

// 2. Load all articles that have an embedding but no story_id
const articlesResult = await pool.query(
  'SELECT id, embedding FROM articles WHERE story_id IS NULL AND embedding IS NOT NULL'
);

console.log(`Found ${articlesResult.rows.length} unlinked articles to process.\n`);

if (articlesResult.rows.length === 0) {
  console.log('Nothing to do. All embedded articles already have a story_id.');
  await pool.end();
  process.exit(0);
}

// 3. For each unlinked article, find the best matching story
let assigned = 0;
let skipped  = 0;

// Track how many new articles each story gains so we can update article_count
const storyGains = new Map(); // storyId → count

for (const article of articlesResult.rows) {
  const embedding = parseVector(article.embedding);

  let bestStory = null;
  let bestScore = -Infinity;

  for (const story of stories) {
    try {
      const score = cosineSimilarity(embedding, story.centroid);
      if (score > bestScore) {
        bestScore = score;
        bestStory = story;
      }
    } catch {
      // Vector length mismatch — skip this story
    }
  }

  if (bestStory && bestScore >= SIMILARITY_THRESHOLD) {
    await pool.query(
      'UPDATE articles SET story_id = $1 WHERE id = $2',
      [bestStory.id, article.id]
    );
    storyGains.set(bestStory.id, (storyGains.get(bestStory.id) ?? 0) + 1);
    assigned++;
    if (assigned % 25 === 0) {
      console.log(`  Assigned ${assigned}/${articlesResult.rows.length} so far...`);
    }
  } else {
    skipped++;
  }
}

// 4. Update article_count on affected stories
console.log(`\nUpdating article_count for ${storyGains.size} stories...`);
for (const [storyId, gain] of storyGains) {
  await pool.query(
    'UPDATE stories SET article_count = article_count + $1, last_updated_at = NOW() WHERE id = $2',
    [gain, storyId]
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n=== Done ===');
console.log(`  Assigned : ${assigned} articles`);
console.log(`  Skipped  : ${skipped} articles (no story scored >= ${SIMILARITY_THRESHOLD})`);
console.log(`  Stories updated: ${storyGains.size}`);

if (skipped > 0) {
  console.log(
    `\n  Note: ${skipped} articles remain unlinked — they are genuinely too different\n` +
    `  from every existing story centroid at the 0.75 threshold and will continue\n` +
    `  to appear in timelines with an external-link fallback.`
  );
}

await pool.end();
