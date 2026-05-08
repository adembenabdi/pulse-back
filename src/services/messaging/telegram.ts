/**
 * services/messaging/telegram.ts
 *
 * Telegram bot integration — handles both:
 *   1. Webhook mode  (POST /api/telegram/webhook in production)
 *   2. Long-polling  (development fallback)
 *
 * Commands:
 *   /start      — welcome + link account
 *   /today      — today's tasks + events (morning briefing)
 *   /done <n>   — mark the nth task from /today as done
 *   /idea <txt> — quick-save an idea
 *   /task <txt> — quick-save a task
 *   /recap      — evening recap
 *   /help       — list commands
 *
 * Any other message is forwarded to assistantChat() (NLU mode).
 */

import TelegramBot             from 'node-telegram-bot-api';
import { assistantChat }       from '../ai/chat.js';
import { runIncoming }         from '../ai/conversational.js';
import { generateMorningBriefing, generateEveningRecap } from '../ai/briefings.js';
import { extractResourceFromUrl, findUrl } from '../ai/resource-extract.js';
import { db, scoped }          from '../../lib/db.js';
import { logger }              from '../../lib/logger.js';

// ── Bot singleton ─────────────────────────────────────────────────────────────

let bot: TelegramBot | null = null;

export function getTelegramBot(): TelegramBot | null {
  return bot;
}

export function initTelegramBot(): void {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) {
    logger.info('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled');
    return;
  }

  const webhookUrl = process.env['TELEGRAM_WEBHOOK_URL'];

  if (webhookUrl) {
    // Production: webhook mode — register webhook with Telegram on every startup
    bot = new TelegramBot(token, { polling: false });
    const webhookSecret = process.env['TELEGRAM_WEBHOOK_SECRET'];
    bot.setWebHook(webhookUrl, {
      ...(webhookSecret ? { secret_token: webhookSecret } : {}),
    }).then(() => {
      logger.info({ webhookUrl }, 'Telegram webhook registered');
    }).catch((err: unknown) => {
      logger.error(err, 'Failed to register Telegram webhook');
    });
  } else {
    // Development: long-polling
    bot = new TelegramBot(token, { polling: true });
    bot.on('message', (msg) => { void handleMessage(msg); });
    logger.info('Telegram bot initialized in polling mode');
  }
}

// ── Webhook handler (called from route) ──────────────────────────────────────

export async function handleWebhook(body: TelegramBot.Update): Promise<void> {
  if (!bot) return;
  const msg = body.message;
  if (!msg) return;
  await handleMessage(msg, body.update_id);
}

// ── Core message handler ─────────────────────────────────────────────────────

