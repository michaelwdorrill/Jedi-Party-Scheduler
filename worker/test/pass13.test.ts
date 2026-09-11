import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSession,
  isSessionActive,
  pruneStaleSessions,
  revokeSession,
  rotateSession,
} from '../src/lib/sessions';
import { runReminderSweep } from '../src/cron/reminders';
import { sweepGoogleCalendar } from '../src/cron/googleSync';
import { TickBudget } from '../src/cron/budget';
import { seal } from '../src/lib/crypto';
import { accessTokenFor, type GoogleConnectionRow, storeConnection } from '../src/lib/googleCalendar';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';
import {
  countRows,
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  membershipRule,
  seedEvent,
  seedGuild,
  seedInvite,
  seedMembership,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';

// Pass 13 review (September 2026). Two independent reviewers re-read the
// Pass-12 corrections; fifteen distinct findings, all verified real. Five were
// regressions introduced by those corrections, which is what this file mostly
// pins. One describe() per finding, finding id in the title.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// P13-01
// ---------------------------------------------------------------------------

// rotateSession read the row, checked revocation and expiry against it, and
// then ran a claim guarded only by `superseded_at IS NULL`. Logout landing
// between the two revoked the family, the claim still won on the revoked row,
// and the successor was inserted with revoked_at NULL -- an active session
// minted after logout had already returned.
describe('rotation cannot mint a successor after logout has completed (P13-01)', () => {
  it('refuses to rotate when logout lands between the read and the claim', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: original } = await createSession(env, 'u1');

    // The real interleaving. rotateSession reads the row, then runs its claim
    // as a batch; logout completing in that window is exactly the case the
    // read-time checks cannot see. Revoking just before the batch delegates
    // puts the logout precisely there.
    let interleaved = false;
    const racing = {
      ...db,
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: unknown[]) => {
        if (!interleaved) {
          interleaved = true;
          await revokeSession(env, original);
        }
        return db.batch(statements as never);
      },
    };

    const successor = await rotateSession({ ...env, DB: racing } as never, original, 'u1');

    expect(interleaved, 'the test did not actually reach the claim').toBe(true);
    expect(successor, 'a successor was minted after logout completed').toBeNull();
    expect(await countRows(db, 'sessions', `user_id = 'u1' AND revoked_at IS NULL`)).toBe(0);
  });

  it('does not hand back a successor that has itself been revoked', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: original } = await createSession(env, 'u1');
    const successor = await rotateSession(env, original, 'u1');
    expect(successor).not.toBeNull();

    // Only the successor row, so the predecessor stays usable and the grace
    // branch is the thing under test rather than the read-time check.
    await db.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`).bind(Date.now(), successor!).run();

    expect(await rotateSession(env, original, 'u1'), 'a revoked successor was handed back').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P13-02
// ---------------------------------------------------------------------------

// The family mechanism resolves a lineage by reading the row whose token was
// presented. Pruning deleted superseded rows once the rotation grace passed,
// so logging out with an intermediate token found no row, fell back to
// treating that id as its own family, matched no descendant, revoked nothing
// and returned success.
//
// A ROOT token happens to work, because its id equals its family id. Testing
// only a root token is what let this through in the first place.
describe('logout still revokes the family after pruning (P13-02)', () => {
  it('revokes the lineage when the token presented is a pruned intermediate', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: root } = await createSession(env, 'u1');
    const intermediate = await rotateSession(env, root, 'u1');
    const current = await rotateSession(env, intermediate!, 'u1');
    expect(current).not.toBeNull();

    // Two minutes on, well past the 60-second rotation grace, and a prune runs.
    vi.setSystemTime(base + 2 * 60 * 1000);
    await pruneStaleSessions(env);

    // The user logs out from the tab still holding the intermediate token.
    await revokeSession(env, intermediate!);

    expect(await isSessionActive(env, current!, 'u1'), 'the live successor survived logout').toBe(false);
  });

  it('keeps the id-to-family mapping alive rather than deleting it', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: root } = await createSession(env, 'u1');
    await rotateSession(env, root, 'u1');

    vi.setSystemTime(base + 2 * 60 * 1000);
    await pruneStaleSessions(env);

    expect(await countRows(db, 'sessions', `id = ?`, root)).toBe(1);
  });

  it('still removes superseded rows once they actually expire', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: root } = await createSession(env, 'u1');
    await rotateSession(env, root, 'u1');

    // Past the absolute seven-day session lifetime.
    vi.setSystemTime(base + 8 * 24 * 60 * 60 * 1000);
    await pruneStaleSessions(env);

    expect(await countRows(db, 'sessions', `user_id = 'u1'`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-36
// ---------------------------------------------------------------------------

// createSession's cap deleted everything outside the twenty newest rows by
// created_at, regardless of state. Once every refresh inserts a row -- and
// especially once P13-02 keeps the superseded ones -- a person with a few
// devices open can push live successors out of that window, so logging in
// somewhere new silently logs them out somewhere else.
describe('the session cap counts sign-ins, not rotation rows (F-36)', () => {
  it('does not evict a live session because another device refreshed a lot', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');

    // One device, signed in and refreshing steadily.
    const { id: phone } = await createSession(env, 'u1');
    let current = phone;
    for (let i = 0; i < 30; i++) {
      const next = await rotateSession(env, current, 'u1');
      expect(next).not.toBeNull();
      current = next!;
    }

    // A second device signs in, which is what runs the cap.
    await createSession(env, 'u1');

    expect(await isSessionActive(env, current, 'u1'), 'the first device was silently logged out').toBe(true);
  });

  it('still caps the number of live sign-ins', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    for (let i = 0; i < 25; i++) await createSession(env, 'u1');

    expect(await countRows(db, 'sessions', `user_id = 'u1' AND superseded_at IS NULL AND revoked_at IS NULL`)).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// P13-03
// ---------------------------------------------------------------------------

// P12-01 put a current-access predicate into recipient selection.
// editSettledPollDms does not use it: it selects previously delivered invite
// DMs straight from notification_log joined to users. Editing looked harmless
// because it is not a resend -- but the edit rewrites the body with the poll's
// CURRENT title and its settled time, so a removed invitee's DM receives
// private content created after their access ended.
describe('settling a poll does not edit new content into a removed invitee DM (P13-03)', () => {
  it('leaves the removed invitee message alone and still updates the others', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'stays');
    await seedUser(db, 'dropped');
    for (const uid of ['organizer', 'stays', 'dropped']) await seedMembership(db, uid, 'guild-1');

    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, {
      id: 'poll-1',
      organizerId: 'organizer',
      title: 'Secret Ops Night',
      eventType: 'poll',
      startAt: null,
      endAt: null,
    });
    await db
      .prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
         VALUES ('opt-1', 'poll-1', ?, ?, 0)`,
      )
      .bind(start, start + 2 * HOUR_MS)
      .run();
    await db
      .prepare(`UPDATE events SET poll_deadline_at = ?, poll_strategy = 'most_votes' WHERE id = 'poll-1'`)
      .bind(Date.now() - HOUR_MS)
      .run();

    // Everyone was invited and everyone has a delivered invite DM carrying the
    // vote control, which is what the edit path rewrites.
    const now = Date.now();
    for (const uid of ['stays', 'dropped']) {
      await seedInvite(db, 'poll-1', uid);
      await db
        .prepare(
          `INSERT INTO notification_log
             (id, user_id, event_id, notification_type, occurrence_date, sent_at, delivered_at, message_id, content)
           VALUES (?, ?, 'poll-1', 'invite', '', ?, ?, ?, 'the original invite')`,
        )
        .bind(`nl-${uid}`, uid, now, now, `msg-${uid}`)
        .run();
      await db.prepare(`UPDATE users SET dm_channel_id = ? WHERE id = ?`).bind(`dm-${uid}`, uid).run();
      await db
        .prepare(
          `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES ('opt-1', ?, 'yes', ?)`,
        )
        .bind(uid, now)
        .run();
    }

    // The organizer drops one of them, then renames the poll before it settles.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM event_invites WHERE event_id = 'poll-1' AND user_id = 'dropped'`),
      env.DB.prepare(`DELETE FROM event_attendance WHERE event_id = 'poll-1' AND user_id = 'dropped'`),
    ]);
    await db.prepare(`UPDATE events SET title = 'Raid on the Vault -- moved' WHERE id = 'poll-1'`).run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200), { match: '/messages/', status: 200, body: {} }]);
    await runReminderSweep(env);

    const dropped = await db
      .prepare(`SELECT message_edited_at FROM notification_log WHERE id = 'nl-dropped'`)
      .first<{ message_edited_at: number | null }>();
    expect(dropped!.message_edited_at, "a removed invitee's DM was rewritten with the new title").toBeNull();

    // And the check has to be about access, not about switching editing off.
    const stays = await db
      .prepare(`SELECT message_edited_at FROM notification_log WHERE id = 'nl-stays'`)
      .first<{ message_edited_at: number | null }>();
    expect(stays!.message_edited_at, 'a current invitee stopped receiving the settled update').not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P13-12 / F-35
