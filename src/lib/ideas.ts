/**
 * lib/ideas.ts
 *
 * Helpers for the "idea = project" model. Every idea has (or will have on
 * first save/organize) a paired `objectives` row of kind='project', linked via
 * `ideas.converted_to_id`. Granular structured-field mutations sync the
 * relevant `items` rows so the project's task list stays consistent.
 */

import { randomUUID } from 'node:crypto';
import type { ScopedDb } from './db.js';

export type StructuredPriority = 'low' | 'medium' | 'high';

export interface StructuredTask {
  id?:         string | undefined;
  title:       string;
  effort_min?: number | undefined;
  priority?:   StructuredPriority | undefined;
  done?:       boolean | undefined;
  /** items.id once materialized */
  item_id?:    string | null | undefined;
}

export interface StructuredMaterial {
  id?:       string | undefined;
  name:      string;
  category?: 'tool' | 'service' | 'hardware' | 'knowledge' | 'other' | undefined;
  note?:     string | undefined;
}

export interface StructuredFeature {
  id?:          string | undefined;
  title:        string;
  description?: string | undefined;
}

export interface OrganizedStructured {
  summary?:         string | undefined;
  target_audience?: string | undefined;
  tasks?:           StructuredTask[] | undefined;
  materials?:       StructuredMaterial[] | undefined;
  extra_features?:  StructuredFeature[] | undefined;
  risks?:           string[] | undefined;
  next_step?:       string | undefined;
  generated_at?:    string | undefined;
}

export interface IdeaRow {
  id:               string;
  user_id:          string;
  role_id:          string | null;
  title:            string;
  description:      string | null;
  raw_description:  string | null;
  validation_status:string;
  converted_to_id:  string | null;
  structured:       OrganizedStructured | null;
}

/**
 * Load an idea row scoped to the current user. Throws-style not used here;
 * caller decides what to do with `null`.
 */
export async function loadIdea(
  db: ScopedDb,
  ideaId: string,
): Promise<IdeaRow | null> {
  const { rows } = await db.query<IdeaRow>(
    `SELECT id, user_id, role_id, title, description, raw_description,
            validation_status, converted_to_id, structured
     FROM ideas
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [ideaId, db.userId],
  );
  return rows[0] ?? null;
}

/**
 * Ensure the idea has a paired `objectives` row (kind=project). Returns
 * objective id. Idempotent.
 */
export async function ensureProject(
  db: ScopedDb,
  idea: IdeaRow,
): Promise<string> {
  if (idea.converted_to_id) return idea.converted_to_id;

  const status =
    idea.validation_status === 'dropped' ? 'cancelled' :
    idea.validation_status === 'validated' ? 'in_progress' :
    'todo';

  const { rows: [obj] } = await db.query<{ id: string }>(
    `INSERT INTO objectives (user_id, role_id, kind, title, description, status, priority)
     VALUES ($1, $2, 'project', $3, $4, $5, 'medium')
     RETURNING id`,
    [db.userId, idea.role_id, idea.title, idea.description ?? '', status],
  );
  await db.query(
    `UPDATE ideas SET converted_to_id = $1, updated_at = NOW() WHERE id = $2`,
    [obj!.id, idea.id],
  );
  idea.converted_to_id = obj!.id;
  return obj!.id;
}

/** Persist the structured payload back to the ideas row. */
export async function saveStructured(
  db: ScopedDb,
  ideaId: string,
  structured: OrganizedStructured,
): Promise<void> {
  await db.query(
    `UPDATE ideas SET structured = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3`,
    [JSON.stringify(structured), ideaId, db.userId],
  );
}

const PRIORITY_VALUES: StructuredPriority[] = ['low', 'medium', 'high'];
function clampPriority(p: unknown): StructuredPriority {
  return typeof p === 'string' && (PRIORITY_VALUES as string[]).includes(p)
    ? p as StructuredPriority
    : 'medium';
}
function clampEffort(n: unknown): number {
  const v = Number(n ?? 30);
  if (!Number.isFinite(v)) return 30;
  return Math.max(5, Math.min(480, Math.round(v)));
}

/**
 * Insert a structured task as a real `items` row under the project objective.
 * Returns the new items.id.
 */
export async function createItemForTask(
  db: ScopedDb,
  objectiveId: string,
  roleId: string | null,
  task: StructuredTask,
): Promise<string> {
  const { rows: [item] } = await db.query<{ id: string }>(
    `INSERT INTO items
       (user_id, objective_id, role_id, kind, title, status, priority, estimated_min)
     VALUES ($1, $2, $3, 'task', $4, $5, $6, $7)
     RETURNING id`,
    [
      db.userId,
      objectiveId,
      roleId,
      task.title,
      task.done ? 'done' : 'todo',
      clampPriority(task.priority),
      clampEffort(task.effort_min),
    ],
  );
  return item!.id;
}

/** Best-effort sync: keep an existing items row in step with a structured task. */
export async function updateItemForTask(
  db: ScopedDb,
  itemId: string,
  patch: {
    title?:      string | undefined;
    priority?:   StructuredPriority | undefined;
    effort_min?: number | undefined;
    done?:       boolean | undefined;
  },
): Promise<void> {
  const cols: string[] = [];
  const vals: unknown[] = [];
  let p = 1;
  if (patch.title !== undefined) {
    cols.push(`title = $${p++}`); vals.push(patch.title);
  }
  if (patch.priority !== undefined) {
    cols.push(`priority = $${p++}`); vals.push(clampPriority(patch.priority));
  }
  if (patch.effort_min !== undefined) {
    cols.push(`estimated_min = $${p++}`); vals.push(clampEffort(patch.effort_min));
  }
  if (patch.done !== undefined) {
    cols.push(`status = $${p++}`); vals.push(patch.done ? 'done' : 'todo');
  }
  if (!cols.length) return;
  vals.push(itemId, db.userId);
  await db.query(
    `UPDATE items SET ${cols.join(', ')}, updated_at = NOW()
     WHERE id = $${p++} AND user_id = $${p} AND deleted_at IS NULL`,
    vals,
  );
}

export async function softDeleteItem(db: ScopedDb, itemId: string): Promise<void> {
  await db.query(
    `UPDATE items SET deleted_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [itemId, db.userId],
  );
}

/**
 * Materialize all structured.tasks that don't yet have an `item_id`, mutating
 * `structured.tasks[*].item_id` in place. Caller should persist the result.
 */
export async function materializeMissingTasks(
  db: ScopedDb,
  objectiveId: string,
  roleId: string | null,
  structured: OrganizedStructured,
): Promise<void> {
  if (!Array.isArray(structured.tasks)) return;
  for (const task of structured.tasks) {
    if (task.item_id) continue;
    if (!task.id) task.id = randomUUID();
    task.item_id = await createItemForTask(db, objectiveId, roleId, task);
  }
}

export function newId(): string {
  return randomUUID();
}
