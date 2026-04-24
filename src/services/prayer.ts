/**
 * Prayer times service
 *
 * Fetches prayer times from AlAdhan API (https://aladhan.com/prayer-times-api)
 * Falls back to Algiers approximations if the API is unavailable.
 */

export interface PrayerTimes {
  fajr:    string;  // HH:mm
  sunrise?: string;
  dhuhr:   string;
  asr:     string;
  maghrib: string;
  isha:    string;
}

// Approximate Algiers defaults (used as fallback)
const ALGIERS_DEFAULTS: Record<number, PrayerTimes> = {
  0:  { fajr: '06:15', sunrise: '07:30', dhuhr: '12:35', asr: '15:15', maghrib: '17:50', isha: '19:10' },
  1:  { fajr: '06:00', sunrise: '07:15', dhuhr: '12:35', asr: '15:30', maghrib: '18:10', isha: '19:30' },
  2:  { fajr: '05:30', sunrise: '06:50', dhuhr: '12:30', asr: '15:55', maghrib: '18:35', isha: '20:00' },
  3:  { fajr: '05:00', sunrise: '06:20', dhuhr: '12:25', asr: '16:15', maghrib: '19:00', isha: '20:30' },
  4:  { fajr: '04:30', sunrise: '05:55', dhuhr: '12:25', asr: '16:30', maghrib: '19:25', isha: '21:00' },
  5:  { fajr: '04:15', sunrise: '05:45', dhuhr: '12:30', asr: '16:40', maghrib: '19:45', isha: '21:20' },
  6:  { fajr: '04:20', sunrise: '05:50', dhuhr: '12:35', asr: '16:35', maghrib: '19:40', isha: '21:15' },
  7:  { fajr: '04:40', sunrise: '06:05', dhuhr: '12:35', asr: '16:20', maghrib: '19:20', isha: '20:50' },
  8:  { fajr: '05:00', sunrise: '06:20', dhuhr: '12:30', asr: '16:00', maghrib: '18:55', isha: '20:20' },
  9:  { fajr: '05:25', sunrise: '06:45', dhuhr: '12:25', asr: '15:35', maghrib: '18:25', isha: '19:50' },
  10: { fajr: '05:50', sunrise: '07:05', dhuhr: '12:25', asr: '15:10', maghrib: '18:00', isha: '19:20' },
  11: { fajr: '06:10', sunrise: '07:25', dhuhr: '12:30', asr: '15:00', maghrib: '17:45', isha: '19:05' },
};

export async function fetchPrayerTimes(
  date:      string,   // YYYY-MM-DD
  latitude:  number,
  longitude: number,
): Promise<PrayerTimes> {
  try {
    const [y, m, d] = date.split('-');
    const url = `https://api.aladhan.com/v1/timings/${d}-${m}-${y}?latitude=${latitude}&longitude=${longitude}&method=2`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) throw new Error(`AlAdhan API returned ${res.status}`);

    const json = await res.json() as {
      data?: { timings?: Record<string, string> };
      status?: string;
    };
    const t = json.data?.timings;
    if (!t) throw new Error('No timings in response');

    return {
      fajr:    t['Fajr']    ?? '05:00',
      ...(t['Sunrise'] !== undefined ? { sunrise: t['Sunrise'] } : {}),
      dhuhr:   t['Dhuhr']   ?? '12:30',
      asr:     t['Asr']     ?? '15:30',
      maghrib: t['Maghrib'] ?? '18:00',
      isha:    t['Isha']    ?? '19:30',
    };
  } catch {
    // Fallback to month-based Algiers approximation
    const month = parseInt(date.split('-')[1] ?? '1', 10) - 1;
    return ALGIERS_DEFAULTS[month] ?? ALGIERS_DEFAULTS[0]!;
  }
}
