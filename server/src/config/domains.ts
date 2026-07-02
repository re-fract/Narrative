export const BLOCKED_DOMAINS = {

  // ── PR / MARKETING WIRE SERVICES ──
  // These are paid press release distribution services, not journalism.
  // User's testing: 25-30% of NewsAPI economic query results come from these.
  pr_wire: [
    'globenewswire.com',
    'prnewswire.com',
    'businesswire.com',
    'accesswire.com',
    'einpresswire.com',
    'newswire.com',
    'prweb.com',
    'prmediaNow.com',
  ],

  // ── SPORTS-ONLY DOMAINS ──
  // These domains publish exclusively or near-exclusively sports content.
  sports: [
    'espn.com',
    'espncricinfo.com',
    'bleacherreport.com',
    'skysports.com',
    'sportskeeda.com',
    'sportsbible.com',
    'cbssports.com',
    'foxsports.com',
    'nbcsports.com',
    'cricbuzz.com',
    'goal.com',
    'transfermarkt.com',
    'sportsstar.thehindu.com',
    'sports.ndtv.com',
  ],

  // ── ENTERTAINMENT / CELEBRITY / GOSSIP ──
  // These domains publish celebrity news, entertainment reviews, gossip.
  entertainment: [
    'tmz.com',
    'eonline.com',
    'perezhilton.com',
    'buzzfeed.com',
    'koreaboo.com',
    'hollywoodreporter.com',
    'deadline.com',
    'variety.com',
    'ew.com',
    'people.com',
    'usmagazine.com',
    'popsugar.com',
    'bollywoodlife.com',
    'pinkvilla.com',
    'filmibeat.com',
    'desimartini.com',
  ],

  // ── TABLOID SOURCES ──
  tabloid: [
    'dailystar.co.uk',
    'thesun.co.uk',
    'dailymail.co.uk',
    'tmz.com',        // also in entertainment but listed here explicitly
    'okmagazine.com',
  ],

  // ── PARTISAN / PROPAGANDA ──
  // Empirically surfaced by TheNewsAPI without domain filter for
  // corruption/investigation queries (user testing).
  partisan: [
    'gellerreport.com',
    'breitbart.com',
    'infowars.com',
    'naturalnews.com',
    'zerohedge.com',
    'thegatewaypundit.com',
    'newsmax.com',
  ],

  // ── CONTENT FARMS / LOW QUALITY AGGREGATORS ──
  content_farm: [
    'dailypolitical.com',
    'watchlistnews.com',
    'baseballnewssource.com',
    'zolmax.com',
    'editorialge.com',
    'newsbreak.com',
    'msn.com',              // Pure aggregator, original source preferred
  ],

  // ── LIFESTYLE / FOOD / TRAVEL / FASHION ──
  lifestyle: [
    'foodnetwork.com',
    'allrecipes.com',
    'bonappetit.com',
    'travelandleisure.com',
    'lonelyplanet.com',
    'vogue.com',
    'cosmopolitan.com',
    'refinery29.com',
    'self.com',
    'byrdie.com',
  ],

  // ── MARKET RESEARCH / DATA AGGREGATORS ──
  // These publish formulaic market sizing reports, not journalism.
  market_research: [
    'marketsandmarkets.com',
    'mordorintelligence.com',
    'grandviewresearch.com',
    'fortunebusinessinsights.com',
    'verifiedmarketresearch.com',
    'researchandmarkets.com',
    'alliedmarketresearch.com',
    'databridgemarketresearch.com',
    'coherentmarketinsights.com',
    'precedenceresearch.com',
    'expertmarketresearch.com',
  ],

  // ── BETTING / GAMBLING ──
  gambling: [
    'oddschecker.com',
    'betfair.com',
    'draftkings.com',
    'fanduel.com',
    'bet365.com',
  ],
};

export const BLOCKED_DOMAIN_SET = new Set(
  Object.values(BLOCKED_DOMAINS).flat()
);

export const INDIA_DOMAINS = [
  'thehindu.com',
  'indianexpress.com',
  'hindustantimes.com',
  'timesofindia.indiatimes.com',
  'ndtv.com',
  'theprint.in',
  'scroll.in',
];
