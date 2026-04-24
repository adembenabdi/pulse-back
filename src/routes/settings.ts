/**
 * routes/settings.ts — user settings & profile management
 *
 * GET    /api/settings/profile                   — full profile
 * PATCH  /api/settings/profile                   — update name/email/avatar/bio
 * PATCH  /api/settings/preferences               — update jsonb preferences
 * GET    /api/settings/notifications             — notification matrix
 * PATCH  /api/settings/notifications             — update per-type × per-channel prefs
 * GET    /api/settings/integrations              — telegram + push status
 * POST   /api/settings/integrations/telegram/link — link telegram via token
 * DELETE /api/settings/integrations/telegram     — unlink telegram
 * GET    /api/settings/roles                     — list roles
 * POST   /api/settings/roles                     — create role
 * PATCH  /api/settings/roles/:id                 — update role
 * DELETE /api/settings/roles/:id                 — delete role
 * GET    /api/settings/locations                 — list locations
 * POST   /api/settings/locations                 — create location
 * PATCH  /api/settings/locations/:id             — update location
 * DELETE /api/settings/locations/:id             — delete location
 * POST   /api/settings/export                    — trigger data export (JSON)
 */

import { Router }       from 'express';
import { z }            from 'zod';
import { requireAuth }  from '../middleware/auth.js';
import { AppError }     from '../middleware/error.js';
import { db }           from '../lib/db.js';

export const settingsRouter: Router = Router();
settingsRouter.use(requireAuth);

// ── Profile ───────────────────────────────────────────────────────────────────

