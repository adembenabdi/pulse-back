/**
 * lib/entities.ts — Universal entity registry
 *
 * Defines every linkable entity type in Pulse, maps each to its DB table and
 * display columns, and provides helpers for:
 *   - resolveEntities()     — bulk-fetch preview rows for a mixed list of refs
 *   - validateEntityRef()   — confirm a user owns an entity before linking
 */

import { admin }   from './db.js';
import { AppError } from '../middleware/error.js';

// ── Entity types ──────────────────────────────────────────────────────────────

export const ENTITY_TYPES = [
  'item',
  'idea',
  'objective',
  'calendar_item',
  'habit',
  'recipe',
  'meal_plan',
  'study_session',
  'gym_session',
  'transaction',
  'freelance_gig',
  'freelance_client',
  'resource',
  'person',        // maps to connections / users table
] as const;

export type EntityType = typeof ENTITY_TYPES[number];

export function isEntityType(val: unknown): val is EntityType {
  return typeof val === 'string' && (ENTITY_TYPES as readonly string[]).includes(val);
}

// ── Table map ─────────────────────────────────────────────────────────────────

interface EntityMeta {
  /** Postgres table name */
  table: string;
  /** Column to use as display title */
  titleCol: string;
  /** Optional subtitle / description column (null if none) */
  subtitleCol: string | null;
  /** Optional ISO timestamp column for "when" context */
  dateCol: string | null;
  /** Column holding owner user_id. null = table has no user_id (join table) */
  ownerCol: string | null;
  /** Frontend href pattern — :id is replaced at runtime */
  href: string;
}

export const ENTITY_TABLE_MAP: Record<EntityType, EntityMeta> = {
  item: {
    table:       'items',
    titleCol:    'title',
    subtitleCol: 'notes',
    dateCol:     'due_at',
    ownerCol:    'user_id',
    href:        '/tasks?id=:id',
  },
  idea: {
    table:       'ideas',
    titleCol:    'title',
    subtitleCol: 'description',
    dateCol:     'created_at',
    ownerCol:    'user_id',
    href:        '/ideas?id=:id',
  },
  objective: {
    table:       'objectives',
    titleCol:    'title',
    subtitleCol: 'kind',
    dateCol:     'target_date',
    ownerCol:    'user_id',
    href:        '/objectives?id=:id',
  },
  calendar_item: {
    table:       'calendar_items',
    titleCol:    'title',
    subtitleCol: 'description',
    dateCol:     'starts_at',
    ownerCol:    'user_id',
    href:        '/calendar?id=:id',
  },
  habit: {
    table:       'habits',
    titleCol:    'title',
    subtitleCol: null,
    dateCol:     'created_at',
    ownerCol:    'user_id',
    href:        '/habits?id=:id',
  },
  recipe: {
    table:       'recipes',
    titleCol:    'title',
    subtitleCol: 'description',
    dateCol:     'created_at',
    ownerCol:    'user_id',
    href:        '/meals?recipe=:id',
  },
  meal_plan: {
    table:       'meal_plans',
    titleCol:    'title',
    subtitleCol: null,
    dateCol:     null,
    ownerCol:    'user_id',
    href:        '/meals?plan=:id',
  },
  study_session: {
    table:       'study_sessions',
    titleCol:    'topic',
    subtitleCol: 'notes',
    dateCol:     'started_at',
    ownerCol:    'user_id',
    href:        '/study?session=:id',
  },
  gym_session: {
    table:       'gym_sessions',
    titleCol:    'note',
    subtitleCol: null,
    dateCol:     'started_at',
    ownerCol:    'user_id',
    href:        '/sport?session=:id',
  },
  transaction: {
    table:       'transactions',
    titleCol:    'description',
    subtitleCol: 'kind',
    dateCol:     'created_at',
    ownerCol:    'user_id',
    href:        '/money?tx=:id',
  },
  freelance_gig: {
    table:       'freelance_gigs',
    titleCol:    'title',
    subtitleCol: 'status',
    dateCol:     'started_on',
    ownerCol:    'user_id',
    href:        '/freelance?gig=:id',
  },
  freelance_client: {
    table:       'freelance_clients',
    titleCol:    'name',
    subtitleCol: 'company',
    dateCol:     'created_at',
    ownerCol:    'user_id',
    href:        '/freelance?client=:id',
  },
  resource: {
    table:       'resources',
    titleCol:    'title',
    subtitleCol: 'url',
    dateCol:     'created_at',
    ownerCol:    'user_id',
    href:        '/study?resource=:id',
  },
  person: {
    // "person" maps to the connections table (peer_id → users)
    // We expose the peer's display_name as title.
    table:       'connections',
    titleCol:    'peer_id',   // resolved as sub-query in resolveEntities
    subtitleCol: null,
    dateCol:     'created_at',
    ownerCol:    'user_id',
    href:        '/connections?id=:id',
  },
};

