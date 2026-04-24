/**
 * Calendar items routes
 *
 * All kinds: event | meeting | block | reminder | travel | class
 *
 * GET    /api/calendar                 list by range (?from=&to=&kind=&source=)
 * POST   /api/calendar                 create
 * GET    /api/calendar/today           today's items
 * GET    /api/calendar/week            this-week items
 * GET    /api/calendar/:id             detail + participants
 * PATCH  /api/calendar/:id             update
 * DELETE /api/calendar/:id             soft-delete
 *
 * Reality view
 * POST   /api/calendar/:id/start       mark actual_start = NOW, status='in_progress'
 * POST   /api/calendar/:id/stop        mark actual_end = NOW
 * POST   /api/calendar/:id/done        status='done'
 * POST   /api/calendar/:id/skip        status='skipped'
 * POST   /api/calendar/:id/unplanned   log an unplanned block
 *
 * Participants (meetings)
 * GET    /api/calendar/:id/participants
 * POST   /api/calendar/:id/participants
 * DELETE /api/calendar/:id/participants/:uid
 * PATCH  /api/calendar/:id/participants/:uid/rsvp
 *
 * Meeting templates
 * GET    /api/calendar/templates
 * POST   /api/calendar/templates
 * PATCH  /api/calendar/templates/:tid
 * DELETE /api/calendar/templates/:tid
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import {
  buildAuthUrl,
  exchangeCode,
  syncGoogleCalendar,
  disconnectGoogleCalendar,
} from '../services/google-calendar.js';

export const calendarRouter: Router = Router();
calendarRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const calKindEnum   = z.enum(['event', 'meeting', 'block', 'reminder', 'travel', 'class']);
const calSourceEnum = z.enum(['manual', 'auto_schedule', 'template', 'university', 'external', 'prayer']);
const calStatusEnum = z.enum(['planned', 'in_progress', 'done', 'skipped', 'cancelled']);

const createSchema = z.object({
  kind:            calKindEnum.default('event'),
  source:          calSourceEnum.optional(),
  title:           z.string().min(1).max(500),
  description:     z.string().optional(),
  location:        z.string().optional(),
  starts_at:       z.string().datetime(),
  ends_at:         z.string().datetime(),
  all_day:         z.boolean().default(false),
  recurrence:      z.string().optional(),   // RRULE
  role_id:         z.string().uuid().optional(),
  item_id:         z.string().uuid().optional(),
  energy_required: z.enum(['high', 'medium', 'low']).optional(),
  meeting_url:     z.string().url().optional(),
});

const updateSchema = createSchema.partial().extend({
  status:       calStatusEnum.optional(),
  actual_start: z.string().datetime().optional(),
  actual_end:   z.string().datetime().optional(),
});

const participantSchema = z.object({
  user_id: z.string().uuid().optional(),
  name:    z.string().optional(),
  email:   z.string().email().optional(),
}).refine(d => d.user_id || d.name || d.email, { message: 'Provide user_id, name, or email' });

const templateSchema = z.object({
  title:        z.string().min(1).max(300),
  agenda:       z.string().optional(),
  duration_min: z.number().int().min(5).max(480).default(60),
});

// ── Helper ────────────────────────────────────────────────────────────────────
function buildDateFilter(from?: string, to?: string, p = 2): { clause: string; values: string[] } {
  const clauses: string[] = [];
  const values: string[] = [];
  if (from) { clauses.push(`ends_at >= $${p++}`);   values.push(from); }
  if (to)   { clauses.push(`starts_at <= $${p++}`); values.push(to); }
  return { clause: clauses.length ? clauses.join(' AND ') : 'TRUE', values };
}

// ── GET /today ────────────────────────────────────────────────────────────────
calendarRouter.get('/today', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT c.*, r.name AS role_name, r.color AS role_color
       FROM   calendar_items c
       LEFT JOIN roles r ON r.id = c.role_id
       WHERE  c.user_id = $1
         AND  c.deleted_at IS NULL
         AND  c.starts_at::date = CURRENT_DATE
       ORDER  BY c.starts_at`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /week ─────────────────────────────────────────────────────────────────
calendarRouter.get('/week', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT c.*, r.name AS role_name, r.color AS role_color
       FROM   calendar_items c
       LEFT JOIN roles r ON r.id = c.role_id
       WHERE  c.user_id = $1
         AND  c.deleted_at IS NULL
         AND  c.starts_at >= date_trunc('week', NOW())
         AND  c.starts_at <  date_trunc('week', NOW()) + INTERVAL '7 days'
       ORDER  BY c.starts_at`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /templates ────────────────────────────────────────────────────────────
calendarRouter.get('/templates', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT * FROM meeting_templates WHERE user_id = $1 AND deleted_at IS NULL ORDER BY title`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /templates ───────────────────────────────────────────────────────────
calendarRouter.post('/templates', async (req, res, next) => {
  try {
    const body = templateSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO meeting_templates (user_id, title, agenda, duration_min)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, body.title, body.agenda ?? null, body.duration_min],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /templates/:tid ─────────────────────────────────────────────────────
calendarRouter.patch('/templates/:tid', async (req, res, next) => {
  try {
    const body = templateSchema.partial().parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.title        !== undefined) col['title']        = body.title;
    if (body.agenda       !== undefined) col['agenda']       = body.agenda;
    if (body.duration_min !== undefined) col['duration_min'] = body.duration_min;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE meeting_templates SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} AND deleted_at IS NULL RETURNING *`,
      [req.params['tid'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Template not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /templates/:tid ────────────────────────────────────────────────────
calendarRouter.delete('/templates/:tid', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE meeting_templates SET deleted_at = NOW() WHERE id = $1 AND user_id = $2`,
      [req.params['tid'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET / ─────────────────────────────────────────────────────────────────────
calendarRouter.get('/', async (req, res, next) => {
  try {
    const { from, to, kind, source, role_id, limit = '200', offset = '0' } = req.query as Record<string, string>;

    const conditions: string[] = [`c.user_id = $1`, `c.deleted_at IS NULL`];
    const values: unknown[] = [req.user.id];
    let p = 2;

    if (from)    { conditions.push(`c.ends_at >= $${p++}`);   values.push(from); }
    if (to)      { conditions.push(`c.starts_at <= $${p++}`); values.push(to); }
    if (kind)    { conditions.push(`c.kind = $${p++}`);       values.push(kind); }
    if (source)  { conditions.push(`c.source = $${p++}`);     values.push(source); }
    if (role_id) { conditions.push(`c.role_id = $${p++}`);    values.push(role_id); }

    const { rows } = await req.db.query(
      `SELECT c.*,
              r.name AS role_name, r.color AS role_color,
              i.title AS item_title
       FROM   calendar_items c
       LEFT JOIN roles r  ON r.id = c.role_id
       LEFT JOIN items i  ON i.id = c.item_id
       WHERE  ${conditions.join(' AND ')}
       ORDER  BY c.starts_at
       LIMIT $${p} OFFSET $${p + 1}`,
      [...values, Number(limit), Number(offset)],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST / ────────────────────────────────────────────────────────────────────
calendarRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO calendar_items
         (user_id, kind, source, title, description, location, starts_at, ends_at, all_day,
          recurrence, role_id, item_id, energy_required, meeting_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        req.user.id, body.kind, body.source ?? 'manual', body.title,
        body.description ?? null, body.location ?? null,
        body.starts_at, body.ends_at, body.all_day,
        body.recurrence ?? null, body.role_id ?? null,
        body.item_id ?? null, body.energy_required ?? null,
        body.meeting_url ?? null,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
calendarRouter.get('/:id', async (req, res, next) => {
  try {
    const { rows: [item] } = await req.db.query(
      `SELECT c.*, r.name AS role_name, r.color AS role_color
       FROM calendar_items c LEFT JOIN roles r ON r.id = c.role_id
       WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!item) throw new AppError(404, 'Calendar item not found');

    const { rows: participants } = await req.db.query(
      `SELECT p.*, u.name, u.avatar_url
       FROM calendar_item_participants p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.cal_item_id = $1`,
      [req.params['id']],
    );
    res.json({ ...item, participants });
  } catch (err) { next(err); }
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────
calendarRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const col: Record<string, unknown> = {};
    const fields_map: Record<string, unknown> = {
      title: body.title, description: body.description, location: body.location,
      starts_at: body.starts_at, ends_at: body.ends_at, all_day: body.all_day,
      recurrence: body.recurrence, role_id: body.role_id, item_id: body.item_id,
      energy_required: body.energy_required, meeting_url: body.meeting_url,
      status: body.status, actual_start: body.actual_start, actual_end: body.actual_end,
    };
    for (const [k, v] of Object.entries(fields_map)) {
      if (v !== undefined) col[k] = v;
    }
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE calendar_items SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} AND deleted_at IS NULL RETURNING *`,
      [req.params['id'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Calendar item not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
calendarRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE calendar_items SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Calendar item not found');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Reality view actions ──────────────────────────────────────────────────────
calendarRouter.post('/:id/start', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE calendar_items SET actual_start = NOW(), status = 'in_progress'
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Calendar item not found');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

calendarRouter.post('/:id/stop', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE calendar_items SET actual_end = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

calendarRouter.post('/:id/done', async (req, res, next) => {
  try {
    const { note } = z.object({ note: z.string().optional() }).parse(req.body);
    await req.db.query(
      `UPDATE calendar_items
       SET status = 'done', actual_end = COALESCE(actual_end, NOW())${note !== undefined ? ', description = COALESCE(description, \'\') || $3' : ''}
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      note !== undefined ? [req.params['id'], req.user.id, '\n' + note] : [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

calendarRouter.post('/:id/skip', async (req, res, next) => {
  try {
    await req.db.query(
      `UPDATE calendar_items SET status = 'skipped'
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Log an unplanned block (creates a new calendar_item with source='manual' and an annotation)
calendarRouter.post('/unplanned', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO calendar_items
         (user_id, kind, source, title, starts_at, ends_at, status, actual_start, actual_end)
       VALUES ($1, $2, 'manual', $3, $4, $5, 'done', $4, $5) RETURNING *`,
      [req.user.id, body.kind, body.title, body.starts_at, body.ends_at],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── Participants ──────────────────────────────────────────────────────────────
calendarRouter.get('/:id/participants', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT p.*, u.name, u.avatar_url, u.email AS user_email
       FROM calendar_item_participants p LEFT JOIN users u ON u.id = p.user_id
       WHERE p.cal_item_id = $1`,
      [req.params['id']],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── Google Calendar OAuth ─────────────────────────────────────────────────────

/** GET /api/calendar/google/auth — redirect to Google consent screen */
calendarRouter.get('/google/auth', (req, res) => {
  const state = req.user.id; // use userId as state (CSRF protection)
  const url   = buildAuthUrl(state);
  res.redirect(url);
});

