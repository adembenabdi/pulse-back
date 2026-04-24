/**
 * Spiritual routes — Prayer logging + Quran reading
 *
 * Prayer logs
 * GET    /api/spiritual/prayer/times       today's prayer times via Aladhan API
 * GET    /api/spiritual/prayer/:date      get all 5 prayers for a date
 * POST   /api/spiritual/prayer            log a prayer (idempotent per day)
 * DELETE /api/spiritual/prayer/:id        delete a prayer log
 * GET    /api/spiritual/prayer/stats      7-day/30-day stats (on-time%, jamaa%)
 *
 * Quran logs
 * GET    /api/spiritual/quran             list logs (with ?from=&to=)
 * POST   /api/spiritual/quran             add entry
 * PATCH  /api/spiritual/quran/:id         update entry
 * DELETE /api/spiritual/quran/:id         delete entry
 * GET    /api/spiritual/quran/progress    cumulative pages read, juz progress
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { logger } from '../lib/logger.js';

export const spiritualRouter: Router = Router();
spiritualRouter.use(requireAuth);

const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
type PrayerName = typeof PRAYERS[number];

// ── Prayer times (Aladhan API, cached per city+date) ─────────────────────────
interface PrayerTimes {
  date:    string;
  city:    string;
  country: string;
  method:  number;
  fajr:    string;
  sunrise: string;
  dhuhr:   string;
  asr:     string;
  maghrib: string;
  isha:    string;
}

const timesCache = new Map<string, { ts: number; data: PrayerTimes }>();
const TIMES_TTL_MS = 12 * 60 * 60 * 1000; // 12h

async function fetchPrayerTimes(
  city: string, country: string, method: number, dateISO: string,
): Promise<PrayerTimes> {
  const key = `${city}|${country}|${method}|${dateISO}`;
  const cached = timesCache.get(key);
  if (cached && Date.now() - cached.ts < TIMES_TTL_MS) return cached.data;

  // Aladhan expects DD-MM-YYYY
  const [y, m, d] = dateISO.split('-');
  const dateStr = `${d}-${m}-${y}`;
  const url = `https://api.aladhan.com/v1/timingsByCity/${dateStr}?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=${method}`;

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 10_000);
  let json: { data?: { timings?: Record<string, string> } };
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`Aladhan HTTP ${r.status}`);
    json = await r.json() as typeof json;
  } finally {
    clearTimeout(timeout);
  }

  const t = json.data?.timings;
  if (!t) throw new Error('Invalid Aladhan response');

  const data: PrayerTimes = {
    date:    dateISO,
    city, country, method,
    fajr:    t['Fajr']    ?? '',
    sunrise: t['Sunrise'] ?? '',
    dhuhr:   t['Dhuhr']   ?? '',
    asr:     t['Asr']     ?? '',
    maghrib: t['Maghrib'] ?? '',
    isha:    t['Isha']    ?? '',
  };
  timesCache.set(key, { ts: Date.now(), data });
  return data;
}

// GET /api/spiritual/prayer/times?date=YYYY-MM-DD&city=&country=&method=
spiritualRouter.get('/prayer/times', async (req, res, next) => {
  try {
    const { date, city, country, method } = req.query as Record<string, string | undefined>;
    const dateISO = date ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw new AppError(400, 'Invalid date');

    // Resolve defaults from user preferences
    const { rows } = await req.db.query<{ prefs: Record<string, unknown> }>(
      `SELECT COALESCE(preferences, '{}'::jsonb) AS prefs FROM users WHERE id = $1`,
      [req.user.id],
    );
    const prefs = rows[0]?.prefs ?? {};
    const cityFinal    = city    ?? (prefs['city']    as string | undefined) ?? 'Algiers';
    const countryFinal = country ?? (prefs['country'] as string | undefined) ?? 'Algeria';
    const methodFinal  = Number(method ?? prefs['prayer_method'] ?? 12);

    try {
      const data = await fetchPrayerTimes(cityFinal, countryFinal, methodFinal, dateISO);
      res.json(data);
    } catch (err) {
      logger.warn({ err }, 'Aladhan fetch failed');
      throw new AppError(502, 'Failed to fetch prayer times');
    }
  } catch (err) { next(err); }
});

// ── Prayer logs ───────────────────────────────────────────────────────────────
spiritualRouter.get('/prayer/stats', async (req, res, next) => {
  try {
    const { days = '30' } = req.query as Record<string, string>;
    const { rows } = await req.db.query(
      `SELECT
         COUNT(*)::int                                   AS total_logged,
         COUNT(*) FILTER (WHERE on_time)::int           AS on_time_count,
         COUNT(*) FILTER (WHERE jamaa)::int             AS jamaa_count,
         ROUND(100.0 * COUNT(*) FILTER (WHERE on_time) / NULLIF(COUNT(*),0),1) AS on_time_pct,
         ROUND(100.0 * COUNT(*) FILTER (WHERE jamaa)   / NULLIF(COUNT(*),0),1) AS jamaa_pct,
         COUNT(*) / NULLIF($2::int * 5, 0)::float       AS daily_completion_avg
       FROM prayer_logs
       WHERE user_id = $1
         AND prayed_at >= NOW() - ($2::text || ' days')::interval`,
      [req.user.id, days],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

spiritualRouter.get('/prayer/:date', async (req, res, next) => {
  try {
    const { date } = req.params;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'Invalid date (YYYY-MM-DD)');
    const { rows } = await req.db.query(
      `SELECT * FROM prayer_logs WHERE user_id = $1 AND DATE(prayed_at) = $2 ORDER BY prayed_at`,
      [req.user.id, date],
    );
    // Return as a map prayer → log (or null)
    const result: Record<PrayerName, unknown | null> = {
      fajr: null, dhuhr: null, asr: null, maghrib: null, isha: null,
    };
    for (const row of rows) {
      const name = (row as Record<string, unknown>)['prayer'] as PrayerName;
      if (PRAYERS.includes(name)) result[name] = row;
    }
    res.json(result);
  } catch (err) { next(err); }
});

spiritualRouter.post('/prayer', async (req, res, next) => {
  try {
    const body = z.object({
      prayer:    z.enum(PRAYERS),
      prayed_at: z.string().datetime().optional(),
      on_time:   z.boolean().default(true),
      jamaa:     z.boolean().default(false),
    }).parse(req.body);

    const prayedAt   = body.prayed_at ?? new Date().toISOString();
    const prayedDate = new Date(prayedAt).toISOString().slice(0, 10); // YYYY-MM-DD in UTC

    const { rows } = await req.db.query(
      `INSERT INTO prayer_logs (user_id, prayer, prayed_at, prayed_date, on_time, jamaa)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, prayer, prayed_date) DO UPDATE
         SET prayed_at = EXCLUDED.prayed_at, on_time = EXCLUDED.on_time, jamaa = EXCLUDED.jamaa
       RETURNING *`,
      [req.user.id, body.prayer, prayedAt, prayedDate, body.on_time, body.jamaa],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

spiritualRouter.delete('/prayer/:id', async (req, res, next) => {
  try {
    await req.db.query(
      `DELETE FROM prayer_logs WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Quran logs ────────────────────────────────────────────────────────────────
spiritualRouter.get('/quran/progress', async (req, res, next) => {
  try {
    const { rows } = await req.db.query(
      `SELECT
         COALESCE(SUM(pages),0)::float          AS total_pages,
         COUNT(DISTINCT logged_date)::int        AS days_read,
         MAX(juz)                               AS max_juz,
         ARRAY_AGG(DISTINCT juz ORDER BY juz)   AS juz_read
       FROM quran_logs WHERE user_id = $1`,
      [req.user.id],
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

spiritualRouter.get('/quran', async (req, res, next) => {
  try {
    const { from, to } = req.query as Record<string, string>;
    const fromDate = from ?? new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0]!;
    const toDate   = to   ?? new Date().toISOString().split('T')[0]!;
    const { rows } = await req.db.query(
      `SELECT * FROM quran_logs
       WHERE user_id = $1 AND logged_date BETWEEN $2 AND $3
       ORDER BY logged_date DESC`,
      [req.user.id, fromDate, toDate],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

spiritualRouter.post('/quran', async (req, res, next) => {
  try {
    const body = z.object({
      logged_date: z.string().date().optional(),
      juz:         z.number().int().min(1).max(30).optional(),
      surah:       z.number().int().min(1).max(114).optional(),
      ayah_start:  z.number().int().positive().optional(),
      ayah_end:    z.number().int().positive().optional(),
      pages:       z.number().min(0).max(604).optional(),
      note:        z.string().max(1000).optional(),
    }).parse(req.body);

    const date = body.logged_date ?? new Date().toISOString().split('T')[0]!;
    const { rows } = await req.db.query(
      `INSERT INTO quran_logs
         (user_id, logged_date, juz, surah, ayah_start, ayah_end, pages, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, date, body.juz ?? null, body.surah ?? null,
       body.ayah_start ?? null, body.ayah_end ?? null, body.pages ?? null, body.note ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

spiritualRouter.patch('/quran/:id', async (req, res, next) => {
  try {
    const body = z.object({
      juz:        z.number().int().min(1).max(30).optional(),
      surah:      z.number().int().min(1).max(114).optional(),
      ayah_start: z.number().int().positive().optional(),
      ayah_end:   z.number().int().positive().optional(),
      pages:      z.number().min(0).max(604).optional(),
      note:       z.string().max(1000).optional(),
    }).parse(req.body);
    const col: Record<string, unknown> = {};
    if (body.juz        !== undefined) col['juz']        = body.juz;
    if (body.surah      !== undefined) col['surah']      = body.surah;
    if (body.ayah_start !== undefined) col['ayah_start'] = body.ayah_start;
    if (body.ayah_end   !== undefined) col['ayah_end']   = body.ayah_end;
    if (body.pages      !== undefined) col['pages']      = body.pages;
    if (body.note       !== undefined) col['note']       = body.note;
    if (!Object.keys(col).length) throw new AppError(400, 'Nothing to update');
    const keys = Object.keys(col);
    const fields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await req.db.query(
      `UPDATE quran_logs SET ${fields}
       WHERE id = $1 AND user_id = $${keys.length + 2} RETURNING *`,
      [req.params['id'], ...Object.values(col), req.user.id],
    );
    if (!rows.length) throw new AppError(404, 'Entry not found');
    res.json(rows[0]);
  } catch (err) { next(err); }
});

spiritualRouter.delete('/quran/:id', async (req, res, next) => {
  try {
    await req.db.query(
      `DELETE FROM quran_logs WHERE id = $1 AND user_id = $2`,
      [req.params['id'], req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});
