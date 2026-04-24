/**
 * Teams routes
 *
 * POST   /api/teams                create team
 * GET    /api/teams                my teams (owner + member)
 * GET    /api/teams/:id            team detail + members
 * PATCH  /api/teams/:id            update (owner only)
 * DELETE /api/teams/:id            delete (owner only)
 * POST   /api/teams/:id/invite     invite a connection by user_id
 * DELETE /api/teams/:id/members/:userId   remove member
 * PATCH  /api/teams/:id/members/:userId   update role
 * POST   /api/teams/:id/leave      leave a team
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { notify } from '../services/notify.js';

export const teamsRouter: Router = Router();
teamsRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const createSchema = z.object({
  name:        z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  avatar_url:  z.string().url().optional(),
});

const updateSchema = createSchema.partial();

const inviteSchema = z.object({
  user_id: z.string().uuid(),
  role:    z.enum(['admin', 'member']).default('member'),
});

const memberRoleSchema = z.object({
  role: z.enum(['admin', 'member']),
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function requireTeamOwner(db: typeof import('../lib/db.js').db.admin, teamId: string, userId: string) {
  const { rows } = await db.query<{ owner_id: string }>(
    `SELECT owner_id FROM teams WHERE id = $1 AND deleted_at IS NULL`,
    [teamId],
  );
  if (!rows.length) throw new AppError(404, 'Team not found');
  if (rows[0]!.owner_id !== userId) throw new AppError(403, 'Only the team owner can do that');
  return rows[0]!;
}

async function requireTeamMember(db: typeof import('../lib/db.js').db.admin, teamId: string, userId: string) {
  const { rows } = await db.query<{ role: string; owner_id: string }>(
    `SELECT tm.role, t.owner_id
     FROM   team_members tm
     JOIN   teams t ON t.id = tm.team_id
     WHERE  tm.team_id = $1 AND tm.user_id = $2 AND t.deleted_at IS NULL`,
    [teamId, userId],
  );
  if (!rows.length) throw new AppError(403, 'Not a team member');
  return rows[0]!;
}

// ── POST / — create ───────────────────────────────────────────────────────────
teamsRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const userId = req.user.id;

    const { rows } = await req.db.query(
      `INSERT INTO teams (owner_id, name, description, avatar_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, body.name, body.description ?? null, body.avatar_url ?? null],
    );
    const team = rows[0]!;

    // Add owner as member
    await req.db.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [team.id, userId],
    );

    res.status(201).json(team);
  } catch (err) {
    next(err);
  }
});

// ── GET / — my teams ──────────────────────────────────────────────────────────
teamsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT t.*, tm.role AS my_role,
              (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS member_count
       FROM   teams t
       JOIN   team_members tm ON tm.team_id = t.id AND tm.user_id = $1
       WHERE  t.deleted_at IS NULL
       ORDER  BY t.created_at DESC`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /:id — detail ─────────────────────────────────────────────────────────
teamsRouter.get('/:id', async (req, res, next) => {
  try {
    await requireTeamMember(req.db as never, req.params['id']!, req.user.id);

    const [{ rows: [team] }, { rows: members }] = await Promise.all([
      req.db.query(
        `SELECT * FROM teams WHERE id = $1 AND deleted_at IS NULL`,
        [req.params['id']],
      ),
      req.db.query(
        `SELECT tm.user_id, tm.role, tm.joined_at,
                u.name, u.email, u.avatar_url
         FROM   team_members tm
         JOIN   users u ON u.id = tm.user_id
         WHERE  tm.team_id = $1
         ORDER  BY tm.joined_at`,
        [req.params['id']],
      ),
    ]);

    if (!team) throw new AppError(404, 'Team not found');
    res.json({ ...team, members });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id — update ───────────────────────────────────────────────────────
teamsRouter.patch('/:id', async (req, res, next) => {
  try {
    await requireTeamOwner(req.db as never, req.params['id']!, req.user.id);
    const body = updateSchema.parse(req.body);

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (body.name        !== undefined) { fields.push(`name = $${i++}`);        values.push(body.name); }
    if (body.description !== undefined) { fields.push(`description = $${i++}`); values.push(body.description); }
    if (body.avatar_url  !== undefined) { fields.push(`avatar_url = $${i++}`);  values.push(body.avatar_url); }

    if (!fields.length) throw new AppError(400, 'Nothing to update');

    values.push(req.params['id']);
    const { rows } = await req.db.query(
      `UPDATE teams SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id — delete ──────────────────────────────────────────────────────
teamsRouter.delete('/:id', async (req, res, next) => {
  try {
    await requireTeamOwner(req.db as never, req.params['id']!, req.user.id);

    await req.db.query(
      `UPDATE teams SET deleted_at = NOW() WHERE id = $1`,
      [req.params['id']],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/invite — invite member ──────────────────────────────────────────
teamsRouter.post('/:id/invite', async (req, res, next) => {
  try {
    const { id: teamId } = req.params;
    const mem = await requireTeamMember(req.db as never, teamId!, req.user.id);
    if (mem.role !== 'owner' && mem.role !== 'admin') {
      throw new AppError(403, 'Only team admins can invite members');
    }

    const { user_id, role } = inviteSchema.parse(req.body);

    // Verify user exists
    const { rows: userRows } = await req.db.query<{ name: string }>(
      `SELECT name FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [user_id],
    );
    if (!userRows.length) throw new AppError(404, 'User not found');

    await req.db.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [teamId, user_id, role],
    );

    const { rows: [team] } = await req.db.query<{ name: string }>(
      `SELECT name FROM teams WHERE id = $1`,
      [teamId],
    );

    void notify({
      userId: user_id,
      type:   'team_invite',
      title:  `You were added to "${team!.name}"`,
      data:   { team_id: teamId, role },
    });

    res.status(201).json({ ok: true, user_id, role });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id/members/:userId — remove member ───────────────────────────────
teamsRouter.delete('/:id/members/:userId', async (req, res, next) => {
  try {
    const { id: teamId, userId: targetUserId } = req.params;
    const mem = await requireTeamMember(req.db as never, teamId!, req.user.id);
    if (mem.role !== 'owner' && mem.role !== 'admin' && targetUserId !== req.user.id) {
      throw new AppError(403, 'Only team admins can remove members');
    }
    if (targetUserId === mem.owner_id) throw new AppError(400, 'Cannot remove team owner');

    const { rowCount } = await req.db.query(
      `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, targetUserId],
    );
    if (!rowCount) throw new AppError(404, 'Member not found');

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/members/:userId — update role ──────────────────────────────────
teamsRouter.patch('/:id/members/:userId', async (req, res, next) => {
  try {
    const { id: teamId, userId: targetUserId } = req.params;
    await requireTeamOwner(req.db as never, teamId!, req.user.id);
    const { role } = memberRoleSchema.parse(req.body);

    const { rowCount } = await req.db.query(
      `UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3`,
      [role, teamId, targetUserId],
    );
    if (!rowCount) throw new AppError(404, 'Member not found');

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/leave ───────────────────────────────────────────────────────────
teamsRouter.post('/:id/leave', async (req, res, next) => {
  try {
    const { id: teamId } = req.params;
    const mem = await requireTeamMember(req.db as never, teamId!, req.user.id);
    if (mem.owner_id === req.user.id) throw new AppError(400, 'Owner cannot leave — transfer ownership first');

    await req.db.query(
      `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, req.user.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