/** GET /api/calendar/google/callback?code=…&state=… */
calendarRouter.get('/google/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query as Record<string, string | undefined>;
    if (!code || !state) throw new AppError(400, 'Missing code or state');

    // Validate state matches logged-in user
    if (state !== req.user.id) throw new AppError(403, 'State mismatch');

    const tokens = await exchangeCode(code);
    const expiry = new Date(Date.now() + tokens.expires_in * 1000);

    // Fetch the user's primary calendar ID
    const calListRes = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1&minAccessRole=writer',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    );
    interface CalListItem { id: string; summary: string }
    interface CalList { items: CalListItem[] }
    const calList = await calListRes.json() as CalList;
    const primaryCal = calList.items?.[0];

    await req.db.query(
      `INSERT INTO external_calendars
         (user_id, provider, external_cal_id, name, access_token, refresh_token, token_expires)
       VALUES ($1, 'google', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, provider)
         DO UPDATE SET
           external_cal_id = EXCLUDED.external_cal_id,
           name            = EXCLUDED.name,
           access_token    = EXCLUDED.access_token,
           refresh_token   = COALESCE(EXCLUDED.refresh_token, external_calendars.refresh_token),
           token_expires   = EXCLUDED.token_expires,
           updated_at      = NOW()`,
      [
        req.user.id,
        primaryCal?.id ?? 'primary',
        primaryCal?.summary ?? 'Google Calendar',
        tokens.access_token,
        tokens.refresh_token ?? null,
        expiry,
      ],
    );

    const FRONTEND_URL = process.env['FRONTEND_URL'] ?? 'http://localhost:3000';
    res.redirect(`${FRONTEND_URL}/settings?google=connected`);
  } catch (err) { next(err); }
});

