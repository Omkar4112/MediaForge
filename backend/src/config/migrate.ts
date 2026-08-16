import fs from 'fs';
import path from 'path';
import { pool } from './db';
import { logger } from '../utils/logger';

// Locally (ts-node / compiled JS from backend/dist/config/) __dirname is
//   <repo>/backend/{src,dist}/config  →  three levels up reaches <repo>/database/migrations.
// In Docker the image layout is /app/dist/config/ and migrations live at /app/database/migrations
//   →  only two levels up.
// MIGRATIONS_DIR env override always wins.  Otherwise we probe both candidate paths at startup
// and use whichever exists, so one Dockerfile + one ts source works everywhere.
function resolveMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) {
    return path.resolve(process.env.MIGRATIONS_DIR);
  }

  // Candidate paths ordered from most-specific (Docker) to least (local dev/prod)
  const candidates = [
    path.resolve(__dirname, '../../database/migrations'),   // Docker: /app/dist/config → /app/database/migrations
    path.resolve(__dirname, '../../../database/migrations'), // Local:  backend/{src,dist}/config → <repo>/database/migrations
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // candidate doesn't exist or isn't readable, try next
    }
  }

  // Fallback: return the Docker-expected path so the error message is actionable
  return candidates[0];
}

const MIGRATIONS_DIR = resolveMigrationsDir();

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

export async function runMigrations(): Promise<void> {
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

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Migration run failed', { error: err.message });
      process.exit(1);
    });
}
