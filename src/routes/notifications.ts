/**
 * Notifications routes
 *
 * GET    /api/notifications              list (unread first, paginated)
 * PATCH  /api/notifications/:id/read     mark single read
 * POST   /api/notifications/read-all     mark all read
 * DELETE /api/notifications/:id          delete
 *
 * POST   /api/notifications/push/subscribe    register a push subscription
 * DELETE /api/notifications/push/subscribe    unregister
 *
 * GET    /api/notifications/preferences       get prefs
 * PUT    /api/notifications/preferences       update prefs
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const notificationsRouter: Router = Router();
notificationsRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const pushSubSchema = z.object({
  endpoint: z.string().url(),
  p256dh:   z.string(),
  auth:     z.string(),
});

const prefsSchema = z.object({
  channels:    z.record(z.object({
    in_app:   z.boolean().optional(),
    push:     z.boolean().optional(),
    telegram: z.boolean().optional(),
    email:    z.boolean().optional(),
  })).optional(),
  quiet_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  quiet_end:   z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
});

// ── GET / ─────────────────────────────────────────────────────────────────────
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const limit  = Math.min(Number(req.query['limit']  ?? 50), 100);
    const offset = Number(req.query['offset'] ?? 0);
    const unreadOnly = req.query['unread'] === 'true';

    const { rows } = await req.db.query(
      `SELECT *
       FROM   notifications
       WHERE  user_id = $1
         AND  ($3 = false OR read_at IS NULL)
       ORDER  BY read_at IS NULL DESC, created_at DESC
       LIMIT  $2 OFFSET $4`,
      [req.user.id, limit, unreadOnly, offset],
    );

    const { rows: [count] } = await req.db.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id],
    );

    res.json({ rows, unread_count: Number(count!.total), limit, offset });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/read ───────────────────────────────────────────────────────────
notificationsRouter.patch('/:id/read', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE notifications SET read_at = NOW()
        WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Notification not found or already read');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /read-all ────────────────────────────────────────────────────────────
notificationsRouter.post('/read-all', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE notifications SET read_at = NOW()
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id],
    );
    res.json({ ok: true, updated: rowCount ?? 0 });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
notificationsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Notification not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Push subscriptions ────────────────────────────────────────────────────────
notificationsRouter.post('/push/subscribe', async (req, res, next) => {
  try {
    const sub = pushSubSchema.parse(req.body);

    await req.db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [req.user.id, sub.endpoint, sub.p256dh, sub.auth, req.headers['user-agent'] ?? null],
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.delete('/push/subscribe', async (req, res, next) => {
  try {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);

    await req.db.query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
      [req.user.id, endpoint],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Preferences ───────────────────────────────────────────────────────────────
notificationsRouter.get('/preferences', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT channels, quiet_start, quiet_end FROM notification_preferences WHERE user_id = $1`,
      [req.user.id],
    );

    if (!rows.length) {
      return res.json({ channels: {}, quiet_start: null, quiet_end: null });
    }
    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

notificationsRouter.put('/preferences', async (req, res, next) => {
  try {
    const body = prefsSchema.parse(req.body);

    const { rows } = await req.db.query(
      `INSERT INTO notification_preferences (user_id, channels, quiet_start, quiet_end)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         channels    = COALESCE(EXCLUDED.channels,    notification_preferences.channels),
         quiet_start = COALESCE(EXCLUDED.quiet_start, notification_preferences.quiet_start),
         quiet_end   = COALESCE(EXCLUDED.quiet_end,   notification_preferences.quiet_end),
         updated_at  = NOW()
       RETURNING *`,
      [
        req.user.id,
        body.channels    ? JSON.stringify(body.channels) : null,
        body.quiet_start ?? null,
        body.quiet_end   ?? null,
      ],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
