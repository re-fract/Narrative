import { normalizeTitle } from './titleNormalizer.js';

export interface TimelineArticle {
  id: number;
  story_id: number;
  title: string;
  body?: string | null;
  published_at: Date | string | null;
  importance_score?: number | string | null;
  representative_rank?: number | string | null;
}

function dayKey(value: Date | string | null): string {
  return (value ? new Date(value) : new Date()).toISOString().slice(0, 10);
}

function eventText(article: TimelineArticle): string {
  const body = (article.body ?? '').replace(/\s+/g, ' ').trim();
  if (body.length > 80) return body.slice(0, 240);
  return article.title.slice(0, 240);
}

function textOverlap(a: string, b: string): number {
  const aWords = new Set(normalizeTitle(a).split(' ').filter(w => w.length > 3));
  const bWords = new Set(normalizeTitle(b).split(' ').filter(w => w.length > 3));
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let shared = 0;
  for (const word of aWords) {
    if (bWords.has(word)) shared += 1;
  }
  return shared / Math.min(aWords.size, bWords.size);
}

export function buildTimelineEvents(articles: TimelineArticle[]): {
  storyId: number;
  representativeArticleId: number;
  eventDate: Date;
  classification: string;
  text: string;
  importanceScore: number;
}[] {
  const grouped = new Map<string, TimelineArticle[]>();
  for (const article of articles) {
    const key = dayKey(article.published_at);
    const group = grouped.get(key) ?? [];
    group.push(article);
    grouped.set(key, group);
  }

  const events = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => {
      const representative = [...group].sort((a, b) => {
        const bScore = Number(b.representative_rank ?? b.importance_score ?? 0);
        const aScore = Number(a.representative_rank ?? a.importance_score ?? 0);
        return bScore - aScore;
      })[0];
      return {
        storyId: representative.story_id,
        representativeArticleId: representative.id,
        eventDate: representative.published_at ? new Date(representative.published_at) : new Date(),
        classification: 'update',
        text: eventText(representative),
        importanceScore: Number(representative.importance_score ?? 0),
      };
    });

  const kept: typeof events = [];
  for (const event of events) {
    const previous = kept[kept.length - 1];
    if (!previous || textOverlap(previous.text, event.text) < 0.72) {
      kept.push(event);
    }
  }
  return kept;
}
