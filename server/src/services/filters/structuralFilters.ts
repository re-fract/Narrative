/**
 * structuralFilters.ts — F1–F7 structural reject filters + region classification
 *
 * Filters ONLY reject. If an article passes F1–F7, it proceeds to LLM.
 * Replaced: genreMapping.ts (classifyRegion moved here per §7)
 */

import type { NormalizedArticle, FilterRejection, SourceApi } from '../../types/index.js';
import { BLOCKED_DOMAIN_SET } from '../../config/domains.js';
import { REJECT_URL_PATHS, REJECT_TITLE_PATTERNS, TEMPLATE_PATTERNS } from '../../config/filters.js';
import { STALENESS_CUTOFF_HOURS, TITLE_MIN_LENGTH, DESCRIPTION_MIN_LENGTHS } from '../../config/constants.js';

// ── Region classification (moved from genreMapping.ts — §7) ──

export function classifyRegion(article: NormalizedArticle): 'india' | 'global' {
  if (article.apiCountry === 'IN' || article.apiCountry === 'india') return 'india';
  const indiaDomains = [
    'thehindu.com', 'indianexpress.com', 'hindustantimes.com',
    'timesofindia.indiatimes.com', 'ndtv.com', 'theprint.in', 'scroll.in',
  ];
  if (indiaDomains.some(d => article.sourceDomain?.includes(d))) return 'india';
  return 'global';
}

// ── F1: Language ──

/** Unicode script ranges that indicate non-English text.
 *  Compiled once at module load — no /g flag (stateless).
 *  Each entry is a [start, end] pair of code points. */
const NON_LATIN_RANGES: [number, number][] = [
  [0x0370, 0x03FF], // Greek and Coptic
  [0x0530, 0x058F], // Armenian
  [0x0900, 0x097F], // Devanagari (Hindi, Marathi, Sanskrit, Nepali)
  [0x0980, 0x09FF], // Bengali
  [0x0A00, 0x0A7F], // Gurmukhi (Punjabi)
  [0x0A80, 0x0AFF], // Gujarati
  [0x0B00, 0x0B7F], // Oriya
  [0x0B80, 0x0BFF], // Tamil
  [0x0C00, 0x0C7F], // Telugu
  [0x0C80, 0x0CFF], // Kannada
  [0x0D00, 0x0D7F], // Malayalam
  [0x0E00, 0x0E7F], // Thai
  [0x0E80, 0x0EFF], // Lao
  [0x1000, 0x109F], // Myanmar
  [0x10A0, 0x10FF], // Georgian
  [0x1100, 0x11FF], // Hangul Jamo (Korean)
  [0x3040, 0x309F], // Hiragana (Japanese)
  [0x30A0, 0x30FF], // Katakana (Japanese)
  [0x4E00, 0x9FFF], // CJK Unified Ideographs (Chinese/Japanese)
  [0xAC00, 0xD7AF], // Hangul Syllables (Korean)
  [0x0600, 0x06FF], // Arabic
  [0x0750, 0x077F], // Arabic Supplement
  [0xFB50, 0xFDFF], // Arabic Presentation Forms-A
  [0x0590, 0x05FF], // Hebrew
];

/** Check if a character code point falls in any non-Latin range. */
function isNonLatin(cp: number): boolean {
  for (const [start, end] of NON_LATIN_RANGES) {
    if (cp >= start && cp <= end) return true;
  }
  return false;
}

function f1Language(article: NormalizedArticle): string | null {
  // 1. API-declared language check (explicit non-English → reject)
  const lang = article.apiLanguage;
  if (lang !== null && lang !== undefined) {
    const lower = lang.toLowerCase();
    if (lower !== 'en' && lower !== 'english') {
      return 'language'; // API explicitly says non-English
    }
  }

  // 2. Script detection: scan actual text for non-Latin characters
  const text = `${article.title ?? ''} ${article.description ?? ''}`;
  if (text.length === 0) return null;

  let charCount = 0;
  let nonLatinCount = 0;

  for (const char of text) {
    // Skip whitespace, digits, common punctuation
    if (/[\s\d\p{P}\p{S}]/u.test(char)) continue;
    charCount++;
    const cp = char.codePointAt(0)!;
    if (isNonLatin(cp)) nonLatinCount++;
  }

  // Too few meaningful characters to reliably detect → pass
  if (charCount < 10) return null;

  // If >30% of meaningful characters are non-Latin → not English
  if (nonLatinCount / charCount > 0.30) return 'language';

  return null;
}

