import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepGoogleCalendar } from '../src/cron/googleSync';
import { runReminderSweep } from '../src/cron/reminders';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { createSession } from '../src/lib/sessions';
import { TickBudget } from '../src/cron/budget';
import { seal } from '../src/lib/crypto';
import { storeConnection } from '../src/lib/googleCalendar';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';
import {
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  membershipRule,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  countRows,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';

// Pass 15 review (September 2026). Two reviewers, eleven findings, and almost
// no overlap between the two reports: A found the Google destination
// regressions this file opens with, B found the rotation tests that the
// coalescing floor had quietly hollowed out.
//
// One describe() per finding, finding id in the title.

const GOOGLE_ENCRYPTION_KEY = 'test-google-encryption-key-at-least-32-chars';

function googleEnv(base: Env): Env {
  return {
    ...base,
    GOOGLE_SYNC_MODE: 'live',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_TOKEN_ENCRYPTION_KEY: GOOGLE_ENCRYPTION_KEY,
  };
}

async function seedConnection(db: ShimDatabase, userId: string, calendarId: string): Promise<void> {
  const sealed = await seal('stored-refresh-token', GOOGLE_ENCRYPTION_KEY);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO google_calendar_connections
         (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
          access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
          last_synced_at, disconnect_attempts, connected_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, 1, 'active', NULL, 0, ?, ?)`,
    )
    .bind(userId, sealed.ciphertext, sealed.iv, `${userId}@gmail.com`, calendarId, now, now)
    .run();
}

async function seedLink(
  db: ShimDatabase,
  opts: { eventId: string; calendarId: string | null; title: string; startAt: number; endAt: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO google_event_links
         (id, user_id, event_id, occurrence_date, google_event_id, calendar_id,
          synced_title, synced_start_at, synced_end_at, synced_at)
       VALUES ('lnk-1', 'u1', ?, '', 'g-1', ?, ?, ?, ?, ?)`,
    )
    .bind(opts.eventId, opts.calendarId, opts.title, opts.startAt, opts.endAt, Date.now())
    .run();
}

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

const TOKEN_RULE = {
  match: 'oauth2.googleapis.com/token',
  status: 200,
  body: { access_token: 'at', expires_in: 3600 },
};

function calendarCalls(stub: FetchStub): string[] {
  return stub.calls.filter((u) => u.includes('/calendar/v3/calendars/'));
}

// ---------------------------------------------------------------------------
// P15-01
// ---------------------------------------------------------------------------

