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

export interface BriefStory {
  id: number
  title: string
  bullets: string[]
  sourceCount: number
  category: string
  timeAgo: string
}

export interface BriefResponse {
  date: string
  stories: BriefStory[]
}

export interface ArticleItem {
  id: number
  title: string
  url: string
  body: string
  full_text: string | null
  published_at: string
  source_name: string
}

export interface StoryDetail {
  id: number
  title: string
  summary: string
  article_count: number
  first_seen_at: string
  last_updated_at: string
}

export interface StoryResponse {
  story: StoryDetail
  articles: ArticleItem[]
}

export interface ExpansionResponse {
  expansion: { text: string }
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
  summary: string | null
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

export function getStory(id: string | number): Promise<StoryResponse> {
  return apiRequest<StoryResponse>(`/stories/${id}`)
}

export function getStoryExpand(id: string | number): Promise<ExpansionResponse> {
  return apiRequest<ExpansionResponse>(`/stories/${id}/expand`)
}

export function getStorySimplify(id: string | number, level: string): Promise<SimplifyResponse> {
  return apiRequest<SimplifyResponse>(`/stories/${id}/simplify?level=${encodeURIComponent(level)}`)
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
