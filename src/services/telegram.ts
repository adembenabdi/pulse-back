/**
 * Telegram notification dispatcher
 *
 * Uses `node-telegram-bot-api` in polling=false mode (send-only).
 * Requires TELEGRAM_BOT_TOKEN env var.
 */
import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../lib/logger.js';

let bot: TelegramBot | null = null;

if (process.env['TELEGRAM_BOT_TOKEN']) {
  bot = new TelegramBot(process.env['TELEGRAM_BOT_TOKEN'], { polling: false });
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!bot) {
    logger.debug('TELEGRAM_BOT_TOKEN not set — skipping telegram');
    return;
  }
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}
