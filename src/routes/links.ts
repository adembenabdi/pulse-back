/**
 * routes/links.ts — Universal entity relationship API
 *
 * POST   /api/links                        Create a link between two entities
 * GET    /api/links                        List links for an entity (with depth)
 * GET    /api/links/graph                  Graph subgraph for React Flow
 * GET    /api/links/suggestions            Pending AI link suggestions
 * POST   /api/links/suggestions/:id/accept Accept a suggestion → entity_links
 * POST   /api/links/suggestions/:id/dismiss Dismiss a suggestion
 * PATCH  /api/links/:id                   Update relation / label / metadata
 * DELETE /api/links/:id                   Delete a link (entity_links only)
 */

import { Router }             from 'express';
import { z }                  from 'zod';
import { requireAuth }        from '../middleware/auth.js';
import { admin }              from '../lib/db.js';
import { AppError }           from '../middleware/error.js';
import {
  isEntityType,
  resolveEntities,
  validateEntityRef,
  ENTITY_TYPES,
  type EntityType,
}                             from '../lib/entities.js';
import { bulkAutoLink }       from '../services/ai/bulk-auto-link.js';

export const linksRouter: Router = Router();
linksRouter.use(requireAuth);

// ── Shared schemas ────────────────────────────────────────────────────────────

const RELATIONS = [
  'depends_on', 'blocks', 'contributes_to', 'uses',
  'related_to', 'references', 'mentions_person', 'custom',
] as const;
type Relation = typeof RELATIONS[number];

const entityRefSchema = z.object({
  type: z.string().refine(isEntityType, { message: `type must be one of: ${ENTITY_TYPES.join(', ')}` }),
  id:   z.string().uuid(),
});

// ── Row types ─────────────────────────────────────────────────────────────────

interface LinkRow {
  id:          string;
  user_id:     string;
  source_type: string;
  source_id:   string;
  target_type: string;
  target_id:   string;
  relation:    string;
  label:       string | null;
  weight:      number;
  metadata:    Record<string, unknown>;
  created_by:  string;
  created_at:  string;
  updated_at:  string;
}

interface UnifiedRow {
  user_id:      string;
  source_type:  string;
  source_id:    string;
  target_type:  string;
  target_id:    string;
  relation:     string;
  label:        string | null;
  weight:       number;
  metadata:     Record<string, unknown>;
  created_by:   string;
  created_at:   string;
  source_table: string;
  link_id:      string | null;
}

// ── POST / — create a link ────────────────────────────────────────────────────

linksRouter.post('/', async (req, res, next) => {
  try {
    const body = z.object({
      source:   entityRefSchema,
      target:   entityRefSchema,
      relation: z.enum(RELATIONS).default('related_to'),
      label:    z.string().max(200).optional(),
      metadata: z.record(z.unknown()).default({}),
    }).parse(req.body);

    if (body.relation === 'custom' && !body.label?.trim()) {
      throw new AppError(400, 'label is required when relation is "custom"');
    }

    const userId = req.user.id;

    // Reject self-links before hitting the DB constraint
    if (body.source.type === body.target.type && body.source.id === body.target.id) {
      throw new AppError(400, 'Cannot link an entity to itself');
    }

    // Validate both ends are owned by this user
    await Promise.all([
      validateEntityRef(userId, body.source.type as EntityType, body.source.id),
      validateEntityRef(userId, body.target.type as EntityType, body.target.id),
    ]);

    const { rows } = await admin.query<LinkRow>(
      `INSERT INTO entity_links
         (user_id, source_type, source_id, target_type, target_id, relation, label, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, source_type, source_id, target_type, target_id, relation) DO UPDATE
         SET label      = EXCLUDED.label,
             metadata   = EXCLUDED.metadata,
             updated_at = now()
       RETURNING *`,
      [
        userId,
        body.source.type, body.source.id,
        body.target.type, body.target.id,
        body.relation,
        body.label ?? null,
        JSON.stringify(body.metadata),
      ],
    );

    const link = rows[0]!;

    // Resolve previews for both ends
    const previews = await resolveEntities(userId, [
      { type: link.source_type as EntityType, id: link.source_id },
      { type: link.target_type as EntityType, id: link.target_id },
    ]);

    res.status(201).json({
      link,
      source_preview: previews.get(`${link.source_type}:${link.source_id}`) ?? null,
      target_preview: previews.get(`${link.target_type}:${link.target_id}`) ?? null,
    });
  } catch (err) { next(err); }
});

// ── GET / — list links for an entity ─────────────────────────────────────────

