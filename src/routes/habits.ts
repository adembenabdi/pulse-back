/**
 * Habits + routines routes
 *
 * GET    /api/habits                    list all habits
 * POST   /api/habits                    create habit
 * GET    /api/habits/:id                detail + steps
 * PATCH  /api/habits/:id                update habit
 * DELETE /api/habits/:id                soft-delete
 *
 * Steps (for routine-style habits)
 * GET    /api/habits/:id/steps          list steps
 * POST   /api/habits/:id/steps          add step
 * PATCH  /api/habits/:id/steps/:stepId  update step
 * DELETE /api/habits/:id/steps/:stepId  delete step
 * PUT    /api/habits/:id/steps/reorder  reorder (array of ids)
 *
 * Logging
 * POST   /api/habits/:id/log            log for a date (idempotent)
 * DELETE /api/habits/:id/log/:date      un-log a date
 * GET    /api/habits/:id/logs           logs for a date range
 *
 * Streaks
 * GET    /api/habits/streaks            all streaks for the user
 * POST   /api/habits/:id/streak/refresh recompute streak for one habit
 *
 * Challenges
 * GET    /api/habits/challenges              list challenges (own + joined)
 * POST   /api/habits/challenges              create challenge
 * POST   /api/habits/challenges/:id/join     join a challenge
 * GET    /api/habits/challenges/:id          detail + leaderboard
 * DELETE /api/habits/challenges/:id          soft-delete (creator only)
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const habitsRouter: Router = Router();
habitsRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const habitSchema = z.object({
  title:        z.string().min(1).max(300),
  description:  z.string().max(2000).optional(),
  recurrence:   z.string().default('FREQ=DAILY'),
  target_count: z.number().int().min(1).default(1),
  is_routine:   z.boolean().default(false),
  color:        z.string().max(20).optional(),
  icon:         z.string().max(50).optional(),
  role_id:      z.string().uuid().optional(),
});

const stepSchema = z.object({
  title:        z.string().min(1).max(300),
  duration_min: z.number().int().positive().optional(),
  sort_order:   z.number().int().default(0),
});

// ── Habits CRUD ───────────────────────────────────────────────────────────────
habitsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT h.*, r.name AS role_name, r.color AS role_color,
         s.current AS streak_current, s.longest AS streak_longest
       FROM habits h
       LEFT JOIN roles r ON r.id = h.role_id
       LEFT JOIN streaks s ON s.habit_id = h.id AND s.user_id = h.user_id
       WHERE h.user_id = $1 AND h.deleted_at IS NULL
       ORDER BY h.created_at`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

habitsRouter.post('/', async (req, res, next) => {
  try {
    const body = habitSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO habits
         (user_id, role_id, title, description, recurrence, target_count, is_routine, color, icon)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.id, body.role_id ?? null, body.title, body.description ?? null,
       body.recurrence, body.target_count, body.is_routine, body.color ?? null, body.icon ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

habitsRouter.get('/streaks', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT s.*, h.title AS habit_title, h.color AS habit_color
       FROM streaks s
       LEFT JOIN habits h ON h.id = s.habit_id
       WHERE s.user_id = $1
       ORDER BY s.current DESC`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

habitsRouter.get('/challenges', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT hc.*, h.title AS habit_title,
         (SELECT COUNT(*) FROM habit_challenge_participants WHERE challenge_id = hc.id) AS participant_count,
         (SELECT score FROM habit_challenge_participants WHERE challenge_id = hc.id AND user_id = $1 LIMIT 1) AS my_score
       FROM habit_challenges hc
       JOIN habits h ON h.id = hc.habit_id
       WHERE (hc.creator_id = $1
          OR hc.id IN (SELECT challenge_id FROM habit_challenge_participants WHERE user_id = $1))
         AND hc.deleted_at IS NULL
       ORDER BY hc.starts_on DESC`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

habitsRouter.post('/challenges', async (req, res, next) => {
  try {
    const body = z.object({
      habit_id:  z.string().uuid(),
      title:     z.string().min(1).max(300),
      starts_on: z.string().date(),
      ends_on:   z.string().date(),
    }).parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO habit_challenges (creator_id, habit_id, title, starts_on, ends_on)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, body.habit_id, body.title, body.starts_on, body.ends_on],
    );
    // Auto-join creator
    await req.db.query(
      `INSERT INTO habit_challenge_participants (challenge_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [rows[0]!.id, req.user.id],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

habitsRouter.get('/challenges/:id', async (req, res, next) => {
  try {
    const { rows: [challenge] } = await req.db.query(
      `SELECT hc.*, h.title AS habit_title
       FROM habit_challenges hc
       JOIN habits h ON h.id = hc.habit_id
       WHERE hc.id = $1 AND hc.deleted_at IS NULL`,
      [req.params['id']],
    );
    if (!challenge) throw new AppError(404, 'Challenge not found');
    const { rows: participants } = await req.db.query(
      `SELECT p.user_id, p.score, p.joined_at, u.name, u.avatar_url
       FROM habit_challenge_participants p
       JOIN users u ON u.id = p.user_id
       WHERE p.challenge_id = $1
       ORDER BY p.score DESC`,
      [req.params['id']],
    );
    res.json({ ...challenge, participants });
  } catch (err) { next(err); }
});

habitsRouter.post('/challenges/:id/join', async (req, res, next) => {
  try {
    await req.db.query(
      `INSERT INTO habit_challenge_participants (challenge_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

habitsRouter.delete('/challenges/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE habit_challenges SET deleted_at = NOW() WHERE id = $1 AND creator_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(403, 'Not found or not owner');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

habitsRouter.get('/:id', async (req, res, next) => {
  try {
    const { rows: [habit] } = await req.db.query(
      `SELECT h.*, r.name AS role_name, r.color AS role_color
       FROM habits h
       LEFT JOIN roles r ON r.id = h.role_id
       WHERE h.id = $1 AND h.user_id = $2 AND h.deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!habit) throw new AppError(404, 'Habit not found');
    const { rows: steps } = await req.db.query(
      `SELECT * FROM habit_steps WHERE habit_id = $1 ORDER BY sort_order`,
      [req.params['id']],
    );
    res.json({ ...habit, steps });
  } catch (err) { next(err); }
});

habitsRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = habitSchema.partial().parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.title        !== undefined) col['title']        = body.title;
    if (body.description  !== undefined) col['description']  = body.description;
    if (body.recurrence   !== undefined) col['recurrence']   = body.recurrence;
    if (body.target_count !== undefined) col['target_count'] = body.target_count;
    if (body.is_routine   !== undefined) col['is_routine']   = body.is_routine;
    if (body.color        !== undefined) col['color']        = body.color;
    if (body.icon         !== undefined) col['icon']         = body.icon;
    if (body.role_id      !== undefined) col['role_id']      = body.role_id;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE habits SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} AND deleted_at IS NULL RETURNING *`,
      [req.params['id'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Habit not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

habitsRouter.delete('/:id', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE habits SET deleted_at = NOW() WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Habit steps ───────────────────────────────────────────────────────────────
habitsRouter.get('/:id/steps', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT * FROM habit_steps WHERE habit_id = $1 AND user_id = $2 ORDER BY sort_order`,
      [req.params['id'], req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

habitsRouter.post('/:id/steps', async (req, res, next) => {
  try {
    const body = stepSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO habit_steps (habit_id, user_id, title, duration_min, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params['id'], req.user.id, body.title, body.duration_min ?? null, body.sort_order],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

habitsRouter.patch('/:id/steps/:stepId', async (req, res, next) => {
  try {
    const body = stepSchema.partial().parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.title        !== undefined) col['title']        = body.title;
    if (body.duration_min !== undefined) col['duration_min'] = body.duration_min;
    if (body.sort_order   !== undefined) col['sort_order']   = body.sort_order;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE habit_steps SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} RETURNING *`,
      [req.params['stepId'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Step not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

habitsRouter.delete('/:id/steps/:stepId', async (req, res, next) => {
  try {
    await req.db.query(
      `DELETE FROM habit_steps WHERE id = $1 AND user_id = $2`,
      [req.params['stepId'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

habitsRouter.put('/:id/steps/reorder', async (req, res, next) => {
  try {
    const { ids } = z.object({ ids: z.array(z.string().uuid()) }).parse(req.body);
    await Promise.all(ids.map((stepId, i) =>
      req.db.query(
        `UPDATE habit_steps SET sort_order = $1 WHERE id = $2 AND user_id = $3`,
        [i, stepId, req.user.id],
      ),
    ));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Habit logging ─────────────────────────────────────────────────────────────
habitsRouter.post('/:id/log', async (req, res, next) => {
  try {
    const { date = new Date().toISOString().split('T')[0]!, count = 1, note } = z.object({
      date:  z.string().date().optional(),
      count: z.number().int().min(1).optional(),
      note:  z.string().max(1000).optional(),
    }).parse(req.body);

    const { rows } = await req.db.query(
      `INSERT INTO habit_logs (habit_id, user_id, logged_date, count, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (habit_id, user_id, logged_date) DO UPDATE
         SET count = EXCLUDED.count, note = EXCLUDED.note
       RETURNING *`,
      [req.params['id'], req.user.id, date, count, note ?? null],
    );

    // Recompute streak
    await refreshStreak(req.params['id']!, req.user.id, req.db);

    res.json(rows[0]);
  } catch (err) { next(err); }
});

habitsRouter.delete('/:id/log/:date', async (req, res, next) => {
  try {
    await req.db.query(
      `DELETE FROM habit_logs WHERE habit_id = $1 AND user_id = $2 AND logged_date = $3`,
      [req.params['id'], req.user.id, req.params['date']],
    );
    await refreshStreak(req.params['id']!, req.user.id, req.db);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

habitsRouter.get('/:id/logs', async (req, res, next) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const fromDate = from ?? new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0]!;
    const toDate   = to   ?? new Date().toISOString().split('T')[0]!;
    const { rows } = await req.db.query(
      `SELECT * FROM habit_logs
       WHERE habit_id = $1 AND user_id = $2 AND logged_date BETWEEN $3 AND $4
       ORDER BY logged_date DESC`,
      [req.params['id'], req.user.id, fromDate, toDate],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Refresh streak for a single habit
habitsRouter.post('/:id/streak/refresh', async (req, res, next) => {
  try {
    const streak = await refreshStreak(req.params['id']!, req.user.id, req.db);
    res.json(streak);
  } catch (err) { next(err); }
});

// ── Streak helper ─────────────────────────────────────────────────────────────
import type { ScopedDb } from '../lib/db.js';

async function refreshStreak(habitId: string, userId: string, db: ScopedDb) {
  // Fetch all logged dates in descending order
  const { rows } = await db.query<{ logged_date: string }>(
    `SELECT logged_date::text FROM habit_logs
     WHERE habit_id = $1 AND user_id = $2
     ORDER BY logged_date DESC`,
    [habitId, userId],
  );

  if (!rows.length) {
    await db.query(
      `INSERT INTO streaks (user_id, habit_id, current, longest, last_logged)
       VALUES ($1,$2,0,0,NULL)
       ON CONFLICT (user_id, habit_id) DO UPDATE SET current=0, last_logged=NULL`,
      [userId, habitId],
    );
    return { current: 0, longest: 0 };
  }

  // Count consecutive days from today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let current = 0;
  let cursor = new Date(today);

  for (const { logged_date } of rows) {
    const d = new Date(logged_date + 'T00:00:00');
    const diff = Math.round((cursor.getTime() - d.getTime()) / 86400_000);
    if (diff === 0 || diff === 1) {
      current++;
      cursor = d;
    } else if (diff > 1 && current === 0) {
      // First row is old — streak might be 0 if today wasn't logged
      break;
    } else {
      break;
    }
  }

  // Compute longest streak
  let longest = 0;
  let run = 1;
  const dates = rows.map(r => new Date(r.logged_date + 'T00:00:00'));
  for (let i = 1; i < dates.length; i++) {
    const gap = Math.round((dates[i - 1]!.getTime() - dates[i]!.getTime()) / 86400_000);
    if (gap === 1) { run++; }
    else { longest = Math.max(longest, run); run = 1; }
  }
  longest = Math.max(longest, run, current);

  await db.query(
    `INSERT INTO streaks (user_id, habit_id, current, longest, last_logged)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, habit_id) DO UPDATE
       SET current=$3, longest=GREATEST(streaks.longest,$4), last_logged=$5, updated_at=NOW()`,
    [userId, habitId, current, longest, rows[0]?.logged_date ?? null],
  );
  return { current, longest };
}
