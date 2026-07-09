import { Pool } from 'pg';

declare global {
  var dbPool: Pool | undefined;
}

const pool = globalThis.dbPool || new Pool({
  connectionString: process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 0,                  // never evict idle clients — prevents stale-conn errors after long scrape phases
  connectionTimeoutMillis: 10000,
  keepAlive: true,                       // send TCP keepalives so RDS doesn't kill idle connections
  keepAliveInitialDelayMillis: 10000,
});

if (process.env.NODE_ENV !== 'production') {
  globalThis.dbPool = pool;
}

export { pool };
export default pool;
