import { normalizeTitle } from './titleNormalizer.js';

export type MainGenre = 'india' | 'global';
export type SubGenre =
  | 'world-politics'
  | 'politics'
  | 'science-tech'
  | 'business-finance'
  | 'markets'
  | 'economy'
  | 'sports'
  | 'health-climate'
  | 'others';

export interface SourceMetadata {
  name?: string | null;
  feedUrl?: string | null;
  baseUrl?: string | null;
  category?: string | null;
  priority?: number | null;
  countryFocus?: string | null;
  mainGenreHint?: string | null;
  subGenreHint?: string | null;
  editorialType?: string | null;
}

export interface ClassificationResult {
  mainGenre: MainGenre;
  subGenre: SubGenre;
  regionConfidence: number;
  genreConfidence: number;
  regionScores: Record<MainGenre, number>;
  subGenreScores: Record<SubGenre, number>;
}

const INDIA_SIGNALS = [
  'india', 'indian', 'new delhi', 'delhi', 'mumbai', 'bengaluru', 'bangalore',
  'chennai', 'kolkata', 'hyderabad', 'maharashtra', 'karnataka', 'tamil nadu',
  'kerala', 'gujarat', 'punjab', 'uttar pradesh', 'west bengal', 'rbi', 'sebi',
  'lok sabha', 'rajya sabha', 'pmo', 'supreme court of india', 'bjp', 'congress',
  'aap', 'tmc', 'dmk', 'nda', 'india bloc',
];

const GLOBAL_SIGNALS = [
  'nato', 'un ', 'united nations', 'eu ', 'european union', 'g7', 'g20',
  'white house', 'kremlin', 'pentagon', 'china', 'russia', 'ukraine', 'israel',
  'iran', 'gaza', 'united states', 'us ', 'u s ', 'uk ', 'france', 'germany',
  'japan', 'pakistan', 'bangladesh', 'sri lanka', 'sanctions', 'ceasefire',
  'invasion', 'summit', 'foreign ministry',
];

const SUB_GENRE_KEYWORDS: Record<SubGenre, string[]> = {
  'world-politics': [
    'diplomacy', 'foreign policy', 'sanctions', 'military', 'border conflict',
    'war', 'ceasefire', 'summit', 'nato', 'united nations', 'geopolitical',
    'embassy', 'foreign minister', 'missile', 'troops',
  ],
  politics: [
    'election', 'cabinet', 'parliament', 'ministry', 'minister', 'party',
    'chief minister', 'legislation', 'governance', 'lawmakers', 'vote',
    'campaign', 'government',
  ],
  'science-tech': [
    ' ai ', 'artificial intelligence', 'chip', 'semiconductor', 'software',
    'platform', 'internet', 'cloud', 'biotech', 'research', 'science',
    'laboratory', 'space', 'startup', 'app', 'cyber',
  ],
  'business-finance': [
    'earnings', 'funding', 'startup', 'acquisition', 'merger', 'banking',
    'company', 'layoffs', 'investment', 'revenue', 'profit', 'ipo', 'stake',
  ],
  markets: [
    'stocks', 'shares', 'sensex', 'nifty', 'nasdaq', 'dow', 'bond yield',
    'rupee', 'dollar', 'commodities', 'crude', 'oil prices', 'index',
  ],
  economy: [
    'inflation', 'gdp', 'unemployment', 'labor', 'trade deficit',
    'fiscal deficit', 'interest rates', 'central bank', 'monetary policy',
    'economic growth', 'tariff', 'exports', 'imports',
  ],
  sports: [
    'match', 'tournament', 'league', 'player', 'team', 'score',
    'championship', 'cricket', 'football', 'tennis', 'ipl', 'world cup',
  ],
  'health-climate': [
    'disease', 'outbreak', 'healthcare', 'hospital', 'vaccine', 'heatwave',
    'emissions', 'climate', 'flood', 'cyclone', 'public health', 'wildfire',
  ],
  others: [],
};

const TIE_BREAK: SubGenre[] = [
  'markets',
  'economy',
  'business-finance',
  'world-politics',
  'politics',
  'science-tech',
  'health-climate',
  'sports',
  'others',
];

function countSignals(text: string, signals: string[]): number {
  return signals.reduce((sum, signal) => {
    const escaped = signal.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escaped) return sum;
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    return sum + (text.match(regex)?.length ?? 0);
  }, 0);
}

export function classifyArticle(input: {
  title: string;
  body?: string | null;
  url?: string | null;
  source?: SourceMetadata;
}): ClassificationResult {
  const source = input.source ?? {};
  const text = ` ${normalizeTitle(input.title)} ${normalizeTitle(input.body ?? '')} ${input.url ?? ''} `;
  const regionScores: Record<MainGenre, number> = { india: 0, global: 0 };

  if (source.countryFocus === 'india' || source.mainGenreHint === 'india') regionScores.india += 1.2;
  if (source.countryFocus === 'global' || source.mainGenreHint === 'global') regionScores.global += 0.9;
  if (source.countryFocus === 'mixed') {
    regionScores.india += 0.4;
    regionScores.global += 0.4;
  }

  regionScores.india += countSignals(text, INDIA_SIGNALS) * 1.1;
  regionScores.global += countSignals(text, GLOBAL_SIGNALS) * 1.0;

  const mainGenre: MainGenre = regionScores.india > regionScores.global + 0.6
    ? 'india'
    : regionScores.global > regionScores.india + 0.6
      ? 'global'
      : source.countryFocus === 'india'
        ? 'india'
        : 'global';

  const subGenreScores = Object.fromEntries(
    Object.keys(SUB_GENRE_KEYWORDS).map(key => [key, 0])
  ) as Record<SubGenre, number>;

  if (source.subGenreHint && source.subGenreHint in subGenreScores) {
    subGenreScores[source.subGenreHint as SubGenre] += 0.9;
  }
  for (const [genre, keywords] of Object.entries(SUB_GENRE_KEYWORDS) as [SubGenre, string[]][]) {
    subGenreScores[genre] += countSignals(text, keywords);
  }
  if (mainGenre === 'global' && subGenreScores.politics > 0) {
    subGenreScores['world-politics'] += 0.45;
  }

  let subGenre: SubGenre = 'others';
  let bestScore = 0;
  for (const genre of TIE_BREAK) {
    const score = subGenreScores[genre];
    if (score > bestScore) {
      bestScore = score;
      subGenre = genre;
    }
  }

  const regionGap = Math.abs(regionScores.india - regionScores.global);
  const regionConfidence = Math.max(0.35, Math.min(0.98, 0.45 + regionGap / 5));
  const genreConfidence = bestScore > 0 ? Math.max(0.35, Math.min(0.95, 0.45 + bestScore / 5)) : 0.3;

  return {
    mainGenre,
    subGenre,
    regionConfidence,
    genreConfidence,
    regionScores,
    subGenreScores,
  };
}

export function genrePriorityScore(subGenre: SubGenre): number {
  return ({
    'world-politics': 0.08,
    politics: 0.08,
    economy: 0.07,
    markets: 0.06,
    'business-finance': 0.05,
    'science-tech': 0.05,
    'health-climate': 0.04,
    sports: 0,
    others: 0,
  } satisfies Record<SubGenre, number>)[subGenre];
}
