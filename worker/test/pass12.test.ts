import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteUserCompletely } from '../src/lib/db';
import { addInvitesToEvent, createEventWithInvites, updateEvent } from '../src/lib/eventWrites';
import { assertValidRoster } from '../src/lib/groups';
import { runReminderSweep } from '../src/cron/reminders';
import { readCursorKey } from '../src/cron/cursor';
import { expandOccurrences } from '../src/lib/recurrence';
import { sweepGoogleCalendar } from '../src/cron/googleSync';
import { TickBudget } from '../src/cron/budget';
import { seal, unseal } from '../src/lib/crypto';
import { createSession, isSessionActive, revokeSession, rotateSession } from '../src/lib/sessions';
import { accessTokenFor, type GoogleConnectionRow, revokeToken, storeConnection } from '../src/lib/googleCalendar';
import { acceptChangeRequest, declineChangeRequest } from '../src/lib/changeRequests';
import type { ChangeRequestRow } from '../src/lib/changeRequests';
import { buildApp } from '../src/router';
import { signJwt } from '../src/lib/jwt';
import { ConflictError, ValidationError } from '../src/lib/validate';
import type { Env } from '../src/env';
import { D1_FREE_PLAN_QUERY_BUDGET, type ShimDatabase } from './d1shim';
import {
  ageSession,
  countRows,
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  loadEventRow,
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

// Pass 12 review (September 2026). Two independent reviewers re-read the 31
// Pass-11 fixes; all 20 of their findings verified as real against this tree.
// One describe() per finding, finding id in the title, same shape as
// pass9-pass11.
//
// The recurring theme of this pass is narrowness: several Pass-11 fixes
// corrected the one call site the finding named and left a structurally
// identical sibling alone. Where that is what happened, the test covers both
// sites, so the pair can't drift apart again.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

// A multi-winner poll with one candidate confirmed and fanned out into a real
// event, built through the actual sweep rather than by hand so the resulting
// created_from_option_id / created_from_poll_id pointers are the ones
// production writes.
async function seedFannedOutPoll(
  db: ShimDatabase,
  env: Env,
): Promise<{ pollId: string; optionId: string; survivingSlot: { startAt: number; endAt: number } }> {
  await seedGuild(db);
  await seedUser(db, 'organizer');
  await seedUser(db, 'invitee');
  await seedMembership(db, 'organizer', 'guild-1');
  await seedMembership(db, 'invitee', 'guild-1');

  const base = Date.now();
  const slotA = { startAt: base + 3 * DAY_MS, endAt: base + 3 * DAY_MS + 2 * HOUR_MS };
  const slotB = { startAt: base + 5 * DAY_MS, endAt: base + 5 * DAY_MS + 2 * HOUR_MS };
  const pollId = await createEventWithInvites(env, 'guild-1', 'organizer', {
    title: 'Which nights?',
    description: null,
    game: null,
    eventType: 'poll',
    timezone: 'America/New_York',
    isRecurring: false,
    pollStrategy: 'threshold',
    pollThresholdCount: 2,
    pollDeadlineAt: base + DAY_MS,
    pollResolutionMode: 'multi_winner',
    pollOptions: [slotA, slotB],
    invites: { userIds: ['invitee'], groupIds: [] },
  } as never);

  const optA = await db
    .prepare(`SELECT id FROM event_poll_options WHERE event_id = ? AND start_at = ?`)
    .bind(pollId, slotA.startAt)
    .first<{ id: string }>();
  await db.prepare(`UPDATE event_poll_options SET confirmed_at = ? WHERE id = ?`).bind(base, optA!.id).run();

  fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);
  await runReminderSweep(env);
  expect(await countRows(db, 'events', 'created_from_option_id = ?', optA!.id)).toBe(1);

  return { pollId, optionId: optA!.id, survivingSlot: slotB };
}

// ---------------------------------------------------------------------------
// P12-06
// ---------------------------------------------------------------------------

