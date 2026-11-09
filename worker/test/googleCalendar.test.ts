import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { signToken } from '../src/lib/signedToken';
import { seal, unseal } from '../src/lib/crypto';
import { GOOGLE_CONNECT_PURPOSE } from '../src/lib/googleCalendar';
import { sweepGoogleCalendar } from '../src/cron/googleSync';
import { computeBusyBlocksForUsers } from '../src/lib/freeBusy';
import { runReminderSweep } from '../src/cron/reminders';
import { TickBudget } from '../src/cron/budget';
import { deleteUserCompletely } from '../src/lib/db';
import {
  countRows,
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  membershipRule,
  seedAttendance,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

// IDEAS item 2 / docs/specs/0017: Google Calendar sync.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const app = buildApp();
const ENCRYPTION_KEY = 'test-google-encryption-key-at-least-32-chars';

// The feature is dormant unless every one of these is present -- which is the
// behaviour half these tests exist to pin down, so the configured env is opt-in
// per test rather than the default from helpers.ts.
function googleEnv(base: Env): Env {
  return {
    ...base,
    GOOGLE_SYNC_MODE: 'live',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
  };
}

async function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`https://worker.test${path}`, init, env);
}

async function authFor(env: Env, userId: string): Promise<string> {
  const { id: sessionId } = await createSession(env, userId);
  return signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
}

function setCookieValue(res: Response): string {
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error('test fixture: no Set-Cookie on response');
  return raw.split(';')[0];
}

const TOKEN_RULE = {
  match: 'oauth2.googleapis.com/token',
  status: 200,
  body: { access_token: 'google-access-token', refresh_token: 'google-refresh-token', expires_in: 3600 },
};
const CALENDAR_LIST_RULE = {
  match: 'users/me/calendarList',
  status: 200,
  body: {
    items: [
      { id: 'someone@gmail.com', summary: 'Personal', accessRole: 'owner', primary: true },
      { id: 'games@group.calendar.google.com', summary: 'Games', accessRole: 'writer' },
    ],
  },
};
const INSERT_RULE = { match: '/calendar/v3/calendars/', status: 200, body: { id: 'google-event-1' } };
const REVOKE_RULE = { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} };

// The sweep runs about hourly (SYNC_INTERVAL_MS), so a test that wants a
// second sync has to do what the passage of an hour does: make the connection
// due again. Calling the sweep twice in a row is now a no-op by design.
async function makeDue(db: ShimDatabase, userId = 'u1'): Promise<void> {
  await db
    .prepare(`UPDATE google_calendar_connections SET last_synced_at = NULL WHERE user_id = ?`)
    .bind(userId)
    .run();
}

async function seedConnection(
  db: ShimDatabase,
  userId: string,
  overrides: { calendarId?: string; syncEnabled?: number; status?: string; lastSyncedAt?: number | null } = {},
): Promise<void> {
  const sealed = await seal('stored-refresh-token', ENCRYPTION_KEY);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO google_calendar_connections
         (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
          access_token_expires_at, google_account_email, calendar_id, sync_enabled, status,
          last_synced_at, disconnect_attempts, connected_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'someone@gmail.com', ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      userId,
      sealed.ciphertext,
      sealed.iv,
      overrides.calendarId ?? 'primary',
      overrides.syncEnabled ?? 1,
      overrides.status ?? 'active',
      overrides.lastSyncedAt ?? null,
      now,
      now,
    )
    .run();
}

// A user who is an active member of a live guild, which is what
// buildCalendarOccurrences requires before it will return anything at all.
//
// The guild is created once per database rather than per call: several tests
// below need two members of the *same* guild, and seeding it twice collides on
// the primary key.
async function seedMember(db: ShimDatabase, userId: string): Promise<void> {
  const exists = await db.prepare(`SELECT 1 FROM guilds WHERE id = 'guild-1'`).first();
  if (!exists) await seedGuild(db, 'guild-1');
  await seedUser(db, userId);
  await seedMembership(db, userId, 'guild-1');
}

