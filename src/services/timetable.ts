/**
 * University timetable sync service
 *
 * Supports three input formats:
 *  - 'progres' — Algerian university (progres.mesrs.dz) JSON timetable.
 *                Accepts either the human URL `/emplois/{dep}/{grade}/{section}/{group}`
 *                (auto-rewritten to the API URL) or the API URL directly.
 *  - 'ical'    — standard `.ics` (parses VEVENT blocks).
 *  - 'json'    — generic array of `{ uid, summary, dtstart, dtend, location }`.
 *
 * Synced events go into `calendar_items` with kind='class', source='timetable'.
 * Manually-added classes (source!='timetable') are preserved on re-sync.
 *
 * A SHA-256 hash of the raw upstream payload is stored in
 * `university_timetables.parser_config.last_hash` so unchanged feeds are skipped.
 */

import { createHash } from 'node:crypto';
import type { ScopedDb } from '../lib/db.js';

export interface TimetableSyncResult {
  synced:    number;
  skipped:   number;
  unchanged: boolean;
  errors:    string[];
}

// ── Common event shape ───────────────────────────────────────────────────────
interface NormalisedEvent {
  uid:      string;
  summary:  string;
  location: string;
  dtstart:  Date;
  dtend:    Date;
  kind:     'lecture' | 'td' | 'tp';
  professor?: string;
}

// ── ProgRES (V1 Algerian university) ─────────────────────────────────────────

const DAY_MAP: Record<string, number> = {
  samedi: 6, saturday: 6,
  dimanche: 0, sunday: 0,
  lundi: 1, monday: 1,
  mardi: 2, tuesday: 2,
  mercredi: 3, wednesday: 3,
  jeudi: 4, thursday: 4,
  vendredi: 5, friday: 5,
};

const TIME_SLOTS: Record<string, { start: string; end: string }> = {
  firstcours:  { start: '08:00', end: '09:30' },
  secondcours: { start: '09:40', end: '11:10' },
  thirdcours:  { start: '11:20', end: '12:50' },
  fourthcours: { start: '13:00', end: '14:30' },
  fifthcours:  { start: '14:40', end: '16:10' },
  sixthcours:  { start: '16:20', end: '17:50' },
};

const TYPE_MAP: Record<string, NormalisedEvent['kind']> = {
  cours:    'lecture',
  td:       'td',
  tp:       'tp',
  enligne:  'lecture',
};

interface ProgresEntry {
  id?:         string | number;
  day:         string;
  start_time:  string;
  type?:       string;
  subject:     string;
  professor?:  string;
  room?:       string;
}

/**
 * Convert a human ProgRES URL like
 *   https://progres.mesrs.dz/emplois/{department}/{grade}/{section}/{group}
 * to its public API form. Already-API URLs pass through unchanged.
 * Returns null if the URL isn't a recognisable ProgRES URL.
 */
export function normaliseProgresUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.pathname.includes('/api/public/timetable')) return input;

    const parts = url.pathname.split('/').filter(Boolean);
    const idx   = parts.indexOf('emplois');
    if (idx === -1 || parts.length < idx + 5) return null;

    const department = parts[idx + 1]!;
    const grade      = parts[idx + 2]!;
    const section    = parts[idx + 3]!;
    const group      = parts[idx + 4]!;

    const depCap = department.charAt(0).toUpperCase() + department.slice(1);
    return `${url.origin}/api/public/timetable`
      + `?department=${encodeURIComponent(depCap)}`
      + `&grade=${encodeURIComponent(grade)}`
      + `&section=${encodeURIComponent(section)}`
      + `&group=${encodeURIComponent(group)}`;
  } catch {
    return null;
  }
}

/**
 * Convert a (day, slot) pair into concrete dtstart/dtend for the **upcoming**
 * occurrence of that weekday — measured from `weekStart` (a Sunday at 00:00 UTC).
 * The university provides a recurring weekly schedule with no concrete dates,
 * so we anchor each entry to the current week (and the cron will refresh weekly).
 */
function toDates(
  weekStart: Date,
  dayOfWeek: number,        // 0=Sun…6=Sat
  slot:      { start: string; end: string },
): { dtstart: Date; dtend: Date } {
  const day = new Date(weekStart);
  day.setUTCDate(weekStart.getUTCDate() + dayOfWeek);
  const [sh, sm] = slot.start.split(':').map(Number) as [number, number];
  const [eh, em] = slot.end  .split(':').map(Number) as [number, number];
  const dtstart  = new Date(day); dtstart.setUTCHours(sh, sm, 0, 0);
  const dtend    = new Date(day); dtend  .setUTCHours(eh, em, 0, 0);
  return { dtstart, dtend };
}

function parseProgres(payload: unknown, weekStart: Date): NormalisedEvent[] {
  const arr: ProgresEntry[] = Array.isArray(payload)
    ? payload as ProgresEntry[]
    : ((payload as { value?: ProgresEntry[] })?.value ?? []);

  const out: NormalisedEvent[] = [];
  for (const e of arr) {
    const dayNum = DAY_MAP[(e.day || '').toLowerCase()];
    const slot   = TIME_SLOTS[(e.start_time || '').toLowerCase()];
    const type   = TYPE_MAP[(e.type || '').toLowerCase()] ?? 'lecture';
    if (dayNum == null || !slot || !e.subject) continue;

    const { dtstart, dtend } = toDates(weekStart, dayNum, slot);
    out.push({
      uid:       `progres:${e.id ?? `${dayNum}-${e.start_time}-${e.subject}`}`,
      summary:   e.subject,
      location:  e.room ?? '',
      dtstart, dtend,
      kind:      type,
      ...(e.professor ? { professor: e.professor } : {}),
    });
  }
  return out;
}

