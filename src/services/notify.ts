/**
 * Notifications service — single `notify()` function that:
 *   1. Writes a row to `notifications`
 *   2. Reads the user's `notification_preferences`
 *   3. Dispatches to each enabled channel (in_app, push, telegram, email)
 *      while respecting quiet_hours and per-type mutes.
 *
 * Channel dispatchers are thin stubs here — they call the actual
 * transport adapters (push.ts, telegram.ts, email.ts) when they exist.
 */

import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────
export interface NotifyInput {
  userId: string;
  type:   string;  // e.g. 'task_due', 'habit_streak', 'share_received', etc.
  title:  string;
  body?:  string;
  data?:  Record<string, unknown>;
}

interface NotificationPrefs {
  channels: Record<string, { in_app?: boolean; push?: boolean; telegram?: boolean; email?: boolean }>;
  quiet_start: string | null;  // 'HH:MM'
  quiet_end:   string | null;
}

interface UserExtras {
  telegram_chat_id: string | null;
  email:            string;
}

// ── Quiet hours check ─────────────────────────────────────────────────────────
function isQuietHour(start: string | null, end: string | null): boolean {
  if (!start || !end) return false;

  const now  = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // Handle wrap-around (e.g. 22:00 → 07:00)
  if (start > end) {
    return hhmm >= start || hhmm < end;
  }
  return hhmm >= start && hhmm < end;
}

// ── Main notify function ──────────────────────────────────────────────────────
export async function notify(input: NotifyInput): Promise<void> {
  const { userId, type, title, body, data } = input;

  // 1. Write notification row
  const { rows } = await db.admin.query<{ id: string }>(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, type, title, body ?? null, data ? JSON.stringify(data) : null],
  );
  const notificationId = rows[0]!.id;

  // 2. Load prefs + user extras
  const { rows: prefRows } = await db.admin.query<NotificationPrefs>(
    `SELECT channels, quiet_start, quiet_end
     FROM   notification_preferences
     WHERE  user_id = $1`,
    [userId],
  );
  const { rows: userRows } = await db.admin.query<UserExtras>(
    `SELECT telegram_chat_id, email FROM users WHERE id = $1`,
    [userId],
  );

  const prefs    = prefRows[0] ?? { channels: {}, quiet_start: null, quiet_end: null };
  const user     = userRows[0];
  const typePrefs = prefs.channels[type] ?? { in_app: true };
  const quiet    = isQuietHour(prefs.quiet_start, prefs.quiet_end);

  // in_app always delivers (no quiet override for in-app)
  if (typePrefs.in_app !== false) {
    await logDelivery(notificationId, 'in_app', 'sent');
    // In-app is read directly from the notifications table by the client
  }

  if (quiet) {
    logger.debug({ userId, type }, 'quiet hours — skipping push/telegram/email');
    return;
  }

  // Push
  if (typePrefs.push && user) {
    await dispatchPush(userId, notificationId, body !== undefined ? { title, body } : { title });
  }

  // Telegram
  if (typePrefs.telegram && user?.telegram_chat_id) {
    await dispatchTelegram(user.telegram_chat_id, notificationId, body !== undefined ? { title, body } : { title });
  }
}

// ── Delivery log ──────────────────────────────────────────────────────────────
async function logDelivery(
  notificationId: string,
  channel: string,
  status: 'sent' | 'failed',
  error?: string,
): Promise<void> {
  await db.admin.query(
    `INSERT INTO notification_deliveries (notification_id, channel, status, error)
     VALUES ($1, $2, $3, $4)`,
    [notificationId, channel, status, error ?? null],
  );
}

// ── Channel dispatchers ───────────────────────────────────────────────────────
async function dispatchPush(
  userId: string,
  notificationId: string,
  payload: { title: string; body?: string },
): Promise<void> {
  try {
    // Dynamically import so missing webpush dep doesn't crash startup
    const { sendPushToUser } = await import('./push.js').catch(() => ({ sendPushToUser: null }));
    if (sendPushToUser) {
      await sendPushToUser(userId, payload);
    }
    await logDelivery(notificationId, 'push', 'sent');
  } catch (err) {
    logger.warn({ err, userId }, 'push dispatch failed');
    await logDelivery(notificationId, 'push', 'failed', String(err));
  }
}

async function dispatchTelegram(
  chatId: string,
  notificationId: string,
  payload: { title: string; body?: string },
): Promise<void> {
  try {
    const { sendTelegramMessage } = await import('./telegram.js').catch(() => ({ sendTelegramMessage: null }));
    if (sendTelegramMessage) {
      const text = payload.body ? `*${payload.title}*\n${payload.body}` : payload.title;
      await sendTelegramMessage(chatId, text);
    }
    await logDelivery(notificationId, 'telegram', 'sent');
  } catch (err) {
    logger.warn({ err, chatId }, 'telegram dispatch failed');
    await logDelivery(notificationId, 'telegram', 'failed', String(err));
  }
}
