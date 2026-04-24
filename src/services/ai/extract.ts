/**
 * services/ai/extract.ts
 *
 * Converts free-form text (a paragraph, a stream of thought, a Telegram
 * message) into a list of structured **proposals** the user can preview,
 * tweak and commit. Multiple proposals can come out of a single paragraph.
 *
 * Used by:
 *   - The in-app QuickCapture (paragraph → proposals → confirm)
 *   - Telegram (paragraph → auto-create + reply with summary)
 *
 * Supported kinds:
 *   task | idea | event | meeting | reminder | note | habit_log | resource
 */

import { groqChat } from './groq.js';
import { logger }   from '../../lib/logger.js';

export type ExtractedKind =
  | 'task' | 'idea' | 'event' | 'meeting' | 'reminder'
  | 'note' | 'habit_log' | 'resource';

export type Priority   = 'low' | 'medium' | 'high' | 'urgent';
export type Energy     = 'low' | 'medium' | 'high';

export interface ExtractedItem {
  kind:           ExtractedKind;
  title:          string;
  description:    string | null;
  /** ISO datetime — when something is *due* (task) */
  due_at:         string | null;
  /** ISO datetime — when something *starts* (event/meeting/reminder) */
  starts_at:      string | null;
  /** ISO datetime — when something *ends* (event/meeting) */
  ends_at:        string | null;
  /** estimated duration in minutes (task or event) */
  estimated_min:  number | null;
  priority:       Priority | null;
  energy:         Energy | null;
  location:       string | null;
  /** RRULE-style recurrence hint, e.g. "FREQ=WEEKLY;BYDAY=MO" */
  recurrence:     string | null;
  /** for resource — extracted URL */
  url:            string | null;
  /** for habit_log — name of the habit being logged */
  habit_name:     string | null;
  /** the source fragment from the user input */
  raw:            string;
  /** model confidence 0..1 (defaults to 0.7 if missing) */
  confidence:     number;
}

const SYSTEM_PROMPT = `You are a personal-productivity dispatcher. The user writes a paragraph (or a few sentences) describing what is on their mind. Your job is to silently figure out what each fragment IS — a task, an idea, a meeting, a reminder, a note, a habit they just did, a useful resource — and return a clean list of proposals.

Today is {{DATE}} ({{WEEKDAY}}). The user's timezone is {{TZ}}. Current local time is {{TIME}}.

Rules:
- ONE paragraph can contain MANY items. Split it carefully. Do not merge unrelated thoughts.
- Pick the BEST kind for each fragment:
    * "task"      — something the user must DO ("call dentist", "finish report", "buy milk").
    * "idea"      — a creative/business concept worth keeping ("app for X", "what if we Y").
    * "event"     — anything with a specific time/date that is NOT a 1:1 meeting (class, gym session, flight, dinner).
    * "meeting"   — a synchronous conversation with another person/team ("call with Sarah Friday 3pm", "team standup").
    * "reminder"  — a poke at a specific time without a duration ("remind me to take pills at 8pm").
    * "note"      — an observation, fact, feeling worth remembering but not actionable ("team is frustrated", "API is slow").
    * "habit_log" — the user is reporting they just did a habit ("did 20 pushups", "meditated 10 min", "read 30 pages").
    * "resource"  — a URL or named reference to read/save later.
- Resolve relative dates to ISO 8601 datetime in the user's timezone:
    "tomorrow"    → next day, 09:00 if no time stated
    "tonight"     → today 20:00
    "this evening"→ today 19:00
    "next Friday" → upcoming Friday
    "in 2 hours"  → now + 2h
- For tasks WITHOUT an explicit time, set due_at to null (do NOT invent one).
- For meetings/events without a stated end, set ends_at to starts_at + 60 min (or 30 for "quick"/"brief").
- Detect priority cues: "urgent", "asap", "important" → high/urgent. "someday", "low key" → low.
- Detect estimated_min from cues like "10 min call", "quick", "couple hours".
- Detect recurrence hints: "every monday" → "FREQ=WEEKLY;BYDAY=MO", "daily" → "FREQ=DAILY".
- Extract URLs verbatim into the "url" field for resource kind.
- "title" must be short (≤ 80 chars). Put longer detail in "description".
- "raw" must be the exact substring of the user input that produced this proposal.
- "confidence" 0..1 — how sure you are this is the right kind. If unsure between kinds, lower the score.

Return ONLY valid JSON of the form:
{
  "items": [
    {
      "kind": "...", "title": "...", "description": null,
      "due_at": null, "starts_at": null, "ends_at": null,
      "estimated_min": null, "priority": null, "energy": null,
      "location": null, "recurrence": null,
      "url": null, "habit_name": null,
      "raw": "...", "confidence": 0.85
    }
  ]
}

If the text contains no actionable content at all, return { "items": [] }.`;

