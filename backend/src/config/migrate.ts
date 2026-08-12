import fs from 'fs';
import path from 'path';
import { pool } from './db';
import { logger } from '../utils/logger';

// Locally (ts-node/dist run from backend/) this resolves to <repo>/database/migrations.
// In Docker the image copies the migrations folder to /app/database/migrations and sets
// MIGRATIONS_DIR explicitly, since the container filesystem doesn't mirror the repo layout.
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.resolve(__dirname, '../../../database/migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const result = await pool.query('SELECT filename FROM schema_migrations');
  return new Set(result.rows.map((r) => r.filename));
}

async function runMigrations(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      logger.info(`Skipping already-applied migration: ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info(`Applied migration: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Failed to apply migration ${file}`, { error: (err as Error).message });
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info('All migrations applied.');
}

runMigrations()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Migration run failed', { error: err.message });
    process.exit(1);
  });
