/**
 * Objectives routes (goal | learning_goal | project | venture)
 *
 * POST   /api/objectives               create
 * GET    /api/objectives               list (filters: kind, status, role_id)
 * GET    /api/objectives/:id           detail (+ milestones, steps, members, reviews)
 * PATCH  /api/objectives/:id           update
 * DELETE /api/objectives/:id           soft-delete
 *
 * POST   /api/objectives/:id/complete  mark complete
 * PATCH  /api/objectives/:id/progress  update progress %
 *
 * Milestones
 * POST   /api/objectives/:id/milestones
 * PATCH  /api/objectives/:id/milestones/:mid
 * DELETE /api/objectives/:id/milestones/:mid
 * POST   /api/objectives/:id/milestones/:mid/complete
 *
 * Steps (learning paths)
 * POST   /api/objectives/:id/steps
 * PATCH  /api/objectives/:id/steps/:sid
 * DELETE /api/objectives/:id/steps/:sid
 * POST   /api/objectives/:id/steps/reorder
 * POST   /api/objectives/:id/steps/:sid/complete
 *
 * Members (ventures)
 * POST   /api/objectives/:id/members   add member (with equity_pct)
 * PATCH  /api/objectives/:id/members/:uid
 * DELETE /api/objectives/:id/members/:uid
 *
 * Reviews (cadence check-ins)
 * GET    /api/objectives/:id/reviews
 * POST   /api/objectives/:id/reviews
 * PATCH  /api/objectives/:id/reviews/:rid
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const objectivesRouter: Router = Router();
objectivesRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const createSchema = z.object({
  kind:        z.enum(['goal', 'learning_goal', 'project', 'venture']).default('goal'),
  title:       z.string().min(1).max(500),
  description: z.string().optional(),
  status:      z.enum(['todo', 'in_progress', 'done', 'cancelled']).default('todo'),
  priority:    z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
  cadence:     z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']).optional(),
  why:         z.string().optional(),
  progress:    z.number().int().min(0).max(100).default(0),
  starts_on:   z.string().date().optional(),
  target_date: z.string().date().optional(),
  role_id:     z.string().uuid().optional(),
  is_public:   z.boolean().default(false),
});

const updateSchema = createSchema.partial();

const milestoneSchema = z.object({
  title:      z.string().min(1).max(500),
  due_date:   z.string().date().optional(),
  sort_order: z.number().int().default(0),
});

const stepSchema = z.object({
  title:        z.string().min(1).max(500),
  description:  z.string().optional(),
  resource_url: z.string().url().optional(),
  duration_min: z.number().int().min(1).optional(),
  sort_order:   z.number().int().default(0),
});

const memberSchema = z.object({
  user_id:    z.string().uuid(),
  role:       z.string().default('member'),
  equity_pct: z.number().min(0).max(100).optional(),
});

const reviewSchema = z.object({
  review_date:  z.string().date(),
  progress:     z.number().int().min(0).max(100).optional(),
  reflection:   z.string().optional(),
  next_actions: z.string().optional(),
  mood:         z.number().int().min(1).max(5).optional(),
});

// ── GET / ─────────────────────────────────────────────────────────────────────
objectivesRouter.get('/', async (req, res, next) => {
  try {
    const { kind, status, role_id, limit = '50', offset = '0' } = req.query as Record<string, string>;

    const conditions: string[] = [`o.user_id = $1`, `o.deleted_at IS NULL`];
    const values: unknown[] = [req.user.id];
    let p = 2;

    if (kind)    { conditions.push(`o.kind = $${p++}`);    values.push(kind); }
    if (status)  { conditions.push(`o.status = $${p++}`);  values.push(status); }
    if (role_id) { conditions.push(`o.role_id = $${p++}`); values.push(role_id); }

    const { rows } = await req.db.query(
      `SELECT o.*,
              r.name AS role_name, r.color AS role_color,
              (SELECT COUNT(*) FROM items WHERE objective_id = o.id AND deleted_at IS NULL AND status NOT IN ('done','cancelled')) AS open_items,
              (SELECT COUNT(*) FROM objective_milestones WHERE objective_id = o.id AND deleted_at IS NULL AND completed_at IS NULL) AS open_milestones
       FROM   objectives o
       LEFT JOIN roles r ON r.id = o.role_id
       WHERE  ${conditions.join(' AND ')}
       ORDER BY
         CASE o.status WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
         o.target_date NULLS LAST, o.created_at DESC
       LIMIT  $${p} OFFSET $${p + 1}`,
      [...values, Number(limit), Number(offset)],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────
objectivesRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO objectives
         (user_id, kind, title, description, status, priority, cadence, why,
          progress, starts_on, target_date, role_id, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        req.user.id, body.kind, body.title, body.description ?? null,
        body.status, body.priority, body.cadence ?? null, body.why ?? null,
        body.progress, body.starts_on ?? null, body.target_date ?? null,
        body.role_id ?? null, body.is_public,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
objectivesRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [obj] } = await req.db.query(
      `SELECT o.*, r.name AS role_name, r.color AS role_color
       FROM objectives o LEFT JOIN roles r ON r.id = o.role_id
       WHERE o.id = $1 AND o.user_id = $2 AND o.deleted_at IS NULL`,
      [id, req.user.id],
    );
    if (!obj) throw new AppError(404, 'Objective not found');

    const [{ rows: milestones }, { rows: steps }, { rows: members }, { rows: items }] = await Promise.all([
      req.db.query(
        `SELECT * FROM objective_milestones WHERE objective_id = $1 AND deleted_at IS NULL ORDER BY sort_order`,
        [id],
      ),
      req.db.query(
        `SELECT * FROM objective_steps WHERE objective_id = $1 AND deleted_at IS NULL ORDER BY sort_order`,
        [id],
      ),
      req.db.query(
        `SELECT om.*, u.name, u.email, u.avatar_url
         FROM objective_members om JOIN users u ON u.id = om.user_id
         WHERE om.objective_id = $1`,
        [id],
      ),
      req.db.query(
        `SELECT id, title, status, priority, due_at, kind
         FROM items WHERE objective_id = $1 AND deleted_at IS NULL ORDER BY due_at NULLS LAST`,
        [id],
      ),
    ]);

    res.json({ ...obj, milestones, steps, members, items });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────
objectivesRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.title       !== undefined) col['title']       = body.title;
    if (body.description !== undefined) col['description'] = body.description;
    if (body.status      !== undefined) col['status']      = body.status;
    if (body.priority    !== undefined) col['priority']    = body.priority;
    if (body.cadence     !== undefined) col['cadence']     = body.cadence;
    if (body.why         !== undefined) col['why']         = body.why;
    if (body.progress    !== undefined) col['progress']    = body.progress;
    if (body.starts_on   !== undefined) col['starts_on']   = body.starts_on;
    if (body.target_date !== undefined) col['target_date'] = body.target_date;
    if (body.role_id     !== undefined) col['role_id']     = body.role_id;
    if (body.is_public   !== undefined) col['is_public']   = body.is_public;

    const keys = Object.keys(col);
    if (!keys.length) throw new AppError(400, 'Nothing to update');
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE objectives SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} AND deleted_at IS NULL
       RETURNING *`,
      [req.params['id'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Objective not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
objectivesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE objectives SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Objective not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/complete ────────────────────────────────────────────────────────
objectivesRouter.post('/:id/complete', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE objectives SET status = 'done', progress = 100, completed_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Objective not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/progress ───────────────────────────────────────────────────────
objectivesRouter.patch('/:id/progress', async (req, res, next) => {
  try {
    const { progress } = z.object({ progress: z.number().int().min(0).max(100) }).parse(req.body);
    const { rowCount } = await req.db.query(
      `UPDATE objectives SET progress = $1
       WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [progress, req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Objective not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── ─────────────────────────────────────────────────────────────────────────
// MILESTONES
// ── ─────────────────────────────────────────────────────────────────────────

objectivesRouter.post('/:id/milestones', async (req, res, next) => {
  try {
    const body = milestoneSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO objective_milestones (objective_id, user_id, title, due_date, sort_order)
       SELECT $1, $2, $3, $4, $5
       WHERE EXISTS (SELECT 1 FROM objectives WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL)
       RETURNING *`,
      [req.params['id'], req.user.id, body.title, body.due_date ?? null, body.sort_order],
    );
    if (!rows.length) throw new AppError(404, 'Objective not found');
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

objectivesRouter.patch('/:id/milestones/:mid', async (req, res, next) => {
  try {
    const body = milestoneSchema.partial().parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.title      !== undefined) col['title']      = body.title;
    if (body.due_date   !== undefined) col['due_date']   = body.due_date;
    if (body.sort_order !== undefined) col['sort_order'] = body.sort_order;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE objective_milestones SET ${fields}
       WHERE id = $1 AND objective_id = $${keys.length + 2} AND user_id = $${keys.length + 3} AND deleted_at IS NULL
       RETURNING *`,
      [req.params['mid'], ...Object.values(col), req.params['id'], req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Milestone not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

objectivesRouter.delete('/:id/milestones/:mid', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE objective_milestones SET deleted_at = NOW()
       WHERE id = $1 AND objective_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [req.params['mid'], req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

objectivesRouter.post('/:id/milestones/:mid/complete', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE objective_milestones SET completed_at = NOW()
       WHERE id = $1 AND objective_id = $2 AND user_id = $3`,
      [req.params['mid'], req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── ─────────────────────────────────────────────────────────────────────────
// STEPS (learning paths)
// ── ─────────────────────────────────────────────────────────────────────────

objectivesRouter.post('/:id/steps', async (req, res, next) => {
  try {
    const body = stepSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO objective_steps (objective_id, user_id, title, description, resource_url, duration_min, sort_order)
       SELECT $1, $2, $3, $4, $5, $6, $7
       WHERE EXISTS (SELECT 1 FROM objectives WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL)
       RETURNING *`,
      [req.params['id'], req.user.id, body.title, body.description ?? null, body.resource_url ?? null, body.duration_min ?? null, body.sort_order],
    );
    if (!rows.length) throw new AppError(404, 'Objective not found');
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

objectivesRouter.patch('/:id/steps/:sid', async (req, res, next) => {
  try {
    const body = stepSchema.partial().parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.title        !== undefined) col['title']        = body.title;
    if (body.description  !== undefined) col['description']  = body.description;
    if (body.resource_url !== undefined) col['resource_url'] = body.resource_url;
    if (body.duration_min !== undefined) col['duration_min'] = body.duration_min;
    if (body.sort_order   !== undefined) col['sort_order']   = body.sort_order;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE objective_steps SET ${fields}
       WHERE id = $1 AND objective_id = $${keys.length + 2} AND user_id = $${keys.length + 3} AND deleted_at IS NULL
       RETURNING *`,
      [req.params['sid'], ...Object.values(col), req.params['id'], req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Step not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

objectivesRouter.delete('/:id/steps/:sid', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE objective_steps SET deleted_at = NOW()
       WHERE id = $1 AND objective_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [req.params['sid'], req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

objectivesRouter.post('/:id/steps/reorder', async (req, res, next) => {
  try {
    const items = z.array(z.object({ id: z.string().uuid(), sort_order: z.number().int() })).parse(req.body);
    for (const { id, sort_order } of items) {
      await req.db.query(
        `UPDATE objective_steps SET sort_order = $1 WHERE id = $2 AND objective_id = $3 AND user_id = $4`,
        [sort_order, id, req.params['id'], req.user.id],
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

objectivesRouter.post('/:id/steps/:sid/complete', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE objective_steps SET completed_at = NOW()
       WHERE id = $1 AND objective_id = $2 AND user_id = $3`,
      [req.params['sid'], req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── ─────────────────────────────────────────────────────────────────────────
// MEMBERS (ventures: co-founders with equity)
// ── ─────────────────────────────────────────────────────────────────────────

objectivesRouter.post('/:id/members', async (req, res, next) => {
  try {
    const body = memberSchema.parse(req.body);
    await req.db.query(
      `INSERT INTO objective_members (objective_id, user_id, role, equity_pct)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (objective_id, user_id) DO UPDATE SET role = EXCLUDED.role, equity_pct = EXCLUDED.equity_pct`,
      [req.params['id'], body.user_id, body.role, body.equity_pct ?? null],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

objectivesRouter.patch('/:id/members/:uid', async (req, res, next) => {
  try {
    const body = memberSchema.partial().parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.role       !== undefined) col['role']       = body.role;
    if (body.equity_pct !== undefined) col['equity_pct'] = body.equity_pct;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await req.db.query(
      `UPDATE objective_members SET ${fields}
       WHERE objective_id = $1 AND user_id = $${keys.length + 2}`,
      [req.params['id'], ...Object.values(col), req.params['uid']],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

objectivesRouter.delete('/:id/members/:uid', async (req, res, next) => {
  try {
    // Only owner can remove; can't remove self if owner
    const { rowCount } = await req.db.query(
      `SELECT 1 FROM objectives WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(403, 'Only objective owner can remove members');

    await req.db.query(
      `DELETE FROM objective_members WHERE objective_id = $1 AND user_id = $2`,
      [req.params['id'], req.params['uid']],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── ─────────────────────────────────────────────────────────────────────────
// REVIEWS (cadence check-ins)
// ── ─────────────────────────────────────────────────────────────────────────

objectivesRouter.get('/:id/reviews', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT * FROM objective_reviews
       WHERE objective_id = $1 AND user_id = $2
       ORDER BY review_date DESC`,
      [req.params['id'], req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

objectivesRouter.post('/:id/reviews', async (req, res, next) => {
  try {
    const body = reviewSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO objective_reviews (objective_id, user_id, review_date, progress, reflection, next_actions, mood)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.params['id'], req.user.id, body.review_date, body.progress ?? null, body.reflection ?? null, body.next_actions ?? null, body.mood ?? null],
    );
    // Auto-update objective progress if provided
    if (body.progress !== undefined) {
      await req.db.query(
        `UPDATE objectives SET progress = $1 WHERE id = $2 AND user_id = $3`,
        [body.progress, req.params['id'], req.user.id],
      );
    }
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

objectivesRouter.patch('/:id/reviews/:rid', async (req, res, next) => {
  try {
    const body = reviewSchema.partial().parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.progress     !== undefined) col['progress']     = body.progress;
    if (body.reflection   !== undefined) col['reflection']   = body.reflection;
    if (body.next_actions !== undefined) col['next_actions'] = body.next_actions;
    if (body.mood         !== undefined) col['mood']         = body.mood;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE objective_reviews SET ${fields}
       WHERE id = $1 AND objective_id = $${keys.length + 2} AND user_id = $${keys.length + 3}
       RETURNING *`,
      [req.params['rid'], ...Object.values(col), req.params['id'], req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Review not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
