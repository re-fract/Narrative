import { useState, useEffect, useRef } from 'react'
import { postChatMessage } from '../api/client'

interface Message {
  role: 'assistant' | 'user' | 'divider'
  content: string
}

interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

interface Props {
  articleId: number | null
  storyId: number | null
  articleTitle: string
  isOpen: boolean
  onToggle: () => void
}

const MAX_HISTORY_PAIRS = 5 // last 5 Q&A pairs sent to LLM as context

// ── sessionStorage helpers (keyed by storyId) ──────────────────────────────

const storageKey = (storyId: number) => `narrative_chat_story_${storyId}`

function loadSavedMessages(storyId: number): Message[] | null {
  try {
    const raw = sessionStorage.getItem(storageKey(storyId))
    return raw ? (JSON.parse(raw) as Message[]) : null
  } catch {
    return null
  }
}

function persistMessages(storyId: number, messages: Message[]): void {
  try {
    sessionStorage.setItem(storageKey(storyId), JSON.stringify(messages))
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────────────

function welcomeMessage(title: string): Message {
  return {
    role: 'assistant',
    content: title
      ? `I have analyzed **"${title}"** and its full story timeline. What would you like to explore?`
      : 'Ask me anything about this article and the full story timeline.',
  }
}

/** Extract the last MAX_HISTORY_PAIRS Q&A pairs (user+assistant only, skip dividers) */
function buildHistory(messages: Message[]): HistoryMessage[] {
  const chatMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant') as HistoryMessage[]
  return chatMsgs.slice(-(MAX_HISTORY_PAIRS * 2))
}

// ── Component ──────────────────────────────────────────────────────────────

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  )
}

