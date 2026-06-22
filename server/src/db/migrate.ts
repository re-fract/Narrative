import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function existingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export async function migrate(): Promise<void> {
  try {
    const schemaPath = existingPath([
      path.join(__dirname, 'schema.sql'),
      path.join(__dirname, '../../src/db/schema.sql'),
    ]);
    if (!schemaPath) {
      throw new Error('schema.sql not found');
    }
    const sql = fs.readFileSync(schemaPath, 'utf-8');
    await pool.query(sql);

    // Track which migrations have been applied
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migrationsDir = existingPath([
      path.join(__dirname, 'migrations'),
      path.join(__dirname, '../../src/db/migrations'),
    ]);
    if (migrationsDir && fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir)
        .filter((f: string) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        const alreadyApplied = await pool.query(
          'SELECT 1 FROM schema_migrations WHERE filename = $1',
          [file]
        );
        if (alreadyApplied.rows.length > 0) {
          continue;
        }

        const migrationPath = path.join(migrationsDir, file);
        const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
        await pool.query(migrationSql);
        await pool.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        console.log(`Migration applied: ${file}`);
      }
    }

    console.log('Database migrated successfully');
  } catch (err) {
    console.error('Migration error:', err);
    throw err;
  }
}
