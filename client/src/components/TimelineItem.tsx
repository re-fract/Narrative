import { Link } from 'react-router-dom';

interface TimelineItemProps {
  category: string;
  time: string;
  headline: string;
  description: string;
  hasActions?: boolean;
  articleId?: number;
  isActive?: boolean;
}

export default function TimelineItem({
  category,
  time,
  headline,
  description,
  hasActions,
  articleId,
  isActive,
}: TimelineItemProps) {
  const content = (
    <article
      className={`border p-stack-md transition-colors duration-200 group relative ${
        isActive
          ? 'bg-secondary/5 border-secondary/40 border-l-4 border-l-secondary'
          : 'bg-surface border-outline-variant hover:bg-surface-container-low'
      }`}
    >
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center gap-2">
          <span className="font-label-caps text-label-caps text-secondary bg-secondary/10 px-2 py-1 rounded">
            {category}
          </span>
          <span className="font-caption text-caption text-on-surface-variant">
            &bull; {time}
          </span>
          {isActive && (
            <span className="font-label-caps text-label-caps text-secondary bg-secondary/20 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider">
              You are here
            </span>
          )}
        </div>
        <button
          aria-label="Bookmark"
          className="text-on-surface-variant hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity z-10"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="material-symbols-outlined text-[20px]">bookmark</span>
        </button>
      </div>

      {headline && (
        <h4 className="font-headline-sm text-headline-sm text-primary mb-2">
          {headline}
        </h4>
      )}

      <p
        className={`font-body-md text-body-md text-on-surface-variant ${hasActions ? 'mb-4' : ''
          }`}
      >
        {description}
      </p>

      {hasActions && (
        <div className="flex items-center gap-3">
          <button className="font-label-md text-label-md text-secondary hover:underline flex items-center gap-1">
            <span className="material-symbols-outlined text-[16px]">article</span>
            Read Full Brief
          </button>
          <button className="font-label-md text-label-md text-on-surface-variant hover:text-primary flex items-center gap-1">
            <span className="material-symbols-outlined text-[16px]">
              auto_awesome
            </span>
            Summarize Update
          </button>
        </div>
      )}
    </article>
  );

  if (articleId) {
    return (
      <Link to={`/article/${articleId}`} className="block">
        {content}
      </Link>
    );
  }

  return content;
}