describe('lib/crypto', () => {
  it('round-trips a value through seal and unseal', async () => {
    const sealed = await seal('a-refresh-token', ENCRYPTION_KEY);
    expect(sealed.ciphertext).not.toContain('a-refresh-token');
    expect(await unseal(sealed, ENCRYPTION_KEY)).toBe('a-refresh-token');
  });

  it('uses a fresh IV per record, so the same plaintext seals differently twice', async () => {
    // Not cosmetic: reusing an IV under one key is the failure mode AES-GCM is
    // least forgiving of, so this is the property worth asserting rather than
    // the round trip alone.
    const a = await seal('same-value', ENCRYPTION_KEY);
    const b = await seal('same-value', ENCRYPTION_KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('returns null rather than throwing for the wrong key', async () => {
    // The rotated-secret case. It has to be a clean "this connection is
    // unusable" so the sweep can disable one connection, not an exception that
    // takes down the tick for everybody else's.
    const sealed = await seal('a-refresh-token', ENCRYPTION_KEY);
    expect(await unseal(sealed, 'a-completely-different-key-of-good-length')).toBeNull();
  });

  it('returns null for a tampered ciphertext', async () => {
    const sealed = await seal('a-refresh-token', ENCRYPTION_KEY);
    const flipped = `${sealed.ciphertext.slice(0, -2)}${sealed.ciphertext.endsWith('A') ? 'B' : 'A'}=`;
    expect(await unseal({ ...sealed, ciphertext: flipped }, ENCRYPTION_KEY)).toBeNull();
  });
});

describe('the feature is dormant until configured', () => {
  it('reports configured:false from /google/status', async () => {
    const { db, env } = setup();
    await seedMember(db, 'u1');
    const auth = await authFor(env, 'u1');

    const res = await call(env, '/google/status', { headers: { Authorization: `Bearer ${auth}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, connected: false });
  });

  it('answers 503, not 500, when asked to start a connection', async () => {
    const { db, env } = setup();
    await seedMember(db, 'u1');
    const auth = await authFor(env, 'u1');

    const res = await call(env, '/google/connect-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}` },
    });
    expect(res.status).toBe(503);
  });

  it('makes the sweep a no-op', async () => {
    const { db, env } = setup();
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1');
    // No fetch stub at all: stubFetch throws on any unmatched call, so the
    // absence of one here means any outbound request would fail this test.
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await countRows(db, 'google_event_links')).toBe(0);
  });
});

// Walks the two hops the way a browser does: an authenticated XHR for the
// start URL, then a top-level navigation to it. Returns the cookie and the
// OAuth state the second hop produced.
async function beginConnect(env: Env, userId: string): Promise<{ cookie: string; state: string }> {
  const auth = await authFor(env, userId);
  const urlRes = await call(env, '/google/connect-url', {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}` },
  });
  const { startUrl } = await urlRes.json<{ startUrl: string }>();
  const startRes = await call(env, `/google/start${new URL(startUrl).search}`, { redirect: 'manual' });
  return {
    cookie: setCookieValue(startRes),
    state: new URL(startRes.headers.get('location')!).searchParams.get('state')!,
  };
}

describe('the connect round trip', () => {
  // The bug this pins down: the nonce cookie CANNOT be set on /connect-url's
  // response. That is a cross-origin XHR, and browsers discard Set-Cookie from
  // one unless it was sent with credentials -- which this app's API client
  // never does. Setting it there means the callback's nonce check fails every
  // time, for everyone, and looks like a verification bug rather than a
  // missing cookie. It has to come from the top-level navigation instead.
  it('hands back a Worker URL and sets no cookie on the XHR response', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    const auth = await authFor(env, 'u1');

    const res = await call(env, '/google/connect-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}` },
    });
    expect(res.status).toBe(200);
    const { startUrl } = await res.json<{ startUrl: string }>();
    // On the Worker, not on Google -- the indirection is the fix.
    expect(startUrl).toContain('worker.test/google/start?t=');
    expect(startUrl).not.toContain('accounts.google.com');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sets the nonce cookie on the top-level navigation and redirects to Google', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    const auth = await authFor(env, 'u1');

    const urlRes = await call(env, '/google/connect-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}` },
    });
    const { startUrl } = await urlRes.json<{ startUrl: string }>();
    const res = await call(env, `/google/start${new URL(startUrl).search}`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toContain('accounts.google.com');
    // Both are load-bearing: without them Google issues no refresh token on a
    // reconnect, and the connection dies an hour later.
    expect(location).toContain('access_type=offline');
    expect(location).toContain('prompt=consent');

    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('google_connect_nonce=');
    expect(setCookie).toContain('HttpOnly');
    // Lax rather than Strict: the callback is a top-level GET navigation from
    // accounts.google.com, and Strict would withhold the cookie on exactly
    // that hop.
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('requires authentication to start', async () => {
    const { env: base } = setup();
    const res = await call(googleEnv(base), '/google/connect-url', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('refuses a /start with a missing or forged token', async () => {
    const { env: base } = setup();
    const env = googleEnv(base);

    const missing = await call(env, '/google/start', { redirect: 'manual' });
    expect(missing.headers.get('location')).toContain('google=unverified');

    const forged = await call(env, '/google/start?t=garbage', { redirect: 'manual' });
    expect(forged.headers.get('location')).toContain('google=unverified');
    expect(forged.headers.get('set-cookie')).toBeNull();
  });

  it('stores the connection when the callback checks out and its owner finalizes it', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    const { cookie, state } = await beginConnect(env, 'u1');

    fetchStub = stubFetch([TOKEN_RULE, CALENDAR_LIST_RULE]);
    const res = await call(env, `/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    // Parked, not attached (F-16 / R01): the callback cannot see who is signed
    // in, so the account has to claim the grant from an authenticated request.
    expect(res.headers.get('location')).toContain('google=pending');
    expect(await countRows(db, 'google_calendar_connections')).toBe(0);

    const pendingId = new URL(res.headers.get('location')!.replace('#/', '')).searchParams.get('pending')!;
    const finalize = await call(env, '/google/finalize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await authFor(env, 'u1')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingId }),
    });
    expect(finalize.status).toBe(200);
    // Consumed, so it cannot be replayed.
    expect(await countRows(db, 'google_pending_connections')).toBe(0);

    const row = await db
      .prepare(`SELECT * FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ refresh_token_ciphertext: string; google_account_email: string; calendar_id: string }>();
    expect(row).toBeTruthy();
    // The account email comes from the primary calendar's id, which is why no
    // `email` scope is requested.
    expect(row!.google_account_email).toBe('someone@gmail.com');
    expect(row!.calendar_id).toBe('primary');
    // The credential is never stored in the clear.
    expect(row!.refresh_token_ciphertext).not.toContain('google-refresh-token');
    expect(await unseal(
      { ciphertext: row!.refresh_token_ciphertext, iv: (row as unknown as { refresh_token_iv: string }).refresh_token_iv },
      ENCRYPTION_KEY,
    )).toBe('google-refresh-token');
  });

  // The account-linking attack the cookie exists to stop: a valid signed state
  // captured from somewhere else, replayed in a browser that never started the
  // flow. Without the nonce half, this would bind the attacker's Google account
  // to whichever user the state names.
  it('refuses a valid state presented without the matching cookie', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');

    const state = await signToken(
      GOOGLE_CONNECT_PURPOSE,
      { userId: 'u1', nonce: 'the-real-nonce' },
      env.JWT_SIGNING_KEY,
      600,
    );
    const res = await call(env, `/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('google=unverified');
    expect(await countRows(db, 'google_calendar_connections')).toBe(0);
  });

  it('refuses a state whose nonce does not match the cookie', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');

    const state = await signToken(
      GOOGLE_CONNECT_PURPOSE,
      { userId: 'u1', nonce: 'nonce-from-another-attempt' },
      env.JWT_SIGNING_KEY,
      600,
    );
    const res = await call(env, `/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: 'google_connect_nonce=a-different-nonce' },
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('google=unverified');
    expect(await countRows(db, 'google_calendar_connections')).toBe(0);
  });

  it('refuses a forged state', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');

    const res = await call(env, '/google/callback?code=abc&state=garbage', {
      headers: { Cookie: 'google_connect_nonce=whatever' },
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('google=unverified');
    expect(await countRows(db, 'google_calendar_connections')).toBe(0);
  });

  // A grant with no refresh token works for an hour and then silently stops.
  // Refusing it at the door is the difference between an error the user sees
  // now and a feature that mysteriously dies over lunch.
  it('refuses a grant that came back without a refresh token', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    const { cookie, state } = await beginConnect(env, 'u1');

    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'a', expires_in: 3600 } },
    ]);
    const res = await call(env, `/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toContain('google=no_refresh_token');
    expect(await countRows(db, 'google_calendar_connections')).toBe(0);
  });

  it('sends someone who pressed cancel back without an error page', async () => {
    const { env: base } = setup();
    const res = await call(googleEnv(base), '/google/callback?error=access_denied', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('google=cancelled');
  });
});

describe('GET /calendars', () => {
  it('lists the calendars the account can write to', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1');

    fetchStub = stubFetch([TOKEN_RULE, CALENDAR_LIST_RULE]);
    const res = await call(env, '/google/calendars', {
      headers: { Authorization: `Bearer ${await authFor(env, 'u1')}` },
    });
    expect(res.status).toBe(200);
    const list = await res.json<{ id: string }[]>();
    expect(list.map((c) => c.id)).toEqual(['someone@gmail.com', 'games@group.calendar.google.com']);
  });

  // Found live, on the sandbox: accessTokenFor can hand back an access token
  // it still believes is good (inside its cached expiry, so no refresh was
  // even attempted) that Google rejects anyway the moment it's actually
  // used -- a grant revoked since the token was cached. Before this fix that
  // fell through to a generic 503 ("Could not list your Google calendars",
  // implying "try again"), when what Google actually said was "reconnect";
  // retrying can never succeed until the person does.
  it("switches sync off and says why when Google rejects a token that still looked fresh", async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1');

    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: 'users/me/calendarList', status: 401, body: { error: 'invalid_grant' } },
    ]);
    const res = await call(env, '/google/calendars', {
      headers: { Authorization: `Bearer ${await authFor(env, 'u1')}` },
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Google rejected the access token');

    const row = await db
      .prepare(`SELECT sync_enabled, last_error FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ sync_enabled: number; last_error: string | null }>();
    expect(row!.sync_enabled).toBe(0);
    expect(row!.last_error).toContain('Google rejected the access token');
  });

  it('returns a plain 503, sync left on, for a transient calendar-list failure', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1');

    fetchStub = stubFetch([TOKEN_RULE, { match: 'users/me/calendarList', status: 503, body: {} }]);
    const res = await call(env, '/google/calendars', {
      headers: { Authorization: `Bearer ${await authFor(env, 'u1')}` },
    });
    expect(res.status).toBe(503);

    // Unlike the unauthorized case above: a transient failure doesn't mean
    // reconnecting would help, so sync stays on and nothing is written to
    // last_error -- the next request just tries again.
    const row = await db
      .prepare(`SELECT sync_enabled, last_error FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ sync_enabled: number; last_error: string | null }>();
    expect(row!.sync_enabled).toBe(1);
    expect(row!.last_error).toBeNull();
  });
});

describe('the sync sweep', () => {
  async function seedSyncable(db: ShimDatabase, userId = 'u1'): Promise<string> {
    await seedMember(db, userId);
    await seedConnection(db, userId);
    return seedEvent(db, {
      id: 'evt-1',
      organizerId: userId,
      title: 'Session One',
      startAt: Date.now() + 2 * DAY_MS,
      endAt: Date.now() + 2 * DAY_MS + 3 * HOUR_MS,
    });
  }

  it('writes an upcoming session to Google and records the link', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'google_event_links', "event_id = 'evt-1'")).toBe(1);
    const link = await db
      .prepare(`SELECT * FROM google_event_links WHERE event_id = 'evt-1'`)
      .first<{ google_event_id: string; synced_title: string; occurrence_date: string }>();
    expect(link!.google_event_id).toBe('google-event-1');
    expect(link!.synced_title).toBe('Session One');
    // '' is event_attendance's convention for "the whole event", reused here on
    // purpose so a per-occurrence decline keys the same way.
    expect(link!.occurrence_date).toBe('');

    const insert = fetchStub.calls.findIndex((u) => u.includes('/calendar/v3/calendars/'));
    const body = JSON.parse(fetchStub.bodies[insert]!);
    expect(body.summary).toBe('Session One');
    expect(body.description).toContain('Guild guild-1');
  });

  it('never sends the event description to Google', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);
    await db
      .prepare(`UPDATE events SET description = ? WHERE id = 'evt-1'`)
      .bind('The secret plan involves the thermal exhaust port')
      .run();

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(fetchStub.bodies.join('\n')).not.toContain('thermal exhaust port');
  });

  // Without this the sweep is silent on success, and because it is idempotent
  // the steady state is silent too -- so `wrangler tail` answers "is it
  // working?" with nothing at all, which is the question an operator actually
  // has. Found while verifying v0.8 on the sandbox with a tail open.
  it('reports what it did, and stays quiet on a tick that changed nothing', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => void logged.push(m));
    try {
      await sweepGoogleCalendar(env, new TickBudget('paid'));
      const summary = logged.find((l) => l.includes('Google sync for u1'));
      expect(summary).toContain('1 added');
      expect(summary).toContain('0 removed');

      // Second tick: nothing changed, so nothing is said. A line every fifteen
      // minutes would bury the ticks that matter.
      logged.length = 0;
      await sweepGoogleCalendar(env, new TickBudget('paid'));
      expect(logged.filter((l) => l.includes('Google sync for'))).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('is idempotent -- a second tick with nothing changed writes nothing', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    const afterFirst = fetchStub.calls.filter((u) => u.includes('/calendar/v3/calendars/')).length;
    expect(afterFirst).toBe(1);

    await makeDue(db);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    const afterSecond = fetchStub.calls.filter((u) => u.includes('/calendar/v3/calendars/')).length;
    // The steady state, and the one that decides whether this feature is
    // affordable at all: an unchanged calendar costs no Google calls.
    expect(afterSecond).toBe(1);
    expect(await countRows(db, 'google_event_links')).toBe(1);
  });

  it('patches the entry when the session moves', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    await db
      .prepare(`UPDATE events SET start_at = ?, title = 'Session One, Moved' WHERE id = 'evt-1'`)
      .bind(Date.now() + 5 * DAY_MS)
      .run();
    await makeDue(db);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const patched = fetchStub.calls.filter((u) => u.includes('/calendar/v3/calendars/'));
    expect(patched).toHaveLength(2);
    const link = await db
      .prepare(`SELECT synced_title FROM google_event_links WHERE event_id = 'evt-1'`)
      .first<{ synced_title: string }>();
    expect(link!.synced_title).toBe('Session One, Moved');
  });

  it('removes the entry when the session is cancelled', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await countRows(db, 'google_event_links')).toBe(1);

    await db.prepare(`UPDATE events SET status = 'cancelled' WHERE id = 'evt-1'`).run();
    await makeDue(db);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'google_event_links')).toBe(0);
  });

  it('does not write a session the person has declined', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'organizer');
    await seedMember(db, 'invitee');
    await seedConnection(db, 'invitee');
    await seedEvent(db, {
      id: 'evt-1',
      organizerId: 'organizer',
      startAt: Date.now() + 2 * DAY_MS,
      endAt: Date.now() + 2 * DAY_MS + 3 * HOUR_MS,
    });
    await seedInvite(db, 'evt-1', 'invitee');
    await seedAttendance(db, 'evt-1', 'invitee', 'declined');

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'google_event_links')).toBe(0);
    expect(fetchStub.calls.some((u) => u.includes('/calendar/v3/calendars/'))).toBe(false);
  });

  it('removes an entry once the person declines a session already written', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'organizer');
    await seedMember(db, 'invitee');
    await seedConnection(db, 'invitee');
    await seedEvent(db, {
      id: 'evt-1',
      organizerId: 'organizer',
      startAt: Date.now() + 2 * DAY_MS,
      endAt: Date.now() + 2 * DAY_MS + 3 * HOUR_MS,
    });
    await seedInvite(db, 'evt-1', 'invitee');

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await countRows(db, 'google_event_links')).toBe(1);

    await seedAttendance(db, 'evt-1', 'invitee', 'declined');
    await makeDue(db, 'invitee');
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await countRows(db, 'google_event_links')).toBe(0);
  });

  it('does not write a session outside the 60-day window', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1');
    await seedEvent(db, {
      id: 'evt-far',
      organizerId: 'u1',
      startAt: Date.now() + 120 * DAY_MS,
      endAt: Date.now() + 120 * DAY_MS + 3 * HOUR_MS,
    });

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await countRows(db, 'google_event_links')).toBe(0);
  });

  it('disables the connection and says why when the grant has been revoked', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 400, body: { error: 'invalid_grant' } },
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const row = await db
      .prepare(`SELECT sync_enabled, last_error FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ sync_enabled: number; last_error: string }>();
    // Disabled rather than retried forever: a dead grant never recovers on its
    // own, and re-discovering that costs a slice of every future tick.
    expect(row!.sync_enabled).toBe(0);
    expect(row!.last_error).toContain('revoked');
  });

  it('leaves a connection enabled after a transient Google failure', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/token', status: 503, body: {} }]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const row = await db
      .prepare(
        `SELECT sync_enabled, last_synced_at, last_error FROM google_calendar_connections WHERE user_id = 'u1'`,
      )
      .first<{ sync_enabled: number; last_synced_at: number | null; last_error: string | null }>();

    // Still enabled: a transient failure is not a dead grant, and only
    // reconnecting fixes a dead one, so switching sync off here would be
    // wrong.
    expect(row!.sync_enabled).toBe(1);

    // Pass-14 review (P14-10) reversed the second half of this test, and the
    // reason is worth keeping. It used to assert last_synced_at stayed null,
    // "which is what keeps this connection at the front of the next tick's
    // queue" -- the same reasoning P12-07 had already had to undo on the write
    // path. With MAX_CONNECTIONS_PER_TICK at 1, front is *only*: a connection
    // whose token endpoint keeps answering 503 took the single slot on every
    // tick while other due users got no calendar calls at all.
    //
    // So the attempt is recorded. This connection costs itself its turn, the
    // next one gets theirs, and the error says the freshness is not the whole
    // story.
    expect(row!.last_synced_at, 'a failed attempt was not recorded, so it keeps the slot').not.toBeNull();
    expect(row!.last_error).toBeTruthy();
  });

  // The regression that made this feature not work at all on the sandbox.
  //
  // The sweep used to run last on every tick, taking whatever the notification
  // sweeps left -- eleven queries, measured, stable. It needs twelve. So it
  // read the calendar, could not afford a single write, and returned without
  // stamping last_synced_at: ~380 ticks over four days, nothing written, no
  // error recorded anywhere. This runs a full free-plan tick, which is what
  // the sandbox actually runs, and asserts it syncs.
  it('syncs on a full FREE-plan tick, which is what the deployed cron runs', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200), TOKEN_RULE, INSERT_RULE]);
    await runReminderSweep(env);

    expect(await countRows(db, 'google_event_links')).toBe(1);
    const row = await db
      .prepare(`SELECT last_synced_at FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ last_synced_at: number | null }>();
    expect(row!.last_synced_at).not.toBeNull();
  });

  it('runs about hourly, not every tick', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200), TOKEN_RULE, INSERT_RULE]);
    await runReminderSweep(env);
    const syncedAt = async () =>
      (await db
        .prepare(`SELECT last_synced_at AS t FROM google_calendar_connections WHERE user_id = 'u1'`)
        .first<{ t: number | null }>())!.t;
    const first = await syncedAt();
    expect(first).not.toBeNull();

    // A second tick fifteen minutes later has nothing due, so the sweep is
    // skipped entirely -- it costs that tick nothing, rather than burning the
    // calendar read for no result, which is what the old version did.
    await runReminderSweep(env);
    expect(await syncedAt()).toBe(first);

    // An hour on, it is due again and syncs.
    await db
      .prepare(`UPDATE google_calendar_connections SET last_synced_at = ? WHERE user_id = 'u1'`)
      .bind(Date.now() - 60 * 60 * 1000)
      .run();
    await runReminderSweep(env);
    expect(await syncedAt()).toBeGreaterThan(first!);
  });

  it('says so, rather than failing silently, when it cannot afford a tick', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((m: string) => void warns.push(m));
    try {
      // Enough allowance to look, not enough to act -- the exact shape that
      // produced four days of silence.
      const budget = new TickBudget('free');
      while (budget.trySpend(1) && budget.remaining().queries > 11) {
        /* drain to just above the read cost */
      }
      await sweepGoogleCalendar(env, budget);
    } finally {
      warnSpy.mockRestore();
    }

    expect(await countRows(db, 'google_event_links')).toBe(0);
    // The point of the fix: a skipped tick leaves evidence.
    expect(warns.some((w) => w.includes('Google sync skipped for u1'))).toBe(true);
  });

  it('stops cleanly when the tick runs out of allowance', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    // A free-plan budget already drained by the notification sweeps above it,
    // which is the situation this sweep is designed to lose gracefully.
    const budget = new TickBudget('free');
    while (budget.trySpend(1)) {
      /* drain */
    }
    await sweepGoogleCalendar(env, budget);

    expect(await countRows(db, 'google_event_links')).toBe(0);
  });
});

// IDEAS item 2 / specs/0017 v2 (0.8.1): read ONE chosen calendar's events
// back in as real, read-only personal-time entries, feeding both the
// scheduling assistant (via computeBusyBlocksForUsers) and the owner's own
// calendar.
describe('the personal-time import', () => {
  // A single-row events.list response. `date` shapes an all-day event
  // (Google's own convention: no dateTime, no offset); `dateTime` shapes a
  // timed one. status defaults to 'confirmed' -- a test that wants a
  // cancelled row overrides it explicitly, which is the shape most of these
  // tests never need.
  const EVENTS_LIST_RULE = (
    items: {
      id?: string;
      status?: string;
      summary?: string;
      description?: string;
      start: { date?: string; dateTime?: string };
      end: { date?: string; dateTime?: string };
    }[],
    timeZone = 'America/New_York',
  ) => ({
    // Specific enough to distinguish this GET from the push half's POST to
    // the very same /calendars/{id}/events path -- stubFetch matches by URL
    // substring only, not by method, so the two would otherwise collide the
    // moment a test points both halves at the same calendar id (see 'does
    // not re-import an event this same connection just pushed' below).
    match: '/calendars/work%40example.com/events?',
    status: 200,
    body: {
      timeZone,
      items: items.map((it, i) => ({
        id: it.id ?? `gevt-${i}`,
        status: it.status ?? 'confirmed',
        summary: it.summary,
        description: it.description,
        start: it.start,
        end: it.end,
      })),
    },
  });

  async function seedReader(db: ShimDatabase): Promise<void> {
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1');
    await db
      .prepare(`UPDATE google_calendar_connections SET read_calendar_id = 'work@example.com' WHERE user_id = 'u1'`)
      .run();
  }

  async function importedRows(db: ShimDatabase): Promise<
    { id: string; title: string; description: string | null; start_at: number; end_at: number; availability: string; google_event_id: string }[]
  > {
    const { results } = await db
      .prepare(
        `SELECT id, title, description, start_at, end_at, availability, google_event_id
         FROM personal_events WHERE user_id = 'u1' AND google_event_id IS NOT NULL`,
      )
      .all();
    return results as never;
  }

  // The default, and the one that matters most: connecting to push must never
  // start a pull.
  it('reads nothing at all unless a read calendar has been chosen', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1');

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(fetchStub.calls.some((u) => u.includes('timeMin='))).toBe(false);
    const row = await db
      .prepare(`SELECT read_calendar_id FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ read_calendar_id: string | null }>();
    expect(row!.read_calendar_id).toBeNull();
    expect(await importedRows(db)).toHaveLength(0);
  });

  it('imports a timed event as a read-only personal-time entry, feeding the scheduling assistant', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReader(db);

    const start = Date.now() + 3 * DAY_MS;
    const end = start + 2 * HOUR_MS;
    fetchStub = stubFetch([
      TOKEN_RULE,
      EVENTS_LIST_RULE([
        {
          id: 'work-standup',
          summary: 'Team standup',
          description: 'Daily sync',
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(end).toISOString() },
        },
      ]),
      INSERT_RULE,
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    // Asks events.list against exactly the chosen calendar, expanded to real
    // instances.
    const call = fetchStub.calls.find((u) => u.includes('/calendars/work%40example.com/events'));
    const url = new URL(call!);
    expect(url.searchParams.get('singleEvents')).toBe('true');

    const rows = await importedRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Team standup',
      description: 'Daily sync',
      start_at: start,
      end_at: end,
      availability: 'busy',
      google_event_id: 'work-standup',
    });

    // And it's what the scheduling assistant sees for this person.
    const blocks = (await computeBusyBlocksForUsers(env, ['u1'], Date.now(), Date.now() + 10 * DAY_MS)).get('u1') ?? [];
    expect(blocks.some((b) => b.startAt === start && b.endAt === end)).toBe(true);
  });

  // Found live, on the sandbox: nothing stops someone picking the same
  // Google calendar for both write and read -- the two settings are
  // independent on purpose, so a dedicated "Games" calendar can legitimately
  // be both. Without this, a session pushed to that calendar came straight
  // back in on the very same tick as a "new" personal-time entry: 3 sessions
  // pushed, 3 duplicates imported, all in one sync.
  it('does not re-import an event this same connection just pushed to a shared calendar', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    // Both settings point at the same calendar -- the exact configuration
    // that produced the duplicates.
    await seedConnection(db, 'u1', { calendarId: 'work@example.com' });
    await db
      .prepare(`UPDATE google_calendar_connections SET read_calendar_id = 'work@example.com' WHERE user_id = 'u1'`)
      .run();

    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, { id: 'evt-shared', organizerId: 'u1', startAt: start, endAt: start + HOUR_MS });

    // INSERT_RULE hands back id 'google-event-1' for the push; the read half
    // is told that exact id exists on the calendar, which is what a real
    // Google would report the moment the push above actually landed there.
    fetchStub = stubFetch([
      TOKEN_RULE,
      EVENTS_LIST_RULE([
        {
          id: 'google-event-1',
          summary: 'Uncle Owen session (echoed back by Google)',
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(start + HOUR_MS).toISOString() },
        },
      ]),
      INSERT_RULE,
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    // The push succeeded --
    const link = await db
      .prepare(`SELECT google_event_id FROM google_event_links WHERE user_id = 'u1' AND event_id = 'evt-shared'`)
      .first<{ google_event_id: string }>();
    expect(link?.google_event_id).toBe('google-event-1');

    // -- but it was not also imported back as a personal-time entry.
    const imported = await db
      .prepare(`SELECT id FROM personal_events WHERE user_id = 'u1' AND google_event_id IS NOT NULL`)
      .all();
    expect(imported.results).toHaveLength(0);
  });

  it('counts an all-day event as busy even though Google marks it Free by default', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReader(db);

    // Google's own default for an all-day event -- no explicit transparency
    // field here, which is the point: this code never asks for or checks
    // that field at all, so there is nothing for a "Free" flag to be filtered
    // by in the first place. The old freebusy.query mechanism would have
    // silently omitted this from the answer.
    fetchStub = stubFetch([
      TOKEN_RULE,
      EVENTS_LIST_RULE([
        { id: 'day-off', summary: 'Day off', start: { date: '2026-09-12' }, end: { date: '2026-09-13' } },
      ], 'America/New_York'),
      INSERT_RULE,
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const rows = await importedRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].availability).toBe('busy');
    // Midnight-to-midnight in the calendar's own zone (America/New_York,
    // UTC-4 in September): 2026-09-12T00:00 EDT -> 2026-09-12T04:00:00.000Z.
    expect(new Date(rows[0].start_at).toISOString()).toBe('2026-09-12T04:00:00.000Z');
    expect(new Date(rows[0].end_at).toISOString()).toBe('2026-09-13T04:00:00.000Z');
  });

  it('skips a cancelled instance', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReader(db);
    const start = Date.now() + DAY_MS;

    fetchStub = stubFetch([
      TOKEN_RULE,
      EVENTS_LIST_RULE([
        {
          id: 'called-off',
          status: 'cancelled',
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(start + HOUR_MS).toISOString() },
        },
      ]),
      INSERT_RULE,
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await importedRows(db)).toHaveLength(0);
  });

  it("never lets a title or description reach someone else's scheduling assistant", async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReader(db);
    const start = Date.now() + DAY_MS;

    fetchStub = stubFetch([
      TOKEN_RULE,
      EVENTS_LIST_RULE([
        {
          id: 'secret-thing',
          summary: 'Something private',
          description: 'Very private details',
          start: { dateTime: new Date(start).toISOString() },
          end: { dateTime: new Date(start + HOUR_MS).toISOString() },
        },
      ]),
      INSERT_RULE,
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    // The privacy contract of the whole free/busy feature: what someone else
    // scheduling around this person receives is still opaque, even though
    // the row backing it now stores real content for the owner's own view.
    const blocks = (await computeBusyBlocksForUsers(env, ['u1'], Date.now(), Date.now() + 10 * DAY_MS)).get('u1') ?? [];
    for (const b of blocks) expect(Object.keys(b).sort()).toEqual(['endAt', 'startAt']);
    expect(JSON.stringify(blocks)).not.toContain('private');
  });

  it('keeps existing imports rather than reporting someone free when Google is unreachable', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReader(db);
    const start = Date.now() + DAY_MS;

    fetchStub = stubFetch([
      TOKEN_RULE,
      EVENTS_LIST_RULE([
        { id: 'stays', start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + HOUR_MS).toISOString() } },
      ]),
      INSERT_RULE,
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    fetchStub.restore();

    // Next hour, Google is down.
    await makeDue(db);
    fetchStub = stubFetch([TOKEN_RULE, { match: '/calendars/work%40example.com/events', status: 503, body: {} }, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    // Still there. Over-reporting busy costs someone a slot; under-reporting
    // books a game over a real commitment, which is the failure
    // lib/freeBusy.ts is written to avoid.
    expect(await importedRows(db)).toHaveLength(1);
  });

  it('switches reading off, says why, and removes every imported row when the chosen calendar is gone', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReader(db);
    const start = Date.now() + DAY_MS;

    fetchStub = stubFetch([
      TOKEN_RULE,
      EVENTS_LIST_RULE([
        { id: 'first', start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + HOUR_MS).toISOString() } },
      ]),
      INSERT_RULE,
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await importedRows(db)).toHaveLength(1);
    fetchStub.restore();

    await makeDue(db);
    fetchStub = stubFetch([TOKEN_RULE, { match: '/calendars/work%40example.com/events', status: 404, body: {} }, INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const row = await db
      .prepare(`SELECT read_calendar_id, last_error FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ read_calendar_id: string | null; last_error: string | null }>();
    expect(row!.read_calendar_id).toBeNull();
    expect(row!.last_error).toContain('could not read that calendar');
    // Not left behind orphaned: nothing will ever sync them again.
    expect(await importedRows(db)).toHaveLength(0);
  });

  it("removes an imported row the moment its source event stops appearing, without touching the owner's own entries", async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReader(db);
    const start = Date.now() + DAY_MS;

    fetchStub = stubFetch([
      TOKEN_RULE,
      EVENTS_LIST_RULE([
        { id: 'goes-away', start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + HOUR_MS).toISOString() } },
      ]),
      INSERT_RULE,
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await importedRows(db)).toHaveLength(1);
    fetchStub.restore();

    // A personal time block the owner made by hand, in the same window --
    // must survive the reconciliation below untouched.
    const handMade = await call(
      env,
      '/personal-events',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${await authFor(env, 'u1')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'My own note',
          timezone: 'America/New_York',
          startAt: start + 3 * HOUR_MS,
          endAt: start + 4 * HOUR_MS,
        }),
      },
    );
    expect(handMade.status).toBe(201);

    await makeDue(db);
    fetchStub = stubFetch([TOKEN_RULE, EVENTS_LIST_RULE([]), INSERT_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await importedRows(db)).toHaveLength(0);
    const survivor = await db.prepare(`SELECT title FROM personal_events WHERE user_id = 'u1'`).first<{ title: string }>();
    expect(survivor?.title).toBe('My own note');
  });

  it('drops every imported row the moment reading is switched off, not at the next sweep', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReader(db);
    const start = Date.now() + DAY_MS;
    fetchStub = stubFetch([
      TOKEN_RULE,
      EVENTS_LIST_RULE([
        { id: 'goes-too', start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + HOUR_MS).toISOString() } },
      ]),
      INSERT_RULE,
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await importedRows(db)).toHaveLength(1);

    const auth = await authFor(env, 'u1');
    const res = await call(env, '/google', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${auth}` },
      body: JSON.stringify({ readCalendarId: null }),
    });
    expect(res.status).toBe(200);

    // Turning a disclosure off has to take effect when it is asked for, not
    // up to an hour later.
    expect(await importedRows(db)).toHaveLength(0);
  });

  it('refuses to edit an imported entry, pointing at Google as the source of truth', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedReader(db);
    const start = Date.now() + DAY_MS;
    fetchStub = stubFetch([
      TOKEN_RULE,
      EVENTS_LIST_RULE([
        { id: 'immutable', summary: 'Locked', start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + HOUR_MS).toISOString() } },
      ]),
      INSERT_RULE,
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    const [row] = await importedRows(db);

    const auth = await authFor(env, 'u1');
    const patchRes = await call(env, `/personal-events/${row.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed locally' }),
    });
    expect(patchRes.status).toBe(409);

    const deleteRes = await call(env, `/personal-events/${row.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${auth}` },
    });
    expect(deleteRes.status).toBe(409);

    // Untouched by either refused request.
    const still = await db.prepare(`SELECT title FROM personal_events WHERE id = ?`).bind(row.id).first<{ title: string }>();
    expect(still?.title).toBe('Locked');
  });
});


describe('disconnecting', () => {
  it('marks the connection disconnecting rather than deleting it outright', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1');
    const auth = await authFor(env, 'u1');

    const res = await call(env, '/google', { method: 'DELETE', headers: { Authorization: `Bearer ${auth}` } });
    expect(res.status).toBe(200);

    const row = await db
      .prepare(`SELECT status, sync_enabled FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ status: string; sync_enabled: number }>();
    // The row has to outlive the request: the entries already written to Google
    // need the credential to come back out again.
    expect(row!.status).toBe('disconnecting');
    expect(row!.sync_enabled).toBe(0);
  });

  it('removes future entries, revokes the token, then drops the connection', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1');
    await seedEvent(db, {
      id: 'evt-1',
      organizerId: 'u1',
      startAt: Date.now() + 2 * DAY_MS,
      endAt: Date.now() + 2 * DAY_MS + 3 * HOUR_MS,
    });

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE, REVOKE_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await countRows(db, 'google_event_links')).toBe(1);

    const auth = await authFor(env, 'u1');
    await call(env, '/google', { method: 'DELETE', headers: { Authorization: `Bearer ${auth}` } });
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(await countRows(db, 'google_calendar_connections')).toBe(0);
    expect(await countRows(db, 'google_event_links')).toBe(0);
    expect(fetchStub.calls.some((u) => u.includes('oauth2.googleapis.com/revoke'))).toBe(true);
  });

  it('leaves entries for sessions that already happened', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1', { status: 'disconnecting', syncEnabled: 0 });
    await seedEvent(db, {
      id: 'evt-past',
      organizerId: 'u1',
      startAt: Date.now() - 10 * DAY_MS,
      endAt: Date.now() - 10 * DAY_MS + 3 * HOUR_MS,
    });
    await db
      .prepare(
        `INSERT INTO google_event_links (id, user_id, event_id, occurrence_date, google_event_id,
           synced_title, synced_start_at, synced_end_at, synced_at)
         VALUES ('link-past', 'u1', 'evt-past', '', 'google-past', 'Old Session', ?, ?, ?)`,
      )
      .bind(Date.now() - 10 * DAY_MS, Date.now() - 10 * DAY_MS + 3 * HOUR_MS, Date.now())
      .run();

    fetchStub = stubFetch([TOKEN_RULE, REVOKE_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    // Nothing was deleted at Google: a past session is the person's own record
    // of something that actually happened.
    expect(fetchStub.calls.some((u) => u.includes('/calendar/v3/calendars/'))).toBe(false);
    expect(await countRows(db, 'google_calendar_connections')).toBe(0);
  });
});

