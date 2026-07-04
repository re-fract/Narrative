import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getFollowUpdates, deleteFollow, markStorySeen } from '../api/client'
import type { FollowedStoryFeed, FollowedStoryArticle } from '../api/client'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeAgo(dateStr: string): string {
  const now = new Date()
  const then = new Date(dateStr)
  const diffMs = now.getTime() - then.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

function groupArticlesByDate(
  articles: FollowedStoryArticle[],
): { label: string; items: FollowedStoryArticle[] }[] {
  const groups: { label: string; items: FollowedStoryArticle[] }[] = []
  let currentLabel = ''
  for (const article of articles) {
    const dateLabel = article.published_at
      ? new Date(article.published_at).toLocaleDateString('en-GB', {
          weekday: 'short',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : 'Unknown Date'
    if (dateLabel !== currentLabel) {
      currentLabel = dateLabel
      groups.push({ label: dateLabel, items: [] })
    }
    groups[groups.length - 1].items.push(article)
  }
  return groups
}

function parseBullets(summary: string | null | undefined): string[] {
  if (!summary) return []
  return summary
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^[•\-\*]\s*/, ''))
    .filter(l => l.length > 0)
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function SkeletonSidebar() {
  return (
    <div className="flex flex-col gap-stack-sm">
      <div className="h-4 w-24 bg-surface-container-high rounded animate-pulse mb-stack-sm" />
      {[0, 1, 2].map(i => (
        <div key={i} className="h-10 bg-surface-container-high rounded animate-pulse" />
      ))}
    </div>
  )
}

function SkeletonFeed() {
  return (
    <div className="flex flex-col gap-6">
      {[0, 1, 2].map(i => (
        <div key={i} className="border border-outline-variant rounded p-gutter flex flex-col gap-3">
          <div className="h-5 w-48 bg-surface-container-high rounded animate-pulse" />
          <div className="h-4 w-24 bg-surface-container-high rounded animate-pulse" />
          <div className="border-t border-outline-variant pt-3 flex flex-col gap-2">
            {[0, 1].map(j => (
              <div key={j} className="h-10 bg-surface-container-high rounded animate-pulse" />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// Mini article row used inside a story card (All Updates view)
function MiniArticleRow({ article }: { article: FollowedStoryArticle }) {
  return (
    <Link to={`/article/${article.id}`} className="block group">
      <div className="flex items-start gap-3 py-2 border-b border-outline-variant last:border-0 hover:bg-surface-container-low transition-colors rounded px-1">
        <div className="flex-1 min-w-0">
          <p className="font-body-md text-body-md text-on-surface group-hover:text-primary group-hover:underline decoration-1 underline-offset-2 line-clamp-2">
            {article.title}
          </p>
          <p className="font-caption text-caption text-on-surface-variant mt-0.5">
            {formatTimeAgo(article.published_at)}
          </p>
        </div>
        <span className="material-symbols-outlined text-[16px] text-outline-variant group-hover:text-primary mt-0.5 shrink-0">
          chevron_right
        </span>
      </div>
    </Link>
  )
}

// Story card shown in All Updates mode
function StoryCard({
  story,
  onSelect,
  onUnfollow,
}: {
  story: FollowedStoryFeed
  onSelect: (id: number) => void
  onUnfollow: (id: number) => void
}) {
  const recentArticles = story.articles.slice(0, 3)

  return (
    <div className="border border-outline-variant bg-surface rounded p-gutter flex flex-col gap-3 hover:border-primary/40 transition-colors duration-200">
      {/* Story header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-label-caps text-label-caps text-secondary bg-secondary/10 px-2 py-0.5 rounded uppercase">
              {story.storyCategory}
            </span>
            {story.newSinceLastSeen > 0 && (
              <span className="font-caption text-caption text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                {story.newSinceLastSeen} new
              </span>
            )}
          </div>
          <h3 className="font-display text-headline-sm text-primary leading-snug">
            {story.storyTitle}
          </h3>
          <p className="font-caption text-caption text-on-surface-variant mt-1">
            {story.articleCount} articles · Last updated {formatTimeAgo(story.lastUpdatedAt)}
          </p>
        </div>
        {/* Unfollow */}
        <button
          onClick={() => onUnfollow(story.storyId)}
          title="Unfollow"
          className="shrink-0 text-on-surface-variant hover:text-error transition-colors p-1"
        >
          <span className="material-symbols-outlined text-[18px]">bookmark_remove</span>
        </button>
      </div>

      {/* Recent articles */}
      {recentArticles.length > 0 && (
        <div className="border-t border-outline-variant pt-2">
          {recentArticles.map(a => (
            <MiniArticleRow key={a.id} article={a} />
          ))}
        </div>
      )}

      {/* "See full story" link */}
      <button
        onClick={() => onSelect(story.storyId)}
        className="flex items-center gap-1 font-label-md text-label-md text-primary hover:underline mt-1 self-start"
      >
        <span className="material-symbols-outlined text-[16px]">timeline</span>
        See full timeline
      </button>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function FollowingPage() {
  const [stories, setStories] = useState<FollowedStoryFeed[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeStoryId, setActiveStoryId] = useState<number | 'all'>('all')

  const fetchUpdates = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await getFollowUpdates()
      setStories(data.stories)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchUpdates()
  }, [])

  const handleFilterSelect = (storyId: number | 'all') => {
    setActiveStoryId(storyId)
    if (typeof storyId === 'number') {
      markStorySeen(storyId).catch(() => {})
    }
  }

  const handleUnfollow = async (storyId: number) => {
    setStories(prev => prev.filter(s => s.storyId !== storyId))
    if (activeStoryId === storyId) setActiveStoryId('all')
    try {
      await deleteFollow(storyId)
    } catch {
      fetchUpdates()
    }
  }

  // For single-story view: the full deduped timeline grouped by date
  const activeStory = typeof activeStoryId === 'number'
    ? stories.find(s => s.storyId === activeStoryId) ?? null
    : null

  const dateGroups = activeStory ? groupArticlesByDate(activeStory.articles) : []

  return (
    <div className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop py-section-gap grid grid-cols-1 md:grid-cols-12 gap-gutter relative">
      {/* Header */}
      <div className="col-span-1 md:col-span-12 flex justify-between items-end border-b border-outline-variant pb-stack-md mb-stack-lg">
        <div>
          <h1 className="font-display text-display-lg text-primary mb-unit">
            Following
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant">
            Live updates on stories you are actively tracking.
          </p>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="col-span-12 flex flex-col items-center justify-center py-20">
          <p className="text-body-md text-on-surface-variant mb-4">{error}</p>
          <button
            onClick={fetchUpdates}
            className="px-4 py-2 bg-primary text-white rounded hover:opacity-90 transition-opacity"
          >
            Retry
          </button>
        </div>
      )}

      {isLoading && !error && (
        <>
          <aside className="hidden md:block col-span-3">
            <SkeletonSidebar />
          </aside>
          <div className="col-span-1 md:col-span-9">
            <SkeletonFeed />
          </div>
        </>
      )}

      {!isLoading && !error && stories.length === 0 && (
        <div className="col-span-12 flex flex-col items-center justify-center py-24 gap-4 text-center">
          <span className="material-symbols-outlined text-[64px] text-outline-variant">
            bookmark
          </span>
          <h2 className="font-display text-headline-md text-primary">
            Nothing followed yet
          </h2>
          <p className="font-body-lg text-body-lg text-on-surface-variant max-w-md">
            Click <strong>"Follow"</strong> on any article in your Daily Brief to start
            tracking its updates here.
          </p>
          <Link
            to="/"
            className="mt-2 px-6 py-3 border border-primary text-primary font-label-md text-label-md hover:bg-surface-container-low transition-colors duration-200"
          >
            Go to Daily Brief
          </Link>
        </div>
      )}

      {!isLoading && !error && stories.length > 0 && (
        <>
          {/* Left Column: Story Filters */}
          <aside className="hidden md:block col-span-3 relative">
            <div className="sticky top-[100px] flex flex-col gap-stack-sm border-r border-outline-variant pr-gutter h-max">
              <h2 className="font-label-caps text-label-caps text-on-surface-variant mb-stack-sm tracking-wider">
                Tracked Stories
              </h2>

              {/* All Updates filter */}
              <button
                onClick={() => handleFilterSelect('all')}
                className={`flex justify-between items-center w-full p-2 rounded text-left ${
                  activeStoryId === 'all'
                    ? 'bg-surface-container-low border border-outline-variant'
                    : 'hover:bg-surface-container-low border border-transparent hover:border-outline-variant transition-colors'
                } group`}
              >
                <span
                  className={`font-label-md text-label-md ${
                    activeStoryId === 'all'
                      ? 'text-primary font-bold'
                      : 'text-on-surface-variant group-hover:text-primary'
                  }`}
                >
                  All Stories
                </span>
                <span
                  className={`font-caption text-caption text-on-surface-variant px-2 py-0.5 rounded-full ${
                    activeStoryId === 'all'
                      ? 'bg-surface-container-high'
                      : 'bg-surface group-hover:bg-surface-container-high'
                  }`}
                >
                  {stories.length}
                </span>
              </button>

              {/* Per-story filters — sorted newest update first (server already sorts this way) */}
              {stories.map(story => {
                const isActive = activeStoryId === story.storyId
                return (
                  <div key={story.storyId} className="relative group/row">
                    <button
                      onClick={() => handleFilterSelect(story.storyId)}
                      className={`flex justify-between items-center w-full p-2 rounded text-left pr-8 ${
                        isActive
                          ? 'bg-surface-container-low border border-outline-variant'
                          : 'hover:bg-surface-container-low border border-transparent hover:border-outline-variant transition-colors'
                      } group`}
                    >
                      <span
                        className={`font-label-md text-label-md truncate mr-2 ${
                          isActive
                            ? 'text-primary font-bold'
                            : 'text-on-surface-variant group-hover:text-primary'
                        }`}
                        title={story.storyTitle}
                      >
                        {story.storyTitle}
                        {story.newSinceLastSeen > 0 && !isActive && (
                          <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-secondary align-middle" />
                        )}
                      </span>
                      <span
                        className={`font-caption text-caption text-on-surface-variant px-2 py-0.5 rounded-full shrink-0 ${
                          isActive
                            ? 'bg-surface-container-high'
                            : 'bg-surface group-hover:bg-surface-container-high'
                        }`}
                      >
                        {story.articles.length}
                      </span>
                    </button>
                    {/* Unfollow button — appears on hover */}
                    <button
                      onClick={() => handleUnfollow(story.storyId)}
                      title="Unfollow this story"
                      className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 transition-opacity text-on-surface-variant hover:text-error p-1 rounded"
                    >
                      <span className="material-symbols-outlined text-[16px]">bookmark_remove</span>
                    </button>
                  </div>
                )
              })}
            </div>
          </aside>

          {/* Right Column */}
          <div className="col-span-1 md:col-span-9">

            {/* ── ALL STORIES VIEW ── */}
            {activeStoryId === 'all' && (
              <div className="flex flex-col gap-6">
                {stories.map(story => (
                  <StoryCard
                    key={story.storyId}
                    story={story}
                    onSelect={handleFilterSelect}
                    onUnfollow={handleUnfollow}
                  />
                ))}
              </div>
            )}

            {/* ── SINGLE STORY TIMELINE VIEW ── */}
            {activeStoryId !== 'all' && activeStory && (
              <>
                {/* Back button */}
                <button
                  onClick={() => handleFilterSelect('all')}
                  className="flex items-center gap-1 font-label-md text-label-md text-on-surface-variant hover:text-primary mb-stack-lg transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                  All Stories
                </button>

                {/* Story heading */}
                <div className="mb-stack-lg border-b border-outline-variant pb-stack-md">
                  <span className="font-label-caps text-label-caps text-secondary uppercase">
                    {activeStory.storyCategory}
                  </span>
                  <h2 className="font-display text-headline-md text-primary mt-1">
                    {activeStory.storyTitle}
                  </h2>
                  <p className="font-caption text-caption text-on-surface-variant mt-1">
                    {activeStory.articleCount} articles · Last updated {formatTimeAgo(activeStory.lastUpdatedAt)}
                  </p>
                </div>

                {/* Timeline */}
                <div className="relative">
                  <div className="absolute left-0 top-0 bottom-0 w-px bg-outline-variant md:ml-4" />
                  <div className="flex flex-col gap-stack-lg ml-6 md:ml-12 relative z-10 py-4">
                    {dateGroups.length === 0 && (
                      <p className="font-body-md text-body-md text-on-surface-variant">
                        No articles found for this story in the past 14 days.
                      </p>
                    )}

                    {dateGroups.map((group, groupIndex) => (
                      <div
                        key={group.label}
                        className={`relative ${groupIndex > 0 ? 'mt-stack-lg' : ''}`}
                      >
                        {/* Timeline dot */}
                        <div
                          className={`absolute -left-[30px] md:-left-[54px] top-1 z-20 ${
                            groupIndex === 0
                              ? 'w-[11px] h-[11px] bg-background border-2 border-primary rounded-full shadow-[0_0_0_4px_#fdf8f8]'
                              : 'w-[9px] h-[9px] bg-outline-variant rounded-full shadow-[0_0_0_4px_#fdf8f8]'
                          }`}
                        />
                        <h3
                          className={`font-label-caps text-label-caps tracking-widest mb-stack-md uppercase ${
                            groupIndex === 0 ? 'text-primary' : 'text-on-surface-variant'
                          }`}
                        >
                          {group.label}
                        </h3>
                        <div className="flex flex-col gap-stack-md">
                          {group.items.map(article => {
                            const bullets = parseBullets(article.summary)
                            return (
                              <Link
                                key={article.id}
                                to={`/article/${article.id}`}
                                className="block group"
                              >
                                <article className="border bg-surface border-outline-variant p-stack-md hover:bg-surface-container-low transition-colors duration-200">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="font-label-caps text-label-caps text-secondary bg-secondary/10 px-2 py-1 rounded">
                                      {article.llm_category || 'News'}
                                    </span>
                                    <span className="font-caption text-caption text-on-surface-variant">
                                      · {formatTimeAgo(article.published_at)}
                                    </span>
                                  </div>

                                  <h4 className="font-headline-sm text-headline-sm text-primary mb-2 group-hover:underline decoration-1 underline-offset-2">
                                    {article.title}
                                  </h4>

                                  {article.source_name && (
                                    <p className="font-caption text-caption text-on-surface-variant mb-2">
                                      {article.source_name}
                                    </p>
                                  )}

                                  {bullets.length > 0 && (
                                    <div className="border-t border-outline-variant pt-stack-sm mt-stack-sm">
                                      <p className="font-label-caps text-label-caps text-on-surface-variant mb-1 flex items-center gap-1">
                                        <span className="material-symbols-outlined text-[14px] text-secondary">auto_awesome</span>
                                        AI Summary
                                      </p>
                                      <ul className="list-disc list-inside font-body-md text-body-md text-on-surface space-y-1">
                                        {bullets.slice(0, 2).map((b, i) => (
                                          <li key={i}>{b}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </article>
                              </Link>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default FollowingPage
