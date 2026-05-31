/**
 * services/ai/execute.ts
 *
 * Writes interpreted CaptureItems into the database (tasks, ideas, events).
 * Uses the admin pool with explicit user_id (callable from Telegram + web).
 */

import { db } from '../../lib/db.js';
import { structureIdea } from './structure-idea.js';
import type { CaptureItem } from './interpret.js';

export interface ExecutedAction {
  type:  'task' | 'idea' | 'event';
  id:    string;
  title: string;
  detail?: string;
}

async function findOrCreateProject(userId: string, name: string): Promise<string> {
  const existing = await db.admin.query<{ id: string }>(
    `SELECT id FROM projects
     WHERE user_id = $1 AND deleted_at IS NULL AND lower(name) = lower($2)
     LIMIT 1`,
    [userId, name],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const created = await db.admin.query<{ id: string }>(
    `INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`,
    [userId, name],
  );
  return created.rows[0]!.id;
}

async function executeOne(userId: string, item: CaptureItem): Promise<ExecutedAction> {
  switch (item.type) {
    case 'task': {
      const projectId = item.project_name
        ? await findOrCreateProject(userId, item.project_name)
        : null;
      const { rows } = await db.admin.query<{ id: string; title: string }>(
        `INSERT INTO tasks (user_id, project_id, title, notes, priority, due_at)
         VALUES ($1, $2, $3, $4, COALESCE($5, 'medium')::task_priority, $6)
         RETURNING id, title`,
        [userId, projectId, item.title, item.notes ?? null, item.priority ?? null, item.due_at ?? null],
      );
      return {
        type: 'task',
        id: rows[0]!.id,
        title: rows[0]!.title,
        ...(item.project_name ? { detail: `in ${item.project_name}` } : {}),
      };
    }

    case 'idea': {
      const structured = await structureIdea(item.title, item.raw_text);
      const { rows } = await db.admin.query<{ id: string; title: string }>(
        `INSERT INTO ideas (user_id, title, raw_text, structured, status)
         VALUES ($1, $2, $3, $4::jsonb, 'structured')
         RETURNING id, title`,
        [userId, item.title, item.raw_text ?? null, JSON.stringify(structured)],
      );
      return { type: 'idea', id: rows[0]!.id, title: rows[0]!.title };
    }

    case 'event': {
      const { rows } = await db.admin.query<{ id: string; title: string }>(
        `INSERT INTO calendar_events (user_id, title, description, location, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, title`,
        [userId, item.title, item.description ?? null, item.location ?? null, item.starts_at, item.ends_at ?? null],
      );
      return { type: 'event', id: rows[0]!.id, title: rows[0]!.title };
    }
  }
}

export async function executeItems(userId: string, items: CaptureItem[]): Promise<ExecutedAction[]> {
  const out: ExecutedAction[] = [];
  for (const item of items) {
    out.push(await executeOne(userId, item));
  }
  return out;
}
