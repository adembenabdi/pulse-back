/**
 * routes/assistant.ts
 *
 * In-app AI assistant endpoints.
 *
 * POST   /api/assistant/conversations           — create conversation + first message
 * GET    /api/assistant/conversations           — list conversations
 * GET    /api/assistant/conversations/:id       — get conversation with messages
 * DELETE /api/assistant/conversations/:id       — soft-delete conversation
 * POST   /api/assistant/conversations/:id/messages — send a message to existing conversation
 * POST   /api/assistant/extract                 — extract structured items from text (legacy alias of /parse)
 * POST   /api/assistant/parse                   — parse a paragraph into AI proposals (preview)
 * POST   /api/assistant/commit                  — commit AI proposals into real DB rows
 * GET    /api/assistant/briefing                — get today's morning briefing
 * GET    /api/assistant/actions                 — list recent ai_actions
 *
 * POST   /api/telegram/webhook                  — Telegram webhook (in same file for simplicity)
 *
 * Push:
 * POST   /api/push/subscribe                    — register web-push subscription
 * DELETE /api/push/subscribe                    — remove subscription
 * GET    /api/push/vapid-key                    — return public VAPID key
 */

import { Router }              from 'express';
import { z }                   from 'zod';
import { requireAuth }         from '../middleware/auth.js';
import { AppError }            from '../middleware/error.js';
import { assistantChat }       from '../services/ai/chat.js';
import { extractItems, type ExtractedItem } from '../services/ai/extract.js';
import { dispatchProposals }   from '../services/ai/dispatch.js';
import { runIncoming, applyChoice } from '../services/ai/conversational.js';
import { generateMorningBriefing } from '../services/ai/briefings.js';
import { isGroqAvailable }     from '../services/ai/groq.js';
import { handleWebhook }       from '../services/messaging/telegram.js';
import { db, scoped }          from '../lib/db.js';
import { logger }              from '../lib/logger.js';

// ── Assistant router ──────────────────────────────────────────────────────────

export const assistantRouter: Router = Router();
assistantRouter.use(requireAuth);

