// Postgres connection pool and the two helpers every data-access function uses.
//
// A pool keeps a handful of open connections and hands them out per query,
// so we don't pay the TCP + TLS handshake (≈100 ms to Neon) on every request.
// Nothing outside src/db should import `pg` directly.

import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

// By default node-postgres returns NUMERIC and BIGINT columns as strings to
// avoid precision loss. Our money columns are NUMERIC(10,2) and never exceed
// JS's safe range, so parse them into numbers here — once — rather than
// sprinkling Number(...) across the codebase.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,                        // Neon free tier allows ~100; 10 is plenty for one server process
  idleTimeoutMillis: 30_000,      // release idle connections so Neon can auto-suspend
  connectionTimeoutMillis: 10_000, // fail fast if the DB is unreachable
});

// A background connection error (e.g. Neon suspends and drops the socket)
// would otherwise crash the process. Log it; the pool replaces the connection.
pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client error');
});

/**
 * Run a single parameterised query.
 *
 * ALWAYS pass user-supplied values via `params` ($1, $2, …), never by string
 * interpolation. Parameterisation is what makes SQL injection impossible.
 *
 * @param {string} text   SQL with $1, $2 placeholders
 * @param {unknown[]} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(text, params = []) {
  const started = performance.now();
  const result = await pool.query(text, params);
  const ms = Math.round(performance.now() - started);
  if (ms > 200) {
    // Slow-query log. Only the first line of SQL, so logs stay readable.
    logger.warn({ ms, rows: result.rowCount, sql: text.split('\n')[0].trim() }, 'slow query');
  }
  return result;
}

/**
 * Run several statements atomically. The callback receives a dedicated
 * client; use `client.query(...)` inside it. If the callback throws, every
 * statement is rolled back and the error is re-thrown.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Quick liveness check used by /health and by startup. */
export async function ping() {
  const { rows } = await query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

/** Graceful shutdown: let in-flight queries finish, then close every socket. */
export async function closePool() {
  await pool.end();
}
