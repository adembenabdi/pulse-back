/**
 * Tasks routes
 *
 * GET    /api/tasks            list (filters: project_id, status, priority,
 *                              parent_task_id, standalone, due_before/after)
 * POST   /api/tasks            create (optional project_id / parent_task_id)
 * GET    /api/tasks/:id        detail (+ subtasks)
 * PATCH  /api/tasks/:id        update (status -> done sets completed_at)
 * POST   /api/tasks/reorder    bulk sort_order update
 * DELETE /api/tasks/:id        soft-delete (+ subtasks)
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const tasksRouter: Router = Router();
tasksRouter.use(requireAuth);

const createSchema = z.object({
  title:          z.string().min(1).max(500),
  notes:          z.string().max(5000).optional(),
  project_id:     z.string().uuid().nullable().optional(),
  parent_task_id: z.string().uuid().nullable().optional(),
  status:         z.enum(['todo', 'in_progress', 'done']).optional(),
  priority:       z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  due_at:         z.string().datetime().nullable().optional(),
  starts_at:      z.string().datetime().nullable().optional(),
  sort_order:     z.number().int().optional(),
});
const updateSchema = createSchema.partial();

const reorderSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), sort_order: z.number().int() })).min(1),
});

// GET / — list with filters
tasksRouter.get('/', async (req, res, next) => {
  try {
    const clauses: string[] = ['user_id = $1', 'deleted_at IS NULL'];
    const values: unknown[] = [req.user.id];
    let i = 2;

    const q = req.query;
    if (typeof q['project_id'] === 'string') { clauses.push(`project_id = $${i++}`); values.push(q['project_id']); }
    if (q['standalone'] === 'true')          { clauses.push(`project_id IS NULL`); }
    if (typeof q['status'] === 'string')     { clauses.push(`status = $${i++}::task_status`); values.push(q['status']); }
    if (typeof q['priority'] === 'string')   { clauses.push(`priority = $${i++}::task_priority`); values.push(q['priority']); }
    if (q['parent_task_id'] === 'null')      { clauses.push(`parent_task_id IS NULL`); }
    else if (typeof q['parent_task_id'] === 'string') { clauses.push(`parent_task_id = $${i++}`); values.push(q['parent_task_id']); }
    if (typeof q['due_before'] === 'string') { clauses.push(`due_at <= $${i++}`); values.push(q['due_before']); }
    if (typeof q['due_after'] === 'string')  { clauses.push(`due_at >= $${i++}`); values.push(q['due_after']); }

    const { rows } = await req.db.query(
      `SELECT * FROM tasks WHERE ${clauses.join(' AND ')}
       ORDER BY sort_order, due_at NULLS LAST, created_at`,
      values,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST / — create
tasksRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO tasks
         (user_id, project_id, parent_task_id, title, notes, status, priority, due_at, starts_at, sort_order)
       VALUES ($1, $2, $3, $4, $5,
               COALESCE($6, 'todo')::task_status,
               COALESCE($7, 'medium')::task_priority,
               $8, $9, COALESCE($10, 0))
       RETURNING *`,
      [
        req.user.id, body.project_id ?? null, body.parent_task_id ?? null,
        body.title, body.notes ?? null, body.status ?? null, body.priority ?? null,
        body.due_at ?? null, body.starts_at ?? null, body.sort_order ?? null,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /reorder
tasksRouter.post('/reorder', async (req, res, next) => {
  try {
    const { items } = reorderSchema.parse(req.body);
    for (const it of items) {
      await req.db.query(
        `UPDATE tasks SET sort_order = $1, updated_at = now()
         WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
        [it.sort_order, it.id, req.user.id],
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /:id — detail + subtasks
tasksRouter.get('/:id', async (req, res, next) => {
  try {
    const task = await req.db.queryOne(`SELECT * FROM tasks WHERE id = $1 /*scope*/`, [req.params['id']]);
    const { rows: subtasks } = await req.db.query(
      `SELECT * FROM tasks
       WHERE parent_task_id = $1 AND user_id = $2 AND deleted_at IS NULL
       ORDER BY sort_order, created_at`,
      [req.params['id'], req.user.id],
    );
    res.json({ ...task, subtasks });
  } catch (err) {
    next(err);
  }
});

// PATCH /:id
tasksRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, val] of Object.entries(body)) {
      if (val === undefined) continue;
      if (key === 'status') {
        fields.push(`status = $${i++}::task_status`);
        values.push(val);
        // sync completed_at with done state
        fields.push(`completed_at = ${val === 'done' ? 'now()' : 'NULL'}`);
      } else if (key === 'priority') {
        fields.push(`priority = $${i++}::task_priority`);
        values.push(val);
      } else {
        fields.push(`${key} = $${i++}`);
        values.push(val);
      }
    }
    if (fields.length === 0) throw new AppError(400, 'No fields to update');
    fields.push(`updated_at = now()`);
    values.push(req.params['id'], req.user.id);
    const { rows } = await req.db.query(
      `UPDATE tasks SET ${fields.join(', ')}
       WHERE id = $${i++} AND user_id = $${i} AND deleted_at IS NULL
       RETURNING *`,
      values,
    );
    if (!rows.length) throw new AppError(404, 'Task not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — soft-delete task + subtasks
tasksRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE tasks SET deleted_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Task not found');
    await req.db.query(
      `UPDATE tasks SET deleted_at = now()
       WHERE parent_task_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
