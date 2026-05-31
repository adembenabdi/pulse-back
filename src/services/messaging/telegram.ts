/**
 * services/messaging/telegram.ts
 *
 * Telegram bot — webhook (prod) or long-polling (dev).
 *
 * Commands:
 *   /start  — welcome + account link token
 *   /link <email>  — link this chat to a Pulse account
 *   /help   — list commands
 *
 * Any other message is forwarded to the shared AI assistant (runAssistant),
 * which captures tasks/ideas/events or answers questions.
 */

import TelegramBot      from 'node-telegram-bot-api';
import { runAssistant } from '../ai/assistant.js';
import { db }           from '../../lib/db.js';
import { logger }       from '../../lib/logger.js';

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
    bot = new TelegramBot(token, { polling: false });
    const webhookSecret = process.env['TELEGRAM_WEBHOOK_SECRET'];
    bot
      .setWebHook(webhookUrl, { ...(webhookSecret ? { secret_token: webhookSecret } : {}) })
      .then(() => logger.info({ webhookUrl }, 'Telegram webhook registered'))
      .catch((err: unknown) => logger.error(err, 'Failed to register Telegram webhook'));
  } else {
    bot = new TelegramBot(token, { polling: true });
    bot.on('message', (msg) => { void handleMessage(msg); });
    logger.info('Telegram bot initialized in polling mode');
  }
}

export async function handleWebhook(body: TelegramBot.Update): Promise<void> {
  if (!bot) return;
  const msg = body.message;
  if (!msg) return;
  await handleMessage(msg);
}

async function handleMessage(msg: TelegramBot.Message): Promise<void> {
  if (!bot || !msg.text || !msg.chat.id) return;

  const chatId = String(msg.chat.id);
  const text   = msg.text.trim();

  if (text === '/ping') {
    await bot.sendMessage(chatId, '🟢 pong');
    return;
  }

  try {
    const { rows } = await db.admin.query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE telegram_chat_id = $1 AND deleted_at IS NULL`,
      [chatId],
    );
    const user = rows[0] ?? null;

    if (text === '/start' || text.startsWith('/start ')) {
      await handleStart(chatId, user);
      return;
    }
    if (text.startsWith('/link ')) {
      await handleLink(chatId, text.slice(6).trim().toLowerCase());
      return;
    }
    if (text === '/help') {
      await sendHelp(chatId);
      return;
    }

    if (!user) {
      await bot.sendMessage(chatId, '❓ Your account is not linked yet.\n\nUse: /link your@email.com');
      return;
    }

    void bot.sendChatAction(chatId, 'typing').catch(() => {});

    const turn = await runAssistant({ userId: user.id, text, surface: 'telegram' });
    await bot.sendMessage(chatId, turn.reply);
  } catch (err) {
    logger.error(err, 'Telegram message handler error');
    try {
      await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again or type /ping.');
    } catch (sendErr) {
      logger.error(sendErr, 'Failed to send error message to Telegram');
    }
  }
}

async function handleStart(chatId: string, user: { id: string; name: string } | null): Promise<void> {
  if (!bot) return;

  if (user) {
    await bot.sendMessage(chatId, `👋 Welcome back, ${user.name}! Your account is linked.\n\nJust type naturally — I'll capture tasks, ideas and events, or answer questions.`);
    return;
  }

  try {
    await db.admin.query(`DELETE FROM telegram_link_tokens WHERE chat_id = $1`, [chatId]);
    const { rows: [row] } = await db.admin.query<{ token: string }>(
      `INSERT INTO telegram_link_tokens (chat_id, expires_at)
       VALUES ($1, NOW() + INTERVAL '15 minutes') RETURNING token`,
      [chatId],
    );
    if (!row?.token) throw new Error('Token generation failed');
    await bot.sendMessage(
      chatId,
      `👋 *Welcome to Pulse!*\n\nPaste this token in *Settings → Telegram*:\n\n\`${row.token}\`\n\n_Expires in 15 minutes._\n\nOr link directly with: \`/link your@email.com\``,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    logger.error(err, 'Failed to generate Telegram link token');
    await bot.sendMessage(chatId, '⚠️ Could not generate a link token. Please try again.');
  }
}

async function handleLink(chatId: string, email: string): Promise<void> {
  if (!bot) return;
  if (!email || !email.includes('@')) {
    await bot.sendMessage(chatId, '❌ Usage: `/link your@email.com`', { parse_mode: 'Markdown' });
    return;
  }
  const { rows } = await db.admin.query<{ name: string }>(
    `UPDATE users SET telegram_chat_id = $1, updated_at = NOW()
     WHERE email = $2 AND deleted_at IS NULL RETURNING name`,
    [chatId, email],
  );
  if (!rows[0]) {
    await bot.sendMessage(chatId, '❌ No Pulse account found with that email.');
    return;
  }
  await bot.sendMessage(chatId, `✅ Linked to *${rows[0].name}*! Type /help to get started.`, { parse_mode: 'Markdown' });
}

async function sendHelp(chatId: string): Promise<void> {
  if (!bot) return;
  await bot.sendMessage(
    chatId,
    `*Pulse Bot*\n\n` +
    `Just type naturally and I'll handle it:\n` +
    `• "Call the dentist tomorrow at 3pm" → event\n` +
    `• "Finish the landing page for Project X" → task\n` +
    `• "App idea: AI meal planner" → idea\n` +
    `• "What's due this week?" → answer\n\n` +
    `Commands:\n/link <email> — link your account\n/help — this message`,
    { parse_mode: 'Markdown' },
  );
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!bot) return;
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.warn(err, `Failed to send Telegram message to ${chatId}`);
  }
}
