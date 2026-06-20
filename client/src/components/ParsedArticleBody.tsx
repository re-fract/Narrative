import React from 'react'

interface ParsedArticleBodyProps {
  text: string
  source?: string
}

function isBylineBlock(text: string, source?: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 150) return false

  // "By Author Name" pattern
  if (/^by\s+\w+/i.test(trimmed)) return true
  // Starts with author bullets like "BBC News Ireland" or contains role/title
  if (/reporter|correspondent|editor|analyst|writer|staff writer/i.test(trimmed) && trimmed.length < 150) return true
  // Contains the source name (e.g. "BBC News") and is short
  if (source && new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(trimmed)) return true

  // Matches a time ago string: "2 hours ago", "6 June 2025"
  if (/\d+\s+(hour|minute|day|week|month|year)s?\s+ago/i.test(trimmed)) return true
  if (/\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i.test(trimmed)) return true

  return false
}

function stripLeadingBylines(text: string, source?: string): string {
  if (!text) return text
  const blocks = text.split(/\n\n+/).filter((b) => b.trim().length > 0)
  const cleaned: string[] = []
  let skipped = 0
  const maxSkip = 4

  for (const block of blocks) {
    if (skipped >= maxSkip) {
      cleaned.push(block)
      continue
    }
    if (isBylineBlock(block, source)) {
      skipped++
      continue
    }
    cleaned.push(block)
  }

  return cleaned.join('\n\n')
}

export default function ParsedArticleBody({ text, source }: ParsedArticleBodyProps) {
  if (!text) return <p className="text-on-surface-variant">Article content unavailable.</p>

  const cleanText = stripLeadingBylines(text, source)
  const blocks = cleanText.split(/\n\n+/).filter((b) => b.trim().length > 0)

  return (
    <div className="flex flex-col gap-6">
      {blocks.map((block, index) => {
        const trimmed = block.trim()

        // Heading marker from articleScraper.ts
        if (trimmed.startsWith('###HEADING:###')) {
          const headingText = trimmed.replace('###HEADING:###', '').trim()
          return (
            <h2
              key={index}
              className="font-sans text-xl font-extrabold text-on-surface mt-4 mb-2 leading-snug tracking-tight"
            >
              {headingText}
            </h2>
          )
        }

        // Standard paragraph
        return (
          <p
            key={index}
            className="text-lg leading-[1.72] text-on-surface font-serif"
          >
            {trimmed}
          </p>
        )
      })}
    </div>
  )
}
