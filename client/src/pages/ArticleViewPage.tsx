import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { getStory, getStorySimplify } from '../api/client'
import type { StoryResponse } from '../api/client'

function ArticleViewPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<StoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [simplifyOn, setSimplifyOn] = useState(false)
  const [simplifiedText, setSimplifiedText] = useState<string | null>(null)
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

  const handleSimplifyToggle = async (next: boolean) => {
    setSimplifyOn(next)
    if (next && simplifiedText === null && id) {
      try {
        const res = await getStorySimplify(Number(id), 'simple')
        setSimplifiedText(res.text)
      } catch {
        // silently fail — simplified text not available
      }
    }
  }

  const storyDate = story
    ? new Date(story.first_seen_at).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }).toUpperCase()
    : ''

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
              <div
                className="flex items-center gap-3 group cursor-pointer"
                onClick={() => handleSimplifyToggle(!simplifyOn)}
              >
                <span className="font-label-md text-label-md text-primary transition-colors group-hover:text-secondary">
                  Simplify
                </span>
                <button
                  aria-checked={simplifyOn}
                  role="switch"
                  className={`simplify-toggle relative inline-flex h-5 w-10 items-center rounded-full border border-outline-variant transition-colors focus:outline-none ${
                    simplifyOn ? 'bg-secondary border-secondary' : 'bg-surface'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleSimplifyToggle(!simplifyOn)
                  }}
                >
                  <span
                    className={`toggle-thumb inline-block h-3 w-3 rounded-full transition-transform duration-200 ease-in-out ${
                      simplifyOn ? 'translate-x-1 bg-on-primary' : 'translate-x-1 bg-primary'
                    }`}
                    style={{
                      transform: simplifyOn ? 'translateX(1.25rem)' : 'translateX(0.25rem)',
                    }}
                  ></span>
                </button>
              </div>
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
            {simplifyOn && simplifiedText ? (
              <div className="font-body text-body-lg text-on-surface flex flex-col gap-6 leading-relaxed">
                <p>{simplifiedText}</p>
              </div>
            ) : (
              <div className="font-body text-body-lg text-on-surface flex flex-col gap-6 leading-relaxed">
                <p>{story.summary}</p>

                <h2 className="font-display text-headline-md text-primary mt-4 pt-4 border-t border-outline-variant">
                  The Efficiency Paradox
                </h2>
                <p>
                  The architecture of global trade is undergoing a quiet, brutalist redesign. For decades, the flow of goods
                  relied on a sprawling network of human intuition, historical relationships, and localized buffers. Today, that
                  entire paradigm is being overwritten by predictive algorithms engineered to shave milliseconds and
                  micrometers off physical supply routes.
                </p>
                <p>
                  Leading the charge is a consortium of multinational manufacturers who have deployed what they term
                  &ldquo;Autonomous Fulfillment Networks&rdquo; (AFNs). These systems do not merely track inventory; they
                  preemptively route raw materials based on real-time geofencing, weather patterns, and localized economic
                  indicators.
                </p>

                <h2 className="font-display text-headline-md text-primary mt-4 pt-4 border-t border-outline-variant">
                  Systemic Fragility
                </h2>
                <p>
                  However, this hyper-optimization comes with a fragile underbelly. By eliminating the slack in the system—the
                  extra warehouse space, the redundant suppliers—the network becomes highly susceptible to cascading failures.
                  A single miscalculation by the predictive model regarding a minor port strike can now paralyze production
                  lines across three continents simultaneously.
                </p>

                {/* Quote Block */}
                <blockquote className="my-stack-md pl-gutter border-l-2 border-primary py-2 bg-surface-container-low">
                  <p className="font-display text-headline-sm text-primary mb-2">
                    &ldquo;We are building supply chains out of glass. They are flawlessly transparent, incredibly efficient,
                    and highly prone to shattering if struck at the right angle.&rdquo;
                  </p>
                  <footer className="font-label-caps text-label-caps text-on-surface-variant">
                    — Dr. Aris Thorne, Director of Logistics Analysis, Geneva.
                  </footer>
                </blockquote>

                <p>
                  As regulatory bodies scramble to understand the implications of non-human entities dictating the flow of
                  essential goods, the market has already cast its vote. Shares in companies providing the underlying machine
                  learning infrastructure for AFNs surged an average of 14% in early trading. The era of the automated harbor
                  has arrived, whether global infrastructure is ready for it or not.
                </p>
              </div>
            )}

            {/* Footer Actions */}
            <div className="pt-section-gap pb-stack-lg border-t border-outline-variant flex flex-col sm:flex-row gap-4 items-center justify-between">
              <div className="font-caption text-caption text-on-surface-variant">
                Originally published by The Financial Courier.
              </div>
              <button className="px-6 py-3 border border-primary text-primary font-label-md text-label-md hover:bg-surface-container-low transition-colors duration-200">
                Read Original Source
              </button>
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
