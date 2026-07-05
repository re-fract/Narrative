import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import BriefCard from '../components/BriefCard'
import { getFollows, postFollow, deleteFollow } from '../api/client'
import type { BriefArticle } from '../api/client'

interface ApiResponse {
  date: string
  articles: BriefArticle[]
}

function HomePage() {
  const [articles, setArticles] = useState<BriefArticle[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [followedStoryIds, setFollowedStoryIds] = useState<Set<number>>(new Set())

  const fetchBrief = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/briefs/today')
      if (!res.ok) {
        throw new Error('Failed to fetch brief')
      }
      const data: ApiResponse = await res.json()
      setArticles(data.articles)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setIsLoading(false)
    }
  }

  const fetchFollowState = async () => {
    try {
      const data = await getFollows()
      setFollowedStoryIds(new Set(data.story_ids))
    } catch {
      // Non-critical — follow state just won't show; silently ignore
    }
  }

  useEffect(() => {
    fetchBrief()
    fetchFollowState()
  }, [])

  const handleToggleFollow = useCallback(async (storyId: number, currentlyFollowed: boolean) => {
    // Optimistic update first
    setFollowedStoryIds(prev => {
      const next = new Set(prev)
      if (currentlyFollowed) {
        next.delete(storyId)
      } else {
        next.add(storyId)
      }
      return next
    })

    try {
      if (currentlyFollowed) {
        await deleteFollow(storyId)
      } else {
        await postFollow(storyId)
      }
    } catch {
      // Rollback the optimistic update on failure
      setFollowedStoryIds(prev => {
        const next = new Set(prev)
        if (currentlyFollowed) {
          next.add(storyId)
        } else {
          next.delete(storyId)
        }
        return next
      })
    }
  }, [])

  const todayStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const featured = articles[0]
  const secondary = articles[1]

  return (
    <div className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop py-stack-lg">
      <header className="mb-section-gap border-b border-outline-variant pb-stack-lg">
        <h1 className="font-display text-[40px] leading-[1.1] text-primary -ml-0.5">
          Good Morning
        </h1>
        <p className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest mt-2">
          {todayStr}
        </p>
      </header>

      {error && (
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-body-md text-on-surface-variant mb-4">{error}</p>
          <button
            onClick={fetchBrief}
            className="px-4 py-2 bg-primary text-white rounded hover:opacity-90 transition-opacity"
          >
            Retry
          </button>
        </div>
      )}

      {isLoading && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-gutter mb-gutter">
            <div className="md:col-span-8">
              <div className="rounded bg-surface-container-high animate-pulse h-96" />
            </div>
            <div className="md:col-span-4">
              <div className="rounded bg-surface-container-high animate-pulse h-96" />
            </div>
          </div>
          <div className="columns-1 md:columns-3 gap-gutter">
            {[0, 1, 2].map((i) => (
              <div key={i} className="break-inside-avoid mb-gutter">
                <div className="rounded bg-surface-container-high animate-pulse h-64" />
              </div>
            ))}
          </div>
        </>
      )}

      {!isLoading && !error && articles.length === 0 && (
        <div className="flex items-center justify-center py-20">
          <p className="text-body-md text-on-surface-variant">
            No articles today
          </p>
        </div>
      )}

      {!isLoading && !error && articles.length > 0 && (
        <>
          {/* Featured + Secondary */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-gutter mb-gutter">
            {featured && (
              <div className="md:col-span-8">
                <Link to={`/article/${featured.id}`} className="block">
                  <BriefCard
                    category={featured.category}
                    timeAgo={featured.timeAgo}
                    headline={featured.title}
                    bullets={featured.bullets}
                    variant="featured"
                    storyId={featured.storyId}
                    isFollowed={featured.storyId != null && followedStoryIds.has(featured.storyId)}
                    onToggleFollow={handleToggleFollow}
                  />
                </Link>
              </div>
            )}
            {secondary && (
              <div className="md:col-span-4">
                <Link to={`/article/${secondary.id}`} className="block">
                  <BriefCard
                    category={secondary.category}
                    timeAgo={secondary.timeAgo}
                    headline={secondary.title}
                    bullets={secondary.bullets}
                    variant="secondary"
                    storyId={secondary.storyId}
                    isFollowed={secondary.storyId != null && followedStoryIds.has(secondary.storyId)}
                    onToggleFollow={handleToggleFollow}
                  />
                </Link>
              </div>
            )}
          </div>
          {/* Tertiary - masonry columns */}
          <div className="columns-1 md:columns-3 gap-gutter">
            {articles.slice(2).map((article) => (
              <div key={article.id} className="break-inside-avoid mb-gutter">
                <Link to={`/article/${article.id}`} className="block">
                  <BriefCard
                    category={article.category}
                    timeAgo={article.timeAgo}
                    headline={article.title}
                    bullets={article.bullets}
                    variant="tertiary"
                    storyId={article.storyId}
                    isFollowed={article.storyId != null && followedStoryIds.has(article.storyId)}
                    onToggleFollow={handleToggleFollow}
                  />
                </Link>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default HomePage
