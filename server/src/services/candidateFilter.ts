import type { RawArticle, SourceRow } from './rssFetcher.js';
import { classifyArticle } from './classifier.js';
import { genrePriorityScore } from './classifier.js';
import { normalizeTitle, titleQualityScore } from './titleNormalizer.js';

const PER_SOURCE_CAP = 5;
const GLOBAL_CAP = 80;

export interface CandidateArticle extends RawArticle {
  normalizedTitle: string;
  mainGenre: 'india' | 'global';
  subGenre: string;
  importanceScore: number;
  isLowSignal: boolean;
  lowSignalReason: string | null;
  regionConfidence: number;
  genreConfidence: number;
  source: SourceRow;
}

export interface CandidateFilterReport {
  totalFetched: number;
  filteredByReason: Record<string, number>;
  keptBeforeEmbeddings: number;
}

function mark(report: CandidateFilterReport, reason: string): void {
  report.filteredByReason[reason] = (report.filteredByReason[reason] ?? 0) + 1;
}

function lowSignalReason(article: RawArticle, normalizedTitle: string): string | null {
  const title = article.title.trim();
  const body = article.body.trim();
  if (!article.url) return 'missing-url';
  if (title.length < 12) return 'short-title';
  if (!normalizedTitle || normalizedTitle.length < 10) return 'bad-normalized-title';
  if (body.length < 20 && title.length < 35) return 'low-content';
  if (/\b(horoscope|coupon|deal|discount|shopping|recipe|photos?|watch video|viral|meme)\b/i.test(title)) {
    return 'soft-content';
  }
  if (/\b(live updates?|live blog)\b/i.test(title)) return 'live-blog';
  if (/\b(opinion|editorial|column)\b/i.test(title)) return 'opinion';
  return null;
}

function freshnessScore(publishedAt: Date): number {
  const hoursOld = Math.max(0, (Date.now() - publishedAt.getTime()) / 36e5);
  return Math.max(0, Math.min(2, 2 - hoursOld / 12));
}

export function prepareCandidates(
  articles: RawArticle[],
  sources: Map<number, SourceRow>,
  perSourceCap = PER_SOURCE_CAP,
  globalCap = GLOBAL_CAP,
): { candidates: CandidateArticle[]; report: CandidateFilterReport } {
  const report: CandidateFilterReport = {
    totalFetched: articles.length,
    filteredByReason: {},
    keptBeforeEmbeddings: 0,
  };
  const seenUrls = new Set<string>();
  const seenSourceTitleDay = new Set<string>();
  const candidates: CandidateArticle[] = [];

  for (const article of articles) {
    const source = sources.get(article.sourceId);
    if (!source) {
      mark(report, 'missing-source');
      continue;
    }
    if (seenUrls.has(article.url)) {
      mark(report, 'duplicate-url');
      continue;
    }
    seenUrls.add(article.url);

    const normalizedTitle = normalizeTitle(article.title);
    const day = article.publishedAt.toISOString().slice(0, 10);
    const titleKey = `${article.sourceId}:${day}:${normalizedTitle}`;
    if (seenSourceTitleDay.has(titleKey)) {
      mark(report, 'duplicate-title-source-day');
      continue;
    }
    seenSourceTitleDay.add(titleKey);

    const classification = classifyArticle({
      title: article.title,
      body: article.body,
      url: article.url,
      source: {
        name: source.name,
        feedUrl: source.feed_url,
        baseUrl: source.base_url,
        category: source.category,
        priority: source.priority,
        countryFocus: source.country_focus,
        mainGenreHint: source.main_genre_hint,
        subGenreHint: source.sub_genre_hint,
        editorialType: source.editorial_type,
      },
    });
    const reason = lowSignalReason(article, normalizedTitle);
    const sourcePriorityScore = Math.max(0, Math.min(3, source.priority ?? 1));
    const bodyPresenceScore = article.body.trim().length > 120 ? 0.6 : article.body.trim().length > 30 ? 0.25 : 0;
    const junkPenalty = reason ? (reason === 'opinion' ? -1.2 : -2.5) : 0;
    const score =
      sourcePriorityScore +
      titleQualityScore(article.title) +
      bodyPresenceScore +
      freshnessScore(article.publishedAt) +
      genrePriorityScore(classification.subGenre) * 10 +
      junkPenalty;

    if (reason || source.priority === 0) {
      mark(report, source.priority === 0 ? 'priority-zero' : reason ?? 'low-signal');
      continue;
    }

    candidates.push({
      ...article,
      normalizedTitle,
      mainGenre: classification.mainGenre,
      subGenre: classification.subGenre,
      importanceScore: Number(score.toFixed(4)),
      isLowSignal: false,
      lowSignalReason: null,
      regionConfidence: Number(classification.regionConfidence.toFixed(4)),
      genreConfidence: Number(classification.genreConfidence.toFixed(4)),
      source,
    });
  }

  const perSourceCounts = new Map<number, number>();
  const adaptivePerSourceCap = Math.max(
    perSourceCap,
    Math.ceil(Math.min(globalCap, candidates.length) / Math.max(1, sources.size))
  );
  const afterPerSourceCap = candidates
    .sort((a, b) => b.importanceScore - a.importanceScore)
    .filter(candidate => {
      const count = perSourceCounts.get(candidate.sourceId) ?? 0;
      if (count >= adaptivePerSourceCap) {
        mark(report, 'per-source-cap');
        return false;
      }
      perSourceCounts.set(candidate.sourceId, count + 1);
      return true;
    })
  const capped = afterPerSourceCap.slice(0, globalCap);

  if (afterPerSourceCap.length > capped.length) {
    report.filteredByReason['global-scored-cap'] = (report.filteredByReason['global-scored-cap'] ?? 0) + afterPerSourceCap.length - capped.length;
  }

  report.keptBeforeEmbeddings = capped.length;
  return { candidates: capped, report };
}
