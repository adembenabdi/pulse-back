/**
 * Ideas routes (Idea Vault)
 *
 * GET    /api/ideas              list (filter: status)
 * POST   /api/ideas              create (stores raw text + AI-structured plan)
 * GET    /api/ideas/:id          detail
 * PATCH  /api/ideas/:id          update (title / raw_text / status / structured)
 * POST   /api/ideas/:id/restructure   re-run AI structuring
 * POST   /api/ideas/:id/promote       create tasks (optionally in a project) from steps
 * DELETE /api/ideas/:id          soft-delete
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { structureIdea } from '../services/ai/structure-idea.js';

export const ideasRouter: Router = Router();
ideasRouter.use(requireAuth);

const createSchema = z.object({
  title:    z.string().min(1).max(300),
  raw_text: z.string().max(8000).optional(),
});

const updateSchema = z.object({
  title:      z.string().min(1).max(300).optional(),
  raw_text:   z.string().max(8000).nullable().optional(),
  status:     z.enum(['raw', 'structured', 'archived']).optional(),
  structured: z.unknown().optional(),
});

const promoteSchema = z.object({
  project_id:     z.string().uuid().nullable().optional(),
  create_project: z.boolean().optional(),
});

// GET /
ideasRouter.get('/', async (req, res, next) => {
  try {
    const clauses = ['user_id = $1', 'deleted_at IS NULL'];
    const values: unknown[] = [req.user.id];
    if (typeof req.query['status'] === 'string') {
      clauses.push(`status = $2::idea_status`);
      values.push(req.query['status']);
    }
    const { rows } = await req.db.query(
      `SELECT * FROM ideas WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
      values,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /
ideasRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const structured = await structureIdea(body.title, body.raw_text);
    const { rows } = await req.db.query(
      `INSERT INTO ideas (user_id, title, raw_text, structured, status)
       VALUES ($1, $2, $3, $4::jsonb, 'structured')
       RETURNING *`,
      [req.user.id, body.title, body.raw_text ?? null, JSON.stringify(structured)],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /:id
ideasRouter.get('/:id', async (req, res, next) => {
  try {
    const idea = await req.db.queryOne(`SELECT * FROM ideas WHERE id = $1 /*scope*/`, [req.params['id']]);
    res.json(idea);
  } catch (err) {
    next(err);
  }
});

// PATCH /:id
ideasRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, val] of Object.entries(body)) {
      if (val === undefined) continue;
      if (key === 'status') { fields.push(`status = $${i++}::idea_status`); values.push(val); }
      else if (key === 'structured') { fields.push(`structured = $${i++}::jsonb`); values.push(JSON.stringify(val)); }
      else { fields.push(`${key} = $${i++}`); values.push(val); }
    }
    if (fields.length === 0) throw new AppError(400, 'No fields to update');
    fields.push(`updated_at = now()`);
    values.push(req.params['id'], req.user.id);
    const { rows } = await req.db.query(
      `UPDATE ideas SET ${fields.join(', ')}
       WHERE id = $${i++} AND user_id = $${i} AND deleted_at IS NULL
       RETURNING *`,
      values,
    );
    if (!rows.length) throw new AppError(404, 'Idea not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /:id/restructure
ideasRouter.post('/:id/restructure', async (req, res, next) => {
  try {
    const idea = await req.db.queryOne<{ title: string; raw_text: string | null }>(
      `SELECT title, raw_text FROM ideas WHERE id = $1 /*scope*/`,
      [req.params['id']],
    );
    const structured = await structureIdea(idea.title, idea.raw_text);
    const { rows } = await req.db.query(
      `UPDATE ideas SET structured = $1::jsonb, status = 'structured', updated_at = now()
       WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
       RETURNING *`,
      [JSON.stringify(structured), req.params['id'], req.user.id],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /:id/promote — turn structured steps into tasks
ideasRouter.post('/:id/promote', async (req, res, next) => {
  try {
    const body = promoteSchema.parse(req.body);
    const idea = await req.db.queryOne<{ id: string; title: string; structured: { steps?: { title: string }[] } | null }>(
      `SELECT id, title, structured FROM ideas WHERE id = $1 /*scope*/`,
      [req.params['id']],
    );
    const steps = Array.isArray(idea.structured?.steps) ? idea.structured!.steps : [];
    if (steps.length === 0) throw new AppError(400, 'Idea has no structured steps to promote');

    let projectId = body.project_id ?? null;
    if (!projectId && body.create_project) {
      const { rows } = await req.db.query<{ id: string }>(
        `INSERT INTO projects (user_id, name, description)
         VALUES ($1, $2, $3) RETURNING id`,
        [req.user.id, idea.title, 'Created from idea'],
      );
      projectId = rows[0]!.id;
    }

    const created: unknown[] = [];
    let order = 0;
    for (const step of steps) {
      const { rows } = await req.db.query(
        `INSERT INTO tasks (user_id, project_id, title, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.user.id, projectId, step.title, order++],
      );
      created.push(rows[0]);
    }
    res.status(201).json({ project_id: projectId, tasks: created });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id
ideasRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE ideas SET deleted_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Idea not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
