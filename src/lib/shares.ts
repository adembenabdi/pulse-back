/**
 * Shares engine — the heart of "everything connects".
 *
 * Provides:
 *   checkAccess(userId, entityType, entityId, minPermission) → throws 403/404
 *   share(...)   → creates a shares row
 *   unshare(...) → soft-deletes a shares row
 *   listShares() → all active shares for an entity
 *   getPermission() → resolved permission level or null
 *
 * Permission order: view < comment < edit
 */

import { db } from './db.js';
import { AppError } from '../middleware/error.js';

// ── Types ─────────────────────────────────────────────────────────────────────
export type ShareEntity =
  | 'item'
  | 'objective'
  | 'calendar_item'
  | 'habit'
  | 'meal_plan'
  | 'venture'
  | 'report';

export type Permission = 'view' | 'comment' | 'edit';

const PERMISSION_RANK: Record<Permission, number> = {
  view: 1,
  comment: 2,
  edit: 3,
};

function meetsMinimum(actual: Permission, minimum: Permission): boolean {
  return PERMISSION_RANK[actual] >= PERMISSION_RANK[minimum];
}

export interface ShareRow {
  id: string;
  owner_id: string;
  entity_type: ShareEntity;
  entity_id: string;
  shared_with_user_id: string | null;
  shared_with_team_id: string | null;
  permission: Permission;
  created_at: string;
}

// ── checkAccess ───────────────────────────────────────────────────────────────
/**
 * Verifies that `userId` has at least `minPermission` on the given entity.
 * Checks:
 *   1. Is userId the owner? (direct ownership assumed if isOwner param true)
 *   2. Does userId have a direct share?
 *   3. Is userId in a team that has a share?
 * Throws AppError(403) if access insufficient, AppError(404) if entity not found.
 */
export async function checkAccess(
  userId: string,
  entityType: ShareEntity,
  entityId: string,
  minPermission: Permission = 'view',
  isOwner = false,
): Promise<Permission> {
  if (isOwner) return 'edit';

  const { rows } = await db.admin.query<{ permission: Permission }>(
    `
    SELECT s.permission
    FROM   shares s
    LEFT   JOIN team_members tm ON tm.team_id = s.shared_with_team_id AND tm.user_id = $1
    WHERE  s.entity_type = $2
      AND  s.entity_id   = $3
      AND  s.deleted_at  IS NULL
      AND  (
             s.shared_with_user_id = $1
          OR tm.user_id IS NOT NULL
           )
    ORDER  BY CASE s.permission
                WHEN 'edit'    THEN 3
                WHEN 'comment' THEN 2
                ELSE                1
              END DESC
    LIMIT  1
    `,
    [userId, entityType, entityId],
  );

  if (rows.length === 0) {
    throw new AppError(403, 'Access denied');
  }

  const granted = rows[0]!.permission;
  if (!meetsMinimum(granted, minPermission)) {
    throw new AppError(403, `Requires ${minPermission} permission`);
  }

  return granted;
}

// ── share ─────────────────────────────────────────────────────────────────────
export interface ShareInput {
  ownerUserId: string;
  entityType: ShareEntity;
  entityId: string;
  permission: Permission;
  withUserId?: string;
  withTeamId?: string;
}

export async function share(input: ShareInput): Promise<ShareRow> {
  const { ownerUserId, entityType, entityId, permission, withUserId, withTeamId } = input;

  if (!withUserId && !withTeamId) {
    throw new AppError(400, 'Must specify withUserId or withTeamId');
  }
  if (withUserId && withTeamId) {
    throw new AppError(400, 'Cannot share with both user and team simultaneously');
  }
  if (withUserId === ownerUserId) {
    throw new AppError(400, 'Cannot share with yourself');
  }

  // Upsert: if share already exists update the permission
  const { rows } = await db.admin.query<ShareRow>(
    `
    INSERT INTO shares
      (owner_id, entity_type, entity_id, shared_with_user_id, shared_with_team_id, permission)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT DO NOTHING
    RETURNING *
    `,
    [ownerUserId, entityType, entityId, withUserId ?? null, withTeamId ?? null, permission],
  );

  // If conflict (already exists), update permission
  if (rows.length === 0) {
    const { rows: updated } = await db.admin.query<ShareRow>(
      `
      UPDATE shares
         SET permission  = $1,
             deleted_at  = NULL
       WHERE owner_id    = $2
         AND entity_type = $3
         AND entity_id   = $4
         AND (shared_with_user_id = $5 OR shared_with_team_id = $6)
      RETURNING *
      `,
      [permission, ownerUserId, entityType, entityId, withUserId ?? null, withTeamId ?? null],
    );
    return updated[0]!;
  }

  return rows[0]!;
}

// ── unshare ───────────────────────────────────────────────────────────────────
export async function unshare(ownerUserId: string, shareId: string): Promise<void> {
  const { rowCount } = await db.admin.query(
    `
    UPDATE shares SET deleted_at = NOW()
     WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
    `,
    [shareId, ownerUserId],
  );

  if (!rowCount) {
    throw new AppError(404, 'Share not found');
  }
}

// ── listShares ────────────────────────────────────────────────────────────────
export async function listShares(
  ownerUserId: string,
  entityType: ShareEntity,
  entityId: string,
): Promise<ShareRow[]> {
  const { rows } = await db.admin.query<ShareRow>(
    `
    SELECT s.*,
           u.name  AS with_user_name,
           u.email AS with_user_email,
           t.name  AS with_team_name
    FROM   shares s
    LEFT   JOIN users u ON u.id = s.shared_with_user_id
    LEFT   JOIN teams t ON t.id = s.shared_with_team_id
    WHERE  s.owner_id    = $1
      AND  s.entity_type = $2
      AND  s.entity_id   = $3
      AND  s.deleted_at  IS NULL
    ORDER  BY s.created_at
    `,
    [ownerUserId, entityType, entityId],
  );
  return rows;
}

// ── getPermission ─────────────────────────────────────────────────────────────
/** Returns the best permission `userId` has, or null if no access. */
export async function getPermission(
  userId: string,
  entityType: ShareEntity,
  entityId: string,
): Promise<Permission | null> {
  try {
    return await checkAccess(userId, entityType, entityId, 'view');
  } catch {
    return null;
  }
}
