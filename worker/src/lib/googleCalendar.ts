// IDEAS item 2 / docs/specs/0017: the Google half of calendar sync -- the
// OAuth round trip, token storage, and the three Calendar API calls the sweep
// makes. Nothing here decides *what* to sync; that's cron/googleSync.ts.

import type { Env } from '../env';
import { seal, unseal, type SealedValue } from './crypto';

const OAUTH_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const OAUTH_REVOKE = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// Matches DISCORD_FETCH_TIMEOUT_MS's reasoning: comfortably shorter than the
// cron's five-minute outbox lease, so a hung request can't leave a sweep
// holding work past the point another invocation may reclaim it.
export const GOOGLE_FETCH_TIMEOUT_MS = 20_000;

// Refresh this far before the token actually expires. A tick that starts with
// 90 seconds left on a token would otherwise spend its Google calls getting
// 401s and retrying, which costs double and reports as a failure.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// specs/0017. calendar.events is what lets us write; calendar.readonly is what
// lets us list the person's calendars for the picker AND, in v0.8.1, run
// freebusy.query -- requested now precisely so that release doesn't have to
// send everyone back through a consent screen.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

export const GOOGLE_CONNECT_PURPOSE = 'google_connect';

export interface GoogleConnectTokenPayload {
  userId: string;
  // Mirrored into an HttpOnly cookie so the signed state alone -- which
  // travels through Google in a URL and is therefore not a secret -- is not
  // enough to complete a link. See specs/0017's "why both".
  nonce: string;
}

export interface GoogleConnectionRow {
  user_id: string;
  refresh_token_ciphertext: string;
  refresh_token_iv: string;
  access_token_ciphertext: string | null;
  access_token_iv: string | null;
  access_token_expires_at: number | null;
  google_account_email: string | null;
  calendar_id: string;
  sync_enabled: number;
  status: 'active' | 'disconnecting';
  last_synced_at: number | null;
  last_error: string | null;
  disconnect_attempts: number;
  connected_at: number;
  updated_at: number;
}

// Ships dormant, the same shape EMAIL_MODE does (specs/0015) and for the same
// reason: the code lands complete, and an operator turns it on once the
// external provisioning it depends on actually exists (docs/SETUP.md section
// 7). Every route checks this and answers 503 rather than 500, and the sweep
// returns immediately, so an unconfigured deployment is inert rather than
// broken.
export function isGoogleConfigured(env: Env): boolean {
  return (
    env.GOOGLE_SYNC_MODE?.trim().toLowerCase() === 'live' &&
    !!env.GOOGLE_CLIENT_ID &&
    !!env.GOOGLE_CLIENT_SECRET &&
    !!env.GOOGLE_TOKEN_ENCRYPTION_KEY
  );
}

