import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

pg.types.setTypeParser(1082, (value) => value);

export const metrics = new AsyncLocalStorage();

export const prefix = process.env.APP_PREFIX || 'maksim_bataron';

if (!/^[a-z]+_[a-z]+$/.test(prefix) || prefix.length > 50)
  throw new Error('Invalid APP_PREFIX');

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  options: `-c search_path=${prefix},public`,
  connectionTimeoutMillis: 5000,
});

export async function query(text, values = [], client = pool) {
  const start = performance.now();

  try {
    return await client.query(text, values);
  } finally {
    const m = metrics.getStore();

    if (m) {
      m.dbMs += performance.now() - start;
      m.queries++;
    }
  }
}

export async function transaction(fn) {
  const client = await pool.connect();

  try {
    await query('BEGIN', [], client);

    const value = await fn((sql, args) => query(sql, args, client));

    await query('COMMIT', [], client);

    return value;
  } catch (error) {
    await query('ROLLBACK', [], client);

    throw error;
  } finally {
    client.release();
  }
}