// ── Generic iCal ─────────────────────────────────────────────────────────────
function parseICS(text: string): NormalisedEvent[] {
  const events: NormalisedEvent[] = [];
  const blocks = text.split(/BEGIN:VEVENT/g).slice(1);
  for (const block of blocks) {
    try {
      const get = (key: string): string => {
        const match = block.match(new RegExp(`^${key}[;:][^\r\n]+`, 'm'));
        if (!match) return '';
        return (match[0]!.replace(new RegExp(`^${key}[^:]*:`), '') as string).trim();
      };
      const uid     = get('UID');
      const summary = get('SUMMARY').replace(/\\n/g, ' ').replace(/\\,/g, ',');
      const location = get('LOCATION').replace(/\\,/g, ',');

      const parseDate = (raw: string): Date | null => {
        if (!raw) return null;
        const m1 = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
        if (m1) return new Date(`${m1[1]}-${m1[2]}-${m1[3]}T${m1[4]}:${m1[5]}:${m1[6]}Z`);
        const m2 = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (m2) return new Date(`${m2[1]}-${m2[2]}-${m2[3]}T00:00:00Z`);
        return null;
      };
      const dtstart = parseDate(get('DTSTART'));
      const dtend   = parseDate(get('DTEND'));
      if (!uid || !dtstart || !dtend || !summary) continue;
      events.push({ uid, summary, location, dtstart, dtend, kind: 'lecture' });
    } catch { /* skip malformed */ }
  }
  return events;
}

// ── Generic JSON ─────────────────────────────────────────────────────────────
function parseJSON(text: string): NormalisedEvent[] {
  try {
    const arr = JSON.parse(text) as Array<{
      id?: string; uid?: string; title?: string; summary?: string;
      start?: string; dtstart?: string; end?: string; dtend?: string; location?: string;
    }>;
    return arr.map((item, i) => ({
      uid:      String(item.uid ?? item.id ?? i),
      summary:  item.summary ?? item.title ?? 'Class',
      location: item.location ?? '',
      dtstart:  new Date(item.dtstart ?? item.start ?? ''),
      dtend:    new Date(item.dtend   ?? item.end   ?? ''),
      kind:     'lecture' as const,
    })).filter(e => !isNaN(e.dtstart.getTime()) && !isNaN(e.dtend.getTime()));
  } catch {
    return [];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Sunday 00:00 UTC of the current week (matches DAY_MAP where Sunday=0). */
function startOfWeekUTC(now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

// ── Main export ──────────────────────────────────────────────────────────────
export async function syncTimetable(
  userId: string,
  url:    string,
  config: unknown,
  db:     ScopedDb,
): Promise<TimetableSyncResult> {
  const cfg     = (config ?? {}) as Record<string, unknown>;
  const format  = (cfg['format'] as string | undefined) ?? 'progres';
  const errors: string[] = [];
  let synced = 0;
  let skipped = 0;

  // 1. Resolve fetchable URL
  let fetchUrl = url;
  if (format === 'progres') {
    const norm = normaliseProgresUrl(url);
    if (!norm) throw new Error('Invalid ProgRES URL — expected /emplois/{dep}/{grade}/{section}/{group}');
    fetchUrl = norm;
  }

  // 2. Fetch
  let text: string;
  try {
    const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    throw new Error(`Failed to fetch timetable: ${(err as Error).message}`);
  }

  // 3. Hash check (skip if unchanged)
  const hash       = createHash('sha256').update(text).digest('hex');
  const lastHash   = (cfg['last_hash'] as string | undefined) ?? '';
  if (hash === lastHash) {
    return { synced: 0, skipped: 0, unchanged: true, errors: [] };
  }

  // 4. Parse
  let events: NormalisedEvent[];
  if (format === 'progres') {
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new Error('ProgRES feed did not return valid JSON'); }
    events = parseProgres(payload, startOfWeekUTC());
  } else if (format === 'json') {
    events = parseJSON(text);
  } else {
    events = parseICS(text);
  }

  if (!events.length) {
    return { synced: 0, skipped: 0, unchanged: false, errors: ['No events parsed from feed'] };
  }

  // 5. Wipe previous timetable-sourced rows for this user (preserve manual)
  await db.query(
    `DELETE FROM calendar_items WHERE user_id = $1 AND source = 'timetable'`,
    [userId],
  );

  // 6. Insert fresh
  for (const ev of events) {
    try {
      await db.query(
        `INSERT INTO calendar_items
           (user_id, kind, source, title, location, starts_at, ends_at, external_id, status, metadata)
         VALUES ($1, 'class', 'timetable', $2, $3, $4, $5, $6, 'planned', $7)`,
        [
          userId,
          ev.summary,
          ev.location || null,
          ev.dtstart.toISOString(),
          ev.dtend.toISOString(),
          ev.uid,
          JSON.stringify({
            class_kind: ev.kind,
            ...(ev.professor ? { professor: ev.professor } : {}),
          }),
        ],
      );
      synced++;
    } catch (err) {
      errors.push(`"${ev.summary}": ${(err as Error).message}`);
      skipped++;
    }
  }

  // 7. Persist new hash + last_synced + raw fetch URL into parser_config
  const newCfg = { ...cfg, format, last_hash: hash, resolved_url: fetchUrl };
  await db.query(
    `UPDATE university_timetables
     SET parser_config = $1, last_synced = NOW(), updated_at = NOW()
     WHERE user_id = $2`,
    [JSON.stringify(newCfg), userId],
  );

  return { synced, skipped, unchanged: false, errors };
}
