import { pool } from '../db/index.js';

export async function trackAPICall(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await pool.query(
    `INSERT INTO api_usage (usage_date, call_count)
     VALUES ($1, 1)
     ON CONFLICT (usage_date)
     DO UPDATE SET call_count = api_usage.call_count + 1`,
    [today]
  );
}

export async function getDailyUsage(): Promise<number> {
  const today = new Date().toISOString().split('T')[0];
  const res = await pool.query(
    'SELECT call_count FROM api_usage WHERE usage_date = $1',
    [today]
  );
  return res.rows[0]?.call_count ?? 0;
}

export async function getBudgetStatus(): Promise<{ used: number; remaining: number; limit: number }> {
  const used = await getDailyUsage();
  const limit = 1500;
  return { used, remaining: Math.max(0, limit - used), limit };
}
