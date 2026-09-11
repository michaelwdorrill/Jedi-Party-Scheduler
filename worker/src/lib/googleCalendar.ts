// IDEAS item 2 / docs/specs/0017: the Google half of calendar sync -- the
// OAuth round trip, token storage, and the three Calendar API calls the sweep
// makes. Nothing here decides *what* to sync; that's cron/googleSync.ts.

import { DateTime } from 'luxon';
import type { Env } from '../env';
import { seal, unseal, type SealedValue } from './crypto';
import { newId } from './ids';

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
// lets us list the person's calendars for the picker AND, in v0.8.1, list
// events on the one nominated for reading -- requested now precisely so that
// release doesn't have to send everyone back through a consent screen.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

// Two purposes, for the two hops of the connect flow, and the split exists for
// a browser reason rather than a cryptographic one.
//
// The nonce cookie has to be set by a *top-level navigation* to this Worker's
// own origin. It cannot be set by the authenticated XHR that starts the flow:
// the frontend is a different origin from the Worker (localhost:5173 or
// uncleowen.space vs workers.dev), and a browser discards Set-Cookie from a
// cross-origin fetch unless the request was made with credentials AND the
// response allows them -- which this app's API client deliberately does not do,
// since it authenticates with a bearer token and wants no ambient cookie
// authority at all.
//
// routes/guildRequests.ts avoids this only because its /connect *is* a
// top-level navigation; it never has to know who is asking. This flow does, so
// it splits into: an authenticated XHR that mints a start token (below), and a
// top-level navigation carrying that token, which is what actually sets the
// cookie and bounces to Google.
export const GOOGLE_START_PURPOSE = 'google_connect_start';
export const GOOGLE_CONNECT_PURPOSE = 'google_connect';

// Hop 1: proves who asked, minted behind requireAuth. Short-lived because it
// only has to survive one immediate redirect.
export interface GoogleStartTokenPayload {
  userId: string;
}

