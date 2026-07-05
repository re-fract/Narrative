-- ════════════════════════════════════════════════════════════════
-- NARRATIVE NEWS BRIEF — COMBINED SCHEMA (4-API + STORY LOGIC)
-- ════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ════════════════════════════════════════════════════════════════
-- STORIES — Created BEFORE articles (referenced by articles.story_id FK)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS stories (
    id                       SERIAL PRIMARY KEY,
    title                    VARCHAR(500),
    centroid                 JSONB,              -- Weighted centroid of article embeddings
    status                   VARCHAR(20) DEFAULT 'active',
    article_count            INTEGER DEFAULT 0,
    first_seen_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_updated_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    frozen_at                TIMESTAMPTZ,
    -- Story intelligence columns
    keyword_set              TEXT[],              -- Tiered keyword accumulation
    canonical_embedding      JSONB,               -- Stable reference embedding
    main_genre               VARCHAR(20),           -- 'india' | 'global'
    llm_category             VARCHAR(20),           -- Majority category: economics, policy, science, accountability, business, none
    importance_score         NUMERIC,
    source_count             INTEGER DEFAULT 0,  -- Distinct source_name count
    representative_article_id INTEGER            -- Soft reference, no FK
);

CREATE INDEX IF NOT EXISTS idx_stories_importance ON stories(importance_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_stories_main_genre ON stories(main_genre);
CREATE INDEX IF NOT EXISTS idx_stories_llm_category ON stories(llm_category);
CREATE INDEX IF NOT EXISTS idx_stories_keyword_set ON stories USING gin(keyword_set);
CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);


