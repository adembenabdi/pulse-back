/**
 * services/ai/answer.ts
 *
 * Answers open-ended questions about the user's data by gathering a compact
 * snapshot (tasks, projects, events, prayers, ideas) and asking Groq.
 */

import { db } from '../../lib/db.js';
import { groqChat, isGroqAvailable } from './groq.js';
import { logger } from '../../lib/logger.js';

async function buildSnapshot(userId: string): Promise<string> {
  const [tasks, projects, events, prayers, ideas] = await Promise.all([
    db.admin.query(
      `SELECT t.title, t.status, t.priority, t.due_at, p.name AS project
       FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.status <> 'done'
       ORDER BY t.due_at NULLS LAST LIMIT 60`,
      [userId],
    ),
    db.admin.query(
      `SELECT p.name, p.description,
              COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL) AS total,
              COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL AND t.status = 'done') AS done
       FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
       WHERE p.user_id = $1 AND p.deleted_at IS NULL
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT 30`,
      [userId],
    ),
    db.admin.query(
      `SELECT title, starts_at, ends_at, location
       FROM calendar_events
       WHERE user_id = $1 AND deleted_at IS NULL
         AND starts_at BETWEEN NOW() - INTERVAL '1 day' AND NOW() + INTERVAL '14 days'
       ORDER BY starts_at LIMIT 40`,
      [userId],
    ),
    db.admin.query(
      `SELECT prayer, prayed_date, completed
       FROM prayer_logs
       WHERE user_id = $1 AND prayed_date >= CURRENT_DATE - INTERVAL '7 days'
       ORDER BY prayed_date DESC`,
      [userId],
    ),
    db.admin.query(
      `SELECT title, status FROM ideas
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 15`,
      [userId],
    ),
  ]);

  return JSON.stringify({
    today: new Date().toISOString(),
    open_tasks: tasks.rows,
    projects: projects.rows,
    upcoming_events: events.rows,
    prayer_logs_last_7_days: prayers.rows,
    recent_ideas: ideas.rows,
  });
}

export async function answerQuestion(userId: string, question: string): Promise<string> {
  if (!isGroqAvailable()) {
    return "AI is not configured, so I can't answer questions right now.";
  }

  try {
    const snapshot = await buildSnapshot(userId);
    const { content } = await groqChat(
      [
        {
          role: 'system',
          content:
            'You are a helpful personal productivity assistant. Answer the user\'s question using ONLY the JSON snapshot of their data. Be concise and friendly. Use short lists when helpful. If the data does not contain the answer, say so plainly.',
        },
        { role: 'user', content: `DATA:\n${snapshot}\n\nQUESTION: ${question}` },
      ],
      { temperature: 0.4, maxTokens: 700 },
    );
    return content.trim();
  } catch (err) {
    logger.error(err, 'answerQuestion failed');
    return 'Sorry, I had trouble answering that. Please try again.';
  }
}
