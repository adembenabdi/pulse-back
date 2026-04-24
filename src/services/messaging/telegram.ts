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
import { extractItems }        from '../ai/extract.js';
import { dispatchProposals }   from '../ai/dispatch.js';
import { generateMorningBriefing, generateEveningRecap } from '../ai/briefings.js';
import { extractResourceFromUrl, findUrl } from '../ai/resource-extract.js';
import { isGroqAvailable }     from '../ai/groq.js';
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
    // Production: webhook mode — no polling
    bot = new TelegramBot(token, { polling: false });
    logger.info({ webhookUrl }, 'Telegram bot initialized in webhook mode');
  } else {
    // Development: long-polling
    bot = new TelegramBot(token, { polling: true });
    bot.on('message', handleMessage);
    logger.info('Telegram bot initialized in polling mode');
  }
}

// ── Webhook handler (called from route) ──────────────────────────────────────

export async function handleWebhook(body: TelegramBot.Update): Promise<void> {
  if (!bot) return;
  const msg = body.message;
  if (!msg) return;
  await handleMessage(msg);
}

// ── Core message handler ──────────────────────────────────────────────────────

async function handleMessage(msg: TelegramBot.Message): Promise<void> {
  if (!bot || !msg.text || !msg.chat.id) return;

  const chatId = String(msg.chat.id);
  const text   = msg.text.trim();

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

  // ── Command dispatch ───────────────────────────────────────────────────────
  if (text === '/help') {
    await sendHelp(chatId);
    return;
  }

  if (text === '/today' || text === '/morning') {
    const briefing = await generateMorningBriefing(user.id);
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

  // ── URL shared → save as resource (AI-enriched) ──────────────────────────
  const sharedUrl = findUrl(text);
  if (sharedUrl && isGroqAvailable()) {
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
      await bot.sendMessage(
        chatId,
        `🔗 *Saved to Resources*\n\n*${finalTitle}*\n${r.description || ''}${tagsLine}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true },
      );
      return;
    } catch (err) {
      logger.warn({ err, sharedUrl }, 'Telegram URL extract failed — falling back');
      // fall through to extractItems
    }
  }

  // ── Free-form NLU — try extractItems + dispatch first, fall back to assistantChat ─
  try {
    const extracted = await extractItems(text, { timezone: user.timezone });

    if (extracted.length > 0) {
      const sdb = scoped(user.id);
      const results = await dispatchProposals(sdb, extracted);
      const created = results.filter(r => r.ok);

      if (created.length > 0) {
        const icons: Record<string, string> = {
          task: '✅', note: '📝', idea: '💡',
          event: '📅', meeting: '👥', reminder: '⏰',
          resource: '🔗', habit_log: '🔁',
        };
        const lines = results.map(r => r.ok
          ? `${icons[r.kind] ?? '•'} ${capitalize(r.kind)}: "${r.title}"`
          : `⚠️ ${capitalize(r.kind)} skipped: ${r.error}`,
        );
        await bot.sendMessage(
          chatId,
          `Captured ${created.length} item${created.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
        );
        return;
      }
    }

    // Nothing actionable — chat back as a normal AI conversation
    const result = await assistantChat({
      userId:         user.id,
      conversationId: null,
      userMessage:    text,
      timezone:       user.timezone,
    });
    await bot.sendMessage(chatId, result.reply, { parse_mode: 'Markdown' });

  } catch (err) {
    logger.error(err, 'Telegram message handler error');
    await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
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

  await bot.sendMessage(
    chatId,
    `👋 *Welcome to Pulse!*\n\n` +
    `To link your account, send:\n` +
    `\`/link your@email.com\`\n\n` +
    `Once linked, you'll get morning briefings, prayer reminders, task alerts and more.`,
    { parse_mode: 'Markdown' },
  );
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
