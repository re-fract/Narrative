interface BriefCardProps {
  category: string;
  timeAgo: string;
  headline: string;
  bullets: string[];
  variant?: 'featured' | 'secondary' | 'tertiary';
}

function BriefCard({
  category,
  timeAgo,
  headline,
  bullets,
  variant = 'tertiary',
}: BriefCardProps) {
  const headlineSize =
    variant === 'featured' ? 'text-headline-md' : 'text-headline-sm'

  return (
    <article className="bg-surface border border-outline-variant rounded p-gutter flex flex-col justify-between group cursor-pointer hover:bg-surface-container-low transition-colors duration-200">
      <div>
        <div className="flex items-center gap-unit mb-stack-md">
          <span className="font-label-caps text-label-caps text-secondary uppercase">
            {category}
          </span>
          <span className="text-outline-variant">•</span>
          <span className="font-caption text-caption text-on-surface-variant">
            {timeAgo}
          </span>
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