export function googleRedirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/google/callback`;
}

export function buildAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    state,
    // Both are load-bearing rather than belt-and-braces. Without
    // access_type=offline Google issues no refresh token at all, and the whole
    // feature is a cron sweep that runs with nobody logged in. Without
    // prompt=consent it issues one only on the *first* authorisation for this
    // client, so someone who disconnects and reconnects gets a grant that
    // works for an hour and then can never be renewed -- a failure that shows
    // up an hour after the testing that would have caught it.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function exchangeCodeForTokens(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
  return (await res.json()) as GoogleTokenResponse;
}

// Best-effort by design. "We deleted our copy" is a weaker promise than "and
// Google no longer honours it", so this is always attempted -- but a failure
// here must not stop the disconnect, or a Google outage would leave someone
// permanently unable to unlink their account.
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(OAUTH_REVOKE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('Google token revocation failed (continuing with local disconnect):', err);
  }
}

// ---------------------------------------------------------------------------
// Connection storage
// ---------------------------------------------------------------------------

export async function loadConnection(env: Env, userId: string): Promise<GoogleConnectionRow | null> {
  return env.DB.prepare(`SELECT * FROM google_calendar_connections WHERE user_id = ?`)
    .bind(userId)
    .first<GoogleConnectionRow>();
}

export async function storeConnection(
  env: Env,
  userId: string,
  refreshToken: string,
  accessToken: string,
  expiresInSeconds: number,
  accountEmail: string | null,
  calendarId: string,
): Promise<void> {
  const now = Date.now();
  const secret = env.GOOGLE_TOKEN_ENCRYPTION_KEY!;
  const sealedRefresh = await seal(refreshToken, secret);
  const sealedAccess = await seal(accessToken, secret);

  // Reconnecting resets sync_enabled, status and last_error deliberately: the
  // most likely reason someone is back here is that the previous grant broke,
  // and leaving the row's failure state behind would mean a successful
  // reconnect that still shows an error and still doesn't sync.
  await env.DB.prepare(
    `INSERT INTO google_calendar_connections (
       user_id, refresh_token_ciphertext, refresh_token_iv,
       access_token_ciphertext, access_token_iv, access_token_expires_at,
       google_account_email, calendar_id, sync_enabled, status,
       last_synced_at, last_error, disconnect_attempts, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', NULL, NULL, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       refresh_token_ciphertext = excluded.refresh_token_ciphertext,
       refresh_token_iv = excluded.refresh_token_iv,
       access_token_ciphertext = excluded.access_token_ciphertext,
       access_token_iv = excluded.access_token_iv,
       access_token_expires_at = excluded.access_token_expires_at,
       google_account_email = excluded.google_account_email,
       calendar_id = excluded.calendar_id,
       sync_enabled = 1,
       status = 'active',
       last_error = NULL,
       disconnect_attempts = 0,
       updated_at = excluded.updated_at`,
  )
    .bind(
      userId,
      sealedRefresh.ciphertext,
      sealedRefresh.iv,
      sealedAccess.ciphertext,
      sealedAccess.iv,
      now + expiresInSeconds * 1000,
      accountEmail,
      calendarId,
      now,
      now,
    )
    .run();
}

export async function readRefreshToken(env: Env, row: GoogleConnectionRow): Promise<string | null> {
  const sealed: SealedValue = { ciphertext: row.refresh_token_ciphertext, iv: row.refresh_token_iv };
  return unseal(sealed, env.GOOGLE_TOKEN_ENCRYPTION_KEY!);
}

// Called by account deletion (lib/db.ts's deleteUserCompletely, and therefore
// also the stale-account purge), which needs the credential actually revoked
// at Google rather than merely dropped locally -- and cannot wait for the
// disconnect sweep, since the row is about to stop existing.
//
// Best-effort by construction: revokeToken swallows its own failures, because
// a Google outage must never be able to block someone deleting their account.
// The rows go regardless; what is lost in that case is only the courtesy of
// telling Google first.
export async function revokeGoogleAccess(env: Env, userId: string): Promise<void> {
  if (!isGoogleConfigured(env)) return;
  const row = await loadConnection(env, userId);
  if (!row) return;
  const refreshToken = await readRefreshToken(env, row);
  if (refreshToken) await revokeToken(refreshToken);
}

export type AccessTokenResult =
  | { ok: true; accessToken: string; refreshed: boolean }
  // The grant is gone for good -- the user revoked it in their Google account
  // settings, or the stored value can no longer be decrypted (a rotated
  // encryption secret). Either way, retrying is pointless and the only route
  // forward is the user reconnecting.
  | { ok: false; reason: 'unauthorized'; message: string }
  | { ok: false; reason: 'retryable'; message: string };

// Returns a usable access token, refreshing only when the cached one is inside
// EXPIRY_SKEW_MS of expiring. `refreshed` tells the caller whether this cost an
// outbound subrequest, so the cron can charge its budget for what actually
// happened rather than for the worst case -- the same distinction
// cron/budget.ts already draws between a cached and an uncached DM channel.
export async function accessTokenFor(env: Env, row: GoogleConnectionRow): Promise<AccessTokenResult> {
  const secret = env.GOOGLE_TOKEN_ENCRYPTION_KEY!;

  if (row.access_token_ciphertext && row.access_token_iv && row.access_token_expires_at) {
    if (row.access_token_expires_at - EXPIRY_SKEW_MS > Date.now()) {
      const cached = await unseal(
        { ciphertext: row.access_token_ciphertext, iv: row.access_token_iv },
        secret,
      );
      if (cached) return { ok: true, accessToken: cached, refreshed: false };
      // Falls through to a refresh rather than failing: an unreadable *access*
      // token is recoverable as long as the refresh token still decrypts.
    }
  }

  const refreshToken = await readRefreshToken(env, row);
  if (!refreshToken) {
    return {
      ok: false,
      reason: 'unauthorized',
      message: 'Stored Google credentials could not be read. Reconnect to fix this.',
    };
  }

  let res: Response;
  try {
    res = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: 'retryable', message: `Network failure refreshing Google token: ${err}` };
  }

  if (!res.ok) {
    // 400 invalid_grant is Google's way of saying the refresh token is dead --
    // revoked by the user, expired through six months of disuse, or the app's
    // credentials changed. It is the one token failure that never resolves on
    // its own, so it must be told apart from a 500: retrying it forever would
    // spend a slice of every tick's budget on a connection that can never work.
    const permanent = res.status === 400 || res.status === 401;
    return {
      ok: false,
      reason: permanent ? 'unauthorized' : 'retryable',
      message: permanent
        ? 'Google access was revoked or expired. Reconnect to resume syncing.'
        : `Google token refresh failed: ${res.status}`,
    };
  }

  const body = (await res.json()) as GoogleTokenResponse;
  const sealedAccess = await seal(body.access_token, secret);
  await env.DB.prepare(
    `UPDATE google_calendar_connections
     SET access_token_ciphertext = ?, access_token_iv = ?, access_token_expires_at = ?, updated_at = ?
     WHERE user_id = ?`,
  )
    .bind(sealedAccess.ciphertext, sealedAccess.iv, Date.now() + body.expires_in * 1000, Date.now(), row.user_id)
    .run();

  return { ok: true, accessToken: body.access_token, refreshed: true };
}

// ---------------------------------------------------------------------------
// Calendar API
// ---------------------------------------------------------------------------

export interface GoogleCalendarSummary {
  id: string;
  summary: string;
  primary: boolean;
}

export type ApiOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'unauthorized' | 'retryable' | 'missing' | 'permanent'; status: number; message: string };

// One place that turns an HTTP status into what the sweep should *do*, so no
// call site has to re-derive it and get it subtly different.
function classify(status: number, body: string): ApiOutcome<never> {
  if (status === 401) return { ok: false, kind: 'unauthorized', status, message: 'Google rejected the access token' };
  if (status === 403 && body.includes('rateLimitExceeded')) {
    return { ok: false, kind: 'retryable', status, message: 'Google rate limit' };
  }
  // 404 (we hold an id Google no longer has) and 410 (already deleted) both
  // mean "the thing you are addressing isn't there". For a delete that's
  // success; for a patch it means our link row is stale and should be dropped
  // so the next tick re-creates the entry. Neither is an error worth
  // surfacing to the user -- deleting our copy from inside Google is a
  // perfectly reasonable thing for someone to do.
  if (status === 404 || status === 410) return { ok: false, kind: 'missing', status, message: 'No such Google event' };
  if (status === 429 || status >= 500) return { ok: false, kind: 'retryable', status, message: `Google ${status}` };
  return { ok: false, kind: 'permanent', status, message: `Google ${status}: ${body.slice(0, 200)}` };
}

async function callGoogle<T>(
  accessToken: string,
  url: string,
  init: RequestInit = {},
): Promise<ApiOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, kind: 'retryable', status: 0, message: `Network failure calling Google: ${err}` };
  }

  if (!res.ok) return classify(res.status, await res.text().catch(() => ''));
  // 204 on delete.
  if (res.status === 204) return { ok: true, value: undefined as T };
  return { ok: true, value: (await res.json()) as T };
}

// The calendars this account may actually write to. accessRole 'reader' and
// 'freeBusyReader' are filtered out because offering them would mean a picker
// where some choices silently fail on the first sync.
export async function listWritableCalendars(accessToken: string): Promise<ApiOutcome<GoogleCalendarSummary[]>> {
  const result = await callGoogle<{
    items?: { id: string; summary: string; accessRole: string; primary?: boolean }[];
  }>(accessToken, `${CALENDAR_API}/users/me/calendarList?minAccessRole=writer&maxResults=250`);
  if (!result.ok) return result;
  return {
    ok: true,
    value: (result.value.items ?? []).map((c) => ({
      id: c.id,
      summary: c.summary,
      primary: !!c.primary,
    })),
  };
}

// Google's primary calendar id *is* the account's email address, which is why
// this feature needs no `email`/`openid` scope to show someone which account
// they connected. One less scope on the consent screen for a value we were
// going to fetch anyway.
export function accountEmailFrom(calendars: GoogleCalendarSummary[]): string | null {
  return calendars.find((c) => c.primary)?.id ?? null;
}

export interface CalendarEventPayload {
  title: string;
  startAt: number;
  endAt: number;
  guildName: string | null;
  eventUrl: string;
  eventId: string;
  occurrenceDate: string;
}

// specs/0017: the app's *event description* is deliberately never sent -- it's
// the most sensitive free text this app holds, and a calendar entry doesn't
// need one. What goes in Google's description field is our own link and the
// server name, which is navigation, not content.
function eventBody(payload: CalendarEventPayload): Record<string, unknown> {
  const lines = [payload.guildName ? `Server: ${payload.guildName}` : null, payload.eventUrl].filter(Boolean);
  return {
    summary: payload.title,
    description: lines.join('\n'),
    start: { dateTime: new Date(payload.startAt).toISOString() },
    end: { dateTime: new Date(payload.endAt).toISOString() },
    // Private to this OAuth client, invisible to the user and to anything else
    // reading the calendar. Makes an entry identifiable as ours from Google's
    // side -- useful for support ("why is this here"), and the handle a future
    // reconciliation pass would need if a link row is ever lost.
    extendedProperties: {
      private: { uncleOwenEventId: payload.eventId, uncleOwenOccurrence: payload.occurrenceDate },
    },
  };
}

export async function insertCalendarEvent(
  accessToken: string,
  calendarId: string,
  payload: CalendarEventPayload,
): Promise<ApiOutcome<{ id: string }>> {
  return callGoogle<{ id: string }>(
    accessToken,
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', body: JSON.stringify(eventBody(payload)) },
  );
}

export async function patchCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
  payload: CalendarEventPayload,
): Promise<ApiOutcome<{ id: string }>> {
  return callGoogle<{ id: string }>(
    accessToken,
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
    { method: 'PATCH', body: JSON.stringify(eventBody(payload)) },
  );
}

export async function deleteCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<ApiOutcome<void>> {
  const result = await callGoogle<void>(
    accessToken,
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
    { method: 'DELETE' },
  );
  // Already gone is the outcome a delete wanted.
  if (!result.ok && result.kind === 'missing') return { ok: true, value: undefined };
  return result;
}