linksRouter.get('/', async (req, res, next) => {
  try {
    const query = z.object({
      entity_type: z.string().refine(isEntityType),
      entity_id:   z.string().uuid(),
      direction:   z.enum(['any', 'in', 'out']).default('any'),
      relation:    z.string().optional(),
      depth:       z.coerce.number().int().min(1).max(3).default(1),
      limit:       z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);

    const userId = req.user.id;
    const { entity_type, entity_id, direction, relation, depth, limit } = query;

    if (depth === 1) {
      // Direct query on unified view
      const conditions: string[] = ['user_id = $1'];
      const params: unknown[] = [userId];
      let p = 2;

      const outCond = `(source_type = $${p} AND source_id = $${p + 1})`;
      const inCond  = `(target_type = $${p} AND target_id = $${p + 1})`;
      params.push(entity_type, entity_id);
      p += 2;

      if (direction === 'out')  conditions.push(outCond);
      else if (direction === 'in')   conditions.push(inCond);
      else                           conditions.push(`(${outCond} OR ${inCond})`);

      if (relation) {
        conditions.push(`relation = $${p}`);
        params.push(relation);
        p++;
      }

      conditions.push(`LIMIT $${p}`);
      params.push(limit);

      const { rows } = await admin.query<UnifiedRow>(
        `SELECT * FROM entity_links_unified
         WHERE ${conditions.slice(0, -1).join(' AND ')}
         ORDER BY created_at DESC
         LIMIT $${p}`,
        params,
      );

      // Resolve all entity previews in one batch
      const refs = rows.flatMap(r => [
        { type: r.source_type as EntityType, id: r.source_id },
        { type: r.target_type as EntityType, id: r.target_id },
      ]);
      const previews = await resolveEntities(userId, refs);

      const enriched = rows.map(r => ({
        ...r,
        source_preview: previews.get(`${r.source_type}:${r.source_id}`) ?? null,
        target_preview: previews.get(`${r.target_type}:${r.target_id}`) ?? null,
      }));

      res.json({ links: enriched, total: enriched.length });
    } else {
      // Multi-hop via recursive CTE on entity_links_unified, depth-capped at 3
      const { rows } = await admin.query<UnifiedRow & { depth: number }>(
        `WITH RECURSIVE graph AS (
           -- Seed: direct neighbors
           SELECT
             source_type, source_id, target_type, target_id,
             relation, label, weight, metadata, created_by,
             created_at, source_table, link_id,
             1 AS depth,
             ARRAY[source_id, target_id] AS visited
           FROM entity_links_unified
           WHERE user_id = $1
             AND (
               (source_type = $2 AND source_id = $3)
               OR (target_type = $2 AND target_id = $3)
             )

           UNION ALL

           -- Expand one hop
           SELECT
             e.source_type, e.source_id, e.target_type, e.target_id,
             e.relation, e.label, e.weight, e.metadata, e.created_by,
             e.created_at, e.source_table, e.link_id,
             g.depth + 1,
             g.visited || e.source_id || e.target_id
           FROM entity_links_unified e
           JOIN graph g ON
             (e.source_type = g.target_type AND e.source_id = g.target_id
              AND NOT (e.target_id = ANY(g.visited)))
             OR
             (e.target_type = g.source_type AND e.target_id = g.source_id
              AND NOT (e.source_id = ANY(g.visited)))
           WHERE e.user_id = $1
             AND g.depth < $4
         )
         SELECT DISTINCT ON (source_type, source_id, target_type, target_id, relation)
           source_type, source_id, target_type, target_id,
           relation, label, weight, metadata, created_by,
           created_at, source_table, link_id, depth,
           $1::uuid AS user_id
         FROM graph
         ORDER BY source_type, source_id, target_type, target_id, relation, depth
         LIMIT $5`,
        [userId, entity_type, entity_id, depth, limit],
      );

      const refs = rows.flatMap(r => [
        { type: r.source_type as EntityType, id: r.source_id },
        { type: r.target_type as EntityType, id: r.target_id },
      ]);
      const previews = await resolveEntities(userId, refs);

      const enriched = rows.map(r => ({
        ...r,
        source_preview: previews.get(`${r.source_type}:${r.source_id}`) ?? null,
        target_preview: previews.get(`${r.target_type}:${r.target_id}`) ?? null,
      }));

      res.json({ links: enriched, total: enriched.length });
    }
  } catch (err) { next(err); }
});

// ── GET /graph — React Flow subgraph ─────────────────────────────────────────

linksRouter.get('/graph', async (req, res, next) => {
  try {
    const query = z.object({
      root_type:  z.string().refine(isEntityType).optional(),
      root_id:    z.string().uuid().optional(),
      depth:      z.coerce.number().int().min(1).max(3).default(2),
      limit:      z.coerce.number().int().min(1).max(200).default(200),
      entity_types: z.string().optional(),  // comma-sep filter
      relations:    z.string().optional(),  // comma-sep filter
      ai_only:    z.coerce.boolean().default(false),
    }).parse(req.query);

    const userId = req.user.id;
    const { root_type, root_id, depth, limit, entity_types, relations, ai_only } = query;

    const typeFilter     = entity_types?.split(',').filter(Boolean) ?? [];
    const relationFilter = relations?.split(',').filter(Boolean)    ?? [];

    let rows: Array<UnifiedRow & { depth?: number }>;

    if (root_type && root_id) {
      // Depth-first neighbourhood from a root node
      const result = await admin.query<UnifiedRow & { depth: number }>(
        `WITH RECURSIVE graph AS (
           SELECT source_type, source_id, target_type, target_id,
                  relation, label, weight, metadata, created_by,
                  created_at, source_table, link_id,
                  1 AS depth,
                  ARRAY[source_id, target_id] AS visited
           FROM entity_links_unified
           WHERE user_id = $1
             AND source_type = $2 AND source_id = $3

           UNION ALL

           SELECT e.source_type, e.source_id, e.target_type, e.target_id,
                  e.relation, e.label, e.weight, e.metadata, e.created_by,
                  e.created_at, e.source_table, e.link_id,
                  g.depth + 1,
                  g.visited || e.source_id || e.target_id
           FROM entity_links_unified e
           JOIN graph g ON e.source_type = g.target_type
                        AND e.source_id = g.target_id
                        AND NOT (e.target_id = ANY(g.visited))
           WHERE e.user_id = $1 AND g.depth < $4
         )
         SELECT DISTINCT source_type, source_id, target_type, target_id,
                relation, label, weight, metadata::jsonb, created_by,
                created_at, source_table, link_id, depth,
                $1::uuid AS user_id
         FROM graph
         LIMIT $5`,
        [userId, root_type, root_id, depth, limit],
      );
      rows = result.rows;
    } else {
      // Full user graph (no root) — return recent edges up to limit
      const result = await admin.query<UnifiedRow>(
        `SELECT *
         FROM entity_links_unified
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit],
      );
      rows = result.rows;
    }

    // Apply filters
    if (typeFilter.length) {
      rows = rows.filter(r =>
        typeFilter.includes(r.source_type) || typeFilter.includes(r.target_type),
      );
    }
    if (relationFilter.length) {
      rows = rows.filter(r => relationFilter.includes(r.relation));
    }
    if (ai_only) {
      rows = rows.filter(r => r.created_by === 'ai');
    }

    // Build unique node set
    const nodeMap = new Map<string, { type: string; id: string }>();
    for (const r of rows) {
      nodeMap.set(`${r.source_type}:${r.source_id}`, { type: r.source_type, id: r.source_id });
      nodeMap.set(`${r.target_type}:${r.target_id}`, { type: r.target_type, id: r.target_id });
    }

    // Resolve all node previews
    const refs = [...nodeMap.values()].map(n => ({ type: n.type as EntityType, id: n.id }));
    const previews = await resolveEntities(userId, refs);

    const nodes = [...nodeMap.values()].map(n => {
      const preview = previews.get(`${n.type}:${n.id}`);
      return {
        id:       `${n.type}:${n.id}`,
        type:     n.type,
        entityId: n.id,
        title:    preview?.title    ?? '(untitled)',
        subtitle: preview?.subtitle ?? null,
        href:     preview?.href     ?? null,
      };
    });

    const edges = rows.map(r => ({
      id:           r.link_id ?? `${r.source_type}:${r.source_id}→${r.target_type}:${r.target_id}`,
      source:       `${r.source_type}:${r.source_id}`,
      target:       `${r.target_type}:${r.target_id}`,
      relation:     r.relation,
      label:        r.label,
      source_table: r.source_table,
      created_by:   r.created_by,
    }));

    res.json({
      nodes,
      edges,
      node_count: nodes.length,
      edge_count: edges.length,
    });
  } catch (err) { next(err); }
});

// ── PATCH /:id — update link ──────────────────────────────────────────────────

linksRouter.patch('/:id', async (req, res, next) => {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body    = z.object({
      relation: z.enum(RELATIONS).optional(),
      label:    z.string().max(200).nullable().optional(),
      metadata: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const userId = req.user.id;

    // Verify ownership
    const { rows: existing } = await admin.query<LinkRow>(
      `SELECT * FROM entity_links WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!existing.length) throw new AppError(404, 'Link not found');

    const merged = {
      relation: body.relation ?? existing[0]!.relation,
      label:    body.label !== undefined ? body.label : existing[0]!.label,
      metadata: body.metadata ? JSON.stringify(body.metadata) : JSON.stringify(existing[0]!.metadata),
    };

    if (merged.relation === 'custom' && !merged.label?.trim()) {
      throw new AppError(400, 'label is required when relation is "custom"');
    }

    const { rows } = await admin.query<LinkRow>(
      `UPDATE entity_links SET relation = $3, label = $4, metadata = $5
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId, merged.relation, merged.label, merged.metadata],
    );

    res.json(rows[0]!);
  } catch (err) { next(err); }
});

// ── DELETE /:id — delete link ─────────────────────────────────────────────────

linksRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const userId  = req.user.id;

    const { rowCount } = await admin.query(
      `DELETE FROM entity_links WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );

    if (!rowCount) throw new AppError(404, 'Link not found');
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── GET /suggestions — pending AI suggestions ─────────────────────────────────

linksRouter.get('/suggestions', async (req, res, next) => {
  try {
    const query = z.object({
      status:      z.enum(['pending', 'accepted', 'dismissed']).default('pending'),
      source_type: z.string().optional(),
      source_id:   z.string().uuid().optional(),
      limit:       z.coerce.number().int().min(1).max(50).default(20),
    }).parse(req.query);

    const userId = req.user.id;

    const conditions: string[] = ['s.user_id = $1', `s.status = $2`];
    const params: unknown[] = [userId, query.status];
    let p = 3;

    if (query.source_type) {
      conditions.push(`s.source_type = $${p++}`);
      params.push(query.source_type);
    }
    if (query.source_id) {
      conditions.push(`s.source_id = $${p++}`);
      params.push(query.source_id);
    }

    params.push(query.limit);

    const { rows } = await admin.query<{
      id: string; user_id: string; source_type: string; source_id: string;
      target_type: string; target_id: string; relation: string;
      confidence: number; reason: string | null; status: string;
      entity_link_id: string | null; created_at: string;
    }>(
      `SELECT s.*
       FROM link_suggestions s
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.confidence DESC, s.created_at DESC
       LIMIT $${p}`,
      params,
    );

    // Resolve previews
    const refs = rows.flatMap(r => [
      { type: r.source_type as EntityType, id: r.source_id },
      { type: r.target_type as EntityType, id: r.target_id },
    ]);
    const previews = await resolveEntities(userId, refs);

    const enriched = rows.map(r => ({
      ...r,
      source_preview: previews.get(`${r.source_type}:${r.source_id}`) ?? null,
      target_preview: previews.get(`${r.target_type}:${r.target_id}`) ?? null,
    }));

    res.json({ suggestions: enriched, total: enriched.length });
  } catch (err) { next(err); }
});

// ── POST /suggestions/:id/accept ──────────────────────────────────────────────

linksRouter.post('/suggestions/:id/accept', async (req, res, next) => {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const userId  = req.user.id;

    const { rows: sRows } = await admin.query<{
      id: string; source_type: string; source_id: string;
      target_type: string; target_id: string; relation: string; status: string;
    }>(
      `SELECT * FROM link_suggestions WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!sRows.length) throw new AppError(404, 'Suggestion not found');
    const sug = sRows[0]!;
    if (sug.status !== 'pending') {
      throw new AppError(409, `Suggestion is already ${sug.status}`);
    }

    // Promote to entity_links with created_by='ai'
    const { rows: linkRows } = await admin.query<LinkRow>(
      `INSERT INTO entity_links
         (user_id, source_type, source_id, target_type, target_id, relation, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'ai')
       ON CONFLICT (user_id, source_type, source_id, target_type, target_id, relation) DO UPDATE
         SET updated_at = now()
       RETURNING *`,
      [userId, sug.source_type, sug.source_id, sug.target_type, sug.target_id, sug.relation],
    );
    const link = linkRows[0]!;

    // Update suggestion status
    await admin.query(
      `UPDATE link_suggestions SET status = 'accepted', entity_link_id = $3 WHERE id = $1 AND user_id = $2`,
      [id, userId, link.id],
    );

    res.json({ link });
  } catch (err) { next(err); }
});

// ── POST /suggestions/:id/dismiss ────────────────────────────────────────────

linksRouter.post('/suggestions/:id/dismiss', async (req, res, next) => {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const userId  = req.user.id;

    const { rowCount } = await admin.query(
      `UPDATE link_suggestions SET status = 'dismissed'
       WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
      [id, userId],
    );
    if (!rowCount) throw new AppError(404, 'Suggestion not found or already actioned');

    res.status(204).send();
  } catch (err) { next(err); }
});

// ── POST /auto-link — AI bulk auto-link ───────────────────────────────────────
// Scans all the user's entities and creates AI-discovered links automatically.

linksRouter.post('/auto-link', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const result = await bulkAutoLink(userId);
    res.json(result);
  } catch (err) { next(err); }
});