// The push half maintained an entry in the calendar the user STOPPED using,
// and the orphan sweep addressed the calendar they moved to. Two branches
// disagreeing about where one event lives.
describe('a destination change moves the entry rather than maintaining the old one (P15-01)', () => {
  async function seedMovedDestination(db: ShimDatabase, env: Env): Promise<number> {
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1', 'cal-NEW');
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'u1'`).run();

    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'u1',
      title: 'Renamed Session',
      startAt: start,
      endAt: start + 2 * HOUR_MS,
    });
    await seedInvite(db, 'ev-1', 'u1');
    // Written back when the destination was cal-OLD, under the old title.
    await seedLink(db, { eventId: 'ev-1', calendarId: 'cal-OLD', title: 'Old Title', startAt: start, endAt: start + 2 * HOUR_MS });
    return start;
  }

  it('creates the occurrence in the calendar the user actually chose', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedMovedDestination(db, env);

    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: '/calendars/cal-OLD/', status: 200, body: {} },
      { match: '/calendars/cal-NEW/', status: 200, body: { id: 'g-2' } },
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const calls = calendarCalls(fetchStub);
    expect(
      calls.some((u) => u.includes('/calendars/cal-NEW/events')),
      'the newly chosen calendar was never written to',
    ).toBe(true);
    expect(
      calls.some((u) => u.includes('/calendars/cal-OLD/events/g-1')),
      'the entry was left behind in the calendar the user stopped using',
    ).toBe(true);

    const link = await db
      .prepare(`SELECT calendar_id, google_event_id FROM google_event_links WHERE user_id = 'u1'`)
      .first<{ calendar_id: string | null; google_event_id: string }>();
    expect(link!.calendar_id, 'the link still points at the old calendar').toBe('cal-NEW');
    expect(link!.google_event_id).toBe('g-2');
  });

  // An invariant guard, not a reproduction: it passes on the unfixed tree too,
  // for a different reason -- that tree never attempted a removal at all, so
  // "nothing was written to the new calendar" held trivially. It is here
  // because removal-then-insert is the ordering decision this fix rests on,
  // and a later refactor that inserts first would break it silently.
  // Labelled, because an unlabelled guard of exactly this kind is F-42.
  it('keeps the old entry when its removal fails, rather than duplicating it', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedMovedDestination(db, env);

    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: '/calendars/cal-OLD/', status: 500, body: { error: { message: 'backend error' } } },
      { match: '/calendars/cal-NEW/', status: 200, body: { id: 'g-2' } },
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(
      calendarCalls(fetchStub).some((u) => u.includes('/calendars/cal-NEW/')),
      'a copy was created while the original may still exist',
    ).toBe(false);
    const link = await db
      .prepare(`SELECT calendar_id FROM google_event_links WHERE user_id = 'u1'`)
      .first<{ calendar_id: string | null }>();
    expect(link!.calendar_id, 'the pointer to the stranded entry was thrown away').toBe('cal-OLD');
  });

  it('deletes an orphan from the calendar its link records', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1', 'cal-NEW');
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'u1'`).run();

    // A link with no live occurrence behind it any more -- cancelled since --
    // written back when the destination was cal-OLD.
    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, { id: 'ev-1', organizerId: 'u1', title: 'Cancelled', startAt: start, endAt: start + HOUR_MS });
    await seedInvite(db, 'ev-1', 'u1');
    await db.prepare(`UPDATE events SET status = 'cancelled' WHERE id = 'ev-1'`).run();
    await seedLink(db, { eventId: 'ev-1', calendarId: 'cal-OLD', title: 'Cancelled', startAt: start, endAt: start + HOUR_MS });

    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: '/calendars/cal-OLD/', status: 200, body: {} },
      { match: '/calendars/cal-NEW/', status: 200, body: {} },
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const calls = calendarCalls(fetchStub);
    expect(
      calls.some((u) => u.includes('/calendars/cal-OLD/events/g-1')),
      'the cancellation was sent to a calendar the entry was never in',
    ).toBe(true);
    expect(calls.some((u) => u.includes('/calendars/cal-NEW/events/g-1'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P15-03
// ---------------------------------------------------------------------------

// A NULL destination can never equal the connection's calendar, so the
// `unchanged` test never held and the row was re-verified on every tick --
// spending a calendar write each time and starving genuinely new events.
describe('a verified legacy link records what it verified (P15-03)', () => {
  it('goes quiet after one verification instead of re-verifying forever', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedConnection(db, 'u1', 'primary');
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'u1'`).run();

    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'u1',
      title: 'Steady Session',
      startAt: start,
      endAt: start + 2 * HOUR_MS,
    });
    await seedInvite(db, 'ev-1', 'u1');
    // Legacy row: provenance never recorded, title and times already correct.
    await seedLink(db, { eventId: 'ev-1', calendarId: null, title: 'Steady Session', startAt: start, endAt: start + 2 * HOUR_MS });

    fetchStub = stubFetch([TOKEN_RULE, { match: '/calendar/v3/calendars/', status: 200, body: { id: 'g-1' } }]);

    const perTick: number[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const before = calendarCalls(fetchStub).length;
      await db.prepare(`UPDATE google_calendar_connections SET last_synced_at = NULL WHERE user_id = 'u1'`).run();
      await sweepGoogleCalendar(env, new TickBudget('paid'));
      perTick.push(calendarCalls(fetchStub).length - before);
    }

    expect(perTick[0], 'the legacy row was never verified at all').toBe(1);
    expect(
      perTick.slice(1),
      'a settled legacy row kept spending a calendar write on every tick',
    ).toEqual([0, 0]);

    const link = await db
      .prepare(`SELECT calendar_id FROM google_event_links WHERE user_id = 'u1'`)
      .first<{ calendar_id: string | null }>();
    expect(link!.calendar_id, 'the verified destination was not recorded').toBe('primary');
  });
});


// ---------------------------------------------------------------------------
// P15-05 and F-44
// ---------------------------------------------------------------------------

// P14-07 refused a calendar list that FAILED. A list that succeeds and simply
// has no primary entry on it is a different fact -- the client reads one page
// of at most 250 and drops the continuation token -- and it produced a NULL
// account email that finalize stored. `switchingAccount` needs two known
// identities, so the unidentified account inherited the previous account's
// destination and links rather than being treated as a different one.
const app = buildApp();

async function authFor(env: Env, userId: string): Promise<string> {
  const { id: sessionId } = await createSession(env, userId);
  return signJwt(userId, sessionId, env.JWT_SIGNING_KEY);
}

async function beginConnect(env: Env, userId: string): Promise<{ cookie: string; state: string }> {
  const auth = await authFor(env, userId);
  const urlRes = await app.request(
    'https://worker.test/google/connect-url',
    { method: 'POST', headers: { Authorization: `Bearer ${auth}` } },
    env,
  );
  const { startUrl } = await urlRes.json<{ startUrl: string }>();
  const startRes = await app.request(
    `https://worker.test/google/start${new URL(startUrl).search}`,
    { redirect: 'manual' },
    env,
  );
  const raw = startRes.headers.get('set-cookie');
  if (!raw) throw new Error('test fixture: no Set-Cookie on /google/start');
  return {
    cookie: raw.split(';')[0],
    state: new URL(startRes.headers.get('location')!).searchParams.get('state')!,
  };
}

const CONNECT_TOKEN_RULE = {
  match: 'oauth2.googleapis.com/token',
  status: 200,
  body: { access_token: 'google-access-token', refresh_token: 'google-refresh-token', expires_in: 3600 },
};
const REVOKE_RULE = { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} };
// A page of writable calendars with no primary on it -- what a continuation
// token means in practice.
const PAGE_WITHOUT_PRIMARY = {
  match: 'users/me/calendarList?',
  status: 200,
  body: {
    nextPageToken: 'page-2',
    items: [{ id: 'games@group.calendar.google.com', summary: 'Games', accessRole: 'writer' }],
  },
};

describe('an account that could not be identified is not connected (P15-05)', () => {
  async function connectWith(env: Env, rules: Parameters<typeof stubFetch>[0]) {
    const { cookie, state } = await beginConnect(env, 'u1');
    fetchStub = stubFetch(rules);
    return app.request(
      `https://worker.test/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookie }, redirect: 'manual' },
      env,
    );
  }

  it('refuses when the calendar page has no primary and the direct lookup fails too', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');

    const res = await connectWith(env, [
      CONNECT_TOKEN_RULE,
      REVOKE_RULE,
      // Ordered before the page rule: stubFetch matches the first rule whose
      // string appears in the URL, and the page rule would swallow this too.
      { match: 'calendarList/primary', status: 503, body: {} },
      PAGE_WITHOUT_PRIMARY,
    ]);

    expect(res.headers.get('location'), 'an unidentifiable account was parked as connectable').toContain(
      'google=account_unverified',
    );
    expect(await countRows(db, 'google_pending_connections', `1=1`), 'a grant with no identity was parked').toBe(0);
  });

  it('identifies the account directly when the first page does not carry it', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');

    const res = await connectWith(env, [
      CONNECT_TOKEN_RULE,
      REVOKE_RULE,
      { match: 'calendarList/primary', status: 200, body: { id: 'someone@gmail.com', primary: true } },
      PAGE_WITHOUT_PRIMARY,
    ]);

    expect(res.headers.get('location'), 'a perfectly identifiable account was turned away').toContain('google=pending');
    const pending = await db
      .prepare(`SELECT google_account_email FROM google_pending_connections WHERE user_id = 'u1'`)
      .first<{ google_account_email: string | null }>();
    expect(pending!.google_account_email).toBe('someone@gmail.com');
  });

  // F-44. The code has already been exchanged by the time either refusal runs,
  // so a grant exists at Google for a refresh token this request is about to
  // drop. Without the revoke, someone who hits an outage here and never
  // retries keeps the app in their Google connected-apps list forever, for a
  // credential nobody holds.
  it('hands back the grant it just exchanged when it refuses', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');

    await connectWith(env, [
      CONNECT_TOKEN_RULE,
      REVOKE_RULE,
      { match: 'users/me/calendarList', status: 503, body: {} },
    ]);

    const revokes = fetchStub!.calls
      .map((url, i) => ({ url, body: fetchStub!.bodies[i] ?? '' }))
      .filter((c) => c.url.includes('/revoke'));
    expect(revokes, 'the refused grant was abandoned at Google rather than revoked').toHaveLength(1);
    expect(revokes[0].body, 'something other than the abandoned refresh token was revoked').toContain(
      'google-refresh-token',
    );
  });
});


// ---------------------------------------------------------------------------
// P15-07 (the P14-08 narrowing)
// ---------------------------------------------------------------------------

// Revoking at Google kills the grant, not the token, so a same-account
// reconnect landing mid-disconnect had its new credential revoked with the old
// one. IDEAS item 71 called the obvious guard unsafe because of connections
// whose account was never identified; P15-05 closed that door, so the guard is
// now correct in every case it applies to -- and it applies to exactly one.
describe('a same-account reconnect is not revoked by the disconnect it interrupted (P15-07)', () => {
  async function seedDisconnecting(db: ShimDatabase, email: string | null): Promise<void> {
    const sealed = await seal('stored-refresh-token', GOOGLE_ENCRYPTION_KEY);
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO google_calendar_connections
           (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
            access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
            last_synced_at, disconnect_attempts, connected_at, updated_at)
         VALUES ('u1', ?, ?, NULL, NULL, NULL, ?, 'primary', NULL, 0, 'disconnecting', NULL, 0, ?, ?)`,
      )
      .bind(sealed.ciphertext, sealed.iv, email, now, now)
      .run();
  }

  async function runDisconnectWith(
    db: ShimDatabase,
    env: Env,
    reconnectAs: string | null,
  ): Promise<string[]> {
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedDisconnecting(db, 'same@gmail.com');

    // One upcoming entry to clear, so the disconnect has work to do and the
    // reconnect can land in the middle of it. This is the shape the finding
    // describes: a multi-tick disconnect, and a reconnect arriving inside it.
    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, { id: 'ev-1', organizerId: 'u1', startAt: start, endAt: start + HOUR_MS });
    await seedLink(db, { eventId: 'ev-1', calendarId: 'primary', title: 'Session', startAt: start, endAt: start + HOUR_MS });

    // The reconnect has to land WHILE the disconnect is running, which is the
    // whole race. Doing it beforehand proves nothing: storeConnection resets
    // `status` to active, so the sweep would not pick the connection up at all
    // and every assertion below would hold for the wrong reason. The `before`
    // hook suspends the sweep inside a real await -- here, the deletion of the
    // entry it is clearing -- which is where a finalize genuinely can arrive.
    let reconnected = false;
    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
      {
        match: '/calendar/v3/calendars/',
        status: 200,
        body: {},
        before: async () => {
          if (!reconnectAs || reconnected) return;
          reconnected = true;
          await storeConnection(env, 'u1', 'replacement-refresh', 'replacement-access', 3600, reconnectAs, 'primary');
        },
      },
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));
    if (reconnectAs) expect(reconnected, 'the sweep never reached the point the reconnect models').toBe(true);
    return fetchStub.bodies.filter((_, i) => fetchStub!.calls[i].includes('/revoke')).map((b) => b ?? '');
  }

  it('skips the revoke when the same account has reconnected', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    const revokes = await runDisconnectWith(db, env, 'same@gmail.com');

    expect(revokes, "the reconnection's own grant was revoked with the one being discarded").toHaveLength(0);
    const conn = await db
      .prepare(`SELECT status FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ status: string }>();
    expect(conn!.status, 'the replacement connection was dropped').toBe('active');
  });

  // The next two are invariant guards, not reproductions: they pass with and
  // without the narrowing, because the unfixed code revoked unconditionally
  // and so satisfied them by accident. They are here because the risk this
  // change carries is over-skipping -- a grant left alive that the Privacy
  // Policy promises to tear down -- and these are the two shapes that must
  // never be skipped.
  it('still revokes an ordinary disconnect that nobody interrupted', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    const revokes = await runDisconnectWith(db, env, null);

    expect(revokes, 'an ordinary disconnect stopped revoking').toHaveLength(1);
    expect(revokes[0]).toContain('stored-refresh-token');
  });

  it('still revokes when the replacement is a different account', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    // storeConnection revokes the predecessor itself on an account switch, so
    // this is belt-and-braces -- but skipping here on an account we cannot
    // prove is the same one is exactly what item 71 refused to do.
    const revokes = await runDisconnectWith(db, env, 'someone-else@gmail.com');

    expect(revokes.length, "a different account's grant was left alive").toBeGreaterThanOrEqual(1);
  });
});


// ---------------------------------------------------------------------------
// P15-04
// ---------------------------------------------------------------------------

// P14-06 taught the push half that a calendar name does not identify a source:
// every Google account has a `primary`, so two accounts' destinations compare
// equal and only the credential tells them apart. The pull half, two hundred
// lines below in the same file and touched in the same commit, kept comparing
// only the name.
describe('an import cannot be credited to the account that replaced its source (P15-04)', () => {
  async function seedReadingConnection(db: ShimDatabase, calendarId: string): Promise<void> {
    const sealed = await seal('stored-refresh-token', GOOGLE_ENCRYPTION_KEY);
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO google_calendar_connections
           (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
            access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
            last_synced_at, disconnect_attempts, connected_at, updated_at)
         VALUES ('u1', ?, ?, NULL, NULL, NULL, 'a@gmail.com', 'primary', ?, 1, 'active', NULL, 0, ?, ?)`,
      )
      .bind(sealed.ciphertext, sealed.iv, calendarId, now, now)
      .run();
  }

  async function seedUserWithGuild(db: ShimDatabase): Promise<void> {
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'u1'`).run();
  }

  it("does not import one account's events under the account that replaced it", async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedUserWithGuild(db);
    await seedReadingConnection(db, 'primary');

    const start = Date.now() + 2 * DAY_MS;
    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
      {
        // The read of account A's calendar. Account B is connected while it is
        // in flight and picks the same calendar name -- which it genuinely
        // might, since `primary` is whatever account you are signed in as.
        match: '/events?',
        status: 200,
        body: {
          timeZone: 'UTC',
          items: [
            {
              id: 'g-private-1',
              summary: 'Account A private meeting',
              start: { dateTime: new Date(start).toISOString() },
              end: { dateTime: new Date(start + HOUR_MS).toISOString() },
            },
          ],
        },
        before: async () => {
          await storeConnection(env, 'u1', 'account-b-refresh', 'account-b-access', 3600, 'b@gmail.com', 'primary');
          await db.prepare(`UPDATE google_calendar_connections SET read_calendar_id = 'primary' WHERE user_id = 'u1'`).run();
        },
      },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(
      await countRows(db, 'personal_events', `user_id = 'u1' AND google_event_id = 'g-private-1'`),
      "an event read from the account the user left was imported under the account they connected",
    ).toBe(0);
  });

  it("does not let one account's read failure clear the account that replaced it", async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedUserWithGuild(db);
    await seedReadingConnection(db, 'primary');

    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
      {
        match: '/events?',
        status: 404,
        body: { error: { message: 'Not Found' } },
        before: async () => {
          await storeConnection(env, 'u1', 'account-b-refresh', 'account-b-access', 3600, 'b@gmail.com', 'primary');
          await db.prepare(`UPDATE google_calendar_connections SET read_calendar_id = 'primary' WHERE user_id = 'u1'`).run();
        },
      },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const conn = await db
      .prepare(`SELECT read_calendar_id, google_account_email FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ read_calendar_id: string | null; google_account_email: string }>();
    expect(conn!.google_account_email, 'the test never reached the replacement connection').toBe('b@gmail.com');
    expect(
      conn!.read_calendar_id,
      "the new account's freshly made choice was cleared by the old account's failure",
    ).toBe('primary');
  });
});


