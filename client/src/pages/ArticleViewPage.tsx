import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { getStory, getStorySimplify } from '../api/client'
import type { StoryResponse } from '../api/client'
import SimplifyToggle, { type SimplifyMode } from '../components/SimplifyToggle'

function ArticleViewPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<StoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<SimplifyMode>('original')
  const [simplifyCache, setSimplifyCache] = useState<Record<string, string>>({})
  const [simplifyLoading, setSimplifyLoading] = useState(false)
  const [simplifyError, setSimplifyError] = useState<string | null>(null)
  const [chatInput, setChatInput] = useState('')

  const story = data?.story
  const articles = data?.articles ?? []

  const fetchStory = async () => {
    if (!id) {
      setError('Failed to load story')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await getStory(Number(id))
      setData(res)
    } catch {
      setError('Failed to load story')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStory()
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
      const res = await getStorySimplify(Number(id), 'simple')
      setSimplifyCache((prev) => ({ ...prev, simple: res.text }))
    } catch {
      setSimplifyError('Failed to load simplified version')
    } finally {
      setSimplifyLoading(false)
    }
  }

  const storyDate = story
    ? new Date(story.first_seen_at).toLocaleDateString('en-US', {
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
        ) : error || !story ? (
          <div className="px-margin-mobile md:px-margin-desktop py-section-gap max-w-3xl mx-auto flex flex-col gap-stack-lg items-center justify-center min-h-[50vh]">
            <p className="font-body-lg text-body-lg text-on-surface">Failed to load story</p>
            <button
              onClick={fetchStory}
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
                <span>{storyDate}</span>
              </div>
              <SimplifyToggle mode={mode} onChange={handleModeChange} />
            </div>

            {/* Headline + Subheadline */}
            <header className="flex flex-col gap-stack-sm">
              <h1 className="font-display text-display-lg-mobile md:text-display-lg text-primary">
                {story.title}
              </h1>
              <p className="font-body-lg text-body-lg text-on-surface-variant italic">
                {story.summary}
              </p>
            </header>

            {/* Articles list below summary */}
            <div className="flex flex-wrap gap-2">
              {articles.map((article) => (
                <a
                  key={article.id}
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-surface-container-low border border-outline-variant rounded-full font-caption text-caption text-on-surface-variant hover:border-secondary hover:text-secondary transition-colors"
                >
                  {article.source_name}
                </a>
              ))}
            </div>

            {/* Hero Image Placeholder */}
            <figure className="w-full relative border border-outline-variant p-1 bg-surface-container-lowest">
              <div className="w-full aspect-[16/9] overflow-hidden bg-surface-container">
                <div className="w-full h-full bg-surface-dim flex items-center justify-center">
                  <span className="material-symbols-outlined text-6xl text-on-surface-variant opacity-20">
                    image
                  </span>
                </div>
              </div>
              <figcaption className="mt-2 font-caption text-caption text-on-surface-variant text-right px-2">
                Automated terminals in Rotterdam reflect the industry&apos;s shift toward absolute precision. (Photo: Agency)
              </figcaption>
            </figure>

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
              <div className="font-body text-body-lg text-on-surface flex flex-col gap-6 leading-relaxed">
                <p>{displayText}</p>
              </div>
            ) : null}
            {(mode === 'original' || simplifyError) && (
              <div className="font-body text-body-lg text-on-surface flex flex-col gap-6 leading-relaxed">
                {articles.map((article) => (
                  <div key={article.id}>
                    {/* Show article title if multiple articles */}
                    {articles.length > 1 && (
                      <h2 className="font-display text-headline-md text-primary mt-4 pt-4 border-t border-outline-variant">
                        {article.title}
                      </h2>
                    )}
                    {/* Article body: prefer full_text, fallback to RSS snippet */}
                    <p className="whitespace-pre-wrap">{article.full_text || article.body || 'Original article content unavailable.'}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Footer Actions */}
            <div className="pt-section-gap pb-stack-lg border-t border-outline-variant flex flex-col sm:flex-row gap-4 items-center justify-between">
              <div className="font-caption text-caption text-on-surface-variant">
                {articles.map(a => a.source_name).filter(Boolean).join(', ')}
              </div>
              <a
                href={articles[0]?.url}
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
      <aside className="hidden md:flex fixed right-0 top-16 bottom-0 w-80 bg-surface-container-low border-l border-outline-variant flex-col z-40">
        {/* Sidebar Header */}
        <header className="mb-stack-md shrink-0 flex flex-col gap-1 p-stack-md border-b border-outline-variant">
          <h2 className="font-display text-headline-sm font-semibold text-primary">AI Insights</h2>
          <span className="font-caption text-caption text-on-surface-variant uppercase tracking-wider">
            Article Analysis
          </span>
        </header>

        {/* Tabs */}
        <nav className="flex items-center gap-2 overflow-x-auto pb-stack-sm border-b border-outline-variant px-stack-md shrink-0 mb-stack-md">
          <button className="flex items-center gap-1.5 px-3 py-1.5 text-on-surface-variant hover:bg-surface-variant rounded transition-all font-label-caps text-label-caps whitespace-nowrap">
            <span className="material-symbols-outlined text-[16px]">info</span> Context
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary-container text-on-secondary-container rounded-lg font-label-caps text-label-caps whitespace-nowrap">
            <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span> Summary
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 text-on-surface-variant hover:bg-surface-variant rounded transition-all font-label-caps text-label-caps whitespace-nowrap">
            <span className="material-symbols-outlined text-[16px]">list_alt</span> Key Facts
          </button>
          <button className="flex items-center gap-1.5 px-3 py-1.5 text-on-surface-variant hover:bg-surface-variant rounded transition-all font-label-caps text-label-caps whitespace-nowrap">
            <span className="material-symbols-outlined text-[16px]">history</span> Timeline
          </button>
        </nav>

        {/* Chat Body */}
        <div className="flex-grow flex flex-col gap-4 overflow-y-auto px-stack-md pb-4 overflow-x-hidden">
          {/* System/AI initial message */}
          <div className="self-start max-w-[95%] text-on-surface p-4 rounded-xl rounded-tl-sm font-body-md text-body-md border border-outline-variant bg-surface">
            <div className="flex items-center gap-2 mb-2 font-label-caps text-label-caps text-secondary">
              <span className="material-symbols-outlined text-[14px]">robot_2</span> Assistant
            </div>
            <p className="mb-2">
              I have analyzed the article &ldquo;{story?.title ?? 'Loading...'}&rdquo;. What
              specific insights would you like to explore?
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              <button className="px-2 py-1 text-xs border border-outline-variant rounded hover:border-secondary hover:text-secondary transition-colors text-on-surface-variant">
                Extract Key Entities
              </button>
              <button className="px-2 py-1 text-xs border border-outline-variant rounded hover:border-secondary hover:text-secondary transition-colors text-on-surface-variant">
                Identify Biases
              </button>
            </div>
          </div>

          {/* User Message */}
          <div className="self-end max-w-[85%] bg-surface-container-highest text-on-surface p-3 rounded-xl rounded-tr-sm font-body-md text-body-md shadow-sm">
            Summarize the financial impact of this story.
          </div>

          {/* AI Response Message */}
          <div className="self-start max-w-[95%] bg-secondary/5 border border-secondary/20 text-on-surface p-4 rounded-xl rounded-tl-sm font-body-md text-body-md">
            <div className="flex items-center gap-2 mb-2 font-label-caps text-label-caps text-secondary">
              <span className="material-symbols-outlined text-[14px]">auto_awesome</span> Synthesis
            </div>
            <p className="mb-2">
              {story?.summary ?? 'Waiting for story data...'}
            </p>
          </div>
        </div>

        {/* Chat Input */}
        <div className="shrink-0 pt-stack-sm bg-surface-container-low border-t border-outline-variant mt-auto relative p-stack-md">
          <div className="relative flex items-center bg-surface border border-outline-variant focus-within:border-secondary focus-within:ring-1 focus-within:ring-secondary transition-all">
            <input
              className="w-full bg-transparent border-none py-3 pl-4 pr-12 font-body-md text-body-md text-on-surface focus:ring-0 focus:outline-none placeholder:text-outline"
              placeholder="Ask AI..."
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
            />
            <button className="absolute right-2 p-1.5 bg-primary text-on-primary hover:bg-surface-tint transition-colors flex items-center justify-center">
              <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
            </button>
          </div>
          <div className="text-center mt-2 font-caption text-[10px] text-on-surface-variant">
            AI can make mistakes. Verify important information.
          </div>
        </div>
      </aside>
    </div>
  )
}

export default ArticleViewPage
