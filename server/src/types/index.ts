export interface BriefStory {
  id: number;
  title: string;
  summary: string;
  category: string;
  sourceCount: number;
  publishedAt: Date;
}

export interface BriefResponse {
  date: string;
  stories: BriefStory[];
}

export interface ArticleRow {
  id: number;
  story_id: number | null;
  source_id: number;
  url: string;
  title: string;
  body: string | null;
  full_text?: string | null;
  embedding: number[] | null;
  published_at: Date | null;
  fetched_at: Date;
  summary?: string | null;
  normalized_title?: string | null;
  main_genre?: string | null;
  sub_genre?: string | null;
  importance_score?: number | string | null;
  is_low_signal?: boolean | null;
  low_signal_reason?: string | null;
  region_confidence?: number | string | null;
  genre_confidence?: number | string | null;
  representative_rank?: number | string | null;
}

export interface StoryRow {
  id: number;
  title: string | null;
  summary: string | null;
  centroid: number[] | null;
  status: string;
  article_count: number;
  expansion_json: unknown | null;
  expansion_built_at_count: number;
  summary_built_at_count: number;
  first_seen_at: Date;
  last_updated_at: Date;
  main_genre?: string | null;
  sub_genre?: string | null;
  importance_score?: number | string | null;
  source_count?: number;
  representative_article_id?: number | null;
  event_count?: number;
}
