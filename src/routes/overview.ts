/**
 * routes/overview.ts — aggregated today/overview data
 *
 * GET /api/overview  — single fetch for the dashboard hero
 *
 * Returns:
 *   - tasks:          { items, due_count }
 *   - events:         EventItem[]         (start_at / end_at)
 *   - habits:         { items, logged, total, pct }
 *   - prayer:         { items, logged, total }
 *   - objectives:     ObjectiveItem[]
 *   - streaks:        StreakItem[]        (name / streak_current)
 *   - plan_vs_reality: PvRItem[]
 *   - ai_briefing:    string | null
 */

import { Router }    from 'express';
import { logger }    from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';

export const overviewRouter: Router = Router();
overviewRouter.use(requireAuth);

// ── Helper: run a query and return an empty-rows result on any DB error ───────
async function safeQuery<T extends Record<string, any>>(
  label: string,
  fn: () => Promise<{ rows: T[] }>,
): Promise<{ rows: T[] }> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, label }, 'overview query failed');
    return { rows: [] };
  }
}

overviewRouter.get('/', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const today  = new Date().toISOString().slice(0, 10);

    // ── Run all queries in parallel — each is fault-isolated ─────────────
    const [
      tasksRes,
      eventsRes,
      habitsRes,
      habitLogsRes,
      prayerLogsRes,
      objectivesRes,
      streaksRes,
      pvRRes,
      briefingRes,
    ] = await Promise.all([

      // Tasks due today (not done) — aliases match frontend TaskItem type
      safeQuery('tasks', () =>
        req.db.query<{ id: string; title: string; priority: string; due_date: string | null }>(
          `SELECT id, title, priority::TEXT, due_at::TEXT AS due_date
           FROM   items
           WHERE  user_id = $1 AND deleted_at IS NULL AND status != 'done'
             AND  (due_at IS NULL OR due_at::DATE <= $2::DATE)
             AND  kind IN ('task','commitment','ask')
           ORDER  BY CASE priority::TEXT
                       WHEN 'critical' THEN 1 WHEN 'urgent' THEN 1
                       WHEN 'high'     THEN 2
                       WHEN 'medium'   THEN 3
                       ELSE 4
                     END,
                     due_at NULLS LAST
           LIMIT  8`,
          [userId, today],
        ),
      ),

      // Events: today + next 7 days (frontend filters/labels)
      safeQuery('events', () =>
        req.db.query<{ id: string; title: string; start_at: string; end_at: string | null; kind: string }>(
          `SELECT id, title, starts_at::TEXT AS start_at, ends_at::TEXT AS end_at, kind
           FROM   calendar_items
           WHERE  user_id = $1 AND deleted_at IS NULL
             AND  starts_at >= NOW() - INTERVAL '2 hours'
             AND  starts_at <  ($2::DATE + INTERVAL '7 days')
           ORDER  BY starts_at
           LIMIT  20`,
          [userId, today],
        ),
      ),

      // Active habits — aliases match frontend HabitItem type
      safeQuery('habits', () =>
        req.db.query<{ id: string; name: string; icon: string | null; streak_current: number }>(
          `SELECT h.id,
                  h.title                         AS name,
                  h.icon,
                  COALESCE(s.current, 0)::INT     AS streak_current
           FROM   habits h
           LEFT JOIN streaks s ON s.habit_id = h.id AND s.user_id = h.user_id
           WHERE  h.user_id = $1 AND h.deleted_at IS NULL
           ORDER  BY s.current DESC NULLS LAST
           LIMIT  8`,
          [userId],
        ),
      ),

      // Habit logs for today
      safeQuery('habit_logs', () =>
        req.db.query<{ habit_id: string }>(
          `SELECT habit_id FROM habit_logs WHERE user_id = $1 AND logged_date = $2`,
          [userId, today],
        ),
      ),

      // Prayer logs today
      safeQuery('prayer_logs', () =>
        req.db.query<{ prayer: string; on_time: boolean }>(
          `SELECT prayer::TEXT, on_time FROM prayer_logs WHERE user_id = $1 AND prayed_date = $2`,
          [userId, today],
        ),
      ),

      // Active objectives with milestone count
      safeQuery('objectives', () =>
        req.db.query<{ id: string; title: string; kind: string; total: number; done: number }>(
          `SELECT o.id, o.title, o.kind,
                  COUNT(m.id)::INT                                               AS total,
                  COUNT(m.id) FILTER (WHERE m.completed_at IS NOT NULL)::INT     AS done
           FROM   objectives o
           LEFT JOIN objective_milestones m ON m.objective_id = o.id AND m.deleted_at IS NULL
           WHERE  o.user_id = $1 AND o.deleted_at IS NULL AND o.status IN ('todo','in_progress')
           GROUP  BY o.id
           ORDER  BY o.created_at DESC
           LIMIT  5`,
          [userId],
        ),
      ),

      // Top habit streaks — aliases match frontend StreakItem type
      safeQuery('streaks', () =>
        req.db.query<{ name: string; streak_current: number; icon: string | null }>(
          `SELECT h.title AS name, s.current::INT AS streak_current, h.icon
           FROM   streaks s
           JOIN   habits h ON h.id = s.habit_id AND h.deleted_at IS NULL
           WHERE  s.user_id = $1 AND s.current > 0
           ORDER  BY s.current DESC LIMIT 5`,
          [userId],
        ),
      ),

      // Plan vs reality for today's blocks
      safeQuery('plan_vs_reality', () =>
        req.db.query<{
          id: string; title: string; kind: string;
          start_at: string; end_at: string | null;
          actual_start: string | null; actual_end: string | null; status: string
        }>(
          `SELECT id, title, kind,
                  starts_at::TEXT  AS start_at,
                  ends_at::TEXT    AS end_at,
                  actual_start::TEXT, actual_end::TEXT, status
           FROM   calendar_items
           WHERE  user_id = $1 AND deleted_at IS NULL AND starts_at::DATE = $2
           ORDER  BY starts_at`,
          [userId, today],
        ),
      ),

      // Latest AI briefing message (assistant role, today)
      safeQuery('ai_briefing', () =>
        req.db.query<{ content: string; created_at: string }>(
          `SELECT m.content, m.created_at::TEXT
           FROM   ai_messages m
           JOIN   ai_conversations c ON c.id = m.conversation_id
           WHERE  m.user_id = $1 AND m.role = 'assistant'
             AND  m.created_at::DATE = $2
           ORDER  BY m.created_at DESC LIMIT 1`,
          [userId, today],
        ),
      ),
    ]);

    // ── Assemble habit checklist ──────────────────────────────────────────
    const loggedHabitIds = new Set(habitLogsRes.rows.map(r => r.habit_id));
    const habitChecklist = habitsRes.rows.map(h => ({
      ...h,
      logged: loggedHabitIds.has(h.id),
    }));
    const habitsLogged  = habitChecklist.filter(h => h.logged).length;
    const habitsTotal   = habitChecklist.length;

    // ── Prayer checklist ─────────────────────────────────────────────────
    const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'] as const;
    const loggedPrayers = new Map(prayerLogsRes.rows.map(p => [p.prayer, p.on_time]));
    const prayerChecklist = PRAYERS.map(name => ({
      name,
      logged:  loggedPrayers.has(name),
      on_time: loggedPrayers.get(name) ?? null,
    }));
    const prayersLogged = prayerChecklist.filter(p => p.logged).length;

    // ── Objective progress ────────────────────────────────────────────────
    const objectives = objectivesRes.rows.map(o => ({
      ...o,
      progress_pct: o.total > 0 ? Math.round((o.done / o.total) * 100) : 0,
    }));

    res.json({
      date:            today,
      tasks: {
        items:         tasksRes.rows,
        due_count:     tasksRes.rows.length,
      },
      events:          eventsRes.rows,
      habits: {
        items:         habitChecklist,
        logged:        habitsLogged,
        total:         habitsTotal,
        pct:           habitsTotal > 0 ? Math.round((habitsLogged / habitsTotal) * 100) : 0,
      },
      prayer: {
        items:         prayerChecklist,
        logged:        prayersLogged,
        total:         5,
      },
      objectives,
      streaks:         streaksRes.rows,
      plan_vs_reality: pvRRes.rows,
      ai_briefing:     briefingRes.rows[0]?.content ?? null,
    });
  } catch (err) { next(err); }
});

// ── PATCH /reality/:itemId — start/stop/done/skip ─────────────────────────────
overviewRouter.patch('/reality/:itemId', async (req, res, next) => {
  try {
    const { action } = req.body as { action: 'start' | 'stop' | 'done' | 'skip' };
    const now        = new Date().toISOString();
    let update       = '';

    switch (action) {
      case 'start': update = `actual_start = $3, status = 'in_progress'`; break;
      case 'stop':  update = `actual_end   = $3`; break;
      case 'done':  update = `status = 'done', actual_end = $3`; break;
      case 'skip':  update = `status = 'skipped'`; break;
      default: res.status(400).json({ error: 'Invalid action' }); return;
    }

    const { rowCount } = await req.db.query(
      `UPDATE calendar_items SET ${update}
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      action === 'skip' ? [req.params['itemId'], req.user.id] : [req.params['itemId'], req.user.id, now],
    );
    if (!rowCount) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});
