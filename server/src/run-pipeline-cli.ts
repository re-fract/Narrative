import './config.js';
import { runPipeline } from './services/pipeline/pipeline.js';
import { pool } from './db/index.js';

async function main() {
  console.log('[CLI] Starting news ingestion pipeline...');
  const start = Date.now();
  
  try {
    const result = await runPipeline();
    const durationSec = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[CLI] Pipeline completed successfully in ${durationSec}s:`, result);
    process.exit(0);
  } catch (err) {
    console.error('[CLI] Pipeline run encountered a critical error:', err);
    process.exit(1);
  } finally {
    // Gracefully shut down the postgres connection pool so the Node process terminates immediately
    await pool.end();
  }
}

main();
