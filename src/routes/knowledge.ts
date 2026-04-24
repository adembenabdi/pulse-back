/**
 * Knowledge routes — Phase 7
 *
 * Resources     GET/POST /resources, GET/PATCH/DELETE /resources/:id
 *               POST/DELETE /resources/:id/links
 * Learning      GET /learning, POST /learning, PATCH/DELETE /learning/:id
 * Study         GET/POST /study, PATCH/DELETE /study/:id
 *               GET /study/stats
 * Pomodoro      GET/POST /pomodoro, PATCH /pomodoro/:id, GET /pomodoro/today
 * Reports       GET/POST /reports, GET/DELETE /reports/:id
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { extractResourceFromUrl } from '../services/ai/resource-extract.js';
import { isGroqAvailable } from '../services/ai/groq.js';

export const knowledgeRouter: Router = Router();
knowledgeRouter.use(requireAuth);

// ── AI URL extractor ─────────────────────────────────────────────────────────

const ExtractBody = z.object({ url: z.string().url() });

// POST /api/knowledge/resources/extract  — AI extracts info from a URL
knowledgeRouter.post('/resources/extract', async (req: Request, res: Response) => {
  const { url } = ExtractBody.parse(req.body);
  if (!isGroqAvailable()) throw new AppError(503, 'AI service not configured');
  const extracted = await extractResourceFromUrl(url);
  res.json(extracted);
});

// ════════════════════════════════════════════════════════════════════════════
// RESOURCES (bookmarks library)
// ════════════════════════════════════════════════════════════════════════════

const ResourceBody = z.object({
  title:       z.string().min(1).max(400),
  url:         z.string().url().optional(),
  description: z.string().optional(),
  tags:        z.array(z.string()).optional(),
});

const LinkBody = z.object({
  entity_type: z.enum(['idea', 'objective', 'item', 'calendar_item']),
  entity_id:   z.string().uuid(),
});

// GET /api/knowledge/resources  ?search=&tag=&page=&limit=
knowledgeRouter.get('/resources', async (req: Request, res: Response) => {
  const { search, tag, page, limit } = req.query as Record<string, string | undefined>;
  const lim    = Math.min(Number(limit) || 50, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * lim;

  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT id, title, url, description, tags, created_at
     FROM resources
     WHERE ($1::text IS NULL OR title ILIKE '%' || $1 || '%' OR url ILIKE '%' || $1 || '%')
       AND ($2::text IS NULL OR $2 = ANY(tags))
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [search ?? null, tag ?? null, lim, offset],
  );
  res.json(rows);
});

// POST /api/knowledge/resources
knowledgeRouter.post('/resources', async (req: Request, res: Response) => {
  const b = ResourceBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO resources (user_id, title, url, description, tags)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user!.id, b.title, b.url ?? null, b.description ?? null,
     b.tags ? JSON.stringify(b.tags) : null],
  );
  res.status(201).json(rows[0]);
});

// GET /api/knowledge/resources/:id  (with links)
knowledgeRouter.get('/resources/:id', async (req: Request, res: Response) => {
  const { rows: resRows } = await req.db!.query<Record<string, unknown>>(
    'SELECT * FROM resources WHERE id=$1',
    [req.params['id']],
  );
  const resource = resRows[0];
  if (!resource) throw new AppError(404, 'Resource not found');

  const { rows: links } = await req.db!.query<Record<string, unknown>>(
    'SELECT entity_type, entity_id FROM resource_links WHERE resource_id=$1',
    [req.params['id']],
  );
  res.json({ ...resource, links });
});

// PATCH /api/knowledge/resources/:id
knowledgeRouter.patch('/resources/:id', async (req: Request, res: Response) => {
  const b = ResourceBody.partial().parse(req.body);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;
  if (b.title       !== undefined) { sets.push(`title=$${n++}`);       vals.push(b.title); }
  if (b.url         !== undefined) { sets.push(`url=$${n++}`);         vals.push(b.url); }
  if (b.description !== undefined) { sets.push(`description=$${n++}`); vals.push(b.description); }
  if (b.tags        !== undefined) { sets.push(`tags=$${n++}`);        vals.push(JSON.stringify(b.tags)); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE resources SET ${sets.join(',')} WHERE id=$${n} RETURNING *`,
    vals,
  );
  if (!rows[0]) throw new AppError(404, 'Resource not found');
  res.json(rows[0]);
});

// DELETE /api/knowledge/resources/:id
knowledgeRouter.delete('/resources/:id', async (req: Request, res: Response) => {
  await req.db!.query('UPDATE resources SET deleted_at=NOW() WHERE id=$1', [req.params['id']]);
  res.json({ ok: true });
});

// POST /api/knowledge/resources/:id/links
knowledgeRouter.post('/resources/:id/links', async (req: Request, res: Response) => {
  const b = LinkBody.parse(req.body);
  await req.db!.query(
    `INSERT INTO resource_links (resource_id, entity_type, entity_id)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [req.params['id'], b.entity_type, b.entity_id],
  );
  res.json({ ok: true });
});

// DELETE /api/knowledge/resources/:id/links
knowledgeRouter.delete('/resources/:id/links', async (req: Request, res: Response) => {
  const b = LinkBody.parse(req.body);
  await req.db!.query(
    'DELETE FROM resource_links WHERE resource_id=$1 AND entity_type=$2 AND entity_id=$3',
    [req.params['id'], b.entity_type, b.entity_id],
  );
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// LEARNING ENTRIES (daily log)
// ════════════════════════════════════════════════════════════════════════════

const LearningBody = z.object({
  logged_date:  z.string(),  // ISO date
  topic:        z.string().min(1).max(400),
  duration_min: z.number().int().nonnegative().optional(),
  source_url:   z.string().url().optional(),
  summary:      z.string().optional(),
});

// GET /api/knowledge/learning  ?from=&to=
knowledgeRouter.get('/learning', async (req: Request, res: Response) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM learning_entries
     WHERE ($1::date IS NULL OR logged_date >= $1::date)
       AND ($2::date IS NULL OR logged_date <= $2::date)
     ORDER BY logged_date DESC, created_at DESC
     LIMIT 200`,
    [from ?? null, to ?? null],
  );
  res.json(rows);
});

// POST /api/knowledge/learning
knowledgeRouter.post('/learning', async (req: Request, res: Response) => {
  const b = LearningBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO learning_entries (user_id, logged_date, topic, duration_min, source_url, summary)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user!.id, b.logged_date, b.topic,
     b.duration_min ?? null, b.source_url ?? null, b.summary ?? null],
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/knowledge/learning/:id
knowledgeRouter.patch('/learning/:id', async (req: Request, res: Response) => {
  const b = LearningBody.partial().parse(req.body);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;
  if (b.logged_date  !== undefined) { sets.push(`logged_date=$${n++}`);  vals.push(b.logged_date); }
  if (b.topic        !== undefined) { sets.push(`topic=$${n++}`);        vals.push(b.topic); }
  if (b.duration_min !== undefined) { sets.push(`duration_min=$${n++}`); vals.push(b.duration_min); }
  if (b.source_url   !== undefined) { sets.push(`source_url=$${n++}`);   vals.push(b.source_url); }
  if (b.summary      !== undefined) { sets.push(`summary=$${n++}`);      vals.push(b.summary); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE learning_entries SET ${sets.join(',')} WHERE id=$${n} RETURNING *`,
    vals,
  );
  if (!rows[0]) throw new AppError(404, 'Entry not found');
  res.json(rows[0]);
});

// DELETE /api/knowledge/learning/:id
knowledgeRouter.delete('/learning/:id', async (req: Request, res: Response) => {
  await req.db!.query('DELETE FROM learning_entries WHERE id=$1', [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// STUDY SESSIONS
// ════════════════════════════════════════════════════════════════════════════

const StudyBody = z.object({
  topic:        z.string().min(1).max(400),
  objective_id: z.string().uuid().optional(),
  started_at:   z.string().datetime().optional(),
  ended_at:     z.string().datetime().optional(),
  note:         z.string().optional(),
});

// GET /api/knowledge/study  ?from=&to=&objective_id=
knowledgeRouter.get('/study', async (req: Request, res: Response) => {
  const { from, to, objective_id } = req.query as Record<string, string | undefined>;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT ss.*,
       EXTRACT(EPOCH FROM (COALESCE(ss.ended_at, NOW()) - ss.started_at)) / 60 AS duration_min
     FROM study_sessions ss
     WHERE ($1::date IS NULL OR ss.started_at::date >= $1::date)
       AND ($2::date IS NULL OR ss.started_at::date <= $2::date)
       AND ($3::uuid IS NULL OR ss.objective_id = $3::uuid)
     ORDER BY ss.started_at DESC
     LIMIT 200`,
    [from ?? null, to ?? null, objective_id ?? null],
  );
  res.json(rows);
});

// GET /api/knowledge/study/stats  ?days=30
knowledgeRouter.get('/study/stats', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query['days']) || 30, 365);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT
       COUNT(*)::int                                     AS total_sessions,
       ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at)) / 60))::int AS total_min,
       COUNT(DISTINCT started_at::date)::int             AS days_studied,
       ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at)) / 60))::int AS avg_min
     FROM study_sessions
     WHERE started_at >= NOW() - ($1 || ' days')::interval`,
    [days],
  );
  res.json(rows[0] ?? { total_sessions: 0, total_min: 0, days_studied: 0, avg_min: 0 });
});

// POST /api/knowledge/study
knowledgeRouter.post('/study', async (req: Request, res: Response) => {
  const b = StudyBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO study_sessions (user_id, topic, objective_id, started_at, ended_at, note)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user!.id, b.topic, b.objective_id ?? null,
     b.started_at ?? new Date().toISOString(), b.ended_at ?? null, b.note ?? null],
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/knowledge/study/:id  (mainly to set ended_at / note)
knowledgeRouter.patch('/study/:id', async (req: Request, res: Response) => {
  const b = StudyBody.partial().parse(req.body);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;
  if (b.topic        !== undefined) { sets.push(`topic=$${n++}`);        vals.push(b.topic); }
  if (b.objective_id !== undefined) { sets.push(`objective_id=$${n++}`); vals.push(b.objective_id); }
  if (b.started_at   !== undefined) { sets.push(`started_at=$${n++}`);   vals.push(b.started_at); }
  if (b.ended_at     !== undefined) { sets.push(`ended_at=$${n++}`);     vals.push(b.ended_at); }
  if (b.note         !== undefined) { sets.push(`note=$${n++}`);         vals.push(b.note); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE study_sessions SET ${sets.join(',')} WHERE id=$${n} RETURNING *`,
    vals,
  );
  if (!rows[0]) throw new AppError(404, 'Study session not found');
  res.json(rows[0]);
});

// DELETE /api/knowledge/study/:id
knowledgeRouter.delete('/study/:id', async (req: Request, res: Response) => {
  await req.db!.query('DELETE FROM study_sessions WHERE id=$1', [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// POMODORO SESSIONS
// ════════════════════════════════════════════════════════════════════════════

const PomodoroBody = z.object({
  item_id:          z.string().uuid().optional(),
  study_session_id: z.string().uuid().optional(),
  started_at:       z.string().datetime().optional(),
  ended_at:         z.string().datetime().optional(),
  work_min:         z.number().int().min(1).max(120).optional(),
  break_min:        z.number().int().min(1).max(60).optional(),
  completed:        z.boolean().optional(),
});

// GET /api/knowledge/pomodoro  ?from=&to=
knowledgeRouter.get('/pomodoro', async (req: Request, res: Response) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM pomodoro_sessions
     WHERE ($1::date IS NULL OR started_at::date >= $1::date)
       AND ($2::date IS NULL OR started_at::date <= $2::date)
     ORDER BY started_at DESC
     LIMIT 200`,
    [from ?? null, to ?? null],
  );
  res.json(rows);
});

// GET /api/knowledge/pomodoro/today
knowledgeRouter.get('/pomodoro/today', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT
       COUNT(*)::int                   AS total,
       COUNT(*) FILTER (WHERE completed)::int AS completed,
       COALESCE(SUM(work_min), 0)::int AS work_min_total
     FROM pomodoro_sessions
     WHERE started_at::date = CURRENT_DATE`,
    [],
  );
  res.json(rows[0] ?? { total: 0, completed: 0, work_min_total: 0 });
});

// POST /api/knowledge/pomodoro  (start a new session)
knowledgeRouter.post('/pomodoro', async (req: Request, res: Response) => {
  const b = PomodoroBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO pomodoro_sessions
       (user_id, item_id, study_session_id, started_at, work_min, break_min, completed)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.user!.id, b.item_id ?? null, b.study_session_id ?? null,
     b.started_at ?? new Date().toISOString(),
     b.work_min ?? 25, b.break_min ?? 5, b.completed ?? false],
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/knowledge/pomodoro/:id  (complete / set ended_at)
knowledgeRouter.patch('/pomodoro/:id', async (req: Request, res: Response) => {
  const b = PomodoroBody.partial().parse(req.body);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;
  if (b.ended_at   !== undefined) { sets.push(`ended_at=$${n++}`);   vals.push(b.ended_at); }
  if (b.completed  !== undefined) { sets.push(`completed=$${n++}`);  vals.push(b.completed); }
  if (b.work_min   !== undefined) { sets.push(`work_min=$${n++}`);   vals.push(b.work_min); }
  if (b.break_min  !== undefined) { sets.push(`break_min=$${n++}`);  vals.push(b.break_min); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE pomodoro_sessions SET ${sets.join(',')} WHERE id=$${n} RETURNING *`,
    vals,
  );
  if (!rows[0]) throw new AppError(404, 'Session not found');
  res.json(rows[0]);
});

// ════════════════════════════════════════════════════════════════════════════
// REPORTS
// ════════════════════════════════════════════════════════════════════════════

const ReportBody = z.object({
  title:        z.string().min(1).max(200),
  period_type:  z.enum(['daily', 'weekly', 'monthly']),
  period_start: z.string(),  // ISO date
  period_end:   z.string(),  // ISO date
  data:         z.record(z.unknown()).optional(),
});

// GET /api/knowledge/reports  ?period_type=&from=&to=
knowledgeRouter.get('/reports', async (req: Request, res: Response) => {
  const { period_type, from, to } = req.query as Record<string, string | undefined>;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM reports
     WHERE ($1::text IS NULL OR period_type = $1)
       AND ($2::date IS NULL OR period_start >= $2::date)
       AND ($3::date IS NULL OR period_end   <= $3::date)
     ORDER BY period_start DESC
     LIMIT 100`,
    [period_type ?? null, from ?? null, to ?? null],
  );
  res.json(rows);
});

// POST /api/knowledge/reports
knowledgeRouter.post('/reports', async (req: Request, res: Response) => {
  const b = ReportBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO reports (user_id, title, period_type, period_start, period_end, data)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user!.id, b.title, b.period_type, b.period_start, b.period_end,
     JSON.stringify(b.data ?? {})],
  );
  res.status(201).json(rows[0]);
});

// GET /api/knowledge/reports/:id
knowledgeRouter.get('/reports/:id', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    'SELECT * FROM reports WHERE id=$1',
    [req.params['id']],
  );
  if (!rows[0]) throw new AppError(404, 'Report not found');
  res.json(rows[0]);
});

// DELETE /api/knowledge/reports/:id
knowledgeRouter.delete('/reports/:id', async (req: Request, res: Response) => {
  await req.db!.query('DELETE FROM reports WHERE id=$1', [req.params['id']]);
  res.json({ ok: true });
});