describe('erasure and referential integrity', () => {
  it('deleting an account removes the connection and its links, and revokes at Google', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'u1');
    await seedConnection(db, 'u1');
    await seedEvent(db, {
      id: 'evt-1',
      organizerId: 'u1',
      startAt: Date.now() + 2 * DAY_MS,
      endAt: Date.now() + 2 * DAY_MS + 3 * HOUR_MS,
    });

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE, REVOKE_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await countRows(db, 'google_event_links')).toBe(1);

    await deleteUserCompletely(env, 'u1');

    expect(await countRows(db, 'google_calendar_connections')).toBe(0);
    expect(await countRows(db, 'google_event_links')).toBe(0);
    // Deleting our copy is a weaker promise than Google no longer honouring it.
    expect(fetchStub.calls.some((u) => u.includes('oauth2.googleapis.com/revoke'))).toBe(true);
  });

  // google_event_links.event_id is a real FK with no ON DELETE action, and the
  // rows can belong to someone other than the organiser -- so deleting an
  // organiser whose event an invitee syncs would fail on a bare "FOREIGN KEY
  // constraint failed". That is the exact failure shape IDEAS items 38 and 56
  // each cost this project once.
  it("deleting an organiser clears another user's links to their events", async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedMember(db, 'organizer');
    await seedMember(db, 'invitee');
    await seedConnection(db, 'invitee');
    await seedEvent(db, {
      id: 'evt-1',
      organizerId: 'organizer',
      startAt: Date.now() + 2 * DAY_MS,
      endAt: Date.now() + 2 * DAY_MS + 3 * HOUR_MS,
    });
    await seedInvite(db, 'evt-1', 'invitee');

    fetchStub = stubFetch([TOKEN_RULE, INSERT_RULE, REVOKE_RULE]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    expect(await countRows(db, 'google_event_links', "user_id = 'invitee'")).toBe(1);

    await deleteUserCompletely(env, 'organizer');

    expect(await countRows(db, 'events', "id = 'evt-1'")).toBe(0);
    expect(await countRows(db, 'google_event_links')).toBe(0);
    // The invitee themselves survives -- only their link to a deleted event goes.
    expect(await countRows(db, 'users', "id = 'invitee'")).toBe(1);
    expect(await countRows(db, 'google_calendar_connections', "user_id = 'invitee'")).toBe(1);
  });

  // The other place events are deleted: the ninety-day terminal-history purge.
  // Same FK, same failure shape, and this one would surface as a cron sweep
  // that silently stops purging anything at all rather than as a failed
  // request -- runIsolated catches the error and logs it, so the only symptom
  // is a table that quietly stops shrinking.
  it('purging a long-cancelled event clears the links pointing at it', async () => {
    const { db, env } = setup();
    await seedMember(db, 'u1');
    const ancient = Date.now() - 200 * DAY_MS;
    await seedEvent(db, {
      id: 'evt-old',
      organizerId: 'u1',
      status: 'cancelled',
      startAt: ancient,
      endAt: ancient + HOUR_MS,
    });
    await db.prepare(`UPDATE events SET updated_at = ? WHERE id = 'evt-old'`).bind(ancient).run();
    await db
      .prepare(
        `INSERT INTO google_event_links (id, user_id, event_id, occurrence_date, google_event_id,
           synced_title, synced_start_at, synced_end_at, synced_at)
         VALUES ('link-old', 'u1', 'evt-old', '', 'google-old', 'Old', ?, ?, ?)`,
      )
      .bind(ancient, ancient + HOUR_MS, ancient)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    // Google is deliberately unconfigured here, so the sync sweep is inert and
    // this is purely about the purge's referential integrity.
    await runReminderSweep(env);

    expect(await countRows(db, 'events', "id = 'evt-old'")).toBe(0);
    expect(await countRows(db, 'google_event_links')).toBe(0);
  });
});
