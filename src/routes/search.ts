/**
 * routes/search.ts — global search across all major entity types
 *
 * GET /api/search?q=<text>&types=tasks,ideas,objectives,events,resources,transactions&limit=20&expand=links
 *   Returns results grouped by entity type, each with:
 *   { type, id, title, subtitle, href, created_at, related[] }
 *
 * GET /api/search/graph?q=<text>
 *   Returns a mini subgraph of matching nodes + their direct neighbors.
 */

import { Router }       from 'express';
import { z }            from 'zod';
import { requireAuth }  from '../middleware/auth.js';
import { resolveEntities, type EntityType } from '../lib/entities.js';

export const searchRouter: Router = Router();
searchRouter.use(requireAuth);

const VALID_TYPES = ['tasks', 'ideas', 'objectives', 'events', 'resources', 'transactions', 'habits', 'notes'] as const;
type SearchType = typeof VALID_TYPES[number];

interface SearchResult {
  type:       SearchType;
  id:         string;
  title:      string;
  subtitle:   string | null;
  /** Alias of `subtitle` kept for clients that expect `snippet`. */
  snippet:    string | null;
  href:       string;
  created_at: string;
  /** First-degree related entities from entity_links_unified (populated when expand=links) */
  related:    RelatedLink[];
}

interface RelatedLink {
  direction:    'out' | 'in';
  relation:     string;
  entity_type:  string;
  entity_id:    string;
  title:        string;
  href:         string | null;
  source_table: string;
}

function makeResult(r: Omit<SearchResult, 'snippet' | 'related'>): SearchResult {
  return { ...r, snippet: r.subtitle, related: [] };
}

// Search-type → entity_type mapping (for unified view lookups)
const SEARCH_TYPE_TO_ENTITY: Partial<Record<SearchType, EntityType>> = {
  tasks:        'item',
  notes:        'item',
  ideas:        'idea',
  objectives:   'objective',
  events:       'calendar_item',
  resources:    'resource',
  habits:       'habit',
};