// ---------------------------------------------------------------------------

// The sibling of R09's notification_log gap, in the other retry consumer. Its
// comment said group membership was the check; the query never made it. Named
// in Pass 12 as F-30 and lost when the two reports were reconciled, so it is
// being fixed a pass later than it should have been.
describe('a queued group nudge does not reach a removed member (P13-12)', () => {
  it('withholds the retry once the person is out of the group', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'owner');
    await seedUser(db, 'dropped');
    await seedMembership(db, 'owner', 'guild-1');
    await seedMembership(db, 'dropped', 'guild-1');
    await db.prepare(`UPDATE users SET dm_channel_id = 'dm-dropped' WHERE id = 'dropped'`).run();

    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO groups (id, name, idle_reminder_days, created_by, created_at) VALUES ('grp-1', 'The Crew', 2, 'owner', ?)`,
      )
      .bind(now)
      .run();
    for (const uid of ['owner', 'dropped']) {
      await db
        .prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp-1', ?, ?)`)
        .bind(uid, now)
        .run();
    }

    // A nudge that failed once and is queued for retry.
    await db
      .prepare(
        `INSERT INTO group_nudge_log (id, group_id, user_id, last_event_at, sent_at, attempt_count, next_attempt_at, content)
         VALUES ('gn-1', 'grp-1', 'dropped', 1000, ?, 1, ?, 'The Crew has not played in a while')`,
      )
      .bind(now - HOUR_MS, now - 60_000)
      .run();

    // The owner removes them from the group before the retry runs.
    await db.prepare(`DELETE FROM group_members WHERE group_id = 'grp-1' AND user_id = 'dropped'`).run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT delivered_at FROM group_nudge_log WHERE id = 'gn-1'`)
      .first<{ delivered_at: number | null }>();
    expect(row!.delivered_at, 'a queued nudge was delivered after the member was removed').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P13-04 / P13-07 / P13-08
// ---------------------------------------------------------------------------

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

async function seedGoogleConnection(
  db: ShimDatabase,
  userId: string,
  overrides: { status?: string; calendarId?: string; token?: string } = {},
): Promise<void> {
  const sealed = await seal(overrides.token ?? 'stored-refresh-token', GOOGLE_ENCRYPTION_KEY);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO google_calendar_connections
         (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
          access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
          last_synced_at, disconnect_attempts, connected_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, 1, ?, NULL, 0, ?, ?)`,
    )
    .bind(
      userId,
      sealed.ciphertext,
      sealed.iv,
      `${userId}@gmail.com`,
      overrides.calendarId ?? 'primary',
      overrides.status ?? 'active',
      now,
      now,
    )
    .run();
}

