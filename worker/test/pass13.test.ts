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
import { resolvePastDeadlineChangeRequests } from '../src/lib/changeRequests';
import { addInvitesToEvent } from '../src/lib/eventWrites';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { expandOccurrences } from '../src/lib/recurrence';
import type { Env } from '../src/env';
import { D1_FREE_PLAN_QUERY_BUDGET, type ShimDatabase } from './d1shim';
import {
  ageSession,
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
    await ageSession(db, original);

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

// ---------------------------------------------------------------------------
// P13-05 / P13-11
// ---------------------------------------------------------------------------

// The resolver priced every request at three statements. An accepted,
// date-moving one-off costs six: the tally, the event lookup, the acceptance
// claim P12-18 added, and updateEvent's own batch of three. Six such requests
// in one tick measured 65 real statements against a documented Free-plan
// ceiling of 50, while the ledger reported itself well inside.
describe('a tick of ordinary accepted change requests stays in budget (P13-05)', () => {
  const REQUEST_COUNT = 6;

  async function seedDueRequests(db: ShimDatabase, base: number): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    for (let v = 0; v < 4; v++) {
      await seedUser(db, `voter-${v}`);
      await seedMembership(db, `voter-${v}`, 'guild-1');
    }

    for (let i = 0; i < REQUEST_COUNT; i++) {
      const id = `ev-${i}`;
      await seedEvent(db, {
        id,
        organizerId: 'organizer',
        startAt: base + (i + 2) * DAY_MS,
        endAt: base + (i + 2) * DAY_MS + 2 * HOUR_MS,
      });
      for (let v = 0; v < 4; v++) await seedInvite(db, id, `voter-${v}`);

      const event = await db.prepare(`SELECT revision FROM events WHERE id = ?`).bind(id).first<{ revision: number }>();
      await db
        .prepare(
          `INSERT INTO event_change_requests
             (id, event_id, requester_id, kind, proposed_start_at, proposed_end_at, occurrence_date,
              status, event_revision, message, created_at, vote_deadline_at)
           VALUES (?, ?, 'voter-0', 'time_change', ?, ?, '', 'pending', ?, 'an hour later?', ?, ?)`,
        )
        .bind(
          `cr-${i}`,
          id,
          base + (i + 2) * DAY_MS + HOUR_MS,
          base + (i + 2) * DAY_MS + 3 * HOUR_MS,
          event!.revision,
          base - DAY_MS,
          base - HOUR_MS,
        )
        .run();
      // One yes, no noes: below an open-vote majority but a win at the deadline.
      await db
        .prepare(
          `INSERT INTO event_change_request_votes (request_id, user_id, vote, voted_at) VALUES (?, 'voter-0', 'yes', ?)`,
        )
        .bind(`cr-${i}`, base - 2 * HOUR_MS)
        .run();
    }
  }

  it('measures actual statements for six legitimate deadline decisions', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedDueRequests(db, base);
    // Notifications off, so what is measured is the decision work alone.
    await db.prepare(`UPDATE users SET notifications_enabled = 0`).run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    db.resetQueryCount();
    await runReminderSweep(env);
    expect(db.queryCount).toBeLessThanOrEqual(D1_FREE_PLAN_QUERY_BUDGET);
  });

  // P13-11. The claim and the event mutation are separate transactions, and
  // the compensating release is itself a write -- so a tick that ran out
  // between them left a request permanently 'accepted' over an event that
  // never moved, invisible to the resolver because it is no longer pending.
  //
  // This is an INVARIANT GUARD, not a reproduction: it passes before the fix
  // as well as after, and saying so matters more than the green tick.
  //
  // The reason is worth recording. updateEvent never consults the WorkBudget
  // at all, so the ledger cannot strand a claim part-way -- once the claim
  // lands, the apply runs regardless of what the ledger thinks is left. The
  // stranding reviewer A demonstrated needs the platform's HARD statement
  // cutoff, which this adapter does not enforce.
  //
  // So the reservation added here does not close P13-11 directly. What it
  // does is keep the tick inside the documented allowance (P13-05), which is
  // the thing that would cause the hard cutoff in the first place. The
  // non-atomicity itself is still there and is recorded as IDEAS item 70.
  // This guard exists so that if the acceptance path ever does become
  // budget-gated, the boundary is already being walked.
  it('never claims an acceptance it cannot afford to finish', async () => {
    for (let allowance = 0; allowance < 20; allowance++) {
      vi.useFakeTimers();
      const base = Date.UTC(2026, 8, 10, 12, 0, 0);
      vi.setSystemTime(base);

      const { db, env } = setup();
      await seedDueRequests(db, base);

      let remaining = allowance;
      await resolvePastDeadlineChangeRequests(env, {
        trySpend: (n: number) => {
          if (remaining < n) return false;
          remaining -= n;
          return true;
        },
      });

      const { results: accepted } = await db
        .prepare(
          `SELECT cr.id, cr.proposed_start_at, e.start_at
           FROM event_change_requests cr JOIN events e ON e.id = cr.event_id
           WHERE cr.status = 'accepted'`,
        )
        .all<{ id: string; proposed_start_at: number; start_at: number }>();

      for (const row of accepted) {
        expect(
          row.start_at,
          `with an allowance of ${allowance}: ${row.id} is accepted but its event never moved`,
        ).toBe(row.proposed_start_at);
      }
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// P13-09 / P13-10
// ---------------------------------------------------------------------------

// P12-12 bounded the invite cap with `LIMIT MAX(0, cap - count)` on an
// INSERT ... SELECT. SQLite applies a LIMIT to the SELECT, before ON CONFLICT
// discards anything -- so an already-invited candidate consumed the one
// available row and was then dropped, and the genuinely new person was never
// considered. 200 returned, nobody added, no concurrency involved.
describe('an invite request near the cap still admits the new people (P13-09)', () => {
  async function seedNearCap(db: ShimDatabase, existingCount: number): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer' });
    for (let i = 0; i < 30; i++) {
      const uid = `guest-${String(i).padStart(2, '0')}`;
      await seedUser(db, uid);
      await seedMembership(db, uid, 'guild-1');
    }
    for (let i = 0; i < existingCount; i++) await seedInvite(db, 'ev-1', `guest-${String(i).padStart(2, '0')}`);
  }

  it('adds the new invitee when the request also names an existing one', async () => {
    const { db, env } = setup();
    await seedNearCap(db, 24);

    // 24 of 25 taken. The request names one person already on the event and
    // one who is not -- the deduplicated union is exactly 25, so it fits.
    const result = await addInvitesToEvent(
      env,
      'ev-1',
      'guild-1',
      ['guest-00', 'guest-24'],
      [],
      'organizer',
    );

    expect(await countRows(db, 'event_invites', `event_id = 'ev-1' AND user_id = 'guest-24'`), 'the new invitee was silently dropped').toBe(1);
    expect(await countRows(db, 'event_invites', `event_id = 'ev-1'`)).toBe(25);
    expect(result.notAdded).toEqual([]);
  });

  it('reports who did not make it rather than claiming success', async () => {
    const { db, env } = setup();
    await seedNearCap(db, 23);

    // Two concurrent additions at the boundary. The cap must hold, and
    // whichever request loses capacity has to say so.
    const [a, b] = await Promise.all([
      addInvitesToEvent(env, 'ev-1', 'guild-1', ['guest-23'], [], 'organizer').catch(() => null),
      addInvitesToEvent(env, 'ev-1', 'guild-1', ['guest-24', 'guest-25'], [], 'organizer').catch(() => null),
    ]);

    const total = await countRows(db, 'event_invites', `event_id = 'ev-1'`);
    expect(total).toBeLessThanOrEqual(25);

    const requested = 3;
    const admitted = total - 23;
    const reported = (a?.notAdded.length ?? 0) + (b?.notAdded.length ?? 0);
    expect(reported, 'people were dropped without the caller being told').toBe(requested - admitted);
  });
});

// The group cap was a read-then-act check, so two additions in flight together
// both validated the same 24-member roster and both inserted.
//
// INVARIANT GUARD, not a reproduction, and worth saying so. Under this
// adapter the two requests serialise -- SQLite is synchronous behind the
// async wrapper, so the second one's preflight already sees the first one's
// insert and refuses at 400. The test therefore passes with or without the
// fix. It is kept because the property it asserts (the roster never exceeds
// its cap, whatever the interleaving) is the one that matters, and because
// the guard now lives in the write where a real interleaving cannot get past
// it. Reviewer A reproduced the 26-member outcome with genuine concurrency.
describe('the group roster cap holds in the write (P13-10)', () => {
  it('never exceeds the cap however the additions interleave', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'owner');
    await seedMembership(db, 'owner', 'guild-1');
    const now = Date.now();
    await db
      .prepare(`INSERT INTO groups (id, name, idle_reminder_days, created_by, created_at) VALUES ('g1', 'Crew', 2, 'owner', ?)`)
      .bind(now)
      .run();
    await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('g1', 'owner', ?)`).bind(now).run();
    for (let i = 0; i < 23; i++) {
      const uid = `m-${String(i).padStart(2, '0')}`;
      await seedUser(db, uid);
      await seedMembership(db, uid, 'guild-1');
      await db.prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('g1', ?, ?)`).bind(uid, now).run();
    }
    for (const uid of ['late-a', 'late-b']) {
      await seedUser(db, uid);
      await seedMembership(db, uid, 'guild-1');
    }

    const app = buildApp();
    const token = await signJwt('owner', (await createSession(env, 'owner')).id, env.JWT_SIGNING_KEY);
    const add = (uid: string) =>
      app.request(
        'https://worker.test/groups/g1/members',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: uid }),
        },
        env,
      );

    await Promise.all([add('late-a'), add('late-b')]);

    expect(await countRows(db, 'group_members', `group_id = 'g1'`), 'the roster went past its cap').toBeLessThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// P13-13
