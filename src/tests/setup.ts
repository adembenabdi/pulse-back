/**
 * Vitest global setup: loads .env.test (or falls back to .env) so tests
 * have a real DATABASE_URL available.  The app is NOT started here —
 * each test file uses `supertest(app)` which starts an in-process server.
 */
import { config } from 'dotenv';

// Prevent index.ts from auto-starting the server on port 4000 when imported
process.env['NODE_ENV'] = 'test';

// Load .env.test first, fall back to .env
config({ path: '.env.test', override: false });
config({ path: '.env',      override: false });

// Guard: skip if no DATABASE_URL
if (!process.env['DATABASE_URL']) {
  console.warn('⚠️  No DATABASE_URL found. Integration tests will be skipped.');
}