// Hop 2: the OAuth `state`. Carries the same user plus the nonce that is
// simultaneously written to an HttpOnly cookie, so the state alone -- which
// travels through Google in a URL and is therefore not a secret -- is not
// enough to complete a link. See specs/0017's "why both".
export interface GoogleConnectTokenPayload {
  userId: string;
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
  // The pull half (migration 0037). NULL means reading is off for this user,
  // which is the default for everyone -- connecting to push never starts a
  // pull. Deliberately not the same column as calendar_id above.
  //
  // 0.8.1 v2 (migration 0039): what this feeds changed from a JSON cache on
  // this row to real personal_events rows keyed by google_event_id, so the
  // three columns that used to live here (busy_blocks, busy_cached_at,
  // busy_window_end_at) are gone. Nothing on this row tracks the pull half's
  // state any more beyond whether it's on and where it's reading from.
  read_calendar_id: string | null;
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
// Returns whether Google actually confirmed the revocation (R12 in the
// Pass-11 review). It used to return void: the response status was never
// looked at and a network error was caught and swallowed, so every caller
// treated "we sent a request into the void" as "the grant is gone". The cron
// then logged 'token revoked' and deleted the stored credential regardless --
// which is the one thing that makes the failure permanent, since the refresh
// token is what a retry would need. A Google 500 therefore left the grant
// potentially live in the user's account with nothing on this side able to
// reach it, while the Privacy Policy said disconnecting revokes it.
//
// Still never throws: a Google outage must not be able to block an account
// deletion. The difference is that callers can now tell the two outcomes
// apart and say so.
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(OAUTH_REVOKE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    });
    if (res.ok) return true;
    // 400 with error=invalid_token means the grant is already gone -- which is
    // the outcome being asked for, so it counts as success rather than as a
    // failure to retry forever.
    if (res.status === 400) return true;
    console.warn(`Google token revocation returned ${res.status}; the grant may still be live.`);
    return false;
  } catch (err) {
    console.warn('Google token revocation failed (continuing with local disconnect):', err);
    return false;
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

  // Pass-11 review (F-22). `prompt=consent` mints a brand-new refresh token on
  // every reconnect, and the one being replaced stays valid at Google
  // indefinitely -- the user would have to find it themselves under their
  // Google account's third-party access settings. Overwriting our copy is not
  // the same as ending the grant, so the superseded one is revoked before the
  // row is replaced.
  //
  // Pass-12 review (P12-02) narrows that to an account *switch*, which is the
  // only case where it is both safe and necessary.
  //
  // Google's revocation is grant-level, not token-level: revoking any token
  // for a (client, user) pair revokes the authorization grant behind it. A
  // same-account reconnect issues its replacement under that same grant, so
  // revoking the superseded token takes the replacement with it -- F-22's fix
  // was destroying the credential it had just stored, and the connection then
  // reported itself active and failed on its first refresh with invalid_grant.
  // Reconnecting is exactly what someone does when their sync has broken, so
  // this fired on the recovery path.
  //
  // Not revoking a superseded same-account token loses nothing: it belongs to
  // the same single grant the user sees in their Google account, and
  // disconnecting here revokes that grant and every token under it. Google
  // also caps refresh tokens per client/user and expires the oldest itself.
  //
  // A different Google account is a different grant, so there the old one
  // really would survive untouched, and revoking it is the point.
  //
  // Best-effort by construction either way: a reconnect must not fail because
  // Google's revoke endpoint is having a bad minute.
  const existing = await loadConnection(env, userId);
  const switchingAccount =
    !!existing && !!existing.google_account_email && existing.google_account_email !== accountEmail;
  if (switchingAccount) {
    const previous = await readRefreshToken(env, existing);
    if (previous && previous !== refreshToken) await revokeToken(previous);
  }
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
       -- F-22: a reconnect to a *different* Google account must not inherit
       -- the previous one's read selection. read_calendar_id names a
       -- calendar on the old account, which the new grant has no authority
       -- over and may not even be able to see -- so keeping it would leave
       -- the sweep reading nothing while Settings displayed a calendar as
       -- selected. Same account: left alone, since re-authorising a broken
       -- grant should not silently switch reading off.
       read_calendar_id = CASE WHEN ? THEN NULL ELSE read_calendar_id END,
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
      switchingAccount ? 1 : 0,
    )
    .run();

  // And the rows the old account's calendar produced, for the same reason
  // PATCH deletes them when reading is switched off: nothing will ever
  // reconcile them again (the sweep now reads a different account, or none),
  // routes/personal.ts refuses to let their owner delete them, and until
  // something does they keep making that person look busy at times taken from
  // a calendar this app no longer has any connection to.
  if (switchingAccount) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM personal_events WHERE user_id = ? AND google_event_id IS NOT NULL`).bind(userId),
      // Pass-12 review (P12-11). The push half's mappings have to go for the
      // same reason the pull half's imports do, and leaving them was the more
      // damaging of the two: google_event_links records that an event was
      // already synced, and syncOneConnection skips anything whose link says
      // it is unchanged. So every event already pushed to the *old* account was
      // skipped forever and the newly connected one received nothing at all --
      // a connection that reports itself healthy, syncs on schedule, and does
      // nothing. R17 fixed this for a calendar change through PATCH; the
      // account switch is the same hazard one path over.
      //
      // The entries themselves are left in the old account, which is the same
      // unavoidable cost R17 accepted: the new grant has no authority over
      // them, so there is nothing this app can do about them from here.
      env.DB.prepare(`DELETE FROM google_event_links WHERE user_id = ?`).bind(userId),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Pending connections (F-16 / R01) -- see migration 0040 for the full why.
// ---------------------------------------------------------------------------

// How long a grant may sit unclaimed. Long enough for the redirect to land and
// the Settings page to finish loading and call finalize; short enough that an
// abandoned one is gone well before anybody could come looking for it.
export const PENDING_CONNECTION_TTL_MS = 5 * 60 * 1000;

export interface PendingConnectionRow {
  id: string;
  user_id: string;
  refresh_token_ciphertext: string;
  refresh_token_iv: string;
  access_token_ciphertext: string;
  access_token_iv: string;
  access_token_expires_at: number | null;
  google_account_email: string | null;
}

// Called from the OAuth callback, which has proven the nonce cookie but cannot
// prove who is signed in -- so nothing is attached to an account here.
export async function storePendingConnection(
  env: Env,
  userId: string,
  refreshToken: string,
  accessToken: string,
  expiresInSeconds: number,
  accountEmail: string | null,
): Promise<string> {
  const now = Date.now();
  const secret = env.GOOGLE_TOKEN_ENCRYPTION_KEY!;
  const sealedRefresh = await seal(refreshToken, secret);
  const sealedAccess = await seal(accessToken, secret);
  const id = newId();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO google_pending_connections (
         id, user_id, refresh_token_ciphertext, refresh_token_iv,
         access_token_ciphertext, access_token_iv, access_token_expires_at,
         google_account_email, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      userId,
      sealedRefresh.ciphertext,
      sealedRefresh.iv,
      sealedAccess.ciphertext,
      sealedAccess.iv,
      now + expiresInSeconds * 1000,
      accountEmail,
      now,
      now + PENDING_CONNECTION_TTL_MS,
    ),
    // Grants nobody ever came back to claim -- someone who closed the tab
    // between Google's consent screen and Settings. Swept here, on the only
    // path that creates these rows, rather than from the cron: cron/budget.ts
    // records at length what one more fixed per-tick query costs (it starved
    // sweepPurgeTerminalHistory outright, twice), and this table does not
    // deserve that when clearing it as we add to it bounds it just as well.
    // Every insert empties the expired set, so the table cannot grow past the
    // connections actually in flight.
    //
    // Deliberately not revoked at Google on the way out, unlike a claim
    // refused in /finalize. This grant was issued by the owner of the account
    // it belongs to, for a connection they began themselves and simply did
    // not finish; tearing down an authorisation on their side because a tab
    // closed would be a surprise, and the credential is gone from here
    // either way.
    env.DB.prepare(`DELETE FROM google_pending_connections WHERE expires_at < ?`).bind(now),
  ]);
  return id;
}

export async function loadPendingConnection(env: Env, id: string): Promise<PendingConnectionRow | null> {
  return env.DB.prepare(`SELECT * FROM google_pending_connections WHERE id = ? AND expires_at > ?`)
    .bind(id, Date.now())
    .first<PendingConnectionRow>();
}

export async function deletePendingConnection(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM google_pending_connections WHERE id = ?`).bind(id).run();
}

