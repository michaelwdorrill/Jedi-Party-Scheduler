// IDEAS item 2 / docs/specs/0017: connecting, configuring and disconnecting a
// Google calendar.
//
// Route gating in this file is per-route rather than applied to the whole
// prefix at mount time, and that is deliberate for the reason routes/me.ts's
// header comment already gives: /google/callback structurally *cannot* carry
// requireAuth (it is a top-level redirect back from Google, with no
// Authorization header available to it), so the prefix cannot be gated as a
// group. Spelling the gate out on each of the other five routes means a route
// added later fails closed with a visible missing argument, rather than
// silently inheriting an exemption written for the callback.

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../lib/authMiddleware';
import { requireAuth, requirePolicyAcceptance } from '../lib/authMiddleware';
import {
  accessTokenFor,
  accountEmailFrom,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  GOOGLE_CONNECT_PURPOSE,
  type GoogleConnectTokenPayload,
  GOOGLE_START_PURPOSE,
  type GoogleStartTokenPayload,
  googleRedirectUri,
  isGoogleConfigured,
  listWritableCalendars,
  loadConnection,
  storeConnection,
} from '../lib/googleCalendar';
import { signToken, verifyToken } from '../lib/signedToken';
import { assertBoolean, assertString, readJsonBody } from '../lib/validate';

export const googleRoutes = new Hono<AppEnv>();

const STATE_COOKIE = 'google_connect_nonce';
const NO_STORE = 'no-store, private';
const CONNECT_TOKEN_TTL_SECONDS = 600;
// Shorter than the state's: this one only has to survive the browser following
// a redirect it was handed milliseconds ago, where the state has to outlast
// however long someone spends on Google's account-picker and consent screens.
const START_TOKEN_TTL_SECONDS = 300;

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 503 rather than 404 or 500: the feature exists and the code is deployed, it
// just hasn't been provisioned yet (docs/SETUP.md section 7). That is a
// temporary condition of the deployment, which is exactly what 503 means, and
// it gives the frontend something honest to say instead of "something went
// wrong".
function notConfigured(c: Context<AppEnv>) {
  c.header('Cache-Control', NO_STORE);
  return c.text('Google Calendar sync is not configured on this deployment yet.', 503);
}

// Hop 1 of the connect flow. Authenticated, because this is the only step that
// knows who is asking -- everything after it is a redirect chain with no
// Authorization header available to it.
//
// Returns a URL on *this Worker* rather than Google's authorize URL, and that
// indirection is load-bearing rather than tidiness: the nonce cookie the
// callback checks cannot be set on this response at all. This is a cross-origin
// XHR (the frontend is a different origin from the Worker), and a browser
// discards Set-Cookie from one unless it was sent with credentials and the
// response allows them -- which this app's API client deliberately never does.
// So the cookie is set by the top-level navigation to /start below, on the
// Worker's own origin, where it is an ordinary first-party cookie.
googleRoutes.post('/connect-url', requireAuth, requirePolicyAcceptance, async (c) => {
  if (!isGoogleConfigured(c.env)) return notConfigured(c);
  c.header('Cache-Control', NO_STORE);

  const payload: GoogleStartTokenPayload = { userId: c.get('userId') };
  const token = await signToken(GOOGLE_START_PURPOSE, payload, c.env.JWT_SIGNING_KEY, START_TOKEN_TTL_SECONDS);
  const origin = new URL(c.req.url).origin;
  return c.json({ startUrl: `${origin}/google/start?t=${encodeURIComponent(token)}` });
});

