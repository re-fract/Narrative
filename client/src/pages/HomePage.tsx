import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import BriefCard from '../components/BriefCard'

interface Story {
  id: number
  title: string
  bullets: string[]
  category: string
  timeAgo: string
}

interface ApiResponse {
  date: string
  stories: Story[]
}

function HomePage() {
  const [stories, setStories] = useState<Story[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchStories = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/briefs/today')
      if (!res.ok) {
        throw new Error('Failed to fetch stories')
      }
      const data: ApiResponse = await res.json()
      setStories(data.stories)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchStories()
  }, [])

  const todayStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const featured = stories[0]
  const secondary = stories[1]

  return (
    <div className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop py-stack-lg">
      <header className="mb-section-gap border-b border-outline-variant pb-stack-lg">
        <h1 className="font-display text-display-lg md:text-display-lg text-primary">
          Good Morning, User
        </h1>
        <p className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">
          {todayStr} · Your Curated Feed
        </p>
      </header>

      {error && (
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-body-md text-on-surface-variant mb-4">{error}</p>
          <button
            onClick={fetchStories}
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

      {!isLoading && !error && stories.length === 0 && (
        <div className="flex items-center justify-center py-20">
          <p className="text-body-md text-on-surface-variant">
            No stories today
          </p>
        </div>
      )}

      {!isLoading && !error && stories.length > 0 && (
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
                  />
                </Link>
              </div>
            )}
          </div>
          {/* Tertiary - masonry columns */}
          <div className="columns-1 md:columns-3 gap-gutter">
            {stories.slice(2).map((story) => (
              <div key={story.id} className="break-inside-avoid mb-gutter">
                <Link to={`/article/${story.id}`} className="block">
                  <BriefCard
                    category={story.category}
                    timeAgo={story.timeAgo}
                    headline={story.title}
                    bullets={story.bullets}
                    variant="tertiary"
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
