// ── Classification ──
export const CLASSIFICATION_BATCH_SIZE = 5;         // Articles per Groq 120b batch
export const CLASSIFICATION_MODEL = 'openai/gpt-oss-120b';
export const CLASSIFICATION_TEMPERATURE = 0.1;

// ── Summarization ──
export const SUMMARIZATION_MODEL = 'openai/gpt-oss-20b';
export const SUMMARIZATION_TEMPERATURE = 0.2;
export const SUMMARIZATION_MAX_TOKENS = 1024;
export const SIMPLIFICATION_MAX_TOKENS = 1536;

// ── Groq Rate Limits (openai/gpt-oss-120b) ──
// 30 RPM, 1K RPD, 8K TPM, 200K TPD per dashboard.
export const GROQ_RPM = 30;
export const GROQ_RPD = 1_000;

// ── Structural Filter Thresholds ──
export const STALENESS_CUTOFF_HOURS = 30;
export const TITLE_MIN_LENGTH = 15;

// Per-API description minimum lengths (F3 filter)
export const DESCRIPTION_MIN_LENGTHS: Record<string, number> = {
  worldnews: 80,
  newsdata: 200,
  webzio: 60,
  thenewsapi: 50,
};

// ── Dedup Thresholds ──
export const DEDUP_SIMILARITY_THRESHOLD = 0.7;     // pg_trgm fuzzy threshold
export const TITLE_SIMILARITY_LOOKUP = 0.75;        // WorldNewsAPI lookup title match
export const DEDUP_CHECK_DAYS = 7;                  // Cross-day dedup lookback window

// ── Story Clustering ──
export const SIMILARITY_THRESHOLD_EXISTING = 0.75;
export const SIMILARITY_THRESHOLD_NEW = 0.80;

// ── Brief Selection ──
export const BRIEF_SIZE = 14;
export const BRIEF_MIN_SCORE = 0.40;
export const BRIEF_MAX_PER_CATEGORY = 4;
export const BRIEF_MAX_PER_REGION = 8;

// ── Scraping ──
export const SCRAPE_CONCURRENCY = 5;
export const SCRAPE_TIMEOUT_MS = 10000;
export const SCRAPE_DOMAIN_COOLDOWN_HOURS = 48;
export const SCRAPE_FAILURE_THRESHOLD = 5;
export const SCRAPE_THIN_CONTENT_CHARS = 200;

// ── Embedding ──
export const EMBED_MAX_TEXT_CHARS = 2000;
export const EMBED_BATCH_SIZE = 100;

// ── LLM Category Values ──
export const VALID_LLM_CATEGORIES = ['economics', 'policy', 'science', 'accountability', 'business', 'none'] as const;
export const VALID_LLM_TIERS = ['A', 'B', 'C', 'D'] as const;
export type LlmCategory = typeof VALID_LLM_CATEGORIES[number];
export type LlmTier = typeof VALID_LLM_TIERS[number];
