import { Pool } from 'pg';

declare global {
  var dbPool: Pool | undefined;
}

const pool = globalThis.dbPool || new Pool({
  connectionString: process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false },
  max: 10,
  // Neon's pooler drops idle connections aggressively (~5 min).
  // Evict our idle clients after 60s so we never hold a connection
  // that Neon has already killed server-side.
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// REQUIRED: without this listener, any dropped idle connection emits an
// unhandled 'error' event and crashes the Node process immediately.
// pg-pool's idle client error handler fires this when Neon/RDS terminates
// a connection while it's sitting unused in the pool.
pool.on('error', (err) => {
  console.error('[DB] Idle client error (connection dropped by server):', err.message);
});

if (process.env.NODE_ENV !== 'production') {
  globalThis.dbPool = pool;
}

export { pool };
export default pool;