// ── F2: Staleness ──

function f2Staleness(article: NormalizedArticle): string | null {
  const cutoff = Date.now() - STALENESS_CUTOFF_HOURS * 3600_000;
  if (article.publishedAt.getTime() < cutoff) return 'staleness';
  return null;
}

// ── F3: Content Minimum ──

function f3ContentMin(article: NormalizedArticle): string | null {
  // Title missing or too short
  if (!article.title || article.title.length < TITLE_MIN_LENGTH) return 'content_min';

  // ALL CAPS title (>85% uppercase)
  const letters = article.title.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 0) {
    const upperCount = (article.title.match(/[A-Z]/g) ?? []).length;
    if (upperCount / letters.length > 0.85) return 'content_min';
  }

  // Per-API description/content minimum — prefer content, then description
  const textToCheck = article.content ?? article.description;
  if (textToCheck === null || textToCheck === undefined) return null; // no text available → pass
  const minLen = DESCRIPTION_MIN_LENGTHS[article.sourceApi as SourceApi] ?? 0;
  if (textToCheck.length < minLen) return 'content_min';

  return null;
}

// ── F4: Domain Blocklist ──

function f4DomainBlocklist(article: NormalizedArticle): string | null {
  if (BLOCKED_DOMAIN_SET.has(article.sourceDomain)) return 'domain_blocklist';
  return null;
}

// ── F5: URL Path ──

function f5UrlPath(article: NormalizedArticle): string | null {
  for (const entry of REJECT_URL_PATHS) {
    if (entry.pattern.test(article.url)) return 'url_path';
  }
  return null;
}

// ── F6: Title Pattern ──

function f6TitlePattern(article: NormalizedArticle): string | null {
  for (const entry of REJECT_TITLE_PATTERNS) {
    if (entry.pattern.test(article.title)) {
      if (entry.additionalCheck) {
        if (entry.additionalCheck(article.title)) return 'title_pattern';
      } else {
        return 'title_pattern';
      }
    }
  }
  return null;
}

// ── F7: Template Detection ──

function f7Template(article: NormalizedArticle): string | null {
  const text = article.content ?? article.description;
  if (!text) return null;
  for (const entry of TEMPLATE_PATTERNS) {
    if (entry.pattern.test(text)) return 'template';
  }
  return null;
}

// ── Main entry point ──

export function runStructuralFilters(
  articles: NormalizedArticle[],
): { passed: NormalizedArticle[]; rejected: FilterRejection[] } {
  const passed: NormalizedArticle[] = [];
  const rejected: FilterRejection[] = [];

  const filters: Array<(a: NormalizedArticle) => string | null> = [
    f1Language,
    f2Staleness,
    f3ContentMin,
    f4DomainBlocklist,
    f5UrlPath,
    f6TitlePattern,
    f7Template,
  ];

  for (const article of articles) {
    let rejectionRule: string | null = null;

    for (const filter of filters) {
      const rule = filter(article);
      if (rule !== null) {
        rejectionRule = rule;
        break; // first matching filter wins
      }
    }

    if (rejectionRule === null) {
      passed.push(article);
    } else {
      rejected.push({
        url: article.url,
        title: article.title,
        sourceApi: article.sourceApi,
        sourceDomain: article.sourceDomain,
        rejectionStage: 'filter',
        rejectionRule,
        contextLen: (article.description?.length ?? 0) + (article.content?.length ?? 0),
      });
    }
  }

  return { passed, rejected };
}