// Unseals a pending grant's refresh token so it can be revoked at Google. Used
// on the refusal path: a grant claimed by the wrong account is not merely
// dropped, because dropping our copy leaves the grant live in the consenting
// person's Google account with nothing in this app to show for it.
export async function readPendingRefreshToken(
  env: Env,
  row: PendingConnectionRow,
): Promise<string | null> {
  return unseal(
    { ciphertext: row.refresh_token_ciphertext, iv: row.refresh_token_iv },
    env.GOOGLE_TOKEN_ENCRYPTION_KEY!,
  );
}

export async function readPendingAccessToken(
  env: Env,
  row: PendingConnectionRow,
): Promise<string | null> {
  return unseal(
    { ciphertext: row.access_token_ciphertext, iv: row.access_token_iv },
    env.GOOGLE_TOKEN_ENCRYPTION_KEY!,
  );
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
  // R12: deliberately NOT gated on isGoogleConfigured any more. A stored
  // credential is a stored credential -- if the feature was switched off on
  // this deployment after someone connected, their grant is still live at
  // Google and erasing their account has to tear it down. Skipping revocation
  // because a config flag changed meant the one case where nobody would ever
  // come back to fix it was also the case that got nothing done.
  //
  // Revocation needs no client id or secret, only the token, so the call is
  // possible whatever the feature mode says. The encryption key is the one
  // thing genuinely required, since without it there is no token to send.
  if (!env.GOOGLE_TOKEN_ENCRYPTION_KEY) return;
  const row = await loadConnection(env, userId);
  if (!row) return;
  const refreshToken = await readRefreshToken(env, row);
  if (!refreshToken) return;

  // Account erasure never blocks on this (see deleteUserCompletely's own
  // comment): a Google outage must not stop someone deleting their account.
  // But the outcome is recorded rather than assumed, so an operator can tell
  // "revoked" from "we deleted our copy and hoped" -- the distinction R12 is
  // about, and one the Privacy Policy has to stop eliding.
  if (!(await revokeToken(refreshToken))) {
    console.warn(
      `Google revocation for ${userId} was not confirmed during account erasure; the local credential is gone, ` +
        'so the grant can now only be removed from that Google account\'s own settings.',
    );
  }
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
  // Pass-12 review (P12-03). Conditioned on the row still holding the refresh
  // token this refresh was performed with, not on user_id alone.
  //
  // `row` is a snapshot taken before a network round trip, and the user can
  // connect a different Google account during it. Keyed on user_id alone, a
  // refresh for account A that lands after account B is stored overwrites B's
  // cached access token with one minted from A's grant: the row then reports
  // B's email and holds B's refresh token while its access token belongs to A,
  // and the next sync sends A's bearer token at B's calendar.
  //
  // The ciphertext is the version token here -- it changes whenever the
  // credential is replaced, which is exactly the event that invalidates this
  // write -- so no schema column is needed to get a compare-and-swap.
  const { meta } = await env.DB.prepare(
    `UPDATE google_calendar_connections
     SET access_token_ciphertext = ?, access_token_iv = ?, access_token_expires_at = ?, updated_at = ?
     WHERE user_id = ? AND refresh_token_ciphertext = ?`,
  )
    .bind(
      sealedAccess.ciphertext,
      sealedAccess.iv,
      Date.now() + body.expires_in * 1000,
      Date.now(),
      row.user_id,
      row.refresh_token_ciphertext,
    )
    .run();

  if (meta.changes === 0) {
    // The connection was replaced while this was in flight. The token is real
    // but belongs to an account this row no longer describes, so it must not
    // be handed back to a caller about to write someone's calendar with it.
    // Retryable rather than unauthorized: the next tick reads the current row
    // and refreshes against the credential that is actually stored.
    return {
      ok: false,
      reason: 'retryable',
      message: 'The Google connection changed while this token refresh was in flight; retrying with the current one.',
    };
  }

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

export interface ImportedCalendarEvent {
  googleEventId: string;
  title: string;
  description: string | null;
  startAt: number;
  endAt: number;
}

// Google's own event shape, narrowed to exactly the fields this function
// requests -- see the `fields` mask below.
interface GoogleEventItem {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  summary?: string;
  description?: string;
}

// events.list against exactly one calendar, expanded to real instances
// (`singleEvents: true`), read for title, description and time -- the whole
// of what a personal_events row needs.
//
// This replaces what used to be a freebusy.query call, and the reason is
// worth recording because it reverses a decision this file used to make in
// the opposite direction, twice over.
//
// First reversal: freebusy.query only reports events Google itself considers
// "Busy" -- an all-day event defaults to "Free" transparency the moment it's
// created, silently excluded from the busy/free answer with no parameter to
// override it. Found in 0.8.1 sandbox verification: a real all-day
// commitment produced an empty busy list, `last_error` null, because Google
// had genuinely and correctly answered "nothing marked Busy here" -- just not
// the question anyone asking to nominate a calendar as their availability
// source actually meant to ask. Decided (Michael, Sept 2026): every event on
// the chosen calendar counts as busy, Google's own Free/Busy toggle on each
// one notwithstanding -- the choice of *which calendar* is the privacy
// control this feature offers, not a second filter on top of it.
//
// Second reversal, decided the same day: this used to return opaque
// {startAt, endAt} pairs on purpose, with a comment recording that reading
// full events was considered and rejected ("scheduling needs busy/free, and
// asking for less is both a smaller privacy surface and less to get
// wrong"). What changed the answer is what those blocks were *for* on the
// owner's own side: Personal Time already has exactly the shape an imported
// Google event needs -- no server, no invite list, no RSVP, just a title, a
// time, and an optional description, private to its owner. Caching an
// anonymous interval and then asking the owner to separately remember what
// it was is strictly worse than storing what it actually is, once the
// destination is a place only the owner ever sees.
//
// That narrowness is preserved everywhere it still matters, though: the
// `fields` mask below is the full extent of what's requested (no attendees,
// no location, no conferencing links, no organizer identity), and what this
// returns is used ONLY to populate the requesting user's own personal_events
// rows -- lib/freeBusy.ts's BusyBlock, the shape anyone *else* scheduling
// around this person receives, is still computed from those rows exactly the
// way it always was, and still carries nothing but a time range. Nobody but
// the calendar's owner ever sees a title or description that came from here.
//
// No pagination: `maxResults` is set to the API's own ceiling (2500) and a
// second page is never requested. cron/googleSync.ts truncates the result
// further, to a number a real person's calendar could plausibly need and a
// single D1 batch can afford -- see MAX_IMPORTED_EVENTS_PER_SYNC there.
export interface ImportedCalendar {
  // The calendar's own timezone, needed alongside the events themselves: an
  // imported row's `timezone` column has to be *something*, and the source
  // calendar's own zone is the only honest answer -- there is no per-user
  // "the timezone I meant this in" for someone else's calendar the way there
  // is for an event created inside Uncle Owen.
  timeZone: string;
  events: ImportedCalendarEvent[];
  // Whether Google says there is more beyond what came back (R16 in the
  // Pass-11 review). The `fields` mask used to omit nextPageToken entirely,
  // which meant a partial page was indistinguishable from a complete one --
  // and Google documents returning fewer results than maxResults with a token
  // rather than a full page, so this is not only about very large calendars.
  // The caller needs it to know whether "these are all the events" is a claim
  // it can act on.
  hasMore: boolean;
}

export async function listCalendarEvents(
  accessToken: string,
  calendarId: string,
  fromMs: number,
  toMs: number,
): Promise<ApiOutcome<ImportedCalendar>> {
  const params = new URLSearchParams({
    timeMin: new Date(fromMs).toISOString(),
    timeMax: new Date(toMs).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
    fields: 'timeZone,nextPageToken,items(id,status,start,end,summary,description)',
  });
  const result = await callGoogle<{ timeZone?: string; items?: GoogleEventItem[]; nextPageToken?: string }>(
    accessToken,
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
  );
  if (!result.ok) {
    // classify()'s 404/410 message ("No such Google event") is phrased for
    // the push half's per-event calls; reworded here so a calendar that no
    // longer exists reads clearly in the last_error column the sync writes
    // it into, rather than talking about "an event" nobody asked about.
    // Every other kind (unauthorized, retryable, permanent) passes through
    // unchanged -- the caller branches on `kind`, not on this text, for
    // those.
    if (result.kind === 'missing') {
      return { ok: false, kind: 'missing', status: result.status, message: 'Google could not read that calendar' };
    }
    return result;
  }

  // Falls back to UTC only if Google ever omits the field entirely, which the
  // API does not document doing -- a defensive floor, not an expected path.
  const zone = result.value.timeZone || 'UTC';

  const imported: ImportedCalendarEvent[] = [];
  for (const item of result.value.items ?? []) {
    if (item.status === 'cancelled') continue;
    const start = item.start;
    const end = item.end;
    if (!start || !end) continue;

    let startAt: number;
    let endAt: number;
    if (start.dateTime && end.dateTime) {
      // A timed event's own dateTime carries its offset already.
      startAt = Date.parse(start.dateTime);
      endAt = Date.parse(end.dateTime);
    } else if (start.date && end.date) {
      // An all-day event has no time or offset of its own -- Google's
      // convention is midnight-to-midnight in the *calendar's* timezone
      // (returned once, at the top of this same response, not per item).
      // `end.date` is already the exclusive boundary (the day after the
      // event's last day), so no adjustment is needed beyond parsing it in
      // the same zone as the start.
      startAt = DateTime.fromISO(start.date, { zone }).toMillis();
      endAt = DateTime.fromISO(end.date, { zone }).toMillis();
    } else {
      continue;
    }
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) continue;

    imported.push({
      googleEventId: item.id,
      title: item.summary?.trim() || 'Busy',
      description: item.description?.trim() || null,
      startAt,
      endAt,
    });
  }

  return { ok: true, value: { timeZone: zone, events: imported, hasMore: !!result.value.nextPageToken } };
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
