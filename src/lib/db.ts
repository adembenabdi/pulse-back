import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

// ── Connection pool ───────────────────────────────────────────────────────────
// Supports either DATABASE_URL directly, or SUPABASE_URL + SUPABASE_SERVICE_KEY.
// Supabase exposes Postgres at: postgresql://postgres.[ref]:[service_key]@aws-0-[region].pooler.supabase.com:6543/postgres
// But the simplest approach: use SUPABASE_URL to extract the project ref and
// build the standard direct connection URL if DATABASE_URL is not set.
function resolveConnectionString(): string | undefined {
  if (process.env['DATABASE_URL']) return process.env['DATABASE_URL'];
  const supaUrl = process.env['SUPABASE_URL'];          // e.g. https://xyz.supabase.co
  const supaKey = process.env['SUPABASE_SERVICE_KEY'];  // service role JWT
  if (supaUrl && supaKey) {
    // Extract project ref from URL: https://<ref>.supabase.co
    const ref = new URL(supaUrl).hostname.split('.')[0];
    // Direct Postgres connection (IPv4, no pooler — works for dev + migrations)
    // For high-concurrency prod, switch to the Supavisor pooler URL from the
    // Supabase dashboard: Project Settings → Database → Connection string
    return `postgresql://postgres:${supaKey}@db.${ref}.supabase.co:5432/postgres`;
  }
  return undefined;
}

export const pool = new Pool({
  connectionString: resolveConnectionString(),
  ssl: { rejectUnauthorized: false },  // always needed for Supabase
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error(err, 'Unexpected pg pool error');
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type QueryResult<T = Record<string, unknown>> = pg.QueryResult<T & pg.QueryResultRow>;

export interface ScopedDb {
  /**
   * Run a parameterised query.
   * Always appends `AND user_id = $N AND deleted_at IS NULL` to any
   * WHERE clause that contains the placeholder `\/\*scope*\/`.
   *
   * For tables that don't have `user_id` (e.g. join tables), use
   * `query()` with explicit filters after verifying ownership yourself.
   */
  query<T extends Record<string, any> = Record<string, any>>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;

  /** Single-row convenience — throws 404 AppError if no row found. */
  queryOne<T extends Record<string, any> = Record<string, any>>(
    sql: string,
    values?: unknown[],
  ): Promise<T>;

  /** The user id this scope is bound to. */
  userId: string;
}

export interface SharedDb extends ScopedDb {
  /**
   * Same as scoped but also returns rows where `entity_id` appears in
   * the `shares` table for this user (read access or above).
   * Use this for "my items + shared with me" queries.
   */
  sharedQuery<T extends Record<string, any> = Record<string, any>>(
    sql: string,
    values?: unknown[],
    entityType?: string,
  ): Promise<QueryResult<T>>;
}

// ── AppError import (avoid circular) ─────────────────────────────────────────
// We import lazily to avoid circular deps between error.ts and db.ts
async function notFound(msg: string): Promise<never> {
  const { AppError } = await import('../middleware/error.js');
  throw new AppError(404, msg);
}

// ── db.scoped(userId) ─────────────────────────────────────────────────────────
/**
 * Returns a query helper scoped to `userId`.
 * Every query auto-appends user_id filtering where the SQL contains
 * the `/*scope*\/` comment placeholder.
 *
 * Usage:
 *   const db = scoped(req.user.id);
 *   const { rows } = await db.query('SELECT * FROM items WHERE id = $1 /*scope*\/', [id]);
 */
export function scoped(userId: string): ScopedDb {
  return {
    userId,

    async query<T extends pg.QueryResultRow = Record<string, any>>(sql: string, values: unknown[] = []) {
      const { sql: rewritten, values: rewrittenValues } = injectScope(sql, values, userId);
      return pool.query<T>(rewritten, rewrittenValues);
    },

    async queryOne<T extends pg.QueryResultRow = Record<string, any>>(sql: string, values: unknown[] = []) {
      const result = await scoped(userId).query<T>(sql, values);
      if (result.rows.length === 0) {
        await notFound('Resource not found');
      }
      return result.rows[0] as T;
    },
  };
}

// ── db.shared(userId) ─────────────────────────────────────────────────────────
/**
 * Like scoped(), but sharedQuery() also includes rows shared with the user
 * via the `shares` table.
 *
 * Usage for "my items + items shared with me":
 *   const db = shared(req.user.id);
 *   const { rows } = await db.sharedQuery(
 *     'SELECT i.* FROM items i WHERE i.id = $1 /*scope*\/',
 *     [id],
 *     'item',
 *   );
 */
export function shared(userId: string): SharedDb {
  const base = scoped(userId);
  return {
    ...base,

    async sharedQuery<T extends pg.QueryResultRow = Record<string, any>>(
      sql: string,
      values: unknown[] = [],
      entityType?: string,
    ) {
      // Strip /*scope*/ and instead use an OR join against the shares table
      const { sql: stripped, values: baseValues } = stripScope(sql, values, userId);

      const offset = baseValues.length;
      const entityFilter = entityType
        ? `AND s.entity_type = $${offset + 2}`
        : '';
      const extraValues: unknown[] = entityType
        ? [userId, entityType]
        : [userId];

      // Wrap the original query as a CTE and union with shared rows
      const wrappedSql = `
        WITH owned AS (${stripped}),
        shared_ids AS (
          SELECT entity_id
          FROM shares s
          WHERE s.shared_with_user_id = $${offset + 1}
            AND s.deleted_at IS NULL
            ${entityFilter}
        )
        SELECT * FROM owned
        UNION
        SELECT t.* FROM (${stripped}) t
        WHERE t.id IN (SELECT entity_id FROM shared_ids)
      `;

      return pool.query<T>(wrappedSql, [...baseValues, ...extraValues]);
    },
  };
}

// ── db.admin() ────────────────────────────────────────────────────────────────
/**
 * Unrestricted pool access for migrations, crons, and system-level queries.
 * NEVER expose this on request handlers.
 */
export const admin = {
  query<T extends pg.QueryResultRow = Record<string, any>>(sql: string, values?: unknown[]) {
    return pool.query<T>(sql, values);
  },
  transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(fn);
  },
};

// ── Transaction helper ────────────────────────────────────────────────────────
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
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

// ── Scope injection helpers ───────────────────────────────────────────────────

function injectScope(
  sql: string,
  values: unknown[],
  userId: string,
): { sql: string; values: unknown[] } {
  if (!sql.includes('/*scope*/')) {
    return { sql, values };
  }
  const idx = values.length + 1;
  const rewritten = sql.replace(
    '/*scope*/',
    `AND user_id = $${idx} AND deleted_at IS NULL`,
  );
  return { sql: rewritten, values: [...values, userId] };
}

function stripScope(
  sql: string,
  values: unknown[],
  userId: string,
): { sql: string; values: unknown[] } {
  // Convert /*scope*/ into an explicit filter (needed for CTE wrapping)
  return injectScope(sql, values, userId);
}

export const db = { scoped, shared, admin, withTransaction };