// runDisconnect's budget exit happened before the attempt counter, and
// `status = 'disconnecting'` sorts ahead of every active connection. A
// disconnect whose deletes are refused therefore made no progress, recorded no
// attempt, and took the single per-tick slot again forever -- never revoking
// the grant it was supposed to release, and never letting anyone else sync.
describe('a refused disconnect still makes bookkeeping progress (P13-04)', () => {
  it('counts attempts and eventually releases the connection', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'stuck');
    await seedGoogleConnection(db, 'stuck', { status: 'disconnecting' });

    // More mapped future entries than one tick's write allowance, against a
    // calendar that refuses every delete.
    const now = Date.now();
    await seedGuild(db);
    await seedMembership(db, 'stuck', 'guild-1');
    for (let i = 0; i < 27; i++) {
      await seedEvent(db, {
        id: `ev-${i}`,
        organizerId: 'stuck',
        startAt: now + DAY_MS,
        endAt: now + DAY_MS + HOUR_MS,
      });
      await db
        .prepare(
          `INSERT INTO google_event_links
             (id, user_id, event_id, occurrence_date, google_event_id, synced_title, synced_start_at, synced_end_at,
              synced_at, calendar_id)
           VALUES (?, 'stuck', ?, '', ?, 'Session', ?, ?, ?, 'primary')`,
        )
        .bind(`link-${i}`, `ev-${i}`, `g-${i}`, now + DAY_MS, now + DAY_MS + HOUR_MS, now)
        .run();
    }

    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'at', expires_in: 3600 } },
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
      { match: '/calendar/v3/calendars/', status: 403, body: { error: { message: 'no access' } } },
    ]);

    for (let tick = 0; tick < 6; tick++) {
      await sweepGoogleCalendar(env, new TickBudget('free'));
    }

    // Either it gave up and dropped the connection, or it is still counting
    // towards doing so -- what it must never do is sit at zero forever.
    const row = await db
      .prepare(`SELECT disconnect_attempts FROM google_calendar_connections WHERE user_id = 'stuck'`)
      .first<{ disconnect_attempts: number }>();
    if (row) {
      expect(row.disconnect_attempts, 'six sweeps recorded no disconnect attempt at all').toBeGreaterThan(0);
    } else {
      expect(await countRows(db, 'google_calendar_connections', `user_id = 'stuck'`)).toBe(0);
    }
  });
});

