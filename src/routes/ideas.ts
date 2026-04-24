/**
 * Ideas routes (raw | researching | validated | dropped)
 *
 * POST   /api/ideas                create
 * GET    /api/ideas                list (filter: validation_status, role_id)
 * GET    /api/ideas/:id            detail (+ resources)
 * PATCH  /api/ideas/:id            update
 * DELETE /api/ideas/:id            soft-delete
 *
 * PATCH  /api/ideas/:id/status     update validation_status
 * POST   /api/ideas/:id/research   AI-powered SWOT / competitors / suggestions
 * POST   /api/ideas/:id/convert    convert to objective (creates objective, sets converted_to_id)
 *
 * Resources
 * POST   /api/ideas/:id/resources
 * DELETE /api/ideas/:id/resources/:rid
 */

import { Router } from 'express';
import { z } from 'zod';
import Groq from 'groq-sdk';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { organizeIdea } from '../services/ai/idea-organize.js';
import { isGroqAvailable } from '../services/ai/groq.js';

export const ideasRouter: Router = Router();
ideasRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const structuredTaskSchema = z.object({
  title:      z.string().min(1),
  effort_min: z.number().int().min(1).max(1440).optional(),
  priority:   z.enum(['low', 'medium', 'high']).optional(),
  done:       z.boolean().optional(),
});
const structuredSchema = z.object({
  summary:         z.string().optional(),
  target_audience: z.string().optional(),
  tasks:           z.array(structuredTaskSchema).optional(),
  materials:       z.array(z.object({
    name: z.string().min(1),
    category: z.enum(['tool', 'service', 'hardware', 'knowledge', 'other']).optional(),
    note: z.string().optional(),
  })).optional(),
  extra_features:  z.array(z.object({
    title: z.string().min(1),
    description: z.string().optional(),
  })).optional(),
  risks:           z.array(z.string()).optional(),
  next_step:       z.string().optional(),
  generated_at:    z.string().optional(),
}).passthrough();

const createSchema = z.object({
  title:             z.string().min(1).max(500),
  description:       z.string().optional(),
  raw_description:   z.string().optional(),
  role_id:           z.string().uuid().optional(),
  validation_status: z.enum(['raw', 'researching', 'validated', 'dropped']).default('raw'),
  structured:        structuredSchema.optional(),
});

const updateSchema = createSchema.partial();

const resourceSchema = z.object({
  title: z.string().min(1).max(300),
  url:   z.string().url(),
  kind:  z.string().default('link'),
});

