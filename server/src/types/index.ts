// ── Unified Source API type ──
export type SourceApi = 'webzio' | 'newsdata' | 'worldnews' | 'thenewsapi';

// ── Unified Normalized Article ──
// All 4 API fetchers normalize into this format.
// This is the SINGLE source of truth — fetchers will be refactored to import from here later.
export interface NormalizedArticle {
  // Identity
  externalId:      string | null;
  sourceApi:      SourceApi;
  url:            string;

  // Content
  title:          string;
  description:    string | null;
  content:        string | null;
  imageUrl:       string | null;

  // Attribution
  author:         string | null;
  sourceName:     string | null;
  sourceDomain:   string;

  // Temporal
  publishedAt:    Date;
  fetchedAt:      Date;

  // API Metadata (all optional)
  apiCategory:      string | null;
  apiIptcCategory:  string | null;
  apiSentiment:     number | null;
  apiLanguage:       string | null;
  apiCountry:        string | null;
  apiKeywords:      string[];
  apiEntities:      Array<{ name: string; type: string; sentiment: number | null }>;
  apiSourcePriority: number | null;
  apiRelevanceScore: number | null;
  apiDomainRank:    number | null;
  apiPerformance:   number | null;
  apiSocial:        Record<string, unknown> | null;
  apiDuplicateFlag: boolean | null;

  // Dedup hashes (computed at normalizer level)
  titleHash:         string;
  normalizedUrlHash: string;
  domainTitleHash:   string;

  // Pre-classification enrichment (scrape/lookup) — set by enrichThinArticles()
  fullText?:         string | null;
}

// ── LLM classification result ──
export interface ClassificationResult {
  tier:      'A' | 'B' | 'C' | 'D';
  category:  'economics' | 'policy' | 'science' | 'accountability' | 'business' | 'none';
  reason:    string;
}

// ── Article with LLM classification applied ──
export interface ScoredArticle extends NormalizedArticle {
  llmTier:       'A' | 'B' | 'C' | 'D';
  llmCategory:   string;
  llmReason:     string;
  filterStatus:  'accepted' | 'rejected' | 'filtered';
}

// ── Region classification ──
export type RegionGenre = 'india' | 'global';

// ── Filter rejection ──
export interface FilterRejection {
  url:            string;
  title:          string | null;
  sourceApi:      SourceApi;
  sourceDomain:   string;
  rejectionStage: 'filter' | 'llm';
  rejectionRule:  string;
  llmTier?:       'C' | 'D';
  llmCategory?:   string;
  llmReason?:     string;
  contextLen?:    number;
}

// ── Database row types ──

export interface ArticleRow {
  id:                  number;
  external_id:         string | null;
  source_api:          SourceApi;
  url:                 string;
  title_hash:          string;
  normalized_url_hash:  string | null;
  domain_title_hash:    string | null;
  title:               string;
  description:         string | null;
  content:             string | null;
  full_text:           string | null;
  summary:             string | null;
  image_url:           string | null;
  author:              string | null;
  source_name:          string | null;
  source_domain:        string;
  story_id:            number | null;
  importance_score:     number | null;
  main_genre:          RegionGenre | null;
  homepage_eligible:   boolean;
  scrape_status:       'pending' | 'lookup' | 'failed' | 'thin' | 'full';
  // LLM classification
  llm_tier:            'A' | 'B' | 'C' | 'D' | null;
  llm_category:        string | null;
  llm_reason:          string | null;
  llm_scored_at:       Date | null;
  llm_model:           string | null;
  // Embedding
  embedding:           number[] | null;
  // API metadata
  api_category:         string | null;
  api_iptc_category:    string | null;
  api_sentiment:       number | null;
  api_language:         string | null;
  api_country:          string | null;
  api_keywords:        string[] | null;
  api_entities:        unknown | null;  // JSONB array
  api_source_priority: number | null;
  api_relevance_score: number | null;
  api_domain_rank:     number | null;
  api_performance:     number | null;
  api_social:          unknown | null;  // JSONB object
  api_duplicate_flag:  boolean | null;
  // Pipeline status
  filter_status:       'accepted' | 'rejected' | 'filtered';
  rejection_reason:    string | null;
  is_duplicate:        boolean;
  duplicate_of_id:     number | null;
  // Temporal
  published_at:        Date | null;
  fetched_at:          Date;
  created_at:          Date;
}

export interface StoryRow {
  id:                       number;
  title:                    string | null;
  centroid:                 number[] | null;
  status:                   string;
  article_count:            number;
  first_seen_at:            Date;
  last_updated_at:          Date;
  frozen_at:                Date | null;
  keyword_set:              string[] | null;
  canonical_embedding:      number[] | null;
  main_genre:               RegionGenre | null;
  llm_category:             string | null;
  importance_score:          number | null;
  source_count:             number;
  representative_article_id: number | null;
}

// ── Brief types ──

export interface BriefStory {
  id: number;
  title: string;
  category: string;
  sourceCount: number;
  publishedAt: Date;
}

export interface BriefResponse {
  date: string;
  articles: BriefArticle[];
}

export interface BriefArticle {
  id: number;
  title: string;
  bullets: string[];
  storyId: number | null;
  sourceName: string;
  category: string;
  timeAgo: string;
}

export interface ScoredStory {
  id: number;
  title: string | null;
  main_genre: string | null;
  llm_category: string | null;
  importance_score: number;
  article_count: number;
  source_count: number;
  representative_article_id: number | null;
}
