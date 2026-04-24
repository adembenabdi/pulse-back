/**
 * Humane scheduling service (port of v1 services/humane.js)
 *
 * Takes a list of planned blocks for a day and:
 *  1. Splits long focus blocks at the max_block_minutes cap (default 90)
 *  2. Inserts breaks between back-to-back deep/work blocks
 *  3. Refuses to place focused work past the evening wind-down threshold
 *  4. Runs a plan health check (score + warnings)
 *
 * Returns { blocks, health, applied_fixes }
 */

export interface HumaneBlock {
  id?:         string;
  title:       string;
  start_time:  string;   // HH:mm
  end_time:    string;   // HH:mm
  category:    string;
  energy?:     string;
  protected?:  boolean;
  description?: string;
}

export interface HumanePrefs {
  wake_time:                   string;
  sleep_time:                  string;
  daily_focus_cap_minutes:     number;
  max_block_minutes:           number;
  min_break_after_minutes:     number;
  evening_winddown_minutes:    number;
  afternoon_low_energy_minutes: number;
  transition_buffer_minutes:   number;
  break_between_minutes:       number;
  deep_work_windows:           string[];
  lighter_day_of_week:         number;
}

export interface HealthCheck { ok: boolean; message: string; }

export interface HumaneResult {
  blocks:         HumaneBlock[];
  health:         { score: number; ok: boolean; checks: HealthCheck[]; warnings: string[] };
  applied_fixes:  string[];
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function toMin(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

function toHHMM(min: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

function dur(b: HumaneBlock): number { return toMin(b.end_time) - toMin(b.start_time); }

// ── Classification ────────────────────────────────────────────────────────────
const REST_CATS  = new Set(['rest', 'meal', 'prayer', 'sleep', 'break', 'commute', 'social', 'wind-down']);
const FOCUS_CATS = new Set(['study', 'work', 'creative', 'deep']);

function isFocus(b: HumaneBlock): boolean {
  if (b.energy === 'deep' || b.energy === 'high') return true;
  if (b.energy === 'low' || b.energy === 'medium') return false;
  return FOCUS_CATS.has(b.category);
}
function isProtected(b: HumaneBlock): boolean {
  return b.protected === true || REST_CATS.has(b.category);
}

function sortByStart(blocks: HumaneBlock[]): HumaneBlock[] {
  return [...blocks].sort((a, b) => toMin(a.start_time) - toMin(b.start_time));
}

// ── Default prefs ─────────────────────────────────────────────────────────────
export const DEFAULT_HUMANE_PREFS: HumanePrefs = {
  wake_time: '07:00',
  sleep_time: '23:00',
  daily_focus_cap_minutes: 360,
  max_block_minutes: 90,
  min_break_after_minutes: 50,
  evening_winddown_minutes: 60,
  afternoon_low_energy_minutes: 20,
  transition_buffer_minutes: 15,
  break_between_minutes: 10,
  deep_work_windows: ['09:00-11:00', '16:00-18:00'],
  lighter_day_of_week: 5,
};

// ── Split long blocks ─────────────────────────────────────────────────────────
function splitLongBlocks(blocks: HumaneBlock[], prefs: HumanePrefs, fixes: string[]): HumaneBlock[] {
  const out: HumaneBlock[] = [];
  const maxMin = prefs.max_block_minutes;
  const breakMin = prefs.break_between_minutes;

  for (const b of blocks) {
    if (isProtected(b) || dur(b) <= maxMin) {
      out.push(b);
      continue;
    }
    const chunkMin = maxMin - breakMin;
    let cursor = toMin(b.start_time);
    const endMin = toMin(b.end_time);
    let part = 1;
    while (cursor < endMin) {
      const chunkEnd = Math.min(cursor + chunkMin, endMin);
      out.push({ ...b, title: `${b.title} (pt ${part})`, start_time: toHHMM(cursor), end_time: toHHMM(chunkEnd) });
      cursor = chunkEnd;
      if (cursor < endMin) {
        out.push({ title: 'Short break', start_time: toHHMM(cursor), end_time: toHHMM(cursor + breakMin), category: 'break', protected: true });
        cursor += breakMin;
      }
      part++;
    }
    fixes.push(`Split "${b.title}" into ${part - 1} chunks`);
  }
  return sortByStart(out);
}

// ── Insert transition buffers ─────────────────────────────────────────────────
function insertTransitionBuffers(blocks: HumaneBlock[], prefs: HumanePrefs, fixes: string[]): HumaneBlock[] {
  const buf = prefs.transition_buffer_minutes;
  if (!buf) return blocks;
  const sorted = sortByStart(blocks);
  const out: HumaneBlock[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1];
    out.push(cur);
    if (next && !isProtected(cur) && !isProtected(next)) {
      const gap = toMin(next.start_time) - toMin(cur.end_time);
      if (gap === 0) {
        out.push({
          title: 'Transition',
          start_time: cur.end_time,
          end_time: toHHMM(toMin(cur.end_time) + buf),
          category: 'break',
          protected: true,
        });
        fixes.push(`Added transition buffer after "${cur.title}"`);
      }
    }
  }
  return sortByStart(out);
}

// ── Wind-down guard ───────────────────────────────────────────────────────────
function enforceWindDown(blocks: HumaneBlock[], prefs: HumanePrefs, fixes: string[]): HumaneBlock[] {
  const windDownStart = toMin(prefs.sleep_time) - prefs.evening_winddown_minutes;
  return blocks.map(b => {
    if (!isFocus(b) || isProtected(b)) return b;
    if (toMin(b.start_time) >= windDownStart) {
      fixes.push(`Removed "${b.title}" — too late (past wind-down at ${toHHMM(windDownStart)})`);
      return null;
    }
    if (toMin(b.end_time) > windDownStart) {
      fixes.push(`Trimmed "${b.title}" to end at wind-down`);
      return { ...b, end_time: toHHMM(windDownStart) };
    }
    return b;
  }).filter((b): b is HumaneBlock => b !== null && dur(b) > 0);
}

// ── Health check ──────────────────────────────────────────────────────────────
function healthCheck(blocks: HumaneBlock[], prefs: HumanePrefs): HumaneResult['health'] {
  const checks: HealthCheck[] = [];
  const warnings: string[] = [];

  const totalFocus = blocks.filter(isFocus).reduce((s, b) => s + dur(b), 0);
  const hasBreaks  = blocks.some(b => b.category === 'break');

  checks.push({ ok: totalFocus <= prefs.daily_focus_cap_minutes, message: `Focus time: ${totalFocus}m / cap ${prefs.daily_focus_cap_minutes}m` });
  checks.push({ ok: hasBreaks || totalFocus === 0, message: hasBreaks ? 'Breaks present' : 'No breaks scheduled' });

  if (totalFocus > prefs.daily_focus_cap_minutes) warnings.push(`Exceeds daily focus cap by ${totalFocus - prefs.daily_focus_cap_minutes}m`);
  if (!hasBreaks && totalFocus > 60) warnings.push('Consider adding breaks for sustained productivity');

  const score = checks.filter(c => c.ok).length / Math.max(1, checks.length) * 100;
  return { score: Math.round(score), ok: warnings.length === 0, checks, warnings };
}

// ── Main export ───────────────────────────────────────────────────────────────
export function humanize(blocks: HumaneBlock[], prefs: Partial<HumanePrefs> = {}): HumaneResult {
  const p: HumanePrefs = { ...DEFAULT_HUMANE_PREFS, ...prefs };
  const fixes: string[] = [];

  let result = splitLongBlocks(blocks, p, fixes);
  result = insertTransitionBuffers(result, p, fixes);
  result = enforceWindDown(result, p, fixes);

  return {
    blocks: sortByStart(result),
    health: healthCheck(result, p),
    applied_fixes: fixes,
  };
}
