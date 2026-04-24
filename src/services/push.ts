/**
 * Push notification dispatcher
 *
 * Uses the `web-push` library. Requires VAPID keys to be set.
 * Install web-push: `pnpm add web-push && pnpm add -D @types/web-push`
 */
import webpush from 'web-push';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export async function sendPushToUser(
  userId: string,
  payload: { title: string; body?: string },
): Promise<void> {
  if (!VAPID_PUBLIC_KEY) {
    logger.debug('VAPID keys not configured — skipping push');
    return;
  }

  const { rows } = await db.admin.query<{ endpoint: string; p256dh: string; auth: string }>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId],
  );

  for (const sub of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
    } catch (err) {
      logger.warn({ err, endpoint: sub.endpoint }, 'push send failed — removing stale sub');
      await db.admin.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [sub.endpoint]);
    }
  }
}
