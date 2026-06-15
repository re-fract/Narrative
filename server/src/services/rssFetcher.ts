export interface RawArticle {
  title: string;
  url: string;
  body: string;
  publishedAt: Date;
  sourceId: number;
}

/**
 * Fetch articles from a single RSS feed using a proxy to avoid CORS.
 * Falls back to an alternate CORS proxy if the first fails.
 */
async function fetchFeed(feedUrl: string): Promise<Array<{ title: string; url: string; description: string; publishedAt: Date }>> {
  const urls = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`,
    `https://api.allorigins.win/get?url=${encodeURIComponent(feedUrl)}&raw=true`,
  ];

  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const text = await res.text();
      return parseRSS(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function parseRSS(xml: string): Array<{ title: string; url: string; description: string; publishedAt: Date }> {
  const items: Array<{ title: string; url: string; description: string; publishedAt: Date }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = extractTag(itemXml, 'title') || '';
    const url = extractTag(itemXml, 'link') || '';
    const description = extractTag(itemXml, 'description') || '';
    const pubDate = extractTag(itemXml, 'pubDate') || '';
    items.push({ title, url, description, publishedAt: new Date(pubDate) });
  }
  return items;
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = regex.exec(xml);
  if (!match) return null;
  return match[1]
    .replace(/<\!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * Fetch all RSS feeds and return deduplicated articles.
 * Only keeps articles published in the last 24 hours.
 */
export async function fetchAllFeeds(sources: Array<{ feedUrl: string; id: number }>): Promise<RawArticle[]> {
  const allItems: RawArticle[] = [];
  const seenUrls = new Set<string>();

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  await Promise.all(
    sources.map(async (source) => {
      try {
        const items = await fetchFeed(source.feedUrl);
        for (const item of items) {
          if (seenUrls.has(item.url)) continue;
          if (item.publishedAt < cutoff) continue;
          seenUrls.add(item.url);
          allItems.push({
            title: item.title.slice(0, 500),
            url: item.url.slice(0, 1000),
            body: item.description.slice(0, 5000),
            publishedAt: item.publishedAt,
            sourceId: source.id,
          });
        }
      } catch {
        // Swallow feed-level errors silently for this demo.
      }
    })
  );

  return allItems;
}
