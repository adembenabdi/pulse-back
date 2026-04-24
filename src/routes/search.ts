/**
 * routes/search.ts — global search across all major entity types
 *
 * GET /api/search?q=<text>&types=tasks,ideas,objectives,events,resources,transactions&limit=20
 *
 * Returns results grouped by entity type, each with:
 *   { type, id, title, subtitle, href, created_at }
 */

import { Router }       from 'express';
import { z }            from 'zod';
import { requireAuth }  from '../middleware/auth.js';

export const searchRouter: Router = Router();
searchRouter.use(requireAuth);

const VALID_TYPES = ['tasks', 'ideas', 'objectives', 'events', 'resources', 'transactions', 'habits', 'notes'] as const;
type SearchType = typeof VALID_TYPES[number];

interface SearchResult {
  type:       SearchType;
  id:         string;
  title:      string;
  subtitle:   string | null;
  /** Alias of `subtitle` kept for clients that expect `snippet`. */
  snippet:    string | null;
  href:       string;
  created_at: string;
}

function makeResult(r: Omit<SearchResult, 'snippet'>): SearchResult {
  return { ...r, snippet: r.subtitle };
}

// ── GET / ─────────────────────────────────────────────────────────────────────
searchRouter.get('/', async (req, res, next) => {
  try {
    const { q, types, limit } = z.object({
      q:     z.string().min(1).max(200),
      types: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }).parse(req.query);

    const userId   = req.user.id;
    const lim      = limit;
    const term     = `%${q.toLowerCase()}%`;

    // Which entity types to search
    const requested = types
      ? types.split(',').filter((t): t is SearchType => (VALID_TYPES as readonly string[]).includes(t))
      : [...VALID_TYPES];

    const results: SearchResult[] = [];

    // ── Tasks / Notes (items table) ────────────────────────────────────────
    if (requested.includes('tasks') || requested.includes('notes')) {
      const kinds: string[] = [];
      if (requested.includes('tasks')) kinds.push("'task'", "'commitment'", "'ask'");
      if (requested.includes('notes')) kinds.push("'note'");

      const { rows } = await req.db.query<{
        id: string; title: string; notes: string | null; kind: string; created_at: string
      }>(
        `SELECT id, title, notes, kind, created_at::TEXT
         FROM   items
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  kind IN (${kinds.join(',')})
           AND  (LOWER(title) LIKE $2 OR LOWER(COALESCE(notes,'')) LIKE $2)
         ORDER  BY created_at DESC
         LIMIT  $3`,
        [userId, term, lim],
      );

      for (const r of rows) {
        const type: SearchType = r.kind === 'note' ? 'notes' : 'tasks';
        results.push(makeResult({
          type,
          id:         r.id,
          title:      r.title,
          subtitle:   r.notes?.slice(0, 80) ?? null,
          href:       type === 'notes' ? `/tasks?id=${r.id}` : `/tasks?id=${r.id}`,
          created_at: r.created_at,
        }));
      }
    }

    // ── Ideas ──────────────────────────────────────────────────────────────
    if (requested.includes('ideas')) {
      const { rows } = await req.db.query<{
        id: string; title: string; description: string | null; created_at: string
      }>(
        `SELECT id, title, description, created_at::TEXT
         FROM   ideas
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  (LOWER(title) LIKE $2 OR LOWER(COALESCE(description,'')) LIKE $2)
         ORDER  BY created_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'ideas', id: r.id, title: r.title, subtitle: r.description?.slice(0, 80) ?? null, href: `/ideas?id=${r.id}`, created_at: r.created_at }));
      }
    }

    // ── Objectives ─────────────────────────────────────────────────────────
    if (requested.includes('objectives')) {
      const { rows } = await req.db.query<{
        id: string; title: string; kind: string; created_at: string
      }>(
        `SELECT id, title, kind, created_at::TEXT
         FROM   objectives
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  LOWER(title) LIKE $2
         ORDER  BY created_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'objectives', id: r.id, title: r.title, subtitle: r.kind, href: `/objectives?id=${r.id}`, created_at: r.created_at }));
      }
    }

    // ── Calendar events ────────────────────────────────────────────────────
    if (requested.includes('events')) {
      const { rows } = await req.db.query<{
        id: string; title: string; starts_at: string; created_at: string
      }>(
        `SELECT id, title, starts_at::TEXT, created_at::TEXT
         FROM   calendar_items
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  LOWER(title) LIKE $2
         ORDER  BY starts_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'events', id: r.id, title: r.title, subtitle: r.starts_at, href: `/calendar?id=${r.id}`, created_at: r.created_at }));
      }
    }

    // ── Resources ──────────────────────────────────────────────────────────
    if (requested.includes('resources')) {
      const { rows } = await req.db.query<{
        id: string; title: string | null; url: string; created_at: string
      }>(
        `SELECT id, title, url, created_at::TEXT
         FROM   resources
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  (LOWER(COALESCE(title,'')) LIKE $2 OR LOWER(url) LIKE $2)
         ORDER  BY created_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'resources', id: r.id, title: r.title ?? r.url, subtitle: r.url, href: `/study?resource=${r.id}`, created_at: r.created_at }));
      }
    }

    // ── Transactions ───────────────────────────────────────────────────────
    if (requested.includes('transactions')) {
      const { rows } = await req.db.query<{
        id: string; description: string | null; amount: string; kind: string; created_at: string
      }>(
        `SELECT id, description, amount::TEXT, kind, created_at::TEXT
         FROM   transactions
         WHERE  user_id = $1 AND deleted_at IS NULL
           AND  LOWER(COALESCE(description,'')) LIKE $2
         ORDER  BY created_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'transactions', id: r.id, title: r.description ?? `${r.kind} ${r.amount}`, subtitle: `${r.kind} · ${r.amount}`, href: `/money?tx=${r.id}`, created_at: r.created_at }));
      }
    }

    // ── Habits ─────────────────────────────────────────────────────────────
    if (requested.includes('habits')) {
      const { rows } = await req.db.query<{
        id: string; title: string; created_at: string
      }>(
        `SELECT id, title, created_at::TEXT
         FROM   habits
         WHERE  user_id = $1 AND deleted_at IS NULL AND LOWER(title) LIKE $2
         ORDER  BY created_at DESC LIMIT $3`,
        [userId, term, lim],
      );
      for (const r of rows) {
        results.push(makeResult({ type: 'habits', id: r.id, title: r.title, subtitle: null, href: `/habits?id=${r.id}`, created_at: r.created_at }));
      }
    }

    // Sort combined results by relevance (exact match first, then recency)
    const ranked = results.sort((a, b) => {
      const aExact = a.title.toLowerCase() === q.toLowerCase() ? 0 : 1;
      const bExact = b.title.toLowerCase() === q.toLowerCase() ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return b.created_at.localeCompare(a.created_at);
    });

    res.json({ query: q, results: ranked.slice(0, lim), total: ranked.length });
  } catch (err) { next(err); }
});
