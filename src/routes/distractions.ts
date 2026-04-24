/**
 * Distractions routes — log focus interruptions, link to active calendar block
 *
 * GET    /api/distractions                list (?date=&cal_item_id=&from=&to=)
 * POST   /api/distractions                log a distraction
 * PATCH  /api/distractions/:id            update
 * DELETE /api/distractions/:id            delete
 * GET    /api/distractions/stats          category breakdown, mood avg, trend
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const distractionsRouter: Router = Router();
distractionsRouter.use(requireAuth);

const distractionSchema = z.object({
  cal_item_id: z.string().uuid().optional(),
  trigger:     z.string().max(500).optional(),
  source:      z.string().max(100).optional(),  // 'phone', 'colleague', 'thought', 'notification'
  category:    z.string().max(100).optional(),
  mood:        z.number().int().min(1).max(5).optional(),
  intentional: z.boolean().default(false),
  logged_at:   z.string().datetime().optional(),
});

distractionsRouter.get('/stats', async (req, res, next) => {
  try {
    const { days = '30' } = req.query as Record<string, string>;
    const { rows } = await req.db.query(
      `SELECT
         COUNT(*)::int                                         AS total,
         COUNT(*) FILTER (WHERE intentional)::int             AS intentional_count,
         ROUND(AVG(mood)::numeric,1)                          AS avg_mood,
         MODE() WITHIN GROUP (ORDER BY source)                AS top_source,
         MODE() WITHIN GROUP (ORDER BY category)              AS top_category
       FROM distractions
       WHERE user_id = $1
         AND logged_at >= NOW() - ($2::text || ' days')::interval`,
      [req.user.id, days],
    );
    // Category breakdown
    const { rows: breakdown } = await req.db.query(
      `SELECT category, COUNT(*)::int AS count
       FROM distractions
       WHERE user_id = $1 AND logged_at >= NOW() - ($2::text || ' days')::interval
         AND category IS NOT NULL
       GROUP BY category ORDER BY count DESC LIMIT 10`,
      [req.user.id, days],
    );
    res.json({ ...(rows[0] ?? {}), breakdown });
  } catch (err) { next(err); }
});

distractionsRouter.get('/', async (req, res, next) => {
  try {
    const { date, cal_item_id, from, to } = req.query as Record<string, string>;
    const vals: unknown[] = [req.user.id];
    let q = `SELECT d.*, c.title AS block_title
             FROM distractions d
             LEFT JOIN calendar_items c ON c.id = d.cal_item_id
             WHERE d.user_id = $1`;
    if (date) {
      vals.push(date);
      q += ` AND DATE(d.logged_at) = $${vals.length}`;
    } else if (from && to) {
      vals.push(from, to);
      q += ` AND d.logged_at BETWEEN $${vals.length - 1} AND $${vals.length}`;
    }
    if (cal_item_id) {
      vals.push(cal_item_id);
      q += ` AND d.cal_item_id = $${vals.length}`;
    }
    q += ` ORDER BY d.logged_at DESC LIMIT 200`;
    const { rows } = await req.db.query(q, vals);
    res.json(rows);
  } catch (err) { next(err); }
});

distractionsRouter.post('/', async (req, res, next) => {
  try {
    const body = distractionSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO distractions
         (user_id, cal_item_id, trigger, source, category, mood, intentional, logged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, body.cal_item_id ?? null, body.trigger ?? null, body.source ?? null,
       body.category ?? null, body.mood ?? null, body.intentional,
       body.logged_at ?? new Date().toISOString()],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

distractionsRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = distractionSchema.partial().parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.trigger     !== undefined) col['trigger']     = body.trigger;
    if (body.source      !== undefined) col['source']      = body.source;
    if (body.category    !== undefined) col['category']    = body.category;
    if (body.mood        !== undefined) col['mood']        = body.mood;
    if (body.intentional !== undefined) col['intentional'] = body.intentional;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE distractions SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} RETURNING *`,
      [req.params['id'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

distractionsRouter.delete('/:id', async (req, res, next) => {
  try {
    await req.db.query(
      `DELETE FROM distractions WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});
