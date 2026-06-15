import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn('GEMINI_API_KEY not set. AI features will fail.');
}

const genAI = apiKey ? new GoogleGenAI({ apiKey }) : null;

export default genAI;
