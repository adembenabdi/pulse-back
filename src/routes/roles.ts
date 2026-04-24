/**
 * Roles routes
 *
 * GET    /api/roles          list my roles
 * POST   /api/roles          create role
 * PATCH  /api/roles/:id      update role
 * PATCH  /api/roles/reorder  bulk reorder (array of {id, sort_order})
 * DELETE /api/roles/:id      soft-delete
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const rolesRouter: Router = Router();
rolesRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const createSchema = z.object({
  name:              z.string().min(1).max(100),
  color:             z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  icon:              z.string().max(50).optional(),
  weekly_focus_min:  z.number().int().min(0).max(10080).default(0),
  sort_order:        z.number().int().default(0),
});

const updateSchema = createSchema.partial().extend({
  is_active: z.boolean().optional(),
});

const reorderSchema = z.array(z.object({
  id:         z.string().uuid(),
  sort_order: z.number().int(),
}));

// ── GET / ─────────────────────────────────────────────────────────────────────
rolesRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT * FROM roles WHERE TRUE /*scope*/
       ORDER BY sort_order, created_at`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────
rolesRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO roles (user_id, name, color, icon, weekly_focus_min, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.user.id, body.name, body.color, body.icon ?? null, body.weekly_focus_min, body.sort_order],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /reorder — must be before /:id ─────────────────────────────────────
rolesRouter.patch('/reorder', async (req, res, next) => {
  try {
    const items = reorderSchema.parse(req.body);
    for (const { id, sort_order } of items) {
      await req.db.query(
        `UPDATE roles SET sort_order = $1 WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
        [sort_order, id, req.user.id],
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────
rolesRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (body.name             !== undefined) { fields.push(`name = $${i++}`);             values.push(body.name); }
    if (body.color            !== undefined) { fields.push(`color = $${i++}`);            values.push(body.color); }
    if (body.icon             !== undefined) { fields.push(`icon = $${i++}`);             values.push(body.icon); }
    if (body.weekly_focus_min !== undefined) { fields.push(`weekly_focus_min = $${i++}`); values.push(body.weekly_focus_min); }
    if (body.sort_order       !== undefined) { fields.push(`sort_order = $${i++}`);       values.push(body.sort_order); }
    if (body.is_active        !== undefined) { fields.push(`is_active = $${i++}`);        values.push(body.is_active); }
    if (!fields.length) throw new AppError(400, 'Nothing to update');

    values.push(req.params['id'], req.user.id);
    const { rows, rowCount } = await req.db.query(
      `UPDATE roles SET ${fields.join(', ')}
       WHERE id = $${i} AND user_id = $${i + 1} AND deleted_at IS NULL
       RETURNING *`,
      values,
    );
    if (!rowCount) throw new AppError(404, 'Role not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
rolesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE roles SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Role not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