// Hop 2: the top-level navigation. Unauthenticated for the same structural
// reason the callback is -- a browser following a redirect chain carries no
// bearer token -- and it stands on the start token minted above instead, which
// is single-purpose, short-lived, and says who this is.
//
// This is where the nonce is created, written as a first-party cookie, and
// bound into the OAuth state. Both halves are minted here so they cannot
// disagree.
googleRoutes.get('/start', async (c) => {
  c.header('Cache-Control', NO_STORE);
  if (!isGoogleConfigured(c.env)) return notConfigured(c);

  const settingsUrl = `${c.env.FRONTEND_URL}/#/settings`;
  const raw = c.req.query('t');
  const payload = raw
    ? await verifyToken<GoogleStartTokenPayload>(raw, GOOGLE_START_PURPOSE, c.env.JWT_SIGNING_KEY)
    : null;
  // Expired is the likely case here, not forged: the token lasts five minutes
  // and someone can sit on the Settings page for longer than that before
  // pressing the button. Sending them back to start again is the right answer
  // to both.
  if (!payload) return c.redirect(`${settingsUrl}?google=unverified`);

  const nonce = randomNonce();
  setCookie(c, STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    // Lax, not Strict: the callback arrives as a top-level GET navigation from
    // accounts.google.com, and Strict would withhold the cookie on exactly
    // that hop -- making the flow fail closed every time, for everyone.
    sameSite: 'Lax',
    path: '/google',
    maxAge: CONNECT_TOKEN_TTL_SECONDS,
  });

  const statePayload: GoogleConnectTokenPayload = { userId: payload.userId, nonce };
  const state = await signToken(
    GOOGLE_CONNECT_PURPOSE,
    statePayload,
    c.env.JWT_SIGNING_KEY,
    CONNECT_TOKEN_TTL_SECONDS,
  );
  return c.redirect(buildAuthorizeUrl(c.env, googleRedirectUri(c.req.url), state));
});

// Unauthenticated by construction -- see this file's header comment. What
// stands in for a session is the pair of proofs specs/0017 describes: a signed,
// short-lived, single-purpose state naming the user, AND a nonce cookie only
// the browser that started the flow can present. Either alone is insufficient,
// and the second is specifically what stops an intercepted state being used to
// bind an attacker's Google account to someone else's profile.
googleRoutes.get('/callback', async (c) => {
  c.header('Cache-Control', NO_STORE);
  if (!isGoogleConfigured(c.env)) return notConfigured(c);

  const settingsUrl = `${c.env.FRONTEND_URL}/#/settings`;
  const code = c.req.query('code');
  const state = c.req.query('state');
  const cookieNonce = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/google' });

  // Google's own "the user pressed cancel" path. Not an error worth a scary
  // page -- send them back where they came from with nothing changed.
  if (c.req.query('error')) return c.redirect(`${settingsUrl}?google=cancelled`);
  if (!code || !state) return c.redirect(`${settingsUrl}?google=failed`);

  const payload = await verifyToken<GoogleConnectTokenPayload>(state, GOOGLE_CONNECT_PURPOSE, c.env.JWT_SIGNING_KEY);
  if (!payload || !cookieNonce || payload.nonce !== cookieNonce) {
    return c.redirect(`${settingsUrl}?google=unverified`);
  }

  try {
    const tokens = await exchangeCodeForTokens(c.env, code, googleRedirectUri(c.req.url));
    // No refresh token means access_type/prompt didn't do what they should
    // have, or Google reused a prior grant. Without one this connection dies
    // silently in an hour, so refuse it now rather than storing something that
    // looks connected and isn't.
    if (!tokens.refresh_token) return c.redirect(`${settingsUrl}?google=no_refresh_token`);

    // Doubles as the account-email lookup -- Google's primary calendar id is
    // the account's email address, so this saves requesting an `email` scope
    // purely to display which account got connected.
    const calendars = await listWritableCalendars(tokens.access_token);
    const email = calendars.ok ? accountEmailFrom(calendars.value) : null;

    await storeConnection(
      c.env,
      payload.userId,
      tokens.refresh_token,
      tokens.access_token,
      tokens.expires_in,
      email,
      'primary',
    );
    return c.redirect(`${settingsUrl}?google=connected`);
  } catch (err) {
    // Never reflect the upstream body back to the browser -- it can carry
    // Google error detail and, on a token endpoint, echoes of what was sent.
    // Same discipline as routes/auth.ts's login callback.
    console.error('Google callback failed:', err);
    return c.redirect(`${settingsUrl}?google=failed`);
  }
});

