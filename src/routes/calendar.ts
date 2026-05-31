/**
 * Calendar routes
 *
 * GET    /api/calendar           range view (?from=&to=) — merges events + task deadlines
 * POST   /api/calendar           create event
 * GET    /api/calendar/:id       event detail
 * PATCH  /api/calendar/:id       update event
 * DELETE /api/calendar/:id       soft-delete event
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const calendarRouter: Router = Router();
calendarRouter.use(requireAuth);

const createSchema = z.object({
  title:       z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  location:    z.string().max(300).optional(),
  task_id:     z.string().uuid().nullable().optional(),
  starts_at:   z.string().datetime(),
  ends_at:     z.string().datetime().nullable().optional(),
  all_day:     z.boolean().optional(),
});
const updateSchema = createSchema.partial();

// GET / — events + task deadlines in range
calendarRouter.get('/', async (req, res, next) => {
  try {
    const from = typeof req.query['from'] === 'string' ? req.query['from'] : null;
    const to   = typeof req.query['to'] === 'string' ? req.query['to'] : null;

    const { rows: events } = await req.db.query(
      `SELECT * FROM calendar_events
       WHERE user_id = $1 AND deleted_at IS NULL
         AND starts_at >= COALESCE($2::timestamptz, NOW() - INTERVAL '7 days')
         AND starts_at <= COALESCE($3::timestamptz, NOW() + INTERVAL '30 days')
       ORDER BY starts_at`,
      [req.user.id, from, to],
    );

    const { rows: deadlines } = await req.db.query(
      `SELECT t.id, t.title, t.due_at, t.status, t.priority, p.name AS project_name
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.due_at IS NOT NULL
         AND t.due_at >= COALESCE($2::timestamptz, NOW() - INTERVAL '7 days')
         AND t.due_at <= COALESCE($3::timestamptz, NOW() + INTERVAL '30 days')
       ORDER BY t.due_at`,
      [req.user.id, from, to],
    );

    res.json({ events, deadlines });
  } catch (err) {
    next(err);
  }
});

// POST /
calendarRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO calendar_events
         (user_id, task_id, title, description, location, starts_at, ends_at, all_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, false))
       RETURNING *`,
      [
        req.user.id, body.task_id ?? null, body.title, body.description ?? null,
        body.location ?? null, body.starts_at, body.ends_at ?? null, body.all_day ?? null,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /:id
calendarRouter.get('/:id', async (req, res, next) => {
  try {
    const event = await req.db.queryOne(`SELECT * FROM calendar_events WHERE id = $1 /*scope*/`, [req.params['id']]);
    res.json(event);
  } catch (err) {
    next(err);
  }
});

// PATCH /:id
calendarRouter.patch('/:id', async (req, res, next) => {
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
      `UPDATE calendar_events SET ${fields.join(', ')}
       WHERE id = $${i++} AND user_id = $${i} AND deleted_at IS NULL
       RETURNING *`,
      values,
    );
    if (!rows.length) throw new AppError(404, 'Event not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id
calendarRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE calendar_events SET deleted_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Event not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