// ---------------------------------------------------------------------------
// F-43
// ---------------------------------------------------------------------------

// The fourth instance of one pattern in four passes: an id carried forward to
// a DM without a live access check. P12-01 was recipient selection, P13-03
// message editing, P14-01 the decision notice -- and each time the organizer's
// own sweeps were left alone, because the organizer is the one recipient who
// is "obviously" entitled to their own event.
describe('an organizer who left the server stops receiving RSVP notices (F-43)', () => {
  async function seedAnsweredEvent(db: ShimDatabase): Promise<void> {
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'organizer');
    await seedUser(db, 'responder');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'responder', 'guild-1');
    await db.prepare(`UPDATE users SET dm_channel_id = 'dm-organizer' WHERE id = 'organizer'`).run();

    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'organizer',
      title: 'Thursday Raid -- private',
      startAt: start,
      endAt: start + 2 * HOUR_MS,
    });
    await seedInvite(db, 'ev-1', 'responder');
    await db
      .prepare(
        `INSERT INTO event_attendance (id, event_id, user_id, occurrence_date, rsvp_status, responded_at)
         VALUES ('att-1', 'ev-1', 'responder', '', 'accepted', ?)`,
      )
      .bind(Date.now())
      .run();
  }

  it('sends nothing once their membership is gone', async () => {
    const { db, env } = setup('paid');
    await seedAnsweredEvent(db);
    await db
      .prepare(`UPDATE user_guild_membership SET is_member = 0 WHERE user_id = 'organizer' AND guild_id = 'guild-1'`)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const toOrganizer = fetchStub.calls
      .map((url, i) => ({ url, body: fetchStub!.bodies[i] ?? '' }))
      .filter((c) => c.url.includes('dm-organizer'))
      .map((c) => c.body)
      .join(' ');
    expect(
      toOrganizer,
      'a departed organizer was told who answered, for an event they can no longer open',
    ).not.toContain('responder');
    expect(await countRows(db, 'organizer_rsvp_notice_log', `organizer_id = 'organizer'`)).toBe(0);
  });

  it('still tells an organizer who is still in the server', async () => {
    const { db, env } = setup('paid');
    await seedAnsweredEvent(db);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    expect(
      await countRows(db, 'organizer_rsvp_notice_log', `organizer_id = 'organizer'`),
      'a current organizer stopped hearing about RSVPs to their own event',
    ).toBe(1);
  });
});