-- ════════════════════════════════════════════════════════════════
-- ARTICLES — Core storage (merged from both plans)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS articles (
    id                  SERIAL PRIMARY KEY,

    -- ── Identity ──
    external_id         VARCHAR(255),           -- API-specific ID
    source_api          VARCHAR(20) NOT NULL,   -- webzio | newsdata | worldnews | thenewsapi
    url                 TEXT UNIQUE NOT NULL,
    title_hash          VARCHAR(64) NOT NULL,   -- SHA-256 of normalized title (F8 layer 3)
    normalized_url_hash VARCHAR(64),             -- SHA-256 of normalized URL (F8 layer 1)
    domain_title_hash   VARCHAR(64),             -- SHA-256 of domain + first 50 chars normalized title (F8 layer 2)

    -- ── Content ──
    title               TEXT NOT NULL,
    description         TEXT,                   -- API-provided snippet (200-420 chars typical)
    content             TEXT,                   -- API-provided longer excerpt (WorldNewsAPI only)
    full_text           TEXT,                   -- Scraped full article text
    summary             TEXT,                   -- Per-article 3-bullet summary (Cerebras zai-glm-4.7)
    image_url           TEXT,

    -- ── Attribution ──
    author              TEXT,
    source_name         VARCHAR(255),           -- Outlet name (across all APIs)
    source_domain       VARCHAR(255),           -- Extracted domain for blocklist matching

    -- ── Story membership ──
    story_id            INTEGER REFERENCES stories(id),
    importance_score    NUMERIC,                -- Article-level quality score

    -- ── Temporal ──
    published_at        TIMESTAMPTZ NOT NULL,
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- ── LLM Classification ──
    llm_tier            CHAR(1),                -- A, B, C, D
    llm_category        VARCHAR(20),            -- economics, policy, science, accountability, business, none
    llm_reason          TEXT,                    -- LLM one-sentence justification
    llm_scored_at       TIMESTAMPTZ,
    llm_model           VARCHAR(50),            -- 'gpt-oss-120b'

    -- ── Embedding ──
    embedding           JSONB,                  -- Gemini embedding vector (TODO: consider pgvector vector(768) for ANN search at scale)

    -- ── Pipeline ──
    main_genre          VARCHAR(20),            -- 'india' | 'global' (region classification)
    homepage_eligible   BOOLEAN DEFAULT true,
    scrape_status       VARCHAR(20) DEFAULT 'pending'
                          CHECK (scrape_status IN ('pending','lookup','failed','thin','full')),

    -- ── API Metadata (preserved for LLM context + analysis) ──
    api_category        VARCHAR(100),
    api_iptc_category   VARCHAR(100),           -- Webz.io IPTC category
    api_sentiment       REAL,                   -- WorldNewsAPI (-1 to 1) or Webz.io mapped
    api_language        VARCHAR(10),
    api_country         VARCHAR(10),
    api_keywords        TEXT[],                  -- Cleaned keywords (array for GIN index)
    api_entities        JSONB DEFAULT '[]',     -- [{name, type, sentiment}]
    api_source_priority INTEGER,                 -- NewsData.io source_priority
    api_relevance_score REAL,                   -- TheNewsAPI relevance_score
    api_domain_rank     INTEGER,                 -- Webz.io domain_rank
    api_performance     REAL,                   -- Webz.io performance_score
    api_social          JSONB,                  -- Webz.io social signals
    api_duplicate_flag  BOOLEAN,                 -- NewsData.io duplicate field

    -- ── Classification status ──
    filter_status       VARCHAR(15) NOT NULL DEFAULT 'accepted',
        -- 'accepted'  = LLM Tier A or B (only tier stored in this table)
        -- 'rejected'  = LLM Tier C or D
        -- 'filtered'  = rejected by structural filters
    rejection_reason    TEXT,
    is_duplicate        BOOLEAN NOT NULL DEFAULT FALSE,
    duplicate_of_id     INTEGER REFERENCES articles(id),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════
-- Performance Indexes
-- ════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(filter_status);
CREATE INDEX IF NOT EXISTS idx_articles_tier ON articles(llm_tier) WHERE filter_status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(llm_category) WHERE filter_status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_articles_title_hash ON articles(title_hash);
CREATE INDEX IF NOT EXISTS idx_articles_normalized_url_hash ON articles(normalized_url_hash);
CREATE INDEX IF NOT EXISTS idx_articles_domain_title_hash ON articles(domain_title_hash);
CREATE INDEX IF NOT EXISTS idx_articles_source_api ON articles(source_api);
CREATE INDEX IF NOT EXISTS idx_articles_domain ON articles(source_domain);
CREATE INDEX IF NOT EXISTS idx_articles_url ON articles(url);
CREATE INDEX IF NOT EXISTS idx_articles_story_id ON articles(story_id);
CREATE INDEX IF NOT EXISTS idx_articles_scrape_status ON articles(scrape_status);
CREATE INDEX IF NOT EXISTS idx_articles_main_genre ON articles(main_genre);
CREATE INDEX IF NOT EXISTS idx_articles_importance ON articles(importance_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_articles_source_name ON articles(source_name);

-- Fuzzy dedup index
CREATE INDEX IF NOT EXISTS idx_articles_title_trgm ON articles USING gin(title gin_trgm_ops);

-- Keywords GIN index (for story keyword overlap queries)
CREATE INDEX IF NOT EXISTS idx_articles_keywords ON articles USING gin(api_keywords);

-- Hot query path: accepted articles (time filter applied at query time,
-- not in index predicate — NOW()/CURRENT_DATE are not IMMUTABLE in Postgres)
CREATE INDEX IF NOT EXISTS idx_articles_recent_accepted
    ON articles(published_at DESC, llm_tier ASC)
    WHERE filter_status = 'accepted';


-- ════════════════════════════════════════════════════════════════
-- BRIEFS — Daily cached briefs
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS briefs (
    id          SERIAL PRIMARY KEY,
    brief_date  DATE NOT NULL,
    story_ids   INTEGER[] NOT NULL,
    article_ids INTEGER[] NOT NULL,     -- The 14 homepage articles (one per selected story)
    user_id     INTEGER,
    created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(brief_date, user_id)
);

CREATE INDEX IF NOT EXISTS idx_briefs_date ON briefs(brief_date);

-- Partial unique index: ensures only one brief per date when user_id IS NULL.
-- Required by the pipeline's ON CONFLICT (brief_date, user_id) WHERE user_id IS NULL.
-- The standard UNIQUE(brief_date, user_id) constraint does NOT enforce uniqueness for NULLs
-- (NULL != NULL in Postgres), so two NULL-user rows for the same date would be allowed without this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_briefs_date_null_user ON briefs(brief_date) WHERE user_id IS NULL;


-- ════════════════════════════════════════════════════════════════
-- SIMPLIFICATIONS — Cached per-article LLM simplifications
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS simplifications (
    id         SERIAL PRIMARY KEY,
    article_id INTEGER REFERENCES articles(id),
    level      VARCHAR(20),
    text       TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(article_id, level)
);

CREATE INDEX IF NOT EXISTS idx_simplifications_article_id ON simplifications(article_id);


-- ════════════════════════════════════════════════════════════════
-- FOLLOWS — Story tracking
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS follows (
    id          SERIAL PRIMARY KEY,
    story_id    INTEGER REFERENCES stories(id),
    user_id     INTEGER,
    last_seen_at TIMESTAMPTZ,
    followed_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(story_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_story_id ON follows(story_id);




-- ════════════════════════════════════════════════════════════════
-- REJECTION_LOG — Why articles were rejected
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rejection_log (
    id              SERIAL PRIMARY KEY,
    url             TEXT NOT NULL,
    title           TEXT,
    source_api      VARCHAR(20),
    source_domain   VARCHAR(255),
    rejection_stage VARCHAR(20) NOT NULL,      -- 'filter' or 'llm'
    rejection_rule  VARCHAR(50),               -- e.g. 'domain_blocklist'
    context_len      INTEGER,               -- total chars of description+content at rejection time (what the LLM sees)
    llm_tier        CHAR(1),                   -- C or D (if LLM rejected)
    llm_category    VARCHAR(20),
    llm_reason      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rejections_stage ON rejection_log(rejection_stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rejections_rule ON rejection_log(rejection_rule, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rejections_domain ON rejection_log(source_domain);


-- ════════════════════════════════════════════════════════════════
-- PIPELINE_RUNS — Observability for daily scheduled runs
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pipeline_runs (
    id                  SERIAL PRIMARY KEY,
    started_at          TIMESTAMPTZ NOT NULL,
    completed_at        TIMESTAMPTZ,
    articles_fetched    INTEGER DEFAULT 0,
    articles_filtered   INTEGER DEFAULT 0,
    articles_deduped    INTEGER DEFAULT 0,
    articles_classified INTEGER DEFAULT 0,
    articles_stored     INTEGER DEFAULT 0,      -- Tier A+B
    stories_matched     INTEGER DEFAULT 0,
    stories_created     INTEGER DEFAULT 0,
    articles_summarized INTEGER DEFAULT 0,  -- Representative articles with 3-bullet summary
    brief_id            INTEGER REFERENCES briefs(id),
    status              TEXT NOT NULL DEFAULT 'running',
    error_message       TEXT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);


-- ════════════════════════════════════════════════════════════════
-- DAILY_METRICS — Aggregated daily stats
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS daily_metrics (
    id                  SERIAL PRIMARY KEY,
    date                DATE UNIQUE NOT NULL,
    total_fetched       INTEGER DEFAULT 0,
    total_filtered      INTEGER DEFAULT 0,
    total_deduplicated  INTEGER DEFAULT 0,
    total_to_llm        INTEGER DEFAULT 0,
    total_accepted      INTEGER DEFAULT 0,
    total_rejected_llm  INTEGER DEFAULT 0,
    tier_a_count        INTEGER DEFAULT 0,
    tier_b_count        INTEGER DEFAULT 0,
    tier_c_count        INTEGER DEFAULT 0,
    tier_d_count        INTEGER DEFAULT 0,
    economics_count     INTEGER DEFAULT 0,
    policy_count        INTEGER DEFAULT 0,
    science_count       INTEGER DEFAULT 0,
    accountability_count INTEGER DEFAULT 0,
    business_count      INTEGER DEFAULT 0,
    filtered_language    INTEGER DEFAULT 0,
    filtered_stale      INTEGER DEFAULT 0,
    filtered_content_min INTEGER DEFAULT 0,
    filtered_domain     INTEGER DEFAULT 0,
    filtered_url_path   INTEGER DEFAULT 0,
    filtered_title_pat  INTEGER DEFAULT 0,
    filtered_template   INTEGER DEFAULT 0,
    filtered_dedup      INTEGER DEFAULT 0,
    llm_requests_used   INTEGER DEFAULT 0,
    llm_errors          INTEGER DEFAULT 0,
    cerebras_120b_tokens INTEGER DEFAULT 0,
    cerebras_47_tokens  INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


