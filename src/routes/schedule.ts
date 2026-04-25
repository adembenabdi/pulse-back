/**
 * Weekly template blocks + scheduler routes
 *
 * Weekly grid blocks — define the recurring weekly time structure
 * GET    /api/schedule/template              list all template blocks
 * POST   /api/schedule/template              create block
 * PATCH  /api/schedule/template/:id          update block
 * DELETE /api/schedule/template/:id          delete block
 * POST   /api/schedule/template/reset        clear non-recurring blocks (Friday cron target)
 *
 * Scheduler — auto-place items into free calendar slots
 * POST   /api/schedule/run                   run auto-scheduler for a date
 * GET    /api/schedule/free-slots            list free slots for a date
 * DELETE /api/schedule/clear                 remove auto-scheduled items for a date
 *
 * University timetable
 * GET    /api/schedule/timetable             get timetable config
 * PUT    /api/schedule/timetable             set/update timetable URL + config
 * POST   /api/schedule/timetable/sync        trigger immediate sync
 *
 * Prayer times
 * GET    /api/schedule/prayer/:date          get prayer times for a date (+ location)
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { runScheduler, getFreeSlots } from '../services/scheduler.js';

export const scheduleRouter: Router = Router();
scheduleRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const templateBlockSchema = z.object({
  day_of_week:     z.number().int().min(0).max(6),
  start_time:      z.string().regex(/^\d{2}:\d{2}$/),
  end_time:        z.string().regex(/^\d{2}:\d{2}$/),
  title:           z.string().min(1).max(300),
  kind:            z.enum(['event', 'meeting', 'block', 'reminder', 'travel', 'class']).default('block'),
  role_id:         z.string().uuid().optional(),
  is_recurring:    z.boolean().default(true),
  energy_required: z.enum(['high', 'medium', 'low']).optional(),
});

// ── Weekly template CRUD ──────────────────────────────────────────────────────
scheduleRouter.get('/template', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT t.*, r.name AS role_name, r.color AS role_color
       FROM weekly_template_blocks t
       LEFT JOIN roles r ON r.id = t.role_id
       WHERE t.user_id = $1 AND t.deleted_at IS NULL
       ORDER BY t.day_of_week, t.start_time`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

scheduleRouter.post('/template', async (req, res, next) => {
  try {
    const body = templateBlockSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO weekly_template_blocks
         (user_id, day_of_week, start_time, end_time, title, kind, role_id, is_recurring, energy_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.id, body.day_of_week, body.start_time, body.end_time, body.title,
       body.kind, body.role_id ?? null, body.is_recurring, body.energy_required ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

scheduleRouter.patch('/template/:id', async (req, res, next) => {
  try {
    const body = templateBlockSchema.partial().parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.day_of_week     !== undefined) col['day_of_week']     = body.day_of_week;
    if (body.start_time      !== undefined) col['start_time']      = body.start_time;
    if (body.end_time        !== undefined) col['end_time']        = body.end_time;
    if (body.title           !== undefined) col['title']           = body.title;
    if (body.kind            !== undefined) col['kind']            = body.kind;
    if (body.role_id         !== undefined) col['role_id']         = body.role_id;
    if (body.is_recurring    !== undefined) col['is_recurring']    = body.is_recurring;
    if (body.energy_required !== undefined) col['energy_required'] = body.energy_required;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE weekly_template_blocks SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} AND deleted_at IS NULL RETURNING *`,
      [req.params['id'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Block not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

scheduleRouter.delete('/template/:id', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE weekly_template_blocks SET deleted_at = NOW() WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Reset non-recurring blocks (call from Friday cron or manually)
scheduleRouter.post('/template/reset', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE weekly_template_blocks SET deleted_at = NOW()
       WHERE user_id = $1 AND is_recurring = FALSE AND deleted_at IS NULL`,
      [req.user.id],
    );
    res.json({ ok: true, cleared: rowCount ?? 0 });
  } catch (err) { next(err); }
});

// ── Scheduler ─────────────────────────────────────────────────────────────────
scheduleRouter.post('/run', async (req, res, next) => {
  try {
    const { date, item_ids, humanize = true } = z.object({
      date:     z.string().date(),
      item_ids: z.array(z.string().uuid()).optional(),
      humanize: z.boolean().default(true),
    }).parse(req.body);

    const result = await runScheduler(req.user.id, date, req.db, {
      ...(item_ids !== undefined ? { item_ids } : {}),
      humanize,
    });
    res.json(result);
  } catch (err) { next(err); }
});

scheduleRouter.get('/free-slots', async (req, res, next) => {
  try {
    const { date = new Date().toISOString().split('T')[0]!, min_duration = '30' } = req.query as Record<string, string>;
    const slots = await getFreeSlots(req.user.id, date, req.db, Number(min_duration));
    res.json(slots);
  } catch (err) { next(err); }
});

scheduleRouter.delete('/clear', async (req, res, next) => {
  try {
    const { date } = z.object({ date: z.string().date() }).parse(req.query);
    const { rowCount } = await req.db.query(
      `UPDATE calendar_items SET deleted_at = NOW()
       WHERE user_id = $1 AND source = 'auto_schedule'
         AND starts_at::date = $2 AND deleted_at IS NULL`,
      [req.user.id, date],
    );
    res.json({ ok: true, cleared: rowCount ?? 0 });
  } catch (err) { next(err); }
});

// ── University timetable ──────────────────────────────────────────────────────
scheduleRouter.get('/timetable', async (req, res, next) => {
  try {
    const { rows: [row] } = await req.db.query(
      `SELECT * FROM university_timetables WHERE user_id = $1`,
      [req.user.id],
    );
    res.json(row ?? null);
  } catch (err) { next(err); }
});

scheduleRouter.put('/timetable', async (req, res, next) => {
  try {
    const body = z.object({
      url:           z.string().url(),
      parser_config: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const { rows } = await req.db.query(
      `INSERT INTO university_timetables (user_id, url, parser_config)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET url = EXCLUDED.url, parser_config = EXCLUDED.parser_config, updated_at = NOW()
       RETURNING *`,
      [req.user.id, body.url, JSON.stringify(body.parser_config ?? {})],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

scheduleRouter.post('/timetable/sync', async (req, res, next) => {
  try {
    const { rows: [tt] } = await req.db.query<{ url: string; parser_config: unknown }>(
      `SELECT url, parser_config FROM university_timetables WHERE user_id = $1`,
      [req.user.id],
    );
    if (!tt) throw new AppError(404, 'No timetable configured. Use PUT /api/schedule/timetable first.');

    // Clear last_hash so manual sync always re-processes regardless of feed content
    const config = (tt.parser_config ?? {}) as Record<string, unknown>;
    delete config['last_hash'];
    await req.db.query(
      `UPDATE university_timetables SET parser_config = $1 WHERE user_id = $2`,
      [JSON.stringify(config), req.user.id],
    );

    const { syncTimetable } = await import('../services/timetable.js');
    const result = await syncTimetable(req.user.id, tt.url, config, req.db);
    res.json(result);
  } catch (err) { next(err); }
});

// ── Prayer times ──────────────────────────────────────────────────────────────
scheduleRouter.get('/prayer/:date', async (req, res, next) => {
  try {
    const { date } = req.params;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'Invalid date format (YYYY-MM-DD)');

    // Get user default location first (needed for cache key)
    const { rows: [loc] } = await req.db.query<{ lat: number; lng: number }>(
      `SELECT lat, lng FROM user_locations WHERE user_id = $1 AND is_default = TRUE AND deleted_at IS NULL LIMIT 1`,
      [req.user.id],
    );
    const lat = loc?.lat ?? 36.7538;
    const lng = loc?.lng ?? 3.0588;

    // Check cache first
    const { rows: [cached] } = await req.db.query(
      `SELECT * FROM prayer_time_caches WHERE lat = $1 AND lng = $2 AND date = $3 AND method = 2`,
      [lat, lng, date],
    );
    if (cached) return res.json(cached);

    const { fetchPrayerTimes } = await import('../services/prayer.js');
    const times = await fetchPrayerTimes(date, lat, lng);

    // Cache it
    await req.db.query(
      `INSERT INTO prayer_time_caches (lat, lng, date, fajr, dhuhr, asr, maghrib, isha, method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, 2)
       ON CONFLICT (lat, lng, date, method) DO UPDATE SET
         fajr = EXCLUDED.fajr, dhuhr = EXCLUDED.dhuhr, asr = EXCLUDED.asr,
         maghrib = EXCLUDED.maghrib, isha = EXCLUDED.isha`,
      [lat, lng, date, times.fajr, times.dhuhr, times.asr, times.maghrib, times.isha],
    );

    res.json(times);
  } catch (err) { next(err); }
});
