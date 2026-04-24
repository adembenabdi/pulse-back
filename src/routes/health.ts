/**
 * Health routes — Sleep, Sport, Gym, Exercise library, Workout routines, PRs
 *
 * Sleep
 * GET    /api/health/sleep               list logs (?from=&to=)
 * POST   /api/health/sleep               log sleep/nap
 * PATCH  /api/health/sleep/:id           update log
 * DELETE /api/health/sleep/:id           delete log
 * GET    /api/health/sleep/stats         avg duration, quality, debt
 *
 * Sport (outdoor / generic)
 * GET    /api/health/sport               list logs
 * POST   /api/health/sport               log activity
 * PATCH  /api/health/sport/:id           update
 * DELETE /api/health/sport/:id           delete
 *
 * Exercise library
 * GET    /api/health/exercises           list (global + own)
 * POST   /api/health/exercises           add custom exercise
 * DELETE /api/health/exercises/:id       delete own exercise
 *
 * Workout routines
 * GET    /api/health/routines            list routines
 * POST   /api/health/routines            create routine
 * GET    /api/health/routines/:id        detail + exercises
 * PATCH  /api/health/routines/:id        update
 * DELETE /api/health/routines/:id        soft-delete
 * PUT    /api/health/routines/:id/exercises   set exercises (replaces)
 *
 * Gym sessions
 * GET    /api/health/gym                 list sessions (?from=&to=)
 * POST   /api/health/gym                 start session
 * PATCH  /api/health/gym/:id             update (end + note)
 * GET    /api/health/gym/:id             detail + exercise logs
 * POST   /api/health/gym/:id/sets        log a set
 * DELETE /api/health/gym/:id/sets/:setId delete set
 *
 * Personal records
 * GET    /api/health/prs                 list all PRs
 * POST   /api/health/prs                 record/update a PR
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const healthRouter: Router = Router();
healthRouter.use(requireAuth);

// ── Sleep ─────────────────────────────────────────────────────────────────────
healthRouter.get('/sleep/stats', async (req, res, next) => {
  try {
    const { days = '30' } = req.query as Record<string, string>;
    const { rows } = await req.db.query(
      `SELECT
         COUNT(*)::int                                             AS total_logs,
         ROUND(AVG(EXTRACT(EPOCH FROM (woke_at - slept_at))/3600)::numeric,2) AS avg_hours,
         ROUND(AVG(quality)::numeric,1)                          AS avg_quality,
         COUNT(*) FILTER (WHERE is_nap)::int                     AS nap_count
       FROM sleep_logs
       WHERE user_id = $1 AND slept_at >= NOW() - ($2::text || ' days')::interval`,
      [req.user.id, days],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.get('/sleep', async (req, res, next) => {
  try {
    const { from, to, is_nap } = req.query as Record<string, string>;
    const fromDate = from ?? new Date(Date.now() - 30 * 86400_000).toISOString();
    const toDate   = to   ?? new Date().toISOString();
    let q = `SELECT * FROM sleep_logs WHERE user_id = $1 AND slept_at BETWEEN $2 AND $3`;
    const vals: unknown[] = [req.user.id, fromDate, toDate];
    if (is_nap !== undefined) { q += ` AND is_nap = $4`; vals.push(is_nap === 'true'); }
    q += ` ORDER BY slept_at DESC`;
    const { rows } = await req.db.query(q, vals);
    res.json(rows);
  } catch (err) { next(err); }
});

healthRouter.post('/sleep', async (req, res, next) => {
  try {
    const body = z.object({
      slept_at: z.string().datetime(),
      woke_at:  z.string().datetime(),
      is_nap:   z.boolean().default(false),
      quality:  z.number().int().min(1).max(5).optional(),
      note:     z.string().max(1000).optional(),
    }).parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO sleep_logs (user_id, slept_at, woke_at, is_nap, quality, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, body.slept_at, body.woke_at, body.is_nap,
       body.quality ?? null, body.note ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.patch('/sleep/:id', async (req, res, next) => {
  try {
    const body = z.object({
      slept_at: z.string().datetime().optional(),
      woke_at:  z.string().datetime().optional(),
      quality:  z.number().int().min(1).max(5).optional(),
      note:     z.string().max(1000).optional(),
    }).parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.slept_at !== undefined) col['slept_at'] = body.slept_at;
    if (body.woke_at  !== undefined) col['woke_at']  = body.woke_at;
    if (body.quality  !== undefined) col['quality']  = body.quality;
    if (body.note     !== undefined) col['note']     = body.note;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE sleep_logs SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} RETURNING *`,
      [req.params['id'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Log not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.delete('/sleep/:id', async (req, res, next) => {
  try {
    await req.db.query(
      `DELETE FROM sleep_logs WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Sport logs ────────────────────────────────────────────────────────────────
healthRouter.get('/sport', async (req, res, next) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const fromDate = from ?? new Date(Date.now() - 30 * 86400_000).toISOString();
    const toDate   = to   ?? new Date().toISOString();
    const { rows } = await req.db.query(
      `SELECT * FROM sport_logs WHERE user_id = $1 AND logged_at BETWEEN $2 AND $3 ORDER BY logged_at DESC`,
      [req.user.id, fromDate, toDate],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

healthRouter.post('/sport', async (req, res, next) => {
  try {
    const body = z.object({
      activity:     z.string().min(1).max(100),
      duration_min: z.number().int().positive().optional(),
      distance_km:  z.number().nonnegative().optional(),
      logged_at:    z.string().datetime().optional(),
      note:         z.string().max(1000).optional(),
    }).parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO sport_logs (user_id, activity, duration_min, distance_km, logged_at, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, body.activity, body.duration_min ?? null, body.distance_km ?? null,
       body.logged_at ?? new Date().toISOString(), body.note ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.patch('/sport/:id', async (req, res, next) => {
  try {
    const body = z.object({
      activity:     z.string().min(1).max(100).optional(),
      duration_min: z.number().int().positive().optional(),
      distance_km:  z.number().nonnegative().optional(),
      note:         z.string().max(1000).optional(),
    }).parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.activity     !== undefined) col['activity']     = body.activity;
    if (body.duration_min !== undefined) col['duration_min'] = body.duration_min;
    if (body.distance_km  !== undefined) col['distance_km']  = body.distance_km;
    if (body.note         !== undefined) col['note']         = body.note;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE sport_logs SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} RETURNING *`,
      [req.params['id'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Log not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.delete('/sport/:id', async (req, res, next) => {
  try {
    await req.db.query(
      `DELETE FROM sport_logs WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Exercise library ──────────────────────────────────────────────────────────
healthRouter.get('/exercises', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT * FROM exercise_library WHERE user_id IS NULL OR user_id = $1 ORDER BY name`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

healthRouter.post('/exercises', async (req, res, next) => {
  try {
    const body = z.object({
      name:         z.string().min(1).max(200),
      muscle_group: z.string().max(100).optional(),
      category:     z.enum(['strength', 'cardio', 'stretch', 'sport']).optional(),
    }).parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO exercise_library (user_id, name, muscle_group, category)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, body.name, body.muscle_group ?? null, body.category ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.delete('/exercises/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `DELETE FROM exercise_library WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(403, 'Cannot delete global exercises');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Workout routines ──────────────────────────────────────────────────────────
healthRouter.get('/routines', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT r.*,
         JSON_AGG(JSON_BUILD_OBJECT('exercise_id',wre.exercise_id,'name',e.name,
           'sets',wre.sets,'reps',wre.reps,'duration_sec',wre.duration_sec,'sort_order',wre.sort_order)
           ORDER BY wre.sort_order) FILTER (WHERE wre.exercise_id IS NOT NULL) AS exercises
       FROM workout_routines r
       LEFT JOIN workout_routine_exercises wre ON wre.routine_id = r.id
       LEFT JOIN exercise_library e ON e.id = wre.exercise_id
       WHERE r.user_id = $1 AND r.deleted_at IS NULL
       GROUP BY r.id ORDER BY r.created_at DESC`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

healthRouter.post('/routines', async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO workout_routines (user_id, name) VALUES ($1,$2) RETURNING *`,
      [req.user.id, body.name],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.get('/routines/:id', async (req, res, next) => {
  try {
    const { rows: [routine] } = await req.db.query(
      `SELECT * FROM workout_routines WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!routine) throw new AppError(404, 'Routine not found');
    const { rows: exercises } = await req.db.query(
      `SELECT wre.*, e.name, e.muscle_group, e.category
       FROM workout_routine_exercises wre
       JOIN exercise_library e ON e.id = wre.exercise_id
       WHERE wre.routine_id = $1 ORDER BY wre.sort_order`,
      [req.params['id']],
    );
    res.json({ ...routine, exercises });
  } catch (err) { next(err); }
});

healthRouter.patch('/routines/:id', async (req, res, next) => {
  try {
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(req.body);
    const { rows } = await req.db.query(
      `UPDATE workout_routines SET name=$1 WHERE id=$2 AND user_id=$3 AND deleted_at IS NULL RETURNING *`,
      [name, req.params['id'], req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Routine not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.delete('/routines/:id', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE workout_routines SET deleted_at=NOW() WHERE id=$1 AND user_id=$2`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

healthRouter.put('/routines/:id/exercises', async (req, res, next) => {
  try {
    const { exercises } = z.object({
      exercises: z.array(z.object({
        exercise_id:  z.string().uuid(),
        sets:         z.number().int().positive().optional(),
        reps:         z.number().int().positive().optional(),
        duration_sec: z.number().int().positive().optional(),
        sort_order:   z.number().int().default(0),
      })),
    }).parse(req.body);
    await req.db.query(
      `DELETE FROM workout_routine_exercises WHERE routine_id = $1`,
      [req.params['id']],
    );
    for (const ex of exercises) {
      await req.db.query(
        `INSERT INTO workout_routine_exercises (routine_id, exercise_id, sets, reps, duration_sec, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params['id'], ex.exercise_id, ex.sets ?? null, ex.reps ?? null, ex.duration_sec ?? null, ex.sort_order],
      );
    }
    res.json({ ok: true, count: exercises.length });
  } catch (err) { next(err); }
});

// ── Gym sessions ──────────────────────────────────────────────────────────────
healthRouter.get('/gym', async (req, res, next) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const fromDate = from ?? new Date(Date.now() - 60 * 86400_000).toISOString();
    const toDate   = to   ?? new Date().toISOString();
    const { rows } = await req.db.query(
      `SELECT s.*, r.name AS routine_name,
         (SELECT COUNT(*) FROM gym_exercise_logs WHERE session_id = s.id)::int AS set_count
       FROM gym_sessions s
       LEFT JOIN workout_routines r ON r.id = s.routine_id
       WHERE s.user_id = $1 AND s.started_at BETWEEN $2 AND $3
       ORDER BY s.started_at DESC`,
      [req.user.id, fromDate, toDate],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

healthRouter.post('/gym', async (req, res, next) => {
  try {
    const body = z.object({
      routine_id: z.string().uuid().optional(),
      started_at: z.string().datetime().optional(),
      note:       z.string().max(1000).optional(),
    }).parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO gym_sessions (user_id, routine_id, started_at, note)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, body.routine_id ?? null,
       body.started_at ?? new Date().toISOString(), body.note ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.patch('/gym/:id', async (req, res, next) => {
  try {
    const body = z.object({
      ended_at: z.string().datetime().optional(),
      note:     z.string().max(1000).optional(),
    }).parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.ended_at !== undefined) col['ended_at'] = body.ended_at;
    if (body.note     !== undefined) col['note']     = body.note;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE gym_sessions SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} RETURNING *`,
      [req.params['id'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Session not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.get('/gym/:id', async (req, res, next) => {
  try {
    const { rows: [session] } = await req.db.query(
      `SELECT * FROM gym_sessions WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    if (!session) throw new AppError(404, 'Session not found');
    const { rows: sets } = await req.db.query(
      `SELECT l.*, e.name AS exercise_name, e.muscle_group
       FROM gym_exercise_logs l
       JOIN exercise_library e ON e.id = l.exercise_id
       WHERE l.session_id = $1 ORDER BY l.created_at`,
      [req.params['id']],
    );
    res.json({ ...session, sets });
  } catch (err) { next(err); }
});

healthRouter.post('/gym/:id/sets', async (req, res, next) => {
  try {
    const body = z.object({
      exercise_id:  z.string().uuid(),
      set_num:      z.number().int().positive(),
      reps:         z.number().int().positive().optional(),
      weight_kg:    z.number().nonnegative().optional(),
      duration_sec: z.number().int().positive().optional(),
      rpe:          z.number().int().min(1).max(10).optional(),
    }).parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO gym_exercise_logs
         (session_id, exercise_id, set_num, reps, weight_kg, duration_sec, rpe)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params['id'], body.exercise_id, body.set_num,
       body.reps ?? null, body.weight_kg ?? null, body.duration_sec ?? null, body.rpe ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

healthRouter.delete('/gym/:id/sets/:setId', async (req, res, next) => {
  try {
    await req.db.query(
      `DELETE FROM gym_exercise_logs WHERE id = $1 AND session_id = $2`,
      [req.params['setId'], req.params['id']],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Personal records ──────────────────────────────────────────────────────────
healthRouter.get('/prs', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT pr.*, e.name AS exercise_name, e.muscle_group
       FROM personal_records pr
       JOIN exercise_library e ON e.id = pr.exercise_id
       WHERE pr.user_id = $1 ORDER BY pr.achieved_at DESC`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

healthRouter.post('/prs', async (req, res, next) => {
  try {
    const body = z.object({
      exercise_id:  z.string().uuid(),
      value:        z.number().positive(),
      unit:         z.enum(['kg', 'reps', 'sec', 'km']),
      achieved_at:  z.string().date().optional(),
    }).parse(req.body);
    const date = body.achieved_at ?? new Date().toISOString().split('T')[0]!;
    const { rows } = await req.db.query(
      `INSERT INTO personal_records (user_id, exercise_id, value, unit, achieved_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, exercise_id, unit) DO UPDATE
         SET value = EXCLUDED.value, achieved_at = EXCLUDED.achieved_at
       RETURNING *`,
      [req.user.id, body.exercise_id, body.value, body.unit, date],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});
