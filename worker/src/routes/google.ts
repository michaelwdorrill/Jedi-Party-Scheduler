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
import type { Env } from '../env';
import type { AppEnv } from '../lib/authMiddleware';
import { requireAuth, requirePolicyAcceptance } from '../lib/authMiddleware';
import {
  accessTokenFor,
  accountEmailFrom,
  fetchPrimaryCalendarId,
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
  loadPendingConnection,
  deletePendingConnection,
  readPendingAccessToken,
  readPendingRefreshToken,
  revokeToken,
  storeConnection,
  storePendingConnection,
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

// Shared by both places in GET /calendars that can discover a dead grant --
// accessTokenFor's own pre-flight check, and a still-cached access token
// Google rejects anyway once it's actually used. Same outcome either way:
// sync_enabled off (retrying costs a request forever, since only
// reconnecting fixes this) and last_error set to what Google actually said,
// so Settings shows why rather than a stale "Last synced: ..." nobody can
// explain.
//
// Pass-13 review (P13-07) named this alongside cron/googleSync.ts's
// markUnauthorized, and only that one was fixed in the first pass at the
// finding -- so this is the same guard, in the sibling the fix missed.
//
// Keyed on user_id alone, a failure belonging to the account the user has
// just left disables the one they have just connected: the row is read, the
// Google call goes out, the user finishes reconnecting while it is away, and
// the answer lands on whatever row now has that user_id. Guarded by the
// refresh token the failure actually belongs to, a stale answer writes
// nothing.
async function markCalendarUnauthorized(
  env: Env,
  row: { user_id: string; refresh_token_ciphertext: string },
  message: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE google_calendar_connections SET sync_enabled = 0, last_error = ?, updated_at = ?
     WHERE user_id = ? AND refresh_token_ciphertext = ?`,
  )
    .bind(message, Date.now(), row.user_id, row.refresh_token_ciphertext)
    .run();
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
    // Pass-14 review (P14-07). An unknown account is not a connectable one.
    //
    // This lookup doubles as the account-email lookup, and a failure used to
    // fall through as `email = null` -- which storeConnection then compared
    // against the existing connection's known email and read as proof of a
    // DIFFERENT account. So a Google outage during a same-account reconnect
    // revoked the grant the replacement was issued under and ran the
    // destructive account-switch cleanup: imports deleted, links dropped.
    //
    // Refusing is the honest failure. Nothing is lost -- the person retries --
    // whereas storing a connection with no identity is what makes every later
    // comparison against it wrong.
    // Pass-15 review (P15-05) and (F-44), together, because they are the same
    // moment: this is where an unidentified account has to be turned away, and
    // where the grant it just issued has to be handed back.
    //
    // P14-07 refused a FAILED lookup and stopped there. A lookup that succeeds
    // and contains no primary entry is a different fact and was not refused:
    // listWritableCalendars reads one page and discards the continuation
    // token, and Google documents neither that the primary calendar is on the
    // first page nor that every account has one on a page of writable
    // calendars. So a 200 could still produce a NULL email, which finalize
    // stored -- and `switchingAccount` requires two KNOWN identities, so the
    // unidentified account inherited the previous one's destination and links
    // instead of being treated as the different account it may well be.
    //
    // The direct `calendarList/primary` lookup below is the answer to that,
    // and it only runs when the page really had no primary on it.
    const email = calendars.ok
      ? (accountEmailFrom(calendars.value) ?? (await fetchPrimaryCalendarId(tokens.access_token)))
      : null;
    if (!email) {
      // Pass-16 review (P16-04). This refusal deliberately does NOT revoke the
      // token it just exchanged, and F-44 -- which asked it to -- is reopened
      // rather than closed.
      //
      // Revocation at Google is grant-level, not token-level. This app already
      // knows that: it is the entire content of IDEAS item 71, written one
      // commit before this code. Applying it here anyway meant that when a
      // user with a WORKING connection reconnects the same account and the
      // identity lookup has an outage, the refusal revoked the grant that
      // working connection depends on -- so a transient failure during a
      // voluntary reconnect broke the connection the user already had. That is
      // strictly worse than the untidiness F-44 was about, and it needs no
      // concurrency at all: one outage at the wrong moment does it.
      //
      // So the abandoned token is left to expire. It belongs to the same grant
      // the user can see and remove in their own Google settings, and any
      // later disconnect of that account tears it down. The real fix is the
      // lifecycle work item 71 describes -- knowing whether this token's grant
      // is the stored connection's before touching it.
      return c.redirect(`${settingsUrl}?google=account_unverified`);
    }

    // Pass-11 review (F-16 / R01): the grant is parked, not attached. Every
    // check reachable from here -- the state signature, the nonce cookie --
    // proves this browser began the flow; none of them proves this browser
    // belongs to the account the start token names, and that URL is
    // transferable to anyone. So the account has to come back and claim it
    // through POST /finalize, where an ordinary Authorization header settles
    // the question this hop structurally cannot.
    const pendingId = await storePendingConnection(
      c.env,
      payload.userId,
      tokens.refresh_token,
      tokens.access_token,
      tokens.expires_in,
      email,
    );
    return c.redirect(`${settingsUrl}?google=pending&pending=${encodeURIComponent(pendingId)}`);
  } catch (err) {
    // Never reflect the upstream body back to the browser -- it can carry
    // Google error detail and, on a token endpoint, echoes of what was sent.
    // Same discipline as routes/auth.ts's login callback.
    console.error('Google callback failed:', err);
    return c.redirect(`${settingsUrl}?google=failed`);
  }
});

// The step that actually attaches a grant to an account (F-16 / R01), and the
// only one in this flow that can: unlike /start and /callback, it is a normal
// authenticated API call, so `userId` here is who is really signed in rather
// than who a transferable URL claimed.
//
// The refusal path revokes rather than merely deleting. A mismatch means the
// person who consented at Google is not the person this grant was minted to
// attach to -- which is the attack -- and they are owed the grant they just
// issued being torn down at Google, not silently dropped here while it stays
// live in their account.
googleRoutes.post('/finalize', requireAuth, requirePolicyAcceptance, async (c) => {
  c.header('Cache-Control', NO_STORE);
  if (!isGoogleConfigured(c.env)) return notConfigured(c);

  const body = await readJsonBody<{ pendingId?: unknown }>(c);
  const pendingId = assertString(body.pendingId, 'pendingId', 128);

  const pending = await loadPendingConnection(c.env, pendingId);
  // Expired, already claimed, or never existed -- all the same answer, and
  // deliberately so: distinguishing them would confirm the existence of a
  // pending id to someone guessing at them.
  if (!pending) return c.text('That connection attempt has expired. Please connect Google again.', 410);

  if (pending.user_id !== c.get('userId')) {
    console.warn(
      `Google pending connection ${pendingId} was claimed by ${c.get('userId')} but minted for ${pending.user_id}; revoking.`,
    );
    const refreshToken = await readPendingRefreshToken(c.env, pending);
    if (refreshToken) await revokeToken(refreshToken);
    await deletePendingConnection(c.env, pendingId);
    return c.text('That connection attempt does not belong to this account.', 403);
  }

  // Pass-21 review (F-60). Connecting a DIFFERENT Google account while one is
  // active is a disconnect that skips everything disconnect promises.
  //
  // storeConnection's switch branch revokes the old grant first, then drops
  // every mapping and import, and its own comment says the entries are "left
  // in the old account ... nothing this app can do about them from here."
  // That is true from there -- and only because the revoke three statements
  // earlier threw away the authority that could have removed them. Disconnect
  // does the opposite: it spends ticks deleting the entries under the old
  // grant and revokes last, which is the behaviour the confirm dialog and the
  // Privacy Policy describe.
  //
  // So a switch left a person's old calendar full of entries this app had
  // added, with no way to reach them, and nothing on screen saying so.
  //
  // Refusing is the fix rather than reordering the switch to delete-then-
  // revoke, because reordering would duplicate the disconnect sweep -- its
  // budget, its retry accounting, its partial-failure handling -- inside a
  // request handler that has none of them. This routes every path that ends a
  // connection through the one path that keeps the promise, and it makes the
  // destructive half of the switch branch unreachable from the ordinary flow
  // rather than adding a second copy of the careful half.
  //
  // The exemption is for a grant that is already DEAD, and identifying one
  // took correcting a wrong assumption: there is no 'unauthorized' status.
  // `status` is CHECK-constrained to ('active', 'disconnecting') by migration
  // 0036, and a grant Google has rejected is marked by markUnauthorized as
  // sync_enabled = 0 with a last_error -- still 'active'. Keying the guard on
  // status alone would therefore have trapped exactly the person most likely
  // to be switching accounts: someone whose grant just died. They would have
  // had to disconnect and wait out the retry budget first.
  //
  // sync_enabled = 0 on its own is not enough either, because that is also
  // what turning sync off deliberately looks like -- and there the grant is
  // fine and the entries really are still removable, so the switch really
  // would abandon them. It is the pair that means "dead": disabled AND
  // carrying the error that disabled it.
  const existing = await c.env.DB.prepare(
    `SELECT google_account_email, sync_enabled, last_error
     FROM google_calendar_connections WHERE user_id = ?`,
  )
    .bind(c.get('userId'))
    .first<{ google_account_email: string | null; sync_enabled: number; last_error: string | null }>();
  const grantIsDead = !!existing && existing.sync_enabled === 0 && existing.last_error != null;
  const switchingFromActive =
    !!existing &&
    !grantIsDead &&
    !!existing.google_account_email &&
    !!pending.google_account_email &&
    existing.google_account_email !== pending.google_account_email;
  if (switchingFromActive) {
    // The pending grant is abandoned rather than left to expire: the user is
    // not getting this connection, so this app should not keep the credential
    // for it. Same discipline as the wrong-owner branch above.
    const orphanToken = await readPendingRefreshToken(c.env, pending);
    if (orphanToken) await revokeToken(orphanToken);
    await deletePendingConnection(c.env, pendingId);
    return c.text(
      'Disconnect your current Google calendar first. Disconnecting removes the upcoming entries this app added to it — connecting a different account straight away would leave them there for good.',
      409,
    );
  }

  const [refreshToken, accessToken] = await Promise.all([
    readPendingRefreshToken(c.env, pending),
    readPendingAccessToken(c.env, pending),
  ]);
  if (!refreshToken || !accessToken) {
    await deletePendingConnection(c.env, pendingId);
    return c.text('That connection attempt could not be completed. Please connect Google again.', 410);
  }

  await storeConnection(
    c.env,
    c.get('userId'),
    refreshToken,
    accessToken,
    // storeConnection wants a lifetime, and what survived the redirect is an
    // absolute expiry. Converted back here, floored at zero so a grant that
    // sat through its access token's lifetime simply reads as already stale
    // and gets refreshed on first use rather than looking valid.
    Math.max(0, Math.floor(((pending.access_token_expires_at ?? 0) - Date.now()) / 1000)),
    pending.google_account_email,
    'primary',
  );
  await deletePendingConnection(c.env, pendingId);
  return c.json({ connected: true });
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
    // null means reading is off, which is the default. Deliberately a
    // different field from calendarId -- one is where we write, the other is
    // the single calendar we may read (specs/0017).
    readCalendarId: row.read_calendar_id,
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
      await markCalendarUnauthorized(c.env, row, token.message);
      return c.text(token.message, 409);
    }
    // Retryable -- a network blip, Google briefly unhappy -- so this is worth
    // knowing about but not worth writing to last_error the way an
    // unauthorized grant is; the next request just tries again. Logged
    // rather than silently discarded: without this, "Could not reach
    // Google" on screen had no way to be traced back to what actually
    // failed.
    console.warn(`Google token refresh failed for ${row.user_id} (route: /calendars): ${token.message}`);
    return c.text('Could not reach Google just now. Try again in a moment.', 503);
  }

  const calendars = await listWritableCalendars(token.accessToken);
  if (!calendars.ok) {
    // Same reasoning as above for logging -- the actual reason (rate limit, a
    // transient Google 5xx, a network failure) was being thrown away here, so
    // a real -- and possibly recurring -- failure had no trace anywhere
    // `wrangler tail` could show.
    console.warn(`Google calendar list failed for ${row.user_id}: ${calendars.kind} - ${calendars.message}`);
    // Found live: `accessTokenFor` above can hand back an access token it
    // still believes is good (inside its cached expiry, so no refresh was
    // attempted) that Google rejects anyway the moment it's actually used --
    // a grant revoked since the token was cached, for instance. Treated as a
    // generic 503 before this, which reads as "try again in a moment" when
    // retrying can never succeed until the person reconnects -- the same
    // unauthorized outcome `accessTokenFor`'s own pre-flight check handles a
    // few lines up, just discovered one call later.
    if (calendars.kind === 'unauthorized') {
      await markCalendarUnauthorized(c.env, row, calendars.message);
      return c.text(calendars.message, 409);
    }
    return c.text('Could not list your Google calendars.', 503);
  }
  return c.json(calendars.value);
});

googleRoutes.patch('/', requireAuth, requirePolicyAcceptance, async (c) => {
  c.header('Cache-Control', NO_STORE);
  if (!isGoogleConfigured(c.env)) return notConfigured(c);

  const userId = c.get('userId');
  const row = await loadConnection(c.env, userId);
  if (!row) return c.text('No Google account connected', 404);

  const body = await readJsonBody<{
    calendarId?: string;
    syncEnabled?: boolean;
    readCalendarId?: string | null;
  }>(c);
  const calendarId = body.calendarId === undefined ? null : assertString(body.calendarId, 'calendarId', 512);
  const syncEnabled = body.syncEnabled === undefined ? null : assertBoolean(body.syncEnabled, 'syncEnabled');

  // Three states, not two, which is why this is not assertOptionalString:
  // absent means "leave it alone", an explicit null means "stop reading my
  // calendar", and a string means "read this one". Collapsing null into absent
  // would leave no way to turn reading back off.
  const clearsRead = body.readCalendarId === null;
  const readCalendarId =
    body.readCalendarId === undefined || body.readCalendarId === null
      ? null
      : assertString(body.readCalendarId, 'readCalendarId', 512);

  // Switching which calendar is read, or switching reading off, drops every
  // row it imported immediately rather than waiting for the next sweep.
  // Otherwise the scheduling assistant would keep answering from the
  // calendar the person just stopped sharing -- for up to an hour, and up to
  // a week if the sweep could not run. Turning a disclosure off has to take
  // effect at the moment it is asked for.
  const dropsImports = clearsRead || readCalendarId !== null;

  // The read setting is resolved in TypeScript rather than in SQL. Expressing
  // "absent means leave alone, null means clear, a string means set" as CASE
  // expressions needs the same flag bound several times over, which is exactly
  // the kind of statement that goes wrong silently when someone later edits
  // one branch of it. `nextRead` is computed once, here, where it is readable.
  const nextRead = clearsRead ? null : readCalendarId !== null ? readCalendarId : row.read_calendar_id;

  const now = Date.now();
  const statements = [
    c.env.DB.prepare(
      `UPDATE google_calendar_connections
       SET calendar_id = COALESCE(?, calendar_id),
           sync_enabled = COALESCE(?, sync_enabled),
           read_calendar_id = ?,
           -- Changing any of these settings is the user telling us to try
           -- again, so a stale failure message must not outlive the fix. The
           -- sweep writes a fresh one if the problem is still there.
           last_error = NULL,
           updated_at = ?
       WHERE user_id = ?`,
    ).bind(
      calendarId,
      syncEnabled === null ? null : syncEnabled ? 1 : 0,
      nextRead,
      now,
      userId,
    ),
  ];
  // Real personal_events rows now, not a cache blob on this row -- dropping
  // the disclosure means deleting what it created, immediately, same as
  // switching a calendar means the old one's imports have to go too (an
  // orphaned row from a calendar this connection no longer reads would keep
  // making its owner look busy to others forever, never touched by another
  // sync).
  if (dropsImports) {
    statements.push(
      c.env.DB.prepare(`DELETE FROM personal_events WHERE user_id = ? AND google_event_id IS NOT NULL`).bind(userId),
    );
  }

  // Pass-11 review (R17). google_event_links records a Google event id and
  // nothing about *which calendar* it lives in, so changing the write
  // destination left every mapping pointing at entries in the old one. The
  // next tick then compared each upcoming occurrence against those links,
  // found the synced values unchanged, and skipped it -- so the newly chosen
  // calendar received nothing at all, indefinitely, while any later edit tried
  // to PATCH an event id that does not exist in it. The UI meanwhile says, in
  // as many words, that future sessions will be written to the new calendar.
  //
  // The mappings for upcoming occurrences are retired here so the sweep
  // recreates those events under the new destination. Past ones are kept: they
  // are the record of sessions that actually happened, they are not going to be
  // rewritten anywhere, and dropping their links would only lose track of what
  // is already in the old calendar. Entries already written to the old
  // calendar stay where they are, which is exactly what ConnectedCalendars
  // tells the user will happen.
  if (calendarId !== null && calendarId !== row.calendar_id) {
    statements.push(
      c.env.DB.prepare(
        `DELETE FROM google_event_links WHERE user_id = ? AND (synced_end_at IS NULL OR synced_end_at >= ?)`,
      ).bind(userId, now),
    );
  }

  await c.env.DB.batch(statements);

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

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE google_calendar_connections
       SET status = 'disconnecting', sync_enabled = 0, read_calendar_id = NULL,
           disconnect_attempts = 0, updated_at = ?
       WHERE user_id = ?`,
    ).bind(Date.now(), userId),
    // Pass-11 review (F-17 / R11), found by both reviewers. Disconnecting is
    // the strongest form of "stop reading my calendar", so it has to drop what
    // reading created -- the same moment PATCH's `readCalendarId: null`
    // already does, and for the reason PATCH's own comment gives: an imported
    // row whose connection no longer exists is never reconciled by another
    // sync, and routes/personal.ts answers 409 to any PATCH or DELETE on a row
    // with a google_event_id. Without this the person is left holding titles
    // and descriptions from a calendar they disconnected, still counted as
    // busy against them by the scheduling assistant, removable only by
    // reconnecting Google in order to switch reading off, or by deleting
    // their whole account.
    c.env.DB.prepare(`DELETE FROM personal_events WHERE user_id = ? AND google_event_id IS NOT NULL`).bind(userId),
  ]);

  return c.json({ ok: true, status: 'disconnecting' });
});
