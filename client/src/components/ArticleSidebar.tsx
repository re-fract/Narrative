import { useState } from 'react'

export default function ArticleSidebar() {
  const [chatInput, setChatInput] = useState('')

  return (
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
            I have analyzed the article &ldquo;Placeholder Article Title&rdquo;. What
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
            This is a placeholder AI synthesis of the article.
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
  )
}
