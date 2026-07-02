/**
 * titleNormalizer.ts — Shared title/URL normalization + dedup hash functions
 *
 * Used by:
 *   - fetchers/ (each has inline copy — will be refactored to import from here)
 *   - filters/deduplicator.ts (F8 dedup — imports from here)
 *
 * All 3 dedup hash functions produce SHA-256 hex strings.
 */

import { createHash } from 'crypto';

// ── URL Normalization ──

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');  // strip trailing slashes
    return `https://${domain}${path}`;                  // no query, no fragment
  } catch {
    return url.toLowerCase();
  }
}

// ── Title Normalization ──

export function normalizeTitleForHash(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '');
}

// ── Dedup Hash Functions ──

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function computeTitleHash(title: string): string {
  return sha256(normalizeTitleForHash(title));
}

export function computeNormalizedUrlHash(url: string): string {
  return sha256(normalizeUrl(url));
}

export function computeDomainTitleHash(domain: string, title: string): string {
  const normalizedTitle = normalizeTitleForHash(title);
  const prefix = normalizedTitle.substring(0, 50);
  return sha256(`${domain.toLowerCase()}:${prefix}`);
}
