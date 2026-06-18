import './src/config.js';
import { pool } from './src/db/index.js';

async function addDummy() {
  const croatiaRes = await pool.query("SELECT id, title FROM stories WHERE title ILIKE '%Croatia%'");
  if (croatiaRes.rows.length > 0) {
    const storyId = croatiaRes.rows[0].id;
    console.log(`Adding dummy article to "${croatiaRes.rows[0].title}" (ID: ${storyId})`);
    await pool.query(
      `INSERT INTO articles (source_id, story_id, url, title, body, full_text, published_at)
       VALUES (1, $1, $2, $3, $4, $5, NOW() - INTERVAL '1 day')`,
      [
        storyId,
        `https://fake-news.com/england-croatia-preview-${Date.now()}`,
        `Pre-match analysis: England faces tough test against Croatia`,
        'Analysts predict a close match between England and Croatia in their opening World Cup game.',
        'Analysts predict a close match between England and Croatia in their opening World Cup game. Both teams have strong lineups.',
      ]
    );
    console.log("Successfully inserted fake article!");
  } else {
    console.log("Couldn't find the Croatia story in DB!");
  }
  process.exit(0);
}
addDummy();