// ── GET /conversations ────────────────────────────────────────────────────────
assistantRouter.get('/conversations', async (req, res, next) => {
  try {
    const { rows } = await req.db.query<{
      id: string; title: string | null; updated_at: string; message_count: number
    }>(
      `SELECT c.id, c.title, c.updated_at::TEXT,
              (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id)::INT AS message_count
       FROM   ai_conversations c
       WHERE  c.user_id = $1 AND c.deleted_at IS NULL
       ORDER  BY c.updated_at DESC
       LIMIT  50`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /conversations/:id ────────────────────────────────────────────────────
assistantRouter.get('/conversations/:id', async (req, res, next) => {
  try {
    const { rows: [conv] } = await req.db.query<{ id: string; title: string | null; updated_at: string }>(
      `SELECT id, title, updated_at::TEXT FROM ai_conversations
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!conv) throw new AppError(404, 'Conversation not found');

    const { rows: messages } = await db.admin.query<{
      id: string; role: string; content: string; model: string | null; created_at: string
    }>(
      `SELECT id, role, content, model, created_at::TEXT
       FROM   ai_messages
       WHERE  conversation_id = $1 AND user_id = $2
       ORDER  BY created_at`,
      [req.params['id'], req.user.id],
    );

    res.json({ ...conv, messages });
  } catch (err) { next(err); }
});

// ── DELETE /conversations/:id ─────────────────────────────────────────────────
assistantRouter.delete('/conversations/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `UPDATE ai_conversations SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Conversation not found');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /conversations — start new conversation ──────────────────────────────
const chatSchema = z.object({
  message:         z.string().min(1).max(4000),
  conversationId:  z.string().uuid().optional(),
});

assistantRouter.post('/conversations', async (req, res, next) => {
  try {
    if (!isGroqAvailable()) throw new AppError(503, 'AI service not configured');
    const { message } = chatSchema.parse(req.body);

    // Try the conversational engine first — it handles capture/confirm flows.
    const sdb = scoped(req.user.id);
    const conv = await runIncoming(sdb, 'web', null, message, { timezone: req.user.timezone });
    if (conv.reply && !conv.fallback) {
      res.status(201).json({
        reply:           conv.reply,
        session_id:      conv.session_id,
        done:            conv.done,
        results:         conv.results,
        conversationId:  null,
      });
      return;
    }

    const result = await assistantChat({
      userId:         req.user.id,
      conversationId: null,
      userMessage:    message,
      timezone:       req.user.timezone,
    });

    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ── POST /conversations/:id/messages — continue conversation ──────────────────
assistantRouter.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    if (!isGroqAvailable()) throw new AppError(503, 'AI service not configured');

    // Verify conversation ownership
    const { rows: [conv] } = await req.db.query<{ id: string }>(
      `SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [req.params['id'], req.user.id],
    );
    if (!conv) throw new AppError(404, 'Conversation not found');

    const { message } = chatSchema.parse(req.body);

    // Conversational engine first (sessions keyed by conversation id).
    const sdb = scoped(req.user.id);
    const cv = await runIncoming(sdb, 'web', req.params['id']!, message, { timezone: req.user.timezone });
    if (cv.reply && !cv.fallback) {
      res.json({
        reply:           cv.reply,
        session_id:      cv.session_id,
        done:            cv.done,
        results:         cv.results,
        conversationId:  req.params['id'],
      });
      return;
    }

    const result = await assistantChat({
      userId:         req.user.id,
      conversationId: req.params['id'],
      userMessage:    message,
      timezone:       req.user.timezone,
    });

    res.json(result);
  } catch (err) { next(err); }
});

// ── Conversational sessions (preview / confirm batches) ────────────────────────
assistantRouter.get('/sessions/current', async (req, res, next) => {
  try {
    const chatId = (req.query['chatId'] as string | undefined) ?? null;
    const { rows } = await req.db.query(
      `SELECT id, surface, chat_id, awaiting, pending, expires_at
       FROM assistant_sessions
       WHERE user_id = $1 AND surface = 'web'
         AND COALESCE(chat_id, '') = COALESCE($2, '')
         AND expires_at > NOW()`,
      [req.user.id, chatId],
    );
    res.json(rows[0] ?? null);
  } catch (err) { next(err); }
});

assistantRouter.post('/sessions/:id/apply', async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    const { rows } = await req.db.query(
      `SELECT id, user_id, surface, chat_id, awaiting, pending, expires_at
       FROM assistant_sessions
       WHERE id = $1 AND user_id = $2 AND expires_at > NOW()`,
      [req.params['id'], req.user.id],
    );
    const session = rows[0];
    if (!session) throw new AppError(404, 'Session not found or expired');

    const sdb = scoped(req.user.id);
    const result = await applyChoice(sdb, session as Parameters<typeof applyChoice>[1], text);
    res.json(result);
  } catch (err) { next(err); }
});

assistantRouter.delete('/sessions/:id', async (req, res, next) => {
  try {
    const { rowCount } = await req.db.query(
      `DELETE FROM assistant_sessions WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    if (!rowCount) throw new AppError(404, 'Session not found');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /extract — extract structured items from text ────────────────────────
assistantRouter.post('/extract', async (req, res, next) => {
  try {
    if (!isGroqAvailable()) throw new AppError(503, 'AI service not configured');
    const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(req.body);
    const items = await extractItems(text, { timezone: req.user.timezone });
    res.json({ items });
  } catch (err) { next(err); }
});

// ── POST /parse — paragraph → preview proposals (no DB writes) ──────────────
assistantRouter.post('/parse', async (req, res, next) => {
  try {
    if (!isGroqAvailable()) throw new AppError(503, 'AI service not configured');
    const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(req.body);
    const items = await extractItems(text, { timezone: req.user.timezone });
    res.json({ items });
  } catch (err) { next(err); }
});

// ── POST /commit — take edited proposals → create real rows ─────────────────
const proposalSchema = z.object({
  kind:          z.enum(['task','idea','event','meeting','reminder','note','habit_log','resource']),
  title:         z.string().min(1).max(200),
  description:   z.string().nullable().optional().default(null),
  due_at:        z.string().nullable().optional().default(null),
  starts_at:     z.string().nullable().optional().default(null),
  ends_at:       z.string().nullable().optional().default(null),
  estimated_min: z.number().int().min(0).max(480).nullable().optional().default(null),
  priority:      z.enum(['low','medium','high','urgent']).nullable().optional().default(null),
  energy:        z.enum(['low','medium','high']).nullable().optional().default(null),
  location:      z.string().nullable().optional().default(null),
  recurrence:    z.string().nullable().optional().default(null),
  url:           z.string().nullable().optional().default(null),
  habit_name:    z.string().nullable().optional().default(null),
  raw:           z.string().optional().default(''),
  confidence:    z.number().optional().default(0.7),
}).passthrough();

assistantRouter.post('/commit', async (req, res, next) => {
  try {
    const { items } = z.object({ items: z.array(proposalSchema).min(1).max(50) }).parse(req.body);
    const sdb = scoped(req.user.id);
    const results = await dispatchProposals(sdb, items as ExtractedItem[]);
    res.json({ results, created: results.filter(r => r.ok).length });
  } catch (err) { next(err); }
});

// ── GET /briefing — today's morning briefing ──────────────────────────────────
assistantRouter.get('/briefing', async (req, res, next) => {
  try {
    if (!isGroqAvailable()) throw new AppError(503, 'AI service not configured');
    const text = await generateMorningBriefing(req.user.id);
    res.json({ text });
  } catch (err) { next(err); }
});

// ── GET /actions — recent ai_actions ─────────────────────────────────────────
assistantRouter.get('/actions', async (req, res, next) => {
  try {
    const { rows } = await db.admin.query<{
      id: string; action_type: string; entity_type: string | null;
      entity_id: string | null; payload: unknown; created_at: string;
    }>(
      `SELECT id, action_type, entity_type, entity_id, payload, created_at::TEXT
       FROM   ai_actions
       WHERE  user_id = $1
       ORDER  BY created_at DESC
       LIMIT  50`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── Telegram webhook router (no auth — uses bot token secret) ─────────────────

export const telegramRouter: Router = Router();

telegramRouter.post('/webhook', async (req, res, next) => {
  try {
    // Verify X-Telegram-Bot-Api-Secret-Token header
    const secret = process.env['TELEGRAM_WEBHOOK_SECRET'];
    if (secret) {
      const provided = req.headers['x-telegram-bot-api-secret-token'];
      if (provided !== secret) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }
    await handleWebhook(req.body as Parameters<typeof handleWebhook>[0]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Push subscription router ──────────────────────────────────────────────────

export const pushRouter: Router = Router();
pushRouter.use(requireAuth);

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  p256dh:   z.string(),
  auth:     z.string(),
});

// GET /vapid-key — return public VAPID key (unauthenticated)
pushRouter.get('/vapid-key', (_req, res) => {
  const key = process.env['VAPID_PUBLIC_KEY'] ?? null;
  res.json({ key });
});

// POST /subscribe — register push subscription
pushRouter.post('/subscribe', async (req, res, next) => {
  try {
    const sub = subscribeSchema.parse(req.body);
    await db.admin.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_id = EXCLUDED.user_id`,
      [req.user.id, sub.endpoint, sub.p256dh, sub.auth],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /subscribe — remove push subscription
pushRouter.delete('/subscribe', async (req, res, next) => {
  try {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);
    await db.admin.query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
      [req.user.id, endpoint],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});
