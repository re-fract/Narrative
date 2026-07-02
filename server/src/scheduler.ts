import cron from 'node-cron';
import { runPipeline } from './services/pipeline/pipeline.js';
import { cleanupOldRejections } from './services/pipeline/metrics.js';

export function startScheduler(): void {
  // 11 PM IST = 5:30 PM UTC
  cron.schedule('30 17 * * *', async () => {
    console.log('[SCHEDULER] Starting daily pipeline');
    try {
      const result = await runPipeline();
      console.log('[SCHEDULER] Pipeline completed:', result);
    } catch (err) {
      console.error('[SCHEDULER] Pipeline failed:', err);
    }
  });

  // 2 AM IST = 8:30 PM UTC previous day
  cron.schedule('30 20 * * *', async () => {
    try {
      const deleted = await cleanupOldRejections(30);
      console.log(`[SCHEDULER] Cleanup completed: ${deleted} old rejection_log entries removed`);
    } catch (err) {
      console.error('[SCHEDULER] Cleanup failed:', err);
    }
  });

  console.log('[SCHEDULER] Daily pipeline scheduled at 11 PM IST (17:30 UTC)');
  console.log('[SCHEDULER] Daily cleanup scheduled at 2 AM IST (20:30 UTC)');
}