/** POST /api/calendar/google/sync — trigger a manual sync */
calendarRouter.post('/google/sync', async (req, res, next) => {
  try {
    const result = await syncGoogleCalendar(req.user.id);
    res.json(result);
  } catch (err) { next(err); }
});

/** GET /api/calendar/google/status — check if connected */
calendarRouter.get('/google/status', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT id, name, last_synced FROM external_calendars WHERE user_id=$1 AND provider='google' LIMIT 1`,
      [req.user.id],
    );
    res.json({ connected: rows.length > 0, calendar: rows[0] ?? null });
  } catch (err) { next(err); }
});

/** DELETE /api/calendar/google — disconnect + revoke */
calendarRouter.delete('/google', async (req, res, next) => {
  try {
    await disconnectGoogleCalendar(req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

calendarRouter.post('/:id/participants', async (req, res, next) => {
  try {
    const body = participantSchema.parse(req.body);
    await req.db.query(
      `INSERT INTO calendar_item_participants (cal_item_id, user_id, name, email)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [req.params['id'], body.user_id ?? null, body.name ?? null, body.email ?? null],
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

calendarRouter.delete('/:id/participants/:uid', async (req, res, next) => {
  try {
    await req.db.query(
      `DELETE FROM calendar_item_participants WHERE cal_item_id = $1 AND user_id = $2`,
      [req.params['id'], req.params['uid']],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

calendarRouter.patch('/:id/participants/:uid/rsvp', async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(['pending', 'accepted', 'declined', 'tentative']) }).parse(req.body);
    await req.db.query(
      `UPDATE calendar_item_participants SET status = $1 WHERE cal_item_id = $2 AND user_id = $3`,
      [status, req.params['id'], req.params['uid']],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});
