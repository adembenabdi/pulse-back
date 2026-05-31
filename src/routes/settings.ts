/**
 * Settings routes
 *
 * GET    /api/settings              profile + preferences + telegram link status
 * PATCH  /api/settings              update name / preferences (timezone, theme, ...)
 * POST   /api/settings/telegram     link Telegram via /start token
 * DELETE /api/settings/telegram     unlink Telegram
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { db } from '../lib/db.js';

export const settingsRouter: Router = Router();
settingsRouter.use(requireAuth);

const updateSchema = z.object({
  name:        z.string().min(1).max(120).optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

const linkSchema = z.object({ token: z.string().min(6).max(200) });

// GET /
settingsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.admin.query(
      `SELECT id, email, name, preferences,
              (telegram_chat_id IS NOT NULL) AS telegram_linked
       FROM users WHERE id = $1`,
      [req.user.id],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /
settingsRouter.patch('/', async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const { rows } = await db.admin.query(
      `UPDATE users
       SET name = COALESCE($2, name),
           preferences = COALESCE(preferences, '{}'::jsonb) || COALESCE($3::jsonb, '{}'::jsonb),
           updated_at = now()
       WHERE id = $1
       RETURNING id, email, name, preferences`,
      [req.user.id, body.name ?? null, body.preferences ? JSON.stringify(body.preferences) : null],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /telegram — consume a /start link token
settingsRouter.post('/telegram', async (req, res, next) => {
  try {
    const { token } = linkSchema.parse(req.body);
    const { rows } = await db.admin.query<{ chat_id: string }>(
      `SELECT chat_id FROM telegram_link_tokens
       WHERE token = $1 AND expires_at > NOW()`,
      [token],
    );
    if (!rows[0]) throw new AppError(400, 'Invalid or expired token');

    await db.admin.query(
      `UPDATE users SET telegram_chat_id = $1, updated_at = now() WHERE id = $2`,
      [rows[0].chat_id, req.user.id],
    );
    await db.admin.query(`DELETE FROM telegram_link_tokens WHERE token = $1`, [token]);
    res.json({ ok: true, telegram_linked: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /telegram
settingsRouter.delete('/telegram', async (req, res, next) => {
  try {
    await db.admin.query(
      `UPDATE users SET telegram_chat_id = NULL, updated_at = now() WHERE id = $1`,
      [req.user.id],
    );
    res.json({ ok: true, telegram_linked: false });
  } catch (err) {
    next(err);
  }
});
