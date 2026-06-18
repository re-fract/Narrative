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

export async function fetchArticleText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
      },
    });
    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    let article: any;
    withCssWarningsSuppressed(() => {
      const jsdom = new JSDOM(html, { url });
      const reader = new Readability(jsdom.window.document);
      article = reader.parse();
    });

    if (!article) {
      return null;
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

    if (!text || text.length < 50) return null;
    return text;
  } catch (err) {
    console.error('fetchArticleText failed:', err);
    return null;
  }
}