export default function ArticleSidebar({ articleId, storyId, articleTitle, isOpen, onToggle }: Props) {
  const [messages, setMessages] = useState<Message[]>([welcomeMessage(articleTitle)])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const prevStoryIdRef = useRef<number | null>(null)
  const prevArticleIdRef = useRef<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // ── Load / reset history when story or article changes ──────────────────
  useEffect(() => {
    if (storyId === null && articleId === null) return

    const storyChanged = storyId !== prevStoryIdRef.current
    const articleChanged = articleId !== prevArticleIdRef.current

    if (storyChanged) {
      // Different story → try to restore saved session, otherwise start fresh
      if (storyId !== null) {
        const saved = loadSavedMessages(storyId)
        if (saved && saved.length > 0) {
          // Restore saved conversation + add divider so user sees they're back
          setMessages([
            ...saved,
            { role: 'divider', content: articleTitle },
          ])
        } else {
          setMessages([welcomeMessage(articleTitle)])
        }
      } else {
        setMessages([welcomeMessage(articleTitle)])
      }
      setInput('')
      setLoading(false)
    } else if (articleChanged && articleId !== null) {
      // Same story, different article → just insert a context divider
      setMessages(prev => [
        ...prev,
        { role: 'divider', content: articleTitle },
      ])
    }

    prevStoryIdRef.current = storyId
    prevArticleIdRef.current = articleId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId, articleId])

  // ── Persist messages to sessionStorage whenever they change ────────────
  useEffect(() => {
    if (storyId === null) return
    // Don't persist if the only message is the welcome greeting
    if (messages.length === 1 && messages[0].role === 'assistant') return
    persistMessages(storyId, messages)
  }, [messages, storyId])

  // ── Auto-scroll to bottom on new messages ──────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // ── Send message ────────────────────────────────────────────────────────
  const sendMessage = async () => {
    const q = input.trim()
    if (!q || loading || !articleId) return

    // Capture history BEFORE appending the new user message
    const history = buildHistory(messages)

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: q }])
    setLoading(true)

    try {
      const { answer } = await postChatMessage(articleId, storyId, q, history)
      setMessages(prev => [...prev, { role: 'assistant', content: answer }])
    } catch {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: 'Something went wrong. Please try again.' },
      ])
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const QUICK_PROMPTS = [
    'Summarize the key points',
    'What is the financial impact?',
    'Who are the key people involved?',
    'What happened before this?',
  ]

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      {/* Toggle button — floats on right edge when sidebar is closed */}
      {!isOpen && (
        <button
          onClick={onToggle}
          aria-label="Open AI chat"
          className="hidden md:flex fixed right-0 top-1/2 -translate-y-1/2 z-50 flex-col items-center gap-1.5 py-4 px-2 bg-surface-container-low border border-r-0 border-outline-variant text-on-surface-variant hover:text-secondary hover:border-secondary transition-colors duration-200"
        >
          <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
          <span
            className="font-label-caps text-label-caps tracking-widest text-[10px]"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            AI Insights
          </span>
          <span className="material-symbols-outlined text-[14px]">chevron_left</span>
        </button>
      )}

      <aside
        className={`hidden md:flex fixed right-0 top-16 bottom-0 w-80 bg-surface-container-low border-l border-outline-variant flex-col z-40 transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
      {/* Sidebar Header */}
      <header className="shrink-0 flex items-center justify-between gap-1 p-stack-md border-b border-outline-variant">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-headline-sm font-semibold text-primary">AI Insights</h2>
          <span className="font-caption text-caption text-on-surface-variant uppercase tracking-wider">
            Article Analysis
          </span>
        </div>
        <button
          onClick={onToggle}
          aria-label="Close AI chat"
          className="p-1.5 text-on-surface-variant hover:text-primary hover:bg-surface-container transition-colors duration-200"
        >
          <span className="material-symbols-outlined text-[20px]">close</span>
        </button>
      </header>

      {/* Chat Body */}
      <div className="flex-grow flex flex-col gap-3 overflow-y-auto px-stack-md py-stack-md pb-4 overflow-x-hidden">
        {messages.map((msg, i) => {
          // Context divider (article navigation within same story)
          if (msg.role === 'divider') {
            return (
              <div key={i} className="flex items-center gap-2 my-1">
                <div className="flex-1 h-px bg-outline-variant" />
                <span className="font-caption text-[10px] text-on-surface-variant whitespace-nowrap">
                  Now reading
                </span>
                <div className="flex-1 h-px bg-outline-variant" />
              </div>
            )
          }

          // Assistant message
          if (msg.role === 'assistant') {
            return (
              <div
                key={i}
                className="self-start max-w-[95%] text-on-surface p-4 rounded-xl rounded-tl-sm font-body-md text-body-md border border-outline-variant bg-surface"
              >
                <div className="flex items-center gap-2 mb-2 font-label-caps text-label-caps text-secondary">
                  <span className="material-symbols-outlined text-[14px]">auto_awesome</span> Assistant
                </div>
                <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                {/* Quick prompts only on the first message */}
                {i === 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {QUICK_PROMPTS.map(prompt => (
                      <button
                        key={prompt}
                        onClick={() => {
                          setInput(prompt)
                          inputRef.current?.focus()
                        }}
                        disabled={loading || !articleId}
                        className="px-2 py-1 text-xs border border-outline-variant rounded hover:border-secondary hover:text-secondary transition-colors text-on-surface-variant disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          }

          // User message
          return (
            <div
              key={i}
              className="self-end max-w-[85%] bg-surface-container-highest text-on-surface p-3 rounded-xl rounded-tr-sm font-body-md text-body-md shadow-sm"
            >
              {msg.content}
            </div>
          )
        })}

        {/* Typing indicator */}
        {loading && (
          <div className="self-start max-w-[95%] text-on-surface p-4 rounded-xl rounded-tl-sm font-body-md text-body-md border border-outline-variant bg-surface">
            <div className="flex items-center gap-2 mb-2 font-label-caps text-label-caps text-secondary">
              <span className="material-symbols-outlined text-[14px]">auto_awesome</span> Assistant
            </div>
            <TypingDots />
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Chat Input */}
      <div className="shrink-0 pt-stack-sm bg-surface-container-low border-t border-outline-variant mt-auto relative p-stack-md">
        <div className="relative flex items-center bg-surface border border-outline-variant focus-within:border-secondary focus-within:ring-1 focus-within:ring-secondary transition-all">
          <input
            ref={inputRef}
            className="w-full bg-transparent border-none py-3 pl-4 pr-12 font-body-md text-body-md text-on-surface focus:ring-0 focus:outline-none placeholder:text-outline disabled:opacity-50"
            placeholder={articleId ? 'Ask about this article…' : 'Loading article…'}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading || !articleId}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim() || !articleId}
            className="absolute right-2 p-1.5 bg-primary text-on-primary hover:bg-surface-tint transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
          </button>
        </div>
        <div className="text-center mt-2 font-caption text-[10px] text-on-surface-variant">
          Answers based only on this article &amp; its story timeline.
        </div>
      </div>
      </aside>
    </>
  )
}
