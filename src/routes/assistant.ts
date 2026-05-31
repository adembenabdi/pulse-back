/**
 * Assistant routes (web chat — shares the orchestrator with Telegram)
 *
 * POST /api/assistant/message                       send a message, get reply + actions
 * GET  /api/assistant/conversations                 list conversations
 * GET  /api/assistant/conversations/:id/messages    message history
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { runAssistant } from '../services/ai/assistant.js';

export const assistantRouter: Router = Router();
assistantRouter.use(requireAuth);

const messageSchema = z.object({
  text:            z.string().min(1).max(4000),
  conversation_id: z.string().uuid().nullable().optional(),
});

// POST /message
assistantRouter.post('/message', async (req, res, next) => {
  try {
    const body = messageSchema.parse(req.body);
    const turn = await runAssistant({
      userId: req.user.id,
      text: body.text,
      surface: 'web',
      conversationId: body.conversation_id ?? null,
    });
    res.json(turn);
  } catch (err) {
    next(err);
  }
});

// GET /conversations
assistantRouter.get('/conversations', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT id, surface, title, created_at, updated_at
       FROM ai_conversations
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 50`,
      [req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /conversations/:id/messages
assistantRouter.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    // ownership check
    await req.db.queryOne(
      `SELECT id FROM ai_conversations WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    const { rows } = await req.db.query(
      `SELECT id, role, content, actions, created_at
       FROM ai_messages
       WHERE conversation_id = $1 AND user_id = $2
       ORDER BY created_at`,
      [req.params['id'], req.user.id],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
