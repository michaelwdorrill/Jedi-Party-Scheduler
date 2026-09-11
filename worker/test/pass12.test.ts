import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteUserCompletely } from '../src/lib/db';
import { createEventWithInvites, updateEvent } from '../src/lib/eventWrites';
import { runReminderSweep } from '../src/cron/reminders';
import { readCursorKey } from '../src/cron/cursor';
import { ValidationError } from '../src/lib/validate';
import type { Env } from '../src/env';
import { D1_FREE_PLAN_QUERY_BUDGET, type ShimDatabase } from './d1shim';
import {
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