googleRoutes.get('/status', requireAuth, requirePolicyAcceptance, async (c) => {
  c.header('Cache-Control', NO_STORE);
  if (!isGoogleConfigured(c.env)) return c.json({ configured: false, connected: false });

  const row = await loadConnection(c.env, c.get('userId'));
  if (!row) return c.json({ configured: true, connected: false });

  // Deliberately never includes a token, sealed or otherwise. There is no
  // route in this app that returns one.
  return c.json({
    configured: true,
    connected: true,
    accountEmail: row.google_account_email,
    calendarId: row.calendar_id,
    syncEnabled: !!row.sync_enabled,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
  });
});

googleRoutes.get('/calendars', requireAuth, requirePolicyAcceptance, async (c) => {
  c.header('Cache-Control', NO_STORE);
  if (!isGoogleConfigured(c.env)) return notConfigured(c);

  const row = await loadConnection(c.env, c.get('userId'));
  if (!row) return c.text('No Google account connected', 404);

  const token = await accessTokenFor(c.env, row);
  if (!token.ok) {
    // A dead grant surfaced here as well as by the sweep, so someone who opens
    // Settings finds out why it stopped instead of watching an empty calendar.
    if (token.reason === 'unauthorized') {
      await c.env.DB.prepare(
        `UPDATE google_calendar_connections SET sync_enabled = 0, last_error = ?, updated_at = ? WHERE user_id = ?`,
      )
        .bind(token.message, Date.now(), row.user_id)
        .run();
      return c.text(token.message, 409);
    }
    return c.text('Could not reach Google just now. Try again in a moment.', 503);
  }

  const calendars = await listWritableCalendars(token.accessToken);
  if (!calendars.ok) return c.text('Could not list your Google calendars.', 503);
  return c.json(calendars.value);
});

googleRoutes.patch('/', requireAuth, requirePolicyAcceptance, async (c) => {
  c.header('Cache-Control', NO_STORE);
  if (!isGoogleConfigured(c.env)) return notConfigured(c);

  const userId = c.get('userId');
  const row = await loadConnection(c.env, userId);
  if (!row) return c.text('No Google account connected', 404);

  const body = await readJsonBody<{ calendarId?: string; syncEnabled?: boolean }>(c);
  const calendarId = body.calendarId === undefined ? null : assertString(body.calendarId, 'calendarId', 512);
  const syncEnabled = body.syncEnabled === undefined ? null : assertBoolean(body.syncEnabled, 'syncEnabled');

  await c.env.DB.prepare(
    `UPDATE google_calendar_connections
     SET calendar_id = COALESCE(?, calendar_id),
         sync_enabled = COALESCE(?, sync_enabled),
         -- Changing either setting is the user telling us to try again, so a
         -- stale failure message must not outlive the fix. The sweep writes a
         -- fresh one if the problem is still there.
         last_error = NULL,
         updated_at = ?
     WHERE user_id = ?`,
  )
    .bind(calendarId, syncEnabled === null ? null : syncEnabled ? 1 : 0, Date.now(), userId)
    .run();

  return c.json({ ok: true });
});

// Begins the disconnect. Deliberately does not finish it: the entries already
// written to Google have to come back out, and doing that inline would mean a
// request whose duration scales with how busy the next two months are. The
// sweep tidies up and then drops the row (specs/0017).
//
// Sync is switched off in the same statement, so nothing new is written in the
// window between asking to disconnect and the cleanup finishing.
googleRoutes.delete('/', requireAuth, requirePolicyAcceptance, async (c) => {
  c.header('Cache-Control', NO_STORE);
  const userId = c.get('userId');
  const row = await loadConnection(c.env, userId);
  if (!row) return c.json({ ok: true });

  await c.env.DB.prepare(
    `UPDATE google_calendar_connections
     SET status = 'disconnecting', sync_enabled = 0, disconnect_attempts = 0, updated_at = ?
     WHERE user_id = ?`,
  )
    .bind(Date.now(), userId)
    .run();

  return c.json({ ok: true, status: 'disconnecting' });
});
