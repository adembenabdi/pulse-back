/**
 * Telegram webhook router — POST /api/telegram/webhook
 *
 * Public endpoint hit by Telegram's servers (no JWT). Optionally validates
 * the secret token configured via TELEGRAM_WEBHOOK_SECRET.
 */

import { Router } from 'express';
import { handleWebhook } from '../services/messaging/telegram.js';
import { logger } from '../lib/logger.js';

export const telegramRouter: Router = Router();

telegramRouter.post('/webhook', async (req, res) => {
  const secret = process.env['TELEGRAM_WEBHOOK_SECRET'];
  if (secret && req.header('X-Telegram-Bot-Api-Secret-Token') !== secret) {
    res.sendStatus(401);
    return;
  }
  // Respond fast; process asynchronously.
  res.sendStatus(200);
  try {
    await handleWebhook(req.body);
  } catch (err) {
    logger.error(err, 'Telegram webhook processing error');
  }
});
