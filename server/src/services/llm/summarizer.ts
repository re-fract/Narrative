import { GoogleGenAI, Part } from '@google/genai';
import { pool } from '../../db/index.js';

export async function summarizeSingle(articleText: string, genAI: GoogleGenAI): Promise<string> {
  const result = await genAI.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Summarize the following news article in exactly 3 concise bullet points (one line each). Return only the bullet points, no preamble:' } as Part,
          { text: articleText } as Part,
        ],
      },
    ],
  });
  return result.text ?? '';
}

export async function batchSummarizeArticles(
  texts: string[],
  genAI: GoogleGenAI
): Promise<string[]> {
  const results = await Promise.all(
    texts.map((text) => summarizeSingle(text, genAI))
  );
  return results;
}

export async function synthesizeClusterSummary(
  articleSummaries: string[],
  genAI: GoogleGenAI
): Promise<string> {
  const combined = articleSummaries.join('\n\n');
  const result = await genAI.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'You are given summaries of related news articles. Synthesize them into exactly 3 concise bullet points that capture the key facts and angles. Return only the bullet points, no preamble.' } as Part,
          { text: combined } as Part,
        ],
      },
    ],
  });
  return result.text ?? '';
}

export type StorySummary = {
  storyId: number;
  summary: string;
  title: string;
};

export async function generateStorySummaries(
  stories: Array<{ storyId: number; articles: string[] }>,
  genAI: GoogleGenAI
): Promise<StorySummary[]> {
  const summaries: StorySummary[] = [];

  for (const story of stories) {
    let summary: string;
    if (story.articles.length === 1) {
      summary = await summarizeSingle(story.articles[0], genAI);
    } else {
      const perArticle = await batchSummarizeArticles(story.articles, genAI);
      summary = await synthesizeClusterSummary(perArticle, genAI);
    }

    const title = summary.split('\n')[0].replace(/^[•\-\*]\s*/, '').slice(0, 500);

    summaries.push({
      storyId: story.storyId,
      summary,
      title,
    });
  }

  return summaries;
}
