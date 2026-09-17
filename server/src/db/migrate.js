// Forward-only SQL migration runner.
//
//   npm run migrate            apply every pending migration
//   npm run migrate -- --status   list applied / pending, change nothing
//
// Rules:
//   * Files live in ./migrations and are named NNNN_description.sql.
//   * They run in filename order, each inside its own transaction.
//   * A file that has already run is never run again (tracked in schema_migrations).
//   * There is no "down". To undo a change, write a new migration that reverses it.
//     That is how the schema history stays an honest, append-only log.
//   * A file's SHA-256 is stored when applied. If someone edits an already-applied
//     file, the runner refuses to continue — the database and the repo have diverged.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './client.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

async function ensureTrackingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text        PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadMigrationFiles() {
  const names = (await readdir(MIGRATIONS_DIR)).filter((f) => FILE_PATTERN.test(f)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      return { name, sql, checksum };
    }),
  );
}

async function loadApplied() {
  const { rows } = await pool.query('SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name');
  return new Map(rows.map((r) => [r.name, r]));
}

async function applyOne({ name, sql, checksum }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const statusOnly = process.argv.includes('--status');

  await ensureTrackingTable();
  const [files, applied] = await Promise.all([loadMigrationFiles(), loadApplied()]);

  // Guard: an applied file whose contents changed means the repo no longer
  // describes what is in the database. Stop and make a human look.
  for (const file of files) {
    const record = applied.get(file.name);
    if (record && record.checksum !== file.checksum) {
      throw new Error(
        `${file.name} was modified after being applied on ${record.applied_at.toISOString()}. ` +
          'Revert the edit, or add a new migration instead.',
      );
    }
  }

  const pending = files.filter((f) => !applied.has(f.name));

  if (statusOnly) {
    for (const f of files) console.log(`${applied.has(f.name) ? 'applied' : 'pending'}  ${f.name}`);
    console.log(`\n${applied.size} applied, ${pending.length} pending`);
    return;
  }

  if (pending.length === 0) {
    console.log('Database is up to date.');
    return;
  }

  for (const file of pending) {
    const started = performance.now();
    try {
      await applyOne(file);
      console.log(`applied  ${file.name}  (${Math.round(performance.now() - started)} ms)`);
    } catch (err) {
      console.error(`FAILED   ${file.name}\n  ${err.message}`);
      if (err.position) {
        // Postgres reports a character offset; turn it into a line number.
        const line = file.sql.slice(0, Number(err.position)).split('\n').length;
        console.error(`  at line ${line} of ${file.name}`);
      }
      process.exitCode = 1;
      return; // later migrations may depend on this one
    }
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
