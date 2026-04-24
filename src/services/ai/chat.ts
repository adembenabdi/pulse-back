/**
 * services/ai/chat.ts
 *
 * The core assistant: takes a conversation + new user message,
 * calls Groq (optionally with tool-calling), persists messages,
 * logs actions to ai_actions, and returns the assistant reply.
 *
 * Tools available to the assistant:
 *   create_task        — adds a row to items
 *   create_idea        — adds a row to ideas
 *   create_event       — adds a row to calendar_items
 *   log_habit          — adds a row to habit_logs
 *   create_note        — adds a row to notes
 *   get_today_summary  — returns today's snapshot (tasks + events + habits)
 *   add_resource       — adds a row to resources
 */

import Groq                   from 'groq-sdk';
import { getGroqClient }      from './groq.js';
import { db }                 from '../../lib/db.js';
import { logger }             from '../../lib/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatInput {
  userId:         string;
  conversationId: string | null; // null = create a new conversation
  userMessage:    string;
}

export interface ChatOutput {
  conversationId: string;
  messageId:      string;
  reply:          string;
  model:          string;
  prompt_tokens:     number;
  completion_tokens: number;
}

// ── Tool definitions (Groq function-calling schema) ───────────────────────────

const TOOLS: Groq.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_today_summary',
      description: "Get today's pending tasks, calendar events, and active habits",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task / to-do item for the user',
      parameters: {
        type: 'object',
        required: ['title'],
        properties: {
          title:       { type: 'string', description: 'Task title' },
          description: { type: 'string', description: 'Optional details' },
          due_date:    { type: 'string', description: 'ISO date YYYY-MM-DD or omit' },
          priority:    { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Priority level' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_idea',
      description: 'Save a new idea for the user',
      parameters: {
        type: 'object',
        required: ['title'],
        properties: {
          title:       { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_event',
      description: 'Add a calendar event / meeting',
      parameters: {
        type: 'object',
        required: ['title', 'start_at'],
        properties: {
          title:    { type: 'string' },
          start_at: { type: 'string', description: 'ISO datetime' },
          end_at:   { type: 'string', description: 'ISO datetime or omit' },
          notes:    { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_habit',
      description: 'Log a habit completion for today',
      parameters: {
        type: 'object',
        required: ['habit_name'],
        properties: {
          habit_name: { type: 'string', description: 'Name of the habit to log' },
          value:      { type: 'number', description: 'Numeric value (reps, minutes, etc.)' },
          note:       { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_note',
      description: 'Save a plain text note',
      parameters: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string' },
          title:   { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_resource',
      description: 'Bookmark a URL as a resource',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url:         { type: 'string' },
          title:       { type: 'string' },
          description: { type: 'string' },
          tags:        { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────

interface ToolCallArgs {
  title?:       string;
  description?: string;
  due_date?:    string;
  priority?:    string;
  start_at?:    string;
  end_at?:      string;
  notes?:       string;
  habit_name?:  string;
  value?:       number;
  note?:        string;
  content?:     string;
  url?:         string;
  tags?:        string[];
}

async function executeTool(
  name:   string,
  args:   ToolCallArgs,
  userId: string,
  convId: string,
): Promise<string> {
  const scopedDb = db.scoped(userId);

  switch (name) {
    case 'get_today_summary': {
      const today = new Date().toISOString().slice(0, 10);
      const { rows: tasks } = await scopedDb.query<{ title: string }>(
        `SELECT title FROM items WHERE user_id = $1 AND deleted_at IS NULL AND status != 'done' AND (due_date IS NULL OR due_date <= $2) ORDER BY due_date NULLS LAST LIMIT 5`,
        [userId, today],
      );
      const { rows: events } = await scopedDb.query<{ title: string; start_at: string }>(
        `SELECT title, start_at::TEXT FROM calendar_items WHERE user_id = $1 AND deleted_at IS NULL AND start_at::DATE = $2 ORDER BY start_at LIMIT 5`,
        [userId, today],
      );
      const { rows: habits } = await scopedDb.query<{ name: string; streak_current: number }>(
        `SELECT name, streak_current FROM habits WHERE user_id = $1 AND deleted_at IS NULL AND is_active = TRUE ORDER BY streak_current DESC LIMIT 5`,
        [userId],
      );
      return JSON.stringify({ tasks, events, habits });
    }

    case 'create_task': {
      const { rows } = await scopedDb.query<{ id: string; title: string }>(
        `INSERT INTO items (user_id, title, description, due_date, priority, status, item_type)
         VALUES ($1, $2, $3, $4, $5, 'todo', 'task') RETURNING id, title`,
        [userId, args.title, args.description ?? null, args.due_date ?? null, args.priority ?? 'normal'],
      );
      const row = rows[0]!;
      await logAction(userId, convId, 'create_task', 'items', row.id, args);
      return `Created task: "${row.title}" (id: ${row.id})`;
    }

    case 'create_idea': {
      const { rows } = await scopedDb.query<{ id: string; title: string }>(
        `INSERT INTO ideas (user_id, title, description) VALUES ($1, $2, $3) RETURNING id, title`,
        [userId, args.title, args.description ?? null],
      );
      const row = rows[0]!;
      await logAction(userId, convId, 'create_idea', 'ideas', row.id, args);
      return `Saved idea: "${row.title}"`;
    }

    case 'create_event': {
      const { rows } = await scopedDb.query<{ id: string; title: string }>(
        `INSERT INTO calendar_items (user_id, title, start_at, end_at, notes, item_type)
         VALUES ($1, $2, $3, $4, $5, 'event') RETURNING id, title`,
        [userId, args.title, args.start_at, args.end_at ?? null, args.notes ?? null],
      );
      const row = rows[0]!;
      await logAction(userId, convId, 'create_event', 'calendar_items', row.id, args);
      return `Added event: "${row.title}" at ${args.start_at}`;
    }

    case 'log_habit': {
      // Find habit by name (case-insensitive)
      const { rows: found } = await scopedDb.query<{ id: string; name: string }>(
        `SELECT id, name FROM habits WHERE user_id = $1 AND deleted_at IS NULL AND LOWER(name) LIKE LOWER($2)`,
        [userId, `%${args.habit_name ?? ''}%`],
      );
      if (!found.length) return `Habit "${args.habit_name}" not found — no log created`;
      const habit = found[0]!;
      const today = new Date().toISOString().slice(0, 10);
      const { rows } = await scopedDb.query<{ id: string }>(
        `INSERT INTO habit_logs (user_id, habit_id, logged_date, value, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (habit_id, logged_date) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note
         RETURNING id`,
        [userId, habit.id, today, args.value ?? null, args.note ?? null],
      );
      const row = rows[0]!;
      await logAction(userId, convId, 'log_habit', 'habit_logs', row.id, args);
      return `Logged habit: "${habit.name}" for ${today}`;
    }

    case 'create_note': {
      const { rows } = await scopedDb.query<{ id: string }>(
        `INSERT INTO notes (user_id, title, content) VALUES ($1, $2, $3) RETURNING id`,
        [userId, args.title ?? 'Quick note', args.content],
      );
      const row = rows[0]!;
      await logAction(userId, convId, 'create_note', 'notes', row.id, args);
      return `Note saved`;
    }

    case 'add_resource': {
      const { rows } = await scopedDb.query<{ id: string; title: string }>(
        `INSERT INTO resources (user_id, url, title, description, tags)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, title`,
        [userId, args.url, args.title ?? args.url, args.description ?? null, JSON.stringify(args.tags ?? [])],
      );
      const row = rows[0]!;
      await logAction(userId, convId, 'add_resource', 'resources', row.id, args);
      return `Bookmarked: "${row.title}"`;
    }

    default:
      return 'Unknown tool';
  }
}

async function logAction(
  userId:     string,
  convId:     string,
  actionType: string,
  entityType: string,
  entityId:   string,
  payload:    unknown,
): Promise<void> {
  await db.admin.query(
    `INSERT INTO ai_actions (user_id, conversation_id, action_type, entity_type, entity_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, convId, actionType, entityType, entityId, JSON.stringify(payload)],
  );
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(timezone: string): string {
  const now = new Date().toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' });
  return `You are Pulse, a personal productivity assistant. Current time: ${now}.
You help the user manage their tasks, ideas, events, habits, notes, and bookmarks.
When the user mentions something actionable, use the appropriate tool.
Keep replies concise and warm. If you used a tool, briefly confirm what you did.`;
}

// ── Main chat function ────────────────────────────────────────────────────────

export async function assistantChat(input: ChatInput & { timezone?: string }): Promise<ChatOutput> {
  const { userId, userMessage, timezone = 'UTC' } = input;
  let   { conversationId } = input;

  const groq = getGroqClient();

  // 1. Resolve / create conversation
  if (!conversationId) {
    // Create new conversation; title = first 80 chars of message
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO ai_conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
      [userId, userMessage.slice(0, 80)],
    );
    conversationId = rows[0]!.id;
  }

  // 2. Load message history (last 20 turns to stay within context)
  const { rows: history } = await db.admin.query<{ role: string; content: string }>(
    `SELECT role, content FROM ai_messages
     WHERE conversation_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT 20`,
    [conversationId, userId],
  );
  const historyMessages: Groq.Chat.ChatCompletionMessageParam[] = history
    .reverse()
    .map(h => ({ role: h.role as 'user' | 'assistant', content: h.content }));

  // 3. Build messages array
  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(timezone) },
    ...historyMessages,
    { role: 'user', content: userMessage },
  ];

  // 4. Persist user message
  await db.admin.query(
    `INSERT INTO ai_messages (conversation_id, user_id, role, content) VALUES ($1, $2, 'user', $3)`,
    [conversationId, userId, userMessage],
  );

  // 5. First LLM call (with tools)
  const MODEL = process.env['GROQ_MODEL'] ?? 'llama-3.3-70b-versatile';
  let completion = await groq.chat.completions.create({
    model:    MODEL,
    messages,
    tools:    TOOLS,
    tool_choice: 'auto',
    max_tokens: 1024,
    temperature: 0.7,
  });

  let totalPrompt     = completion.usage?.prompt_tokens     ?? 0;
  let totalCompletion = completion.usage?.completion_tokens ?? 0;

  // 6. Agentic loop — handle tool calls
  const MAX_ROUNDS = 4;
  let round = 0;

  while (completion.choices[0]?.finish_reason === 'tool_calls' && round < MAX_ROUNDS) {
    round++;
    const assistantMessage = completion.choices[0].message;
    messages.push(assistantMessage);

    const toolResults: Groq.Chat.ChatCompletionToolMessageParam[] = [];

    for (const call of assistantMessage.tool_calls ?? []) {
      let toolResult: string;
      try {
        const args = JSON.parse(call.function.arguments ?? '{}') as ToolCallArgs;
        toolResult = await executeTool(call.function.name, args, userId, conversationId);
      } catch (err) {
        logger.warn(err, `Tool ${call.function.name} failed`);
        toolResult = `Error: ${String(err)}`;
      }

      toolResults.push({
        role:         'tool',
        tool_call_id: call.id,
        content:      toolResult,
      });
    }

    messages.push(...toolResults);

    // Call again with tool results
    completion = await groq.chat.completions.create({
      model:    MODEL,
      messages,
      tools:    TOOLS,
      tool_choice: 'auto',
      max_tokens: 1024,
      temperature: 0.7,
    });

    totalPrompt     += completion.usage?.prompt_tokens     ?? 0;
    totalCompletion += completion.usage?.completion_tokens ?? 0;
  }

  // 7. Extract final reply
  const reply = completion.choices[0]?.message.content ?? '';

  // 8. Persist assistant message
  const { rows: msgRows } = await db.admin.query<{ id: string }>(
    `INSERT INTO ai_messages
       (conversation_id, user_id, role, content, model, prompt_tokens, completion_tokens)
     VALUES ($1, $2, 'assistant', $3, $4, $5, $6)
     RETURNING id`,
    [conversationId, userId, reply, completion.model, totalPrompt, totalCompletion],
  );

  // 9. Update conversation updated_at
  await db.admin.query(
    `UPDATE ai_conversations SET updated_at = NOW() WHERE id = $1`,
    [conversationId],
  );

  return {
    conversationId,
    messageId:         msgRows[0]!.id,
    reply,
    model:             completion.model,
    prompt_tokens:     totalPrompt,
    completion_tokens: totalCompletion,
  };
}
