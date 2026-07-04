interface BriefCardProps {
  category: string;
  timeAgo: string;
  headline: string;
  bullets: string[];
  variant?: 'featured' | 'secondary' | 'tertiary';
  // Follow feature
  storyId?: number | null;
  isFollowed?: boolean;
  onToggleFollow?: (storyId: number, currentlyFollowed: boolean) => void;
}

function BriefCard({
  category,
  timeAgo,
  headline,
  bullets,
  variant = 'tertiary',
  storyId,
  isFollowed = false,
  onToggleFollow,
}: BriefCardProps) {
  const headlineSize =
    variant === 'featured' ? 'text-headline-md' : 'text-headline-sm'

  const handleFollowClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (storyId && onToggleFollow) {
      onToggleFollow(storyId, isFollowed)
    }
  }

  return (
    <article className="bg-surface border border-outline-variant rounded p-gutter flex flex-col justify-between group cursor-pointer hover:bg-surface-container-low transition-colors duration-200">
      <div>
        <div className="flex items-center justify-between gap-unit mb-stack-md">
          <div className="flex items-center gap-unit min-w-0 flex-wrap">
            <span className="font-label-caps text-label-caps text-secondary uppercase">
              {category}
            </span>
            <span className="text-outline-variant">•</span>
            <span className="font-caption text-caption text-on-surface-variant">
              {timeAgo}
            </span>
          </div>

          {/* Follow button — top right, only when article has a story */}
          {storyId != null && onToggleFollow && (
            <button
              onClick={handleFollowClick}
              className={`flex items-center gap-1 shrink-0 font-label-md text-label-md transition-colors duration-200 ${
                isFollowed
                  ? 'text-primary'
                  : 'text-on-surface-variant hover:text-primary'
              }`}
              aria-label={isFollowed ? 'Unfollow this story' : 'Follow this story'}
            >
              <span className="material-symbols-outlined text-[18px]">
                {isFollowed ? 'bookmark_added' : 'bookmark_add'}
              </span>
              <span className="hidden sm:inline">
                {isFollowed ? 'Following' : 'Follow'}
              </span>
            </button>
          )}
        </div>
        <h2
          className={`font-display ${headlineSize} text-primary mb-stack-lg group-hover:underline decoration-1 underline-offset-4`}
        >
          {headline}
        </h2>
      </div>
      <div className="border-t border-outline-variant pt-stack-md mt-stack-lg">
        <h3 className="font-label-caps text-label-caps text-on-surface-variant mb-stack-sm flex items-center gap-2">
          <span className="material-symbols-outlined text-[16px] text-secondary">
            auto_awesome
          </span>{' '}
          AI Summary
        </h3>
        <ul className="list-disc list-inside font-body-md text-body-md text-on-surface space-y-unit">
          {bullets.map((bullet, index) => (
            <li key={index}>{bullet}</li>
          ))}
        </ul>
      </div>
    </article>
  )
}

export default BriefCard
