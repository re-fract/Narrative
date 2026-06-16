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
    const jsdom = new JSDOM(html, { url });
    const reader = new Readability(jsdom.window.document);
    const article = reader.parse();

    if (!article) {
      return null;
    }

    let text: string;

    if (article.content) {
      // Parse Readability's cleaned HTML for better text extraction
      const articleDom = new JSDOM(article.content);
      const doc = articleDom.window.document;
      const body = doc.body;

      if (!body) {
        text = article.textContent?.trim() || '';
      } else {
        // Walk all paragraphs and text nodes to build properly spaced text
        const paragraphs = body.querySelectorAll('p');
        if (paragraphs.length > 0) {
          const parts: string[] = [];
          paragraphs.forEach((p) => {
            const paraText = p.textContent?.trim();
            if (paraText && paraText.length > 0) {
              parts.push(normalizeArticleText(paraText));
            }
          });
          text = parts.join('\n\n');
        } else {
          // Fallback to body textContent with normalization
          text = normalizeArticleText(body.textContent?.trim() || '');
        }
      }
    } else {
      text = normalizeArticleText(article.textContent?.trim() || '');
    }

    if (!text || text.length < 50) return null;
    return text;
  } catch (err) {
    console.error('fetchArticleText failed:', err);
    return null;
  }
}
