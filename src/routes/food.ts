/**
 * Food routes — Phase 6
 *
 * Recipes     GET/POST /recipes, GET/PATCH/DELETE /recipes/:id
 *             GET/PUT  /recipes/:id/ingredients
 * Meal logs   GET /logs, POST /logs, DELETE /logs/:id
 * Meal plans  GET/POST /plans, GET/PATCH/DELETE /plans/:id
 *             GET/PUT  /plans/:id/slots
 *             POST/DELETE /plans/:id/members/:uid
 *             POST     /plans/:id/activate
 *             POST     /plans/:id/shopping-list   (auto-generate)
 * Pantry      GET/POST /pantry, PATCH/DELETE /pantry/:id
 * Shopping    GET /shopping, POST /shopping, PATCH /shopping/:id, DELETE /shopping/:id
 *             DELETE   /shopping/clear-checked
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';

export const foodRouter: Router = Router();
foodRouter.use(requireAuth);

// ════════════════════════════════════════════════════════════════════════════
// RECIPES
// ════════════════════════════════════════════════════════════════════════════

const RecipeBody = z.object({
  title:       z.string().min(1).max(200),
  description: z.string().optional(),
  prep_min:    z.number().int().nonnegative().optional(),
  cook_min:    z.number().int().nonnegative().optional(),
  servings:    z.number().int().positive().optional(),
  image_url:   z.string().url().optional(),
  tags:        z.array(z.string()).optional(),
});

const IngredientSchema = z.object({
  name:       z.string().min(1),
  quantity:   z.string().optional(),
  unit:       z.string().optional(),
  sort_order: z.number().int().nonnegative().optional(),
});

// GET /api/food/recipes
foodRouter.get('/recipes', async (req: Request, res: Response) => {
  const { search, tag, page, limit } = req.query as Record<string, string | undefined>;
  const lim    = Math.min(Number(limit) || 50, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * lim;

  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT id, title, description, prep_min, cook_min, servings, image_url, tags, created_at
     FROM recipes
     WHERE ($1::text IS NULL OR title ILIKE '%' || $1 || '%')
       AND ($2::text IS NULL OR $2 = ANY(tags))
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [search ?? null, tag ?? null, lim, offset],
  );
  res.json(rows);
});

// POST /api/food/recipes
foodRouter.post('/recipes', async (req: Request, res: Response) => {
  const b = RecipeBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO recipes (user_id, title, description, prep_min, cook_min, servings, image_url, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user!.id, b.title, b.description ?? null, b.prep_min ?? null, b.cook_min ?? null,
     b.servings ?? null, b.image_url ?? null, b.tags ? JSON.stringify(b.tags) : null],
  );
  res.status(201).json(rows[0]);
});

// GET /api/food/recipes/:id
foodRouter.get('/recipes/:id', async (req: Request, res: Response) => {
  const { rows: recRows } = await req.db!.query<Record<string, unknown>>(
    'SELECT * FROM recipes WHERE id = $1',
    [req.params['id']],
  );
  const recipe = recRows[0];
  if (!recipe) throw new AppError(404, 'Recipe not found');

  const { rows: ingredients } = await req.db!.query<Record<string, unknown>>(
    'SELECT * FROM recipe_ingredients WHERE recipe_id = $1 ORDER BY sort_order',
    [req.params['id']],
  );
  res.json({ ...recipe, ingredients });
});

// PATCH /api/food/recipes/:id
foodRouter.patch('/recipes/:id', async (req: Request, res: Response) => {
  const b = RecipeBody.partial().parse(req.body);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;
  if (b.title       !== undefined) { sets.push(`title=$${n++}`);       vals.push(b.title); }
  if (b.description !== undefined) { sets.push(`description=$${n++}`); vals.push(b.description); }
  if (b.prep_min    !== undefined) { sets.push(`prep_min=$${n++}`);    vals.push(b.prep_min); }
  if (b.cook_min    !== undefined) { sets.push(`cook_min=$${n++}`);    vals.push(b.cook_min); }
  if (b.servings    !== undefined) { sets.push(`servings=$${n++}`);    vals.push(b.servings); }
  if (b.image_url   !== undefined) { sets.push(`image_url=$${n++}`);   vals.push(b.image_url); }
  if (b.tags        !== undefined) { sets.push(`tags=$${n++}`);        vals.push(JSON.stringify(b.tags)); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE recipes SET ${sets.join(',')} WHERE id=$${n} RETURNING *`,
    vals,
  );
  if (!rows[0]) throw new AppError(404, 'Recipe not found');
  res.json(rows[0]);
});

// DELETE /api/food/recipes/:id
foodRouter.delete('/recipes/:id', async (req: Request, res: Response) => {
  await req.db!.query(
    `UPDATE recipes SET deleted_at=NOW() WHERE id=$1`,
    [req.params['id']],
  );
  res.json({ ok: true });
});

// GET /api/food/recipes/:id/ingredients
foodRouter.get('/recipes/:id/ingredients', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    'SELECT * FROM recipe_ingredients WHERE recipe_id = $1 ORDER BY sort_order',
    [req.params['id']],
  );
  res.json(rows);
});

// PUT /api/food/recipes/:id/ingredients  (full replace)
foodRouter.put('/recipes/:id/ingredients', async (req: Request, res: Response) => {
  const items = z.array(IngredientSchema).parse(req.body);
  const recipeId = req.params['id'];

  await req.db!.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1', [recipeId]);
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    await req.db!.query(
      `INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit, sort_order)
       VALUES ($1,$2,$3,$4,$5)`,
      [recipeId, it.name, it.quantity ?? null, it.unit ?? null, it.sort_order ?? i],
    );
  }
  const { rows } = await req.db!.query<Record<string, unknown>>(
    'SELECT * FROM recipe_ingredients WHERE recipe_id=$1 ORDER BY sort_order',
    [recipeId],
  );
  res.json(rows);
});

// ════════════════════════════════════════════════════════════════════════════
// MEAL LOGS
// ════════════════════════════════════════════════════════════════════════════

const MealLogBody = z.object({
  recipe_id: z.string().uuid().optional(),
  meal_type: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
  logged_at: z.string().datetime().optional(),
  note:      z.string().optional(),
});

// GET /api/food/logs  ?from=&to=&meal_type=
foodRouter.get('/logs', async (req: Request, res: Response) => {
  const { from, to, meal_type } = req.query as Record<string, string | undefined>;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT ml.*, r.title AS recipe_title
     FROM meal_logs ml
     LEFT JOIN recipes r ON r.id = ml.recipe_id AND r.deleted_at IS NULL
     WHERE ($1::date IS NULL OR ml.logged_at::date >= $1::date)
       AND ($2::date IS NULL OR ml.logged_at::date <= $2::date)
       AND ($3::text IS NULL OR ml.meal_type = $3)
     ORDER BY ml.logged_at DESC
     LIMIT 200`,
    [from ?? null, to ?? null, meal_type ?? null],
  );
  res.json(rows);
});

// POST /api/food/logs
foodRouter.post('/logs', async (req: Request, res: Response) => {
  const b = MealLogBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO meal_logs (user_id, recipe_id, meal_type, logged_at, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user!.id, b.recipe_id ?? null, b.meal_type,
     b.logged_at ?? new Date().toISOString(), b.note ?? null],
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/food/logs/:id
foodRouter.delete('/logs/:id', async (req: Request, res: Response) => {
  await req.db!.query('DELETE FROM meal_logs WHERE id=$1', [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// MEAL PLANS
// ════════════════════════════════════════════════════════════════════════════

const PlanBody = z.object({
  title:     z.string().min(1).max(200),
  is_active: z.boolean().optional(),
});

const SlotSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  meal_type:   z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
  recipe_id:   z.string().uuid().optional(),
  label:       z.string().optional(),
});

// GET /api/food/plans
foodRouter.get('/plans', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    'SELECT * FROM meal_plans ORDER BY is_active DESC, created_at DESC',
    [],
  );
  res.json(rows);
});

// POST /api/food/plans
foodRouter.post('/plans', async (req: Request, res: Response) => {
  const b = PlanBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO meal_plans (user_id, title, is_active) VALUES ($1,$2,$3) RETURNING *`,
    [req.user!.id, b.title, b.is_active ?? false],
  );
  res.status(201).json(rows[0]);
});

// GET /api/food/plans/:id  (with slots + members)
foodRouter.get('/plans/:id', async (req: Request, res: Response) => {
  const { rows: planRows } = await req.db!.query<Record<string, unknown>>(
    'SELECT * FROM meal_plans WHERE id=$1',
    [req.params['id']],
  );
  const plan = planRows[0];
  if (!plan) throw new AppError(404, 'Meal plan not found');

  const { rows: slots } = await req.db!.query<Record<string, unknown>>(
    `SELECT mps.*, r.title AS recipe_title
     FROM meal_plan_slots mps
     LEFT JOIN recipes r ON r.id = mps.recipe_id AND r.deleted_at IS NULL
     WHERE mps.plan_id=$1
     ORDER BY mps.day_of_week, mps.meal_type`,
    [req.params['id']],
  );
  const { rows: members } = await req.db!.query<Record<string, unknown>>(
    `SELECT mpm.*, u.name, u.avatar_url
     FROM meal_plan_members mpm
     JOIN users u ON u.id = mpm.user_id
     WHERE mpm.plan_id=$1`,
    [req.params['id']],
  );
  res.json({ ...plan, slots, members });
});

// PATCH /api/food/plans/:id
foodRouter.patch('/plans/:id', async (req: Request, res: Response) => {
  const b = PlanBody.partial().parse(req.body);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;
  if (b.title     !== undefined) { sets.push(`title=$${n++}`);     vals.push(b.title); }
  if (b.is_active !== undefined) { sets.push(`is_active=$${n++}`); vals.push(b.is_active); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE meal_plans SET ${sets.join(',')} WHERE id=$${n} RETURNING *`,
    vals,
  );
  if (!rows[0]) throw new AppError(404, 'Meal plan not found');
  res.json(rows[0]);
});

// DELETE /api/food/plans/:id
foodRouter.delete('/plans/:id', async (req: Request, res: Response) => {
  await req.db!.query('UPDATE meal_plans SET deleted_at=NOW() WHERE id=$1', [req.params['id']]);
  res.json({ ok: true });
});

// POST /api/food/plans/:id/activate
foodRouter.post('/plans/:id/activate', async (req: Request, res: Response) => {
  await req.db!.query('UPDATE meal_plans SET is_active=FALSE', []);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    'UPDATE meal_plans SET is_active=TRUE WHERE id=$1 RETURNING *',
    [req.params['id']],
  );
  if (!rows[0]) throw new AppError(404, 'Meal plan not found');
  res.json(rows[0]);
});

// GET /api/food/plans/:id/slots
foodRouter.get('/plans/:id/slots', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT mps.*, r.title AS recipe_title
     FROM meal_plan_slots mps
     LEFT JOIN recipes r ON r.id = mps.recipe_id AND r.deleted_at IS NULL
     WHERE mps.plan_id=$1 ORDER BY mps.day_of_week, mps.meal_type`,
    [req.params['id']],
  );
  res.json(rows);
});

// PUT /api/food/plans/:id/slots  (full replace)
foodRouter.put('/plans/:id/slots', async (req: Request, res: Response) => {
  const slots = z.array(SlotSchema).parse(req.body);
  const planId = req.params['id'];

  const { rows: planRows } = await req.db!.query<Record<string, unknown>>(
    'SELECT id FROM meal_plans WHERE id=$1',
    [planId],
  );
  if (!planRows[0]) throw new AppError(404, 'Meal plan not found');

  await req.db!.query('DELETE FROM meal_plan_slots WHERE plan_id=$1', [planId]);
  for (const s of slots) {
    await req.db!.query(
      `INSERT INTO meal_plan_slots (plan_id, day_of_week, meal_type, recipe_id, label)
       VALUES ($1,$2,$3,$4,$5)`,
      [planId, s.day_of_week, s.meal_type, s.recipe_id ?? null, s.label ?? null],
    );
  }
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT mps.*, r.title AS recipe_title
     FROM meal_plan_slots mps
     LEFT JOIN recipes r ON r.id = mps.recipe_id AND r.deleted_at IS NULL
     WHERE mps.plan_id=$1 ORDER BY mps.day_of_week, mps.meal_type`,
    [planId],
  );
  res.json(rows);
});

// POST /api/food/plans/:id/members/:uid
foodRouter.post('/plans/:id/members/:uid', async (req: Request, res: Response) => {
  const { role } = z.object({ role: z.enum(['viewer', 'editor']).default('viewer') }).parse(req.body);
  await req.db!.query(
    `INSERT INTO meal_plan_members (plan_id, user_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (plan_id, user_id) DO UPDATE SET role=EXCLUDED.role`,
    [req.params['id'], req.params['uid'], role],
  );
  res.json({ ok: true });
});

// DELETE /api/food/plans/:id/members/:uid
foodRouter.delete('/plans/:id/members/:uid', async (req: Request, res: Response) => {
  await req.db!.query(
    'DELETE FROM meal_plan_members WHERE plan_id=$1 AND user_id=$2',
    [req.params['id'], req.params['uid']],
  );
  res.json({ ok: true });
});

// POST /api/food/plans/:id/shopping-list  (auto-generate from slots)
foodRouter.post('/plans/:id/shopping-list', async (req: Request, res: Response) => {
  const planId = req.params['id'];
  const { rows: planRows } = await req.db!.query<Record<string, unknown>>(
    'SELECT id FROM meal_plans WHERE id=$1',
    [planId],
  );
  if (!planRows[0]) throw new AppError(404, 'Meal plan not found');

  const { rows: slots } = await req.db!.query<{ recipe_id: string | null }>(
    'SELECT recipe_id FROM meal_plan_slots WHERE plan_id=$1 AND recipe_id IS NOT NULL',
    [planId],
  );
  const recipeIds = [...new Set(
    slots.map(s => s.recipe_id).filter((id): id is string => id !== null),
  )];

  if (recipeIds.length === 0) { res.json({ inserted: 0 }); return; }

  const ph = recipeIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: ingredients } = await req.db!.query<{ name: string; quantity: string | null; unit: string | null }>(
    `SELECT name, quantity, unit FROM recipe_ingredients WHERE recipe_id IN (${ph})`,
    recipeIds,
  );

  let inserted = 0;
  for (const ing of ingredients) {
    await req.db!.query(
      `INSERT INTO shopping_list_items (user_id, plan_id, name, quantity, unit)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.user!.id, planId, ing.name, ing.quantity ?? null, ing.unit ?? null],
    );
    inserted++;
  }
  res.json({ inserted });
});

// ════════════════════════════════════════════════════════════════════════════
// PANTRY
// ════════════════════════════════════════════════════════════════════════════

const PantryBody = z.object({
  name:       z.string().min(1).max(200),
  quantity:   z.string().optional(),
  unit:       z.string().optional(),
  expires_on: z.string().optional(),
  in_stock:   z.boolean().optional(),
});

// GET /api/food/pantry  ?in_stock=true|false
foodRouter.get('/pantry', async (req: Request, res: Response) => {
  const { in_stock } = req.query as Record<string, string | undefined>;
  const filterStock = in_stock != null ? in_stock === 'true' : null;
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `SELECT * FROM pantry_items
     WHERE ($1::boolean IS NULL OR in_stock = $1)
     ORDER BY in_stock DESC, name`,
    [filterStock],
  );
  res.json(rows);
});

// POST /api/food/pantry
foodRouter.post('/pantry', async (req: Request, res: Response) => {
  const b = PantryBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO pantry_items (user_id, name, quantity, unit, expires_on, in_stock)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user!.id, b.name, b.quantity ?? null, b.unit ?? null,
     b.expires_on ?? null, b.in_stock ?? true],
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/food/pantry/:id
foodRouter.patch('/pantry/:id', async (req: Request, res: Response) => {
  const b = PantryBody.partial().parse(req.body);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;
  if (b.name       !== undefined) { sets.push(`name=$${n++}`);       vals.push(b.name); }
  if (b.quantity   !== undefined) { sets.push(`quantity=$${n++}`);   vals.push(b.quantity); }
  if (b.unit       !== undefined) { sets.push(`unit=$${n++}`);       vals.push(b.unit); }
  if (b.expires_on !== undefined) { sets.push(`expires_on=$${n++}`); vals.push(b.expires_on); }
  if (b.in_stock   !== undefined) { sets.push(`in_stock=$${n++}`);   vals.push(b.in_stock); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE pantry_items SET ${sets.join(',')} WHERE id=$${n} RETURNING *`,
    vals,
  );
  if (!rows[0]) throw new AppError(404, 'Pantry item not found');
  res.json(rows[0]);
});

// DELETE /api/food/pantry/:id
foodRouter.delete('/pantry/:id', async (req: Request, res: Response) => {
  await req.db!.query('DELETE FROM pantry_items WHERE id=$1', [req.params['id']]);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// SHOPPING LIST
// ════════════════════════════════════════════════════════════════════════════

const ShoppingBody = z.object({
  name:     z.string().min(1).max(200),
  quantity: z.string().optional(),
  unit:     z.string().optional(),
  plan_id:  z.string().uuid().optional(),
  checked:  z.boolean().optional(),
});

// GET /api/food/shopping
foodRouter.get('/shopping', async (req: Request, res: Response) => {
  const { rows } = await req.db!.query<Record<string, unknown>>(
    'SELECT * FROM shopping_list_items ORDER BY checked, created_at',
    [],
  );
  res.json(rows);
});

// POST /api/food/shopping
foodRouter.post('/shopping', async (req: Request, res: Response) => {
  const b = ShoppingBody.parse(req.body);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `INSERT INTO shopping_list_items (user_id, plan_id, name, quantity, unit, checked)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user!.id, b.plan_id ?? null, b.name, b.quantity ?? null, b.unit ?? null, b.checked ?? false],
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/food/shopping/:id
foodRouter.patch('/shopping/:id', async (req: Request, res: Response) => {
  const b = ShoppingBody.partial().parse(req.body);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let n = 1;
  if (b.name     !== undefined) { sets.push(`name=$${n++}`);     vals.push(b.name); }
  if (b.quantity !== undefined) { sets.push(`quantity=$${n++}`); vals.push(b.quantity); }
  if (b.unit     !== undefined) { sets.push(`unit=$${n++}`);     vals.push(b.unit); }
  if (b.checked  !== undefined) { sets.push(`checked=$${n++}`);  vals.push(b.checked); }
  if (sets.length === 0) throw new AppError(400, 'Nothing to update');
  vals.push(req.params['id']);
  const { rows } = await req.db!.query<Record<string, unknown>>(
    `UPDATE shopping_list_items SET ${sets.join(',')} WHERE id=$${n} RETURNING *`,
    vals,
  );
  if (!rows[0]) throw new AppError(404, 'Shopping item not found');
  res.json(rows[0]);
});

// DELETE /api/food/shopping/:id
foodRouter.delete('/shopping/:id', async (req: Request, res: Response) => {
  await req.db!.query('DELETE FROM shopping_list_items WHERE id=$1', [req.params['id']]);
  res.json({ ok: true });
});

// DELETE /api/food/shopping/clear-checked
foodRouter.delete('/shopping/clear-checked', async (req: Request, res: Response) => {
  const result = await req.db!.query<never>(
    'DELETE FROM shopping_list_items WHERE checked=TRUE',
    [],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});
