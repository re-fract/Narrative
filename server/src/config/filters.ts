// ── URL Path Pattern types ──

export interface UrlPathPattern {
  pattern: RegExp;
  reason: string;
}

export interface TitlePattern {
  name: string;
  pattern: RegExp;
  additionalCheck?: (title: string) => boolean;
}

export interface TemplatePattern {
  name: string;
  pattern: RegExp;
}

// ── F5: URL Path Rejection ──

export const REJECT_URL_PATHS: UrlPathPattern[] = [
  // ── SPORTS ──
  { pattern: /\/sports?\//i,             reason: 'url_path_sports' },
  { pattern: /\/cricket\//i,             reason: 'url_path_sports' },
  { pattern: /\/football\//i,            reason: 'url_path_sports' },
  { pattern: /\/soccer\//i,              reason: 'url_path_sports' },
  { pattern: /\/tennis\//i,              reason: 'url_path_sports' },
  { pattern: /\/nba\//i,                 reason: 'url_path_sports' },
  { pattern: /\/nfl\//i,                 reason: 'url_path_sports' },
  { pattern: /\/ipl\//i,                 reason: 'url_path_sports' },
  { pattern: /\/formula-?1\//i,          reason: 'url_path_sports' },
  { pattern: /\/premier-league\//i,      reason: 'url_path_sports' },

  // ── ENTERTAINMENT ──
  { pattern: /\/entertainment\//i,       reason: 'url_path_entertainment' },
  { pattern: /\/celebrity\//i,           reason: 'url_path_entertainment' },
  { pattern: /\/gossip\//i,              reason: 'url_path_entertainment' },
  { pattern: /\/movies?\//i,             reason: 'url_path_entertainment' },
  { pattern: /\/tv-?shows?\//i,          reason: 'url_path_entertainment' },
  { pattern: /\/bollywood\//i,           reason: 'url_path_entertainment' },
  { pattern: /\/hollywood\//i,           reason: 'url_path_entertainment' },
  { pattern: /\/music\//i,              reason: 'url_path_entertainment' },

  // ── LIFESTYLE ──
  { pattern: /\/lifestyle\//i,           reason: 'url_path_lifestyle' },
  { pattern: /\/fashion\//i,             reason: 'url_path_lifestyle' },
  { pattern: /\/beauty\//i,              reason: 'url_path_lifestyle' },
  { pattern: /\/food(?:-and-drink)?\//i, reason: 'url_path_lifestyle' },
  { pattern: /\/recipes?\//i,            reason: 'url_path_lifestyle' },
  { pattern: /\/travel\//i,              reason: 'url_path_lifestyle' },
  { pattern: /\/shopping\//i,            reason: 'url_path_lifestyle' },
  { pattern: /\/wellness\//i,            reason: 'url_path_lifestyle' },
  { pattern: /\/fitness\//i,             reason: 'url_path_lifestyle' },
  { pattern: /\/style\//i,              reason: 'url_path_lifestyle' },
  { pattern: /\/dining\//i,             reason: 'url_path_lifestyle' },

  // ── NON-ARTICLE CONTENT ──
  { pattern: /\/horoscope/i,             reason: 'url_path_horoscope' },
  { pattern: /\/astrology/i,             reason: 'url_path_astrology' },
  { pattern: /\/puzzles?\//i,            reason: 'url_path_puzzle' },
  { pattern: /\/crossword/i,             reason: 'url_path_puzzle' },
  { pattern: /\/sudoku/i,               reason: 'url_path_puzzle' },
  { pattern: /\/games?\//i,              reason: 'url_path_games' },
  { pattern: /\/obituar/i,              reason: 'url_path_obituary' },
  { pattern: /\/comics?\//i,            reason: 'url_path_comic' },
  { pattern: /\/photo-?galler/i,         reason: 'url_path_gallery' },
  { pattern: /\/slideshows?\//i,         reason: 'url_path_slideshow' },
];

// ── F6: Title Pattern Rejection ──

export const REJECT_TITLE_PATTERNS: TitlePattern[] = [

  // ── SPORTS SCORES / RESULTS ──
  // Pattern: "Team X [number]-[number] Team Y" or "X beats Y by N wickets"
  {
    name: 'sports_score',
    pattern: /\b\d+\s*[-–—]\s*\d+\b/,
    // Matches: "India 3-1 Pakistan", "Mumbai Indians 186-4"
    // Additional check: must ALSO contain a sports term
    additionalCheck: (title) => /\b(?:win|won|beat|defeat|draw|wicket|goal|set|match|runs?|points?|score|innings|quarter|half-?time|over|boundary)\b/i.test(title),
  },
  {
    name: 'sports_vs',
    pattern: /\bvs\.?\s/i,
    // Matches: "India vs Australia", "Mumbai vs Chennai"
    // Requires sports context to avoid false positives on legal cases ("State vs Defendant")
    additionalCheck: (title) => !/\b(?:court|case|ruling|verdict|lawsuit|appeal|trial|plaintiff|defendant)\b/i.test(title),
  },
  {
    name: 'sports_matchday',
    pattern: /\b(?:matchday|gameweek|round \d+|leg \d+|semi-?final|quarter-?final|group stage)\b/i,
  },

  // ── LISTICLES / CLICKBAIT ──
  {
    name: 'listicle',
    pattern: /^\d+\s+(?:best|worst|top|amazing|incredible|surprising|shocking|ways|things|reasons|tips|tricks|secrets|hacks|facts|signs|rules)\b/i,
    // Matches: "10 best restaurants", "7 shocking facts"
    // Does NOT match: "2 killed in accident" (starts with number but no listicle word)
  },
  {
    name: 'clickbait_curiosity',
    pattern: /\b(?:you won'?t believe|jaw.?dropping|mind.?blowing|will blow your mind|left speechless|internet is losing)\b/i,
  },
  {
    name: 'clickbait_reaction',
    pattern: /\b(?:claps? back|slams?|destroys?|absolutely (?:destroyed|crushed)|epic fail|goes viral|breaks the internet|sparked? outrage|twitter reacts|social media (?:erupts|reacts))\b/i,
  },
  {
    name: 'clickbait_question_bait',
    pattern: /\?{2,}|!{3,}/,
    // Matches: "Will this change everything??", "SHOCKING!!!"
  },

  // ── LIVE UPDATES / STREAMS ──
  {
    name: 'live_content',
    pattern: /^(?:live|watch|stream)\s*(?:updates?|blog|score|stream|now|video|coverage)\b/i,
    // Matches: "LIVE updates: India vs Aus", "Watch now: PM speech"
  },

  // ── ROUTINE NON-NEWS ──
  {
    name: 'horoscope',
    pattern: /\b(?:horoscope|zodiac|sun sign|moon sign|daily forecast|weekly forecast)\b/i,
  },
  {
    name: 'puzzle_game',
    pattern: /\b(?:wordle|connections|crossword|sudoku|quordle|nyt connections)\b.*\b(?:answer|hint|clue|solution|today)\b/i,
  },
  {
    name: 'weather_routine',
    pattern: /^(?:weather|forecast|temperature)\b.*\b(?:today|tonight|tomorrow|this week|weekend)\b/i,
    // Catches routine forecasts. Does NOT catch "Extreme weather event causes $X billion in damage" (no "today/tomorrow")
  },
  {
    name: 'obituary',
    pattern: /\b(?:obituary|dies at age|passed away|rip )\b/i,
    // Exception: major public figures are handled by LLM. Simple obit format is filtered.
    additionalCheck: (title) => !/\b(?:president|prime minister|ceo|founder|nobel|supreme court)\b/i.test(title),
  },

  // ── PRODUCT LAUNCHES / DEALS ──
  {
    name: 'deal_promotion',
    pattern: /\b(?:coupon|promo code|discount code|flash sale|deal of the day|price drop|save \d+%|buy now|order now|best deals?)\b/i,
  },
  {
    name: 'product_review',
    pattern: /^(?:review|hands-on|unboxing|first look)\s*:/i,
    // Matches: "Review: iPhone 16 Pro", "Unboxing: Galaxy S26"
  },
];

// ── F7: Template Content Detection ──

export const TEMPLATE_PATTERNS: TemplatePattern[] = [

  // ── MARKET RESEARCH REPORTS ──
  // "Global Widget Market Size Worth $XX Billion by 2030, Growing at XX% CAGR"
  {
    name: 'market_research',
    pattern: /(?:global|worldwide)\s+.{3,50}\s+market\s+(?:size|share|growth|report|forecast|analysis|research|outlook|trends?)\b/i,
  },
  {
    name: 'market_valuation',
    pattern: /market\s+(?:to reach|worth|valued at|expected to|projected to|estimated at)\s+\$?\s*[\d.]+\s*(?:billion|million|trillion|bn|mn)/i,
  },
  {
    name: 'cagr_report',
    pattern: /\b(?:CAGR|compound annual growth)\s+(?:of\s+)?[\d.]+\s*%/i,
  },

  // ── PRESS RELEASES ──
  {
    name: 'press_release',
    pattern: /^(?:press release|media release|for immediate release)\s*[:\-–]/i,
  },
  {
    name: 'company_announces',
    pattern: /\b(?:announces?|launched?|unveil|introduces?)\s+(?:new|latest|innovative|revolutionary|cutting.?edge|state.?of.?the.?art|next.?gen)\s+/i,
    // Matches PR-style language: "X announces new innovative Y"
    // Does NOT match: "Government announces new tax policy" (no "innovative/latest")
  },

  // ── STOCK BOILERPLATE ──
  {
    name: 'stock_short_interest',
    pattern: /^Short Interest in .+\(.+\)/i,
  },
  {
    name: 'stock_price_target',
    pattern: /^(?:analyst|broker)\s+.+\s+(?:price target|rating|upgrade|downgrade)/i,
  },
  {
    name: 'penny_stock',
    pattern: /\b(?:penny stock|hot stock|stock pick|stock alert|buy alert)\b/i,
  },

  // ── FORMULAIC ROUNDUPS ──
  {
    name: 'daily_roundup',
    pattern: /^(?:today'?s|daily|weekly|morning|evening)\s+(?:brief|briefing|digest|roundup|round-up|wrap|recap|summary|newsletter)\b/i,
  },
  {
    name: 'what_happened_today',
    pattern: /^(?:what happened|what to know|what to watch|what's trending|trending now|top stories)\s+(?:today|this (?:week|morning|evening))\b/i,
  },

  // ── BETTING / ODDS ──
  {
    name: 'betting_odds',
    pattern: /\b(?:betting odds|spread|over.?under|point spread|money.?line|parlay|handicap|odds comparison)\b/i,
  },
  {
    name: 'fantasy_sports',
    pattern: /\b(?:fantasy (?:football|cricket|baseball|basketball|premier league)|dream ?11|fpl|fantasy lineup|captain pick)\b/i,
  },

  // ── SOCIAL MEDIA ENGAGEMENT BAIT ──
  {
    name: 'social_media_reaction',
    pattern: /\b(?:fans react|twitter reacts|internet reacts|netizens|went viral|breaking the internet|memes?\s+(?:flood|pour|go viral))\b/i,
  },
];
