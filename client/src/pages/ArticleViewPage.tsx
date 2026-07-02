import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { getArticle, getArticleSimplify, getStoryTimeline } from '../api/client'
import type { ArticleItem, TimelineArticle } from '../api/client'
import SimplifyToggle, { type SimplifyMode } from '../components/SimplifyToggle'
import ParsedArticleBody from '../components/ParsedArticleBody'
import ArticleTimeline from '../components/ArticleTimeline'
import ArticleSidebar from '../components/ArticleSidebar'

function ArticleViewPage() {
  const { id } = useParams<{ id: string }>()
  const activeFetchIdRef = useRef(0)
  const [article, setArticle] = useState<ArticleItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<SimplifyMode>('original')
  const [simplifyCache, setSimplifyCache] = useState<Record<string, string>>({})
  const [simplifyLoading, setSimplifyLoading] = useState(false)
  const [simplifyError, setSimplifyError] = useState<string | null>(null)
  const [timelineArticles, setTimelineArticles] = useState<TimelineArticle[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [resolvedStoryId, setResolvedStoryId] = useState<number | null>(null)

  const fetchTimeline = async (storyId: number, fetchId: number) => {
    setTimelineLoading(true)
    try {
      // Artificial delay to prevent UI flickering and make the transition feel smoother
      await new Promise(resolve => setTimeout(resolve, 400))
      
      const res = await getStoryTimeline(storyId)
      if (fetchId !== activeFetchIdRef.current) return
      // Sort newest first — backend returns oldest→newest
      const sorted = res.articles
        .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
      setTimelineArticles(sorted)
    } catch {
      // silently fail — timeline is non-critical
    } finally {
      if (fetchId === activeFetchIdRef.current) {
        setTimelineLoading(false)
      }
    }
  }

  const fetchArticle = async () => {
    if (!id) {
      setError('Failed to load article')
      setLoading(false)
      return
    }
    const fetchId = ++activeFetchIdRef.current
    setLoading(true)
    setTimelineLoading(true)
    setError(null)
    try {
      // Artificial delay to prevent UI flickering when navigating between timeline items
      await new Promise(resolve => setTimeout(resolve, 500))

      const res = await getArticle(Number(id))
      if (fetchId !== activeFetchIdRef.current) return

      setArticle(res.article)
      setResolvedStoryId(res.article.story_id)

      if (res.article.story_id) {
        fetchTimeline(res.article.story_id, fetchId)
      } else {
        setTimelineArticles([])
        setTimelineLoading(false)
      }

    } catch {
      if (fetchId !== activeFetchIdRef.current) return
      setError('Failed to load article')
    } finally {
      if (fetchId === activeFetchIdRef.current) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    // Reset all reading-mode state on navigation so the new story always
    // opens in 'original' mode with a clean simplify cache.
    // Without this, mode stays 'simple' and the stale cache blocks re-fetching.
    setMode('original')
    setSimplifyCache({})
    setSimplifyError(null)
    setArticle(null)
    setTimelineArticles([])
    setResolvedStoryId(null)
    fetchArticle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const handleModeChange = async (nextMode: SimplifyMode) => {
    setMode(nextMode)

    if (nextMode === 'original') {
      setSimplifyError(null)
      return
    }

    if (simplifyCache['simple'] || !id) {
      setSimplifyError(null)
      return
    }

    setSimplifyLoading(true)
    setSimplifyError(null)
    try {
      const articleIdForSimplify = article?.id
      const res = await getArticleSimplify(articleIdForSimplify)
      setSimplifyCache((prev) => ({ ...prev, simple: res.text }))
    } catch {
      setSimplifyError('Failed to load simplified version')
    } finally {
      setSimplifyLoading(false)
    }
  }

  const articleDate = article?.published_at
    ? new Date(article.published_at).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).toUpperCase()
    : ''

  const displayText = mode === 'original' ? null : simplifyCache['simple'] ?? null

  return (
    <div className="flex-grow flex w-full relative">
      <main className="flex-grow w-full md:pr-80 max-w-container-max mx-auto">
        {loading ? (
          <div className="px-margin-mobile md:px-margin-desktop py-section-gap max-w-3xl mx-auto flex flex-col gap-stack-lg">
            <div className="flex items-center justify-between border-b border-outline-variant pb-stack-sm">
              <div className="animate-pulse bg-surface-container h-4 w-48 rounded"></div>
              <div className="animate-pulse bg-surface-container h-5 w-20 rounded"></div>
            </div>
            <div className="animate-pulse bg-surface-container h-10 w-full rounded"></div>
            <div className="animate-pulse bg-surface-container h-6 w-3/4 rounded"></div>
            <div className="animate-pulse bg-surface-container aspect-[16/9] w-full rounded"></div>
            <div className="flex flex-col gap-4">
              <div className="animate-pulse bg-surface-container h-4 w-full rounded"></div>
              <div className="animate-pulse bg-surface-container h-4 w-full rounded"></div>
              <div className="animate-pulse bg-surface-container h-4 w-5/6 rounded"></div>
            </div>
            <div className="animate-pulse bg-surface-container h-10 w-48 rounded"></div>
          </div>
        ) : error || !article ? (
          <div className="px-margin-mobile md:px-margin-desktop py-section-gap max-w-3xl mx-auto flex flex-col gap-stack-lg items-center justify-center min-h-[50vh]">
            <p className="font-body-lg text-body-lg text-on-surface">Failed to load article</p>
            <button
              onClick={fetchArticle}
              className="px-6 py-3 border border-primary text-primary font-label-md text-label-md hover:bg-surface-container-low transition-colors duration-200"
            >
              Retry
            </button>
          </div>
        ) : (
          <article className="px-margin-mobile md:px-margin-desktop py-section-gap max-w-3xl mx-auto flex flex-col gap-stack-lg">
            {/* Meta + Simplify Toggle */}
            <div className="flex items-center justify-between border-b border-outline-variant pb-stack-sm">
              <div className="flex items-center gap-3 font-label-caps text-label-caps text-on-surface-variant tracking-widest">
                <span>BUSINESS &amp; MARKETS</span>
                <span className="w-1 h-1 bg-outline-variant rounded-full"></span>
                <span>{articleDate}</span>
              </div>
              <SimplifyToggle mode={mode} onChange={handleModeChange} />
            </div>

            {/* Headline + Byline */}
            <header className="flex flex-col gap-2">
              <h1 className="font-display text-3xl md:text-4xl lg:text-5xl font-black leading-tight text-primary">
                {article.title}
              </h1>
              <div className="flex items-center gap-2 font-body-sm text-body-sm text-on-surface-variant">
                <time dateTime={article.published_at}>
                  {new Date(article.published_at).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}{' '}
                  {new Date(article.published_at).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </div>
            </header>

            {/* News History Timeline */}
            <ArticleTimeline 
              timelineLoading={timelineLoading} 
              timelineArticles={timelineArticles} 
              currentArticleId={article.id} 
            />

            {/* Divider between timeline and article body */}
            <div className="flex items-center gap-3 border-t border-outline-variant pt-6">
              <span className="font-label-caps text-label-caps text-on-surface-variant tracking-widest">Article</span>
              <div className="flex-1 h-px bg-outline-variant" />
            </div>

            {/* Article Body */}
            {mode !== 'original' && simplifyError && (
              <div className="font-body text-body-lg text-on-surface flex flex-col gap-4 leading-relaxed">
                <p className="text-error">{simplifyError}</p>
              </div>
            )}
            {mode !== 'original' && simplifyLoading && (
              <div className="font-body text-body-lg text-on-surface flex flex-col gap-6 leading-relaxed">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-secondary border-t-transparent"></span>
                  <span className="font-body-md text-on-surface-variant">Loading simplified version...</span>
                </div>
                <div className="animate-pulse bg-surface-container h-4 w-full rounded"></div>
                <div className="animate-pulse bg-surface-container h-4 w-full rounded"></div>
                <div className="animate-pulse bg-surface-container h-4 w-5/6 rounded"></div>
              </div>
            )}
            {mode !== 'original' && displayText ? (
              <ParsedArticleBody text={displayText} />
            ) : null}
            {(mode === 'original' || simplifyError) && (() => {
              const displayArticle = article
              if (!displayArticle) {
                return (
                  <div className="font-body text-body-lg text-on-surface-variant italic">
                    Article content not available.
                  </div>
                )
              }
              return (
                <div className="font-body text-body-lg text-on-surface flex flex-col gap-6 leading-relaxed">
                  <ParsedArticleBody
                    text={displayArticle.full_text || displayArticle.content || displayArticle.description || 'Original article content unavailable.'}
                    source={displayArticle.source_name}
                  />
                </div>
              )
            })()}

            {/* Footer Actions */}
            <div className="pt-section-gap pb-stack-lg border-t border-outline-variant flex flex-col sm:flex-row gap-4 items-center justify-between">
              <div className="font-caption text-caption text-on-surface-variant">
                {article.source_name ?? ''}
              </div>
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="px-6 py-3 border border-primary text-primary font-label-md text-label-md hover:bg-surface-container-low transition-colors duration-200"
              >
                Read Original Source
              </a>
            </div>
          </article>
        )}
      </main>

      {/* AI Chat Sidebar */}
      <ArticleSidebar />
    </div>
  )
}

export default ArticleViewPage
