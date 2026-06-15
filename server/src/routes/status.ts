import { Router } from 'express';
import { getBudgetStatus } from '../services/budgetTracker.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const budget = await getBudgetStatus();
    res.json({
      status: 'ok',
      budget,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

export default router;
