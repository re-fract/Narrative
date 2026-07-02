import { Pool } from 'pg';

declare global {
  var dbPool: Pool | undefined;
}

const pool = globalThis.dbPool || new Pool({
  connectionString: process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

if (process.env.NODE_ENV !== 'production') {
  globalThis.dbPool = pool;
}

export { pool };
export default pool;
