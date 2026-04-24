/**
 * Shares routes — generic endpoint any entity uses for sharing.
 *
 * POST   /api/shares/:entityType/:entityId          create share
 * GET    /api/shares/:entityType/:entityId          list shares for entity
 * PATCH  /api/shares/:entityType/:entityId/:shareId update permission
 * DELETE /api/shares/:entityType/:entityId/:shareId revoke share
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { share, unshare, listShares, type ShareEntity, type Permission } from '../lib/shares.js';
import { notify } from '../services/notify.js';

export const sharesRouter: Router = Router();
sharesRouter.use(requireAuth);

const VALID_ENTITIES: ShareEntity[] = [
  'item', 'objective', 'calendar_item', 'habit', 'meal_plan', 'venture', 'report',
];

const createSchema = z.object({
  permission:          z.enum(['view', 'comment', 'edit']),
  with_user_id:        z.string().uuid().optional(),
  with_team_id:        z.string().uuid().optional(),
});

const updateSchema = z.object({
  permission: z.enum(['view', 'comment', 'edit']),
});

function parseEntityType(raw: string): ShareEntity {
  if (!VALID_ENTITIES.includes(raw as ShareEntity)) {
    throw new AppError(400, `Invalid entity type. Must be one of: ${VALID_ENTITIES.join(', ')}`);
  }
  return raw as ShareEntity;
}

// ── POST /:entityType/:entityId ───────────────────────────────────────────────
sharesRouter.post('/:entityType/:entityId', async (req, res, next) => {
  try {
    const entityType = parseEntityType(req.params['entityType']!);
    const entityId   = req.params['entityId']!;
    const body       = createSchema.parse(req.body);

    const row = await share({
      ownerUserId: req.user.id,
      entityType,
      entityId,
      permission: body.permission as Permission,
      ...(body.with_user_id !== undefined ? { withUserId: body.with_user_id } : {}),
      ...(body.with_team_id !== undefined ? { withTeamId: body.with_team_id } : {}),
    });

    if (body.with_user_id) {
      void notify({
        userId: body.with_user_id,
        type:   'share_received',
        title:  `${req.user.name} shared a ${entityType} with you`,
        data:   { entity_type: entityType, entity_id: entityId, share_id: row.id, permission: body.permission },
      });
    }

    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

// ── GET /:entityType/:entityId ────────────────────────────────────────────────
sharesRouter.get('/:entityType/:entityId', async (req, res, next) => {
  try {
    const entityType = parseEntityType(req.params['entityType']!);
    const entityId   = req.params['entityId']!;

    const rows = await listShares(req.user.id, entityType, entityId);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:entityType/:entityId/:shareId ─────────────────────────────────────
sharesRouter.patch('/:entityType/:entityId/:shareId', async (req, res, next) => {
  try {
    const entityType = parseEntityType(req.params['entityType']!);
    const entityId   = req.params['entityId']!;
    const shareId    = req.params['shareId']!;
    const { permission } = updateSchema.parse(req.body);

    const { rowCount, rows } = await req.db.query(
      `UPDATE shares SET permission = $1
        WHERE id = $2 AND owner_id = $3
          AND entity_type = $4 AND entity_id = $5
          AND deleted_at IS NULL
       RETURNING *`,
      [permission, shareId, req.user.id, entityType, entityId],
    );
    if (!rowCount) throw new AppError(404, 'Share not found');

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:entityType/:entityId/:shareId ────────────────────────────────────
sharesRouter.delete('/:entityType/:entityId/:shareId', async (req, res, next) => {
  try {
    await unshare(req.user.id, req.params['shareId']!);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
