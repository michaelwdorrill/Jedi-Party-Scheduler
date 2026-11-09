import { afterEach, describe, expect, it } from 'vitest';
import { seal } from '../src/lib/crypto';
import { sweepGoogleCalendar } from '../src/cron/googleSync';
import { TickBudget } from '../src/cron/budget';
import {
  DAY_MS,
  HOUR_MS,
  seedEvent,
  seedGuild,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

// Pass-19 review (P19-08). The push half inserts into Google and then records
// the mapping under a guard that refuses if the connection's destination or
// credential changed while the insert was in flight (P13-08, P14-06). The
// guard is right. What was missing is what happened to the remote event when
// it fired: nothing. No link row, so the next sweep made a second copy -- and,
// far worse, DISCONNECT could not remove the first, because disconnect
// enumerates google_event_links.
//
// Three places promise removal without qualification: the confirm dialog, the
// disconnecting state, and the Privacy Policy ("Disconnecting also removes the
// upcoming entries this service added to that calendar"). That makes this the
// only finding in the cycle where the product text is falsifiable.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
});

const ENCRYPTION_KEY = 'test-google-encryption-key-at-least-32-chars';

function googleEnv(base: Env): Env {
  return {
    ...base,
    GOOGLE_SYNC_MODE: 'live',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
  };
}

const TOKEN_RULE = {
  match: 'oauth2.googleapis.com/token',
  status: 200,
  body: { access_token: 'google-access-token', refresh_token: 'google-refresh-token', expires_in: 3600 },
};
const REVOKE_RULE = { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} };

