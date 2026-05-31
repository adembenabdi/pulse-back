/**
 * Overview route — dashboard summary for the home page.
 * GET /api/overview
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

export const overviewRouter: Router = Router();
overviewRouter.use(requireAuth);

overviewRouter.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [todayTasks, weekTasks, projects, prayerToday, recentIdeas, todayEvents] = await Promise.all([
      req.db.query(
        `SELECT t.*, p.name AS project_name FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.status <> 'done'
           AND (t.due_at::date = CURRENT_DATE OR (t.due_at IS NULL AND t.starts_at::date = CURRENT_DATE))
         ORDER BY t.priority DESC, t.due_at NULLS LAST`,
        [uid],
      ),
      req.db.query(
        `SELECT COUNT(*)::int AS n FROM tasks
         WHERE user_id = $1 AND deleted_at IS NULL AND status <> 'done'
           AND due_at IS NOT NULL AND due_at <= NOW() + INTERVAL '7 days'`,
        [uid],
      ),
      req.db.query(
        `SELECT p.id, p.name, p.color, p.status,
                COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL)                       AS task_count,
                COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'done') AS done_count
         FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
         WHERE p.user_id = $1 AND p.deleted_at IS NULL AND p.status = 'active'
         GROUP BY p.id ORDER BY p.created_at DESC LIMIT 6`,
        [uid],
      ),
      req.db.query(
        `SELECT COUNT(*) FILTER (WHERE completed)::int AS completed
         FROM prayer_logs WHERE user_id = $1 AND prayed_date = CURRENT_DATE`,
        [uid],
      ),
      req.db.query(
        `SELECT id, title, status, created_at FROM ideas
         WHERE user_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 5`,
        [uid],
      ),
      req.db.query(
        `SELECT id, title, starts_at, ends_at, location FROM calendar_events
         WHERE user_id = $1 AND deleted_at IS NULL AND starts_at::date = CURRENT_DATE
         ORDER BY starts_at`,
        [uid],
      ),
    ]);

    res.json({
      today_tasks: todayTasks.rows,
      due_this_week: weekTasks.rows[0]?.['n'] ?? 0,
      projects: projects.rows,
      prayer_today: { completed: prayerToday.rows[0]?.['completed'] ?? 0, total: 5 },
      recent_ideas: recentIdeas.rows,
      today_events: todayEvents.rows,
    });
  } catch (err) {
    next(err);
  }
});
