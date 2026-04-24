import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../lib/jwt.js';
import { AppError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import crypto from 'node:crypto';

export const authRouter: Router = Router();

// ── Schemas ───────────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  timezone: z.string().default('Africa/Algiers'),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8).max(128),
});

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

const ResetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  newPassword: z.string().min(8).max(128),
});

const UpdateMeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  timezone: z.string().optional(),
  preferences: z.record(z.unknown()).optional(),
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
authRouter.post('/register', async (req, res, next) => {
  try {
    const body = RegisterSchema.parse(req.body);
    const hash = await bcrypt.hash(body.password, 12);

    const existing = await db.admin.query(
      'SELECT id FROM users WHERE email = $1',
      [body.email.toLowerCase()],
    );
    if (existing.rows.length > 0) {
      throw new AppError(409, 'Email already in use');
    }

    const { rows } = await db.admin.query<{ id: string; email: string; name: string }>(
      `INSERT INTO users (email, name, password_hash, preferences)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, email, name`,
      [
        body.email.toLowerCase(),
        body.name,
        hash,
        JSON.stringify({ timezone: body.timezone }),
      ],
    );

    const user = rows[0]!;
    const sessionId = crypto.randomUUID();

    await db.admin.query(
      `INSERT INTO user_sessions (id, user_id, created_at)
       VALUES ($1, $2, NOW())`,
      [sessionId, user.id],
    );

    const accessToken = signAccessToken({ sub: user.id, email: user.email });
    const refreshToken = signRefreshToken({ sub: user.id, sessionId });

    res.status(201).json({ user, accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
authRouter.post('/login', async (req, res, next) => {
  try {
    const body = LoginSchema.parse(req.body);

    const { rows } = await db.admin.query<{
      id: string;
      email: string;
      name: string;
      password_hash: string;
    }>(
      `SELECT id, email, name, password_hash
       FROM users
       WHERE email = $1 AND deleted_at IS NULL`,
      [body.email.toLowerCase()],
    );

    const user = rows[0];
    if (!user) throw new AppError(401, 'Invalid credentials');

    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) throw new AppError(401, 'Invalid credentials');

    const sessionId = crypto.randomUUID();
    await db.admin.query(
      `INSERT INTO user_sessions (id, user_id, created_at)
       VALUES ($1, $2, NOW())`,
      [sessionId, user.id],
    );

    const accessToken = signAccessToken({ sub: user.id, email: user.email });
    const refreshToken = signRefreshToken({ sub: user.id, sessionId });

    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
authRouter.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    const payload = verifyRefreshToken(refreshToken);

    const { rows } = await db.admin.query<{ id: string; email: string; name: string }>(
      `SELECT u.id, u.email, u.name
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND u.deleted_at IS NULL`,
      [payload.sessionId],
    );

    if (rows.length === 0) throw new AppError(401, 'Session not found');
    const user = rows[0]!;

    const newAccessToken = signAccessToken({ sub: user.id, email: user.email });
    res.json({ accessToken: newAccessToken });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
// Accepts either { sessionId } directly OR { refreshToken } from which the
// session id is decoded. If neither is provided, all sessions for the user are
// removed (sign out everywhere). All variants require a valid access token.
authRouter.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const body = z.object({
      sessionId:    z.string().uuid().optional(),
      refreshToken: z.string().optional(),
    }).parse(req.body ?? {});

    let sessionId = body.sessionId;
    if (!sessionId && body.refreshToken) {
      try {
        sessionId = verifyRefreshToken(body.refreshToken).sessionId;
      } catch {
        // ignore — fall through to delete-all
      }
    }

    if (sessionId) {
      await db.admin.query(
        'DELETE FROM user_sessions WHERE id = $1 AND user_id = $2',
        [sessionId, req.user.id],
      );
    } else {
      await db.admin.query(
        'DELETE FROM user_sessions WHERE user_id = $1',
        [req.user.id],
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.admin.query(
      `SELECT id, email, name, avatar_url, preferences, created_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id],
    );
    if (rows.length === 0) throw new AppError(404, 'User not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/auth/me ────────────────────────────────────────────────────────
authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const body = UpdateMeSchema.parse(req.body);

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.name !== undefined) {
      setClauses.push(`name = $${idx++}`);
      values.push(body.name);
    }
    if (body.timezone !== undefined) {
      setClauses.push(
        `preferences = preferences || $${idx++}::jsonb`,
      );
      values.push(JSON.stringify({ timezone: body.timezone }));
    }
    if (body.preferences !== undefined) {
      setClauses.push(
        `preferences = preferences || $${idx++}::jsonb`,
      );
      values.push(JSON.stringify(body.preferences));
    }

    if (setClauses.length === 0) {
      throw new AppError(400, 'No fields to update');
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(req.user.id);

    const { rows } = await db.admin.query(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING id, email, name, preferences, updated_at`,
      values,
    );

    if (rows.length === 0) throw new AppError(404, 'User not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/change-password ────────────────────────────────────────────
authRouter.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const body = ChangePasswordSchema.parse(req.body);

    const { rows } = await db.admin.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id],
    );
    const user = rows[0];
    if (!user) throw new AppError(404, 'User not found');

    const valid = await bcrypt.compare(body.currentPassword, user.password_hash);
    if (!valid) throw new AppError(401, 'Current password is incorrect');

    const newHash = await bcrypt.hash(body.newPassword, 12);
    await db.admin.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.id],
    );

    // Invalidate all sessions so other devices must re-login
    await db.admin.query('DELETE FROM user_sessions WHERE user_id = $1', [req.user.id]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
authRouter.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = ForgotPasswordSchema.parse(req.body);

    const { rows } = await db.admin.query<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE email = $1 AND deleted_at IS NULL',
      [email.toLowerCase()],
    );

    // Always return 200 to prevent email enumeration
    if (rows.length === 0) {
      res.json({ ok: true });
      return;
    }

    const user = rows[0]!;
    const code = String(Math.floor(100_000 + Math.random() * 900_000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    await db.admin.query(
      `INSERT INTO password_reset_tokens (user_id, code, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET code = $2, expires_at = $3, created_at = NOW()`,
      [user.id, code, expiresAt],
    );

    // Email sending removed — handle password reset manually or via Telegram
    res.json({ ok: true, _dev_code: process.env['NODE_ENV'] === 'development' ? code : undefined });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
authRouter.post('/reset-password', async (req, res, next) => {
  try {
    const body = ResetPasswordSchema.parse(req.body);

    const { rows } = await db.admin.query<{ user_id: string; expires_at: Date }>(
      `SELECT prt.user_id, prt.expires_at
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE u.email = $1 AND prt.code = $2`,
      [body.email.toLowerCase(), body.code],
    );

    const token = rows[0];
    if (!token) throw new AppError(400, 'Invalid or expired reset code');
    if (token.expires_at < new Date()) throw new AppError(400, 'Reset code has expired');

    const newHash = await bcrypt.hash(body.newPassword, 12);
    await db.admin.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, token.user_id],
    );
    await db.admin.query(
      'DELETE FROM password_reset_tokens WHERE user_id = $1',
      [token.user_id],
    );
    await db.admin.query(
      'DELETE FROM user_sessions WHERE user_id = $1',
      [token.user_id],
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
