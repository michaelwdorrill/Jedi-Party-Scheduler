import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteUserCompletely } from '../src/lib/db';
import { buildNoticeboard } from '../src/lib/noticeboard';
import { runReminderSweep } from '../src/cron/reminders';
import type { ShimDatabase } from './d1shim';
import {
  countRows,
  DAY_MS,
  DM_CHANNEL_RULE,
  dmSendRule,
  HOUR_MS,
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

// Pass 11 review (September 2026) -- the first structured pass over Phase 4
// (specs/0015, 0016) and Phase 5 (specs/0007, 0017), reviewed at e5180a0 by
// two independent reviewers whose findings are merged here. One describe()
// per finding, finding id in the title, same shape as pass9/pass10.
//
// Findings carry both reviewers' ids where both found it (F-15 / R04); a
// single id means only one of them did. Blocks land as their fixes do.

let fetchStub: FetchStub | null = null;
afterEach(() => {
  fetchStub?.restore();
  fetchStub = null;
  vi.useRealTimers();
});

// Two users in one guild, B invited to A's event. The shape every F-15
// scenario starts from.
async function seedOrganizerAndInvitee(db: ShimDatabase): Promise<{ eventId: string }> {
  await seedGuild(db);
  await seedUser(db, 'alice');
  await seedUser(db, 'bob');
  await seedMembership(db, 'alice', 'guild-1');
  await seedMembership(db, 'bob', 'guild-1');
  const eventId = await seedEvent(db, { id: 'ev-1', organizerId: 'alice' });
  await seedInvite(db, eventId, 'bob');
  return { eventId };
}

async function seedChangeRequest(
  db: ShimDatabase,
  id: string,
  eventId: string,
  requesterId: string,
  extra: { kind?: 'time_change' | 'add_invitee'; targetUserId?: string | null } = {},
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO event_change_requests
         (id, event_id, requester_id, kind, proposed_start_at, proposed_end_at, target_user_id, event_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(
      id,
      eventId,
      requesterId,
      extra.kind ?? 'time_change',
      extra.kind === 'add_invitee' ? null : now + 2 * DAY_MS,
      extra.kind === 'add_invitee' ? null : now + 2 * DAY_MS + HOUR_MS,
      extra.targetUserId ?? null,
      now,
    )
    .run();
}

// ---------------------------------------------------------------------------
// F-15 / R04
// ---------------------------------------------------------------------------

// deleteUserCompletely never cleared organizer_rsvp_notice_log (as responder),
// event_change_requests (as requester or target), event_change_request_votes
// or change_request_log. All four reference users(id) with no ON DELETE
// action, so the final `DELETE FROM users` failed and D1 rolled the whole
// batch back -- DELETE /me answered 500, and the stale-account purge re-threw
// every tick for that account. The organizer_rsvp_notice_log case is the
// common one: the cron writes one row per RSVP to another person's active
// event (migration 0035) and never removes it, so anyone who had ever pressed
// a button on a DM about someone else's event was undeletable.
describe('account deletion clears every table that references the user (F-15 / R04)', () => {
  it("deletes a user who responded to someone else's event once the RSVP-notice log has recorded it", async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    const now = Date.now();
    await seedAttendance(db, eventId, 'bob', 'accepted');
    await db
      .prepare(
        `INSERT INTO organizer_rsvp_notice_log
           (id, organizer_id, event_id, occurrence_date, responder_id, responded_at, sent_at, delivered_at)
         VALUES ('n1', 'alice', ?, '', 'bob', ?, ?, ?)`,
      )
      .bind(eventId, now, now, now)
      .run();

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'organizer_rsvp_notice_log', 'responder_id = ?', 'bob')).toBe(0);
    // Alice's event is untouched -- only Bob's rows went.
    expect(await countRows(db, 'events', 'id = ?', eventId)).toBe(1);
  });

  it("deletes a user who filed a change request on someone else's event", async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    await seedChangeRequest(db, 'cr1', eventId, 'bob');

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'event_change_requests', 'requester_id = ?', 'bob')).toBe(0);
  });

  it('deletes a user who voted on a change request they did not file', async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    await seedUser(db, 'carol');
    await seedMembership(db, 'carol', 'guild-1');
    await seedInvite(db, eventId, 'carol');
    await seedChangeRequest(db, 'cr1', eventId, 'carol');
    await db
      .prepare(
        `INSERT INTO event_change_request_votes (request_id, user_id, vote, voted_at) VALUES ('cr1', 'bob', 'yes', ?)`,
      )
      .bind(Date.now())
      .run();

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'event_change_request_votes', 'user_id = ?', 'bob')).toBe(0);
    // Carol's request survives; it was hers.
    expect(await countRows(db, 'event_change_requests', 'id = ?', 'cr1')).toBe(1);
  });

  it('deletes a user who was DMed about a change request through change_request_log', async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    await seedUser(db, 'carol');
    await seedMembership(db, 'carol', 'guild-1');
    await seedChangeRequest(db, 'cr1', eventId, 'carol');
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO change_request_log (id, request_id, user_id, notification_type, sent_at, delivered_at)
         VALUES ('l1', 'cr1', 'bob', 'change_request_opened', ?, ?)`,
      )
      .bind(now, now)
      .run();

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'change_request_log', 'user_id = ?', 'bob')).toBe(0);
  });

  it("deletes a user who is the target of someone else's add_invitee request", async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    await seedUser(db, 'carol');
    await seedMembership(db, 'carol', 'guild-1');
    await seedChangeRequest(db, 'cr1', eventId, 'carol', { kind: 'add_invitee', targetUserId: 'bob' });

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'event_change_requests', 'target_user_id = ?', 'bob')).toBe(0);
  });

  // decided_by is nulled rather than deleted: the request belongs to whoever
  // filed it, on an event this user does not own, so it has to survive them.
  it("keeps someone else's request but drops the decider when the decider is erased", async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    await seedUser(db, 'carol');
    await seedMembership(db, 'carol', 'guild-1');
    await seedChangeRequest(db, 'cr1', eventId, 'carol');
    const now = Date.now();
    await db
      .prepare(`UPDATE event_change_requests SET status = 'declined', decided_at = ?, decided_by = 'bob' WHERE id = 'cr1'`)
      .bind(now)
      .run();

    await expect(deleteUserCompletely(env, 'bob')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(0);
    expect(await countRows(db, 'event_change_requests', 'id = ?', 'cr1')).toBe(1);
    expect(await countRows(db, 'event_change_requests', 'decided_by IS NULL AND id = ?', 'cr1')).toBe(1);
    // Still readable as decided -- only the attribution went.
    expect(await countRows(db, 'event_change_requests', 'decided_at IS NOT NULL AND id = ?', 'cr1')).toBe(1);
  });

  // The control the others are measured against: this already passed before
  // the fix, and must keep passing -- the fix is additive.
  it('still deletes an organizer along with their own event and its notice-log rows', async () => {
    const { db, env } = setup();
    const { eventId } = await seedOrganizerAndInvitee(db);
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO organizer_rsvp_notice_log
           (id, organizer_id, event_id, occurrence_date, responder_id, responded_at, sent_at, delivered_at)
         VALUES ('n1', 'alice', ?, '', 'bob', ?, ?, ?)`,
      )
      .bind(eventId, now, now, now)
      .run();

    await expect(deleteUserCompletely(env, 'alice')).resolves.toBeUndefined();

    expect(await countRows(db, 'users', 'id = ?', 'alice')).toBe(0);
    expect(await countRows(db, 'events')).toBe(0);
    expect(await countRows(db, 'organizer_rsvp_notice_log')).toBe(0);
    expect(await countRows(db, 'users', 'id = ?', 'bob')).toBe(1);
  });

  // The purge path is the same function, so the same rows blocked it -- and
  // the second consequence is that the throw exited sweepStaleAccounts, so one
  // stuck account also stopped every account sorting after it from being
  // warned or purged. Two stale accounts, the first holding an RSVP-notice
  // row: both have to be gone after two ticks (STALE_PURGE_MAX_PER_TICK is 1).
  it('purges both stale accounts across two ticks when the first holds an RSVP-notice row', async () => {
    vi.useFakeTimers();
    const base = Date.UTC(2026, 8, 10, 12, 0, 0);
    vi.setSystemTime(base);

    const { db, env } = setup();
    await seedGuild(db);
    // Two accounts, both a year stale. 'aaa' sorts first; give it an RSVP row
    // on a live event so its erasure would fail under the old statement list.
    for (const id of ['aaa', 'zzz']) {
      await seedUser(db, id);
      await seedMembership(db, id, 'guild-1');
      await db
        .prepare(`UPDATE users SET last_login_at = ?, created_at = ? WHERE id = ?`)
        .bind(base - 366 * DAY_MS, base - 366 * DAY_MS, id)
        .run();
    }
    await seedUser(db, 'organizer');
    await seedMembership(db, 'organizer', 'guild-1');
    // A *past* event, so hasUpcomingStake does not pause the purge.
    const eventId = await seedEvent(db, {
      id: 'ev-past',
      organizerId: 'organizer',
      startAt: base - 2 * DAY_MS,
      endAt: base - 2 * DAY_MS + HOUR_MS,
    });
    await seedInvite(db, eventId, 'aaa');
    await db
      .prepare(
        `INSERT INTO organizer_rsvp_notice_log
           (id, organizer_id, event_id, occurrence_date, responder_id, responded_at, sent_at, delivered_at)
         VALUES ('n1', 'organizer', ?, '', 'aaa', ?, ?, ?)`,
      )
      .bind(eventId, base, base, base)
      .run();

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);

    // STALE_PURGE_MAX_PER_TICK is 1, so two ticks for two accounts.
    await runReminderSweep(env);
    vi.setSystemTime(base + 15 * 60 * 1000);
    await runReminderSweep(env);

    expect(await countRows(db, 'users', 'id = ?', 'aaa')).toBe(0);
    expect(await countRows(db, 'users', 'id = ?', 'zzz')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-18 / R03
// ---------------------------------------------------------------------------

// createFannedOutEvent's INSERT omitted is_private and the sweep's SELECT
// never read it, so migration 0038's default (0 = visible) applied to every
// event a confirmed multi-winner option spawned. The organiser ticked "keep
// this one off the noticeboard" on the poll; each confirmed day then appeared
// on it anyway -- title, time, organiser, invitee list and RSVP answers, to
// every member of the server, none of whom were invited.
describe('a private multi-winner poll fans out private events (F-18 / R03)', () => {
  async function seedMultiWinnerPoll(db: ShimDatabase, isPrivate: number): Promise<number> {
    await seedGuild(db);
    await seedUser(db, 'organizer');
    await seedUser(db, 'invitee');
    await seedMembership(db, 'organizer', 'guild-1');
    await seedMembership(db, 'invitee', 'guild-1');

    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO events (id, guild_id, organizer_id, title, event_type, timezone, start_at, end_at, status,
           poll_mode, poll_resolution_mode, is_recurring, is_private, created_at, updated_at)
         VALUES ('poll-1', 'guild-1', 'organizer', 'Private therapy discussion', 'poll', 'America/New_York', NULL, NULL,
           'active', 'options', 'multi_winner', 0, ?, ?, ?)`,
      )
      .bind(isPrivate, now, now)
      .run();
    await seedInvite(db, 'poll-1', 'organizer');
    await seedInvite(db, 'poll-1', 'invitee');
    await db
      .prepare(
        `INSERT INTO event_poll_options (id, event_id, start_at, end_at, display_order, confirmed_at)
         VALUES ('opt-1', 'poll-1', ?, ?, 0, ?)`,
      )
      .bind(now + 3 * DAY_MS, now + 3 * DAY_MS + 2 * HOUR_MS, now)
      .run();
    return now;
  }

  it('copies is_private from the parent poll onto the spawned event and keeps it off the noticeboard', async () => {
    const { db, env } = setup();
    const now = await seedMultiWinnerPoll(db, 1);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);
    await runReminderSweep(env);

    const spawned = await db
      .prepare(`SELECT id, is_private FROM events WHERE created_from_option_id = 'opt-1'`)
      .first<{ id: string; is_private: number }>();
    expect(spawned).not.toBeNull();
    expect(spawned!.is_private).toBe(1);

    const board = await buildNoticeboard(env, 'guild-1', now, now + 30 * DAY_MS);
    expect(board.map((o) => o.eventId)).not.toContain(spawned!.id);
  });

  // The other direction, so the fix cannot be "always private" -- a poll the
  // organiser left on the noticeboard still spawns days that appear on it.
  it("leaves a public poll's confirmed days on the noticeboard", async () => {
    const { db, env } = setup();
    const now = await seedMultiWinnerPoll(db, 0);

    fetchStub = stubFetch([DM_CHANNEL_RULE, dmSendRule(200)]);
    await runReminderSweep(env);

    const spawned = await db
      .prepare(`SELECT id, is_private FROM events WHERE created_from_option_id = 'opt-1'`)
      .first<{ id: string; is_private: number }>();
    expect(spawned).not.toBeNull();
    expect(spawned!.is_private).toBe(0);

    const board = await buildNoticeboard(env, 'guild-1', now, now + 30 * DAY_MS);
    expect(board.map((o) => o.eventId)).toContain(spawned!.id);
  });
});
