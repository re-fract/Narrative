import type { ScoredStory } from '../../types/index.js';

export function selectBriefStories(
  stories: ScoredStory[],
  options: { totalSlots?: number; minScore?: number } = {}
): ScoredStory[] {
  const totalSlots = options.totalSlots ?? 14;
  const minScore = options.minScore ?? 0.40;

  const eligible = stories
    .filter(s => s.importance_score >= minScore)
    .sort((a, b) => b.importance_score - a.importance_score);

  const selected: ScoredStory[] = [];
  const llmCatCounts = new Map<string, number>();
  const regionCounts = new Map<string, number>();
  const maxPerLlmCat = 4;
  const maxPerRegion = 8;

  // Pass 1: fill with soft caps
  for (const story of eligible) {
    if (selected.length >= totalSlots) break;
    const catCount = llmCatCounts.get(story.llm_category ?? 'others') ?? 0;
    const regionCount = regionCounts.get(story.main_genre ?? 'global') ?? 0;
    if (catCount >= maxPerLlmCat) continue;
    if (regionCount >= maxPerRegion) continue;
    selected.push(story);
    llmCatCounts.set(story.llm_category ?? 'others', catCount + 1);
    regionCounts.set(story.main_genre ?? 'global', regionCount + 1);
  }

  // Pass 2: wildcard fill
  if (selected.length < totalSlots) {
    const selectedIds = new Set(selected.map(s => s.id));
    const remaining = eligible.filter(s => !selectedIds.has(s.id));
    for (const story of remaining) {
      if (selected.length >= totalSlots) break;
      selected.push(story);
    }
  }

  return selected.sort((a, b) => b.importance_score - a.importance_score);
}
