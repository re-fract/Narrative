import { XMLParser } from 'fast-xml-parser';
import { pool } from '../db/index.js';

export interface RawArticle {
  title: string;
  url: string;
  body: string;
  publishedAt: Date;
  sourceId: number;
}

interface FeedItem {
  title: string;
  url: string;
  body: string;
  publishedAt: Date;
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, '').trim();
}

function getFirstTextNode(val: unknown): string | null {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj['#text'] === 'string') return obj['#text'];
    if (typeof obj.text === 'string') return obj.text;
  }
  return null;
}

function extractUrlFromItem(item: Record<string, unknown>, feedUrl: string): string {
  // RSS style
  if (typeof item.link === 'string') return item.link;
  // Atom style link with href
  if (item.link) {
    const linkText = getFirstTextNode(item.link);
    if (linkText) return linkText;

    const linkObj = item.link as Record<string, string | undefined>;
    if (linkObj['@_href']) return linkObj['@_href'];
    if (linkObj.href) return linkObj.href;
  }
  return '';
}

function parseDate(dateStr: unknown): Date | null {
  if (typeof dateStr !== 'string' || !dateStr.trim()) return null;
  const parsed = new Date(dateStr.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractPubDate(item: Record<string, unknown>): Date | null {
  const candidates: unknown[] = [
    item.pubDate,
    item.published,
    item.updated,
  ];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const d = parseDate(c);
      if (d) return d;
    }
  }
  return null;
}

function extractDescription(item: Record<string, unknown>): string {
  let raw = '';
  if (typeof item.description === 'string') {
    raw = item.description;
  } else if (typeof item.summary === 'string') {
    raw = item.summary;
  } else if (typeof item.content === 'string') {
    raw = item.content;
  } else if (typeof item['content:encoded'] === 'string') {
    raw = item['content:encoded'];
  } else if (typeof item['dc:description'] === 'string') {
    raw = item['dc:description'];
  }
  return stripHtml(raw);
}

function extractTitle(item: Record<string, unknown>): string {
  if (typeof item.title === 'string') return item.title;
  const textNode = getFirstTextNode(item.title);
  if (textNode) return textNode;
  return '';
}

function parseXML(xml: string): FeedItem[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  const parsed = parser.parse(xml);

  let rawItems: unknown[] = [];

  if (parsed?.rss?.channel?.item) {
    rawItems = Array.isArray(parsed.rss.channel.item)
      ? parsed.rss.channel.item
      : [parsed.rss.channel.item];
  } else if (parsed?.feed?.entry) {
    rawItems = Array.isArray(parsed.feed.entry)
      ? parsed.feed.entry
      : [parsed.feed.entry];
  }

  const items: FeedItem[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    if (items.length >= 30) break;
    const raw = rawItems[i];
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    const title = extractTitle(item);
    const url = extractUrlFromItem(item, '');
    const body = extractDescription(item);
    let publishedAt = extractPubDate(item);
    if (!publishedAt) {
      publishedAt = new Date();
    }

    items.push({
      title,
      url,
      body,
      publishedAt,
    });
  }

  return items;
}

async function fetchFeed(feedUrl: string): Promise<FeedItem[]> {
  const urls = [feedUrl, `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const text = await res.text();
      return parseXML(text);
    } catch {
      // Continue to next URL
    }
  }

  return [];
}

export async function fetchAllFeeds(): Promise<RawArticle[]> {
  const result = await pool.query<{ id: number; feed_url: string }>(
    'SELECT id, feed_url FROM sources WHERE is_active = true'
  );

  const sources = result.rows;
  const allItems: RawArticle[] = [];
  const seenUrls = new Set<string>();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const source of sources) {
    try {
      const items = await fetchFeed(source.feed_url);
      for (const item of items) {
        if (seenUrls.has(item.url)) continue;
        if (item.publishedAt < cutoff) continue;
        seenUrls.add(item.url);
        allItems.push({
          title: item.title.slice(0, 500),
          url: item.url.slice(0, 1000),
          body: item.body.slice(0, 5000),
          publishedAt: item.publishedAt,
          sourceId: source.id,
        });
        if (allItems.length >= 60) break;
      }
      if (allItems.length >= 60) break;
    } catch (err) {
      console.error(`Feed fetch failed for ${source.feed_url}:`, err);
    }
  }

  return allItems.slice(0, 60);
}
