/**
 * services/ai/briefings.ts
 *
 * Generates periodic AI-powered briefings for the user:
 *   - morning:  today's tasks, events, habits due, streaks
 *   - evening:  what was completed, what's pending tomorrow
 *   - weekly:   week summary, top wins, focus areas
 */

import { groqChat }  from './groq.js';
import { db }        from '../../lib/db.js';
import { notify }    from '../notify.js';
import { logger }    from '../../lib/logger.js';

// ── Data loaders ──────────────────────────────────────────────────────────────

interface TaskRow    { title: string; due_date: string | null }
interface EventRow   { title: string; start_at: string }
interface HabitRow   { name: string; streak_current: number }
interface SummaryRow { completed: number; pending: number; habit_completions: number }

async function loadTodayData(userId: string) {
  const today = new Date().toISOString().slice(0, 10);

  const { rows: tasks } = await db.admin.query<TaskRow>(
    `SELECT title, due_date::TEXT FROM items
     WHERE user_id = $1 AND deleted_at IS NULL
       AND status   != 'done'
       AND (due_date IS NULL OR due_date <= $2)
     ORDER BY due_date NULLS LAST, created_at
     LIMIT 10`,
    [userId, today],
  );

  const { rows: events } = await db.admin.query<EventRow>(
    `SELECT title, start_at::TEXT FROM calendar_items
     WHERE user_id = $1 AND deleted_at IS NULL
       AND start_at::DATE = $2
     ORDER BY start_at
     LIMIT 10`,
    [userId, today],
  );

  const { rows: habits } = await db.admin.query<HabitRow>(
    `SELECT name, streak_current FROM habits
     WHERE user_id = $1 AND deleted_at IS NULL AND is_active = TRUE
     ORDER BY streak_current DESC
     LIMIT 8`,
    [userId],
  );

  return { tasks, events, habits };
}

async function loadEveningData(userId: string) {
  const today = new Date().toISOString().slice(0, 10);

  const { rows } = await db.admin.query<SummaryRow>(
    `SELECT
       (SELECT COUNT(*) FROM items WHERE user_id = $1 AND deleted_at IS NULL AND status = 'done'   AND updated_at::DATE = $2)::INT AS completed,
       (SELECT COUNT(*) FROM items WHERE user_id = $1 AND deleted_at IS NULL AND status != 'done'  AND due_date = $2)::INT AS pending,
       (SELECT COUNT(*) FROM habit_logs WHERE user_id = $1 AND logged_date = $2)::INT AS habit_completions`,
    [userId, today],
  );

  return rows[0] ?? { completed: 0, pending: 0, habit_completions: 0 };
}

// ── Generators ────────────────────────────────────────────────────────────────

export async function generateMorningBriefing(userId: string): Promise<string> {
  const { tasks, events, habits } = await loadTodayData(userId);

  const taskList   = tasks.map(t => `- ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`).join('\n') || 'No pending tasks';
  const eventList  = events.map(e => `- ${e.title} at ${e.start_at}`).join('\n') || 'No events today';
  const habitList  = habits.map(h => `- ${h.name} (🔥 ${h.streak_current})`).join('\n') || 'No active habits';

  const result = await groqChat([
    { role: 'system', content: 'You are a calm, concise personal assistant. Write a short morning briefing (3–4 sentences max) using the data below. Motivating but minimal.' },
    { role: 'user', content: `Tasks today:\n${taskList}\n\nCalendar:\n${eventList}\n\nHabits to keep:\n${habitList}` },
  ], { temperature: 0.6, maxTokens: 300 });

  return result.content;
}

export async function generateEveningRecap(userId: string): Promise<string> {
  const data = await loadEveningData(userId);

  const result = await groqChat([
    { role: 'system', content: 'You are a personal assistant. Write a brief evening recap (2–3 sentences) that acknowledges what was done and sets a positive tone for tomorrow.' },
    { role: 'user', content: `Completed tasks: ${data.completed}\nPending tasks for tomorrow: ${data.pending}\nHabit completions: ${data.habit_completions}` },
  ], { temperature: 0.6, maxTokens: 200 });

  return result.content;
}

export async function generateWeeklyReview(userId: string): Promise<string> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const { rows } = await db.admin.query<{ completed: number; created: number; habit_logs: number }>(
    `SELECT
       (SELECT COUNT(*) FROM items      WHERE user_id = $1 AND deleted_at IS NULL AND status = 'done' AND updated_at::DATE BETWEEN $2 AND $3)::INT AS completed,
       (SELECT COUNT(*) FROM items      WHERE user_id = $1 AND deleted_at IS NULL AND created_at::DATE BETWEEN $2 AND $3)::INT AS created,
       (SELECT COUNT(*) FROM habit_logs WHERE user_id = $1 AND logged_date BETWEEN $2 AND $3)::INT AS habit_logs`,
    [userId, sevenDaysAgo, today],
  );
  const summary = rows[0] ?? { completed: 0, created: 0, habit_logs: 0 };

  const result = await groqChat([
    { role: 'system', content: 'You are a personal productivity coach. Write a weekly review summary (3–5 sentences) based on the stats below. Highlight progress and suggest one focus area for next week.' },
    { role: 'user', content: `Tasks completed: ${summary.completed}\nTasks created: ${summary.created}\nHabit log entries: ${summary.habit_logs}` },
  ], { temperature: 0.7, maxTokens: 400 });

  return result.content;
}

// ── Dispatch via notify ───────────────────────────────────────────────────────

export async function dispatchMorningBriefing(userId: string): Promise<void> {
  try {
    const text = await generateMorningBriefing(userId);
    await notify({ userId, type: 'morning_briefing', title: 'Good morning ☀️', body: text });
  } catch (err) {
    logger.error(err, 'Failed to dispatch morning briefing');
  }
}

export async function dispatchEveningRecap(userId: string): Promise<void> {
  try {
    const text = await generateEveningRecap(userId);
    await notify({ userId, type: 'evening_recap', title: 'Evening recap 🌙', body: text });
  } catch (err) {
    logger.error(err, 'Failed to dispatch evening recap');
  }
}

export async function dispatchWeeklyReview(userId: string): Promise<void> {
  try {
    const text = await generateWeeklyReview(userId);
    await notify({ userId, type: 'weekly_review', title: 'Weekly review 📊', body: text });
  } catch (err) {
    logger.error(err, 'Failed to dispatch weekly review');
  }
}

// ── Bulk dispatch (called from cron) ─────────────────────────────────────────

export async function runMorningBriefingsForAllUsers(): Promise<void> {
  const { rows } = await db.admin.query<{ id: string }>(
    `SELECT id FROM users WHERE deleted_at IS NULL`,
  );
  await Promise.allSettled(rows.map(r => dispatchMorningBriefing(r.id)));
}

export async function runEveningRecapsForAllUsers(): Promise<void> {
  const { rows } = await db.admin.query<{ id: string }>(
    `SELECT id FROM users WHERE deleted_at IS NULL`,
  );
  await Promise.allSettled(rows.map(r => dispatchEveningRecap(r.id)));
}

export async function runWeeklyReviewsForAllUsers(): Promise<void> {
  const { rows } = await db.admin.query<{ id: string }>(
    `SELECT id FROM users WHERE deleted_at IS NULL`,
  );
  await Promise.allSettled(rows.map(r => dispatchWeeklyReview(r.id)));
}