// ── GET / ─────────────────────────────────────────────────────────────────────
searchRouter.get('/', async (req, res, next) => {
  try {
    const { q, types, limit, expand } = z.object({
      q:      z.string().min(1).max(200),
      types:  z.string().optional(),
      limit:  z.coerce.number().int().min(1).max(50).default(20),
      expand: z.string().optional().default('links'),
    }).parse(req.query);

    const userId   = req.user.id;
    const lim      = limit;
    const term     = `%${q.toLowerCase()}%`;
    const doExpand = expand === 'links';

    // Which entity types to search
    const requested = types
      ? types.split(',').filter((t): t is SearchType => (VALID_TYPES as readonly string[]).includes(t))
      : [...VALID_TYPES];

    const results: SearchResult[] = [];

    // ── Tasks / Notes (items table) ────────────────────────────────────────
    if (requested.includes('tasks') || requested.includes('notes')) {
      const kinds: string[] = [];
      if (requested.includes('tasks')) kinds.push("'task'", "'commitment'", "'ask'");
      if (requested.includes('notes')) kinds.push("'note'");

      const { rows } = await req.db.query<{
        id: string; title: string; notes: string | null; kind: string; created_at: string
      }>(
        `SELECT id, title, notes, kind, created_at::TEXT
         FROM   items
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  kind IN (${kinds.join(',')})
           AND  (LOWER(title) LIKE $2 OR LOWER(COALESCE(notes,'')) LIKE $2)
         ORDER  BY created_at DESC
         LIMIT  $3`,
        [userId, term, lim],
      );

      for (const r of rows) {
        const type: SearchType = r.kind === 'note' ? 'notes' : 'tasks';
        results.push(makeResult({
          type,
          id:         r.id,
          title:      r.title,
          subtitle:   r.notes?.slice(0, 80) ?? null,
          href:       `/tasks?id=${r.id}`,
          created_at: r.created_at,
        }));
      }
    }

    // ── Ideas ──────────────────────────────────────────────────────────────
    if (requested.includes('ideas')) {
      const { rows } = await req.db.query<{
        id: string; title: string; description: string | null; created_at: string
      }>(
        `SELECT id, title, description, created_at::TEXT
         FROM   ideas
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  (LOWER(title) LIKE $2 OR LOWER(COALESCE(description,'')) LIKE $2)
         ORDER  BY created_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'ideas', id: r.id, title: r.title, subtitle: r.description?.slice(0, 80) ?? null, href: `/ideas?id=${r.id}`, created_at: r.created_at }));
      }
    }

    // ── Objectives ─────────────────────────────────────────────────────────
    if (requested.includes('objectives')) {
      const { rows } = await req.db.query<{
        id: string; title: string; kind: string; created_at: string
      }>(
        `SELECT id, title, kind, created_at::TEXT
         FROM   objectives
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  LOWER(title) LIKE $2
         ORDER  BY created_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'objectives', id: r.id, title: r.title, subtitle: r.kind, href: `/objectives?id=${r.id}`, created_at: r.created_at }));
      }
    }

    // ── Calendar events ────────────────────────────────────────────────────
    if (requested.includes('events')) {
      const { rows } = await req.db.query<{
        id: string; title: string; starts_at: string; created_at: string
      }>(
        `SELECT id, title, starts_at::TEXT, created_at::TEXT
         FROM   calendar_items
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  LOWER(title) LIKE $2
         ORDER  BY starts_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'events', id: r.id, title: r.title, subtitle: r.starts_at, href: `/calendar?id=${r.id}`, created_at: r.created_at }));
      }
    }

    // ── Resources ──────────────────────────────────────────────────────────
    if (requested.includes('resources')) {
      const { rows } = await req.db.query<{
        id: string; title: string | null; url: string; created_at: string
      }>(
        `SELECT id, title, url, created_at::TEXT
         FROM   resources
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  (LOWER(COALESCE(title,'')) LIKE $2 OR LOWER(url) LIKE $2)
         ORDER  BY created_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'resources', id: r.id, title: r.title ?? r.url, subtitle: r.url, href: `/study?resource=${r.id}`, created_at: r.created_at }));
      }
    }

    // ── Transactions ───────────────────────────────────────────────────────
    if (requested.includes('transactions')) {
      const { rows } = await req.db.query<{
        id: string; description: string | null; amount: string; kind: string; created_at: string
      }>(
        `SELECT id, description, amount::TEXT, kind, created_at::TEXT
         FROM   transactions
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  LOWER(COALESCE(description,'')) LIKE $2
         ORDER  BY created_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'transactions', id: r.id, title: r.description ?? `${r.kind} ${r.amount}`, subtitle: `${r.kind} · ${r.amount}`, href: `/money?tx=${r.id}`, created_at: r.created_at }));
      }
    }

    // ── Habits ─────────────────────────────────────────────────────────────
    if (requested.includes('habits')) {
      const { rows } = await req.db.query<{
        id: string; title: string; created_at: string
      }>(
        `SELECT id, title, created_at::TEXT
         FROM   habits
         WHERE  user_id = $1 AND deleted_at IS NULL AND LOWER(title) LIKE $2
         ORDER  BY created_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'habits', id: r.id, title: r.title, subtitle: null, href: `/habits?id=${r.id}`, created_at: r.created_at }));
      }
    }

    // Sort combined results by relevance (exact match first, then recency)
    const ranked = results
      .sort((a, b) => {
        const aExact = a.title.toLowerCase() === q.toLowerCase() ? 0 : 1;
        const bExact = b.title.toLowerCase() === q.toLowerCase() ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        return b.created_at.localeCompare(a.created_at);
      })
      .slice(0, lim);

    // ── Related expansion (first-degree neighbors from unified view) ───────
    if (doExpand && ranked.length > 0) {
      // Build one big OR query for all matched entity refs
      const refs = ranked
        .map(r => ({ type: SEARCH_TYPE_TO_ENTITY[r.type], id: r.id }))
        .filter((r): r is { type: EntityType; id: string } => r.type !== undefined);

      if (refs.length > 0) {
        // Fetch neighbors using a VALUES list
        const valuePlaceholders = refs.map((_, i) => `($${i * 2 + 2}::text, $${i * 2 + 3}::uuid)`).join(', ');
        const params: unknown[] = [userId];
        for (const r of refs) { params.push(r.type, r.id); }

        const { rows: neighborRows } = await req.db.query<{
          source_type: string; source_id: string;
          target_type: string; target_id: string;
          relation: string; source_table: string;
        }>(
          `WITH anchors(entity_type, entity_id) AS (
             VALUES ${valuePlaceholders}
           )
           SELECT u.source_type, u.source_id, u.target_type, u.target_id,
                  u.relation, u.source_table
           FROM entity_links_unified u
           JOIN anchors a ON
             (u.source_type = a.entity_type AND u.source_id = a.entity_id)
             OR (u.target_type = a.entity_type AND u.target_id = a.entity_id)
           WHERE u.user_id = $1
           LIMIT 200`,
          params,
        );

        // Resolve neighbor entity previews
        const neighborRefs = neighborRows.flatMap(r => [
          { type: r.source_type as EntityType, id: r.source_id },
          { type: r.target_type as EntityType, id: r.target_id },
        ]);
        const previews = await resolveEntities(userId, neighborRefs);

        // Attach related to each matched result
        for (const result of ranked) {
          const entityType = SEARCH_TYPE_TO_ENTITY[result.type];
          if (!entityType) continue;

          for (const nr of neighborRows) {
            let direction: 'out' | 'in' | null = null;
            let neighborType: string = '';
            let neighborId: string   = '';

            if (nr.source_type === entityType && nr.source_id === result.id) {
              direction    = 'out';
              neighborType = nr.target_type;
              neighborId   = nr.target_id;
            } else if (nr.target_type === entityType && nr.target_id === result.id) {
              direction    = 'in';
              neighborType = nr.source_type;
              neighborId   = nr.source_id;
            }

            if (!direction) continue;

            const preview = previews.get(`${neighborType}:${neighborId}`);
            result.related.push({
              direction,
              relation:    nr.relation,
              entity_type: neighborType,
              entity_id:   neighborId,
              title:       preview?.title ?? '(untitled)',
              href:        preview?.href  ?? null,
              source_table: nr.source_table,
            });
          }
        }
      }
    }

    res.json({ query: q, results: ranked, total: ranked.length });
  } catch (err) { next(err); }
});