// ---------------------------------------------------------------------------

// deliverThroughOutbox sets next_attempt_at to NULL when it claims a row, and
// a failed delivery is what writes the real retry time back. Interrupt
// execution between those two and the lease expires with no retry timestamp at
// all -- and the retry consumer required a non-null one, so the row became
// invisible to it. Once the source event leaves its notification window the
// producer cannot recreate it either. One notification, stranded permanently,
// with its content sitting right there on the row.
describe('an abandoned outbox claim is picked up again (P13-13)', () => {
  it('retries a row whose lease expired before its retry time was recorded', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'guest');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'guest', 'guild-1');
    await db.prepare(`UPDATE users SET dm_channel_id = 'dm-guest' WHERE id = 'guest'`).run();

    // An event whose own notification window is long past, so nothing will
    // ever re-derive this obligation.
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'organizer',
      startAt: base - 10 * DAY_MS,
      endAt: base - 10 * DAY_MS + HOUR_MS,
    });
    await seedInvite(db, 'ev-1', 'guest');

    // Exactly the state an interrupted delivery leaves: claimed, lease long
    // expired, attempt recorded, content captured -- and no retry time,
    // because the write that would have set one never ran.
    await db
      .prepare(
        `INSERT INTO notification_log
           (id, user_id, event_id, notification_type, occurrence_date, sent_at, attempt_count,
            claim_token, claimed_until, next_attempt_at, content)
         VALUES ('nl-1', 'guest', 'ev-1', 'reminder_1h', '', ?, 1, 'tok', ?, NULL, 'your session is soon')`,
      )
      .bind(base - HOUR_MS, base - 10 * 60 * 1000)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT delivered_at, next_attempt_at FROM notification_log WHERE id = 'nl-1'`)
      .first<{ delivered_at: number | null; next_attempt_at: number | null }>();
    expect(
      row!.delivered_at ?? row!.next_attempt_at,
      'the stranded obligation was neither delivered nor rescheduled',
    ).not.toBeNull();
  });

  // The sibling consumer, fixed in the same commit rather than a pass later.
  // sweepDueNudgeRetries claims through the identical outbox helper and had
  // the identical non-null requirement -- and this consumer has now been the
  // missed sibling three times running (R09's invitation check, P13-12's
  // group-membership check, and this), which is reason enough to stop
  // discovering it one finding at a time.
  it('retries an abandoned group-nudge claim too', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'owner');
    await seedMembership(db, 'owner', 'guild-1');
    await db.prepare(`UPDATE users SET dm_channel_id = 'dm-owner' WHERE id = 'owner'`).run();
    await db
      .prepare(`INSERT INTO groups (id, name, idle_reminder_days, created_by, created_at) VALUES ('grp-1', 'The Crew', 2, 'owner', ?)`)
      .bind(base)
      .run();
    await db
      .prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('grp-1', 'owner', ?)`)
      .bind(base)
      .run();

    await db
      .prepare(
        `INSERT INTO group_nudge_log (id, group_id, user_id, last_event_at, sent_at, attempt_count,
           claim_token, claimed_until, next_attempt_at, content)
         VALUES ('gn-1', 'grp-1', 'owner', 1000, ?, 1, 'tok', ?, NULL, 'The Crew has not played in a while')`,
      )
      .bind(base - HOUR_MS, base - 10 * 60 * 1000)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    const row = await db
      .prepare(`SELECT delivered_at, next_attempt_at FROM group_nudge_log WHERE id = 'gn-1'`)
      .first<{ delivered_at: number | null; next_attempt_at: number | null }>();
    expect(
      row!.delivered_at ?? row!.next_attempt_at,
      'the stranded nudge was neither delivered nor rescheduled',
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P13-14 / F-34
// ---------------------------------------------------------------------------

// P12-14 widened the fast-forward so a long occurrence starting before the
// window is generated, and the Pass-12 summary described what was left as
// "an override that moves an occurrence later can fall outside the span".
// Both reviewers pointed out that understates it: the walk is driven by
// NOMINAL dates, pushIfInWindow stops the forward walk before it reads an
// override, and an accepted time_change validates only that the proposed time
// is a sane future range. So the gap is both directions and any distance --
// moving next Monday's game three weeks out is an ordinary use of the feature.
describe('a moved occurrence appears at the time it was moved to (P13-14)', () => {
  const daily = {
    freq: 'DAILY' as const,
    interval: 1,
    byWeekday: null,
    byMonthDay: null,
    startDate: '2026-09-01',
    startTime: '19:00',
    durationMinutes: 120,
    endType: 'after_count' as const,
    endDate: null,
    endCount: 1,
  };

  const movedForward = [
    {
      occurrence_date: '2026-09-01',
      is_cancelled: 0,
      override_start_at: Date.UTC(2026, 8, 20, 19, 0),
      override_end_at: Date.UTC(2026, 8, 20, 21, 0),
    },
  ];

  it('is found when the window covers its new time, far past the original', () => {
    const occurrences = expandOccurrences(
      daily,
      'UTC',
      Date.UTC(2026, 8, 20, 0, 0),
      Date.UTC(2026, 8, 21, 0, 0),
      movedForward,
    );
    expect(occurrences.map((o) => o.startAt)).toEqual([Date.UTC(2026, 8, 20, 19, 0)]);
  });

  it('is not reported at its original time any more', () => {
    const occurrences = expandOccurrences(
      daily,
      'UTC',
      Date.UTC(2026, 8, 1, 0, 0),
      Date.UTC(2026, 8, 2, 0, 0),
      movedForward,
    );
    expect(occurrences).toEqual([]);
  });

  it('is found when the move is backwards, before the rule would reach it', () => {
    const later = { ...daily, startDate: '2026-09-28' };
    const movedBack = [
      {
        occurrence_date: '2026-09-28',
        is_cancelled: 0,
        override_start_at: Date.UTC(2026, 8, 2, 19, 0),
        override_end_at: Date.UTC(2026, 8, 2, 21, 0),
      },
    ];
    const occurrences = expandOccurrences(
      later,
      'UTC',
      Date.UTC(2026, 8, 2, 0, 0),
      Date.UTC(2026, 8, 3, 0, 0),
      movedBack,
    );
    expect(occurrences.map((o) => o.startAt)).toEqual([Date.UTC(2026, 8, 2, 19, 0)]);
  });

  it('emits a moved occurrence exactly once when the walk also reaches it', () => {
    // A small move that stays inside the same window the walk covers -- the
    // override pass must not duplicate what pushIfInWindow already emitted.
    const nudged = [
      {
        occurrence_date: '2026-09-01',
        is_cancelled: 0,
        override_start_at: Date.UTC(2026, 8, 1, 21, 0),
        override_end_at: Date.UTC(2026, 8, 1, 23, 0),
      },
    ];
    const occurrences = expandOccurrences(
      daily,
      'UTC',
      Date.UTC(2026, 8, 1, 0, 0),
      Date.UTC(2026, 8, 2, 0, 0),
      nudged,
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].startAt).toBe(Date.UTC(2026, 8, 1, 21, 0));
  });

  it('does not resurrect an occurrence the series no longer produces', () => {
    // An override left behind by an edit that ended the series earlier. Its
    // original date is outside the series, so it is not an occurrence at all.
    const ended = { ...daily, endType: 'on_date' as const, endDate: '2026-09-05', endCount: null };
    const orphan = [
      {
        occurrence_date: '2026-09-30',
        is_cancelled: 0,
        override_start_at: Date.UTC(2026, 8, 20, 19, 0),
        override_end_at: Date.UTC(2026, 8, 20, 21, 0),
      },
    ];
    const occurrences = expandOccurrences(
      ended,
      'UTC',
      Date.UTC(2026, 8, 20, 0, 0),
      Date.UTC(2026, 8, 21, 0, 0),
      orphan,
    );
    expect(occurrences).toEqual([]);
  });
});