// markUnauthorized keyed on user_id alone, so a stale invalid_grant belonging
// to the account the user just left disabled the one they just connected.
describe('a stale Google failure cannot disable the replacement connection (P13-07)', () => {
  it('leaves a reconnected account enabled when the old grant reports failure', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'u1');
    await seedGoogleConnection(db, 'u1', { token: 'account-a-refresh' });

    // The snapshot an in-flight sweep holds for account A.
    const stale = await db
      .prepare(`SELECT * FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<GoogleConnectionRow>();

    // The user connects account B while that refresh is away.
    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'account-b-refresh', 'account-b-access', 3600, 'b@gmail.com', 'primary');
    fetchStub.restore();

    // A's refresh comes back dead.
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 400, body: { error: 'invalid_grant' } },
    ]);
    const result = await accessTokenFor(env, stale!);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'unauthorized') {
      await sweepGoogleCalendar(env, new TickBudget('paid'));
    }

    const row = await db
      .prepare(`SELECT sync_enabled, google_account_email FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ sync_enabled: number; google_account_email: string }>();
    expect(row!.google_account_email).toBe('b@gmail.com');
    expect(row!.sync_enabled, "the old account's failure disabled the new connection").toBe(1);
  });
});

// /google/finalize passes the literal 'primary', and storeConnection
// overwrote calendar_id unconditionally -- so reconnecting the same account
// silently moved the write destination back to primary while every existing
// mapping still pointed at the calendar the user had chosen.
describe('a same-account reconnect keeps the chosen write calendar (P13-08)', () => {
  it('does not silently reset the destination to primary', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'u1');
    await seedGoogleConnection(db, 'u1', { calendarId: 'games@group.calendar.google.com' });

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'new-refresh', 'new-access', 3600, 'u1@gmail.com', 'primary');

    const row = await db
      .prepare(`SELECT calendar_id FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ calendar_id: string }>();
    expect(row!.calendar_id, 'reconnecting reset the write calendar').toBe('games@group.calendar.google.com');
  });

  it('still moves the destination when the account actually changes', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'u1');
    await seedGoogleConnection(db, 'u1', { calendarId: 'games@group.calendar.google.com' });

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'new-refresh', 'new-access', 3600, 'someone-else@gmail.com', 'primary');

    const row = await db
      .prepare(`SELECT calendar_id FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ calendar_id: string }>();
    expect(row!.calendar_id).toBe('primary');
  });
});
