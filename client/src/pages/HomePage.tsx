import { Link } from 'react-router-dom'
import BriefCard from '../components/BriefCard'

const stories = [
  {
    id: '1',
    category: 'Global Markets',
    timeAgo: '2 hours ago',
    headline:
      'Tech Stocks Rally Amidst Regulatory Clarity in European Markets',
    bullets: [
      'European regulators finalized the new framework for AI deployment, reducing uncertainty for major tech firms.',
      'Equities in the sector saw a 4% average increase in early trading, led by semiconductor manufacturers.',
      'Analysts predict sustained growth if upcoming US CPI data aligns with expectations next week.',
    ],
    variant: 'featured' as const,
  },
  {
    id: '2',
    category: 'Science',
    timeAgo: '4 hours ago',
    headline: 'Breakthrough in Solid-State Battery Density Announced',
    bullets: [
      'Researchers achieved a 30% increase in energy density without compromising safety.',
      'Commercial applications for EVs expected by 2027.',
    ],
    variant: 'secondary' as const,
  },
  {
    id: '3',
    category: 'Politics',
    timeAgo: '6 hours ago',
    headline: 'Bipartisan Infrastructure Bill Passes Senate Committee',
    bullets: [
      'Focuses on grid modernization and broadband expansion.',
      'Faces a tough floor vote expected late next month.',
    ],
    variant: 'tertiary' as const,
  },
  {
    id: '4',
    category: 'Culture',
    timeAgo: '8 hours ago',
    headline:
      'The Resurgence of Minimalist Architecture in Urban Centers',
    bullets: [
      'New developments favor brutalist elements and natural light.',
      'Shift driven by sustainability mandates and material costs.',
    ],
    variant: 'tertiary' as const,
  },
  {
    id: '5',
    category: 'Technology',
    timeAgo: '10 hours ago',
    headline:
      'OpenAI Announces New Multimodal Model with Enhanced Reasoning',
    bullets: [
      'The model demonstrates significant improvements in complex problem-solving tasks.',
      'Integration with existing developer APIs is planned for next quarter.',
    ],
    variant: 'tertiary' as const,
  },
]

function HomePage() {
  const [featured, secondary, ...tertiary] = stories

  return (
    <div className="max-w-container-max mx-auto px-margin-mobile md:px-margin-desktop py-stack-lg">
      <header className="mb-section-gap border-b border-outline-variant pb-stack-lg">
        <h1 className="font-display text-display-lg md:text-display-lg text-primary">
          Good Morning, User
        </h1>
        <p className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">
          Thursday, October 24, 2024 · Your Curated Feed
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-gutter">
        {/* Featured */}
        <div className="md:col-span-8">
          <Link to={`/article/${featured.id}`} className="block">
            <BriefCard
              category={featured.category}
              timeAgo={featured.timeAgo}
              headline={featured.headline}
              bullets={featured.bullets}
              variant="featured"
            />
          </Link>
        </div>
        {/* Secondary */}
        <div className="md:col-span-4">
          <Link to={`/article/${secondary.id}`} className="block">
            <BriefCard
              category={secondary.category}
              timeAgo={secondary.timeAgo}
              headline={secondary.headline}
              bullets={secondary.bullets}
              variant="secondary"
            />
          </Link>
        </div>
        {/* Tertiary */}
        {tertiary.map((story) => (
          <div key={story.id} className="md:col-span-4">
            <Link to={`/article/${story.id}`} className="block">
              <BriefCard
                category={story.category}
                timeAgo={story.timeAgo}
                headline={story.headline}
                bullets={story.bullets}
                variant="tertiary"
              />
            </Link>
          </div>
        ))}
      </div>
    </div>
  )
}

export default HomePage
