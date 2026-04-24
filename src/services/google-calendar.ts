/**
 * Google Calendar OAuth 2.0 + two-way sync service.
 *
 * Flow:
 *  1. GET /api/calendar/google/auth  → redirect to Google consent screen
 *  2. GET /api/calendar/google/callback?code=…  → exchange code, store tokens
 *  3. POST /api/calendar/google/sync  → pull Google events + push Pulse events
 *  4. DELETE /api/calendar/google  → revoke & delete external_calendar row
 */

import { logger }  from '../lib/logger.js';
import { pool }    from '../lib/db.js';

// ── OAuth config ──────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env['GOOGLE_CLIENT_ID']     ?? '';
const CLIENT_SECRET = process.env['GOOGLE_CLIENT_SECRET'] ?? '';
const REDIRECT_URI  = process.env['GOOGLE_REDIRECT_URI']  ??
  'http://localhost:4000/api/calendar/google/callback';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

// ── Build Google OAuth URL ────────────────────────────────────────────────────

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ── Exchange code for tokens ──────────────────────────────────────────────────

export interface GoogleTokens {
  access_token:  string;
  refresh_token: string | null;
  expires_in:    number;
  token_type:    string;
}

export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }
  return res.json() as Promise<GoogleTokens>;
}

// ── Refresh access token ──────────────────────────────────────────────────────

export async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('Google token refresh failed');
  return res.json() as Promise<{ access_token: string; expires_in: number }>;
}

// ── Ensure we have a valid access token ──────────────────────────────────────

async function getValidToken(calRow: Record<string, unknown>): Promise<string> {
  const expiresAt = calRow['token_expires'] ? new Date(calRow['token_expires'] as string) : new Date(0);
  const isExpired = expiresAt.getTime() - Date.now() < 60_000; // 1 min buffer

  if (!isExpired) return calRow['access_token'] as string;

  if (!calRow['refresh_token']) throw new Error('No refresh token stored; user must re-authenticate');

  const refreshed = await refreshAccessToken(calRow['refresh_token'] as string);
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);

  await pool.query(
    `UPDATE external_calendars SET access_token=$1, token_expires=$2 WHERE id=$3`,
    [refreshed.access_token, newExpiry, calRow['id']],
  );
  return refreshed.access_token;
}

// ── List Google Calendar events ───────────────────────────────────────────────

interface GoogleEvent {
  id:      string;
  summary: string | undefined;
  description: string | undefined;
  start:   { dateTime?: string; date?: string };
  end:     { dateTime?: string; date?: string };
  status:  string;
  htmlLink: string;
}

interface GoogleEventsResponse {
  items:         GoogleEvent[];
  nextSyncToken: string | undefined;
}

async function listGoogleEvents(
  accessToken: string,
  calendarId:  string,
  syncToken:   string | null,
  timeMin:     string,
): Promise<{ events: GoogleEvent[]; nextSyncToken: string | undefined }> {
  const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
  if (syncToken) {
    params.set('syncToken', syncToken);
  } else {
    params.set('timeMin', timeMin);
  }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (res.status === 410) {
    // Sync token expired — do a full sync
    const fresh = new URLSearchParams({ singleEvents: 'true', maxResults: '250', timeMin });
    const r2 = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${fresh}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const data = await r2.json() as GoogleEventsResponse;
    return { events: data.items ?? [], nextSyncToken: data.nextSyncToken };
  }

  if (!res.ok) throw new Error(`Google Calendar list failed: ${await res.text()}`);
  const data = await res.json() as GoogleEventsResponse;
  return { events: data.items ?? [], nextSyncToken: data.nextSyncToken };
}

// ── Create/update a Google Calendar event ────────────────────────────────────

async function upsertGoogleEvent(
  accessToken: string,
  calendarId:  string,
  event: { summary: string; description?: string; start: string; end: string; googleEventId?: string },
): Promise<string> {
  const body = {
    summary:     event.summary,
    description: event.description,
    start:       { dateTime: event.start, timeZone: 'Africa/Algiers' },
    end:         { dateTime: event.end,   timeZone: 'Africa/Algiers' },
  };

  const url  = event.googleEventId
    ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${event.googleEventId}`
    : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const method = event.googleEventId ? 'PUT' : 'POST';

  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google event upsert failed: ${await res.text()}`);
  const data = await res.json() as { id: string };
  return data.id;
}

// ── Delete a Google Calendar event ───────────────────────────────────────────

async function deleteGoogleEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

