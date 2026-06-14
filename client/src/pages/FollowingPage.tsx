import TimelineItem from '../components/TimelineItem'

const filters = [
  { label: 'All Updates', count: 24, active: true },
  { label: 'Global Tech Regulation', count: 8 },
  { label: 'European Markets', count: 12 },
  { label: 'Climate Policy Summit', count: 4 },
]

const timelineData = [
  {
    section: 'Today',
    dotStyle: 'today',
    items: [
      {
        category: 'Global Tech Regulation',
        time: '10:42 AM',
        headline:
          'EU Commission announces drafting of new AI liability directives',
        description:
          'Preliminary drafts suggest strict liability for foundation model providers... Implementation timeline expected within Q3.',
        hasActions: true,
      },
      {
        category: 'European Markets',
        time: '08:15 AM',
        headline:
          'ECB signals potential pause in rate hikes amid inflation cooling',
        description:
          'Core inflation drops slightly below 5%, prompting analysts to revise forecasts for the upcoming central bank meeting.',
        hasActions: false,
      },
    ],
  },
  {
    section: 'Yesterday',
    dotStyle: 'older',
    items: [
      {
        category: 'Climate Policy Summit',
        time: '4:30 PM',
        headline: '',
        description:
          "Keynote speakers finalized for next week's summit in Geneva...",
        hasActions: false,
      },
      {
        category: 'Global Tech Regulation',
        time: '11:00 AM',
        headline:
          'Major tech firms form lobbying coalition ahead of legislative votes',
        description:
          'Five of the largest tech companies have pooled resources...',
        hasActions: true,
      },
    ],
  },
]

function FollowingPage() {
  return (
    <div className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop py-section-gap grid grid-cols-1 md:grid-cols-12 gap-gutter relative">
      {/* Header */}
      <div className="col-span-1 md:col-span-12 flex justify-between items-end border-b border-outline-variant pb-stack-md mb-stack-lg">
        <div>
          <h1 className="font-display text-display-lg text-primary mb-unit">
            Following
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant">
            Live updates on stories and topics you are actively tracking.
          </p>
        </div>
        <button className="flex items-center gap-2 border border-primary text-primary px-4 py-2 rounded font-label-md text-label-md hover:bg-surface-container-low transition-colors">
          <span className="material-symbols-outlined text-[18px]">tune</span>
          Manage Topics
        </button>
      </div>

      {/* Left Column: Topic Filters */}
      <aside className="hidden md:block col-span-3 relative">
        <div className="sticky top-[100px] flex flex-col gap-stack-sm border-r border-outline-variant pr-gutter h-max">
          <h2 className="font-label-caps text-label-caps text-on-surface-variant mb-stack-sm tracking-wider">
            Tracked Topics
          </h2>
          {filters.map((filter, index) => {
            const isActive = filter.active ?? false
            return (
              <button
                key={index}
                className={`flex justify-between items-center w-full p-2 rounded text-left ${
                  isActive
                    ? 'bg-surface-container-low border border-outline-variant'
                    : 'hover:bg-surface-container-low border border-transparent hover:border-outline-variant transition-colors'
                } group`}
              >
                <span
                  className={`font-label-md text-label-md ${
                    isActive
                      ? 'text-primary font-bold'
                      : 'text-on-surface-variant group-hover:text-primary'
                  }`}
                >
                  {filter.label}
                </span>
                <span
                  className={`font-caption text-caption text-on-surface-variant px-2 py-0.5 rounded-full ${
                    isActive
                      ? 'bg-surface-container-high'
                      : 'bg-surface group-hover:bg-surface-container-high'
                  }`}
                >
                  {filter.count}
                </span>
              </button>
            )
          })}
        </div>
      </aside>

      {/* Right Column: Timeline */}
      <div className="col-span-1 md:col-span-9 relative">
        <div className="absolute left-0 top-0 bottom-0 w-px bg-outline-variant md:ml-4"></div>
        <div className="flex flex-col gap-stack-lg ml-6 md:ml-12 relative z-10 py-4">
          {timelineData.map((section, sectionIndex) => (
            <div
              key={section.section}
              className={`relative ${sectionIndex > 0 ? 'mt-stack-lg' : ''}`}
            >
              <div
                className={`absolute -left-[30px] md:-left-[54px] top-1 z-20 ${
                  section.dotStyle === 'today'
                    ? 'w-[11px] h-[11px] bg-background border-2 border-primary rounded-full shadow-[0_0_0_4px_#fdf8f8]'
                    : 'w-[9px] h-[9px] bg-outline-variant rounded-full shadow-[0_0_0_4px_#fdf8f8]'
                }`}
              ></div>
              <h3
                className={`font-label-caps text-label-caps tracking-widest mb-stack-md uppercase ${
                  section.dotStyle === 'today'
                    ? 'text-primary'
                    : 'text-on-surface-variant'
                }`}
              >
                {section.section}
              </h3>
              <div className="flex flex-col gap-stack-md">
                {section.items.map((item, index) => (
                  <TimelineItem key={index} {...item} />
                ))}
              </div>
            </div>
          ))}
          <div className="text-center relative z-20 mt-stack-lg">
            <button className="bg-surface border border-outline-variant text-primary px-6 py-2 rounded-full font-label-md text-label-md hover:bg-surface-container-low transition-colors">
              Load Previous Updates
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default FollowingPage
