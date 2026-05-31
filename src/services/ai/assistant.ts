/**
 * services/ai/assistant.ts
 *
 * Orchestrates a single assistant turn for BOTH the web chat and Telegram:
 *   interpret → (execute | answer) → persist messages → reply.
 */

import { db } from '../../lib/db.js';
import { interpret } from './interpret.js';
import { executeItems, type ExecutedAction } from './execute.js';
import { answerQuestion } from './answer.js';
import { logger } from '../../lib/logger.js';

export interface AssistantTurn {
  conversationId: string;
  reply: string;
  actions: ExecutedAction[];
}

async function getUserContext(userId: string): Promise<{ timezone: string; projectNames: string[] }> {
  const [{ rows: userRows }, { rows: projectRows }] = await Promise.all([
    db.admin.query<{ timezone: string }>(
      `SELECT COALESCE(preferences->>'timezone', 'Africa/Algiers') AS timezone
       FROM users WHERE id = $1`,
      [userId],
    ),
    db.admin.query<{ name: string }>(
      `SELECT name FROM projects WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`,
      [userId],
    ),
  ]);
  return {
    timezone: userRows[0]?.timezone ?? 'Africa/Algiers',
    projectNames: projectRows.map((r) => r.name),
  };
}

async function ensureConversation(
  userId: string,
  surface: string,
  conversationId: string | null,
): Promise<string> {
  if (conversationId) {
    const { rows } = await db.admin.query<{ id: string }>(
      `SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await db.admin.query<{ id: string }>(
    `INSERT INTO ai_conversations (user_id, surface) VALUES ($1, $2) RETURNING id`,
    [userId, surface],
  );
  return rows[0]!.id;
}

async function saveMessage(
  conversationId: string,
  userId: string,
  role: 'user' | 'assistant',
  content: string,
  actions?: ExecutedAction[],
): Promise<void> {
  await db.admin.query(
    `INSERT INTO ai_messages (conversation_id, user_id, role, content, actions)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [conversationId, userId, role, content, actions ? JSON.stringify(actions) : null],
  );
  await db.admin.query(`UPDATE ai_conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
}

function summarize(actions: ExecutedAction[]): string {
  if (actions.length === 0) return "I couldn't capture anything from that.";
  const lines = actions.map((a) => {
    const icon = a.type === 'task' ? '✅' : a.type === 'idea' ? '💡' : '📅';
    const suffix = a.detail ? ` (${a.detail})` : '';
    const label = a.type.charAt(0).toUpperCase() + a.type.slice(1);
    return `${icon} ${label}: ${a.title}${suffix}`;
  });
  return `Done — captured ${actions.length} item${actions.length > 1 ? 's' : ''}:\n${lines.join('\n')}`;
}

/**
 * Run one assistant turn. `userId` must already be resolved/authenticated.
 */
export async function runAssistant(opts: {
  userId: string;
  text: string;
  surface?: 'web' | 'telegram';
  conversationId?: string | null;
}): Promise<AssistantTurn> {
  const surface = opts.surface ?? 'web';
  const conversationId = await ensureConversation(opts.userId, surface, opts.conversationId ?? null);
  await saveMessage(conversationId, opts.userId, 'user', opts.text);

  const ctx = await getUserContext(opts.userId);
  const interpretation = await interpret(opts.text, {
    timezone: ctx.timezone,
    nowIso: new Date().toISOString(),
    projectNames: ctx.projectNames,
  });

  let reply: string;
  let actions: ExecutedAction[] = [];

  if (interpretation.mode === 'query') {
    reply = await answerQuestion(opts.userId, interpretation.question ?? opts.text);
  } else {
    try {
      actions = await executeItems(opts.userId, interpretation.items);
      reply = summarize(actions);
    } catch (err) {
      logger.error(err, 'assistant execute failed');
      reply = 'Something went wrong while saving that. Please try again.';
    }
  }

  await saveMessage(conversationId, opts.userId, 'assistant', reply, actions);
  return { conversationId, reply, actions };
}