const ALLOWED_KINDS: ExtractedKind[] = [
  'task','idea','event','meeting','reminder','note','habit_log','resource',
];
const PRIORITIES: Priority[] = ['low','medium','high','urgent'];
const ENERGIES:   Energy[]   = ['low','medium','high'];

export interface ExtractOptions {
  /** IANA tz, e.g. "Europe/Paris". Defaults to UTC. */
  timezone?: string;
}

export async function extractItems(
  text: string,
  opts: ExtractOptions = {},
): Promise<ExtractedItem[]> {
  const tz   = opts.timezone || 'UTC';
  const now  = new Date();
  const date = formatLocal(now, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const wd   = formatLocal(now, tz, { weekday: 'long' });
  const time = formatLocal(now, tz, { hour: '2-digit', minute: '2-digit', hour12: false });

  const system = SYSTEM_PROMPT
    .replace('{{DATE}}',    date)
    .replace('{{WEEKDAY}}', wd)
    .replace('{{TZ}}',      tz)
    .replace('{{TIME}}',    time);

  try {
    const result = await groqChat(
      [
        { role: 'system', content: system },
        { role: 'user',   content: text   },
      ],
      { temperature: 0.2, maxTokens: 2000, jsonMode: true },
    );

    const parsed = JSON.parse(result.content) as { items?: unknown[] };
    if (!Array.isArray(parsed.items)) return [];

    return parsed.items
      .map(normalize)
      .filter((x): x is ExtractedItem => x !== null);
  } catch (err) {
    logger.warn({ err }, 'extractItems failed');
    return [];
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function formatLocal(d: Date, tz: string, opts: Intl.DateTimeFormatOptions): string {
  try { return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz }).format(d); }
  catch { return new Intl.DateTimeFormat('en-CA', opts).format(d); }
}

function normalize(raw: unknown): ExtractedItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const kind = typeof o['kind'] === 'string' && (ALLOWED_KINDS as string[]).includes(o['kind'])
    ? o['kind'] as ExtractedKind
    : null;
  const title = typeof o['title'] === 'string' ? o['title'].trim() : '';
  if (!kind || !title) return null;

  const priority = typeof o['priority'] === 'string' && (PRIORITIES as string[]).includes(o['priority'])
    ? o['priority'] as Priority
    : null;
  const energy = typeof o['energy'] === 'string' && (ENERGIES as string[]).includes(o['energy'])
    ? o['energy'] as Energy
    : null;

  const num = (k: string): number | null => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return v;
  };
  const str = (k: string): string | null => {
    const v = o[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };

  const est = num('estimated_min');
  const conf = num('confidence');

  return {
    kind,
    title:         title.slice(0, 200),
    description:   str('description'),
    due_at:        str('due_at'),
    starts_at:     str('starts_at'),
    ends_at:       str('ends_at'),
    estimated_min: est === null ? null : Math.max(1, Math.min(480, Math.round(est))),
    priority,
    energy,
    location:      str('location'),
    recurrence:    str('recurrence'),
    url:           str('url'),
    habit_name:    str('habit_name'),
    raw:           str('raw') ?? title,
    confidence:    conf === null ? 0.7 : Math.max(0, Math.min(1, conf)),
  };
}
