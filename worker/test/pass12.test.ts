import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteUserCompletely } from '../src/lib/db';
import { createEventWithInvites, updateEvent } from '../src/lib/eventWrites';
import { runReminderSweep } from '../src/cron/reminders';
import { ValidationError } from '../src/lib/validate';
import type { Env } from '../src/env';
import type { ShimDatabase } from './d1shim';
import {
  countRows,
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
  loadEventRow,
  seedGuild,
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
