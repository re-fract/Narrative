import { Router } from 'express';
import { runPipeline } from '../services/pipeline/pipeline.js';

const router = Router();

// POST /api/admin/trigger-pipeline
// Query params:
//   maxArticles=N — test mode: cap pipeline to N articles (limits LLM spend, runs all phases)
router.post('/trigger-pipeline', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const secret = process.env.PIPELINE_SECRET || 'dev-local';
  if (authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const maxArticles = req.query.maxArticles ? Number(req.query.maxArticles) : undefined;
  // Don't await — return immediately, pipeline runs in background
  runPipeline(maxArticles ? { maxArticles } : undefined).then(result => {
    console.log('[ADMIN] Pipeline triggered successfully:', result);
  }).catch(err => {
    console.error('[ADMIN] Pipeline triggered but failed:', err);
  });
  const msg = maxArticles
    ? `Pipeline started (test mode, max ${maxArticles} articles)`
    : 'Pipeline started';
  res.json({ triggered: true, message: msg });
});

export default router;