import React from 'react'
import TimelineItem from './TimelineItem'
import type { TimelineArticle } from '../api/client'

interface ArticleTimelineProps {
  timelineLoading: boolean
  timelineArticles: TimelineArticle[]
  currentArticleId: number | undefined
}

export default function ArticleTimeline({
  timelineLoading,
  timelineArticles,
  currentArticleId
}: ArticleTimelineProps) {
  if (timelineLoading) {
    return (
      <div className="flex flex-col gap-4 mt-4">
        <h3 className="font-display text-2xl font-bold text-primary mb-2">Timeline</h3>
        <div className="flex items-center gap-2 text-on-surface-variant">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-secondary border-t-transparent"></span>
          <span className="font-body-md text-sm">Loading 14-day history...</span>
        </div>
      </div>
    )
  }

  if (timelineArticles.length === 0) {
    return (
      <div className="flex flex-col gap-4 mt-4">
        <h3 className="font-display text-2xl font-bold text-primary mb-2">Timeline</h3>
        <p className="text-on-surface-variant text-sm font-body-md">No coverage history found for this story yet.</p>
      </div>
    )
  }

  // Group articles by date for clear timeline progression
  const groups: { label: string; articles: typeof timelineArticles }[] = []
  let currentLabel = ''
  for (const article of timelineArticles) {
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
      groups.push({ label: dateLabel, articles: [] })
    }
    groups[groups.length - 1].articles.push(article)
  }

  return (
    <div className="flex flex-col gap-4 mt-4">
      <h3 className="font-display text-2xl font-bold text-primary mb-2">Timeline</h3>
      <div className={`border-l-2 border-outline-variant pl-4 ml-2 flex flex-col gap-2${timelineArticles.length > 3 ? ' max-h-[480px] overflow-y-auto pr-2' : ''}`}>
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-3">
            {/* Date separator */}
            <div className="flex items-center gap-3 pt-3 first:pt-0">
              <div className="w-3 h-3 rounded-full bg-secondary -ml-[1.625rem] border-2 border-surface shrink-0" />
              <span className="font-label-caps text-label-caps text-secondary tracking-wider">
                {group.label}
              </span>
            </div>
            {group.articles.map((timelineArticle) => (
              <TimelineItem
                key={timelineArticle.id}
                articleId={timelineArticle.id}
                isActive={timelineArticle.id === currentArticleId}
                category={timelineArticle.source_name || 'News Source'}
                time={timelineArticle.published_at
                  ? new Date(timelineArticle.published_at).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                  : ''}
                headline={timelineArticle.title}
                description=""
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