async function handleMessage(msg: TelegramBot.Message, updateId?: number): Promise<void> {
  if (!bot || !msg.text || !msg.chat.id) return;

  const chatId = String(msg.chat.id);
  const text   = msg.text.trim();

  // /ping — alive check with zero DB involvement (useful for diagnosing issues)
  if (text === '/ping') {
    await bot.sendMessage(chatId, '🟢 pong');
    return;
  }

  try {
    // Resolve user from telegram_chat_id
    const { rows } = await db.admin.query<{ id: string; name: string; timezone: string }>(
      `SELECT id, name, COALESCE(preferences->>'timezone', 'UTC') AS timezone
       FROM users
       WHERE telegram_chat_id = $1 AND deleted_at IS NULL`,
      [chatId],
    );

    // /start — provide link-code even for unlinked users
    if (text === '/start' || text.startsWith('/start ')) {
      await handleStart(chatId, rows[0] ?? null);
      return;
    }

    // /link <email> — link this chat to an existing Pulse account
    if (text.startsWith('/link ')) {
      await handleLink(chatId, text.slice(6).trim().toLowerCase(), msg.from?.username ?? null);
      return;
    }

    if (!rows.length) {
      await bot.sendMessage(chatId, '❓ Your account is not linked yet.\n\nUse: /link your@email.com');
      return;
    }

    const user = rows[0]!;

    // Send typing action immediately so the user gets instant visual feedback
    // while the AI pipeline runs (extract → classify → reply can take 3-8 seconds).
    void bot.sendChatAction(chatId, 'typing').catch(() => {/* non-critical */});

    // ── Command dispatch ─────────────────────────────────────────────────────
    if (text === '/help') {
      await sendHelp(chatId);
      return;
    }

    if (text === '/today' || text === '/morning') {
      const briefing = await generateMorningBriefing(user.id, user.timezone);
      await bot.sendMessage(chatId, briefing, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/recap' || text === '/evening') {
      const recap = await generateEveningRecap(user.id);
      await bot.sendMessage(chatId, recap, { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/task ')) {
      const title = text.slice(6).trim();
      if (!title) { await bot.sendMessage(chatId, 'Usage: /task <description>'); return; }
      await db.admin.query(
        `INSERT INTO items (user_id, kind, title, status, priority) VALUES ($1, 'task', $2, 'todo', 'medium')`,
        [user.id, title],
      );
      await bot.sendMessage(chatId, `✅ Task saved: "${title}"`);
      return;
    }

    if (text.startsWith('/idea ')) {
      const title = text.slice(6).trim();
      if (!title) { await bot.sendMessage(chatId, 'Usage: /idea <description>'); return; }
      await db.admin.query(
        `INSERT INTO ideas (user_id, title) VALUES ($1, $2)`,
        [user.id, title],
      );
      await bot.sendMessage(chatId, `💡 Idea saved: "${title}"`);
      return;
    }

    // ── URL shared → save as resource (fast path, no confirm) ───────────────
    const sharedUrl = findUrl(text);
    if (sharedUrl) {
      try {
        await bot.sendChatAction(chatId, 'typing');
        const r = await extractResourceFromUrl(sharedUrl);
        const finalUrl   = r.url || sharedUrl;
        const finalTitle = r.title || sharedUrl;
        await db.admin.query(
          `INSERT INTO resources (user_id, url, title, description, tags)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.id, finalUrl, finalTitle, r.description || null,
           r.tags.length ? JSON.stringify(r.tags) : null],
        );
        const tagsLine = r.tags.length ? `\n🏷  ${r.tags.join(', ')}` : '';
        const descLine = r.description ? `\n${r.description}` : '';
        await bot.sendMessage(
          chatId,
          `🔗 *Saved to Resources*\n\n*${finalTitle}*${descLine}${tagsLine}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true },
        );
        return;
      } catch (err) {
        logger.warn({ err, sharedUrl }, 'Telegram URL extract failed — falling back');
        // fall through to the conversational engine
      }
    }

    // ── Conversational engine (free-text, multi-turn confirm) ────────────────
    const sdb = scoped(user.id);
    const result = await runIncoming(sdb, 'telegram', chatId, text, {
      timezone: user.timezone,
      ...(typeof updateId === 'number' ? { updateId } : {}),
    });

    if (result.reply) {
      await bot.sendMessage(chatId, result.reply, { parse_mode: 'Markdown' });
      return;
    }

    if (result.fallback) {
      // Engine had nothing to extract — use the free-form chat agent.
      const reply = await assistantChat({
        userId:         user.id,
        conversationId: null,
        userMessage:    text,
        timezone:       user.timezone,
      });
      await bot.sendMessage(chatId, reply.reply, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    logger.error(err, 'Telegram message handler error');
    // Always reply so the user knows something went wrong instead of seeing silence.
    try {
      await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again or type /ping to check the connection.');
    } catch (sendErr) {
      logger.error(sendErr, 'Failed to send error message to Telegram');
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace('_', ' ');
}

// ── /start handler ────────────────────────────────────────────────────────────

async function handleStart(chatId: string, user: { id: string; name: string } | null): Promise<void> {
  if (!bot) return;

  if (user) {
    await bot.sendMessage(
      chatId,
      `👋 Welcome back, ${user.name}! Your account is already linked.\n\nType /help to see available commands.`,
    );
    return;
  }

  // Generate a short-lived link token so the user can paste it in Settings → Integrations
  try {
    // Clean up any existing pending token for this chat before creating a new one
    await db.admin.query(
      `DELETE FROM telegram_link_tokens WHERE chat_id = $1`,
      [chatId],
    );
    const { rows: [row] } = await db.admin.query<{ token: string }>(
      `INSERT INTO telegram_link_tokens (chat_id, expires_at)
       VALUES ($1, NOW() + INTERVAL '15 minutes')
       RETURNING token`,
      [chatId],
    );
    const token = row?.token;
    if (!token) throw new Error('Token generation failed');

    await bot.sendMessage(
      chatId,
      `👋 *Welcome to Pulse!*\n\n` +
      `Copy the token below and paste it in *Settings → Integrations → Telegram*:\n\n` +
      `\`${token}\`\n\n` +
      `_This token expires in 15 minutes._`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    logger.error(err, 'Failed to generate Telegram link token');
    await bot.sendMessage(chatId, '⚠️ Could not generate a link token. Please try again.');
  }
}

// ── /link <email> handler ─────────────────────────────────────────────────────

async function handleLink(chatId: string, email: string, _username: string | null): Promise<void> {
  if (!bot) return;

  if (!email || !email.includes('@')) {
    await bot.sendMessage(chatId, '❌ Please provide a valid email.\n\nUsage: `/link your@email.com`', { parse_mode: 'Markdown' });
    return;
  }

  const { rows } = await db.admin.query<{ id: string; name: string }>(
    `UPDATE users
        SET telegram_chat_id = $1,
            updated_at = NOW()
      WHERE email = $2 AND deleted_at IS NULL
      RETURNING id, name`,
    [chatId, email],
  );

  const user = rows[0];
  if (!user) {
    await bot.sendMessage(chatId, '❌ No Pulse account found with that email. Sign up at the app first.');
    return;
  }

  await bot.sendMessage(
    chatId,
    `✅ Linked to *${user.name}*!\n\nType /help to see available commands.`,
    { parse_mode: 'Markdown' },
  );
}

// ── Help message ──────────────────────────────────────────────────────────────

async function sendHelp(chatId: string): Promise<void> {
  if (!bot) return;
  await bot.sendMessage(
    chatId,
    `*Pulse Bot Commands*\n\n` +
    `/today — Morning briefing (tasks + events)\n` +
    `/recap — Evening recap\n` +
    `/task <text> — Quick-save a task\n` +
    `/idea <text> — Quick-save an idea\n` +
    `/help — Show this message\n\n` +
    `🔗 Paste any link → auto-saved to Resources with AI summary\n` +
    `Or just type anything naturally — I'll understand 🧠`,
    { parse_mode: 'Markdown' },
  );
}

// ── Send message helper (used by notify.ts) ───────────────────────────────────

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.warn(err, `Failed to send Telegram message to ${chatId}`);
  }
}
