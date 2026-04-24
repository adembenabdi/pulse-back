/**
 * services/ai/dispatch.ts
 *
 * Take an array of {@link ExtractedItem} proposals and turn them into real
 * rows in the database. Used by:
 *   - POST /api/assistant/commit  (in-app QuickCapture)
 *   - Telegram free-text messages (auto-commit)
 *
 * Each proposal is routed to the right table:
 *   task      → items (kind='task')
 *   note      → items (kind='note')
 *   idea      → ideas
 *   event     → calendar_items (kind='event')
 *   meeting   → calendar_items (kind='meeting')
 *   reminder  → calendar_items (kind='reminder')
 *   resource  → resources
 *   habit_log → habit_logs (best-effort fuzzy match on habit_name)
 *
 * Returns one {@link DispatchResult} per input proposal so the caller can
 * report back what was created (and what failed).
 */

import type { ScopedDb } from '../../lib/db.js';
import type { ExtractedItem } from './extract.js';
import { logger } from '../../lib/logger.js';

export interface DispatchResult {
  ok:        boolean;
  kind:      ExtractedItem['kind'];
  title:     string;
  /** target table (only when ok) */
  table?:    string;
  /** created row id (only when ok) */
  id?:       string;
  /** human-readable error (only when !ok) */
  error?:    string;
}

export async function dispatchProposals(
  db:    ScopedDb,
  items: ExtractedItem[],
): Promise<DispatchResult[]> {
  const out: DispatchResult[] = [];
  for (const it of items) {
    try {
      const r = await dispatchOne(db, it);
      out.push(r);
    } catch (err) {
      logger.warn({ err, kind: it.kind, title: it.title }, 'dispatchOne failed');
      out.push({ ok: false, kind: it.kind, title: it.title, error: errMsg(err) });
    }
  }
  return out;
}

async function dispatchOne(db: ScopedDb, it: ExtractedItem): Promise<DispatchResult> {
  switch (it.kind) {
    case 'task':     return await insertItem(db, it, 'task');
    case 'note':     return await insertItem(db, it, 'note');
    case 'idea':     return await insertIdea(db, it);
    case 'event':    return await insertCalendar(db, it, 'event');
    case 'meeting':  return await insertCalendar(db, it, 'meeting');
    case 'reminder': return await insertCalendar(db, it, 'reminder');
    case 'resource': return await insertResource(db, it);
    case 'habit_log':return await insertHabitLog(db, it);
  }
}

// ── tasks / notes ─────────────────────────────────────────────────────────────
async function insertItem(
  db:   ScopedDb,
  it:   ExtractedItem,
  kind: 'task' | 'note',
): Promise<DispatchResult> {
  const priority = it.priority ?? 'medium';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO items (user_id, kind, title, notes, status, priority,
                        energy_required, due_at, estimated_min)
     VALUES ($1, $2, $3, $4, 'todo', $5, $6, $7, $8)
     RETURNING id`,
    [
      db.userId, kind, it.title, it.description,
      priority, it.energy, it.due_at, it.estimated_min,
    ],
  );
  return { ok: true, kind: it.kind, title: it.title, table: 'items', id: rows[0]!.id };
}

// ── ideas ─────────────────────────────────────────────────────────────────────
async function insertIdea(db: ScopedDb, it: ExtractedItem): Promise<DispatchResult> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ideas (user_id, title, description, raw_description, validation_status)
     VALUES ($1, $2, $3, $4, 'raw')
     RETURNING id`,
    [db.userId, it.title, it.description, it.raw],
  );
  return { ok: true, kind: it.kind, title: it.title, table: 'ideas', id: rows[0]!.id };
}

// ── calendar (event/meeting/reminder) ────────────────────────────────────────
async function insertCalendar(
  db:   ScopedDb,
  it:   ExtractedItem,
  kind: 'event' | 'meeting' | 'reminder',
): Promise<DispatchResult> {
  const starts = it.starts_at ?? it.due_at;
  if (!starts) {
    return { ok: false, kind: it.kind, title: it.title, error: 'no start time detected' };
  }
  // Default duration: meeting 30m, event 60m, reminder 0 (end == start)
  const defaultMin = kind === 'reminder' ? 0 : kind === 'meeting' ? 30 : 60;
  const dur        = it.estimated_min ?? defaultMin;
  const ends       = it.ends_at ?? new Date(new Date(starts).getTime() + dur * 60_000).toISOString();

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO calendar_items
       (user_id, kind, source, title, description, location,
        starts_at, ends_at, all_day, recurrence, energy_required)
     VALUES ($1, $2, 'manual', $3, $4, $5, $6, $7, false, $8, $9)
     RETURNING id`,
    [
      db.userId, kind, it.title, it.description, it.location,
      starts, ends, it.recurrence, it.energy,
    ],
  );
  return { ok: true, kind: it.kind, title: it.title, table: 'calendar_items', id: rows[0]!.id };
}

// ── resources ─────────────────────────────────────────────────────────────────
async function insertResource(db: ScopedDb, it: ExtractedItem): Promise<DispatchResult> {
  if (!it.url) {
    return { ok: false, kind: it.kind, title: it.title, error: 'no URL detected' };
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO resources (user_id, title, url, description)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [db.userId, it.title, it.url, it.description],
  );
  return { ok: true, kind: it.kind, title: it.title, table: 'resources', id: rows[0]!.id };
}

// ── habit log (fuzzy match on habit name) ────────────────────────────────────
async function insertHabitLog(db: ScopedDb, it: ExtractedItem): Promise<DispatchResult> {
  const name = (it.habit_name ?? it.title).toLowerCase().trim();
  if (!name) return { ok: false, kind: it.kind, title: it.title, error: 'no habit name' };

  const { rows: matches } = await db.query<{ id: string }>(
    `SELECT id FROM habits
     WHERE user_id = $1 AND deleted_at IS NULL
       AND lower(title) ILIKE '%' || $2 || '%'
     ORDER BY length(title) ASC
     LIMIT 1`,
    [db.userId, name],
  );
  const habit = matches[0];
  if (!habit) {
    // Fall back to a note so the user still keeps the data.
    return await insertItem(db, { ...it, kind: 'note' }, 'note');
  }

  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO habit_logs (habit_id, user_id, logged_date, count, note)
     VALUES ($1, $2, $3, 1, $4)
     RETURNING id`,
    [habit.id, db.userId, today, it.description ?? it.raw],
  );
  return { ok: true, kind: it.kind, title: it.title, table: 'habit_logs', id: rows[0]!.id };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
