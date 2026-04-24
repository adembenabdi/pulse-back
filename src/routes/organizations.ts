/**
 * Organizations routes
 *
 * POST   /api/organizations                    create org
 * GET    /api/organizations                    my orgs
 * GET    /api/organizations/:id                detail + members
 * PATCH  /api/organizations/:id                update (owner/admin)
 * DELETE /api/organizations/:id                delete (owner)
 * POST   /api/organizations/:id/invite         add member
 * DELETE /api/organizations/:id/members/:userId
 * PATCH  /api/organizations/:id/members/:userId
 * POST   /api/organizations/:id/leave
 *
 * GET    /api/organizations/:id/events          list events
 * POST   /api/organizations/:id/events          create event
 * PATCH  /api/organizations/:id/events/:eid     update event
 * DELETE /api/organizations/:id/events/:eid     cancel event
 * POST   /api/organizations/:id/events/:eid/rsvp  RSVP (accepted/declined)
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { notify } from '../services/notify.js';

export const orgsRouter: Router = Router();
orgsRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const createOrgSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  avatar_url:  z.string().url().optional(),
});

const updateOrgSchema = createOrgSchema.partial();

const inviteSchema = z.object({
  user_id: z.string().uuid(),
  role:    z.enum(['admin', 'member']).default('member'),
});

const eventSchema = z.object({
  title:       z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  starts_at:   z.string().datetime(),
  ends_at:     z.string().datetime().optional(),
  location:    z.string().max(500).optional(),
});

const rsvpSchema = z.object({
  status: z.enum(['accepted', 'declined']),
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function requireOrgMember(
  db: { query: Function },
  orgId: string,
  userId: string,
): Promise<{ role: string; owner_id: string }> {
  const { rows } = await db.query(
    `SELECT om.role, o.owner_id
     FROM   org_members om
     JOIN   organizations o ON o.id = om.org_id
     WHERE  om.org_id = $1 AND om.user_id = $2 AND o.deleted_at IS NULL`,
    [orgId, userId],
  );
  if (!rows.length) throw new AppError(403, 'Not an org member');
  return rows[0] as { role: string; owner_id: string };
}

// ── POST / ────────────────────────────────────────────────────────────────────
orgsRouter.post('/', async (req, res, next) => {
  try {
    const body = createOrgSchema.parse(req.body);

    const { rows } = await req.db.query(
      `INSERT INTO organizations (owner_id, name, description, avatar_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, body.name, body.description ?? null, body.avatar_url ?? null],
    );
    const org = rows[0]!;

    await req.db.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [org.id, req.user.id],
    );

    res.status(201).json(org);
  } catch (err) {
    next(err);
  }
});

// ── GET / ─────────────────────────────────────────────────────────────────────
orgsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT o.*, om.role AS my_role,
              (SELECT COUNT(*) FROM org_members WHERE org_id = o.id) AS member_count
       FROM   organizations o
       JOIN   org_members om ON om.org_id = o.id AND om.user_id = $1
       WHERE  o.deleted_at IS NULL
       ORDER  BY o.name`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
orgsRouter.get('/:id', async (req, res, next) => {
  try {
    await requireOrgMember(req.db, req.params['id']!, req.user.id);

    const [{ rows: [org] }, { rows: members }] = await Promise.all([
      req.db.query(
        `SELECT * FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
        [req.params['id']],
      ),
      req.db.query(
        `SELECT om.user_id, om.role, om.joined_at, u.name, u.email, u.avatar_url
         FROM   org_members om
         JOIN   users u ON u.id = om.user_id
         WHERE  om.org_id = $1 ORDER BY om.joined_at`,
        [req.params['id']],
      ),
    ]);

    if (!org) throw new AppError(404, 'Organization not found');
    res.json({ ...org, members });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────
orgsRouter.patch('/:id', async (req, res, next) => {
  try {
    const mem = await requireOrgMember(req.db, req.params['id']!, req.user.id);
    if (mem.role !== 'owner' && mem.role !== 'admin') throw new AppError(403, 'Admins only');

    const body = updateOrgSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (body.name        !== undefined) { fields.push(`name = $${i++}`);        values.push(body.name); }
    if (body.description !== undefined) { fields.push(`description = $${i++}`); values.push(body.description); }
    if (body.avatar_url  !== undefined) { fields.push(`avatar_url = $${i++}`);  values.push(body.avatar_url); }
    if (!fields.length) throw new AppError(400, 'Nothing to update');

    values.push(req.params['id']);
    const { rows } = await req.db.query(
      `UPDATE organizations SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
orgsRouter.delete('/:id', async (req, res, next) => {
  try {
    const mem = await requireOrgMember(req.db, req.params['id']!, req.user.id);
    if (mem.owner_id !== req.user.id) throw new AppError(403, 'Owner only');

    await req.db.query(
      `UPDATE organizations SET deleted_at = NOW() WHERE id = $1`,
      [req.params['id']],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/invite ──────────────────────────────────────────────────────────
orgsRouter.post('/:id/invite', async (req, res, next) => {
  try {
    const orgId = req.params['id']!;
    const mem = await requireOrgMember(req.db, orgId, req.user.id);
    if (mem.role !== 'owner' && mem.role !== 'admin') throw new AppError(403, 'Admins only');

    const { user_id, role } = inviteSchema.parse(req.body);

    const { rows: [org] } = await req.db.query<{ name: string }>(
      `SELECT name FROM organizations WHERE id = $1`,
      [orgId],
    );

    await req.db.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [orgId, user_id, role],
    );

    void notify({
      userId: user_id,
      type:   'org_invite',
      title:  `You were added to "${org!.name}"`,
      data:   { org_id: orgId, role },
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id/members/:userId ───────────────────────────────────────────────
orgsRouter.delete('/:id/members/:userId', async (req, res, next) => {
  try {
    const { id: orgId, userId: targetId } = req.params;
    const mem = await requireOrgMember(req.db, orgId!, req.user.id);
    if (mem.role !== 'owner' && mem.role !== 'admin' && targetId !== req.user.id) {
      throw new AppError(403, 'Admins only');
    }
    if (targetId === mem.owner_id) throw new AppError(400, 'Cannot remove owner');

    await req.db.query(
      `DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, targetId],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/members/:userId ────────────────────────────────────────────────
orgsRouter.patch('/:id/members/:userId', async (req, res, next) => {
  try {
    const { id: orgId, userId: targetId } = req.params;
    const mem = await requireOrgMember(req.db, orgId!, req.user.id);
    if (mem.owner_id !== req.user.id) throw new AppError(403, 'Owner only');

    const { role } = inviteSchema.parse(req.body);
    await req.db.query(
      `UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3`,
      [role, orgId, targetId],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/leave ───────────────────────────────────────────────────────────
orgsRouter.post('/:id/leave', async (req, res, next) => {
  try {
    const mem = await requireOrgMember(req.db, req.params['id']!, req.user.id);
    if (mem.owner_id === req.user.id) throw new AppError(400, 'Owner cannot leave');

    await req.db.query(
      `DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── ─────────────────────────────────────────────────────────────────────────
// EVENTS
// ── ─────────────────────────────────────────────────────────────────────────

// GET /:id/events
orgsRouter.get('/:id/events', async (req, res, next) => {
  try {
    await requireOrgMember(req.db, req.params['id']!, req.user.id);

    const { rows } = await req.db.query(
      `SELECT e.*,
              (SELECT json_agg(json_build_object(
                'user_id', a.user_id, 'status', a.status,
                'name', u.name, 'avatar_url', u.avatar_url
              ))
               FROM org_event_attendance a
               JOIN users u ON u.id = a.user_id
               WHERE a.event_id = e.id) AS attendees
       FROM   org_events e
       WHERE  e.org_id = $1 AND e.deleted_at IS NULL
       ORDER  BY e.starts_at`,
      [req.params['id']],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /:id/events
orgsRouter.post('/:id/events', async (req, res, next) => {
  try {
    const orgId = req.params['id']!;
    const mem = await requireOrgMember(req.db, orgId, req.user.id);
    if (mem.role !== 'owner' && mem.role !== 'admin') throw new AppError(403, 'Admins only');

    const body = eventSchema.parse(req.body);

    const { rows } = await req.db.query(
      `INSERT INTO org_events (org_id, title, description, starts_at, ends_at, location)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [orgId, body.title, body.description ?? null, body.starts_at, body.ends_at ?? null, body.location ?? null],
    );
    const event = rows[0]!;

    // Notify all members
    const { rows: members } = await req.db.query<{ user_id: string }>(
      `SELECT user_id FROM org_members WHERE org_id = $1 AND user_id != $2`,
      [orgId, req.user.id],
    );
    for (const { user_id } of members) {
      void notify({
        userId: user_id,
        type:   'org_event',
        title:  `New event: ${body.title}`,
        data:   { event_id: event.id, org_id: orgId },
      });
    }

    res.status(201).json(event);
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/events/:eid
orgsRouter.patch('/:id/events/:eid', async (req, res, next) => {
  try {
    const { id: orgId, eid } = req.params;
    const mem = await requireOrgMember(req.db, orgId!, req.user.id);
    if (mem.role !== 'owner' && mem.role !== 'admin') throw new AppError(403, 'Admins only');

    const body = eventSchema.partial().parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (body.title       !== undefined) { fields.push(`title = $${i++}`);       values.push(body.title); }
    if (body.description !== undefined) { fields.push(`description = $${i++}`); values.push(body.description); }
    if (body.starts_at   !== undefined) { fields.push(`starts_at = $${i++}`);   values.push(body.starts_at); }
    if (body.ends_at     !== undefined) { fields.push(`ends_at = $${i++}`);     values.push(body.ends_at); }
    if (body.location    !== undefined) { fields.push(`location = $${i++}`);    values.push(body.location); }
    if (!fields.length) throw new AppError(400, 'Nothing to update');

    values.push(eid);
    const { rows } = await req.db.query(
      `UPDATE org_events SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
      values,
    );
    if (!rows.length) throw new AppError(404, 'Event not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id/events/:eid
orgsRouter.delete('/:id/events/:eid', async (req, res, next) => {
  try {
    const { id: orgId, eid } = req.params;
    const mem = await requireOrgMember(req.db, orgId!, req.user.id);
    if (mem.role !== 'owner' && mem.role !== 'admin') throw new AppError(403, 'Admins only');

    await req.db.query(
      `UPDATE org_events SET deleted_at = NOW() WHERE id = $1`,
      [eid],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /:id/events/:eid/rsvp
orgsRouter.post('/:id/events/:eid/rsvp', async (req, res, next) => {
  try {
    const { id: orgId, eid } = req.params;
    await requireOrgMember(req.db, orgId!, req.user.id);
    const { status } = rsvpSchema.parse(req.body);

    await req.db.query(
      `INSERT INTO org_event_attendance (event_id, user_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, user_id) DO UPDATE SET status = EXCLUDED.status`,
      [eid, req.user.id, status],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
