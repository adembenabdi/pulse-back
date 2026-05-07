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
import {
  loadIdea, ensureProject, saveStructured, materializeMissingTasks,
  createItemForTask, updateItemForTask, softDeleteItem, newId,
  type OrganizedStructured, type StructuredTask,
  type StructuredFeature, type StructuredMaterial,
} from '../lib/ideas.js';

export const ideasRouter: Router = Router();
ideasRouter.use(requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────
const structuredTaskSchema = z.object({
  id:         z.string().uuid().optional(),
  item_id:    z.string().uuid().nullable().optional(),
  title:      z.string().min(1),
  effort_min: z.number().int().min(1).max(1440).optional(),
  priority:   z.enum(['low', 'medium', 'high']).optional(),
  done:       z.boolean().optional(),
});
const structuredMaterialSchema = z.object({
  id:       z.string().uuid().optional(),
  name:     z.string().min(1),
  category: z.enum(['tool', 'service', 'hardware', 'knowledge', 'other']).optional(),
  note:     z.string().optional(),
});
const structuredFeatureSchema = z.object({
  id:          z.string().uuid().optional(),
  title:       z.string().min(1),
  description: z.string().optional(),
});
const structuredSchema = z.object({
  summary:         z.string().optional(),
  target_audience: z.string().optional(),
  tasks:           z.array(structuredTaskSchema).optional(),
  materials:       z.array(structuredMaterialSchema).optional(),
  extra_features:  z.array(structuredFeatureSchema).optional(),
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
// Every idea is auto-promoted to a `objectives` row of kind='project' so the
// user can treat them uniformly. If the idea ships with structured.tasks,
// they are materialized into items linked to the new project right away.
ideasRouter.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const structured: OrganizedStructured | undefined = body.structured
      ? { ...body.structured, tasks: body.structured.tasks?.map((t) => ({ ...t, id: t.id ?? newId() })) }
      : undefined;

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
        structured ? JSON.stringify(structured) : null,
      ],
    );
    const ideaRow = rows[0]!;

    // Auto-promote
    const idea = await loadIdea(req.db, ideaRow.id);
    if (idea) {
      const projectId = await ensureProject(req.db, idea);
      if (idea.structured && Array.isArray(idea.structured.tasks)) {
        await materializeMissingTasks(req.db, projectId, idea.role_id, idea.structured);
        await saveStructured(req.db, idea.id, idea.structured);
      }
      ideaRow.converted_to_id = projectId;
      ideaRow.structured = idea.structured;
    }
    res.status(201).json(ideaRow);
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

    const generated = await organizeIdea({
      title:       idea.title,
      description: idea.raw_description || idea.description,
    });
    // Assign stable ids to structured collections so the granular endpoints
    // can address them individually.
    const structured: OrganizedStructured = {
      ...generated,
      tasks:          generated.tasks?.map((t)         => ({ ...t, id: newId() })),
      extra_features: generated.extra_features?.map((f) => ({ ...f, id: newId() })),
      materials:      generated.materials?.map((m)     => ({ ...m, id: newId() })),
    };

    const fresh = await loadIdea(req.db, idea.id);
    if (!fresh) throw new AppError(404, 'Idea not found');
    const projectId = await ensureProject(req.db, fresh);
    await materializeMissingTasks(req.db, projectId, fresh.role_id, structured);

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

// ─────────────────────────────────────────────────────────────────────────────
// Granular structured-field endpoints
//
// All of these load the idea, mutate the `structured` jsonb in-memory, and
// save it back. Tasks also sync to the paired project's `items` rows.
// ─────────────────────────────────────────────────────────────────────────────

async function loadOrFail(req: { db: import('../lib/db.js').ScopedDb }, ideaId: string) {
  const idea = await loadIdea(req.db, ideaId);
  if (!idea) throw new AppError(404, 'Idea not found');
  return idea;
}

function ensureStructured(idea: { structured: OrganizedStructured | null }): OrganizedStructured {
  return idea.structured ?? (idea.structured = {});
}

// ── tasks ────────────────────────────────────────────────────────────────────
ideasRouter.post('/:id/tasks', async (req, res, next) => {
  try {
    const body = structuredTaskSchema.parse(req.body);
    const idea = await loadOrFail(req, req.params['id']!);
    const projectId = await ensureProject(req.db, idea);
    const structured = ensureStructured(idea);
    structured.tasks ??= [];
    const task: StructuredTask = { ...body, id: body.id ?? newId() };
    task.item_id = await createItemForTask(req.db, projectId, idea.role_id, task);
    structured.tasks.push(task);
    await saveStructured(req.db, idea.id, structured);
    res.status(201).json(task);
  } catch (err) { next(err); }
});

ideasRouter.patch('/:id/tasks/:taskId', async (req, res, next) => {
  try {
    const body = structuredTaskSchema.partial().parse(req.body);
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    const tasks = structured.tasks ?? [];
    const task = tasks.find((t) => t.id === req.params['taskId']);
    if (!task) throw new AppError(404, 'Task not found');
    Object.assign(task, body, { id: task.id });
    if (task.item_id) {
      await updateItemForTask(req.db, task.item_id, body);
    } else if (idea.converted_to_id) {
      task.item_id = await createItemForTask(req.db, idea.converted_to_id, idea.role_id, task);
    }
    await saveStructured(req.db, idea.id, structured);
    res.json(task);
  } catch (err) { next(err); }
});

ideasRouter.delete('/:id/tasks/:taskId', async (req, res, next) => {
  try {
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    const tasks = structured.tasks ?? [];
    const idx = tasks.findIndex((t) => t.id === req.params['taskId']);
    if (idx < 0) throw new AppError(404, 'Task not found');
    const [task] = tasks.splice(idx, 1);
    if (task?.item_id) await softDeleteItem(req.db, task.item_id);
    await saveStructured(req.db, idea.id, structured);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── features ────────────────────────────────────────────────────────────────
ideasRouter.post('/:id/features', async (req, res, next) => {
  try {
    const body = structuredFeatureSchema.parse(req.body);
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    structured.extra_features ??= [];
    const feature: StructuredFeature = { ...body, id: body.id ?? newId() };
    structured.extra_features.push(feature);
    await saveStructured(req.db, idea.id, structured);
    res.status(201).json(feature);
  } catch (err) { next(err); }
});

ideasRouter.patch('/:id/features/:featureId', async (req, res, next) => {
  try {
    const body = structuredFeatureSchema.partial().parse(req.body);
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    const features = structured.extra_features ?? [];
    const f = features.find((x) => x.id === req.params['featureId']);
    if (!f) throw new AppError(404, 'Feature not found');
    Object.assign(f, body, { id: f.id });
    await saveStructured(req.db, idea.id, structured);
    res.json(f);
  } catch (err) { next(err); }
});

ideasRouter.delete('/:id/features/:featureId', async (req, res, next) => {
  try {
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    const features = structured.extra_features ?? [];
    const idx = features.findIndex((f) => f.id === req.params['featureId']);
    if (idx < 0) throw new AppError(404, 'Feature not found');
    features.splice(idx, 1);
    await saveStructured(req.db, idea.id, structured);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── materials ───────────────────────────────────────────────────────────────
ideasRouter.post('/:id/materials', async (req, res, next) => {
  try {
    const body = structuredMaterialSchema.parse(req.body);
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    structured.materials ??= [];
    const material: StructuredMaterial = { ...body, id: body.id ?? newId() };
    structured.materials.push(material);
    await saveStructured(req.db, idea.id, structured);
    res.status(201).json(material);
  } catch (err) { next(err); }
});

ideasRouter.patch('/:id/materials/:matId', async (req, res, next) => {
  try {
    const body = structuredMaterialSchema.partial().parse(req.body);
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    const mats = structured.materials ?? [];
    const m = mats.find((x) => x.id === req.params['matId']);
    if (!m) throw new AppError(404, 'Material not found');
    Object.assign(m, body, { id: m.id });
    await saveStructured(req.db, idea.id, structured);
    res.json(m);
  } catch (err) { next(err); }
});

ideasRouter.delete('/:id/materials/:matId', async (req, res, next) => {
  try {
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    const mats = structured.materials ?? [];
    const idx = mats.findIndex((m) => m.id === req.params['matId']);
    if (idx < 0) throw new AppError(404, 'Material not found');
    mats.splice(idx, 1);
    await saveStructured(req.db, idea.id, structured);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── risks (string array, indexed by position) ───────────────────────────────
ideasRouter.post('/:id/risks', async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    structured.risks ??= [];
    structured.risks.push(text);
    await saveStructured(req.db, idea.id, structured);
    res.status(201).json({ index: structured.risks.length - 1, text });
  } catch (err) { next(err); }
});

ideasRouter.patch('/:id/risks/:idx', async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    const risks = structured.risks ?? [];
    const i = Number(req.params['idx']);
    if (!Number.isInteger(i) || i < 0 || i >= risks.length) throw new AppError(404, 'Risk not found');
    risks[i] = text;
    await saveStructured(req.db, idea.id, structured);
    res.json({ index: i, text });
  } catch (err) { next(err); }
});

ideasRouter.delete('/:id/risks/:idx', async (req, res, next) => {
  try {
    const idea = await loadOrFail(req, req.params['id']!);
    const structured = ensureStructured(idea);
    const risks = structured.risks ?? [];
    const i = Number(req.params['idx']);
    if (!Number.isInteger(i) || i < 0 || i >= risks.length) throw new AppError(404, 'Risk not found');
    risks.splice(i, 1);
    await saveStructured(req.db, idea.id, structured);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── title / description shortcuts ───────────────────────────────────────────
ideasRouter.patch('/:id/title', async (req, res, next) => {
  try {
    const { title } = z.object({ title: z.string().min(1).max(500) }).parse(req.body);
    const { rowCount } = await req.db.query(
      `UPDATE ideas SET title = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [title, req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Idea not found');
    // Mirror to project objective.
    await req.db.query(
      `UPDATE objectives SET title = $1, updated_at = NOW()
       WHERE id = (SELECT converted_to_id FROM ideas WHERE id = $2)
         AND user_id = $3 AND deleted_at IS NULL`,
      [title, req.params['id'], req.user.id],
    );
    res.json({ ok: true, title });
  } catch (err) { next(err); }
});

ideasRouter.patch('/:id/description', async (req, res, next) => {
  try {
    const { description } = z.object({ description: z.string().max(5000) }).parse(req.body);
    const { rowCount } = await req.db.query(
      `UPDATE ideas SET description = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [description, req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Idea not found');
    await req.db.query(
      `UPDATE objectives SET description = $1, updated_at = NOW()
       WHERE id = (SELECT converted_to_id FROM ideas WHERE id = $2)
         AND user_id = $3 AND deleted_at IS NULL`,
      [description, req.params['id'], req.user.id],
    );
    res.json({ ok: true, description });
  } catch (err) { next(err); }
});
