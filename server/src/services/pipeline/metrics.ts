import { pool } from '../../db/index.js';

/**
 * Aggregate today's (or a given date's) pipeline statistics into daily_metrics.
 * Uses INSERT ... ON CONFLICT (date) DO UPDATE for idempotency.
 *
 * Queries three source tables separately, then upserts:
 *   1. articles — accepted/rejected counts, tier breakdown, category counts
 *   2. rejection_log — structural filter counts by rule
 *   3. pipeline_runs — fetched/classified/LLM error stats
 */
export async function aggregateDailyMetrics(date?: Date): Promise<void> {
  const targetDate = (date ?? new Date()).toISOString().split('T')[0]; // 'YYYY-MM-DD'
  const dayStart = `${targetDate} 00:00:00+00`;
  const dayEnd = `${targetDate} 23:59:59+00`;

  // ── Query 1: Article stats ──
  const artStats = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE filter_status = 'accepted')        AS total_accepted,
       COUNT(*) FILTER (WHERE filter_status = 'rejected')        AS total_rejected_llm,
       COUNT(*) FILTER (WHERE llm_tier = 'A')                   AS tier_a_count,
       COUNT(*) FILTER (WHERE llm_tier = 'B')                   AS tier_b_count,
       COUNT(*) FILTER (WHERE llm_tier = 'C')                   AS tier_c_count,
       COUNT(*) FILTER (WHERE llm_tier = 'D')                   AS tier_d_count,
       COUNT(*) FILTER (WHERE filter_status = 'accepted' AND llm_category = 'economics')       AS economics_count,
       COUNT(*) FILTER (WHERE filter_status = 'accepted' AND llm_category = 'policy')          AS policy_count,
       COUNT(*) FILTER (WHERE filter_status = 'accepted' AND llm_category = 'science')         AS science_count,
       COUNT(*) FILTER (WHERE filter_status = 'accepted' AND llm_category = 'accountability')  AS accountability_count,
       COUNT(*) FILTER (WHERE filter_status = 'accepted' AND llm_category = 'business')        AS business_count
     FROM articles
     WHERE created_at BETWEEN $1 AND $2
       AND filter_status IN ('accepted', 'rejected')`,
    [dayStart, dayEnd]
  );
  const a = artStats.rows[0];

  // ── Query 2: Rejection log stats ──
  const rejStats = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE rejection_rule = 'language')          AS filtered_language,
       COUNT(*) FILTER (WHERE rejection_rule = 'stale')             AS filtered_stale,
       COUNT(*) FILTER (WHERE rejection_rule = 'content_min')      AS filtered_content_min,
       COUNT(*) FILTER (WHERE rejection_rule = 'domain_blocklist')  AS filtered_domain,
       COUNT(*) FILTER (WHERE rejection_rule = 'url_path')         AS filtered_url_path,
       COUNT(*) FILTER (WHERE rejection_rule = 'title_pattern')    AS filtered_title_pat,
       COUNT(*) FILTER (WHERE rejection_rule = 'template')          AS filtered_template,
       COUNT(*) FILTER (WHERE rejection_rule LIKE 'dedup%')         AS filtered_dedup,
       COUNT(*)                                                    AS total_filtered
     FROM rejection_log
     WHERE created_at BETWEEN $1 AND $2`,
    [dayStart, dayEnd]
  );
  const r = rejStats.rows[0];

  // ── Query 3: Pipeline run stats ──
  const runStats = await pool.query(
    `SELECT
       COALESCE(SUM(articles_fetched), 0)    AS total_fetched,
       COALESCE(SUM(articles_classified), 0) AS total_to_llm,
       COALESCE(SUM(articles_classified) FILTER (WHERE status = 'success'), 0) AS llm_requests_used,
       COUNT(*) FILTER (WHERE status = 'failed') AS llm_errors
     FROM pipeline_runs
     WHERE started_at BETWEEN $1 AND $2`,
    [dayStart, dayEnd]
  );
  const p = runStats.rows[0];

  // ── Upsert into daily_metrics ──
  await pool.query(
    `INSERT INTO daily_metrics (
       date,
       total_fetched, total_filtered, total_deduplicated,
       total_to_llm, total_accepted, total_rejected_llm,
       tier_a_count, tier_b_count, tier_c_count, tier_d_count,
       economics_count, policy_count, science_count, accountability_count, business_count,
       filtered_language, filtered_stale, filtered_content_min, filtered_domain,
       filtered_url_path, filtered_title_pat, filtered_template, filtered_dedup,
       llm_requests_used, llm_errors
     ) VALUES (
       $1,
       $2, $3, $4,
       $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14, $15, $16,
       $17, $18, $19, $20,
       $21, $22, $23, $24,
       $25, $26
     )
     ON CONFLICT (date) DO UPDATE SET
       total_fetched       = EXCLUDED.total_fetched,
       total_filtered      = EXCLUDED.total_filtered,
       total_deduplicated  = EXCLUDED.total_deduplicated,
       total_to_llm        = EXCLUDED.total_to_llm,
       total_accepted      = EXCLUDED.total_accepted,
       total_rejected_llm  = EXCLUDED.total_rejected_llm,
       tier_a_count        = EXCLUDED.tier_a_count,
       tier_b_count        = EXCLUDED.tier_b_count,
       tier_c_count        = EXCLUDED.tier_c_count,
       tier_d_count        = EXCLUDED.tier_d_count,
       economics_count     = EXCLUDED.economics_count,
       policy_count        = EXCLUDED.policy_count,
       science_count       = EXCLUDED.science_count,
       accountability_count = EXCLUDED.accountability_count,
       business_count      = EXCLUDED.business_count,
       filtered_language   = EXCLUDED.filtered_language,
       filtered_stale      = EXCLUDED.filtered_stale,
       filtered_content_min = EXCLUDED.filtered_content_min,
       filtered_domain     = EXCLUDED.filtered_domain,
       filtered_url_path   = EXCLUDED.filtered_url_path,
       filtered_title_pat  = EXCLUDED.filtered_title_pat,
       filtered_template   = EXCLUDED.filtered_template,
       filtered_dedup      = EXCLUDED.filtered_dedup,
       llm_requests_used   = EXCLUDED.llm_requests_used,
       llm_errors          = EXCLUDED.llm_errors`,
    [
      targetDate,
      // pipeline_runs
      p.total_fetched,
      r.total_filtered,
      r.filtered_dedup, // total_deduplicated = same as filtered_dedup
      p.total_to_llm,
      // articles
      a.total_accepted,
      a.total_rejected_llm,
      a.tier_a_count,
      a.tier_b_count,
      a.tier_c_count,
      a.tier_d_count,
      a.economics_count,
      a.policy_count,
      a.science_count,
      a.accountability_count,
      a.business_count,
      // rejection_log
      r.filtered_language,
      r.filtered_stale,
      r.filtered_content_min,
      r.filtered_domain,
      r.filtered_url_path,
      r.filtered_title_pat,
      r.filtered_template,
      r.filtered_dedup,
      // pipeline_runs LLM stats
      p.llm_requests_used,
      p.llm_errors,
    ]
  );

  console.log(`[METRICS] Aggregated daily metrics for ${targetDate}`);
}

/**
 * Delete rows from rejection_log older than keepDays days.
 * Returns the number of deleted rows.
 */
export async function cleanupOldRejections(keepDays: number = 30): Promise<number> {
  const result = await pool.query(
    `DELETE FROM rejection_log WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
    [keepDays]
  );
  console.log(`[METRICS] Cleaned up ${result.rowCount} old rejection_log entries (kept ${keepDays} days)`);
  return result.rowCount ?? 0;
}
