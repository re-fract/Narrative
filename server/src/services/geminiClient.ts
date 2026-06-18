import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn('GEMINI_API_KEY not set. AI features will fail.');
}

const genAI = apiKey ? new GoogleGenAI({ apiKey }) : null;

export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!genAI) return null;
  try {
    const response = await genAI.models.embedContent({
      model: 'gemini-embedding-2',
      contents: text,
    });
    return response.embeddings?.[0]?.values ?? null;
  } catch (err) {
    console.error('Failed to generate embedding:', err);
    return null;
  }
}

export default genAI;
