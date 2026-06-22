const BOILERPLATE_PATTERNS = [
  /\blive updates?\b/gi,
  /\bbreaking news\b/gi,
  /\bopinion\b/gi,
  /\banalysis\b/gi,
  /\bexplained\b/gi,
];

export function normalizeTitle(title: string): string {
  let normalized = title.toLowerCase();
  normalized = normalized.replace(/\s+[-|]\s+[^-|]+$/g, ' ');
  for (const pattern of BOILERPLATE_PATTERNS) {
    normalized = normalized.replace(pattern, ' ');
  }
  normalized = normalized
    .replace(/&amp;/g, ' and ')
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.slice(0, 500);
}

export function titleQualityScore(title: string): number {
  const normalized = normalizeTitle(title);
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) return 0;

  let score = 1;
  if (words.length >= 5 && words.length <= 16) score += 0.45;
  if (/[0-9]/.test(title)) score += 0.15;
  if (/\b(says|approves|wins|launches|warns|cuts|raises|signs|reports|arrests|strikes)\b/i.test(title)) {
    score += 0.25;
  }
  if (/\b(this|that|these|those|watch|viral|shocking|you need to know)\b/i.test(title)) {
    score -= 0.45;
  }
  if (/\blive\b/i.test(title)) score -= 0.25;
  if (words.length > 22) score -= 0.25;

  return Math.max(0, Math.min(2, score));
}
