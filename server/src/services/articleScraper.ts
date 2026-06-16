import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

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

    const text = article.textContent?.trim();
    if (!text || text.length < 50) return null;
    return text;
  } catch (err) {
    console.error('fetchArticleText failed:', err);
    return null;
  }
}
