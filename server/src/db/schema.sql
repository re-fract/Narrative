-- ============================================================
-- News Brief — Database Schema
-- All dates/times are UTC. IDs are SERIAL for simplicity.
-- user_id columns are nullable (single-user now, multi-user later).
-- ============================================================

-- News sources (RSS feeds)
CREATE TABLE IF NOT EXISTS sources (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    feed_url    VARCHAR(500) NOT NULL UNIQUE,
    base_url    VARCHAR(500),
    category    VARCHAR(50),
    is_active   BOOLEAN DEFAULT true
);

-- Story clusters: persistent, evolving news events
CREATE TABLE IF NOT EXISTS stories (
    id                          SERIAL PRIMARY KEY,
    title                       VARCHAR(500),
    summary                     TEXT,
    centroid                    JSONB,
    status                      VARCHAR(20) DEFAULT 'active',
    article_count               INTEGER DEFAULT 0,
    expansion_json              JSONB,
    expansion_built_at_count    INTEGER DEFAULT 0,
    summary_built_at_count      INTEGER DEFAULT 0,
    first_seen_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Individual articles ingested from feeds
CREATE TABLE IF NOT EXISTS articles (
    id              SERIAL PRIMARY KEY,
    story_id        INTEGER REFERENCES stories(id),
    source_id       INTEGER REFERENCES sources(id),
    url             VARCHAR(1000) NOT NULL UNIQUE,
    title           VARCHAR(500) NOT NULL,
    body            TEXT,
    embedding       JSONB,
    published_at    TIMESTAMP,
    fetched_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Daily assembled briefs
CREATE TABLE IF NOT EXISTS briefs (
    id              SERIAL PRIMARY KEY,
    brief_date      DATE NOT NULL,
    story_ids       INTEGER[] NOT NULL,
    user_id         INTEGER,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(brief_date, user_id)
);

-- Cached simplifications (per story per reading level)
CREATE TABLE IF NOT EXISTS simplifications (
    id          SERIAL PRIMARY KEY,
    story_id    INTEGER REFERENCES stories(id),
    level       VARCHAR(20),
    text        TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(story_id, level)
);

-- Timeline entries: only material changes
CREATE TABLE IF NOT EXISTS timeline_entries (
    id                      SERIAL PRIMARY KEY,
    story_id                INTEGER REFERENCES stories(id),
    triggered_by_article_id INTEGER REFERENCES articles(id),
    classification          VARCHAR(20),
    text                    TEXT NOT NULL,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Follows: stories the user is tracking
CREATE TABLE IF NOT EXISTS follows (
    id              SERIAL PRIMARY KEY,
    story_id        INTEGER REFERENCES stories(id),
    user_id         INTEGER,
    last_seen_at    TIMESTAMP,
    followed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(story_id, user_id)
);

-- Chat threads
CREATE TABLE IF NOT EXISTS chat_threads (
    id          SERIAL PRIMARY KEY,
    story_id    INTEGER REFERENCES stories(id),
    user_id     INTEGER,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
    id              SERIAL PRIMARY KEY,
    thread_id       INTEGER REFERENCES chat_threads(id),
    role            VARCHAR(20) NOT NULL,
    content         TEXT NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Interaction log (future personalization)
CREATE TABLE IF NOT EXISTS interactions (
    id              SERIAL PRIMARY KEY,
    story_id        INTEGER REFERENCES stories(id),
    user_id         INTEGER,
    action_type     VARCHAR(20),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- API usage tracking
CREATE TABLE IF NOT EXISTS api_usage (
    id          SERIAL PRIMARY KEY,
    usage_date  DATE NOT NULL UNIQUE,
    call_count  INTEGER DEFAULT 0
);

-- Indexes (not strictly needed for perf at this scale, but correct)
CREATE INDEX IF NOT EXISTS idx_articles_story_id ON articles(story_id);
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_source_id ON articles(source_id);
CREATE INDEX IF NOT EXISTS idx_briefs_date ON briefs(brief_date);
CREATE INDEX IF NOT EXISTS idx_timeline_story_id ON timeline_entries(story_id);
CREATE INDEX IF NOT EXISTS idx_timeline_created_at ON timeline_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_follows_story_id ON follows(story_id);
CREATE INDEX IF NOT EXISTS idx_chat_threads_story_id ON chat_threads(story_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id ON chat_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_interactions_story_id ON interactions(story_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_date ON api_usage(usage_date);
