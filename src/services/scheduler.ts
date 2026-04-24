/**
 * Smart scheduler service (port of v1 services/scheduler.js)
 *
 * 1. Collects all busy intervals for a given date from:
 *    - sleep windows (from user_preferences)
 *    - existing calendar_items
 *    - weekly_template_blocks
 *    - prayer_time_caches
 *
 * 2. Finds optimal free slots of configurable minimum duration
 *
 * 3. Places unscheduled items into those slots as calendar_items
 *    with source = 'auto_schedule'
 *
 * 4. Optionally runs the humane service over the resulting plan
 */

import cron                from 'node-cron';
import type { ScopedDb }   from '../lib/db.js';
import { humanize, type HumaneBlock } from './humane.js';
import { logger }          from '../lib/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────
export interface BusyBlock {
  start:  number;   // minutes since midnight
  end:    number;
  type:   string;
  title:  string;
}

export interface FreeSlot {
  start_time: string;  // HH:mm
  end_time:   string;
  duration_min: number;
}

export interface SchedulerResult {
  scheduled:     { item_id: string; title: string; starts_at: string; ends_at: string }[];
  skipped:       { item_id: string; title: string; reason: string }[];
  health?:       ReturnType<typeof humanize>['health'];
  applied_fixes?: string[];
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function toMin(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

function toHHMM(min: number): string {
  const c = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
}

function overlaps(a: BusyBlock, b: BusyBlock): boolean {
  return a.start < b.end && b.start < a.end;
}

// ── Collect busy blocks for a day ─────────────────────────────────────────────
async function getBusyBlocks(userId: string, date: string, db: ScopedDb): Promise<BusyBlock[]> {
  const blocks: BusyBlock[] = [];

  // 1. User preferences (sleep window, meals)
  const { rows: [prefs] } = await db.query<Record<string, unknown>>(
    `SELECT sleep_time, wake_time, meal_times
     FROM users WHERE id = $1`,
    [userId],
  );
  // Defaults
  const wakeMin  = toMin((prefs?.['wake_time']  as string | undefined) ?? '07:00');
  const sleepMin = toMin((prefs?.['sleep_time'] as string | undefined) ?? '23:00');

  // Sleep window: 00:00 → wake and sleep → 23:59
  blocks.push({ start: 0,        end: wakeMin,  type: 'sleep', title: 'Sleep' });
  blocks.push({ start: sleepMin, end: 24 * 60,  type: 'sleep', title: 'Sleep' });

  // Meals from user prefs (optional JSON)
  const meals = (prefs?.['meal_times'] as Record<string, string> | null) ?? {
    breakfast: '07:30', lunch: '12:30', dinner: '19:30',
  };
  const mealDurs: Record<string, number> = { breakfast: 30, lunch: 45, dinner: 45 };
  for (const [name, time] of Object.entries(meals)) {
    const s = toMin(time);
    blocks.push({ start: s, end: s + (mealDurs[name] ?? 30), type: 'meal', title: name });
  }

  // 2. Prayer times for this date
  const { rows: prayers } = await db.query<Record<string, string>>(
    `SELECT fajr, dhuhr, asr, maghrib, isha FROM prayer_time_caches WHERE user_id = $1 AND date = $2`,
    [userId, date],
  );
  if (prayers.length) {
    const pt = prayers[0]!;
    const prayerBuf = 20;
    for (const name of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const) {
      const t = pt[name];
      if (t) {
        const s = toMin(t);
        blocks.push({ start: s, end: s + prayerBuf, type: 'prayer', title: name });
      }
    }
  }

  // 3. Existing calendar_items for this date (non-auto-scheduled to avoid circular)
  const { rows: calItems } = await db.query<Record<string, unknown>>(
    `SELECT starts_at, ends_at, title, kind, source
     FROM calendar_items
     WHERE user_id = $1
       AND starts_at::date = $2
       AND deleted_at IS NULL
       AND status NOT IN ('skipped','cancelled')`,
    [userId, date],
  );
  for (const ci of calItems) {
    const s = new Date(ci['starts_at'] as string);
    const e = new Date(ci['ends_at']   as string);
    blocks.push({
      start: s.getHours() * 60 + s.getMinutes(),
      end:   e.getHours() * 60 + e.getMinutes(),
      type:  ci['kind'] as string,
      title: ci['title'] as string,
    });
  }

  // 4. Weekly template blocks for this day-of-week
  const dayOfWeek = new Date(date + 'T12:00:00').getDay();
  const { rows: tplBlocks } = await db.query<Record<string, unknown>>(
    `SELECT start_time, end_time, title FROM weekly_template_blocks
     WHERE user_id = $1 AND day_of_week = $2 AND deleted_at IS NULL`,
    [userId, dayOfWeek],
  );
  for (const tb of tplBlocks) {
    blocks.push({
      start: toMin(tb['start_time'] as string),
      end:   toMin(tb['end_time']   as string),
      type:  'template',
      title: tb['title'] as string,
    });
  }

  return blocks;
}

// ── Find free slots ───────────────────────────────────────────────────────────
function computeFreeSlots(busy: BusyBlock[], minDuration: number, wakeMin: number, sleepMin: number): FreeSlot[] {
  // Merge and sort busy blocks
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  const merged: BusyBlock[] = [];
  for (const b of sorted) {
    if (merged.length && b.start <= merged[merged.length - 1]!.end) {
      merged[merged.length - 1]!.end = Math.max(merged[merged.length - 1]!.end, b.end);
    } else {
      merged.push({ ...b });
    }
  }

  const slots: FreeSlot[] = [];
  let cursor = wakeMin;

  for (const b of merged) {
    if (b.start > cursor) {
      const dur = b.start - cursor;
      if (dur >= minDuration) {
        slots.push({ start_time: toHHMM(cursor), end_time: toHHMM(b.start), duration_min: dur });
      }
    }
    cursor = Math.max(cursor, b.end);
  }

  // Slot after last busy until sleep
  if (cursor < sleepMin) {
    const dur = sleepMin - cursor;
    if (dur >= minDuration) {
      slots.push({ start_time: toHHMM(cursor), end_time: toHHMM(sleepMin), duration_min: dur });
    }
  }

  return slots;
}

// ── Public: get free slots ────────────────────────────────────────────────────
export async function getFreeSlots(
  userId:      string,
  date:        string,
  db:          ScopedDb,
  minDuration: number = 30,
): Promise<FreeSlot[]> {
  const { rows: [prefs] } = await db.query<Record<string, unknown>>(
    `SELECT sleep_time, wake_time FROM users WHERE id = $1`, [userId],
  );
  const wakeMin  = toMin((prefs?.['wake_time']  as string | undefined) ?? '07:00');
  const sleepMin = toMin((prefs?.['sleep_time'] as string | undefined) ?? '23:00');

  const busy = await getBusyBlocks(userId, date, db);
  return computeFreeSlots(busy, minDuration, wakeMin, sleepMin);
}

// ── Public: run scheduler ─────────────────────────────────────────────────────
export async function runScheduler(
  userId:  string,
  date:    string,
  db:      ScopedDb,
  options: { item_ids?: string[]; humanize?: boolean } = {},
): Promise<SchedulerResult> {
  const { rows: [prefs] } = await db.query<Record<string, unknown>>(
    `SELECT sleep_time, wake_time FROM users WHERE id = $1`, [userId],
  );
  const wakeMin  = toMin((prefs?.['wake_time']  as string | undefined) ?? '07:00');
  const sleepMin = toMin((prefs?.['sleep_time'] as string | undefined) ?? '23:00');

  const busy  = await getBusyBlocks(userId, date, db);
  const slots = computeFreeSlots(busy, 15, wakeMin, sleepMin);

  // Load items to schedule
  let query = `SELECT id, title, estimated_min, priority, energy_required, kind
               FROM items
               WHERE user_id = $1 AND deleted_at IS NULL
                 AND status = 'todo' AND due_at::date <= $2`;
  const qValues: unknown[] = [userId, date];

  if (options.item_ids?.length) {
    query = `SELECT id, title, estimated_min, priority, energy_required, kind
             FROM items WHERE id = ANY($1::uuid[]) AND user_id = $2 AND deleted_at IS NULL`;
    qValues.length = 0;
    qValues.push(options.item_ids, userId);
  }

  const { rows: items } = await db.query<{
    id: string; title: string; estimated_min: number | null;
    priority: string; energy_required: string | null; kind: string;
  }>(query, qValues);

  // Priority sort: urgent → high → medium → low
  const priorityRank: Record<string, number> = { urgent: 1, high: 2, medium: 3, low: 4 };
  const sorted = [...items].sort((a, b) => (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3));

  const scheduled: SchedulerResult['scheduled'] = [];
  const skipped:   SchedulerResult['skipped']   = [];

  let slotIdx = 0;
  let slotCursor = slots[0] ? toMin(slots[0].start_time) : -1;

  for (const item of sorted) {
    const neededMin = item.estimated_min ?? 30;

    // Find a slot with enough space
    while (slotIdx < slots.length) {
      const slot = slots[slotIdx]!;
      const slotEnd = toMin(slot.end_time);
      const remaining = slotEnd - slotCursor;
      if (remaining >= neededMin) break;
      slotIdx++;
      if (slotIdx < slots.length) slotCursor = toMin(slots[slotIdx]!.start_time);
    }

    if (slotIdx >= slots.length) {
      skipped.push({ item_id: item.id, title: item.title, reason: 'No free slots remaining' });
      continue;
    }

    const startsMin = slotCursor;
    const endsMin   = slotCursor + neededMin;

    const startsAt = new Date(`${date}T00:00:00`);
    startsAt.setMinutes(startsMin);
    const endsAt = new Date(`${date}T00:00:00`);
    endsAt.setMinutes(endsMin);

    await db.query(
      `INSERT INTO calendar_items
         (user_id, kind, source, title, starts_at, ends_at, item_id, energy_required, status)
       VALUES ($1, 'block', 'auto_schedule', $2, $3, $4, $5, $6, 'planned')
       ON CONFLICT DO NOTHING`,
      [userId, item.title, startsAt.toISOString(), endsAt.toISOString(), item.id, item.energy_required ?? null],
    );

    scheduled.push({
      item_id:   item.id,
      title:     item.title,
      starts_at: startsAt.toISOString(),
      ends_at:   endsAt.toISOString(),
    });

    // Advance cursor
    slotCursor = endsMin;
    // Add a short break after
    slotCursor += 10;
  }

  // Optionally humanize the day's plan
  if (options.humanize !== false) {
    const { rows: dayItems } = await db.query<Record<string, unknown>>(
      `SELECT title, starts_at, ends_at, kind, energy_required
       FROM calendar_items
       WHERE user_id = $1 AND starts_at::date = $2 AND deleted_at IS NULL`,
      [userId, date],
    );
    const blocks: HumaneBlock[] = dayItems.map(ci => ({
      title:      ci['title'] as string,
      start_time: toHHMM(new Date(ci['starts_at'] as string).getHours() * 60 + new Date(ci['starts_at'] as string).getMinutes()),
      end_time:   toHHMM(new Date(ci['ends_at']   as string).getHours() * 60 + new Date(ci['ends_at']   as string).getMinutes()),
      category:   ci['kind'] as string,
      ...(ci['energy_required'] !== null && ci['energy_required'] !== undefined
        ? { energy: ci['energy_required'] as string }
        : {}),
    }));
    const { health, applied_fixes } = humanize(blocks);
    return { scheduled, skipped, health, applied_fixes };
  }

  return { scheduled, skipped };
}

// ── Cron jobs ─────────────────────────────────────────────────────────────────
// Called once at server startup from index.ts

export function initCronJobs(): void {
  // Lazy-import to avoid circular deps at module load time
  import('./ai/briefings.js').then(({ runMorningBriefingsForAllUsers, runEveningRecapsForAllUsers, runWeeklyReviewsForAllUsers }) => {
    // Morning briefing — 07:00 every day
    cron.schedule('0 7 * * *', async () => {
      logger.info('cron: running morning briefings');
      await runMorningBriefingsForAllUsers();
    });

    // Evening recap — 21:00 every day
    cron.schedule('0 21 * * *', async () => {
      logger.info('cron: running evening recaps');
      await runEveningRecapsForAllUsers();
    });

    // Weekly review — 09:00 every Sunday
    cron.schedule('0 9 * * 0', async () => {
      logger.info('cron: running weekly reviews');
      await runWeeklyReviewsForAllUsers();
    });

    logger.info('cron jobs initialized');
  }).catch((err: unknown) => {
    logger.error(err, 'Failed to init cron jobs');
  });
}