async function seedConnection(db: ShimDatabase, userId: string, secret = 'stored-refresh-token'): Promise<void> {
  const sealed = await seal(secret, ENCRYPTION_KEY);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO google_calendar_connections
         (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
          access_token_expires_at, google_account_email, calendar_id, sync_enabled, status,
          last_synced_at, disconnect_attempts, connected_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'someone@gmail.com', 'primary', 1, 'active', NULL, 0, ?, ?)`,
    )
    .bind(userId, sealed.ciphertext, sealed.iv, now, now)
    .run();
}

async function seedSyncable(db: ShimDatabase): Promise<void> {
  await seedGuild(db, 'guild-1');
  await seedUser(db, 'u1');
  await seedMembership(db, 'u1', 'guild-1');
  await seedConnection(db, 'u1');
  await seedEvent(db, {
    id: 'evt-1',
    organizerId: 'u1',
    title: 'Session One',
    startAt: Date.now() + 2 * DAY_MS,
    endAt: Date.now() + 2 * DAY_MS + 3 * HOUR_MS,
  });
}

// The interleaving the finding is about: a same-account reconnect finalizes
// while this insert is in flight, so by the time the mapping statement runs the
// stored credential is a different one and its EXISTS guard refuses.
//
// Driven from the insert response's own `before` hook, which the fetch stub
// already supports. Nothing is forged -- a reconnect really does replace
// refresh_token_ciphertext, and that column really is the guard's test.
function reconnectDuringInsert(db: ShimDatabase): { match: string; status: number; body: unknown; before: () => Promise<void> } {
  let fired = false;
  return {
    match: '/calendar/v3/calendars/',
    status: 200,
    body: { id: 'google-event-orphan' },
    before: async () => {
      if (fired) return;
      fired = true;
      const replacement = await seal('reconnected-refresh-token', ENCRYPTION_KEY);
      await db
        .prepare(
          `UPDATE google_calendar_connections SET refresh_token_ciphertext = ?, refresh_token_iv = ? WHERE user_id = 'u1'`,
        )
        .bind(replacement.ciphertext, replacement.iv)
        .run();
    },
  };
}

describe('a Google event we created is never left untracked (P19-08)', () => {
  it('compensates immediately when the mapping guard refuses the insert', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([TOKEN_RULE, reconnectDuringInsert(db)]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    // The mapping was correctly refused -- that guard must keep working.
    const links = await db
      .prepare(`SELECT COUNT(*) AS n FROM google_event_links WHERE user_id = 'u1'`)
      .first<{ n: number }>();
    expect(links!.n, 'the stale-credential mapping guard stopped working').toBe(0);

    // And the remote event we created was taken back out.
    const deletes = fetchStub.calls.filter(
      (u, i) => u.includes('google-event-orphan') && fetchStub!.bodies[i] === null,
    );
    expect(
      deletes.length,
      'an event this app created in Google was left there with nothing pointing at it',
    ).toBeGreaterThan(0);

    const owed = await db.prepare(`SELECT COUNT(*) AS n FROM google_orphaned_inserts`).first<{ n: number }>();
    expect(owed!.n, 'compensation succeeded, so nothing should still be owed').toBe(0);
  });

  it('records the obligation when the compensating delete fails, and disconnect honours it', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    // The insert succeeds and the compensating DELETE does not. That is the
    // state which has to survive to disconnect, because by then nothing else
    // in the database can reach this event.
    //
    // The delete rule is listed first because stubFetch takes the FIRST
    // matching rule, and its match is the orphan's id, which only appears in
    // the URL of a delete -- an insert POSTs to the calendar collection.
    let deleteShouldFail = true;
    const reconnect = reconnectDuringInsert(db);
    fetchStub = stubFetch([
      TOKEN_RULE,
      REVOKE_RULE,
      { match: 'google-event-orphan', status: 500, body: {} },
      {
        match: '/calendar/v3/calendars/',
        status: 200,
        body: { id: 'google-event-orphan' },
        before: reconnect.before,
      },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const owed = await db
      .prepare(`SELECT google_event_id, calendar_id FROM google_orphaned_inserts WHERE user_id = 'u1'`)
      .all<{ google_event_id: string; calendar_id: string }>();
    expect(
      owed.results.length,
      'the compensating delete failed and nothing recorded that this deletion is still owed',
    ).toBe(1);
    expect(owed.results[0].google_event_id).toBe('google-event-orphan');
    expect(owed.results[0].calendar_id).toBe('primary');

    // Now the user disconnects. The confirm dialog, the disconnecting state
    // and the Privacy Policy all say, without qualification, that the upcoming
    // entries this app added are removed from their calendar.
    deleteShouldFail = false;
    fetchStub.restore();
    fetchStub = stubFetch([
      TOKEN_RULE,
      REVOKE_RULE,
      // 200 rather than Google's real 204: `new Response('', { status: 204 })`
      // is invalid (a null-body status cannot carry one), and the stub always
      // constructs a body. The code path under test only reads `ok`.
      { match: 'google-event-orphan', status: deleteShouldFail ? 500 : 200, body: {} },
      { match: '/calendar/v3/calendars/', status: 200, body: {} },
    ]);
    await db
      .prepare(`UPDATE google_calendar_connections SET status = 'disconnecting' WHERE user_id = 'u1'`)
      .run();
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(
      fetchStub.calls.some((u) => u.includes('google-event-orphan')),
      'disconnect never even asked Google to remove the entry it had created',
    ).toBe(true);
    const stillOwed = await db.prepare(`SELECT COUNT(*) AS n FROM google_orphaned_inserts`).first<{ n: number }>();
    expect(
      stillOwed!.n,
      'disconnect reported success while an entry this app created was still in the calendar',
    ).toBe(0);
  });

  // The control: an ordinary insert, nothing racing it, must still record its
  // mapping and owe nothing. If this fails, sync has stopped working entirely.
  it('records the mapping normally when nothing changes underneath it', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([TOKEN_RULE, { match: '/calendar/v3/calendars/', status: 200, body: { id: 'google-event-1' } }]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const link = await db
      .prepare(`SELECT google_event_id FROM google_event_links WHERE event_id = 'evt-1'`)
      .first<{ google_event_id: string }>();
    expect(link!.google_event_id).toBe('google-event-1');
    const owed = await db.prepare(`SELECT COUNT(*) AS n FROM google_orphaned_inserts`).first<{ n: number }>();
    expect(owed!.n).toBe(0);
  });

  // Pass-20 review (P20-04). The Pass-19 compensation handled the mapping
  // write RETURNING zero changes. It never ran when that write THREW, because
  // the throw left the function before either the compensating delete or the
  // obligation record. Google had already created the event; nothing local
  // knew; the next sweep made a second copy and disconnect reached only that.
  it('still records the obligation when the mapping write throws', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    fetchStub = stubFetch([
      TOKEN_RULE,
      { match: '/calendar/v3/calendars/', status: 200, body: { id: 'google-event-orphan' } },
    ]);

    // One injected failure on the mapping INSERT, after a successful provider
    // response. Not a forged state: it is what a D1 error at that instant does.
    const realPrepare = db.prepare.bind(db);
    let thrown = false;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (!thrown && sql.includes('INSERT INTO google_event_links')) {
        thrown = true;
        return {
          bind: () => ({
            run: async () => {
              throw new Error('D1_ERROR: injected');
            },
          }),
        };
      }
      return realPrepare(sql);
    };

    // The sweep must NOT swallow this -- a failed tick has to look failed.
    await expect(sweepGoogleCalendar(env, new TickBudget('paid'))).rejects.toThrow(/injected/);

    const owed = await db
      .prepare(`SELECT google_event_id, google_account_email FROM google_orphaned_inserts WHERE user_id = 'u1'`)
      .all<{ google_event_id: string; google_account_email: string | null }>();
    expect(
      owed.results.length,
      'Google created the event, the local write failed, and nothing recorded that we owe its removal',
    ).toBe(1);
    expect(owed.results[0].google_event_id).toBe('google-event-orphan');
    expect(owed.results[0].google_account_email).toBe('someone@gmail.com');
  });

  // Pass-20 review (P20-05). An obligation created while account A was
  // connected must not be discharged by asking account B. Google answers 404
  // because the event is not in B -- which is not proof it is gone from A.
  it('does not discharge an obligation by asking a different Google account', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    await db
      .prepare(
        `INSERT INTO google_orphaned_inserts
           (id, user_id, google_event_id, calendar_id, created_at, google_account_email)
         VALUES ('owe-1', 'u1', 'google-event-in-account-a', 'primary', ?, 'account-a@gmail.com')`,
      )
      .bind(Date.now())
      .run();

    // The user is now connected as a DIFFERENT account and disconnects it.
    await db
      .prepare(
        `UPDATE google_calendar_connections
         SET google_account_email = 'account-b@gmail.com', status = 'disconnecting' WHERE user_id = 'u1'`,
      )
      .run();

    fetchStub = stubFetch([
      TOKEN_RULE,
      REVOKE_RULE,
      // Account B genuinely does not have this event.
      { match: 'google-event-in-account-a', status: 404, body: {} },
      { match: '/calendar/v3/calendars/', status: 200, body: {} },
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(
      fetchStub.calls.some((u) => u.includes('google-event-in-account-a')),
      "the wrong account was asked to delete account A's event",
    ).toBe(false);
    const stillOwed = await db
      .prepare(`SELECT COUNT(*) AS n FROM google_orphaned_inserts WHERE id = 'owe-1'`)
      .first<{ n: number }>();
    expect(
      stillOwed!.n,
      'a 404 from an unrelated account was accepted as proof the obligation was discharged',
    ).toBe(1);
  });

  // The control for that scoping: a same-account obligation must still be
  // discharged, or the P19-08 fix has been undone by the P20-05 one.
  it('still discharges an obligation belonging to the account being disconnected', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedSyncable(db);

    await db
      .prepare(
        `INSERT INTO google_orphaned_inserts
           (id, user_id, google_event_id, calendar_id, created_at, google_account_email)
         VALUES ('owe-1', 'u1', 'google-event-owed', 'primary', ?, 'someone@gmail.com')`,
      )
      .bind(Date.now())
      .run();
    await db
      .prepare(`UPDATE google_calendar_connections SET status = 'disconnecting' WHERE user_id = 'u1'`)
      .run();

    fetchStub = stubFetch([
      TOKEN_RULE,
      REVOKE_RULE,
      { match: 'google-event-owed', status: 200, body: {} },
      { match: '/calendar/v3/calendars/', status: 200, body: {} },
    ]);
    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(fetchStub.calls.some((u) => u.includes('google-event-owed'))).toBe(true);
    const stillOwed = await db.prepare(`SELECT COUNT(*) AS n FROM google_orphaned_inserts`).first<{ n: number }>();
    expect(stillOwed!.n).toBe(0);
  });
});