// ── Main sync function ────────────────────────────────────────────────────────

export interface SyncResult {
  imported: number;
  pushed:   number;
  deleted:  number;
}

export async function syncGoogleCalendar(userId: string): Promise<SyncResult> {
  // 1. Load the external_calendar row
  const { rows: calRows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM external_calendars WHERE user_id=$1 AND provider='google' LIMIT 1`,
    [userId],
  );
  if (!calRows[0]) throw new Error('Google Calendar not connected');
  const cal = calRows[0];
  const calId = (cal['external_cal_id'] as string | null) ?? 'primary';

  const accessToken = await getValidToken(cal);
  const timeMin     = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30d back

  // 2. Pull events from Google
  const { events: gEvents, nextSyncToken } = await listGoogleEvents(
    accessToken, calId, cal['sync_token'] as string | null, timeMin,
  );

  let imported = 0;
  let deleted  = 0;

  for (const ge of gEvents) {
    if (ge.status === 'cancelled') {
      // Delete from Pulse if it exists
      const { rowCount } = await pool.query(
        `DELETE FROM calendar_items WHERE user_id=$1 AND metadata->>'google_event_id'=$2`,
        [userId, ge.id],
      );
      if (rowCount && rowCount > 0) deleted++;
      continue;
    }

    const startAt = ge.start.dateTime ?? ge.start.date ?? '';
    const endAt   = ge.end.dateTime   ?? ge.end.date   ?? startAt;

    // Upsert into calendar_items (source = 'google')
    await pool.query(
      `INSERT INTO calendar_items
         (user_id, title, description, kind, starts_at, ends_at, source, metadata)
       VALUES ($1,$2,$3,'event',$4,$5,'google', jsonb_build_object('google_event_id',$6,'html_link',$7))
       ON CONFLICT (user_id, (metadata->>'google_event_id'))
         WHERE metadata->>'google_event_id' IS NOT NULL
         DO UPDATE SET
           title=$2, description=$3, starts_at=$4, ends_at=$5,
           metadata = calendar_items.metadata || excluded.metadata,
           updated_at=NOW()`,
      [userId, ge.summary ?? '(no title)', ge.description ?? null, startAt, endAt, ge.id, ge.htmlLink ?? null],
    );
    imported++;
  }

  // 3. Push Pulse events that don't have a google_event_id yet (and aren't sourced from google)
  const { rows: pulseEvents } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM calendar_items
     WHERE user_id=$1
       AND source != 'google'
       AND (metadata->>'google_event_id') IS NULL
       AND deleted_at IS NULL
       AND kind IN ('event','meeting')
       AND starts_at >= NOW() - INTERVAL '1 day'`,
    [userId],
  );

  let pushed = 0;
  for (const pe of pulseEvents) {
    try {
      const desc = pe['description'] as string | null | undefined;
      const gId = await upsertGoogleEvent(accessToken, calId, {
        summary: pe['title']      as string,
        start:   pe['starts_at']  as string,
        end:     (pe['ends_at'] ?? pe['starts_at']) as string,
        ...(desc !== null && desc !== undefined ? { description: desc } : {}),
      });
      // Store google_event_id back
      await pool.query(
        `UPDATE calendar_items SET metadata = metadata || jsonb_build_object('google_event_id',$1) WHERE id=$2`,
        [gId, pe['id']],
      );
      pushed++;
    } catch (err) {
      logger.warn({ err, calItemId: pe['id'] }, 'Failed to push event to Google Calendar');
    }
  }

  // 4. Save sync token
  if (nextSyncToken) {
    await pool.query(
      `UPDATE external_calendars SET sync_token=$1, last_synced=NOW() WHERE id=$2`,
      [nextSyncToken, cal['id']],
    );
  }

  logger.info({ userId, imported, pushed, deleted }, 'Google Calendar sync complete');
  return { imported, pushed, deleted };
}

// ── Revoke token + delete row ─────────────────────────────────────────────────

export async function disconnectGoogleCalendar(userId: string): Promise<void> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT access_token FROM external_calendars WHERE user_id=$1 AND provider='google' LIMIT 1`,
    [userId],
  );
  if (rows[0]?.['access_token']) {
    // Best-effort revoke
    void fetch(`https://oauth2.googleapis.com/revoke?token=${rows[0]['access_token']}`, { method: 'POST' });
  }
  await pool.query(`DELETE FROM external_calendars WHERE user_id=$1 AND provider='google'`, [userId]);
}