// ── GET / ─────────────────────────────────────────────────────────────────────
ideasRouter.get('/', async (req, res, next) => {
  try {
    const { validation_status, role_id, limit = '50', offset = '0' } = req.query as Record<string, string>;

    const conditions: string[] = [`i.user_id = $1`, `i.deleted_at IS NULL`];
    const values: unknown[] = [req.user.id];
    let p = 2;

    if (validation_status) { conditions.push(`i.validation_status = $${p++}`); values.push(validation_status); }
    if (role_id)            { conditions.push(`i.role_id = $${p++}`);          values.push(role_id); }

    const { rows } = await req.db.query(
      `SELECT i.*, r.name AS role_name, r.color AS role_color
       FROM   ideas i
       LEFT JOIN roles r ON r.id = i.role_id
       WHERE  ${conditions.join(' AND ')}
       ORDER  BY i.created_at DESC
       LIMIT  $${p} OFFSET $${p + 1}`,
      [...values, Number(limit), Number(offset)],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────
ideasRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const { rows } = await req.db.query(
      `INSERT INTO ideas (user_id, title, description, raw_description, role_id, validation_status, structured)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.user.id,
        body.title,
        body.description ?? null,
        body.raw_description ?? null,
        body.role_id ?? null,
        body.validation_status,
        body.structured ? JSON.stringify(body.structured) : null,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── POST /organize ────────────────────────────────────────────────────────────
// Preview-only: takes raw text, returns AI-organized payload. Does NOT save.
ideasRouter.post('/organize', async (req, res, next) => {
  try {
    const body = z.object({
      title:       z.string().min(1).max(500),
      description: z.string().optional(),
    }).parse(req.body);
    if (!isGroqAvailable()) throw new AppError(503, 'AI service not configured');
    const structured = await organizeIdea({ title: body.title, description: body.description ?? null });
    res.json({ structured });
  } catch (err) {
    next(err);
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
ideasRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [idea] } = await req.db.query(
      `SELECT i.*, r.name AS role_name, r.color AS role_color
       FROM ideas i LEFT JOIN roles r ON r.id = i.role_id
       WHERE i.id = $1 AND i.user_id = $2 AND i.deleted_at IS NULL`,
      [id, req.user.id],
    );
    if (!idea) throw new AppError(404, 'Idea not found');

    const { rows: resources } = await req.db.query(
      `SELECT r.* FROM resources r
       JOIN resource_links rl ON rl.resource_id = r.id
       WHERE rl.entity_type = 'idea' AND rl.entity_id = $1 AND r.deleted_at IS NULL
       ORDER BY r.created_at`,
      [id],
    );

    res.json({ ...idea, resources });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────
ideasRouter.patch('/:id', async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.title             !== undefined) col['title']             = body.title;
    if (body.description       !== undefined) col['description']       = body.description;
    if (body.raw_description   !== undefined) col['raw_description']   = body.raw_description;
    if (body.role_id           !== undefined) col['role_id']           = body.role_id;
    if (body.validation_status !== undefined) col['validation_status'] = body.validation_status;
    if (body.structured        !== undefined) col['structured']        = body.structured ? JSON.stringify(body.structured) : null;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE ideas SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} AND deleted_at IS NULL
       RETURNING *`,
      [req.params['id'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Idea not found');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
ideasRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE ideas SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Idea not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id/status ─────────────────────────────────────────────────────────
ideasRouter.patch('/:id/status', async (req, res, next) => {
  try {
    const { validation_status } = z.object({
      validation_status: z.enum(['raw', 'researching', 'validated', 'dropped']),
    }).parse(req.body);

    const { rowCount } = await req.db.query(
      `UPDATE ideas SET validation_status = $1 WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [validation_status, req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Idea not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/research ────────────────────────────────────────────────────────
// Uses Groq to generate SWOT, competitors, and AI suggestions for the idea
ideasRouter.post('/:id/research', async (req, res, next) => {
  try {
    const { rows: [idea] } = await req.db.query<{ id: string; title: string; description: string | null }>(
      `SELECT id, title, description FROM ideas WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!idea) throw new AppError(404, 'Idea not found');

    // Set status to researching
    await req.db.query(
      `UPDATE ideas SET validation_status = 'researching' WHERE id = $1`,
      [idea.id],
    );

    const groqApiKey = process.env['GROQ_API_KEY'];
    if (!groqApiKey) {
      // Stub response when no API key
      const stub = {
        swot: {
          strengths:    ['Define key strengths'],
          weaknesses:   ['Identify risks'],
          opportunities: ['Market gaps'],
          threats:      ['Competition, regulation'],
        },
        competitors:    ['Research direct/indirect competitors'],
        ai_suggestions: ['Start with an MVP', 'Validate with 10 customers first'],
      };
      await req.db.query(
        `UPDATE ideas SET swot = $1, competitors = $2, ai_suggestions = $3 WHERE id = $4`,
        [JSON.stringify(stub.swot), JSON.stringify(stub.competitors), JSON.stringify(stub.ai_suggestions), idea.id],
      );
      return res.json(stub);
    }

    const groq = new Groq({ apiKey: groqApiKey });
    const prompt = `You are a startup/personal-project research assistant.
Analyze this idea and return ONLY valid JSON with this exact structure:
{
  "swot": {
    "strengths": ["..."],
    "weaknesses": ["..."],
    "opportunities": ["..."],
    "threats": ["..."]
  },
  "competitors": ["company/product name - brief description"],
  "ai_suggestions": ["actionable suggestion 1", "actionable suggestion 2", "actionable suggestion 3"]
}

Idea: ${idea.title}
Description: ${idea.description ?? 'No description provided'}`;

    const completion = await groq.chat.completions.create({
      model:    'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content) as {
      swot?: unknown;
      competitors?: unknown;
      ai_suggestions?: unknown;
    };

    await req.db.query(
      `UPDATE ideas SET swot = $1, competitors = $2, ai_suggestions = $3 WHERE id = $4`,
      [
        JSON.stringify(parsed.swot ?? {}),
        JSON.stringify(parsed.competitors ?? []),
        JSON.stringify(parsed.ai_suggestions ?? []),
        idea.id,
      ],
    );

    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/convert ─────────────────────────────────────────────────────────
// Convert idea to an objective (project or venture)
ideasRouter.post('/:id/convert', async (req, res, next) => {
  try {
    const { kind = 'project', title, description, role_id } = z.object({
      kind:        z.enum(['goal', 'learning_goal', 'project', 'venture']).default('project'),
      title:       z.string().min(1).optional(),
      description: z.string().optional(),
      role_id:     z.string().uuid().optional(),
    }).parse(req.body);

    const { rows: [idea] } = await req.db.query<{
      id: string; title: string; description: string | null; role_id: string | null
    }>(
      `SELECT id, title, description, role_id FROM ideas WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!idea) throw new AppError(404, 'Idea not found');
    if ((idea as Record<string, unknown>)['converted_to_id']) throw new AppError(409, 'Idea already converted');

    const objTitle       = title       ?? idea.title;
    const objDescription = description ?? idea.description;
    const objRoleId      = role_id     ?? idea.role_id;

    const { rows: [obj] } = await req.db.query<{ id: string }>(
      `INSERT INTO objectives (user_id, kind, title, description, role_id, status)
       VALUES ($1, $2, $3, $4, $5, 'todo')
       RETURNING *`,
      [req.user.id, kind, objTitle, objDescription ?? null, objRoleId ?? null],
    );

    await req.db.query(
      `UPDATE ideas SET converted_to_id = $1, validation_status = 'validated' WHERE id = $2`,
      [obj!.id, idea.id],
    );

    res.status(201).json(obj);
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/organize ────────────────────────────────────────────────────────
// Run AI organize on an existing idea and persist the result.
ideasRouter.post('/:id/organize', async (req, res, next) => {
  try {
    if (!isGroqAvailable()) throw new AppError(503, 'AI service not configured');
    const { rows: [idea] } = await req.db.query<{ id: string; title: string; description: string | null; raw_description: string | null }>(
      `SELECT id, title, description, raw_description
       FROM ideas WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!idea) throw new AppError(404, 'Idea not found');

    const structured = await organizeIdea({
      title:       idea.title,
      description: idea.raw_description || idea.description,
    });

    const { rows } = await req.db.query(
      `UPDATE ideas
       SET structured = $1,
           description = COALESCE(NULLIF(description, ''), $2),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [JSON.stringify(structured), structured.summary, idea.id],
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/materialize ─────────────────────────────────────────────────────
// Turn structured.tasks into real `items` (tasks) linked to a new objective.
ideasRouter.post('/:id/materialize', async (req, res, next) => {
  try {
    const body = z.object({
      objective_kind: z.enum(['goal', 'learning_goal', 'project', 'venture']).default('project'),
      role_id:        z.string().uuid().optional(),
    }).parse(req.body ?? {});

    const { rows: [idea] } = await req.db.query<{
      id: string; title: string; description: string | null;
      role_id: string | null; structured: unknown;
    }>(
      `SELECT id, title, description, role_id, structured
       FROM ideas WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!idea) throw new AppError(404, 'Idea not found');
    const struct = idea.structured as { tasks?: Array<{ title: string; effort_min?: number; priority?: 'low' | 'medium' | 'high' }> } | null;
    const tasks = Array.isArray(struct?.tasks) ? struct!.tasks : [];
    if (!tasks.length) throw new AppError(400, 'No structured tasks to materialize. Run AI organize first.');

    const roleId = body.role_id ?? idea.role_id;

    // Create the parent objective (or reuse if already converted)
    const { rows: [obj] } = await req.db.query<{ id: string; title: string }>(
      `INSERT INTO objectives (user_id, kind, title, description, role_id, status)
       VALUES ($1, $2, $3, $4, $5, 'todo')
       RETURNING id, title`,
      [req.user.id, body.objective_kind, idea.title, idea.description ?? null, roleId ?? null],
    );

    // Bulk-insert items
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const t of tasks) {
      const priority = (t.priority === 'low' || t.priority === 'high') ? t.priority : 'medium';
      const effort   = Math.max(5, Math.min(480, Math.round(Number(t.effort_min ?? 30))));
      placeholders.push(`($${p++}, $${p++}, $${p++}, 'task', $${p++}, $${p++}, $${p++})`);
      values.push(req.user.id, obj!.id, roleId ?? null, t.title, priority, effort);
    }
    const { rows: items } = await req.db.query<{ id: string; title: string }>(
      `INSERT INTO items (user_id, objective_id, role_id, kind, title, priority, estimated_min)
       VALUES ${placeholders.join(', ')}
       RETURNING id, title`,
      values,
    );

    await req.db.query(
      `UPDATE ideas SET converted_to_id = $1, validation_status = 'validated', updated_at = NOW() WHERE id = $2`,
      [obj!.id, idea.id],
    );

    res.status(201).json({ objective: obj, items });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/resources ───────────────────────────────────────────────────────
ideasRouter.post('/:id/resources', async (req, res, next) => {
  try {
    const body = resourceSchema.parse(req.body);

    // Verify ownership
    const { rows: [idea] } = await req.db.query(
      `SELECT id FROM ideas WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!idea) throw new AppError(404, 'Idea not found');

    const { rows } = await req.db.query(
      `INSERT INTO resources (user_id, entity_type, entity_id, title, url, kind)
       VALUES ($1, 'idea', $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, req.params['id'], body.title, body.url, body.kind],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /:id/resources/:rid ────────────────────────────────────────────────
ideasRouter.delete('/:id/resources/:rid', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `DELETE FROM resources
       WHERE id = $1 AND entity_type = 'idea' AND entity_id = $2 AND user_id = $3`,
      [req.params['rid'], req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Resource not found');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
