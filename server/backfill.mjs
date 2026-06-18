import pg from 'pg';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const res = await pool.query('SELECT id, title, body FROM articles WHERE embedding IS NULL LIMIT 250');
console.log('Articles to backfill:', res.rows.length);

let done = 0;
for (const row of res.rows) {
  try {
    const text = (row.title || '') + '\n' + (row.body || '');
    const emb = await genAI.models.embedContent({ model: 'gemini-embedding-2', contents: text });
    const values = emb.embeddings?.[0]?.values;
    if (values) {
      await pool.query('UPDATE articles SET embedding = $1 WHERE id = $2', [JSON.stringify(values), row.id]);
      done++;
      if (done % 10 === 0) console.log(`Progress: ${done}/${res.rows.length}`);
    }
  } catch (e) {
    console.warn('Failed for', row.id, e.message);
  }
}

console.log('Backfilled:', done, '/', res.rows.length);
await pool.end();
