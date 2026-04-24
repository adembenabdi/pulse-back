/**
 * Items routes (tasks | commitments | asks | notes)
 *
 * POST   /api/items                  create
 * GET    /api/items                  list (filters: kind, status, role_id, objective_id, due_before, tag)
 * GET    /api/items/inbox            today's tasks + overdue
 * GET    /api/items/week             tasks due this week
 * GET    /api/items/shared           items shared with me
 * GET    /api/items/:id              detail (+ deps + tags + links)
 * PATCH  /api/items/:id              update
 * DELETE /api/items/:id              soft-delete
 *
 * POST   /api/items/:id/complete     mark done (status=done, records completed_at)
 * POST   /api/items/:id/reopen       reopen (status=todo)
 *
 * POST   /api/items/:id/tags         add tags (array of tag ids or names)
 * DELETE /api/items/:id/tags/:tagId  remove tag
 *
 * POST   /api/items/:id/deps         add dependency
 * DELETE /api/items/:id/deps/:depId  remove dependency
 *
 * -- Tags CRUD --
 * GET    /api/items/tags             list my tags
 * POST   /api/items/tags             create tag
 * DELETE /api/items/tags/:id         delete tag
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { checkAccess, type ShareEntity } from '../lib/shares.js';
import type { ScopedDb } from '../lib/db.js';

export const itemsRouter: Router = Router();
itemsRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const createSchema = z.object({
  kind:             z.enum(['task', 'commitment', 'ask', 'note']).default('task'),
  title:            z.string().min(1).max(500),
  notes:            z.string().optional(),
  status:           z.enum(['todo', 'in_progress', 'done', 'cancelled']).default('todo'),
  priority:         z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
  energy_required:  z.enum(['high', 'medium', 'low']).optional(),
  due_at:           z.string().datetime().optional(),
  starts_at:        z.string().datetime().optional(),
  recurrence:       z.string().max(200).optional(),
  role_id:          z.string().uuid().optional(),
  objective_id:     z.string().uuid().optional(),
  peer_id:          z.string().uuid().optional(),
  peer_name:        z.string().max(200).optional(),
  estimated_min:    z.number().int().min(1).max(480).optional(),
  tag_ids:          z.array(z.string().uuid()).optional(),
});

const updateSchema = createSchema.partial();

const tagCreateSchema = z.object({
  name:  z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const addTagsSchema = z.object({
  tags: z.array(z.union([
    z.string().uuid(),         // existing tag id
    z.object({ name: z.string().min(1).max(50), color: z.string().optional() }), // new tag
  ])),
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getItemOrThrow(db: ScopedDb, id: string, userId: string) {
  const { rows } = await db.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM items WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (!rows.length) throw new AppError(404, 'Item not found');
  return rows[0]!;
}

// ── Tag helpers ───────────────────────────────────────────────────────────────
// GET /tags
itemsRouter.get('/tags', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT * FROM tags WHERE user_id = $1 ORDER BY name`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /tags
itemsRouter.post('/tags', async (req, res, next) => {
  try {
    const body = tagCreateSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO tags (user_id, name, color)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, name) DO UPDATE SET color = EXCLUDED.color
       RETURNING *`,
      [req.user.id, body.name, body.color ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /tags/:id
itemsRouter.delete('/tags/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `DELETE FROM tags WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Tag not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Inbox views ───────────────────────────────────────────────────────────────
// GET /inbox — today + overdue, not done/cancelled
itemsRouter.get('/inbox', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT i.*,
              r.name AS role_name, r.color AS role_color,
              o.title AS objective_title
       FROM   items i
       LEFT JOIN roles r ON r.id = i.role_id
       LEFT JOIN objectives o ON o.id = i.objective_id
       WHERE  i.user_id = $1
         AND  i.deleted_at IS NULL
         AND  i.status NOT IN ('done', 'cancelled')
         AND  (i.due_at <= NOW() + INTERVAL '1 day' OR i.due_at IS NULL)
       ORDER BY
         CASE i.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         i.due_at NULLS LAST, i.created_at`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /week — due this week
itemsRouter.get('/week', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT i.*,
              r.name AS role_name, r.color AS role_color,
              o.title AS objective_title
       FROM   items i
       LEFT JOIN roles r ON r.id = i.role_id
       LEFT JOIN objectives o ON o.id = i.objective_id
       WHERE  i.user_id = $1
         AND  i.deleted_at IS NULL
         AND  i.status NOT IN ('done', 'cancelled')
         AND  i.due_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
       ORDER BY i.due_at, CASE i.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /shared — items shared with me
itemsRouter.get('/shared', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT i.*,
              u.name AS owner_name, u.avatar_url AS owner_avatar,
              s.permission,
              r.name AS role_name, r.color AS role_color
       FROM   shares s
       JOIN   items i ON i.id = s.entity_id AND i.deleted_at IS NULL
       LEFT JOIN users u ON u.id = i.user_id
       LEFT JOIN roles r ON r.id = i.role_id
       WHERE  s.entity_type = 'item'
         AND  s.shared_with_user_id = $1
         AND  s.deleted_at IS NULL
       ORDER BY i.updated_at DESC`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET / — list with filters ─────────────────────────────────────────────────
itemsRouter.get('/', async (req, res, next) => {
  try {
    const { kind, status, role_id, objective_id, tag, due_before, due_after, limit = '50', offset = '0' } = req.query as Record<string, string>;

    const conditions: string[] = [`i.user_id = $1`, `i.deleted_at IS NULL`];
    const values: unknown[] = [req.user.id];
    let p = 2;

    if (kind)         { conditions.push(`i.kind = $${p++}`);                              values.push(kind); }
    if (status)       { conditions.push(`i.status = $${p++}`);                            values.push(status); }
    if (role_id)      { conditions.push(`i.role_id = $${p++}`);                           values.push(role_id); }
    if (objective_id) { conditions.push(`i.objective_id = $${p++}`);                      values.push(objective_id); }
    if (due_before)   { conditions.push(`i.due_at <= $${p++}`);                           values.push(due_before); }
    if (due_after)    { conditions.push(`i.due_at >= $${p++}`);                           values.push(due_after); }
    if (tag)          { conditions.push(`EXISTS (SELECT 1 FROM item_tags it JOIN tags tg ON tg.id = it.tag_id WHERE it.item_id = i.id AND tg.name = $${p++})`); values.push(tag); }

    const { rows } = await req.db.query(
      `SELECT i.*,
              r.name AS role_name, r.color AS role_color,
              o.title AS objective_title,
              COALESCE(
                json_agg(DISTINCT jsonb_build_object('id', tg.id, 'name', tg.name, 'color', tg.color))
                FILTER (WHERE tg.id IS NOT NULL), '[]'
              ) AS tags
       FROM   items i
       LEFT JOIN roles r      ON r.id = i.role_id
       LEFT JOIN objectives o ON o.id = i.objective_id
       LEFT JOIN item_tags it ON it.item_id = i.id
       LEFT JOIN tags tg      ON tg.id = it.tag_id
       WHERE  ${conditions.join(' AND ')}
       GROUP  BY i.id, r.name, r.color, o.title
       ORDER  BY
         CASE i.status WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
         CASE i.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         i.due_at NULLS LAST
       LIMIT  $${p} OFFSET $${p + 1}`,
      [...values, Number(limit), Number(offset)],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────
itemsRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);

    const { rows } = await req.db.query<{ id: string }>(
      `INSERT INTO items (user_id, kind, title, notes, status, priority, energy_required,
                          due_at, starts_at, recurrence, role_id, objective_id,
                          peer_id, peer_name, estimated_min)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        req.user.id, body.kind, body.title, body.notes ?? null, body.status,
        body.priority, body.energy_required ?? null,
        body.due_at ?? null, body.starts_at ?? null, body.recurrence ?? null,
        body.role_id ?? null, body.objective_id ?? null,
        body.peer_id ?? null, body.peer_name ?? null, body.estimated_min ?? null,
      ],
    );
    const item = rows[0]!;

    // Attach tags if provided
    if (body.tag_ids?.length) {
      for (const tagId of body.tag_ids) {
        await req.db.query(
          `INSERT INTO item_tags (item_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [item.id, tagId],
        );
      }
    }

    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
itemsRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows: [item] } = await req.db.query(
      `SELECT i.*,
              r.name AS role_name, r.color AS role_color,
              o.title AS objective_title
       FROM   items i
       LEFT JOIN roles r      ON r.id = i.role_id
       LEFT JOIN objectives o ON o.id = i.objective_id
       WHERE  i.id = $1 AND i.deleted_at IS NULL`,
      [id],
    );

    if (!item) throw new AppError(404, 'Item not found');

    // Check: owner or has share
    if ((item as Record<string, unknown>)['user_id'] !== req.user.id) {
      await checkAccess(req.user.id, 'item' as ShareEntity, id!, 'view');
    }

    const [{ rows: tags }, { rows: deps }, { rows: links }] = await Promise.all([
      req.db.query(
        `SELECT tg.* FROM item_tags it JOIN tags tg ON tg.id = it.tag_id WHERE it.item_id = $1`,
        [id],
      ),
      req.db.query(
        `SELECT di.id, di.title, di.status, di.priority
         FROM   item_dependencies id2
         JOIN   items di ON di.id = id2.depends_on_id
         WHERE  id2.item_id = $1 AND di.deleted_at IS NULL`,
        [id],
      ),
      req.db.query(
        `SELECT * FROM item_links WHERE item_id = $1`,
        [id],
      ),
    ]);

    res.json({ ...item, tags, dependencies: deps, links });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────
itemsRouter.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await getItemOrThrow(req.db, id!, req.user.id);
    const body = updateSchema.parse(req.body);

    const col: Record<string, unknown> = {};
    if (body.title            !== undefined) col['title']            = body.title;
    if (body.notes            !== undefined) col['notes']            = body.notes;
    if (body.status           !== undefined) col['status']           = body.status;
    if (body.priority         !== undefined) col['priority']         = body.priority;
    if (body.energy_required  !== undefined) col['energy_required']  = body.energy_required;
    if (body.due_at           !== undefined) col['due_at']           = body.due_at;
    if (body.starts_at        !== undefined) col['starts_at']        = body.starts_at;
    if (body.recurrence       !== undefined) col['recurrence']       = body.recurrence;
    if (body.role_id          !== undefined) col['role_id']          = body.role_id;
    if (body.objective_id     !== undefined) col['objective_id']     = body.objective_id;
    if (body.peer_id          !== undefined) col['peer_id']          = body.peer_id;
    if (body.peer_name        !== undefined) col['peer_name']        = body.peer_name;
    if (body.estimated_min    !== undefined) col['estimated_min']    = body.estimated_min;

    const keys = Object.keys(col);
    if (!keys.length) throw new AppError(400, 'Nothing to update');

    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [id, ...Object.values(col)];

    const { rows } = await req.db.query(
      `UPDATE items SET ${fields} WHERE id = $1 AND user_id = $${keys.length + 2} AND deleted_at IS NULL RETURNING *`,
      [...values, req.user.id],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
itemsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE items SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Item not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/complete ────────────────────────────────────────────────────────
itemsRouter.post('/:id/complete', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE items SET status = 'done', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Item not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/reopen ──────────────────────────────────────────────────────────
itemsRouter.post('/:id/reopen', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE items SET status = 'todo', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Item not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/tags ────────────────────────────────────────────────────────────
itemsRouter.post('/:id/tags', async (req, res, next) => {
  try {
    const { id } = req.params;
    await getItemOrThrow(req.db, id!, req.user.id);
    const { tags } = addTagsSchema.parse(req.body);

    const attached: unknown[] = [];
    for (const t of tags) {
      let tagId: string;
      if (typeof t === 'string') {
        tagId = t;
      } else {
        const { rows } = await req.db.query<{ id: string }>(
          `INSERT INTO tags (user_id, name, color) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, name) DO UPDATE SET color = COALESCE(EXCLUDED.color, tags.color)
           RETURNING id`,
          [req.user.id, t.name, t.color ?? null],
        );
        tagId = rows[0]!.id;
      }
      await req.db.query(
        `INSERT INTO item_tags (item_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, tagId],
      );
      attached.push(tagId);
    }
    res.json({ ok: true, attached });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id/tags/:tagId ───────────────────────────────────────────────────
itemsRouter.delete('/:id/tags/:tagId', async (req, res, next) => {
  try {
    const { id, tagId } = req.params;
    await getItemOrThrow(req.db, id!, req.user.id);
    await req.db.query(
      `DELETE FROM item_tags WHERE item_id = $1 AND tag_id = $2`,
      [id, tagId],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/deps ────────────────────────────────────────────────────────────
itemsRouter.post('/:id/deps', async (req, res, next) => {
  try {
    const { id } = req.params;
    await getItemOrThrow(req.db, id!, req.user.id);
    const { depends_on_id } = z.object({ depends_on_id: z.string().uuid() }).parse(req.body);
    if (depends_on_id === id) throw new AppError(400, 'Item cannot depend on itself');

    await req.db.query(
      `INSERT INTO item_dependencies (item_id, depends_on_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, depends_on_id],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id/deps/:depId ───────────────────────────────────────────────────
itemsRouter.delete('/:id/deps/:depId', async (req, res, next) => {
  try {
    const { id, depId } = req.params;
    await getItemOrThrow(req.db, id!, req.user.id);
    await req.db.query(
      `DELETE FROM item_dependencies WHERE item_id = $1 AND depends_on_id = $2`,
      [id, depId],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
