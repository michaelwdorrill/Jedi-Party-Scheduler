import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReminderSweep } from '../src/cron/reminders';
import { handleInteraction } from '../src/lib/interactions';
import { expandOccurrences } from '../src/lib/recurrence';
import { acceptChangeRequest, type ChangeRequestRow } from '../src/lib/changeRequests';
import { createSession, isSessionActive, revokeSession, rotateSession } from '../src/lib/sessions';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { sweepGoogleCalendar } from '../src/cron/googleSync';
import { storeConnection } from '../src/lib/googleCalendar';
import { TickBudget } from '../src/cron/budget';
import { seal } from '../src/lib/crypto';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';

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
  overrides: { readCalendarId?: string | null } = {},
): Promise<void> {
  const sealed = await seal('stored-refresh-token', GOOGLE_ENCRYPTION_KEY);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO google_calendar_connections
         (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
          access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
          last_synced_at, disconnect_attempts, connected_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'primary', ?, 1, 'active', NULL, 0, ?, ?)`,
    )
    .bind(userId, sealed.ciphertext, sealed.iv, `${userId}@gmail.com`, overrides.readCalendarId ?? null, now, now)
    .run();
}
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
  loadEventRow,
  seedUser,
  setup,
  stubFetch,
  type FetchStub,
} from './helpers';

// Pass 14 review (September 2026). Two independent reviewers; reviewer A
// withheld sign-off on one P1, reviewer B judged every Pass-13 fix closed and
// found five adjacent defects. Four findings were reported by both.
//
// One describe() per finding, finding id in the title.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// P14-01
// ---------------------------------------------------------------------------

// The third of three outgoing paths to carry a user id forward instead of
// deriving recipients live. P12-01 fixed recipient selection, P13-03 fixed
// message editing, and this one -- the change-request decision notice -- keys
// on ecr.requester_id with only guild-membership joins, while selecting the
// event's CURRENT title and the organizer's CURRENT decision note.
//
// So removing a requester, renaming the event and then declining their request
// sends them a first DM containing both new values.
describe('a removed requester gets no decision notice (P14-01)', () => {
  async function seedFiledRequest(db: Awaited<ReturnType<typeof setup>>['db']): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'asker');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'asker', 'guild-1');
    await db.prepare(`UPDATE users SET dm_channel_id = 'dm-asker' WHERE id = 'asker'`).run();

    const start = Date.now() + 5 * DAY_MS;
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'organizer',
      title: 'Ordinary Tuesday Game',
      startAt: start,
      endAt: start + 2 * HOUR_MS,
    });
    await seedInvite(db, 'ev-1', 'asker');
    await seedUser(db, 'newcomer');
    await seedMembership(db, 'newcomer', 'guild-1');

    await db
      .prepare(
        `INSERT INTO event_change_requests
           (id, event_id, requester_id, kind, target_user_id, occurrence_date, status, event_revision, message, created_at)
         VALUES ('cr-1', 'ev-1', 'asker', 'add_invitee', 'newcomer', '', 'pending', 0, 'can my friend come?', ?)`,
      )
      .bind(Date.now())
      .run();
  }

  it('withholds the new title and decision note once access is gone', async () => {
    const { db, env } = setup('paid');
    await seedFiledRequest(db);

    // The organizer removes them, through the same two statements the real
    // invite-removal route runs.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM event_invites WHERE event_id = 'ev-1' AND user_id = 'asker'`),
      env.DB.prepare(`DELETE FROM event_attendance WHERE event_id = 'ev-1' AND user_id = 'asker'`),
    ]);

    // ...then renames the event and declines with a private note. Both values
    // are created after the removal.
    await db.prepare(`UPDATE events SET title = 'Raid on the Vault -- secret' WHERE id = 'ev-1'`).run();
    await db
      .prepare(
        `UPDATE event_change_requests SET status = 'declined', decision_note = 'no, we moved it off-site', decided_at = ? WHERE id = 'cr-1'`,
      )
      .bind(Date.now())
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    // Scoped to the removed requester's own DM channel. The organizer also
    // gets notices about their own event and those legitimately carry the
    // title, so asserting over every outgoing body would fail for the wrong
    // reason.
    const toRemoved = fetchStub.calls
      .map((url, i) => ({ url, body: fetchStub!.bodies[i] ?? '' }))
      .filter((c) => c.url.includes('dm-asker'));
    const sentToRemoved = toRemoved.map((c) => c.body).join(' ');

    expect(sentToRemoved, 'the new private title reached a removed requester').not.toContain('Raid on the Vault');
    expect(sentToRemoved, 'the organizer private note reached a removed requester').not.toContain('off-site');
    expect(
      await countRows(db, 'change_request_log', `user_id = 'asker' AND notification_type = 'change_request_decision'`),
    ).toBe(0);
  });

  it('still tells a requester who is still on the event', async () => {
    const { db, env } = setup('paid');
    await seedFiledRequest(db);

    await db.prepare(`UPDATE events SET title = 'Raid on the Vault -- secret' WHERE id = 'ev-1'`).run();
    await db
      .prepare(
        `UPDATE event_change_requests SET status = 'declined', decision_note = 'no, we moved it off-site', decided_at = ? WHERE id = 'cr-1'`,
      )
      .bind(Date.now())
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    expect(
      await countRows(db, 'change_request_log', `user_id = 'asker' AND notification_type = 'change_request_decision'`),
      'a current invitee stopped being told the outcome of their own request',
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P14-02
// ---------------------------------------------------------------------------

// The website's loadOwnedActiveEvent requires the organizer to still be a
// current active member of the event's guild -- its comment says
// "leaving/removal revokes control too, not just visibility". Both interaction
// cancel handlers checked organizer identity and event state and stopped
// there, so an authentic press of a control still sitting in an old DM
// cancelled a session the website would have refused with a 404.
//
// A signature proves who pressed the button. It does not prove they may still
// act.
describe('Discord cancel controls respect current guild membership (P14-02)', () => {
  function press(customId: string, userId: string) {
    return {
      type: 3,
      data: { custom_id: customId },
      member: { user: { id: userId } },
      message: { id: 'msg-1', components: [] },
    } as never;
  }

  async function seedOrganizerWhoLeft(db: Awaited<ReturnType<typeof setup>>['db']) {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer', startAt: start, endAt: start + 2 * HOUR_MS });
    await seedEvent(db, { id: 'ev-rec', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
    // They leave the server. The website refuses every organizer mutation
    // from this point; the retained Discord controls did not.
    await db
      .prepare(`UPDATE user_guild_membership SET is_member = 0 WHERE user_id = 'organizer' AND guild_id = 'guild-1'`)
      .run();
  }

  it('refuses a whole-event cancel from an organizer who has left', async () => {
    const { db, env } = setup('paid');
    await seedOrganizerWhoLeft(db);

    const res = await handleInteraction(env, press('uo:v2:cancel:ev-1', 'organizer'));

    expect(await countRows(db, 'events', `id = 'ev-1' AND status = 'cancelled'`), 'the session was cancelled by someone no longer in the server').toBe(0);
    expect(JSON.stringify(res)).toContain('no longer in that server');
  });

  it('refuses an occurrence cancel from an organizer who has left', async () => {
    const { db, env } = setup('paid');
    await seedOrganizerWhoLeft(db);

    await handleInteraction(env, press('uo:v2:cancelocc:ev-rec:2026-09-20', 'organizer'));

    expect(
      await countRows(db, 'event_occurrence_overrides', `event_id = 'ev-rec' AND is_cancelled = 1`),
      'an occurrence was cancelled by someone no longer in the server',
    ).toBe(0);
  });

  it('still lets a current organizer cancel', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    const start = Date.now() + 3 * DAY_MS;
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer', startAt: start, endAt: start + 2 * HOUR_MS });

    await handleInteraction(env, press('uo:v2:cancel:ev-1', 'organizer'));

    expect(await countRows(db, 'events', `id = 'ev-1' AND status = 'cancelled'`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P14-15 / F-38, P14-13 / F-39, P14-14
// ---------------------------------------------------------------------------

const weekly = {
  freq: 'WEEKLY' as const,
  interval: 1,
  byWeekday: '0', // Monday
  byMonthDay: null,
  startDate: '2026-09-07',
  startTime: '19:00',
  durationMinutes: 120,
  endType: 'never' as const,
  endDate: null,
  endCount: null,
};

// pushIfInWindow emits at the RULE's position carrying the OVERRIDE's times,
// and the Pass-13 override pass appends far-moved ones at the end. Nothing
// sorted. Three callers take results[0] as "the next occurrence".
describe('expanded occurrences come back in chronological order (P14-15)', () => {
  it('puts an occurrence moved earlier ahead of the ones it now precedes', () => {
    const moved = [
      {
        occurrence_date: '2026-10-12',
        is_cancelled: 0,
        override_start_at: Date.UTC(2026, 8, 16, 19, 0),
        override_end_at: Date.UTC(2026, 8, 16, 21, 0),
      },
    ];
    const occurrences = expandOccurrences(weekly, 'UTC', Date.UTC(2026, 8, 15), Date.UTC(2026, 9, 20), moved);

    expect(occurrences.length).toBeGreaterThan(1);
    expect(occurrences[0].date, 'the earliest occurrence was not first').toBe('2026-10-12');
    expect(occurrences[0].startAt).toBe(Date.UTC(2026, 8, 16, 19, 0));

    const starts = occurrences.map((o) => o.startAt);
    expect(starts, 'output is not sorted by effective start').toEqual([...starts].sort((a, b) => a - b));
  });

  it('leaves an ordinary series in order', () => {
    const occurrences = expandOccurrences(weekly, 'UTC', Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1), []);
    const starts = occurrences.map((o) => o.startAt);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

// The override pass checked only seriesStart and endDate, so an override
// orphaned by a rule edit -- a changed weekday, a shortened count -- came back
// as a live occurrence with reminders and a busy block.
describe('the override pass only emits real occurrences of the series (P14-13)', () => {
  it('drops an override orphaned by a weekday change', () => {
    // A Monday override, on a series since edited to Tuesdays.
    const tuesdays = { ...weekly, byWeekday: '1', startDate: '2026-09-08' };
    const orphan = [
      {
        occurrence_date: '2026-09-14', // a Monday
        is_cancelled: 0,
        override_start_at: Date.UTC(2026, 8, 30, 19, 0),
        override_end_at: Date.UTC(2026, 8, 30, 21, 0),
      },
    ];
    const occurrences = expandOccurrences(tuesdays, 'UTC', Date.UTC(2026, 8, 30), Date.UTC(2026, 9, 1), orphan);
    expect(occurrences.map((o) => o.date), 'a Monday override survived a move to Tuesdays').toEqual([]);
  });

  it('drops an override past a shortened end_count', () => {
    const countOne = { ...weekly, endType: 'after_count' as const, endCount: 1 };
    const orphan = [
      {
        occurrence_date: '2026-09-21', // the third Monday, outside a count of one
        is_cancelled: 0,
        override_start_at: Date.UTC(2026, 8, 30, 19, 0),
        override_end_at: Date.UTC(2026, 8, 30, 21, 0),
      },
    ];
    const occurrences = expandOccurrences(countOne, 'UTC', Date.UTC(2026, 8, 30), Date.UTC(2026, 9, 1), orphan);
    expect(occurrences.map((o) => o.date), 'an override outside end_count was emitted').toEqual([]);
  });

  it('drops an override on an off-interval date', () => {
    const fortnightly = { ...weekly, interval: 2 };
    const orphan = [
      {
        occurrence_date: '2026-09-14', // the skipped week
        is_cancelled: 0,
        override_start_at: Date.UTC(2026, 8, 30, 19, 0),
        override_end_at: Date.UTC(2026, 8, 30, 21, 0),
      },
    ];
    const occurrences = expandOccurrences(fortnightly, 'UTC', Date.UTC(2026, 8, 30), Date.UTC(2026, 9, 1), orphan);
    expect(occurrences.map((o) => o.date)).toEqual([]);
  });

  it('still emits a move of a genuine occurrence', () => {
    const moved = [
      {
        occurrence_date: '2026-09-14', // a real Monday of this series
        is_cancelled: 0,
        override_start_at: Date.UTC(2026, 8, 30, 19, 0),
        override_end_at: Date.UTC(2026, 8, 30, 21, 0),
      },
    ];
    const occurrences = expandOccurrences(weekly, 'UTC', Date.UTC(2026, 8, 30), Date.UTC(2026, 9, 1), moved);
    expect(occurrences.map((o) => o.date), 'a legitimate move stopped being visible').toEqual(['2026-09-14']);
  });
});

// ---------------------------------------------------------------------------
// P14-09 / F-37
// ---------------------------------------------------------------------------

// A third P13-07-shaped sibling, missed even after last pass went looking for
// siblings of exactly this guard. syncImportedPersonalEvents' terminal branch
// nulls read_calendar_id and deletes every imported row scoped by user_id
// alone -- while the stale-delete and upsert a few lines further down the same
// function use guardBinds = [user_id, read_calendar_id] for precisely this
// reason.
describe('a stale import failure cannot revert a new read calendar (P14-09)', () => {
  async function seedReader(db: ShimDatabase, env: Env): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedGoogleConnection(db, 'u1', { readCalendarId: 'calendar-a' });
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'u1'`).run();
    void env;
  }

  it('leaves the newly selected calendar and its imports alone', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedReader(db, env);

    const now = Date.now();
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'at', expires_in: 3600 } },
      {
        match: '/calendars/calendar-a/events',
        status: 404,
        body: { error: { message: 'not found' } },
        // The switch happens with calendar A's read genuinely in flight --
        // the request is away and its answer has not arrived.
        before: async () => {
          await db
            .prepare(`UPDATE google_calendar_connections SET read_calendar_id = 'calendar-b' WHERE user_id = 'u1'`)
            .run();
          await db
            .prepare(
              `INSERT INTO personal_events
                 (id, user_id, title, description, timezone, start_at, end_at, status, availability, is_recurring,
                  google_event_id, created_at, updated_at)
               VALUES ('pe-b', 'u1', 'From calendar B', NULL, 'UTC', ?, ?, 'active', 'busy', 0, 'g-b', ?, ?)`,
            )
            .bind(now + DAY_MS, now + DAY_MS + HOUR_MS, now, now)
            .run();
        },
      },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const row = await db
      .prepare(`SELECT read_calendar_id FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ read_calendar_id: string | null }>();
    expect(row!.read_calendar_id, "a stale 404 reverted the user's new calendar choice").toBe('calendar-b');
    expect(await countRows(db, 'personal_events', `id = 'pe-b'`), "the new calendar's imports were deleted").toBe(1);
  });

  it('still switches reading off when the current calendar is the one that is gone', async () => {
    const { db, env: base } = setup('paid');
    const env = googleEnv(base);
    await seedReader(db, env);

    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'at', expires_in: 3600 } },
      { match: '/calendars/calendar-a/events', status: 404, body: { error: { message: 'not found' } } },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const after = await db
      .prepare(`SELECT read_calendar_id FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ read_calendar_id: string | null }>();
    expect(after!.read_calendar_id, 'a genuinely missing calendar was left switched on').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P14-11 / F-40
// ---------------------------------------------------------------------------

// P13-09 gave addInvitesToEvent an honest answer about who the capacity guard
// actually admitted, and taught the additive route to surface it. This caller
// kept discarding it, so a racing truncation committed the request as accepted
// with nobody added -- a decision recorded for an effect that never happened.
describe('accepting an add-invitee request honours notAdded (P14-11)', () => {
  it('does not record an acceptance whose invitation was truncated', async () => {
    const { db, env } = setup('paid');
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer' });

    const guests: string[] = [];
    for (let i = 0; i < 27; i++) {
      const uid = `guest-${String(i).padStart(2, '0')}`;
      await seedUser(db, uid);
      await seedMembership(db, uid, 'guild-1');
      guests.push(uid);
    }
    // 24 of 25 seats taken, so this acceptance's preflight passes.
    for (const uid of guests.slice(0, 24)) await seedInvite(db, 'ev-1', uid);

    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO event_change_requests
           (id, event_id, requester_id, kind, target_user_id, occurrence_date, status, event_revision, message, created_at)
         VALUES ('cr-a', 'ev-1', ?, 'add_invitee', ?, '', 'pending', 0, 'can they come?', ?)`,
      )
      .bind(guests[24], guests[24], now)
      .run();

    // The real interleaving: another request takes the last seat between this
    // acceptance's preflight count and its invite write. That is the state
    // P13-09's LIMIT exists to handle -- it truncates rather than overshoot --
    // and the question is what the acceptance does about it.
    let filled = false;
    const racing = {
      ...db,
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: unknown[]) => {
        if (!filled) {
          filled = true;
          await seedInvite(db, 'ev-1', guests[25]);
        }
        return db.batch(statements as never);
      },
    };

    const event = await loadEventRow(db, 'ev-1');
    const request = await db
      .prepare(`SELECT * FROM event_change_requests WHERE id = 'cr-a'`)
      .first<ChangeRequestRow>();

    await acceptChangeRequest({ ...env, DB: racing } as never, event, request!, 'organizer').catch(() => undefined);

    expect(filled, 'the test never reached the invite write').toBe(true);
    expect(await countRows(db, 'event_invites', `event_id = 'ev-1'`), 'the cap did not hold').toBeLessThanOrEqual(25);
    expect(
      await countRows(db, 'event_invites', `event_id = 'ev-1' AND user_id = ?`, guests[24]),
      'the request target was not invited',
    ).toBe(0);
    expect(
      await countRows(db, 'event_change_requests', `id = 'cr-a' AND status = 'accepted'`),
      'the request was recorded as accepted without its person being invited',
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P14-05
// ---------------------------------------------------------------------------

// P13-02 made superseded rows survive to absolute expiry, because they carry
// the id-to-family mapping logout and replay detection resolve through. What
// that exposed: nothing bounds how often rotation runs. /auth/refresh accepts
// a token it issued a moment ago and mints another session for it, and the
// live-session cap deliberately does not count the retained rows -- so an
// authenticated caller could grow stored rows by request count.
//
// Deleting them again is the fix P13-02 undid, so the issuance side is bounded
// instead.
describe('hammering refresh does not grow the session table (P14-05)', () => {
  it('coalesces refreshes of a session that was just issued', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: original } = await createSession(env, 'u1');

    let current = original;
    for (let i = 0; i < 50; i++) {
      const next = await rotateSession(env, current, 'u1');
      expect(next).not.toBeNull();
      current = next!;
    }

    expect(current, 'a hammering caller was handed new sessions').toBe(original);
    expect(await countRows(db, 'sessions', `user_id = 'u1'`), 'fifty immediate refreshes created rows').toBe(1);
    expect(await isSessionActive(env, current, 'u1')).toBe(true);
  });

  it('still rotates once the session has aged past the window', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: original } = await createSession(env, 'u1');
    await ageSession(db, original);

    const next = await rotateSession(env, original, 'u1');

    expect(next, 'an aged session stopped rotating').not.toBe(original);
    expect(await countRows(db, 'sessions', `user_id = 'u1'`)).toBe(2);
  });

  it('leaves delayed logout working, which is what the retention is for', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: root } = await createSession(env, 'u1');
    await ageSession(db, root);
    const successor = await rotateSession(env, root, 'u1');

    await revokeSession(env, root);

    expect(await isSessionActive(env, successor!, 'u1'), 'coalescing broke family revocation').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P14-07 / P14-06 / P14-10
// ---------------------------------------------------------------------------

// The calendar-list call doubles as the account-email lookup, and a failure
// fell through as a null identity that was still parked as a finalizable
// connection. storeConnection then compared that null against the existing
// connection's known email and read it as proof of a DIFFERENT account --
// revoking the grant of the account being kept and running the destructive
// switch cleanup.
describe('an unidentified Google account is not treated as a different one (P14-07)', () => {
  it('does not revoke or wipe when the identity lookup failed', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'u1');
    await seedGoogleConnection(db, 'u1', { readCalendarId: 'primary' });
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO personal_events
           (id, user_id, title, description, timezone, start_at, end_at, status, availability, is_recurring,
            google_event_id, created_at, updated_at)
         VALUES ('pe-1', 'u1', 'Imported', NULL, 'UTC', ?, ?, 'active', 'busy', 0, 'g-1', ?, ?)`,
      )
      .bind(now + DAY_MS, now + DAY_MS + HOUR_MS, now, now)
      .run();

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    // The same account reconnecting, but its identity could not be read.
    await storeConnection(env, 'u1', 'fresh-refresh', 'fresh-access', 3600, null, 'primary');

    expect(fetchStub.calls.filter((c) => c.includes('/revoke')), 'an unknown identity triggered a revocation').toHaveLength(0);
    expect(await countRows(db, 'personal_events', `id = 'pe-1'`), 'imports were wiped on an unknown identity').toBe(1);
  });

  it('still treats a genuinely different account as a switch', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'u1');
    await seedGoogleConnection(db, 'u1');

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'fresh-refresh', 'fresh-access', 3600, 'someone-else@gmail.com', 'primary');

    expect(fetchStub.calls.filter((c) => c.includes('/revoke'))).toHaveLength(1);
  });
});

// The link-insert guard checked the calendar string and active status but not
// the credential that owns it. Every Google account has a calendar aliased
// 'primary', so two accounts' destinations compare equal.
describe('a link cannot be accepted under the wrong account (P14-06)', () => {
  it('rejects a late insert once the connection has been replaced', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedGoogleConnection(db, 'u1');
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'u1'`).run();

    const now = Date.now();
    await seedEvent(db, { id: 'ev-1', organizerId: 'u1', startAt: now + DAY_MS, endAt: now + DAY_MS + HOUR_MS });
    await seedInvite(db, 'ev-1', 'u1');

    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'at', expires_in: 3600 } },
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
      {
        match: '/calendar/v3/calendars/',
        status: 200,
        body: { id: 'google-event-1' },
        // Account B is connected while account A's insert is in flight. Both
        // write to a calendar called 'primary'.
        before: async () => {
          await storeConnection(env, 'u1', 'account-b-refresh', 'account-b-access', 3600, 'b@gmail.com', 'primary');
        },
      },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    expect(
      await countRows(db, 'google_event_links', `user_id = 'u1'`),
      "account A's late insert was recorded under account B",
    ).toBe(0);
  });
});

// "Stays at the front of the queue and is retried first next tick" is only
// fair when the queue serves more than one connection per tick. It serves one.
describe('a failing token does not monopolize the sync slot (P14-10)', () => {
  it('lets a second due user run after a transient token failure', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    for (const uid of ['a-user', 'b-user']) {
      await seedUser(db, uid);
      await seedMembership(db, uid, 'guild-1');
      await seedGoogleConnection(db, uid);
    }
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id IN ('a-user','b-user')`).run();

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/token', status: 503, body: {} }]);

    for (let tick = 0; tick < 4; tick++) {
      await sweepGoogleCalendar(env, new TickBudget('free'));
    }

    const second = await db
      .prepare(`SELECT last_synced_at FROM google_calendar_connections WHERE user_id = 'b-user'`)
      .first<{ last_synced_at: number | null }>();
    expect(second!.last_synced_at, 'the second user never got a turn').not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F-41 and the P13-07 residual
// ---------------------------------------------------------------------------

// The export's sessions projection predated rotation. Refresh replaces the
// session and keeps the predecessor until it expires (0041/0042), so a single
// login open for a week exports as dozens of rows that differ only in their
// timestamps -- read against a policy sentence that promised "your active
// login sessions". All of them are genuinely held, so the correction is to
// say which is which, not to hide them.
describe('the export distinguishes a live session from the ones it replaced (F-41)', () => {
  it('carries superseded_at and family_id on rotation history', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');

    const { id: root } = await createSession(env, 'u1');
    await ageSession(db, root);
    const successor = await rotateSession(env, root, 'u1');

    const token = await signJwt('u1', successor!, env.JWT_SIGNING_KEY);
    const res = await buildApp().request(
      'https://worker.test/me/export',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: { superseded_at: number | null; family_id: string | null }[];
    };

    expect(body.sessions, 'the rotation predecessor is not in the export at all').toHaveLength(2);
    const live = body.sessions.filter((s) => s.superseded_at == null);
    const retired = body.sessions.filter((s) => s.superseded_at != null);
    expect(live, 'more than one row reads as the session in use').toHaveLength(1);
    expect(retired, 'the replaced session is indistinguishable from the live one').toHaveLength(1);
    // One login, not two: the family is what says so.
    expect(new Set(body.sessions.map((s) => s.family_id)).size, 'one login exported as several').toBe(1);
  });

  // An invariant guard, not a reproduction: it passes with and without the
  // projection change. It exists because widening this particular SELECT is
  // exactly the move that puts a secret in a file the user downloads, and the
  // googleCalendar line above says so in a comment that nothing enforces.
  it('exports no credential material with them', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: sessionId } = await createSession(env, 'u1');

    const token = await signJwt('u1', sessionId, env.JWT_SIGNING_KEY);
    const res = await buildApp().request(
      'https://worker.test/me/export',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const body = (await res.json()) as Record<string, unknown>;

    // family_id is the id of the login that started the chain, which for a
    // fresh session is its own id -- inert without the signing key, and the
    // key itself must never appear whatever else this projection grows.
    expect(JSON.stringify(body)).not.toContain(env.JWT_SIGNING_KEY);
  });
});

// Reviewer B's note on P13-07: markUnauthorized was given the credential guard
// and this close-out stamp was not. If the user reconnects mid-sync, the
// predecessor's outcome lands on the replacement's row.
describe('a finished sync does not stamp a connection it no longer owns (P13-07 residual)', () => {
  it('leaves the replacement connection unmarked', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedGuild(db, 'guild-1');
    await seedUser(db, 'u1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedGoogleConnection(db, 'u1');
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'u1'`).run();

    const now = Date.now();
    await seedEvent(db, { id: 'ev-1', organizerId: 'u1', startAt: now + DAY_MS, endAt: now + DAY_MS + HOUR_MS });
    await seedInvite(db, 'ev-1', 'u1');

    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'at', expires_in: 3600 } },
      { match: 'oauth2.googleapis.com/revoke', status: 200, body: {} },
      {
        // The write Google refuses -- what puts a message in last_error -- and
        // the moment the user reconnects as somebody else.
        match: '/calendar/v3/calendars/',
        status: 500,
        body: { error: { message: 'backend error' } },
        before: async () => {
          await storeConnection(env, 'u1', 'account-b-refresh', 'account-b-access', 3600, 'b@gmail.com', 'primary');
        },
      },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('paid'));

    const conn = await db
      .prepare(`SELECT last_error, google_account_email FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<{ last_error: string | null; google_account_email: string }>();
    expect(conn!.google_account_email, 'the test never reached the replacement connection').toBe('b@gmail.com');
    expect(
      conn!.last_error,
      "the predecessor's failure was stamped on the account the user had just connected",
    ).toBeNull();
  });
});
