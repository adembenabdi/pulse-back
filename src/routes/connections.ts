/**
 * Connections routes
 *
 * POST   /api/connections/request         send a connection request
 * GET    /api/connections/requests         list incoming pending requests
 * PATCH  /api/connections/requests/:id/accept
 * PATCH  /api/connections/requests/:id/decline
 * GET    /api/connections                  list my confirmed connections
 * DELETE /api/connections/:peerId          remove connection (both directions)
 * PATCH  /api/connections/:peerId/block    block a user
 * PATCH  /api/connections/:peerId/unblock  unblock
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { notify } from '../services/notify.js';

export const connectionsRouter: Router = Router();
connectionsRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const sendRequestSchema = z.object({
  to_user_id: z.string().uuid(),
  message:    z.string().max(500).optional(),
});

// ── GET /find?email=... — look up a user by email (used by invite forms) ─────
connectionsRouter.get('/find', async (req, res, next) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.query);
    const { rows } = await req.db.query<{ id: string; name: string; email: string; avatar_url: string | null }>(
      `SELECT id, name, email, avatar_url
       FROM   users
       WHERE  LOWER(email) = LOWER($1) AND deleted_at IS NULL AND id <> $2`,
      [email, req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'No user with that email');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── POST /request — send connection request ───────────────────────────────────
connectionsRouter.post('/request', async (req, res, next) => {
  try {
    const { to_user_id, message } = sendRequestSchema.parse(req.body);
    const fromId = req.user.id;

    if (to_user_id === fromId) throw new AppError(400, 'Cannot send request to yourself');

    // Check target user exists
    const { rows: target } = await req.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [to_user_id],
    );
    if (!target.length) throw new AppError(404, 'User not found');

    // Check not already connected
    const { rows: existing } = await req.db.query(
      `SELECT id FROM connections WHERE user_id = $1 AND peer_id = $2`,
      [fromId, to_user_id],
    );
    if (existing.length) throw new AppError(409, 'Already connected');

    // Check not already pending
    const { rows: pendingReq } = await req.db.query(
      `SELECT id, status FROM connection_requests
       WHERE from_user_id = $1 AND to_user_id = $2`,
      [fromId, to_user_id],
    );
    if (pendingReq.length && pendingReq[0]!.status === 'pending') {
      throw new AppError(409, 'Request already pending');
    }

    // Upsert request
    const { rows } = await req.db.query<{ id: string }>(
      `INSERT INTO connection_requests (from_user_id, to_user_id, message, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (from_user_id, to_user_id)
         DO UPDATE SET status = 'pending', message = EXCLUDED.message, updated_at = NOW()
       RETURNING *`,
      [fromId, to_user_id, message ?? null],
    );

    // Notify recipient
    void notify({
      userId: to_user_id,
      type:   'connection_request',
      title:  `${req.user.name} wants to connect`,
      ...(message !== undefined ? { body: message } : {}),
      data:   { from_user_id: fromId, request_id: rows[0]!.id },
    });

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── GET /requests — incoming pending requests ─────────────────────────────────
connectionsRouter.get('/requests', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT cr.*, u.name AS from_name, u.email AS from_email, u.avatar_url AS from_avatar
       FROM   connection_requests cr
       JOIN   users u ON u.id = cr.from_user_id
       WHERE  cr.to_user_id = $1 AND cr.status = 'pending'
       ORDER  BY cr.created_at DESC`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /requests/:id/accept ────────────────────────────────────────────────
connectionsRouter.patch('/requests/:id/accept', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows: reqRows } = await req.db.query<{ from_user_id: string }>(
      `UPDATE connection_requests
          SET status = 'accepted', updated_at = NOW()
        WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
        RETURNING *`,
      [id, req.user.id],
    );
    if (!reqRows.length) throw new AppError(404, 'Request not found');

    const request = reqRows[0]!;

    // Create mutual connection rows
    await req.db.query(
      `INSERT INTO connections (user_id, peer_id) VALUES ($1, $2), ($2, $1)
       ON CONFLICT DO NOTHING`,
      [req.user.id, request.from_user_id],
    );

    // Notify the sender
    void notify({
      userId: request.from_user_id,
      type:   'connection_accepted',
      title:  `${req.user.name} accepted your connection request`,
      data:   { peer_id: req.user.id },
    });

    res.json({ ok: true, peer_id: request.from_user_id });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /requests/:id/decline ───────────────────────────────────────────────
connectionsRouter.patch('/requests/:id/decline', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rowCount } = await req.db.query(
      `UPDATE connection_requests
          SET status = 'declined', updated_at = NOW()
        WHERE id = $1 AND to_user_id = $2 AND status = 'pending'`,
      [id, req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Request not found');

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── GET / — list my connections ───────────────────────────────────────────────
connectionsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT c.peer_id, c.is_blocked, c.created_at,
              u.name, u.email, u.avatar_url
       FROM   connections c
       JOIN   users u ON u.id = c.peer_id
       WHERE  c.user_id    = $1
         AND  c.is_blocked = false
       ORDER  BY u.name`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:peerId — remove connection ───────────────────────────────────────
connectionsRouter.delete('/:peerId', async (req, res, next) => {
  try {
    const { peerId } = req.params;

    const { rowCount } = await req.db.query(
      `DELETE FROM connections
        WHERE (user_id = $1 AND peer_id = $2)
           OR (user_id = $2 AND peer_id = $1)`,
      [req.user.id, peerId],
    );
    if (!rowCount) throw new AppError(404, 'Connection not found');

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:peerId/block ──────────────────────────────────────────────────────
connectionsRouter.patch('/:peerId/block', async (req, res, next) => {
  try {
    const { peerId } = req.params;

    await req.db.query(
      `UPDATE connections SET is_blocked = true
        WHERE user_id = $1 AND peer_id = $2`,
      [req.user.id, peerId],
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:peerId/unblock ────────────────────────────────────────────────────
connectionsRouter.patch('/:peerId/unblock', async (req, res, next) => {
  try {
    const { peerId } = req.params;

    await req.db.query(
      `UPDATE connections SET is_blocked = false
        WHERE user_id = $1 AND peer_id = $2`,
      [req.user.id, peerId],
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
