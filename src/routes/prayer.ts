/**
 * Prayer tracker routes (Suivi de Prière)
 *
 * GET  /api/prayer/today          today's 5 prayers with completion state
 * GET  /api/prayer/history        range grouped by date (?from=&to=)
 * GET  /api/prayer/streak         current consecutive all-5-completed streak
 * POST /api/prayer/toggle         toggle/log a prayer for a date
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';

export const prayerRouter: Router = Router();
prayerRouter.use(requireAuth);

const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;

const toggleSchema = z.object({
  prayer:    z.enum(PRAYERS),
  date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  completed: z.boolean().optional(),
});

function mergeDay(date: string, rows: { prayer: string; completed: boolean; prayed_at: string | null }[]) {
  const byName = new Map(rows.map((r) => [r.prayer, r]));
  return {
    date,
    prayers: PRAYERS.map((p) => ({
      prayer: p,
      completed: byName.get(p)?.completed ?? false,
      prayed_at: byName.get(p)?.prayed_at ?? null,
    })),
    completed_count: PRAYERS.filter((p) => byName.get(p)?.completed).length,
  };
}

// GET /today
prayerRouter.get('/today', async (req, res, next) => {
  try {
    const { rows } = await req.db.query<{ prayer: string; completed: boolean; prayed_at: string | null }>(
      `SELECT prayer, completed, prayed_at FROM prayer_logs
       WHERE user_id = $1 AND prayed_date = CURRENT_DATE`,
      [req.user.id],
    );
    const today = new Date().toISOString().slice(0, 10);
    res.json(mergeDay(today, rows));
  } catch (err) {
    next(err);
  }
});

// GET /history?from=&to=
prayerRouter.get('/history', async (req, res, next) => {
  try {
    const from = typeof req.query['from'] === 'string' ? req.query['from'] : null;
    const to   = typeof req.query['to'] === 'string' ? req.query['to'] : null;
    const { rows } = await req.db.query<{ prayed_date: string; prayer: string; completed: boolean; prayed_at: string | null }>(
      `SELECT to_char(prayed_date, 'YYYY-MM-DD') AS prayed_date, prayer, completed, prayed_at
       FROM prayer_logs
       WHERE user_id = $1
         AND prayed_date >= COALESCE($2::date, CURRENT_DATE - INTERVAL '30 days')
         AND prayed_date <= COALESCE($3::date, CURRENT_DATE)
       ORDER BY prayed_date DESC`,
      [req.user.id, from, to],
    );
    const byDate = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byDate.get(r.prayed_date) ?? [];
      list.push(r);
      byDate.set(r.prayed_date, list);
    }
    res.json([...byDate.entries()].map(([date, list]) => mergeDay(date, list)));
  } catch (err) {
    next(err);
  }
});

// GET /streak — consecutive days (ending today/yesterday) with all 5 completed
prayerRouter.get('/streak', async (req, res, next) => {
  try {
    const { rows } = await req.db.query<{ prayed_date: string; n: string }>(
      `SELECT to_char(prayed_date, 'YYYY-MM-DD') AS prayed_date,
              COUNT(*) FILTER (WHERE completed) AS n
       FROM prayer_logs
       WHERE user_id = $1 AND prayed_date >= CURRENT_DATE - INTERVAL '365 days'
       GROUP BY prayed_date
       ORDER BY prayed_date DESC`,
      [req.user.id],
    );
    const fullDays = new Set(rows.filter((r) => Number(r.n) >= 5).map((r) => r.prayed_date));
    let streak = 0;
    const cursor = new Date();
    // allow today to be incomplete without breaking the streak
    if (!fullDays.has(cursor.toISOString().slice(0, 10))) cursor.setDate(cursor.getDate() - 1);
    while (fullDays.has(cursor.toISOString().slice(0, 10))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    res.json({ streak });
  } catch (err) {
    next(err);
  }
});

// POST /toggle
prayerRouter.post('/toggle', async (req, res, next) => {
  try {
    const body = toggleSchema.parse(req.body);
    const completed = body.completed ?? true;
    const { rows } = await req.db.query(
      `INSERT INTO prayer_logs (user_id, prayer, prayed_date, completed, prayed_at)
       VALUES ($1, $2::prayer_name, $3::date, $4, CASE WHEN $4 THEN now() ELSE NULL END)
       ON CONFLICT (user_id, prayer, prayed_date)
       DO UPDATE SET completed = EXCLUDED.completed,
                     prayed_at = CASE WHEN EXCLUDED.completed THEN now() ELSE NULL END
       RETURNING prayer, to_char(prayed_date, 'YYYY-MM-DD') AS prayed_date, completed, prayed_at`,
      [req.user.id, body.prayer, body.date, completed],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
