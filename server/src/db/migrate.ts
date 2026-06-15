import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function migrate(): Promise<void> {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    await pool.query(sql);
    console.log('Database migrated successfully');
  } catch (err) {
    // pg does not throw for IF NOT EXISTS, but catch anything else
    console.error('Migration error:', err);
    throw err;
  }
}