settingsRouter.get('/profile', async (req, res, next) => {
  try {
    const { rows: [user] } = await db.admin.query<{
      id: string; email: string; name: string; avatar_url: string | null;
      timezone: string; created_at: string; preferences: Record<string, unknown> | null;
    }>(
      `SELECT id, email, name, avatar_url,
              COALESCE(preferences->>'timezone','Africa/Algiers') AS timezone,
              created_at::TEXT,
              preferences
       FROM   users WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id],
    );
    if (!user) throw new AppError(404, 'User not found');
    res.json(user);
  } catch (err) { next(err); }
});

settingsRouter.patch('/profile', async (req, res, next) => {
  try {
    const body = z.object({
      name:       z.string().min(1).max(100).optional(),
      avatar_url: z.string().url().optional(),
    }).parse(req.body);

    const col: Record<string, unknown> = {};
    if (body.name       !== undefined) col['name']       = body.name;
    if (body.avatar_url !== undefined) col['avatar_url'] = body.avatar_url;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');

    const keys   = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows: [updated] } = await db.admin.query(
      `UPDATE users SET ${fields} WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, email, avatar_url`,
      [req.user.id, ...Object.values(col)],
    );
    res.json(updated);
  } catch (err) { next(err); }
});

// ── Preferences ───────────────────────────────────────────────────────────────

settingsRouter.patch('/preferences', async (req, res, next) => {
  try {
    // Merge incoming partial preferences into existing jsonb
    const patches = z.record(z.unknown()).parse(req.body);
    const { rows: [updated] } = await db.admin.query<{ preferences: Record<string, unknown> }>(
      `UPDATE users
       SET    preferences = COALESCE(preferences,'{}')::jsonb || $2::jsonb
       WHERE  id = $1 AND deleted_at IS NULL
       RETURNING preferences`,
      [req.user.id, JSON.stringify(patches)],
    );
    res.json(updated?.preferences ?? {});
  } catch (err) { next(err); }
});

// ── Notification matrix ───────────────────────────────────────────────────────

settingsRouter.get('/notifications', async (req, res, next) => {
  try {
    const { rows: [prefs] } = await db.admin.query<{
      channels: Record<string, unknown>; quiet_start: string | null; quiet_end: string | null
    }>(
      `SELECT channels, quiet_start, quiet_end FROM notification_preferences WHERE user_id = $1`,
      [req.user.id],
    );
    res.json(prefs ?? { channels: {}, quiet_start: null, quiet_end: null });
  } catch (err) { next(err); }
});

settingsRouter.patch('/notifications', async (req, res, next) => {
  try {
    const body = z.object({
      channels:    z.record(z.unknown()).optional(),
      quiet_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
      quiet_end:   z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    }).parse(req.body);

    await db.admin.query(
      `INSERT INTO notification_preferences (user_id, channels, quiet_start, quiet_end)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET channels    = COALESCE($2::jsonb,  notification_preferences.channels),
             quiet_start = COALESCE($3, notification_preferences.quiet_start),
             quiet_end   = COALESCE($4, notification_preferences.quiet_end)`,
      [
        req.user.id,
        body.channels ? JSON.stringify(body.channels) : null,
        body.quiet_start ?? null,
        body.quiet_end   ?? null,
      ],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Integrations ──────────────────────────────────────────────────────────────

settingsRouter.get('/integrations', async (req, res, next) => {
  try {
    const { rows: [user] } = await db.admin.query<{ telegram_chat_id: string | null }>(
      `SELECT telegram_chat_id FROM users WHERE id = $1`,
      [req.user.id],
    );
    const { rows: pushSubs } = await db.admin.query<{ endpoint: string }>(
      `SELECT endpoint FROM push_subscriptions WHERE user_id = $1 LIMIT 1`,
      [req.user.id],
    );
    res.json({
      telegram: {
        linked:   Boolean(user?.telegram_chat_id),
        chat_id:  user?.telegram_chat_id ?? null,
      },
      push: {
        subscribed: pushSubs.length > 0,
      },
    });
  } catch (err) { next(err); }
});

// Link telegram via token generated by bot /start
settingsRouter.post('/integrations/telegram/link', async (req, res, next) => {
  try {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.body);

    const { rows: [linkRow] } = await db.admin.query<{ chat_id: string }>(
      `DELETE FROM telegram_link_tokens
       WHERE  token = $1 AND expires_at > NOW()
       RETURNING chat_id`,
      [token],
    );
    if (!linkRow) throw new AppError(400, 'Invalid or expired link token');

    await db.admin.query(
      `UPDATE users SET telegram_chat_id = $1 WHERE id = $2`,
      [linkRow.chat_id, req.user.id],
    );
    res.json({ ok: true, chat_id: linkRow.chat_id });
  } catch (err) { next(err); }
});

settingsRouter.delete('/integrations/telegram', async (req, res, next) => {
  try {
    await db.admin.query(`UPDATE users SET telegram_chat_id = NULL WHERE id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Roles ─────────────────────────────────────────────────────────────────────

const roleSchema = z.object({
  name:             z.string().min(1).max(60),
  color:            z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  weekly_focus_min: z.number().int().min(0).optional(),
  icon:             z.string().max(10).optional(),
});

settingsRouter.get('/roles', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT * FROM roles WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

settingsRouter.post('/roles', async (req, res, next) => {
  try {
    const body = roleSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO roles (user_id, name, color, weekly_focus_min, icon)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, body.name, body.color ?? '#8b5cf6', body.weekly_focus_min ?? 0, body.icon ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

settingsRouter.patch('/roles/:id', async (req, res, next) => {
  try {
    const body  = roleSchema.partial().parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.name             !== undefined) col['name']             = body.name;
    if (body.color            !== undefined) col['color']            = body.color;
    if (body.weekly_focus_min !== undefined) col['weekly_focus_min'] = body.weekly_focus_min;
    if (body.icon             !== undefined) col['icon']             = body.icon;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys   = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE roles SET ${fields} WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING *`,
      [req.params['id'], req.user.id, ...Object.values(col)],
    );
    if (!rows.length) throw new AppError(404, 'Role not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

settingsRouter.delete('/roles/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE roles SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Role not found');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Locations ─────────────────────────────────────────────────────────────────

const locationSchema = z.object({
  label:     z.string().min(1).max(100),
  address:   z.string().max(300).optional(),
  lat:       z.number().optional(),
  lng:       z.number().optional(),
  is_default: z.boolean().optional(),
});

settingsRouter.get('/locations', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT * FROM user_locations WHERE user_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, created_at`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

settingsRouter.post('/locations', async (req, res, next) => {
  try {
    const body = locationSchema.parse(req.body);
    if (body.is_default) {
      await req.db.query(`UPDATE user_locations SET is_default = FALSE WHERE user_id = $1`, [req.user.id]);
    }
    const { rows } = await req.db.query(
      `INSERT INTO user_locations (user_id, label, address, lat, lng, is_default)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, body.label, body.address ?? null, body.lat ?? null, body.lng ?? null, body.is_default ?? false],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

settingsRouter.patch('/locations/:id', async (req, res, next) => {
  try {
    const body = locationSchema.partial().parse(req.body);
    if (body.is_default) {
      await req.db.query(`UPDATE user_locations SET is_default = FALSE WHERE user_id = $1`, [req.user.id]);
    }
    const col: Record<string, unknown> = {};
    if (body.label      !== undefined) col['label']      = body.label;
    if (body.address    !== undefined) col['address']    = body.address;
    if (body.lat        !== undefined) col['lat']        = body.lat;
    if (body.lng        !== undefined) col['lng']        = body.lng;
    if (body.is_default !== undefined) col['is_default'] = body.is_default;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys   = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE user_locations SET ${fields} WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING *`,
      [req.params['id'], req.user.id, ...Object.values(col)],
    );
    if (!rows.length) throw new AppError(404, 'Location not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

settingsRouter.delete('/locations/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE user_locations SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Location not found');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Data Export ───────────────────────────────────────────────────────────────

settingsRouter.post('/export', async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Fetch key tables (soft-deleted excluded)
    const [items, ideas, objectives, habits, transactions, notes] = await Promise.all([
      req.db.query(`SELECT * FROM items        WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [userId]),
      req.db.query(`SELECT * FROM ideas        WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [userId]),
      req.db.query(`SELECT * FROM objectives   WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [userId]),
      req.db.query(`SELECT * FROM habits       WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [userId]),
      req.db.query(`SELECT * FROM transactions WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [userId]),
      req.db.query(`SELECT * FROM items WHERE user_id = $1 AND kind = 'note' AND deleted_at IS NULL ORDER BY created_at`, [userId]),
    ]);

    const exportData = {
      exported_at:  new Date().toISOString(),
      user_id:      userId,
      items:        items.rows,
      ideas:        ideas.rows,
      objectives:   objectives.rows,
      habits:       habits.rows,
      transactions: transactions.rows,
      notes:        notes.rows,
    };

    res
      .set('Content-Disposition', `attachment; filename="pulse-export-${new Date().toISOString().slice(0,10)}.json"`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(exportData, null, 2));
  } catch (err) { next(err); }
});