// ── EntityPreview ─────────────────────────────────────────────────────────────

export interface EntityPreview {
  type:       EntityType;
  id:         string;
  title:      string;
  subtitle:   string | null;
  date:       string | null;
  href:       string;
}

// ── resolveEntities ───────────────────────────────────────────────────────────
/**
 * Batch-resolve previews for a mixed list of entity refs.
 * Groups refs by type → one query per table → parallelized.
 * Refs with no match (deleted / not found) are silently omitted.
 */
export async function resolveEntities(
  userId: string,
  refs: Array<{ type: EntityType; id: string }>,
): Promise<Map<string, EntityPreview>> {
  if (refs.length === 0) return new Map();

  // Group by type
  const groups = new Map<EntityType, string[]>();
  for (const { type, id } of refs) {
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)!.push(id);
  }

  const result = new Map<string, EntityPreview>();

  await Promise.all(
    [...groups.entries()].map(async ([type, ids]) => {
      const meta = ENTITY_TABLE_MAP[type];
      if (!meta.ownerCol) return; // skip un-owned tables (shouldn't be referenced directly)

      // Special case: person → join connections + users
      if (type === 'person') {
        const { rows } = await admin.query<{
          id: string; full_name: string | null; email: string; created_at: string
        }>(
          `SELECT c.id, u.full_name, u.email, c.created_at::TEXT
           FROM   connections c
           JOIN   users u ON u.id = c.peer_id
           WHERE  c.user_id = $1 AND c.id = ANY($2::uuid[])`,
          [userId, ids],
        );
        for (const r of rows) {
          const key = `${type}:${r.id}`;
          result.set(key, {
            type,
            id:       r.id,
            title:    r.full_name ?? r.email,
            subtitle: r.email,
            date:     r.created_at,
            href:     `/connections?id=${r.id}`,
          });
        }
        return;
      }

      const titleSql   = meta.titleCol;
      const subSql     = meta.subtitleCol ? `${meta.subtitleCol}::TEXT` : 'NULL';
      const dateSql    = meta.dateCol     ? `${meta.dateCol}::TEXT`     : 'NULL';

      // Tables without deleted_at (gym_sessions, study_sessions, transactions, etc.)
      // must not include a deleted_at filter — we only filter by owner
      const TABLES_WITH_DELETED_AT = new Set([
        'items', 'ideas', 'objectives', 'calendar_items', 'habits', 'recipes',
        'meal_plans', 'resources', 'freelance_gigs', 'freelance_clients', 'roles',
      ]);
      const deletedClause = TABLES_WITH_DELETED_AT.has(meta.table)
        ? 'AND deleted_at IS NULL'
        : '';

      const { rows } = await admin.query<{
        id: string; title: string; subtitle: string | null; date: string | null
      }>(
        `SELECT id,
                ${titleSql}::TEXT   AS title,
                ${subSql}           AS subtitle,
                ${dateSql}          AS date
         FROM   ${meta.table}
         WHERE  ${meta.ownerCol} = $1
           AND  id = ANY($2::uuid[])
           ${deletedClause}`,
        [userId, ids],
      );

      for (const r of rows) {
        const key = `${type}:${r.id}`;
        result.set(key, {
          type,
          id:       r.id,
          title:    r.title ?? '(untitled)',
          subtitle: r.subtitle?.slice(0, 120) ?? null,
          date:     r.date,
          href:     meta.href.replace(':id', r.id),
        });
      }
    }),
  );

  return result;
}

// ── validateEntityRef ─────────────────────────────────────────────────────────
/**
 * Confirms that `userId` owns the given entity.
 * Throws AppError(404) if not found / not owned.
 */
export async function validateEntityRef(
  userId: string,
  type:   EntityType,
  id:     string,
): Promise<void> {
  const meta = ENTITY_TABLE_MAP[type];
  if (!meta.ownerCol) {
    throw new AppError(400, `Entity type "${type}" cannot be directly referenced`);
  }

  if (type === 'person') {
    const { rows } = await admin.query(
      `SELECT 1 FROM connections WHERE user_id = $1 AND id = $2`,
      [userId, id],
    );
    if (!rows.length) throw new AppError(404, `Person ${id} not found`);
    return;
  }

  const { rows } = await admin.query(
    `SELECT 1 FROM ${meta.table} WHERE ${meta.ownerCol} = $1 AND id = $2`,
    [userId, id],
  );
  if (!rows.length) {
    throw new AppError(404, `${type} ${id} not found`);
  }
}
