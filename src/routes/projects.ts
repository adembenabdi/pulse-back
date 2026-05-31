/**
 * Projects routes
 *
 * GET    /api/projects            list (with task counts + progress)
 * POST   /api/projects            create
 * GET    /api/projects/:id        detail (+ tasks)
 * PATCH  /api/projects/:id        update
 * DELETE /api/projects/:id        soft-delete (cascades tasks via FK on hard delete only;
 *                                  here we soft-delete the project + its tasks)
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const projectsRouter: Router = Router();
projectsRouter.use(requireAuth);

const createSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  status:      z.enum(['active', 'archived']).optional(),
});
const updateSchema = createSchema.partial();

// GET / — list with progress
projectsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT p.*,
              COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL)                       AS task_count,
              COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'done') AS done_count
       FROM   projects p
       LEFT JOIN tasks t ON t.project_id = p.id
       WHERE  p.user_id = $1 AND p.deleted_at IS NULL
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST / — create
projectsRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO projects (user_id, name, description, color, status)
       VALUES ($1, $2, $3, COALESCE($4, '#7c5cff'), COALESCE($5, 'active'))
       RETURNING *`,
      [req.user.id, body.name, body.description ?? null, body.color ?? null, body.status ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /:id — detail + tasks
projectsRouter.get('/:id', async (req, res, next) => {
  try {
    const project = await req.db.queryOne(
      `SELECT * FROM projects WHERE id = $1 /*scope*/`,
      [req.params['id']],
    );
    const { rows: tasks } = await req.db.query(
      `SELECT * FROM tasks
       WHERE project_id = $1 AND user_id = $2 AND deleted_at IS NULL
       ORDER BY sort_order, created_at`,
      [req.params['id'], req.user.id],
    );
    const total = tasks.length;
    const done = tasks.filter((t) => t['status'] === 'done').length;
    res.json({ ...project, tasks, task_count: total, done_count: done });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id
projectsRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, val] of Object.entries(body)) {
      if (val === undefined) continue;
      fields.push(`${key} = $${i++}`);
      values.push(val);
    }
    if (fields.length === 0) throw new AppError(400, 'No fields to update');
    fields.push(`updated_at = now()`);
    values.push(req.params['id'], req.user.id);
    const { rows } = await req.db.query(
      `UPDATE projects SET ${fields.join(', ')}
       WHERE id = $${i++} AND user_id = $${i} AND deleted_at IS NULL
       RETURNING *`,
      values,
    );
    if (!rows.length) throw new AppError(404, 'Project not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — soft-delete project + its tasks
projectsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE projects SET deleted_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Project not found');
    await req.db.query(
      `UPDATE tasks SET deleted_at = now()
       WHERE project_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
