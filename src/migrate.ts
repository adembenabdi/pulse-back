/**
 * Migration runner.
 * Usage: pnpm migrate
 * Reads all SQL files in migrations/ in order and applies unapplied ones.
 */
import 'dotenv/config';
import { db } from './lib/db.js';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, '../migrations');

await db.admin.query(`
  CREATE TABLE IF NOT EXISTS migrations (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

const { rows: applied } = await db.admin.query<{ name: string }>(
  'SELECT name FROM migrations ORDER BY id',
);
const appliedSet = new Set(applied.map((r) => r.name));

const files = (await readdir(migrationsDir))
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of files) {
  if (appliedSet.has(file)) {
    logger.debug(`skip: ${file}`);
    continue;
  }

  logger.info(`applying: ${file}`);
  const sql = await readFile(resolve(migrationsDir, file), 'utf-8');

  await db.admin.transaction(async (client) => {
    await client.query(sql);
    await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
  });

  logger.info(`done: ${file}`);
}

logger.info('All migrations applied');
process.exit(0);
