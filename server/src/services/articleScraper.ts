import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

function normalizeArticleText(text: string): string {
  if (!text) return text;

  let normalized = text
    // Collapse runs of whitespace (newlines, tabs, multiple spaces)
    .replace(/\s+/g, ' ')
    .trim();

  // Fix missing spaces between words that were concatenated when
  // inline HTML elements were stripped (e.g. <span>one</span><span>Two</span>)
  // 1. lowercase letter followed by uppercase letter + lowercase (e.g. "agoRachel" -> "ago Rachel")
  normalized = normalized.replace(/([a-z])([A-Z][a-z])/g, '$1 $2');

  // 2. letter immediately followed by a comma/semicolon and then uppercase (e.g. "Murphy,BBC" -> "Murphy, BBC")
  normalized = normalized.replace(/([a-zA-Z])([,;])([A-Z])/g, '$1$2 $3');

  return normalized;
}

function stripLeadingBylines(text: string, byline?: string): string {
  if (!text) return text;
  if (!byline || byline.trim().length < 2) return text;

  const blocks = text.split('\n\n');
  const cleaned: string[] = [];
  let count = 0;
  const bl = byline.trim().toLowerCase();

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (count >= 3) {
      cleaned.push(block);
      continue;
    }

    const lower = trimmed.toLowerCase();
    let isByline = false;

    // Exact match with byline
    if (lower === bl) {
      isByline = true;
    }
    // Paragraph contains the byline and is short enough to be a byline
    else if (lower.includes(bl)) {
      const ratio = bl.length / trimmed.length;
      if (ratio > 0.5 || trimmed.length < bl.length + 40) {
        isByline = true;
      }
    }
    // Byline contains this short paragraph (partial match, e.g. "BBC News" in a longer byline)
    else if (trimmed.length > 0 && trimmed.length < bl.length && bl.includes(lower)) {
      isByline = true;
    }

    if (isByline) {
      count++;
      continue;
    }

    // Additional metadata paragraph right after a byline (date, time, etc.)
    if (count > 0 && trimmed.length < 80 && !trimmed.endsWith('.')) {
      const metaRe = /(ago$|hour|minute|published|updated|correspondent|reporter|editor|analyst|staff)/i;
      if (metaRe.test(trimmed)) {
        count++;
        continue;
      }
    }

    cleaned.push(block);
  }

  const result = cleaned.join('\n\n');
  // Safety: don't remove more than 60% of the article
  if (result.length < text.length * 0.4) return text;
  return result;
}

function withCssWarningsSuppressed<T>(fn: () => T): T {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('Could not parse CSS stylesheet')
    ) {
      return;
    }
    original.apply(console, args as [string, ...unknown[]]);
  };
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

function textFromElements(document: Document, selectors: string[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el) => {
      const tag = el.tagName.toLowerCase();
      if (!['p', 'h2', 'h3', 'h4', 'blockquote'].includes(tag)) return;

      const raw = el.textContent?.trim();
      if (!raw || raw.length < 25) return;

      const normalized = normalizeArticleText(raw);
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      parts.push(tag.startsWith('h') ? `###HEADING:###${normalized}` : normalized);
    });

    if (parts.join('\n\n').length > 500) break;
  }

  return parts.join('\n\n');
}

function extractJsonLdArticleBody(document: Document): string {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    const raw = script.textContent?.trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      const queue = [...nodes];

      while (queue.length > 0) {
        const node = queue.shift();
        if (!node || typeof node !== 'object') continue;
        const record = node as Record<string, unknown>;
        const type = record['@type'];
        const isArticle = Array.isArray(type)
          ? type.some(t => String(t).toLowerCase().includes('article'))
          : String(type ?? '').toLowerCase().includes('article');

        if (isArticle && typeof record.articleBody === 'string' && record.articleBody.length > 200) {
          return normalizeArticleText(record.articleBody);
        }

        for (const value of Object.values(record)) {
          if (Array.isArray(value)) queue.push(...value);
          else if (value && typeof value === 'object') queue.push(value);
        }
      }
    } catch {
      // Ignore malformed publisher JSON-LD and try the next block.
    }
  }

  return '';
}

function extractSiteSpecificText(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  const { document } = dom.window;

  document.querySelectorAll('script, style, noscript, iframe, nav, header, footer, aside, form').forEach(el => el.remove());

  const jsonLd = extractJsonLdArticleBody(document);
  if (jsonLd.length > 500) return jsonLd;

  return textFromElements(document, [
    'article [itemprop="articleBody"] p, article [itemprop="articleBody"] h2, article [itemprop="articleBody"] h3',
    '[itemprop="articleBody"] p, [itemprop="articleBody"] h2, [itemprop="articleBody"] h3',
    '.articlebodycontent p, .articlebodycontent h2, .articlebodycontent h3',
    '.story-details p, .story-details h2, .story-details h3',
    '.storyDetail p, .storyDetail h2, .storyDetail h3',
    '.story_content p, .story_content h2, .story_content h3',
    '.articleBody p, .articleBody h2, .articleBody h3',
    '.article-body p, .article-body h2, .article-body h3',
    '.paywall p, .paywall h2, .paywall h3',
    'main article p, main article h2, main article h3',
    'article p, article h2, article h3',
    'main p, main h2, main h3',
  ]);
}

export async function fetchArticleText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
    });
    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const fallbackText = extractSiteSpecificText(html, url);
    let article: any;
    withCssWarningsSuppressed(() => {
      const jsdom = new JSDOM(html, { url });
      const reader = new Readability(jsdom.window.document);
      article = reader.parse();
    });

    if (!article) {
      return fallbackText.length >= 200 ? fallbackText : null;
    }

    const bylineText = (article.byline || '').trim();
    let text: string;

    if (article.content) {
      // Parse Readability's cleaned HTML for better text extraction
      const articleDom = new JSDOM(article.content);
      const doc = articleDom.window.document;
      const body = doc.body;

      if (!body) {
        text = article.textContent?.trim() || '';
      } else {
        // Walk all relevant structural elements in order, preserving headings
        const elements = body.querySelectorAll('h2, h3, h4, h5, h6, p, blockquote');
        const parts: string[] = [];
        elements.forEach((el) => {
          const elText = el.textContent?.trim();
          if (!elText || elText.length === 0) return;

          const tag = el.tagName.toLowerCase();
          const normalized = normalizeArticleText(elText);

          if (tag.startsWith('h')) {
            // Mark headings so the frontend can render them distinctly
            parts.push(`###HEADING:###${normalized}`);
          } else if (tag === 'blockquote') {
            parts.push(normalized);
          } else {
            parts.push(normalized);
          }
        });
        text = parts.join('\n\n');
      }
    } else {
      text = normalizeArticleText(article.textContent?.trim() || '');
    }

    // Remove byline paragraphs that got included in the article body
    text = stripLeadingBylines(text, bylineText || undefined);

    if (fallbackText.length > text.length * 1.25) {
      text = fallbackText;
    }

    if (!text || text.length < 50) return fallbackText.length >= 200 ? fallbackText : null;
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'Error';
    if (name === 'TimeoutError' || message.toLowerCase().includes('timeout')) {
      console.warn(`fetchArticleText timeout for ${url}`);
    } else {
      console.warn(`fetchArticleText failed for ${url}: ${message}`);
    }
    return null;
  }
}