// Migration 0027's created_from_option_id and created_from_poll_id are a
// fanned-out event's pointer back to the multi-winner poll candidate it came
// from, and neither carries ON DELETE CASCADE. deleteUserCompletely deletes
// event_poll_options in one statement and events in a later one, so at the
// conclusion of the options delete the generated event is still there, still
// pointing at a row that no longer exists -- a bare "FOREIGN KEY constraint
// failed", the whole batch rolled back, and DELETE /me returning 500.
//
// The account is *not* deleted, but revokeAllSessionsForUser has already run
// by then, so the person is logged out of an account that still exists and
// whose deletion they can no longer even retry from the UI. R04/F-15 added
// five missing tables to this batch; it did not complete the dependency
// graph. sweepPurgeTerminalHistory has cleared these two pointers since IDEAS
// item 56 -- this is the same hazard in the path that never learned it.
describe('deleting an account survives an ordinary multi-winner fan-out (P12-06)', () => {
  it('erases an organizer whose poll candidate became a real event', async () => {
    const { db, env } = setup();
    const { pollId, optionId } = await seedFannedOutPoll(db, env);

    await expect(deleteUserCompletely(env, 'organizer')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'organizer')).toBe(0);
    expect(await countRows(db, 'events', 'id = ?', pollId)).toBe(0);
    expect(await countRows(db, 'events', 'created_from_option_id = ?', optionId)).toBe(0);
    expect(await countRows(db, 'event_poll_options', 'event_id = ?', pollId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P12-16 / F-29
// ---------------------------------------------------------------------------

// The same foreign key, reached from the edit path instead of the delete path.
// R05 made updateEvent reconcile candidates by (start_at, end_at) rather than
// replacing them wholesale, which is what stopped an unrelated edit destroying
// votes -- but a candidate the organizer genuinely removes is still deleted
// outright, and if the sweep has already turned that candidate into a real
// event, the delete fails the FK, the batch rolls back, and the organizer gets
// "Internal error" for an edit the UI offered them.
//
// Retiming a materialized candidate reaches it too: (start_at, end_at) is the
// identity, so a moved slot is a remove plus an add.
//
// Refused rather than cascaded, deliberately. The fanned-out event is a real
// session on real calendars that people have been DMed about and may have
// RSVPed to; silently deleting it because its originating candidate was edited
// off a poll would be a much worse outcome than declining the edit. The
// organizer can cancel the session itself if that is what they meant.
describe('removing a fanned-out candidate is refused, not a 500 (P12-16)', () => {
  it('rejects the edit and leaves both the poll and the generated event intact', async () => {
    const { db, env } = setup();
    const { pollId, optionId, survivingSlot } = await seedFannedOutPoll(db, env);

    const stored = await loadEventRow(db, pollId);
    await expect(
      updateEvent(env, pollId, 'guild-1', { pollOptions: [survivingSlot], revision: stored.revision } as never, stored),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countRows(db, 'event_poll_options', 'event_id = ?', pollId)).toBe(2);
    expect(await countRows(db, 'events', 'created_from_option_id = ?', optionId)).toBe(1);
  });

  it('rejects retiming a candidate that has already become an event', async () => {
    const { db, env } = setup();
    const { pollId, survivingSlot } = await seedFannedOutPoll(db, env);

    const stored = await loadEventRow(db, pollId);
    const moved = { startAt: Date.now() + 9 * DAY_MS, endAt: Date.now() + 9 * DAY_MS + 2 * HOUR_MS };
    await expect(
      updateEvent(
        env,
        pollId,
        'guild-1',
        { pollOptions: [moved, survivingSlot], revision: stored.revision } as never,
        stored,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countRows(db, 'event_poll_options', 'event_id = ?', pollId)).toBe(2);
  });

  it('still allows editing a candidate that has not been confirmed', async () => {
    const { db, env } = setup();
    const { pollId, optionId, survivingSlot } = await seedFannedOutPoll(db, env);

    // slotB never confirmed, so moving it is an ordinary edit and must work --
    // the refusal above has to be about materialization, not about polls that
    // happen to have a fanned-out sibling candidate.
    const stored = await loadEventRow(db, pollId);
    const movedB = { startAt: survivingSlot.startAt + DAY_MS, endAt: survivingSlot.endAt + DAY_MS };
    const confirmedSlot = await db
      .prepare(`SELECT start_at, end_at FROM event_poll_options WHERE id = ?`)
      .bind(optionId)
      .first<{ start_at: number; end_at: number }>();

    await updateEvent(
      env,
      pollId,
      'guild-1',
      {
        pollOptions: [{ startAt: confirmedSlot!.start_at, endAt: confirmedSlot!.end_at }, movedB],
        revision: stored.revision,
      } as never,
      stored,
    );

    expect(await countRows(db, 'event_poll_options', 'event_id = ? AND start_at = ?', pollId, movedB.startAt)).toBe(1);
    expect(await countRows(db, 'events', 'created_from_option_id = ?', optionId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P12-08
// ---------------------------------------------------------------------------

// R06 charged and bulk-loaded the per-event recurrence reads in
// sweepMinimumAttendeesDeadlines and left its sibling alone.
// sweepMinimumAttendeesDeadlineWarnings -- the T-24h heads-up, same events,
// same shape, forty lines further down the file -- still ran
// loadOverridesForEvents per candidate, still let expandOccurrencesForEvent
// fall back to issuing its own recurrence-rule query per candidate, and still
// spent its organizer lookup uncharged. So the exact workload R06 measured at
// 89 statements against a 50-query ceiling was fixed for the day the deadline
// lands and left in place for the day before it.
//
// Measured against the database rather than the ledger, for R06's reason: the
// ledger was what was wrong.
describe('the deadline *warning* tick stays inside the Free-plan ceiling (P12-08)', () => {
  const EVENT_COUNT = 30;

  // Thirty daily recurring events whose first occurrence is 30 hours out with
  // a 24-hour deadline, so every one of them is inside the warning window
  // (deadline in (now, now + 24h]) and none is due for resolution yet.
  async function seedWarningWindowEvents(db: ShimDatabase, base: number): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const seriesStart = new Date(base + 30 * HOUR_MS);
    const startDate = seriesStart.toISOString().slice(0, 10);
    const startTime = `${String(seriesStart.getUTCHours()).padStart(2, '0')}:${String(seriesStart.getUTCMinutes()).padStart(2, '0')}`;

    for (let i = 0; i < EVENT_COUNT; i++) {
      const id = `rec-${String(i).padStart(2, '0')}`;
      await seedEvent(db, { id, organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
      await db
        .prepare(
          `UPDATE events SET timezone = 'UTC', minimum_attendees = 5, auto_cancel_below_minimum = 0,
             minimum_attendees_deadline_hours_before = 24 WHERE id = ?`,
        )
        .bind(id)
        .run();
      await db
        .prepare(
          `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
           VALUES (?, 'DAILY', 1, ?, ?, 60, 'never')`,
        )
        .bind(id, startDate, startTime)
        .run();
      await seedInvite(db, id, 'organizer');
    }
  }

  it('measures actual statements for thirty in-quota recurring events', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedWarningWindowEvents(db, base);
    // Notifications off, so what is measured is the discovery work alone and
    // not delivery -- same isolation the R06 test uses.
    await db.prepare(`UPDATE users SET notifications_enabled = 0 WHERE id = 'organizer'`).run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    db.resetQueryCount();
    await runReminderSweep(env);
    expect(db.queryCount).toBeLessThanOrEqual(D1_FREE_PLAN_QUERY_BUDGET);
  });

  // And the other half, exactly as for R06: once the ledger is honest a tick
  // affords only a handful of these, and this sweep selected both its pages
  // with a bare LIMIT and no ORDER BY -- so the same prefix came back every
  // tick and the events behind it were never warned about at all.
  it('reaches every event across successive ticks rather than the same prefix', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedWarningWindowEvents(db, base);
    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);

    for (let tick = 0; tick < 12; tick++) {
      await runReminderSweep(env);
      vi.setSystemTime(base + (tick + 1) * 60 * 1000);
    }

    const warned = await countRows(db, 'notification_log', `notification_type = ?`, 'minimum_attendees_deadline_warning');
    expect(warned).toBe(EVENT_COUNT);
  });
});

// ---------------------------------------------------------------------------
// P12-10 / F-28
// ---------------------------------------------------------------------------

// The recurring arm of sweepMinimumAttendeesDeadlines resets its keyset cursor
// only inside `if (recurringCandidates.length > 0)`. The single arm resets on
// any short page, zero rows included; this one cannot, because a zero-row page
// never enters the block that holds the reset.
//
// A page goes empty whenever nothing sorts after the saved cursor any more --
// the tail events were cancelled, had their deadline turned off, or were
// deleted. From that tick on the query is `id > <stuck>` forever, and every
// recurring minimum-attendees deadline with a lower id is never evaluated
// again. Nothing recovers it: the cursor is durable, so this survives restarts
// and outlives the events that caused it.
describe('the recurring-deadline cursor resets on an empty page (P12-10)', () => {
  it('clears a cursor that nothing sorts after any more', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    // One eligible recurring event, whose id sorts *before* the stuck cursor.
    const seriesStart = new Date(base + 12 * HOUR_MS);
    await seedEvent(db, { id: 'aaa-event', organizerId: 'organizer', isRecurring: 1, startAt: null, endAt: null });
    await db
      .prepare(
        `UPDATE events SET timezone = 'UTC', minimum_attendees = 5, auto_cancel_below_minimum = 0,
           minimum_attendees_deadline_hours_before = 24 WHERE id = 'aaa-event'`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO event_recurrence_rules (event_id, freq, interval, start_date, start_time, duration_minutes, end_type)
         VALUES ('aaa-event', 'DAILY', 1, ?, ?, 60, 'never')`,
      )
      .bind(
        seriesStart.toISOString().slice(0, 10),
        `${String(seriesStart.getUTCHours()).padStart(2, '0')}:${String(seriesStart.getUTCMinutes()).padStart(2, '0')}`,
      )
      .run();
    await seedInvite(db, 'aaa-event', 'organizer');

    // The state a previous tick leaves behind after the events it stopped on
    // are gone: a cursor pointing past everything that still exists.
    await db
      .prepare(
        `INSERT INTO cron_cursors (name, position, cursor_key, updated_at)
         VALUES ('minimum_attendees_recurring', 0, 'zzz-departed', ?)`,
      )
      .bind(base)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    expect(await readCursorKey(env, 'minimum_attendees_recurring')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P12-09
// ---------------------------------------------------------------------------

// R23 made the cancellation notice durable for everyone rather than only the
// slice a tick could afford to DM -- but it records that obligation *after*
// the occurrence is already cancelled, behind two more budget reservations.
// Either of them failing returns from a function that has already committed
// the cancellation, leaving zero notification_log rows.
//
// Nothing recovers it, and the code's own comment above the R23 fix explains
// why: a cancelled occurrence stops coming back from expandOccurrences, so
// resolveMinimumAttendeesDeadline is never called for it again, the general
// cancellation sweep skips recurring events, and the retry consumer scans for
// rows that exist -- these never existed. The session is cancelled and nobody
// is ever told.
//
// Swept across a range of preceding workloads rather than one tuned number,
// because the failure is a budget-boundary one: the preceding events each cost
// exactly one query (their minimum is already met, so they return straight
// after the count), which walks the remaining allowance down one step per
// iteration and puts the boundary somewhere inside the range.
describe('an auto-cancelled occurrence always leaves a notice behind (P12-09)', () => {
  it('never commits a cancellation it cannot record notifications for', async () => {
    for (let ahead = 0; ahead < 30; ahead++) {
      vi.useFakeTimers();
      const base = Date.UTC(2026, 8, 10, 12, 0, 0);
      vi.setSystemTime(base);

      const { db, env } = setup();
      await seedGuild(db);
      await seedUser(db, 'organizer');
      await seedMembership(db, 'organizer', 'guild-1');

      // Cheap events ahead of the target in id order, each already at its
      // minimum so it costs one query and stops.
      for (let i = 0; i < ahead; i++) {
        const id = `aaa-${String(i).padStart(2, '0')}`;
        await seedEvent(db, { id, organizerId: 'organizer', startAt: base + 6 * HOUR_MS, endAt: base + 7 * HOUR_MS });
        await db
          .prepare(
            `UPDATE events SET minimum_attendees = 1, auto_cancel_below_minimum = 0,
               minimum_attendees_deadline_at = ? WHERE id = ?`,
          )
          .bind(base - HOUR_MS, id)
          .run();
        await seedInvite(db, id, 'organizer');
      }

      // The target: deadline passed, well below its minimum, auto-cancel on,
      // and a full invite list so the obligation set is several statements.
      await seedEvent(db, {
        id: 'zzz-target',
        organizerId: 'organizer',
        startAt: base + 6 * HOUR_MS,
        endAt: base + 7 * HOUR_MS,
      });
      await db
        .prepare(
          `UPDATE events SET minimum_attendees = 25, auto_cancel_below_minimum = 1,
             minimum_attendees_deadline_at = ? WHERE id = 'zzz-target'`,
        )
        .bind(base - HOUR_MS)
        .run();
      for (let i = 0; i < 20; i++) {
        const uid = `guest-${String(i).padStart(2, '0')}`;
        await seedUser(db, uid);
        await seedMembership(db, uid, 'guild-1');
        await seedInvite(db, 'zzz-target', uid);
        await seedAttendance(db, 'zzz-target', uid, 'accepted');
      }

      fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
      await runReminderSweep(env);
      fetchStub.restore();
      fetchStub = null;

      const cancelled = await countRows(db, 'events', `id = 'zzz-target' AND status = 'cancelled'`);
      const notices = await countRows(
        db,
        'notification_log',
        `event_id = 'zzz-target' AND notification_type = 'event_cancelled_below_minimum'`,
      );
      expect(
        cancelled === 0 || notices > 0,
        `with ${ahead} events ahead of it: cancelled=${cancelled}, notices=${notices}`,
      ).toBe(true);
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// P12-07
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

async function seedGoogleConnection(db: ShimDatabase, userId: string): Promise<void> {
  const sealed = await seal('stored-refresh-token', GOOGLE_ENCRYPTION_KEY);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO google_calendar_connections
         (user_id, refresh_token_ciphertext, refresh_token_iv, access_token_ciphertext, access_token_iv,
          access_token_expires_at, google_account_email, calendar_id, read_calendar_id, sync_enabled, status,
          last_synced_at, disconnect_attempts, connected_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'primary', NULL, 1, 'active', NULL, 0, ?, ?)`,
    )
    .bind(userId, sealed.ciphertext, sealed.iv, `${userId}@gmail.com`, now, now)
    .run();
}

// sweepGoogleCalendar takes one connection per tick (MAX_CONNECTIONS_PER_TICK)
// ordered by last_synced_at ascending, NULLs first -- so the scheduling key is
// the bookkeeping stamp at the end of syncOneConnection. Three of that
// function's exits skipped it: the ones where tryCalendarWrite runs out
// mid-loop. A connection with more upcoming events than one tick's write
// allowance, against a calendar that rejects writes, therefore made no durable
// progress AND never got stamped -- so it sorted first again on the next tick,
// and on every tick after that, and no other user's calendar was ever synced
// again.
//
// The fix reserves the bookkeeping query up front, because tryCalendarWrite
// draws on the same pool: a tick that has run out cannot afford to say so
// afterwards.
describe('one failing Google connection does not starve every later user (P12-07)', () => {
  it('services a second due user even while the first keeps failing', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);

    await seedGuild(db, 'guild-1');
    for (const uid of ['a-user', 'b-user']) {
      await seedUser(db, uid);
      await seedMembership(db, uid, 'guild-1');
      await seedGoogleConnection(db, uid);
    }
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id IN ('a-user','b-user')`).run();

    // Sixteen upcoming sessions for the first user, well inside the app's own
    // limits, against a calendar that refuses every write.
    const now = Date.now();
    for (let i = 0; i < 16; i++) {
      const id = `ev-${String(i).padStart(2, '0')}`;
      await seedEvent(db, {
        id,
        organizerId: 'a-user',
        startAt: now + (i + 1) * DAY_MS,
        endAt: now + (i + 1) * DAY_MS + HOUR_MS,
      });
      await seedInvite(db, id, 'a-user');
    }

    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'at', expires_in: 3600 } },
      { match: '/calendar/v3/calendars/', status: 403, body: { error: { message: 'no write access' } } },
    ]);

    // Several hours of ticks. The first user can never finish; the second has
    // nothing to do and needs only its turn.
    for (let tick = 0; tick < 4; tick++) {
      await sweepGoogleCalendar(env, new TickBudget('free'));
    }

    const second = await db
      .prepare(`SELECT last_synced_at FROM google_calendar_connections WHERE user_id = 'b-user'`)
      .first<{ last_synced_at: number | null }>();
    expect(second!.last_synced_at, 'the second user was never serviced at all').not.toBeNull();
  });

  it('records that a truncated run is not a complete one', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);

    await seedGuild(db, 'guild-1');
    await seedUser(db, 'a-user');
    await seedMembership(db, 'a-user', 'guild-1');
    await seedGoogleConnection(db, 'a-user');
    await db.prepare(`UPDATE users SET accepted_policy_version = 99 WHERE id = 'a-user'`).run();

    const now = Date.now();
    for (let i = 0; i < 16; i++) {
      const id = `ev-${String(i).padStart(2, '0')}`;
      await seedEvent(db, {
        id,
        organizerId: 'a-user',
        startAt: now + (i + 1) * DAY_MS,
        endAt: now + (i + 1) * DAY_MS + HOUR_MS,
      });
      await seedInvite(db, id, 'a-user');
    }

    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/token', status: 200, body: { access_token: 'at', expires_in: 3600 } },
      { match: '/calendar/v3/calendars/', status: 200, body: { id: 'google-event-1' } },
    ]);

    await sweepGoogleCalendar(env, new TickBudget('free'));

    // Stamped, so the next tick moves on -- but not reported as a clean sync,
    // which is the state R18 calls the most misleading this feature can be in.
    const row = await db
      .prepare(`SELECT last_synced_at, last_error FROM google_calendar_connections WHERE user_id = 'a-user'`)
      .first<{ last_synced_at: number | null; last_error: string | null }>();
    expect(row!.last_synced_at).not.toBeNull();
    expect(row!.last_error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P12-02 / P12-03 / P12-11
// ---------------------------------------------------------------------------

async function connectionRow(db: ShimDatabase, userId: string) {
  return db
    .prepare(`SELECT * FROM google_calendar_connections WHERE user_id = ?`)
    .bind(userId)
    .first<{
      google_account_email: string;
      refresh_token_ciphertext: string;
      access_token_ciphertext: string | null;
      access_token_iv: string | null;
    }>();
}

// F-22 made storeConnection revoke the refresh token it replaces, on the
// reasoning that overwriting our copy is not the same as ending the grant.
// That is right for a different Google account and wrong for the same one,
// because Google's revocation is grant-level: revoking any token for a
// (client, user) pair revokes the authorization grant, and the replacement
// `prompt=consent` just minted hangs off that same grant.
//
// So the fix introduced its own failure -- reconnecting the same account, which
// is what someone does when their sync has broken, revoked the credential it
// had just stored. The connection reports itself active and fails on its first
// refresh with invalid_grant.
describe('reconnecting the same Google account keeps the new credential (P12-02)', () => {
  it('does not revoke a superseded token from the same grant', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'u1');
    await seedGoogleConnection(db, 'u1');

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'fresh-refresh-token', 'fresh-access-token', 3600, 'u1@gmail.com', 'primary');

    expect(fetchStub.calls.filter((c) => c.includes('/revoke'))).toHaveLength(0);
    const row = await connectionRow(db, 'u1');
    expect(await unseal({ ciphertext: row!.refresh_token_ciphertext, iv: (row as never as { refresh_token_iv: string }).refresh_token_iv }, GOOGLE_ENCRYPTION_KEY)).toBe(
      'fresh-refresh-token',
    );
  });

  // The other half: a genuinely different Google account is a different grant,
  // so revoking the old one is both safe and the whole point of F-22.
  it('still revokes when the connection moves to a different account', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'u1');
    await seedGoogleConnection(db, 'u1');

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'other-refresh-token', 'other-access-token', 3600, 'someone-else@gmail.com', 'primary');

    const revokes = fetchStub.calls.filter((c) => c.includes('/revoke'));
    expect(revokes).toHaveLength(1);
    expect(fetchStub.bodies.join('')).toContain('stored-refresh-token');
  });
});

// accessTokenFor reads a connection row, goes to Google, and writes the result
// back keyed on `WHERE user_id = ?` alone. Nothing checks that the row is still
// the one the refresh began against -- so a refresh for account A that is still
// in flight when the user connects account B lands afterwards and overwrites
// B's cached access token with one minted from A's grant. The row then reports
// B's email and holds B's refresh token while its access token belongs to A,
// and the next sync sends A's bearer token at B's calendar.
describe('an in-flight refresh cannot overwrite a reconnected account (P12-03)', () => {
  it('discards a refresh whose connection was replaced while it was in flight', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'u1');
    await seedGoogleConnection(db, 'u1');

    // The snapshot a sweep would be holding: account A, access token expired.
    const stale = await db
      .prepare(`SELECT * FROM google_calendar_connections WHERE user_id = 'u1'`)
      .first<GoogleConnectionRow>();

    const accountBAccess = await seal('account-b-access-token', GOOGLE_ENCRYPTION_KEY);
    const accountBRefresh = await seal('account-b-refresh-token', GOOGLE_ENCRYPTION_KEY);

    fetchStub = stubFetch([
      {
        match: 'oauth2.googleapis.com/token',
        status: 200,
        body: { access_token: 'account-a-access-token', expires_in: 3600 },
        // While A's refresh is suspended at the network call, the user finishes
        // connecting account B.
        before: async () => {
          await db
            .prepare(
              `UPDATE google_calendar_connections
               SET google_account_email = 'account-b@gmail.com',
                   refresh_token_ciphertext = ?, refresh_token_iv = ?,
                   access_token_ciphertext = ?, access_token_iv = ?, access_token_expires_at = ?
               WHERE user_id = 'u1'`,
            )
            .bind(
              accountBRefresh.ciphertext,
              accountBRefresh.iv,
              accountBAccess.ciphertext,
              accountBAccess.iv,
              Date.now() + 3600_000,
            )
            .run();
        },
      },
    ]);

    const result = await accessTokenFor(env, stale!);

    const row = await connectionRow(db, 'u1');
    expect(row!.google_account_email).toBe('account-b@gmail.com');
    expect(
      await unseal({ ciphertext: row!.access_token_ciphertext!, iv: row!.access_token_iv! }, GOOGLE_ENCRYPTION_KEY),
      "account A's token was written over account B's row",
    ).toBe('account-b-access-token');
    // And the caller is told to stand down rather than handed a credential for
    // an account this row no longer describes.
    expect(result.ok).toBe(false);
  });
});

// storeConnection clears the previous account's imported personal_events when
// the connection moves to a different Google account, but left
// google_event_links alone -- so every event already pushed to the old account
// still had a link row claiming it was synced. The push half reads those links,
// finds each event unchanged, and skips it: the newly connected account
// receives nothing at all, indefinitely. R17 fixed the equivalent case for a
// calendar change through PATCH; this is the same hazard one path over.
describe('switching Google account clears the old account mappings (P12-11)', () => {
  it('drops google_event_links so the new account gets a fresh push', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'u1');
    await seedGoogleConnection(db, 'u1');
    await seedGuild(db, 'guild-1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'u1',
      startAt: Date.now() + DAY_MS,
      endAt: Date.now() + DAY_MS + HOUR_MS,
    });
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO google_event_links
           (id, user_id, event_id, occurrence_date, google_event_id, synced_title, synced_start_at, synced_end_at, synced_at)
         VALUES ('link-1', 'u1', 'ev-1', '', 'google-event-1', 'Session', ?, ?, ?)`,
      )
      .bind(now + DAY_MS, now + DAY_MS + HOUR_MS, now)
      .run();

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'new-refresh-token', 'new-access-token', 3600, 'someone-else@gmail.com', 'primary');

    expect(await countRows(db, 'google_event_links', `user_id = 'u1'`)).toBe(0);
  });

  it('keeps them when the same account simply reconnects', async () => {
    const { db, env: base } = setup();
    const env = googleEnv(base);
    await seedUser(db, 'u1');
    await seedGoogleConnection(db, 'u1');
    await seedGuild(db, 'guild-1');
    await seedMembership(db, 'u1', 'guild-1');
    await seedEvent(db, {
      id: 'ev-1',
      organizerId: 'u1',
      startAt: Date.now() + DAY_MS,
      endAt: Date.now() + DAY_MS + HOUR_MS,
    });
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO google_event_links
           (id, user_id, event_id, occurrence_date, google_event_id, synced_title, synced_start_at, synced_end_at, synced_at)
         VALUES ('link-1', 'u1', 'ev-1', '', 'google-event-1', 'Session', ?, ?, ?)`,
      )
      .bind(now + DAY_MS, now + DAY_MS + HOUR_MS, now)
      .run();

    fetchStub = stubFetch([{ match: 'oauth2.googleapis.com/revoke', status: 200, body: {} }]);
    await storeConnection(env, 'u1', 'new-refresh-token', 'new-access-token', 3600, 'u1@gmail.com', 'primary');

    // Same account, same calendar: the entries really are still there and
    // re-pushing all of them would be duplicate work at best.
    expect(await countRows(db, 'google_event_links', `user_id = 'u1'`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P12-01
// ---------------------------------------------------------------------------

// Removing someone from an event deletes their event_invites and
// event_attendance rows -- and nothing else. Their poll votes and window
// submissions stay, which is reasonable in itself, but getConfirmedAttendeeIds'
// two poll branches select recipients straight out of those historical records
// and the membership join around them checked only that the person is still in
// the guild. So a removed invitee remained "confirmed" for a poll they were
// dropped from, and sweepVoiceChannelInvites sent them a brand-new DM carrying
// a private event's title, its start time and a link into its voice channel.
//
// R09 closed this for the retry consumer, whose comment names the same
// invite-removal route as the cause. It did not close it for the initial send,
// which is the path that leaks new information rather than re-delivering old.
describe('a removed invitee gets no further DMs about the event (P12-01)', () => {
  async function seedResolvedPoll(db: ShimDatabase): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'dropped');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'dropped', 'guild-1');

    const start = Date.now() + 10 * 60 * 1000;
    await seedEvent(db, {
      id: 'poll-1',
      organizerId: 'organizer',
      title: 'Secret Ops Night',
      eventType: 'poll',
      startAt: start,
      endAt: start + 2 * HOUR_MS,
      status: 'resolved',
    });
    await db
      .prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order)
         VALUES ('opt-1', 'poll-1', ?, ?, 0)`,
      )
      .bind(start, start + 2 * HOUR_MS)
      .run();
    await db
      .prepare(
        `UPDATE events SET resolved_option_id = 'opt-1', voice_channel_id = 'vc-1',
           voice_channel_name = 'The Cantina' WHERE id = 'poll-1'`,
      )
      .run();

    // Both were invited and both voted yes on the night that won.
    for (const uid of ['organizer', 'dropped']) {
      await seedInvite(db, 'poll-1', uid);
      await db
        .prepare(
          `INSERT INTO event_poll_votes (option_id, user_id, vote, voted_at) VALUES ('opt-1', ?, 'yes', ?)`,
        )
        .bind(uid, Date.now())
        .run();
    }
  }

  it('sends no voice-channel invite to someone dropped from a poll', async () => {
    const { db, env } = setup('paid');
    await seedResolvedPoll(db);

    // The organizer removes them, through the real route.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM event_invites WHERE event_id = 'poll-1' AND user_id = 'dropped'`),
      env.DB.prepare(`DELETE FROM event_attendance WHERE event_id = 'poll-1' AND user_id = 'dropped'`),
    ]);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    expect(
      await countRows(db, 'notification_log', `user_id = 'dropped' AND notification_type = 'voice_channel_invite'`),
      'a removed invitee was sent the voice channel link',
    ).toBe(0);
    // The organizer, still on the event, is told as normal -- the guard has to
    // be about current access, not about switching the sweep off.
    expect(
      await countRows(db, 'notification_log', `user_id = 'organizer' AND notification_type = 'voice_channel_invite'`),
    ).toBe(1);
  });

  it('still reaches an invitee who is only a voter, never an RSVPer', async () => {
    const { db, env } = setup('paid');
    await seedResolvedPoll(db);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200), membershipRule(200)]);
    await runReminderSweep(env);

    // Nobody was removed here, and a yes vote with no RSVP row is exactly how
    // poll attendance is expressed -- so the new check must not quietly
    // require an event_attendance row that polls never create.
    expect(
      await countRows(db, 'notification_log', `user_id = 'dropped' AND notification_type = 'voice_channel_invite'`),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P12-04 / F-27
// ---------------------------------------------------------------------------

// F-20's rotation retires the session presented and mints a successor, so a
// stolen token and the real one cannot both keep working. Its
// `superseded_at IS NULL` guard stops a second concurrent rotation moving the
// grace window -- but not from inserting a second successor. One session
// therefore forked into two independent chains, each free to rotate on for the
// rest of the seven days, with nothing linking them: logging out of one left
// the other running, and a captured token simply refreshed into a branch of
// its own rather than dying at the next refresh.
describe('rotation converges instead of forking, and a family revokes together (P12-04)', () => {
  it('hands two refreshes of the same session the same successor', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: original } = await createSession(env, 'u1');

    const [a, b] = await Promise.all([
      rotateSession(env, original, 'u1'),
      rotateSession(env, original, 'u1'),
    ]);

    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it('leaves exactly one live session behind after many refreshes', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    let current = (await createSession(env, 'u1')).id;
    for (let i = 0; i < 25; i++) {
      const next = await rotateSession(env, current, 'u1');
      expect(next).not.toBeNull();
      current = next!;
    }

    // Every predecessor is superseded; only the newest authenticates.
    expect(await countRows(db, 'sessions', `user_id = 'u1' AND superseded_at IS NULL AND revoked_at IS NULL`)).toBe(1);
    expect(await isSessionActive(env, current, 'u1')).toBe(true);
  });

  it('revokes the whole lineage on logout, not just the row presented', async () => {
    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: original } = await createSession(env, 'u1');
    const second = await rotateSession(env, original, 'u1');
    const third = await rotateSession(env, second!, 'u1');

    await revokeSession(env, third!);

    expect(await isSessionActive(env, third!, 'u1')).toBe(false);
    expect(await isSessionActive(env, second!, 'u1')).toBe(false);
    expect(await isSessionActive(env, original, 'u1')).toBe(false);
  });

  it('revokes the family when a retired session is replayed after the grace', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedUser(db, 'u1');
    const { id: original } = await createSession(env, 'u1');
    await ageSession(db, original);
    const stolen = original;
    const legitimate = await rotateSession(env, original, 'u1');
    expect(legitimate).not.toBeNull();

    // Well past the 60-second grace: this can no longer be a slow second tab.
    vi.setSystemTime(base + 10 * 60 * 1000);
    expect(await rotateSession(env, stolen, 'u1')).toBeNull();

    // The legitimate holder is logged out too. That is the intended outcome --
    // by this point one of the two holders is an attacker and nothing here can
    // tell which.
    expect(await isSessionActive(env, legitimate!, 'u1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P12-12 / P12-17
// ---------------------------------------------------------------------------

// R21 gave the additive invite path two layers: a read-then-check preflight
// for a message the organizer can act on, and a guard inside each INSERT for
// the concurrent case where both preflights pass. The guard was a threshold,
// not a reservation -- SQLite evaluates `WHERE (SELECT COUNT(*)...) < cap`
// once for the whole statement, so a count one below the cap admitted the
// entire chunk behind it, however many rows that was.
describe('the invite cap reserves capacity rather than checking a threshold (P12-12)', () => {
  it('holds at the cap when two additions race', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer' });

    // 23 already on the event, against MAX_RESOLVED_INVITEES of 25.
    const guests: string[] = [];
    for (let i = 0; i < 26; i++) {
      const uid = `guest-${String(i).padStart(2, '0')}`;
      await seedUser(db, uid);
      await seedMembership(db, uid, 'guild-1');
      guests.push(uid);
    }
    for (const uid of guests.slice(0, 23)) await seedInvite(db, 'ev-1', uid);

    // One request adds one person, another adds two. Both preflights see 23.
    await Promise.all([
      addInvitesToEvent(env, 'ev-1', 'guild-1', [guests[23]], [], 'organizer').catch(() => undefined),
      addInvitesToEvent(env, 'ev-1', 'guild-1', [guests[24], guests[25]], [], 'organizer').catch(() => undefined),
    ]);

    const total = await countRows(db, 'event_invites', `event_id = 'ev-1'`);
    expect(total, 'the event went past its invitee cap').toBeLessThanOrEqual(25);
  });
});

// assertValidRoster is the one thing all three roster paths call, and it
// checked only the shared-server rule. POST /:groupId/members had no size
// check at all, and the two whole-roster paths cap the submitted array and
// then prepend the owner if it omitted them -- so a full 25 that leaves the
// owner out becomes 26.
describe('a group roster cannot exceed its cap (P12-17)', () => {
  async function seedFullGroup(db: ShimDatabase): Promise<void> {
    await seedGuild(db);
    await seedUser(db, 'owner');
    await seedMembership(db, 'owner', 'guild-1');
    await db
      .prepare(`INSERT INTO groups (id, name, idle_reminder_days, created_by, created_at) VALUES ('g1', 'Crew', 2, 'owner', ?)`)
      .bind(Date.now())
      .run();
    await db
      .prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('g1', 'owner', ?)`)
      .bind(Date.now())
      .run();
    // 24 more, for 25 in total.
    for (let i = 0; i < 24; i++) {
      const uid = `m-${String(i).padStart(2, '0')}`;
      await seedUser(db, uid);
      await seedMembership(db, uid, 'guild-1');
      await db
        .prepare(`INSERT INTO group_members (group_id, user_id, added_at) VALUES ('g1', ?, ?)`)
        .bind(uid, Date.now())
        .run();
    }
    await seedUser(db, 'one-too-many');
    await seedMembership(db, 'one-too-many', 'guild-1');
  }

  it('refuses a 26th member on the additive route', async () => {
    const { db, env } = setup();
    await seedFullGroup(db);

    await expect(
      assertValidRoster(env, [
        'owner',
        ...Array.from({ length: 24 }, (_, i) => `m-${String(i).padStart(2, '0')}`),
        'one-too-many',
      ]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('counts the owner that whole-roster paths prepend', async () => {
    const { db, env } = setup();
    await seedFullGroup(db);

    // What POST /groups and PATCH /groups/:id build: a submitted list of 25
    // that passes assertStringArray's cap, plus the owner prepended because it
    // did not include them.
    const submitted = [
      ...Array.from({ length: 24 }, (_, i) => `m-${String(i).padStart(2, '0')}`),
      'one-too-many',
    ];
    await expect(assertValidRoster(env, ['owner', ...submitted])).rejects.toBeInstanceOf(ValidationError);
  });

  it('still accepts a roster exactly at the cap', async () => {
    const { db, env } = setup();
    await seedFullGroup(db);

    await expect(
      assertValidRoster(env, ['owner', ...Array.from({ length: 24 }, (_, i) => `m-${String(i).padStart(2, '0')}`)]),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P12-13 / P12-14
// ---------------------------------------------------------------------------

const BASE_RULE = {
  interval: 1,
  byWeekday: null,
  byMonthDay: null,
  startTime: '19:00',
  durationMinutes: 120,
  endType: 'never' as const,
  endDate: null,
  endCount: null,
};

// R22 fixed two counting bugs in this expander: empty months for a day-31 rule,
// and the partial first week of a WEEKLY series. The MONTHLY arm kept a third.
//
// A candidate that falls before the series' own start date is filtered out of
// the output -- pushIfInWindow returns early for it -- but the MONTHLY loop
// still advanced occurrenceIndex past it, so it consumed one of the
// occurrences an after_count series is allowed. The WEEKLY arm already handles
// exactly this with a `continue` that does not count; MONTHLY did not.
describe('a monthly series does not spend an occurrence on a date before it starts (P12-13)', () => {
  it('gives an after-count-3 series three real dates', () => {
    const occurrences = expandOccurrences(
      { ...BASE_RULE, freq: 'MONTHLY', byMonthDay: 1, startDate: '2026-01-15', endType: 'after_count', endCount: 3 },
      'UTC',
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 11, 31),
      [],
    );

    // January 1st precedes the 15th the series starts on, so it is not an
    // occurrence at all -- the third is April.
    expect(occurrences.map((o) => o.date)).toEqual(['2026-02-01', '2026-03-01', '2026-04-01']);
  });

  it('is unchanged when the start day is the rule day', () => {
    const occurrences = expandOccurrences(
      { ...BASE_RULE, freq: 'MONTHLY', byMonthDay: 15, startDate: '2026-01-15', endType: 'after_count', endCount: 3 },
      'UTC',
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 11, 31),
      [],
    );
    expect(occurrences.map((o) => o.date)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
  });
});

// The fast-forward that skips a long-dormant series up to the query window
// steps back one recurrence interval "to be safe against partial-day rounding
// at the boundary". That slack is measured in intervals and takes no account
// of how long an occurrence lasts -- so an occurrence longer than one interval
// begins before the step-back point, is never generated, and is therefore
// never tested for overlap.
//
// The window it vanishes from is a *narrower* one inside a window that
// returned it, which is what makes this worse than a missing row: the
// calendar and the free/busy assistant report a genuinely occupied interval as
// free, and the narrower the question the more likely they are to.
describe('a long occurrence stays visible in a narrow overlapping window (P12-14)', () => {
  const weekLong = {
    ...BASE_RULE,
    freq: 'DAILY' as const,
    startDate: '2026-09-01',
    startTime: '09:00',
    durationMinutes: 7 * 24 * 60,
    endType: 'after_count' as const,
    endCount: 1,
  };

  it('is returned by the window that contains its start', () => {
    const occurrences = expandOccurrences(weekLong, 'UTC', Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 8), []);
    expect(occurrences.map((o) => o.date)).toEqual(['2026-09-01']);
  });

  it('is still returned by a window entirely inside it', () => {
    const occurrences = expandOccurrences(weekLong, 'UTC', Date.UTC(2026, 8, 5), Date.UTC(2026, 8, 6), []);
    expect(
      occurrences.map((o) => o.date),
      'narrowing the range dropped an event that still overlaps it',
    ).toEqual(['2026-09-01']);
  });

  it('holds for a weekly series too', () => {
    const longWeekly = {
      ...BASE_RULE,
      freq: 'WEEKLY' as const,
      byWeekday: '1',
      startDate: '2026-09-01',
      startTime: '09:00',
      durationMinutes: 10 * 24 * 60,
      endType: 'never' as const,
    };
    const wide = expandOccurrences(longWeekly, 'UTC', Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 15), []);
    expect(wide.length).toBeGreaterThan(0);

    // A one-day window in the middle of the series must still see whichever
    // occurrence is running across it.
    const narrow = expandOccurrences(longWeekly, 'UTC', Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2), []);
    expect(narrow.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// P12-15 / P12-18 / P12-19 / P12-20
// ---------------------------------------------------------------------------

// normalizePollModes applies the CREATE-time default `?? 'single_winner'`, and
// updateEvent called it too -- so a PATCH that does not mention
// pollResolutionMode silently converted a multi-winner poll into a
// single-winner one. Every other field in that same UPDATE learned this lesson
// under F-08-A: "the caller didn't send it" and "the caller wants the default"
// are different requests.
describe('a partial poll edit preserves its resolution mode (P12-15)', () => {
  it('leaves a multi-winner poll multi-winner when the mode is not sent', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');

    const base = Date.now();
    const slot = { startAt: base + 3 * DAY_MS, endAt: base + 3 * DAY_MS + 2 * HOUR_MS };
    const pollId = await createEventWithInvites(env, 'guild-1', 'organizer', {
      title: 'Which nights?',
      description: null,
      game: null,
      eventType: 'poll',
      timezone: 'America/New_York',
      isRecurring: false,
      pollStrategy: 'threshold',
      pollThresholdCount: 1,
      pollDeadlineAt: base + DAY_MS,
      pollResolutionMode: 'multi_winner',
      pollOptions: [slot],
      invites: { userIds: [], groupIds: [] },
    } as never);

    const stored = await loadEventRow(db, pollId);
    // A partial edit: same candidates, no mode.
    await updateEvent(env, pollId, 'guild-1', { pollOptions: [slot], revision: stored.revision } as never, stored);

    const after = await loadEventRow(db, pollId);
    expect(after.poll_resolution_mode, 'a partial edit downgraded the poll to single-winner').toBe('multi_winner');
  });
});

// applyAndAccept moved the event first and recorded the decision afterwards,
// behind a `WHERE status = 'pending'` compare-and-set. acceptChangeRequest's
// own pending check reads a snapshot the route loaded earlier, so a decline
// landing between the two passed it: the accept moved the schedule and then
// updated nothing, leaving a request that reads 'declined', decline note and
// all, beside an event that had already moved.
describe('a declined change request cannot also be applied (P12-18)', () => {
  it('refuses the accept when a decline got there first', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'asker');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'asker', 'guild-1');

    const start = Date.now() + 5 * DAY_MS;
    await seedEvent(db, { id: 'ev-1', organizerId: 'organizer', startAt: start, endAt: start + 2 * HOUR_MS });
    await seedInvite(db, 'ev-1', 'asker');

    const event = await loadEventRow(db, 'ev-1');
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO event_change_requests
           (id, event_id, occurrence_date, requester_id, kind, status, proposed_start_at, proposed_end_at,
            event_revision, message, created_at)
         VALUES ('cr-1', 'ev-1', '', 'asker', 'time_change', 'pending', ?, ?, ?, 'an hour later?', ?)`,
      )
      .bind(start + HOUR_MS, start + 3 * HOUR_MS, event.revision, now)
      .run();

    // The route's snapshot, loaded while the request was still pending.
    const snapshot = await db
      .prepare(`SELECT * FROM event_change_requests WHERE id = 'cr-1'`)
      .first<ChangeRequestRow>();

    // The organizer declines from another tab.
    await declineChangeRequest(env, snapshot!, 'organizer', 'not this week');

    // The accept, still holding the pending snapshot, must not apply.
    await expect(acceptChangeRequest(env, event, snapshot!, 'organizer')).rejects.toBeInstanceOf(ConflictError);

    const after = await loadEventRow(db, 'ev-1');
    expect(after.start_at, 'a declined request still moved the event').toBe(start);
    const stored = await db
      .prepare(`SELECT status, decision_note FROM event_change_requests WHERE id = 'cr-1'`)
      .first<{ status: string; decision_note: string | null }>();
    expect(stored!.status).toBe('declined');
    expect(stored!.decision_note).toBe('not this week');
  });
});

// R13/F-21 substantially widened the export and still left two things out: the
// candidate times a poll is made of, and the login-attempt timestamp the
// Pass-11 commit message claimed it had added.
describe('the export returns the poll candidates and the login bookkeeping (P12-19)', () => {
  it('includes both', async () => {
    const { db, env } = setup();
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    await db.prepare(`UPDATE users SET last_login_attempt_at = 1750000000000 WHERE id = 'organizer'`).run();

    const base = Date.now();
    const slot = { startAt: base + 3 * DAY_MS, endAt: base + 3 * DAY_MS + 2 * HOUR_MS };
    await createEventWithInvites(env, 'guild-1', 'organizer', {
      title: 'Which nights?',
      description: null,
      game: null,
      eventType: 'poll',
      timezone: 'America/New_York',
      isRecurring: false,
      pollStrategy: 'threshold',
      pollThresholdCount: 1,
      pollDeadlineAt: base + DAY_MS,
      pollResolutionMode: 'multi_winner',
      pollOptions: [slot],
      invites: { userIds: [], groupIds: [] },
    } as never);

    const app = buildApp();
    const { id: sessionId } = await createSession(env, 'organizer');
    const token = await signJwt('organizer', sessionId, env.JWT_SIGNING_KEY);
    const res = await app.request(
      'https://worker.test/me/export',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(JSON.stringify(body.pollCandidates), 'the poll candidate times are missing').toContain(String(slot.startAt));
    expect(JSON.stringify(body.profile)).toContain('1750000000000');
  });
});

// revokeToken's comment said "400 with error=invalid_token means the grant is
// already gone"; its code said "400". Google returns 400 for a malformed or
// incomplete request too, and those mean the call did not happen -- reporting
// them as a successful revocation is how a credential this app promised to
// revoke stays live with nothing left to retry it.
describe('revocation only treats an already-revoked token as success (P12-20)', () => {
  it('accepts a 400 that says invalid_token', async () => {
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/revoke', status: 400, body: { error: 'invalid_token' } },
    ]);
    expect(await revokeToken('a-token')).toBe(true);
  });

  it('does not accept a 400 that says anything else', async () => {
    fetchStub = stubFetch([
      { match: 'oauth2.googleapis.com/revoke', status: 400, body: { error: 'invalid_request' } },
    ]);
    expect(await revokeToken('a-token'), 'a rejected request was reported as a successful revocation').toBe(false);
  });
});
