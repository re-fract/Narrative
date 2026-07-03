const API_BASE = '/api'

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, options)
  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(error.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// ─── Types ───

export interface BriefArticle {
  id: number
  title: string
  bullets: string[]
  storyId: number | null
  sourceName: string
  category: string
  timeAgo: string
}

export interface BriefResponse {
  date: string
  articles: BriefArticle[]
}

export interface ArticleItem {
  id: number
  story_id: number | null
  title: string
  url: string
  description: string | null
  content: string | null
  full_text: string | null
  published_at: string
  source_name: string
}

export interface ArticleResponse {
  article: ArticleItem
}

export interface TimelineArticle {
  id: number
  story_id: number
  title: string
  url: string
  published_at: string
  source_name: string
}

export interface TimelineResponse {
  articles: TimelineArticle[]
}

export interface SimplifyResponse {
  text: string
}

export interface FollowItem {
  id: number
  story_id: number
  followed_at: string
  last_seen_at: string
  title: string | null
  article_count: number
  last_updated_at: string
}

export interface FollowsResponse {
  follows: FollowItem[]
}

export interface FollowActionResponse {
  followed: boolean
}

// ─── Endpoints ───

export function getBriefToday(): Promise<BriefResponse> {
  return apiRequest<BriefResponse>('/briefs/today')
}

export function getArticle(id: string | number): Promise<ArticleResponse> {
  return apiRequest<ArticleResponse>(`/articles/${id}`)
}

export function getStoryTimeline(id: string | number, currentArticleId?: number): Promise<TimelineResponse> {
  const params = currentArticleId != null ? `?currentArticleId=${currentArticleId}` : '';
  return apiRequest<TimelineResponse>(`/stories/${id}/timeline${params}`)
}

export function getArticleSimplify(articleId: string | number): Promise<SimplifyResponse> {
  return apiRequest<SimplifyResponse>(`/articles/${articleId}/simplify`)
}

export function getFollows(): Promise<FollowsResponse> {
  return apiRequest<FollowsResponse>('/follows')
}

export function postFollow(id: string | number): Promise<FollowActionResponse> {
  return apiRequest<FollowActionResponse>(`/stories/${id}/follow`, { method: 'POST' })
}

export function deleteFollow(id: string | number): Promise<FollowActionResponse> {
  return apiRequest<FollowActionResponse>(`/stories/${id}/follow`, { method: 'DELETE' })
}