// ── GET /graph — search results as a mini subgraph ───────────────────────────

searchRouter.get('/graph', async (req, res, next) => {
  try {
    const { q, limit } = z.object({
      q:     z.string().min(1).max(200),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);

    const userId = req.user.id;
    const term   = `%${q.toLowerCase()}%`;

    // Find matching entities across all main tables
    const { rows: matchRows } = await req.db.query<{
      entity_type: string; id: string; title: string
    }>(
      `SELECT 'item' AS entity_type, id, title FROM items
        WHERE user_id = $1 AND deleted_at IS NULL AND LOWER(title) LIKE $2
       UNION ALL
       SELECT 'idea', id, title FROM ideas
        WHERE user_id = $1 AND deleted_at IS NULL AND (LOWER(title) LIKE $2 OR LOWER(COALESCE(description,'')) LIKE $2)
       UNION ALL
       SELECT 'objective', id, title FROM objectives
        WHERE user_id = $1 AND deleted_at IS NULL AND LOWER(title) LIKE $2
       UNION ALL
       SELECT 'habit', id, title FROM habits
        WHERE user_id = $1 AND deleted_at IS NULL AND LOWER(title) LIKE $2
       UNION ALL
       SELECT 'resource', id, COALESCE(title, url) FROM resources
        WHERE user_id = $1 AND deleted_at IS NULL AND (LOWER(COALESCE(title,'')) LIKE $2 OR LOWER(url) LIKE $2)
       LIMIT $3`,
      [userId, term, limit],
    );

    if (matchRows.length === 0) {
      return res.json({ query: q, nodes: [], edges: [], node_count: 0, edge_count: 0 });
    }

    // Fetch direct neighbors for all matched nodes
    const valuePlaceholders = matchRows.map((_, i) => `($${i * 2 + 2}::text, $${i * 2 + 3}::uuid)`).join(', ');
    const params: unknown[] = [userId];
    for (const r of matchRows) { params.push(r.entity_type, r.id); }

    const { rows: edgeRows } = await req.db.query<{
      source_type: string; source_id: string;
      target_type: string; target_id: string;
      relation: string; source_table: string; link_id: string | null;
    }>(
      `WITH anchors(entity_type, entity_id) AS (VALUES ${valuePlaceholders})
       SELECT u.source_type, u.source_id, u.target_type, u.target_id,
              u.relation, u.source_table, u.link_id
       FROM entity_links_unified u
       JOIN anchors a ON
         (u.source_type = a.entity_type AND u.source_id = a.entity_id)
         OR (u.target_type = a.entity_type AND u.target_id = a.entity_id)
       WHERE u.user_id = $1
       LIMIT 200`,
      params,
    );

    // Build nodes
    const nodeMap = new Map<string, { type: string; id: string; title: string; matched: boolean }>();
    for (const r of matchRows) {
      nodeMap.set(`${r.entity_type}:${r.id}`, { type: r.entity_type, id: r.id, title: r.title, matched: true });
    }
    // Resolve neighbor previews
    const neighborRefs = edgeRows.flatMap(e => [
      { type: e.source_type as EntityType, id: e.source_id },
      { type: e.target_type as EntityType, id: e.target_id },
    ]);
    const previews = await resolveEntities(userId, neighborRefs);
    for (const e of edgeRows) {
      for (const [key, { type, id }] of [[`${e.source_type}:${e.source_id}`, { type: e.source_type, id: e.source_id }], [`${e.target_type}:${e.target_id}`, { type: e.target_type, id: e.target_id }]] as const) {
        if (!nodeMap.has(key)) {
          const preview = previews.get(key);
          nodeMap.set(key, { type, id, title: preview?.title ?? '(untitled)', matched: false });
        }
      }
    }

    const nodes = [...nodeMap.entries()].map(([nodeKey, n]) => ({
      id:       nodeKey,
      type:     n.type,
      entityId: n.id,
      title:    n.title,
      matched:  n.matched,
      href:     previews.get(nodeKey)?.href ?? null,
    }));

    const edges = edgeRows.map(e => ({
      id:           e.link_id ?? `${e.source_type}:${e.source_id}→${e.target_type}:${e.target_id}`,
      source:       `${e.source_type}:${e.source_id}`,
      target:       `${e.target_type}:${e.target_id}`,
      relation:     e.relation,
      source_table: e.source_table,
    }));

    res.json({ query: q, nodes, edges, node_count: nodes.length, edge_count: edges.length });
  } catch (err) { next(err); }
});
